import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityAcp } from "../../../packages/backend/src/agents/antigravity/antigravity-acp";
import {
  AntigravityManagedRunner,
  antigravityTurnFailure,
} from "../../../packages/backend/src/agents/antigravity/antigravity-managed-runner";

type Frame = { id?: number | string; method?: string; params?: any; result?: any; error?: any };

/** An in-process `agy acp` (1.5.14) that answers as each test scripts it. */
function fakeCli() {
  const fromAgent = new PassThrough();
  const toAgent = new PassThrough();
  const frames: Frame[] = [];
  const config: Record<string, string> = { model: "flash", thought_level: "high", mode: "default" };
  const configOptions = () =>
    Object.entries(config).map(([id, currentValue]) => ({
      id,
      type: "select",
      currentValue,
      options: [],
    }));
  const send = (frame: Frame) =>
    fromAgent.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
  let onPrompt: (frame: Frame) => void = (frame) =>
    send({ id: frame.id, result: { stopReason: "end_turn" } });
  toAgent.setEncoding("utf8");
  let buffer = "";
  toAgent.on("data", (data: string) => {
    buffer += data;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, index)) as Frame;
      buffer = buffer.slice(index + 1);
      frames.push(frame);
      if (frame.method === "initialize")
        send({
          id: frame.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" },
            agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, load: {} } },
          },
        });
      if (frame.method === "session/new") {
        // The CLI announces the new session's commands before it answers.
        send({
          method: "session/update",
          params: {
            sessionId: "fresh",
            update: { sessionUpdate: "available_commands_update", availableCommands: [] },
          },
        });
        send({ id: frame.id, result: { sessionId: "fresh", configOptions: configOptions() } });
      }
      if (frame.method === "session/resume")
        send({
          id: frame.id,
          result: { sessionId: frame.params.sessionId, configOptions: configOptions() },
        });
      if (frame.method === "session/set_config_option") {
        config[frame.params.configId] = frame.params.value;
        send({ id: frame.id, result: { configOptions: configOptions() } });
      }
      if (frame.method === "session/prompt") onPrompt(frame);
    }
  });
  vi.spyOn(AntigravityAcp, "spawn").mockImplementation(
    (_executable, _args, _cwd, _env, options) => new AntigravityAcp(fromAgent, toAgent, options),
  );
  return {
    frames,
    send,
    prompt(handler: (frame: Frame) => void) {
      onPrompt = handler;
    },
    responses: () => frames.filter((frame) => frame.method === undefined && frame.result),
  };
}

const settle = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !check(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check()).toBe(true);
};

afterEach(() => vi.restoreAllMocks());

describe("Antigravity CLI control (agy acp 1.5.14)", () => {
  it("starts a session with the chosen options and changes them between turns", async () => {
    const cli = fakeCli();
    const runner = await AntigravityManagedRunner.connect(
      "/bin/agy",
      "/tmp",
      "",
      {},
      undefined,
      undefined,
      0,
      undefined,
      {
        create: true,
        config: { thought_level: "low", mode: "accept-edits", model: "flash" },
      },
    );
    expect(runner.sessionId).toBe("fresh");
    expect([runner.option("thought_level"), runner.option("mode")]).toEqual([
      "low",
      "accept-edits",
    ]);
    // Only options that differ are set.
    expect(
      cli.frames
        .filter((frame) => frame.method === "session/set_config_option")
        .map((frame) => frame.params.configId),
    ).toEqual(["thought_level", "mode"]);
    await runner.setOptions({ mode: "plan" }, Number(runner.snapshot().revision));
    expect(runner.option("mode")).toBe("plan");
    cli.prompt(() => {});
    await runner.send("Hello", Number(runner.snapshot().revision));
    await expect(
      runner.setOptions({ mode: "default" }, Number(runner.snapshot().revision)),
    ).rejects.toThrow("session-busy");
    runner.close();
  });

  it("auto-approves only the Project Agent's registered tools and shows the other requests", async () => {
    const cli = fakeCli();
    const runner = await AntigravityManagedRunner.connect(
      "/bin/agy",
      "/tmp",
      "known",
      {},
      undefined,
      undefined,
      0,
      undefined,
      {
        leadTools: {
          serverName: "agentkib_workers",
          url: "http://127.0.0.1:1/lead/x",
          toolNames: ["worker_list"],
        },
      },
    );
    expect(
      cli.frames.find((frame) => frame.method === "session/resume")?.params.mcpServers,
    ).toEqual([
      { type: "http", name: "agentkib_workers", url: "http://127.0.0.1:1/lead/x", headers: [] },
    ]);
    const options = [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ];
    const requestedTools = [
      "mcp_agentkib_workers_worker_list",
      "mcp_agentkib_workers_x_worker_list",
      "mcp_agentkib_workers_unregistered",
    ];
    cli.prompt(() => {
      requestedTools.forEach((name, index) =>
        cli.send({
          id: 900 + index,
          method: "session/request_permission",
          params: {
            sessionId: "known",
            options,
            toolCall: {
              sessionUpdate: "tool_call",
              toolCallId: `mcp-${index}`,
              name,
              kind: "other",
              title: `Run ${name}`,
              args: {},
              rawInput: {},
            },
          },
        }),
      );
      cli.send({
        id: 903,
        method: "session/request_permission",
        params: {
          sessionId: "known",
          options,
          toolCall: {
            sessionUpdate: "tool_call",
            toolCallId: "t2",
            name: "run_command",
            kind: "execute",
            title: "touch ran.txt",
            status: "pending",
            args: { CommandLine: "touch ran.txt", WaitMsBeforeAsync: 0, toolSummary: "x" },
            rawInput: { CommandLine: "touch ran.txt", WaitMsBeforeAsync: 0, toolSummary: "x" },
          },
        },
      });
    });
    await runner.send("List the workers", Number(runner.snapshot().revision));
    await settle(() => (runner.snapshot().approvals as unknown[]).length === 3);
    expect(cli.frames.find((frame) => frame.id === 900)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    const approvals = runner.snapshot().approvals as Array<Record<string, unknown>>;
    expect(approvals.map((approval) => approval.requestId)).toEqual(["901", "902", "903"]);
    expect(runner.snapshot().status).toBe("waiting-approval");
    expect(cli.frames.some((frame) => frame.id === 901 || frame.id === 902)).toBe(false);
    expect(approvals[2]).toMatchObject({
      supported: true,
      availableDecisions: ["allow", "deny"],
      toolCall: { kind: "execute", rawInput: { command: "touch ran.txt" } },
    });
    runner.close();
  });

  it("ends a turn Antigravity could not run as failed and keeps the session usable", async () => {
    const cli = fakeCli();
    const runner = await AntigravityManagedRunner.connect("/bin/agy", "/tmp", "known", {});
    cli.prompt((frame) =>
      cli.send({
        id: frame.id,
        error: { code: -32603, message: "RESOURCE_EXHAUSTED: quota exceeded" },
      }),
    );
    await runner.send("Hello", Number(runner.snapshot().revision));
    await settle(() => runner.snapshot().status === "idle" && runner.snapshot().turnId === null);
    expect(runner.snapshot()).toMatchObject({
      reason: "antigravity-usage-limited",
      sendEnabled: true,
    });
    expect(runner.connected).toBe(true);
    expect(antigravityTurnFailure("Please sign in to continue")).toBe("antigravity-login-required");
    expect(antigravityTurnFailure("model crashed")).toBe("antigravity-run-failed");
    runner.close();
  });
});
