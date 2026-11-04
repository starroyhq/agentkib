// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DshBridge, dshConversationEvents } from "../../../packages/backend/src/dsh-bridge";
import { readControlReceipt } from "../../../packages/backend/src/control-receipt";
import { createBridge } from "../../../packages/dsh-bridge-plugin/bridge.js";
import { dshBridgeCompatibility } from "../../../packages/dsh-bridge-plugin/compatibility.js";
import { historyRecord, queueItems } from "../../../packages/dsh-bridge-plugin/projection.js";

type Listener = { callback: (...args: any[]) => any; prepend: boolean };

/** Just enough of a DSH process: Cordis events and waterfalls, agents, queries and the session service. */
function fakeDsh(cwd: string) {
  const hooks = new Map<string, Listener[]>();
  const sessions = new Map<
    string,
    { events: any[]; agent: any; title: string | null; updatedAt: number }
  >();
  const prompts: any[] = [];
  const queueUpdates: any[] = [];
  const cancels: string[] = [];
  const disposers: Array<() => void> = [];
  const nativeAnswers: Array<{
    request: any;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];
  const emit = (name: string, ...args: any[]) => {
    for (const hook of hooks.get(name) ?? []) hook.callback(...args);
  };
  const append = (id: string, type: string, data: unknown) => {
    const session = sessions.get(id)!;
    const event = { seq: session.events.length, time: Date.now(), type, data };
    session.events.push(event);
    session.agent.session.seq = session.events.length;
    session.updatedAt = Date.now();
    emit("session/event", { id }, event);
    return event;
  };
  const ctx: any = {
    on(name: string, callback: (...args: any[]) => any, options?: { prepend?: boolean }) {
      const list = hooks.get(name) ?? [];
      const hook = { callback, prepend: options?.prepend === true };
      if (hook.prepend) list.unshift(hook);
      else list.push(hook);
      hooks.set(name, list);
      return () =>
        hooks.set(
          name,
          (hooks.get(name) ?? []).filter((item) => item !== hook),
        );
    },
    waterfall(thisArg: unknown, name: string, ...rest: any[]) {
      const inner = rest.pop();
      const callbacks = [...(hooks.get(name) ?? [])].map((hook) => hook.callback);
      const dispatch = (): any => {
        const callback = callbacks.shift();
        if (!callback) return inner();
        return callback.call(thisArg, ...rest, dispatch);
      };
      return dispatch();
    },
    effect(callback: () => () => void) {
      disposers.push(callback());
    },
    inject(_deps: string[], callback: () => void) {
      callback();
    },
    get(name: string) {
      return ctx[name];
    },
    agents: {
      get: (id: string) => sessions.get(id)?.agent,
      list: () => [...sessions.values()].map((session) => session.agent),
    },
    userQuestions: { ask: () => undefined },
    approval: { request: () => undefined },
    sessionQuery: {
      async observeSession(id: string) {
        const session = sessions.get(id);
        if (!session) throw new Error("not found");
        return {
          header: { id, cwd, createdAt: 1 },
          events: [...session.events],
          cursor: session.events.length - 1,
          [Symbol.dispose]() {},
        };
      },
      async listSessions() {
        return [...sessions.keys()].map((id) => ({
          header: { id, cwd, createdAt: 1 },
          live: true,
        }));
      },
    },
    sessionController: {
      async list() {
        return {
          items: [...sessions.entries()].map(([sessionId, session]) => ({
            sessionId,
            cwd,
            updatedAt: session.updatedAt,
            running: session.agent.status === "running",
            agentAvailable: true,
            blank: false,
            projections: { kind: "sequenced", asOfSeq: 0, values: { title: session.title } },
          })),
        };
      },
      async prompt(request: any) {
        prompts.push(request);
        const session = sessions.get(request.sessionId)!;
        if (
          session.events.some(
            (event) =>
              event.type === "user/message" && event.data.source.rpcId === request.requestId,
          )
        )
          return { accepted: true };
        session.agent.status = "running";
        emit("agent/status", { agent: session.agent, status: "running" });
        append(request.sessionId, "turn/start", { turn: 1 });
        append(request.sessionId, "user/message", {
          role: "user",
          id: randomUUID(),
          content: request.content,
          source: { kind: "user", rpcId: request.requestId },
        });
        return { accepted: true };
      },
      async updateQueue(request: any) {
        queueUpdates.push(request);
        return { accepted: true };
      },
      cancel(request: any) {
        cancels.push(request.sessionId);
        return { accepted: true };
      },
    },
  };
  // DSH's own browser UI answers through a forwarded, non-prepended waterfall listener.
  for (const event of ["approval/request", "user-questions/request"])
    ctx.on(
      event,
      (request: any) =>
        new Promise((resolve, reject) => {
          const entry = { request, resolve, reject };
          nativeAnswers.push(entry);
          request.signal?.addEventListener("abort", () => reject(new Error("withdrawn")), {
            once: true,
          });
        }),
    );
  const create = (id: string, title: string) => {
    const agent = {
      id,
      status: "idle",
      inbox: { nextTurn: [], nextStep: [] },
      session: { id, seq: 0 },
    };
    sessions.set(id, { events: [], agent, title, updatedAt: Date.now() });
    emit("agent/created", { agent, source: "startup" });
    return agent;
  };
  const finishTurn = (id: string, text: string) => {
    const session = sessions.get(id)!;
    append(id, "assistant/message", {
      turn: 1,
      step: 0,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    append(id, "turn/end", { turn: 1, reason: { kind: "completed" } });
    session.agent.status = "idle";
    emit("agent/status", { agent: session.agent, status: "idle" });
  };
  return {
    ctx,
    sessions,
    prompts,
    queueUpdates,
    cancels,
    nativeAnswers,
    create,
    append,
    finishTurn,
    emit,
    close: () => disposers.forEach((dispose) => dispose()),
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until<T>(read: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-dsh-test-")));
  const workspace = path.join(root, "workspace");
  const agentkibHome = path.join(root, "agentkib-home");
  mkdirSync(workspace);
  const publish = vi.fn();
  const changed: string[][] = [];
  const bridge = new DshBridge({
    dataDir: path.join(root, "data"),
    bootId: randomUUID(),
    pluginDirectory: path.join(root, "plugin"),
    discoveryFile: path.join(agentkibHome, "dsh-bridge", "discovery-v1.json"),
    platform: "darwin",
    commandTimeoutMs: 1500,
    disconnectGraceMs: 100,
    reconcileIntervalMs: 0,
    reconcileGiveUpMs: 300,
    sessionId: (nativeId) => `ak-${nativeId}`,
    workspaceFor: (cwd) =>
      cwd.startsWith(workspace) ? { id: "workspace", path: workspace } : null,
    sessionsChanged: (ids) => changed.push(ids),
    publish,
  });
  bridge.initialize();
  const dsh = fakeDsh(workspace);
  dsh.create("session-a", "First DSH session");
  const plugin = createBridge(dsh.ctx, {
    roots: [agentkibHome],
    dshVersion: "0.2.1-rc.5",
    discoveryMs: 50,
    debounceMs: 10,
  });
  cleanups.push(async () => {
    plugin.close();
    dsh.close();
    await bridge.close();
    rmSync(root, { recursive: true, force: true });
  });
  await until(() => bridge.handles("ak-session-a"));
  // The first report lists the session; the next acknowledges the watch list.
  await until(() => plugin.hosts.size > 0 && [...plugin.hosts.values()][0]!.watch.has("session-a"));
  let lastBody: Record<string, unknown> = {};
  const control = (operation: string, extra: Record<string, unknown> = {}) => {
    const live = bridge.live("ak-session-a", true);
    lastBody = {
      operation,
      sessionId: "ak-session-a",
      requestId: randomUUID(),
      deviceId: "device-1",
      runtimeBootId: live.runtimeBootId,
      expectedRevision: live.revision,
      experimentalEnabled: true,
      ...extra,
    };
    return bridge.request(lastBody) as Promise<Record<string, any>>;
  };
  return {
    root,
    workspace,
    agentkibHome,
    bridge,
    dsh,
    plugin,
    publish,
    changed,
    control,
    lastBody: () => lastBody,
  };
}

describe("DeepSeek Harness bridge", () => {
  it("publishes a private discovery file and lists sessions of registered workspaces", async () => {
    const f = await fixture();
    const discovery = path.join(f.agentkibHome, "dsh-bridge", "discovery-v1.json");
    expect(statSync(discovery).mode & 0o777).toBe(0o600);
    const value = JSON.parse(readFileSync(discovery, "utf8"));
    expect(value).toMatchObject({ protocol: 1, key: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(statSync(value.socketPath).mode & 0o777).toBe(0o600);
    const listing = f.bridge.list(f.workspace);
    expect(listing.sessions).toEqual([
      expect.objectContaining({
        native_ref: "session-a",
        agent: "deepseek-harness",
        title: "First DSH session",
        availability: "readable",
      }),
    ]);
    expect(f.bridge.list(path.join(f.root, "elsewhere")).sessions).toEqual([]);
    expect(f.changed.flat()).toContain("workspace");
  });

  it("reads history pages through the plugin and keeps injected context out", async () => {
    const f = await fixture();
    f.dsh.append("session-a", "turn/start", { turn: 1 });
    f.dsh.append("session-a", "user/message", {
      role: "user",
      id: "m1",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "r1" },
    });
    f.dsh.append("session-a", "user/message", {
      role: "user",
      id: "m2",
      content: [{ type: "text", text: "<AGENTS.md contents>" }],
      source: { kind: "context-notice" },
    });
    f.dsh.append("session-a", "tool/call", {
      turn: 1,
      step: 0,
      callId: "c1",
      name: "bash",
      arguments: "{}",
    });
    f.dsh.append("session-a", "tool/result", {
      turn: 1,
      step: 0,
      message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "ok" }] },
    });
    f.dsh.append("session-a", "assistant/message", {
      turn: 1,
      step: 1,
      message: {
        role: "assistant",
        content: [
          { type: "reasoning", text: "hidden" },
          { type: "text", text: "done" },
        ],
      },
    });
    const page = await f.bridge.events("session-a", null, 50);
    expect(page.events.map((event) => [event.kind, event.content, event.tool_status])).toEqual([
      ["user-message", "hello", null],
      ["tool-summary", "ok", "completed"],
      ["agent-message", "done", null],
    ]);
    expect(JSON.stringify(page)).not.toContain("AGENTS.md");
    expect(JSON.stringify(page)).not.toContain("hidden");
    await expect(f.bridge.events("session-a", "codex-native-v1:1", 10)).rejects.toThrow(
      "TRANSCRIPT_CURSOR_STALE",
    );
  });

  it("sends through DSH's session service once per request and records a receipt", async () => {
    const f = await fixture();
    const result = await f.control("send", { text: "run the tests" });
    expect(result).toMatchObject({ accepted: true, controlOutcome: "accepted" });
    expect(f.dsh.prompts).toEqual([
      expect.objectContaining({
        sessionId: "session-a",
        requestId: result.requestId,
        mode: "queue",
      }),
    ]);
    // The same request replays the stored outcome instead of reaching DSH again; the same
    // request ID with a different body is refused.
    const body = f.lastBody();
    const replay = (await f.bridge.request(body)) as Record<string, unknown>;
    expect(replay).toMatchObject({ requestId: result.requestId, controlOutcome: "accepted" });
    // What was stored carries the settled state, not the moment the request was unconfirmed.
    expect(replay.live).not.toMatchObject({ status: "outcome-unknown" });
    expect(f.dsh.prompts).toHaveLength(1);
    await expect(f.bridge.request({ ...body, text: "something else" })).rejects.toThrow(
      "request-id-reused-with-different-input",
    );
    expect(
      readControlReceipt(f.bridge.options.dataDir, {
        requestId: result.requestId,
        deviceId: "device-1",
      }),
    ).toMatchObject({
      found: true,
      status: "accepted",
    });
    const live = await until(() => {
      const value = f.bridge.live("ak-session-a", true);
      return value.status === "running" && value;
    });
    expect(live).toMatchObject({
      executionMode: "dsh-follower",
      executionLocation: "external",
      sendEnabled: false,
      stopEnabled: true,
      turnId: "dsh-turn-1",
    });
    const stopped = await f.control("stop", { turnId: "dsh-turn-1" });
    expect(stopped).toMatchObject({ accepted: true });
    expect(f.dsh.cancels).toEqual(["session-a"]);
  });

  it("keeps the control revision while DSH streams, so a queued message is not stale", async () => {
    const f = await fixture();
    await f.control("send", { text: "run the tests" });
    const running = await until(() => {
      const value = f.bridge.live("ak-session-a", true);
      return value.status === "running" && value;
    });
    const agent = f.dsh.sessions.get("session-a")!.agent;
    for (const text of ["Working", " on", " it"])
      f.dsh.emit("agent/assistant-stream", {
        agent,
        frame: { type: "chunk", chunk: { type: "text-delta", text } },
      });
    await until(() => f.bridge.live("ak-session-a", true).streamText === "Working on it");
    expect(f.bridge.live("ak-session-a", true).revision).toBe(running.revision);
    // Decided on the revision seen before the text arrived.
    const queued = await f.bridge.request({
      operation: "queue-add",
      sessionId: "ak-session-a",
      requestId: randomUUID(),
      deviceId: "device-1",
      runtimeBootId: running.runtimeBootId,
      expectedRevision: running.revision,
      experimentalEnabled: true,
      text: "and then the lint",
    });
    expect(queued).toMatchObject({ accepted: true });
  });

  it("lists only messages waiting for the next turn and steers one into the running turn", async () => {
    const f = await fixture();
    await f.control("send", { text: "run the tests" });
    await until(() => f.bridge.live("ak-session-a", true).status === "running");
    const agent = f.dsh.sessions.get("session-a")!.agent;
    const message = (id: string, text: string) => ({
      id,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "user" },
    });
    agent.inbox.nextTurn = [message("q1", "after this turn")];
    agent.inbox.nextStep = [message("s1", "already steering")];
    f.publish.mockClear();
    f.dsh.emit("agent/status", { agent, status: "running" });
    await until(() => f.bridge.live("ak-session-a", true).queuedCount === 1);
    // Queue readers refetch on this signal, not on every streamed state change.
    expect(
      f.publish.mock.calls.some(
        ([id, type, payload]) =>
          id === "ak-session-a" && type === "invalidate" && payload.domains?.includes("queue"),
      ),
    ).toBe(true);
    // Steering is part of the running turn already, so only q1 is waiting.
    const queued = (await f.bridge.request({
      operation: "queue-list",
      sessionId: "ak-session-a",
    })) as { data: { id: string }[] };
    expect(queued.data.map((item) => item.id)).toEqual(["q1"]);
    expect(f.bridge.live("ak-session-a", true).queuedCount).toBe(1);
    await expect(f.control("queue-steer", { queuedSubmissionId: "s1" })).resolves.toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "queue-item-unavailable",
    });
    const steered = await f.control("queue-steer", { queuedSubmissionId: "q1" });
    expect(steered).toMatchObject({ accepted: true });
    expect(f.dsh.queueUpdates).toEqual([
      expect.objectContaining({ sessionId: "session-a", itemId: "q1", action: { kind: "steer" } }),
    ]);
  });

  it("shows an approval in both places and the first answer wins", async () => {
    const f = await fixture();
    const outer = new AbortController();
    const agent = f.dsh.sessions.get("session-a")!.agent;
    const pending = f.dsh.ctx.waterfall(
      { scoped: agent },
      "approval/request",
      { agent, toolName: "bash", reason: "needs network", signal: outer.signal },
      () => Promise.resolve("unavailable"),
    );
    const live = await until(() => {
      const value = f.bridge.live("ak-session-a", true);
      return (value.approvals as unknown[]).length > 0 && value;
    });
    expect(live.status).toBe("awaiting-approval");
    const approval = (live.approvals as any[])[0];
    expect(approval).toMatchObject({
      method: "dsh/approval",
      toolName: "bash",
      supported: true,
      availableDecisions: ["accept", "decline"],
    });
    // DSH's own UI received the same request through the re-dispatched copy.
    expect(f.dsh.nativeAnswers).toHaveLength(1);
    const answered = await f.control("approve", {
      turnId: approval.turnId,
      approvalId: approval.requestId,
      decision: "accept",
    });
    expect(answered).toMatchObject({ accepted: true });
    await expect(pending).resolves.toBe("allowed-once");
    // AgentKib answered first, so the DSH UI copy is withdrawn.
    await expect(
      new Promise((resolve, reject) =>
        f.dsh.nativeAnswers[0]!.request.signal.aborted
          ? resolve("aborted")
          : reject(new Error("still open")),
      ),
    ).resolves.toBe("aborted");
    await until(() => (f.bridge.live("ak-session-a", true).approvals as unknown[]).length === 0);
  });

  it("withdraws the AgentKib copy when DSH's UI answers first", async () => {
    const f = await fixture();
    const agent = f.dsh.sessions.get("session-a")!.agent;
    const pending = f.dsh.ctx.waterfall(
      { scoped: agent },
      "user-questions/request",
      {
        agent,
        questions: [{ id: "q1", question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
      },
      () => Promise.reject(new Error("no answerer")),
    );
    const live = await until(() => {
      const value = f.bridge.live("ak-session-a", true);
      return (value.questions as unknown[]).length > 0 && value;
    });
    const question = (live.questions as any[])[0];
    expect(question).toMatchObject({ method: "dsh/question", supported: true });
    f.dsh.nativeAnswers[0]!.resolve({ answers: [{ id: "q1", selected: ["A"] }] });
    await expect(pending).resolves.toEqual({ answers: [{ id: "q1", selected: ["A"] }] });
    await until(() => (f.bridge.live("ak-session-a", true).questions as unknown[]).length === 0);
    // Refused before reaching DSH, and said so: the answer was not sent, not of unknown outcome.
    await expect(
      f.control("answer", {
        turnId: question.turnId,
        questionId: question.requestId,
        answers: { q1: ["B"] },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "interaction-answered-elsewhere",
    });
  });

  it("keeps a delivered send unknown until DSH's record confirms it", async () => {
    const f = await fixture();
    const original = f.dsh.ctx.sessionController.prompt;
    // The prompt reaches DSH, but its result never comes back.
    f.dsh.ctx.sessionController.prompt = (request: any) => {
      void original(request);
      return new Promise(() => undefined);
    };
    const result = await f.control("send", { text: "lost reply" });
    expect(result).toMatchObject({ accepted: false, controlOutcome: "unknown" });
    expect(result.live).toMatchObject({
      status: "outcome-unknown",
      sendEnabled: false,
      reason: "control-outcome-unconfirmed",
    });
    // DSH's next report brings it back from the record; a manual check finds the same.
    await f.bridge.request({ operation: "reconcile", sessionId: "ak-session-a" });
    await until(
      () =>
        readControlReceipt(f.bridge.options.dataDir, {
          requestId: result.requestId,
          deviceId: "device-1",
        }).status === "accepted",
    );
    expect(f.bridge.live("ak-session-a", true).reason).not.toBe("control-outcome-unconfirmed");
  });

  it("settles a send whose result never came back from DSH's own record", async () => {
    const f = await fixture();
    const controller = f.dsh.ctx.sessionController;
    const prompt = controller.prompt.bind(controller);
    let release!: () => void;
    controller.prompt = (request: any) =>
      new Promise((resolve) => {
        release = () => resolve(prompt(request));
      });
    const sent = await f.control("send", { text: "slow to take" });
    expect(sent).toMatchObject({ controlOutcome: "unknown" });
    expect(f.bridge.live("ak-session-a", true).reason).toBe("control-outcome-unconfirmed");
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Overdue, but DSH still works on it: absent from the record without being lost.
    await f.bridge.request({
      operation: "reconcile",
      sessionId: "ak-session-a",
      experimentalEnabled: true,
    });
    expect(f.bridge.live("ak-session-a", true).reason).toBe("control-outcome-unconfirmed");
    f.publish.mockClear();
    release();
    await until(() => f.bridge.live("ak-session-a", true).reason !== "control-outcome-unconfirmed");
    expect(
      readControlReceipt(f.bridge.options.dataDir, {
        requestId: sent.requestId,
        deviceId: "device-1",
      }),
    ).toMatchObject({ found: true, status: "accepted" });
    // Clients holding a fence for it read the receipt again.
    expect(
      f.publish.mock.calls.some(
        ([id, type, payload]) =>
          id === "ak-session-a" && type === "invalidate" && payload.domains?.includes("receipts"),
      ),
    ).toBe(true);
  });

  it("ends the wait for a send DSH has no trace of once it no longer works on it", async () => {
    const f = await fixture();
    let lose!: () => void;
    f.dsh.ctx.sessionController.prompt = () =>
      new Promise((_resolve, reject) => {
        lose = () => reject(new Error("lost"));
      });
    const sent = await f.control("send", { text: "never taken" });
    expect(sent).toMatchObject({ controlOutcome: "unknown" });
    lose();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await f.bridge.request({
      operation: "reconcile",
      sessionId: "ak-session-a",
      experimentalEnabled: true,
    });
    await until(
      () =>
        readControlReceipt(f.bridge.options.dataDir, {
          requestId: sent.requestId,
          deviceId: "device-1",
        }).status === "not-dispatched",
    );
    expect(f.bridge.live("ak-session-a", true)).toMatchObject({ sendEnabled: true });
  });

  it("keeps read history after DSH quits and reads it again when DSH returns", async () => {
    const f = await fixture();
    f.dsh.append("session-a", "user/message", {
      role: "user",
      id: "m1",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "r1" },
    });
    const page = await f.bridge.events("session-a", null, 50);
    expect(page.events).toHaveLength(1);
    f.plugin.close();
    // The dropped poll is noticed within the grace period, long before OFFLINE_MS.
    await until(() => f.bridge.live("ak-session-a", true).reason === "dsh-runtime-offline");
    expect(f.bridge.list(f.workspace).sessions).toEqual([
      expect.objectContaining({ native_ref: "session-a", availability: "readable" }),
    ]);
    // What this run read stays visible; an older page it never read is not made up.
    await expect(f.bridge.events("session-a", null, 50)).resolves.toEqual(page);
    await expect(f.bridge.events("session-a", "dsh-v1:1", 50)).rejects.toThrow(
      "dsh-runtime-offline",
    );
    f.publish.mockClear();
    const again = createBridge(f.dsh.ctx, {
      roots: [f.agentkibHome],
      dshVersion: "0.2.1-rc.5",
      discoveryMs: 50,
      debounceMs: 10,
    });
    cleanups.push(() => again.close());
    await until(() =>
      f.publish.mock.calls.some(
        ([id, type, payload]) =>
          id === "ak-session-a" && type === "invalidate" && payload.domains?.includes("history"),
      ),
    );
    expect(f.bridge.live("ak-session-a", true).executionLocation).toBe("external");
  });

  it("lists DSH sessions with empty history when no DSH ran since AgentKib started", async () => {
    const f = await fixture();
    f.plugin.close();
    await f.bridge.close();
    const reopened = new DshBridge({ ...f.bridge.options, discoveryFile: undefined });
    cleanups.push(() => reopened.close());
    expect(reopened.list(f.workspace).sessions).toEqual([
      expect.objectContaining({ native_ref: "session-a", availability: "readable" }),
    ]);
    // The live state explains why; the history is not an error.
    await expect(reopened.events("session-a", null, 50)).resolves.toEqual({
      events: [],
      next_cursor: null,
      warnings: [],
    });
    expect(reopened.live("ak-session-a", true)).toMatchObject({
      status: "unsupported",
      reason: "dsh-runtime-offline",
      sendEnabled: false,
    });
  });
});

describe("DeepSeek Harness plugin projections", () => {
  it("bounds versions and history records", () => {
    expect(dshBridgeCompatibility("0.2.1-rc.5")).toBe("verified");
    expect(dshBridgeCompatibility("0.2.2-alpha.3")).toBe("unverified");
    expect(dshBridgeCompatibility("0.2.1-rc.4")).toBe("too-old");
    expect(dshBridgeCompatibility("0.2.1")).toBe("unverified");
    expect(dshBridgeCompatibility("unknown")).toBe("unknown");
    expect(dshBridgeCompatibility("latest")).toBe("invalid");
    expect(historyRecord({ seq: 1, time: 1, type: "system/message", data: {} })).toBeNull();
    expect(
      historyRecord({
        seq: 2,
        time: 1,
        type: "user/message",
        data: { content: "x".repeat(70_000), source: { kind: "user" } },
      }),
    ).toMatchObject({ kind: "user", truncated: true });
    expect(
      queueItems({
        inbox: {
          nextTurn: [
            {
              id: "1",
              content: [{ type: "text", text: "queued" }],
              source: { kind: "user", rpcId: "r" },
            },
          ],
          nextStep: [{ id: "2", content: "notice", source: { kind: "context" } }],
        },
      }),
    ).toEqual([{ id: "1", placement: "queued", text: "queued", rpcId: "r" }]);
    expect(
      dshConversationEvents([
        {
          seq: 1,
          time: null,
          kind: "tool-result",
          turn: 1,
          callId: "x",
          isError: true,
          preview: "boom",
          truncated: false,
        },
      ]),
    ).toEqual([expect.objectContaining({ id: "dsh-tool:x", tool_status: "failed" })]);
  });
});
