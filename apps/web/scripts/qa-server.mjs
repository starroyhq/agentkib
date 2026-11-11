// Synthetic, loopback-only visual QA harness. Never packaged; never calls runtime/IPC.
// Env: QA_PORT, QA_APPROVED=1 (skip pairing), QA_HOME=clear (no waiting/unread/running sessions),
// QA_REPLY=unknown (approve/answer/create drop the connection), QA_DEVICE=readonly (no send/manage),
// QA_INTERACTION=question (what POST /send raises).
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
const root = resolve(import.meta.dirname, "../dist");
const port = Number(process.env.QA_PORT || 1423);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid QA_PORT");
const env = process.env;
const replyUnknown = env.QA_REPLY === "unknown";
const readonly = env.QA_DEVICE === "readonly";
let status = env.QA_APPROVED === "1" ? "approved" : "unpaired",
  pairedAt = 0;
const started = Date.now();
const ago = (minutes) => new Date(started - minutes * 60000).toISOString();
const workspaces = ["northstar-api", "data-pipeline", "atlas-studio", "design-system"].map(
  (id) => ({ id, name: id, path: `/Users/demo/code/${id}` }),
);
const pathOf = (id) => workspaces.find((w) => w.id === id)?.path ?? "/Users/demo/code/unknown";
const item = (id, kind, content, extra = {}) => ({
  id,
  kind,
  content,
  attachment_count: 0,
  truncated: false,
  ...extra,
});
const events = [
  item("u", "user-message", "请检查会话阅读体验：长文本、代码与执行过程。", {
    turn_id: "t",
    timestamp: "2026-09-08T01:00:00Z",
  }),
  item("c", "agent-message", "正在检查页面布局与键盘交互。", {
    turn_id: "t",
    message_phase: "commentary",
  }),
  item("tool", "tool-summary", "合成工具输出，不执行任何命令。\n" + "long-output ".repeat(40), {
    turn_id: "t",
    tool_name: "exec",
    tool_status: "completed",
  }),
  item(
    "f",
    "agent-message",
    '## 检查完成\n\n这是一条合成记录，不代表真实运行状态。\n\n- 保留正文\n- 工具详情可键盘展开\n\n```typescript\nconst veryLongSyntheticLine = "' +
      "safe-output-".repeat(30) +
      '";\n```\n\n' +
      "正文保持居中，长文本自动换行，历史与实时状态分开呈现。".repeat(14),
    { turn_id: "t", message_phase: "final_answer" },
  ),
];

// Per-session state. `state`: idle | approval | question | running.
const sessions = new Map();
let versionCounter = 1;
const resultOf = (id, outcome, minutesAgo) => ({
  id: `${id}-result-${versionCounter}`,
  turnId: "qa-turn",
  itemId: null,
  outcome,
  completedAt: ago(minutesAgo),
});
function add(id, title, agent, workspace_id, minutesAgo, extra = {}) {
  const { state = "idle", continuation, result, ...rest } = extra;
  sessions.set(id, {
    summary: {
      id,
      title,
      agent,
      workspace_id,
      created_at: ago(minutesAgo + 30),
      updated_at: ago(minutesAgo),
      availability: "readable",
      archived: false,
      sidechain: false,
      origin: "interactive",
      message_count: 6,
      ...(continuation ? { continuation } : {}),
      ...rest,
    },
    state,
    revision: 1,
    unread: result ?? null, // ConversationReadResult while unread
    lastResult: result ?? null,
    readVersion: versionCounter++,
  });
}
const waitingApproval = {
  requestId: 42,
  turnId: "qa-turn",
  method: "item/commandExecution/requestApproval",
  command: "pnpm test --filter auth-session",
  cwd: pathOf("northstar-api"),
  supported: true,
  availableDecisions: ["accept", "acceptForSession", "decline"],
};
const waitingQuestion = {
  requestId: "qa-question-1",
  turnId: "qa-turn",
  method: "claude/AskUserQuestion",
  supported: true,
  questions: [
    {
      id: "scope",
      header: "范围",
      question: "API 文档要覆盖哪些部分？",
      multiSelect: false,
      allowCustom: true,
      options: [
        { label: "仅公开接口", description: "只整理对外暴露的接口" },
        { label: "包含内部接口", description: "同时整理内部服务之间的接口" },
      ],
    },
  ],
};
if (env.QA_HOME !== "clear") {
  add("qa-login", "修复登录超时的问题", "codex", "northstar-api", 2, {
    state: "approval",
    continuation: { status: "awaiting-approval", executionLocation: "agentkib" },
    pendingInteraction: true,
  });
  add("qa-docs", "整理 API 文档", "claude-code", "northstar-api", 6, {
    state: "question",
    continuation: { status: "waiting-input", executionLocation: "agentkib" },
    pendingInteraction: true,
  });
  add("qa-retry", "核对夜间任务的失败重试", "codex", "data-pipeline", 12, {
    result: resultOf("qa-retry", "completed", 12),
  });
  add("qa-node", "升级依赖到 Node 24", "claude-code", "atlas-studio", 25, {
    result: resultOf("qa-node", "failed", 25),
  });
  add("qa-canvas", "重构画布组件的拖拽逻辑", "codex", "atlas-studio", 4, {
    state: "running",
    continuation: { status: "running", executionLocation: "terminal" },
  });
}
add("qa-a11y", "检查按钮组件的可访问性", "codex", "design-system", 60);
add("qa-routes", "梳理页面路由", "claude-code", "northstar-api", 26 * 60);
add("qa-tests", "补充回归测试", "codex", "data-pipeline", 49 * 60);

const readStateOf = (s) => ({
  source: "agentkib",
  status: s.unread ? "unread" : "read",
  freshness: "current",
  version: `qa:${s.summary.id}:${s.readVersion}`,
  firstUnread: s.unread
    ? { type: "result", resultId: s.unread.id, turnId: s.unread.turnId }
    : null,
  latestResult: s.lastResult,
});
const summaryOf = (s) => ({ ...s.summary, readState: readStateOf(s) });
const statusOf = { idle: "idle", approval: "waiting-approval", question: "waiting-input", running: "running" };
const liveOf = (s) => ({
  sessionId: s.summary.id,
  runtimeBootId: "qa-boot",
  status: statusOf[s.state],
  turnId: "qa-turn",
  revision: s.revision,
  sendEnabled: s.state === "idle",
  stopEnabled: false,
  executionMode: s.summary.agent === "codex" ? "codex-managed" : "claude-managed",
  executionLocation: s.state === "running" ? "terminal" : "agentkib",
  approvals: s.state === "approval" ? [waitingApproval] : [],
  questions: s.state === "question" ? [waitingQuestion] : [],
});
const continuationOf = (s) =>
  s.state === "approval"
    ? { status: "awaiting-approval", executionLocation: "agentkib" }
    : s.state === "question"
      ? { status: "waiting-input", executionLocation: "agentkib" }
      : s.state === "running"
        ? { status: "running", executionLocation: s.summary.continuation?.executionLocation ?? "agentkib" }
        : { status: "idle", executionLocation: "agentkib" };

// Live delivery: global streams get catalog-invalidated, session streams get a fresh snapshot.
const streams = new Set();
let streamSeq = 0;
const frame = (type, data, id) =>
  `${id ? `id: ${id}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
function sendSnapshot(client, s) {
  const seq = ++streamSeq;
  const cursor = `qa-${seq}`;
  client.res.write(
    frame(
      "session-event",
      {
        protocolVersion: 2,
        subscriptionId: client.id,
        sessionId: s.summary.id,
        runtimeBootId: "qa-boot",
        epoch: "qa-epoch",
        seq,
        cursor,
        type: "snapshot",
        payload: { live: liveOf(s), items: [] },
      },
      cursor,
    ),
  );
  client.res.write(frame("session-ready", { cursor }));
}
function changed(s) {
  s.revision++;
  s.summary.continuation = continuationOf(s);
  // A host that observed the session reports false once nothing waits; the Web keeps the last value
  // when the field is missing.
  if (s.state === "approval" || s.state === "question") s.summary.pendingInteraction = true;
  else if ("pendingInteraction" in s.summary) s.summary.pendingInteraction = false;
  for (const client of streams) {
    if (client.sessionId === "") {
      client.res.write(frame("catalog-invalidated", {}));
      client.res.write(frame("control-changed", { sessionId: s.summary.id }));
    } else if (client.sessionId === s.summary.id) {
      sendSnapshot(client, s);
      client.res.write(frame("control-changed", { sessionId: s.summary.id }));
    }
  }
}
function finish(s) {
  s.state = "idle";
  s.summary.updated_at = new Date().toISOString();
  s.lastResult = s.unread = resultOf(s.summary.id, "completed", 0);
  s.readVersion = versionCounter++;
  changed(s);
}
const receipts = new Map();
const device = () => ({
  id: "qa",
  name: "合成浏览器",
  send: !readonly,
  approve: true,
  manage: !readonly,
});
let created = 0;

const MODELS = [
  { id: "qa-model-large", name: "Large", efforts: ["low", "medium", "high"], isDefault: true, defaultEffort: "medium" },
  { id: "qa-model-small", name: "Small", efforts: ["low", "medium"], defaultEffort: "low" },
];
function optionsFor(agent) {
  const base = { available: true, cliVersion: "0.0.0-qa", models: MODELS, workspaces: workspaces.map(({ id, name }) => ({ id, name })) };
  if (agent === "codex")
    return {
      ...base,
      defaults: { model: "qa-model-large", effort: "medium" },
      policies: [
        { id: "workspace-write-on-request", name: "工作区可写，按需询问", description: "在工作区内读写，越界操作时询问" },
        { id: "workspace-write-auto-review", name: "工作区可写，自动审查", description: "工作区内读写，由审查模型决定是否放行" },
        { id: "full-access-on-request", name: "完全访问，按需询问", description: "不限制文件和网络，敏感操作时询问" },
      ],
    };
  if (agent === "claude-code")
    return {
      ...base,
      permissionModes: [
        { id: "default", name: "默认", description: "每次编辑和命令都询问" },
        { id: "acceptEdits", name: "接受编辑", description: "自动接受文件编辑，命令仍询问" },
        { id: "plan", name: "计划模式", description: "只规划，不修改文件" },
      ],
    };
  return {
    ...base,
    agentPresets: [
      { id: "default", name: null, description: null, isDefault: true, broken: null },
      { id: "reviewer", name: "代码审查", description: "只读检查并给出审查意见", isDefault: false, broken: null },
    ],
  };
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const json = (value, code = 200) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    // Same shape the client reads from a refused control.
    const refuse = (code, error, outcome = "not-dispatched") =>
      json({ code: error, controlOutcome: outcome }, code);
    if (url.pathname.startsWith("/api/")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return json({ code: "bad_request" }, 400);
      }
      const p = url.pathname.replace(/^\/api\/web\/v1\//, "").replace(/^\/api\//, "");
      const sessionId = url.searchParams.get("sessionId") ?? body.sessionId;
      const s = sessions.get(sessionId);
      const approved = status === "approved";
      if (p === "pair") {
        status = "pending";
        pairedAt = Date.now();
        return json({});
      }
      if (p === "logout") {
        status = "unpaired";
        return json({});
      }
      if (p === "access") {
        if (status === "pending" && Date.now() - pairedAt > 8000) status = "approved";
        return json({
          status,
          protocolVersion: 2,
          csrfToken: "qa-only",
          bootId: "qa-only",
          experimentalEnabled: true,
          device: status === "approved" ? device() : undefined,
          pending:
            status === "pending"
              ? { id: "qa-pair", verification: "482 916", expiresAt: Date.now() + 300000 }
              : undefined,
        });
      }
      if (!approved) return json({ code: "access_ended" }, 401);
      if (p === "catalog")
        return json({
          indexEnabled: true,
          complete: true,
          workspaces,
          sessions: [...sessions.values()].map(summaryOf),
        });
      if (p === "events")
        return json({
          events: url.searchParams.has("cursor")
            ? [item("older", "agent-message", "更早的合成记录")]
            : events,
          next_cursor: url.searchParams.has("cursor") ? undefined : "older",
          warnings: [],
        });
      if (p === "live") return s ? json(liveOf(s)) : json({ code: "not_found" }, 404);
      if (p === "read-state") {
        if (!s) return json({ code: "not_found" }, 404);
        if (req.method === "POST") {
          if (
            body.expectedVersion !== readStateOf(s).version ||
            (body.seenResultId ?? null) !== (s.lastResult?.id ?? null)
          )
            return json({ code: "read_state_conflict" }, 409);
          s.unread = null;
          s.readVersion = versionCounter++;
          for (const client of streams)
            if (client.sessionId === "") client.res.write(frame("catalog-invalidated", {}));
        }
        return json({ readState: readStateOf(s) });
      }
      if (p === "codex/capabilities" || p === "managed/capabilities") {
        if (!s) return json({ code: "not_found" }, 404);
        const on = { available: true };
        return json({
          sessionId: s.summary.id,
          executionMode: liveOf(s).executionMode,
          status: "ready",
          features: { send: on, resume: on, inspect: on, rename: on, archive: on },
        });
      }
      if (p === "managed/options") {
        const agent = url.searchParams.get("agent") ?? "codex";
        if (!["codex", "claude-code", "deepseek-harness"].includes(agent))
          return json({ code: "unsupported_agent" }, 400);
        return json(optionsFor(agent));
      }
      if (p.startsWith("requests/")) {
        const requestId = decodeURIComponent(p.slice("requests/".length));
        return json(receipts.get(requestId) ?? { found: false, requestId });
      }
      if (p === "stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        const client = {
          res,
          id: `qa-sub-${Math.random().toString(36).slice(2, 8)}`,
          sessionId: url.searchParams.get("sessionId") ?? "",
        };
        streams.add(client);
        res.write(": open\n\n");
        const target = sessions.get(client.sessionId);
        if (target) sendSnapshot(client, target);
        const beat = setInterval(() => res.write(": keep-alive\n\n"), 15000);
        req.on("close", () => {
          clearInterval(beat);
          streams.delete(client);
        });
        return;
      }
      // Controls. QA_REPLY=unknown drops the connection so the outcome is unknown to the client.
      if (["send", "approve", "answer", "managed/create"].includes(p)) {
        if (replyUnknown && p !== "send") return req.socket.destroy();
        const allowed = p === "approve" ? device().approve : p === "managed/create" ? device().manage : device().send;
        if (!allowed) return refuse(403, `${p === "approve" ? "approve" : p === "send" || p === "answer" ? "send" : "manage"}_not_permitted`);
        if (p === "managed/create") {
          if (!workspaces.some((w) => w.id === body.workspaceId))
            return refuse(400, "workspace_not_found");
          const id = `qa-new-${++created}`;
          const agent = body.agent ?? "codex";
          add(id, "新会话", agent, body.workspaceId, 0);
          receipts.set(body.requestId, {
            found: true,
            requestId: body.requestId,
            sessionId: id,
            workspaceId: body.workspaceId,
            operation: "create",
            status: "accepted",
            completionObserved: true,
            ack: { accepted: true, completed: true, requestId: body.requestId, sessionId: id },
          });
          for (const client of streams)
            if (client.sessionId === "") client.res.write(frame("catalog-invalidated", {}));
          return json({ accepted: true, sessionId: id });
        }
        if (!s) return refuse(404, "session_not_found");
        if (p === "send") {
          s.state = env.QA_INTERACTION === "question" ? "question" : "approval";
          changed(s);
          return json({ accepted: true });
        }
        if (body.expectedRevision !== s.revision) return refuse(409, "stale_revision");
        const gone =
          p === "approve"
            ? s.state !== "approval" || body.approvalId !== waitingApproval.requestId
            : s.state !== "question" || body.questionId !== waitingQuestion.requestId;
        if (gone) return refuse(409, "request_not_pending");
        receipts.set(body.requestId, {
          found: true,
          requestId: body.requestId,
          sessionId: s.summary.id,
          operation: p,
          executionMode: liveOf(s).executionMode,
          runtimeBootId: "qa-boot",
          expectedRevision: body.expectedRevision,
          turnId: body.turnId ?? null,
          status: "accepted",
          completionObserved: false,
          ack: { accepted: true, requestId: body.requestId, sessionId: s.summary.id },
        });
        s.state = "running";
        changed(s);
        // The reply starts a turn that ends with an unread result shortly after.
        setTimeout(() => finish(s), 3000).unref?.();
        return json({ accepted: true, requestId: body.requestId, sessionId: s.summary.id });
      }
      res.writeHead(404);
      return res.end();
    }
    try {
      const path = resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
      if (!path.startsWith(root + "/")) throw Error();
      const data = await readFile(path);
      res.writeHead(200, {
        "content-type":
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".woff2": "font/woff2",
            ".svg": "image/svg+xml",
          }[extname(path)] ?? "application/octet-stream",
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`Synthetic QA only: http://127.0.0.1:${port}`));
