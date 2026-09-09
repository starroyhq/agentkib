// Synthetic, loopback-only visual QA harness. Never packaged; never calls runtime/IPC.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
const root = resolve(import.meta.dirname, "../dist");
const port = Number(process.env.QA_PORT || 1423);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid QA_PORT");
let status = "unpaired",
  pairedAt = 0,
  revision = 1;
let approvalPending = false;
let questionPending = false;
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
const live = () => ({
  sessionId: "qa-session",
  status: questionPending ? "waiting-input" : approvalPending ? "waiting-approval" : "idle",
  turnId: "qa-turn",
  revision,
  sendEnabled: !approvalPending && !questionPending,
  questions: questionPending
    ? [
        {
          requestId: `qa-question-${revision}`,
          turnId: "qa-turn",
          method: "claude/AskUserQuestion",
          supported: true,
          questions: [
            {
              id: "color",
              header: "颜色",
              question: "请选择测试颜色",
              multiSelect: false,
              allowCustom: true,
              options: [
                { label: "蓝色", description: "冷色" },
                { label: "绿色", description: "自然色" },
              ],
            },
            {
              id: "checks",
              header: "检查项",
              question: "选择检查项（可多选）",
              multiSelect: true,
              allowCustom: true,
              options: [
                { label: "键盘", description: "焦点与提交" },
                { label: "布局", description: "窄屏与主题" },
              ],
            },
          ],
        },
      ]
    : [],
  approvals: approvalPending
    ? [
        {
          requestId: 42,
          turnId: "qa-turn",
          method: "item/commandExecution/requestApproval",
          command: ["/usr/bin/true"],
          cwd: "/tmp",
          supported: true,
          availableDecisions: ["accept", "decline", "cancel"],
        },
      ]
    : [],
});
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const json = (value) => {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname.startsWith("/api/")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const p = url.pathname.split("/").at(-1);
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
          csrfToken: "qa-only",
          bootId: "qa-only",
          experimentalEnabled: true,
          device:
            status === "approved"
              ? { id: "qa", name: "合成浏览器", send: true, approve: true }
              : undefined,
          pending:
            status === "pending"
              ? { id: "qa-pair", verification: "482 916", expiresAt: Date.now() + 300000 }
              : undefined,
        });
      }
      if (p === "catalog")
        return json({
          indexEnabled: true,
          workspaces: [
            { id: "agentkib", name: "合成测试", path: "/synthetic/agentkib" },
            { id: "workspace", name: "另一个项目", path: "/synthetic/other" },
          ],
          sessions: [
            {
              id: "qa-session",
              title: "验收会话 · 合成记录",
              agent: "codex",
              workspace_id: "agentkib",
              availability: "readable",
            },
            {
              id: "qa-long",
              title: "很长的会话标题用于验证窄屏截断和目录可读性",
              agent: "claude-code",
              workspace_id: "workspace",
              availability: "readable",
            },
          ],
        });
      if (p === "events")
        return json({
          events: url.searchParams.has("cursor")
            ? [item("older", "agent-message", "更早的合成记录")]
            : events,
          next_cursor: url.searchParams.has("cursor") ? undefined : "older",
          warnings: [],
        });
      if (p === "live") return json({ ...live(), sessionId: url.searchParams.get("sessionId") });
      if (p === "stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        const publish = () =>
          res.write(
            `event: snapshot\ndata: ${JSON.stringify({ ...live(), sessionId: url.searchParams.get("sessionId") })}\n\n`,
          );
        publish();
        const timer = setInterval(publish, 2000);
        req.on("close", () => clearInterval(timer));
        return;
      }
      if (p === "send") {
        revision++;
        questionPending = process.env.QA_INTERACTION === "question";
        approvalPending = !questionPending;
        return json({ accepted: true });
      }
      if (p === "approve") {
        revision++;
        approvalPending = false;
        return json({ accepted: true });
      }
      if (p === "answer") {
        revision++;
        questionPending = false;
        return json({ accepted: true });
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
