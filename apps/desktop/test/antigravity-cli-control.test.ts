import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { sessionInteractionItems } from "@agentkib/session-ui";
import type { Live } from "@agentkib/web-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityAcp } from "../../../packages/backend/src/agents/antigravity/antigravity-acp";
import {
  AntigravityManagedRunner,
  antigravityTurnFailure,
} from "../../../packages/backend/src/agents/antigravity/antigravity-managed-runner";
import { parseAntigravityReplay } from "../../../packages/backend/src/agents/antigravity/antigravity-replay";
import { Commands } from "../../../packages/backend/src/commands";
import { readControlReceipt } from "../../../packages/backend/src/control-receipt";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";
import { WebReadRequests } from "../../../packages/backend/src/web-read";

type Frame = { id?: number | string; method?: string; params?: any; result?: any; error?: any };

// Captured from agy acp 1.5.14 with a sandboxed MCP fixture. Session and tool call IDs are replaced.
const ordinaryMcpPermission = {
  id: "1",
  method: "session/request_permission",
  params: {
    sessionId: "known",
    toolCall: {
      sessionUpdate: "tool_call",
      toolCallId: "call-mcp-1",
      name: "mcp_rel2_fixture_record_approval",
      args: { marker: "DENY", toolSummary: "Record DENY approval marker" },
      status: "pending",
      kind: "other",
      title: "Run mcp_rel2_fixture_record_approval",
      rawInput: { marker: "DENY", toolSummary: "Record DENY approval marker" },
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  },
};

// The same CLI replays native-config MCP tools via call_mcp_tool. This payload comes from
// session/load of the cancelled sandbox turn, with the pending status used in the live envelope.
const nativeMcpInput = {
  Arguments: { marker: "DENY" },
  ServerName: "rel2_fixture",
  ToolName: "record_approval",
};
const nativeMcpToolCall = {
  ...ordinaryMcpPermission.params.toolCall,
  name: "call_mcp_tool",
  kind: "execute",
  title: "MCP Tool record_approval",
  args: nativeMcpInput,
  rawInput: nativeMcpInput,
};
const redactedMcpInput = {
  ...nativeMcpInput,
  Arguments: { ...nativeMcpInput.Arguments, token: "synthetic private argument" },
};
const extraMcpInput = { ...nativeMcpInput, CommandLine: "echo unexpected field" };
const emptyMcpInput = { ...nativeMcpInput, Arguments: {} };
const oversizedMcpInput = {
  ...nativeMcpInput,
  Arguments: { marker: "x".repeat(64 * 1024) },
};

/** An in-process `agy acp` (1.5.14) that answers as each test scripts it. */
function fakeCli({
  modeConfirmation,
  promptCapabilities,
}: {
  modeConfirmation?: "missing" | "mismatch" | "rejected" | "stale" | "confirmed";
  promptCapabilities?: Record<string, boolean>;
} = {}) {
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
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { resume: {}, load: {} },
              ...(promptCapabilities && { promptCapabilities }),
            },
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
        if (frame.params.configId === "model" && modeConfirmation === "stale") {
          config.model = frame.params.value;
          config.mode = "auto";
          send({ id: frame.id, result: {} });
          continue;
        }
        if (frame.params.configId === "mode") {
          if (modeConfirmation === "missing" || modeConfirmation === "stale") {
            send({ id: frame.id, result: {} });
            continue;
          }
          if (modeConfirmation === "rejected") {
            send({ id: frame.id, error: { code: -32602, message: "Invalid params" } });
            continue;
          }
        }
        if (frame.params.configId !== "mode" || modeConfirmation !== "mismatch")
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
  it("uses the admitted request for the live prompt and an echoed native identity for replay", async () => {
    const cli = fakeCli();
    cli.prompt(() => {});
    const publish = vi.fn();
    const onNativeUserMessage = vi.fn();
    const runner = await AntigravityManagedRunner.connect("/bin/agy", "/tmp", "known", {}, publish);
    const chunks = ["Report test ", "body"].map((text) => ({
      sessionUpdate: "user_message_chunk",
      messageId: "native-report-message",
      content: { type: "text", text },
    }));
    try {
      await runner.send("Report test body", Number(runner.snapshot().revision), undefined, {
        requestId: "host-report-request",
        accepted: Promise.resolve(true),
        onNativeUserMessage,
      });
      expect(publish.mock.lastCall?.[1]).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: "user-message",
            worker_report_request_id: "host-report-request",
          }),
        ]),
      });
      for (const update of chunks)
        cli.send({ method: "session/update", params: { sessionId: "known", update } });
      const prompt = cli.frames.find(({ method }) => method === "session/prompt")!;
      cli.send({ id: prompt.id, result: { stopReason: "end_turn" } });
      await settle(() => onNativeUserMessage.mock.calls.length === 1);
      expect(onNativeUserMessage).toHaveBeenCalledWith("antigravity-acp:native-report-message");
      const replay = parseAntigravityReplay(chunks);
      expect(replay.events).toMatchObject([
        {
          id: "antigravity-update-0",
          kind: "user-message",
          content: "Report test body",
          worker_report_native_message_id: "antigravity-acp:native-report-message",
        },
      ]);
    } finally {
      runner.close();
    }
  });

  it("projects ACP plans only during their active prompt and deduplicates repeat updates", async () => {
    const cli = fakeCli();
    const publish = vi.fn();
    cli.prompt(() => {});
    const runner = await AntigravityManagedRunner.connect("/bin/agy", "/tmp", "known", {}, publish);
    const update = (entries: unknown) =>
      cli.send({
        method: "session/update",
        params: { sessionId: "known", update: { sessionUpdate: "plan", entries } },
      });
    const step = { content: "Check the workspace", priority: "high", status: "in_progress" };
    const updates = () => publish.mock.calls.filter(([kind]) => kind === "state");
    const barrier = async () => {
      const count = publish.mock.calls.length;
      cli.send({
        method: "session/update",
        params: { sessionId: "known", update: { sessionUpdate: "session_info_update" } },
      });
      await settle(() => publish.mock.calls.length > count);
    };
    try {
      update([{ ...step, content: "Replay from a prior turn" }]);
      await barrier();
      expect(runner.snapshot().planProgress).toBeNull();
      await runner.send("First prompt", Number(runner.snapshot().revision));
      const turnId = runner.snapshot().turnId;
      expect(runner.snapshot().planProgress).toBeNull();
      update([step]);
      update([step]);
      update([{ ...step, status: "completed" }]);
      await settle(() => updates().length >= 2);
      expect(updates()).toHaveLength(2);
      const [, first] = updates()[0]!;
      expect(first.planProgress).toMatchObject({
        turnId,
        steps: [{ text: step.content, status: step.status }],
        currentStepId: first.planProgress.steps[0].id,
      });
      const plan = runner.snapshot().planProgress;
      expect(plan).toMatchObject({
        turnId,
        steps: [{ text: step.content, status: "completed" }],
        currentStepId: null,
      });
      const prompt = cli.frames.find(({ method }) => method === "session/prompt")!;
      cli.send({ id: prompt.id, result: { stopReason: "end_turn" } });
      await settle(() => runner.snapshot().status === "idle");
      update([{ ...step, content: "Late update for the finished prompt" }]);
      await barrier();
      expect(runner.snapshot().planProgress).toEqual(plan);
      await runner.send("Second prompt", Number(runner.snapshot().revision));
      expect(runner.snapshot().turnId).not.toBe(turnId);
      expect(runner.snapshot().planProgress).toBeNull();
      expect(updates()).toHaveLength(2);
    } finally {
      runner.close();
    }
  });

  it.each([
    "missing",
    "mismatch",
    "rejected",
    "stale",
    "confirmed",
    "already-active",
    "omitted",
  ] as const)(
    "requires native confirmation before the first Antigravity message (%s)",
    async (confirmation) => {
      const implicit = confirmation === "already-active" || confirmation === "omitted";
      const cli = fakeCli({ modeConfirmation: implicit ? "missing" : confirmation });
      const root = await realpath(await mkdtemp(join(tmpdir(), "ak-agy-create-")));
      const store = new BackendStore(join(root, "agentkib.db"));
      const commands = new Commands();
      const environment = {
        HOME: root,
        USERPROFILE: root,
        CODEX_HOME: join(root, ".codex"),
        PATH: root,
        AGENTKIB_ENABLE_ANTIGRAVITY_ACP: "1",
      };
      const readers = new SessionReaders(store.sessions, commands, environment, {
        profiles: () => [],
      });
      const web = new WebReadRequests(store, readers, root, () => 0n, environment);
      try {
        store.sql.run(
          "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
          "workspace",
          root,
          "Fixture",
          "healthy",
          "2026-11-16T00:00:00Z",
        );
        vi.spyOn(readers, "antigravityControlExecutable").mockReturnValue(join(root, "fake-agy"));
        vi.spyOn(readers, "list").mockResolvedValue({
          sessions: [
            {
              native_ref: "fresh",
              agent: "antigravity",
              title: "Fixture",
              origin: "interactive",
              created_at: null,
              updated_at: null,
              message_count: 1,
              git_branch: null,
              archived: false,
              sidechain: false,
              availability: "readable",
            },
          ],
          incomplete: false,
        });
        const request = {
          requestId: randomUUID(),
          deviceId: "phone",
          workspaceId: "workspace",
          prompt: "Only send with confirmed permissions",
          ...(confirmation === "omitted"
            ? {}
            : {
                permissionMode:
                  confirmation === "already-active" || confirmation === "stale"
                    ? "default"
                    : "plan",
              }),
          ...(confirmation === "stale" ? { model: "sonnet" } : {}),
        };
        const create = () => web.sessionProviderCreate("antigravity", request);
        const result = await create();
        const methods = cli.frames.map((frame) => frame.method);
        if (confirmation === "confirmed" || implicit) {
          expect(result).toMatchObject({
            accepted: true,
            sessionId: store.sessions.id("antigravity", "fresh"),
          });
          expect(methods).toEqual([
            "initialize",
            "session/new",
            ...(confirmation === "confirmed" ? ["session/set_config_option"] : []),
            "session/prompt",
          ]);
        } else {
          expect(result).toMatchObject({
            accepted: false,
            controlOutcome: "not-dispatched",
            reason: "create-permission-unconfirmed",
          });
          expect(
            readControlReceipt(root, { requestId: request.requestId, deviceId: request.deviceId }),
          ).toMatchObject({ status: "not-dispatched" });
          expect(methods).toEqual([
            "initialize",
            "session/new",
            ...(confirmation === "stale" ? ["session/set_config_option"] : []),
            "session/set_config_option",
          ]);
        }
        expect(await create()).toEqual(result);
      } finally {
        await web.closeAsync();
        readers.close();
        commands.close();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { support: undefined, length: 8, reason: "attachments-unsupported" },
    { support: { image: true }, length: 1024 * 1024, reason: "attachments_too_large" },
  ])(
    "rejects $reason before acknowledging a native dispatch",
    async ({ support, length, reason }) => {
      const cli = fakeCli({ promptCapabilities: support });
      const runner = await AntigravityManagedRunner.connect("/bin/agy", "/tmp", "known", {});
      try {
        const beforeDispatch = vi.fn();
        await expect(
          runner.send(
            [{ type: "image", mimeType: "image/png", data: "A".repeat(length) }],
            Number(runner.snapshot().revision),
            beforeDispatch,
          ),
        ).rejects.toThrow(reason);
        expect(beforeDispatch).not.toHaveBeenCalled();
        expect(runner.snapshot()).toMatchObject({ status: "idle", sendEnabled: true });
        expect(cli.frames.some(({ method }) => method === "session/prompt")).toBe(false);
      } finally {
        runner.close();
      }
    },
  );

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

  it.each([
    {
      label: "an ACP-registered tool",
      toolCall: ordinaryMcpPermission.params.toolCall,
      toolLabel: "mcp_rel2_fixture_record_approval",
      parameters: ["marker: DENY", "toolSummary: Record DENY approval marker"],
      decision: "allow",
    },
    {
      label: "a native-config tool in an ordinary session",
      toolCall: nativeMcpToolCall,
      toolLabel: "rel2_fixture / record_approval",
      parameters: ["marker: DENY"],
      decision: "allow",
    },
    {
      label: "a native-config tool in a Project Agent session",
      toolCall: nativeMcpToolCall,
      toolLabel: "rel2_fixture / record_approval",
      parameters: ["marker: DENY"],
      decision: "deny",
      projectAgent: true,
    },
    {
      label: "a native-config tool with no arguments",
      toolCall: { ...nativeMcpToolCall, args: emptyMcpInput, rawInput: emptyMcpInput },
      toolLabel: "rel2_fixture / record_approval",
      decision: "allow",
    },
    {
      label: "redacted native-config arguments",
      toolCall: { ...nativeMcpToolCall, args: redactedMcpInput, rawInput: redactedMcpInput },
      decision: null,
    },
    {
      label: "an unexpected native-config field",
      toolCall: { ...nativeMcpToolCall, args: extraMcpInput, rawInput: extraMcpInput },
      decision: null,
    },
    {
      label: "disagreeing native-config arguments",
      toolCall: {
        ...nativeMcpToolCall,
        args: { ...nativeMcpInput, Arguments: { marker: "ALLOW" } },
      },
      decision: null,
    },
    {
      label: "oversized native-config arguments",
      toolCall: { ...nativeMcpToolCall, args: oversizedMcpInput, rawInput: oversizedMcpInput },
      decision: null,
    },
  ])(
    "handles a captured MCP permission request with $label",
    async ({ decision, parameters, projectAgent, toolCall, toolLabel }) => {
      const cli = fakeCli();
      const leadTools = projectAgent
        ? {
            serverName: "agentkib_workers",
            url: "http://127.0.0.1:1/lead/x",
            toolNames: ["worker_list"],
          }
        : undefined;
      const runner = await AntigravityManagedRunner.connect(
        "/bin/agy",
        "/tmp",
        "known",
        {},
        undefined,
        undefined,
        0,
        undefined,
        { leadTools },
      );
      try {
        const frame = {
          ...ordinaryMcpPermission,
          params: { ...ordinaryMcpPermission.params, toolCall },
        };
        cli.prompt(() => cli.send(frame));
        await runner.send("Request approval", Number(runner.snapshot().revision));
        await settle(() => runner.snapshot().status === "waiting-approval");
        const live = runner.snapshot() as unknown as Live;
        const { items, approvals } = sessionInteractionItems(
          live,
          { bootId: "boot", experimentalEnabled: true, device: { approve: true, send: false } },
          {
            locale: "en-US",
            sessionId: "known",
            agent: "Antigravity",
            connection: "acp",
            canStop: false,
            ready: true,
            uncertain: false,
          },
        );
        expect(cli.responses()).toEqual([]);
        const [card] = items;
        expect(card).toMatchObject({ kind: "approval", enabled: decision !== null });
        if (card.kind !== "approval") throw new Error("Expected an approval card");
        const request = approvals.get(card.key)!;
        expect(request.requestId).toBe(frame.id);
        if (decision === null) {
          expect(card.model.choices).toEqual([]);
          expect(card.model.details).not.toContain("synthetic private argument");
          await expect(
            runner.approve(String(request.requestId), request.turnId, "allow", live.revision),
          ).rejects.toThrow("Antigravity approval is unavailable");
          expect(cli.responses()).toEqual([]);
          return;
        }
        // A lead can decide a worker's plain commands, but ACP's execute label also covers MCP.
        expect(request.toolCall).toMatchObject({ kind: "other" });
        expect(card.model).toMatchObject({
          title: `Allow Antigravity to use ${toolLabel}?`,
          choices: [
            { decision: "allow", label: "Allow", quick: "allow" },
            { decision: "deny", label: "Deny", quick: "deny" },
          ],
        });
        expect(card.model.block?.lines).toEqual(parameters);
        await runner.approve(String(request.requestId), request.turnId, decision, live.revision);
        expect(cli.responses()).toEqual([
          {
            id: frame.id,
            jsonrpc: "2.0",
            result: { outcome: { outcome: "selected", optionId: decision } },
          },
        ]);
      } finally {
        runner.close();
      }
    },
  );

  it.each([
    {
      label: "shell command",
      name: "run_command",
      kind: "execute",
      input: { CommandLine: "touch /tmp/synthetic-approval.txt", WaitMsBeforeAsync: 0 },
      decision: "allow",
    },
    {
      label: "ordinary MCP request",
      name: "mcp_fixture_lookup",
      kind: "other",
      input: { query: "synthetic record", limit: 2 },
      decision: "deny",
    },
    {
      label: "MCP request with no parameters",
      name: "mcp_fixture_list",
      kind: "other",
      input: {},
      decision: "allow",
    },
  ])(
    "projects a $label to the shared approval card and sends the exact choice",
    async ({ name, kind, input, decision }) => {
      const cli = fakeCli();
      const runner = await AntigravityManagedRunner.connect("/bin/agy", "/tmp", "known", {});
      try {
        cli.prompt(() =>
          cli.send({
            id: 910,
            method: "session/request_permission",
            params: {
              sessionId: "known",
              toolCall: {
                sessionUpdate: "tool_call",
                toolCallId: "approval-tool",
                kind,
                name,
                title: "Synthetic tool",
                status: "pending",
                rawInput: input,
                args: input,
              },
              options: [
                { optionId: "allow", name: "Allow once", kind: "allow_once" },
                { optionId: "deny", name: "Reject", kind: "reject_once" },
                { optionId: "always", name: "Always allow", kind: "allow_always" },
              ],
            },
          }),
        );
        await runner.send("Request approval", Number(runner.snapshot().revision));
        await settle(() => runner.snapshot().status === "waiting-approval");
        // As on the IPC/SSE path, render directly from the runtime snapshot, before a GET
        // can enrich it. Both readers use this builder to decide whether to offer actions.
        const live = runner.snapshot() as unknown as Live;
        const access = {
          bootId: "boot",
          experimentalEnabled: true,
          device: { approve: true, send: false },
        };
        const context = {
          locale: "en-US" as const,
          sessionId: "known",
          agent: "Antigravity",
          connection: "acp" as const,
          canStop: false,
          ready: true,
          uncertain: false,
        };
        const { items, approvals } = sessionInteractionItems(live, access, context);
        const [card] = items;
        expect(card).toMatchObject({
          kind: "approval",
          enabled: true,
          model: {
            title: `Allow Antigravity to use ${kind === "other" ? name : "Synthetic tool"}?`,
            choices: [
              { decision: "allow", label: "Allow once", quick: "allow" },
              { decision: "deny", label: "Reject", quick: "deny" },
            ],
          },
        });
        if (card.kind !== "approval") throw new Error("Expected an approval card");
        if (name === "mcp_fixture_lookup") expect(card.model.block?.lines).toContain("limit: 2");
        const request = approvals.get(card.key)!;
        expect(
          sessionInteractionItems(
            live,
            { ...access, device: { approve: false, send: true } },
            context,
          ).items[0],
        ).toMatchObject({ enabled: false });
        expect(
          sessionInteractionItems(live, access, { ...context, ready: false }).items[0],
        ).toMatchObject({ enabled: false });
        expect(cli.responses()).toEqual([]);

        await expect(
          runner.approve(String(request.requestId), request.turnId, "always", live.revision),
        ).rejects.toThrow("Antigravity approval option is unavailable");
        expect(cli.responses()).toEqual([]);
        const choice = card.model.choices.find((item) => item.decision === decision);
        expect(choice).toBeDefined();
        await runner.approve(
          String(request.requestId),
          request.turnId,
          choice!.decision!,
          live.revision,
        );
        expect(cli.responses()).toEqual([
          {
            id: 910,
            jsonrpc: "2.0",
            result: { outcome: { outcome: "selected", optionId: decision } },
          },
        ]);
        expect(runner.snapshot().approvals).toEqual([]);
      } finally {
        runner.close();
      }
    },
  );

  it.each([
    ["a non-MCP tool", { name: "unidentified_tool", rawInput: { query: "visible" } }],
    ["redacted arguments", { rawInput: { token: "synthetic private argument" } }],
    [
      "disagreeing argument fields",
      { rawInput: { query: "visible" }, args: { query: "different" } },
    ],
    [
      "an integer the card cannot represent exactly",
      { rawInput: { limit: 9_007_199_254_740_992 } },
    ],
  ])("keeps %s out of the native approval dispatch", async (_label, fields) => {
    const cli = fakeCli();
    const runner = await AntigravityManagedRunner.connect("/bin/agy", "/tmp", "known", {});
    try {
      cli.prompt(() =>
        cli.send({
          id: 911,
          method: "session/request_permission",
          params: {
            sessionId: "known",
            toolCall: {
              toolCallId: "unsupported",
              kind: "other",
              name: "mcp_fixture_lookup",
              ...fields,
            },
            options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
          },
        }),
      );
      await runner.send("Request approval", Number(runner.snapshot().revision));
      await settle(() => runner.snapshot().status === "waiting-approval");
      const live = runner.snapshot() as unknown as Live;
      expect(live.approvals).toMatchObject([
        { requestId: "911", supported: false, availableDecisions: [] },
      ]);
      expect(JSON.stringify(live.approvals)).not.toContain("synthetic private argument");
      await expect(runner.approve("911", live.turnId!, "allow", live.revision)).rejects.toThrow(
        "Antigravity approval is unavailable",
      );
      expect(cli.responses()).toEqual([]);
    } finally {
      runner.close();
    }
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
