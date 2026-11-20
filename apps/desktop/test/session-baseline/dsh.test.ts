// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DSH_BRIDGE_PATHS,
  DSH_BRIDGE_PLUGIN_VERSION,
  DSH_BRIDGE_PROTOCOL,
  type DshBridgeCommand,
  type DshBridgeDiscovery,
  type DshBridgeInteraction,
  type DshBridgeServices,
  type DshBridgeSessionState,
} from "@agentkib/runtime-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discover, post } from "../../../../packages/dsh-bridge-plugin/client.js";
import { startBackend, startHost } from "./harness";

const agent = "deepseek-harness";
const nativeId = "session-baseline";
const model = "deepseek/deepseek-chat";
const reasoner = "deepseek/deepseek-reasoner";
const turn = 3;
const turnId = "dsh-turn-3";

async function startFakePlugin(agentkibHome: string, workspace: string) {
  const discovery = await vi.waitFor(async () => {
    const [entry] = (await discover([agentkibHome])) as DshBridgeDiscovery[];
    if (!entry) throw new Error("DSH bridge is not listening");
    return entry;
  });
  const services: DshBridgeServices = {
    sessionController: true,
    sessionQuery: false,
    turnScopedCancel: true,
    approvals: true,
    questions: true,
    modelCatalog: true,
    sessionModelSelection: true,
    createModelSelection: true,
    commands: true,
    permissions: true,
  };
  const { token } = (await post(discovery.socketPath, DSH_BRIDGE_PATHS.register, {
    key: discovery.key,
    protocol: DSH_BRIDGE_PROTOCOL,
    pluginVersion: DSH_BRIDGE_PLUGIN_VERSION,
    dshVersion: "0.2.1-rc.5",
    runtimeId: randomUUID(),
    pid: process.pid,
    services,
  })) as { token: string };
  const selection = { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" };
  const options = [
    { value: "workspace-write", name: "Workspace write", description: null },
    { value: "read-only", name: "Read only", description: null },
  ];
  let selected = { ...selection };
  let policy = "workspace-write";
  let interactions: DshBridgeInteraction[] = [];
  const commands: DshBridgeCommand[] = [];
  const idleState = (sessionId: string): DshBridgeSessionState => ({
    sessionId,
    live: true,
    status: "idle",
    turn: null,
    cursor: -1,
    queue: [],
    streamText: "",
    streamTruncated: false,
    pending: 0,
    activity: null,
    goal: null,
  });
  const sessions = new Map([[nativeId, idleState(nativeId)]]);
  const stateFor = (sessionId: string) => {
    const state = sessions.get(sessionId);
    if (!state) throw new Error("Unknown fake DSH session: " + sessionId);
    return state;
  };
  const report = (extra: Record<string, unknown>) =>
    post(discovery.socketPath, DSH_BRIDGE_PATHS.report, { token, ...extra });
  const list = () =>
    [...sessions.keys()].map((sessionId) => ({
      sessionId,
      cwd: workspace,
      title: sessionId === nativeId ? "DSH baseline" : null,
      updatedAt: 1_700_000_000_000,
      running: false,
      live: true,
      blank: sessionId !== nativeId,
      parentSessionId: null,
      origin: null,
    }));
  await report({
    sessions: list(),
    states: [stateFor(nativeId)],
    commands: [
      { name: "permission", description: "Permission preset", hint: null, attachments: false },
    ],
  });

  // Model just the private plugin protocol. The real Host, RPC dispatcher, registry and
  // bridge translate the requests and persist receipts before the fake sees each command.
  async function execute(command: DshBridgeCommand) {
    // A post-turn history read checks quota independently of the control request.
    if (command.type !== "history") commands.push(command);
    switch (command.type) {
      case "create": {
        const state = idleState(command.sessionId);
        sessions.set(command.sessionId, state);
        await report({ sessions: list(), states: [state] });
        return {
          sessionId: command.sessionId,
          ...(command.modelSelection ? { selected: command.modelSelection } : {}),
        };
      }
      case "prompt": {
        const state = stateFor(command.sessionId);
        if (state.status === "idle") {
          state.status = "running";
          state.turn = turn;
        } else {
          state.queue.push({
            id: "submission-" + state.queue.length,
            placement: command.mode === "steer" ? "steering" : "queued",
            text: command.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
            images: 0,
            rpcId: command.requestId,
          });
        }
        await report({ states: [state] });
        return { sessionId: command.sessionId };
      }
      case "cancel-turn": {
        const state = stateFor(command.sessionId);
        state.status = "idle";
        state.turn = null;
        state.queue = [];
        await report({ states: [state] });
        return { sessionId: command.sessionId, turn: command.turn, accepted: true };
      }
      case "answer":
        interactions = interactions.filter((item) => item.id !== command.interactionId);
        await report({ interactions });
        return { found: true };
      case "history":
        return {
          sessionId: command.sessionId,
          cwd: workspace,
          createdAt: null,
          cursor: -1,
          records: [],
          nextBefore: null,
        };
      case "models":
        return {
          models: [
            { model: "deepseek-chat", name: "DeepSeek Chat" },
            { model: "deepseek-reasoner", name: "DeepSeek Reasoner" },
          ].map((entry) => ({
            ...entry,
            provider: "deepseek",
            providerName: "DeepSeek",
            efforts: [
              { id: "low", name: "Low" },
              { id: "high", name: "High" },
            ],
            defaultEffort: "low",
          })),
          default: selection,
          selected: command.sessionId ? selected : null,
        };
      case "permissions":
        return { options, current: policy };
      case "command":
        policy = command.line.slice("/permission ".length);
        return { matched: true, running: false, ok: true, text: "" };
      case "selectModel":
        selected = {
          provider: command.provider,
          model: command.model,
          reasoningEffort: command.reasoningEffort ?? "low",
        };
        return { selected };
      default:
        throw new Error("Unexpected DSH bridge command: " + command.type);
    }
  }
  const abort = new AbortController();
  const pollOptions = { signal: abort.signal, timeoutMs: 30_000 };
  let pollError: unknown;
  const polling = (async () => {
    while (!abort.signal.aborted) {
      const { commands: pending } = (await post(
        discovery.socketPath,
        DSH_BRIDGE_PATHS.poll,
        { token },
        pollOptions,
      )) as { commands: DshBridgeCommand[] };
      for (const command of pending) {
        const value = await execute(command);
        await post(discovery.socketPath, DSH_BRIDGE_PATHS.result, {
          token,
          commandId: command.commandId,
          ok: true,
          value,
        });
      }
    }
  })().catch((error: unknown) => {
    if (!abort.signal.aborted) pollError = error;
  });
  return {
    drainCommands: () => commands.splice(0).map(({ commandId: _commandId, ...command }) => command),
    async interact(interaction: DshBridgeInteraction) {
      const state = stateFor(interaction.sessionId);
      state.status = "running";
      state.turn = turn;
      interactions = [interaction];
      await report({ states: [state], interactions });
    },
    async close() {
      abort.abort();
      await polling;
      if (pollError) throw pollError;
    },
  };
}

describe.skipIf(process.platform !== "darwin")("DeepSeek Harness HTTP behavior baseline", () => {
  let root: string;
  let workspace: string;
  let host: Awaited<ReturnType<typeof startHost>>;
  let plugin: Awaited<ReturnType<typeof startFakePlugin>>;
  let sessionId: string;
  const cleanups: Array<() => Promise<unknown>> = [];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "ak-baseline-dsh-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    workspace = join(root, "workspace");
    const agentkibHome = join(root, ".agentkib");
    await mkdir(workspace);
    const backend = await startBackend({
      data: join(root, "data"),
      workspace,
      indexSessions: true,
      environment: {
        HOME: root,
        USERPROFILE: root,
        AGENTKIB_HOME: agentkibHome,
        AGENTKIB_DSH_PLUGIN_DIR: "",
        CLAUDE_CONFIG_DIR: join(root, ".claude"),
        CODEX_HOME: join(root, ".codex"),
        DSH_HOME: join(root, ".dsh"),
        XDG_CONFIG_HOME: join(root, ".config"),
        XDG_DATA_HOME: join(root, ".local", "share"),
        DEVIN_SESSIONS_DIR: join(root, ".local", "share", "devin"),
        PATH: "/usr/bin:/bin",
      },
    });
    cleanups.push(backend.close);
    plugin = await startFakePlugin(agentkibHome, workspace);
    cleanups.push(plugin.close);
    host = await startHost({ root, workspace, rpc: backend.rpc });
    cleanups.push(host.dispose);

    const catalog = (await backend.rpc("web.request", { operation: "catalog" })) as {
      sessions: { id: string; agent: string }[];
    };
    const [session] = catalog.sessions;
    expect(session).toMatchObject({ agent });
    sessionId = session!.id;
  });

  afterEach(async () => {
    let failure: unknown;
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  });

  const getLive = (id = sessionId) => host.http("/live?sessionId=" + id);
  const managedPath = (operation: string) =>
    "/managed/" + operation + "?agent=" + agent + "&sessionId=" + sessionId;

  async function mutate(
    operation: string,
    payload: Record<string, unknown>,
    nativeCommands: Record<string, unknown>[],
    expectedLive: Record<string, unknown>,
    targetSessionId = sessionId,
  ) {
    const sessionId = targetSessionId;
    const before = await getLive(sessionId);
    expect(before.status).toBe(200);
    const requestId = randomUUID();
    const dedicated = ["send", "stop", "approve", "answer"].includes(operation);
    const result = await host.http(dedicated ? "/" + operation : "/managed/action", {
      ...(dedicated ? {} : { agent, operation }),
      bootId: host.bootId,
      sessionId,
      expectedRevision: before.body.revision,
      requestId,
      ...payload,
    });
    expect(result).toMatchObject({
      status: 200,
      body: {
        accepted: true,
        completed: false,
        controlOutcome: "accepted",
        requestId,
        sessionId,
        runtimeBootId: before.body.runtimeBootId,
        ...(operation === "stop" ? { turnId } : {}),
        live: { sessionId, executionMode: "dsh-follower", ...expectedLive },
      },
    });
    expect(plugin.drainCommands()).toEqual(
      nativeCommands.map((command) =>
        ["prompt", "command"].includes(String(command.type)) ? { ...command, requestId } : command,
      ),
    );
    expect(host.calls).toContainEqual({
      method: "web.request",
      params: expect.objectContaining({
        operation,
        requestId,
        deviceId: host.deviceId,
        sessionId,
        expectedRevision: before.body.revision,
        runtimeBootId: before.body.runtimeBootId,
        experimentalEnabled: true,
        ...payload,
      }),
    });
    const receipt = await host.http("/requests/" + requestId);
    expect(receipt).toMatchObject({
      status: 200,
      body: {
        found: true,
        requestId,
        sessionId,
        workspaceId: "workspace",
        operation,
        executionMode: "dsh-follower",
        runtimeBootId: before.body.runtimeBootId,
        expectedRevision: before.body.revision,
        turnId: payload.turnId ?? null,
        status: "accepted",
        completionObserved: false,
        ack: result.body,
      },
    });
    expect(await getLive(sessionId)).toMatchObject({
      status: 200,
      body: { sessionId, executionMode: "dsh-follower", ...expectedLive },
    });
  }

  async function createBlankSession(prompt?: string) {
    const requestId = randomUUID();
    const result = await host.http("/managed/create", {
      agent,
      bootId: host.bootId,
      workspaceId: "workspace",
      requestId,
      model,
      effort: "high",
      ...(prompt === undefined ? {} : { prompt }),
    });
    expect(result).toEqual({
      status: 200,
      body: {
        accepted: true,
        completed: true,
        controlOutcome: "accepted",
        executionMode: "dsh-follower",
        requestId,
        runtimeBootId: expect.any(String),
        sessionId: expect.any(String),
      },
    });
    expect(host.calls).toContainEqual({
      method: "web.request",
      params: {
        operation: "provider-create",
        agent,
        requestId,
        deviceId: host.deviceId,
        workspaceId: "workspace",
        model,
        effort: "high",
      },
    });
    const resultId = String(result.body.sessionId);
    const live = await getLive(resultId);
    expect(live).toMatchObject({
      status: 200,
      body: {
        sessionId: resultId,
        sourceSessionId: expect.stringMatching(/^session-[a-f0-9-]{36}$/),
        workspaceId: "workspace",
        status: "idle",
        sendEnabled: true,
        turnId: null,
      },
    });
    expect(plugin.drainCommands()).toEqual([
      {
        type: "create",
        cwd: workspace,
        sessionId: live.body.sourceSessionId,
        modelSelection: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" },
      },
    ]);
    expect(await host.http("/requests/" + requestId)).toMatchObject({
      status: 200,
      body: {
        found: true,
        requestId,
        sessionId: resultId,
        workspaceId: "workspace",
        operation: "create",
        executionMode: "dsh-follower",
        status: "accepted",
        completionObserved: true,
        ack: result.body,
      },
    });
    return { id: resultId, nativeId: String(live.body.sourceSessionId) };
  }

  it.each([
    { title: "without a prompt" },
    { title: "with a prompt that the Host discards", prompt: "Initial browser message" },
  ])("creates a blank DSH session $title", async ({ prompt }) => {
    await createBlankSession(prompt);
  });

  it("sends the composer’s first message to the session created by the preceding request", async () => {
    const created = await createBlankSession();
    const text = "Initial browser message";
    await mutate(
      "send",
      { text },
      [
        {
          type: "prompt",
          sessionId: created.nativeId,
          mode: "queue",
          content: [{ type: "text", text }],
          fullAccess: true,
        },
      ],
      { status: "running", turnId, queuedCount: 0 },
      created.id,
    );
    expect(await getLive()).toMatchObject({ status: 200, body: { status: "idle" } });
  });

  it("reads options, capabilities, inspect and live through the DSH provider", async () => {
    const options = await host.http("/managed/options?agent=" + agent + "&workspaceId=workspace");
    expect(options).toMatchObject({
      status: 200,
      body: {
        available: true,
        provider: { create: { mode: "empty", catalogScope: "workspace" } },
        models: [
          { id: model, name: "DeepSeek Chat", efforts: ["low", "high"] },
          { id: reasoner, name: "DeepSeek Reasoner", efforts: ["low", "high"] },
        ],
        defaults: { model, effort: "low" },
        workspaces: [{ id: "workspace", name: "Offline workspace" }],
      },
    });
    expect(plugin.drainCommands()).toEqual([{ type: "models" }]);

    const live = await getLive();
    expect(live).toMatchObject({
      status: 200,
      body: {
        sessionId,
        sourceSessionId: nativeId,
        workspaceId: "workspace",
        executionMode: "dsh-follower",
        executionLocation: "external",
        status: "idle",
        turnId: null,
        sendEnabled: true,
        stopEnabled: false,
        queueEnabled: false,
        steerEnabled: false,
        queueEditEnabled: true,
        queuedCount: 0,
        approvals: [],
        questions: [],
      },
    });
    expect(await host.http(managedPath("capabilities"))).toMatchObject({
      status: 200,
      body: {
        sessionId,
        executionMode: "dsh-follower",
        status: "idle",
        features: {
          send: { available: true },
          stop: { available: false, reason: "operation-unavailable" },
          steer: { available: false, reason: "operation-unavailable" },
          "queue-add": { available: false, reason: "operation-unavailable" },
          approve: { available: false, reason: "operation-unavailable" },
          answer: { available: false, reason: "operation-unavailable" },
          settings: { available: true },
          inspect: { available: true },
        },
      },
    });
    expect(await host.http(managedPath("inspect"))).toMatchObject({
      status: 200,
      body: {
        sessionId,
        sourceSessionId: nativeId,
        workspaceId: "workspace",
        reconciled: false,
        live: live.body,
      },
    });
    expect(host.calls).toEqual(
      expect.arrayContaining([
        {
          method: "web.request",
          params: { operation: "provider-options", agent, workspaceId: "workspace" },
        },
        ...["capabilities", "inspect", "live"].map((operation) => ({
          method: "web.request",
          params: expect.objectContaining({ operation, sessionId, experimentalEnabled: true }),
        })),
      ]),
    );
    expect(plugin.drainCommands()).toEqual([]);
  });

  it("sends, steers, enqueues and stops the current turn", async () => {
    const prompt = (text: string, mode: string) => ({
      type: "prompt",
      sessionId: nativeId,
      mode,
      content: [{ type: "text", text }],
      fullAccess: true,
    });
    await mutate("send", { text: "Start" }, [prompt("Start", "queue")], {
      status: "running",
      turnId,
      queuedCount: 0,
    });
    await mutate("steer", { text: "Interrupt", turnId }, [prompt("Interrupt", "steer")], {
      status: "running",
      turnId,
      queuedCount: 0,
    });
    await mutate("queue-add", { text: "Later" }, [prompt("Later", "queue")], {
      status: "running",
      turnId,
      queuedCount: 1,
    });
    await mutate("stop", { turnId }, [{ type: "cancel-turn", sessionId: nativeId, turn }], {
      status: "idle",
      turnId: null,
      queuedCount: 0,
    });
  });

  it("maps approvals and answers to the native interaction protocol", async () => {
    const approvalId = randomUUID();
    await plugin.interact({
      id: approvalId,
      sessionId: nativeId,
      createdAt: 1_700_000_000_000,
      kind: "approval",
      toolName: "read_file",
      callId: "tool-call",
      reason: null,
      displayReason: null,
      arguments: JSON.stringify({ path: "notes.txt" }),
    });
    expect(await getLive()).toMatchObject({
      status: 200,
      body: {
        status: "awaiting-approval",
        approvals: [
          {
            requestId: approvalId,
            turnId,
            method: "dsh/approval",
            availableDecisions: ["accept", "decline"],
            supported: true,
          },
        ],
      },
    });
    await mutate(
      "approve",
      { approvalId, turnId, decision: "accept" },
      [{ type: "answer", interactionId: approvalId, value: { outcome: "allowed-once" } }],
      { status: "running", approvals: [] },
    );

    const questionId = randomUUID();
    await plugin.interact({
      id: questionId,
      sessionId: nativeId,
      createdAt: 1_700_000_000_000,
      kind: "question",
      questions: [
        {
          id: "choice",
          question: "Which one?",
          header: null,
          detail: null,
          multiSelect: true,
          options: [{ label: "A", description: null }],
          intent: null,
        },
      ],
    });
    expect(await getLive()).toMatchObject({
      status: 200,
      body: {
        status: "waiting-input",
        questions: [
          {
            requestId: questionId,
            turnId,
            method: "dsh/question",
            supported: true,
            questions: [{ id: "choice", multiSelect: true, allowCustom: true }],
          },
        ],
      },
    });
    await mutate(
      "answer",
      { questionId, turnId, answers: { choice: ["A", "Other"] } },
      [
        {
          type: "answer",
          interactionId: questionId,
          value: { answers: [{ id: "choice", selected: ["A"], custom: "Other" }] },
        },
      ],
      { status: "running", questions: [] },
    );
  });

  it("sets the permission preset before selecting the session model and effort", async () => {
    const projections = [
      { type: "models", sessionId: nativeId },
      { type: "permissions", sessionId: nativeId },
    ];
    const before = await host.http(managedPath("settings"));
    expect(before).toMatchObject({
      status: 200,
      body: {
        sessionId,
        current: { modelId: model, effort: "low", policyId: "workspace-write" },
        writable: { model: { available: true }, policy: { available: true } },
      },
    });
    expect(plugin.drainCommands()).toEqual(projections);
    await mutate(
      "settings",
      { model: reasoner, effort: "high", policyId: "read-only" },
      [
        ...projections,
        { type: "command", sessionId: nativeId, line: "/permission read-only" },
        {
          type: "selectModel",
          sessionId: nativeId,
          provider: "deepseek",
          model: "deepseek-reasoner",
          reasoningEffort: "high",
        },
      ],
      { status: "idle", sendEnabled: true },
    );
    expect(await host.http(managedPath("settings"))).toMatchObject({
      status: 200,
      body: { sessionId, current: { modelId: reasoner, effort: "high", policyId: "read-only" } },
    });
    expect(plugin.drainCommands()).toEqual(projections);
  });
});
