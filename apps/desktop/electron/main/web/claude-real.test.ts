// @vitest-environment node
// Explicit opt-in only: this test incurs one real Claude turn in the specified test session.
import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { WebAccessService } from "./service";
import { PROTOCOL_VERSION } from "../../generated/runtime-protocol";

it.skipIf(process.env.AGENTKIB_CLAUDE_REAL_SESSION !== "3121ec99-e4cb-465b-8056-0d653212b113")(
  "real Claude test session receives one Web message and returns history",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agentkib-claude-acceptance-"));
    const data = join(root, "runtime");
    await mkdir(data);
    await writeFile(
      join(data, "preferences.json"),
      JSON.stringify({
        mcp_network: { port: 19423, lan_enabled: false, lan_risk_accepted: false },
      }),
    );
    const child = spawn(resolve("../../target/debug/agentkib-runtime"), [], {
      env: {
        ...process.env,
        AGENTKIB_BENCHMARK_DATA_DIR: data,
        AGENTKIB_APP_FLAVOR: "ai.agentkib.dev",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let seq = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const value = JSON.parse(line);
      const request = pending.get(value.id);
      if (!request) return;
      pending.delete(value.id);
      value.error ? request.reject(new Error(value.error.message)) : request.resolve(value.result);
    });
    const rpc = (method: string, params: unknown = {}): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    let service: WebAccessService | undefined;
    try {
      await rpc("agentkib.handshake", {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "agentkib-electron", version: "0.9.0" },
      });
      const workspace = await rpc("workspace.add", { path: "/Users/kouzen/Documents/data/test" });
      const sessions = await rpc("workspace.refreshSessions", {
        workspaceId: workspace.id,
        force: true,
      });
      const claude = sessions.filter((s: any) => s.agent === "claude-code");
      expect(claude).toHaveLength(1);
      const sessionId = claude[0].id;
      const socket = createServer();
      await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
      const port = (socket.address() as { port: number }).port;
      await new Promise<void>((done) => socket.close(() => done()));
      service = new WebAccessService({
        dataDir: join(root, "web"),
        staticDir: root,
        acceptanceSessionId: sessionId,
        runtimeRequest: (params) => rpc("web.request", params),
      });
      await service.initialize();
      await service.request({
        operation: "configure",
        enabled: true,
        port,
        externalOrigin: "",
        experimentalEnabled: true,
      });
      const origin = `http://127.0.0.1:${port}`;
      let cookie = "",
        csrf = "";
      const http = async (path: string, body?: unknown) => {
        const response = await fetch(`${origin}/api/web/v1/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Cookie: cookie,
            ...(body === undefined
              ? {}
              : { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(25000),
        });
        if (response.headers.has("set-cookie"))
          cookie = response.headers.get("set-cookie")!.split(";")[0];
        const result = await response.json();
        expect(response.status, JSON.stringify(result)).toBe(200);
        return result;
      };
      const access = await http("access");
      csrf = access.csrfToken;
      const code = await service.request({ operation: "generate-code" });
      const paired = await http("pair", { code: code.code!.value, name: "Claude real acceptance" });
      const approvalDecision = process.env.AGENTKIB_CLAUDE_REAL_DECISION;
      const questionTest = process.env.AGENTKIB_CLAUDE_REAL_QUESTION === "1";
      expect(questionTest && !!approvalDecision).toBe(false);
      expect([undefined, "allow", "deny"]).toContain(approvalDecision);
      await service.request({
        operation: "approve",
        id: paired.pending.id,
        send: true,
        approve: !!approvalDecision,
      });
      const state = await http(`live?sessionId=${sessionId}`);
      expect(state.sendEnabled).toBe(true);
      const marker = `AK-CLAUDE-WEB-${Date.now()}`;
      const sent = await http("send", {
        sessionId,
        requestId: randomUUID(),
        bootId: access.bootId,
        expectedRevision: state.revision,
        text: questionTest
          ? `这是 Web 结构化提问验收。只调用一次 AskUserQuestion，询问“请选择测试颜色”，提供“蓝色”和“绿色”两个选项，单选。收到回答后只回复 ${marker} 和所选颜色。不调用其他工具，不读写文件，不访问网络，不创建任务或分支。`
          : approvalDecision
            ? `这是 Web 原生审批验收。仅申请通过 Bash 执行一次 /usr/bin/true，等待当前正常审批决定。不读写文件、不访问网络、不创建任务或分支，不申请持久权限。拒绝后立即结束，不重试、不换方式。决定后回复 ${marker} 并报告允许执行的退出码或拒绝结果。`
            : `这是 Web 真实回传验收。不要调用工具，不读写文件，不访问网络，不创建任务或分支，只回复：${marker} 收到。`,
      });
      expect(sent.accepted).toBe(true);
      const deadline = Date.now() + 90000;
      let completed = false;
      let approved = false;
      let answered = false;
      while (Date.now() < deadline) {
        const live = await http(`live?sessionId=${sessionId}`);
        expect(["unsupported", "outcome-unknown"], String(live.reason)).not.toContain(live.status);
        if (live.questions?.length) {
          expect(questionTest).toBe(true);
          expect(answered).toBe(false);
          expect(live.questions).toHaveLength(1);
          const question = live.questions[0];
          expect(question.supported).toBe(true);
          expect(question.questions).toHaveLength(1);
          const item = question.questions[0];
          expect(item.options.some((option: any) => option.label === "蓝色")).toBe(true);
          await http("answer", {
            sessionId,
            requestId: randomUUID(),
            bootId: access.bootId,
            expectedRevision: live.revision,
            turnId: question.turnId,
            questionId: question.requestId,
            answers: { [item.id]: ["蓝色"] },
          });
          answered = true;
        }
        if (live.approvals.length) {
          expect(approvalDecision).toBeDefined();
          expect(approved).toBe(false);
          expect(live.approvals).toHaveLength(1);
          const approval = live.approvals[0];
          expect(approval.method).toBe("claude/can_use_tool");
          expect(approval.toolName).toBe("Bash");
          expect(approval.input.command.trim()).toBe("/usr/bin/true");
          await http("approve", {
            sessionId,
            requestId: randomUUID(),
            bootId: access.bootId,
            expectedRevision: live.revision,
            turnId: approval.turnId,
            approvalId: approval.requestId,
            decision: approvalDecision,
          });
          approved = true;
        }
        if (live.status === "idle") {
          completed = true;
          break;
        }
        await new Promise((done) => setTimeout(done, 1000));
      }
      expect(completed).toBe(true);
      if (approvalDecision) expect(approved).toBe(true);
      if (questionTest) expect(answered).toBe(true);
      const history = await http(`events?sessionId=${sessionId}`);
      expect(
        history.events.some(
          (event: any) => event.kind === "agent-message" && event.content?.includes(marker),
        ),
      ).toBe(true);
      await service.request({ operation: "revoke", id: paired.pending.id });
      console.log("Claude real Web send + history return passed", marker);
    } finally {
      await service?.shutdown();
      child.stdin.end();
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          child.kill();
          done();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
      lines.close();
    }
  },
  150000,
);
