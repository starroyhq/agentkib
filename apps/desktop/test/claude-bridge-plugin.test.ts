// @vitest-environment node
import { randomUUID } from "node:crypto";
import { CLAUDE_BRIDGE_PLUGIN_VERSION } from "@agentkib/runtime-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  decodeTicket,
  connectionFailureText,
  initialState,
  previewText,
  probeCapabilities,
  observeNativeStream,
  register as productionRegister,
  safeSocket,
  validSend,
  visibleMessages,
} from "../../../packages/claude-bridge-plugin/hooks/register.js";

type Value = Record<string, any>;
type Hook = (api: Value, event: Value, next: (event: Value) => any) => any;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function collectStream(stream: AsyncGenerator<Value, unknown>) {
  const chunks: Value[] = [];
  let item = await stream.next();
  while (!item.done) {
    chunks.push(item.value);
    item = await stream.next();
  }
  return { chunks, result: item.value };
}

function measureUtf8Work() {
  const nativeEncode = TextEncoder.prototype.encode;
  const nativeEncodeInto = TextEncoder.prototype.encodeInto;
  const nativeCharCodeAt = String.prototype.charCodeAt;
  const work = { calls: 0, readUnits: 0, capacity: 0, charCodeAtCalls: 0 };
  const encode = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(function (
    this: TextEncoder,
    input = "",
  ) {
    const result = nativeEncode.call(this, input);
    work.calls++;
    work.readUnits += input.length;
    work.capacity += result.byteLength;
    return result;
  });
  const encodeInto = vi
    .spyOn(TextEncoder.prototype, "encodeInto")
    .mockImplementation(function (this: TextEncoder, input, destination) {
      const result = nativeEncodeInto.call(this, input, destination);
      work.calls++;
      work.readUnits += result.read;
      work.capacity += destination.byteLength;
      return result;
    });
  const charCodeAt = vi
    .spyOn(String.prototype, "charCodeAt")
    .mockImplementation(function (this: string, index) {
      work.charCodeAtCalls++;
      return nativeCharCodeAt.call(this, index);
    });
  return {
    checkpoint: () => ({ ...work }),
    reset() {
      work.calls = 0;
      work.readUnits = 0;
      work.capacity = 0;
      work.charCodeAtCalls = 0;
    },
    restore() {
      charCodeAt.mockRestore();
      encode.mockRestore();
      encodeInto.mockRestore();
    },
  };
}

const STREAM_BUDGET = 96 * 1024;
const PREVIEW_END = "\n[AgentKib preview truncated; read the original history for full content]";

function expectedUtf8Preview(value: string, budget: number) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= budget) return value;
  const prefix = bytes.subarray(0, budget - Buffer.byteLength(PREVIEW_END));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // An independent byte-based oracle discards at most an incomplete final
  // UTF-8 code point; it does not share the plugin's UTF-16 slicing logic.
  for (let end = prefix.length; end >= prefix.length - 3; end--) {
    try {
      return decoder.decode(prefix.subarray(0, end)) + PREVIEW_END;
    } catch {
      /* The cut fell inside a multi-byte code point. */
    }
  }
  throw new Error("invalid UTF-8 preview prefix");
}

async function fixture(
  options: {
    connect?: boolean;
    features?: string[];
    activeAtStart?: boolean;
    storedCredential?: boolean;
    version?: string;
    credentialVersion?: string;
    httpInterceptor?: (url: string) => Promise<void>;
    /** `$.clock.sleep`; by default a short real wait. */
    sleep?: (ms: number) => Promise<void>;
    storeGetInterceptor?: (key: string) => Promise<void>;
    configure?: (api: Value) => void;
  } = {},
) {
  const hooks = new Map<string, Array<{ match: Value; hook: Hook }>>();
  const register = productionRegister;
  register((name: string, matcher: Value | Hook, handler?: Hook) => {
    const hook = typeof matcher === "function" ? matcher : handler!;
    const match = typeof matcher === "function" ? {} : matcher;
    hooks.set(name, [...(hooks.get(name) ?? []), { match, hook }]);
    return { catch: () => undefined };
  });
  const nativeId = randomUUID();
  let cwd = "/isolated/workspace";
  let version = options.version ?? "2.1.301";
  let command: Value | null = null;
  let dispatches = 0;
  let stops = 0;
  let messages: Value[] = [{ role: "user", text: "native history" }];
  let interceptHttp = options.httpInterceptor;
  // Whether a Runtime listens on the socket; liveness checks are counted apart from requests.
  let reachable = true;
  const pings: string[] = [];
  const nextResponses = new Map<string, Value>();
  const calls: Array<{ url: string; init: Value; body: Value }> = [];
  const timers: Array<() => Promise<void>> = [];
  const stored = new Map<string, unknown>();
  const connection = {
    protocol: 1,
    ...(options.features ? { features: options.features } : {}),
    bindingId: randomUUID(),
    token: "a".repeat(64),
    leaseId: randomUUID(),
    credentialPath: "/private/app/claude-bridge/credential.json",
  };
  let submit: (value: Value) => Promise<Value>;
  const api: Value = {
    session: {
      id: async () => nativeId,
      cwd: async () => cwd,
      root: async () => cwd,
      version: async () => ({ version }),
      messages: async () => messages,
      usage: async () => ({ context: { tokens: 32, window: 100, percent: 32 } }),
    },
    command: { register: async () => undefined },
    store: {
      get: async (key: string) => {
        await options.storeGetInterceptor?.(key);
        return stored.get(key);
      },
      set: async (key: string, value: unknown) => stored.set(key, value),
    },
    plugin: { root: "/synthetic/plugin" },
    fs: {
      read: async (path: string) =>
        path === "/synthetic/plugin/package.json"
          ? JSON.stringify({ version: "0.4.0" })
          : JSON.stringify({
              ...connection,
              socketPath: "/private/bridge.sock",
              nativeId,
              cwd,
              cliVersion: options.credentialVersion ?? version,
              pluginVersion: "0.4.0",
            }),
    },
    clock: {
      every: (_ms: number, callback: () => Promise<void>) => timers.push(callback),
      sleep: (ms: number) =>
        options.sleep?.(ms) ??
        new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 20))),
    },
    http: {
      fetch: async (url: string, init: Value) => {
        if (init.method === "GET") {
          pings.push(url);
          if (!reachable) throw new Error("connect ECONNREFUSED");
          return {
            ok: false,
            status: 403,
            text: JSON.stringify({ error: "bridge-request-rejected" }),
          };
        }
        const body = JSON.parse(init.body);
        calls.push({ url, init, body });
        await interceptHttp?.(url);
        const forced = nextResponses.get(url);
        if (forced) {
          nextResponses.delete(url);
          return { ok: false, status: forced.status, text: JSON.stringify(forced.body) };
        }
        let result: Value = {};
        if (url.endsWith("/pair") || url.endsWith("/reconnect")) result = connection;
        else if (url.endsWith("/events")) result = { ackSeq: body.events.at(-1).seq };
        else if (url.endsWith("/commands")) {
          result = { commands: command ? [command] : [] };
          command = null;
        }
        return { ok: true, status: 200, text: JSON.stringify(result) };
      },
    },
    prompt: {
      submit: async (value: Value) => {
        dispatches++;
        return submit(value);
      },
    },
    turn: {
      abort: async () => {
        stops++;
      },
    },
  };
  function run(name: string, event: Value, bottom: (value: Value) => any = (value) => value): any {
    const rows = (hooks.get(name) ?? []).filter(({ match }) =>
      Object.entries(match).every(([key, value]) => event[key] === value),
    );
    const visit = (index: number, value: Value): any =>
      index === rows.length
        ? bottom(value)
        : rows[index].hook(api, value, (next) => visit(index + 1, next));
    return visit(0, event);
  }
  submit = async (value) => {
    // Native self-call re-entry skips the sender's own prompt.submit hook.
    await run("session.append", {
      door: "prompt",
      origin: { kind: "plugin", name: "agentkib-bridge", asUser: true },
      uuid: randomUUID(),
      message: { type: "user", content: [{ type: "text", text: value.text }] },
    });
    const turnId = randomUUID();
    await run("turn.start", { text: value.text, turnId });
    return { text: value.text };
  };
  if (options.storedCredential) stored.set(`credentialPath:${nativeId}`, connection.credentialPath);
  options.configure?.(api);
  let nativeStarts = 0;
  await run("session.start", { cwd, isInteractive: true, surface: "terminal" }, (value) => {
    nativeStarts++;
    return value;
  });
  const ticket = Buffer.from(
    JSON.stringify({ protocol: 1, socketPath: "/private/bridge.sock", ticket: "t".repeat(32) }),
  ).toString("base64url");
  await run("ui.render", {
    component: "AbovePrompt",
    props: { isWorking: options.activeAtStart === true },
  });
  if (options.connect !== false) {
    const connected = await run("command.run", { command: "agentkib-connect", args: ticket });
    expect(connected.text).toContain("connected");
  }
  const events = () =>
    calls.filter((call) => call.url.endsWith("/events")).flatMap((call) => call.body.events);
  const snapshots = () =>
    events()
      .filter((entry) => entry.event.type === "snapshot")
      .map((entry) => entry.event.snapshot);
  const results = () =>
    calls.filter((call) => call.url.endsWith("/results")).map((call) => call.body);
  return {
    run,
    api,
    calls,
    stored,
    connection,
    nativeId,
    events,
    snapshots,
    results,
    ticket,
    nativeStarts,
    get dispatches() {
      return dispatches;
    },
    get stops() {
      return stops;
    },
    setSubmit(value: typeof submit) {
      submit = value;
    },
    setIdentity(value: { cwd?: string; version?: string }) {
      cwd = value.cwd ?? cwd;
      version = value.version ?? version;
    },
    setMessages(value: Value[]) {
      messages = value;
    },
    setHttpInterceptor(value: typeof interceptHttp) {
      interceptHttp = value;
    },
    setReachable(value: boolean) {
      reachable = value;
    },
    pings,
    nextHttpResponse(suffix: string, response: Value) {
      nextResponses.set(`http://localhost${suffix}`, response);
    },
    async tick() {
      for (const callback of timers) await callback();
    },
    async flush() {
      await timers[0]();
    },
    stream(turnId: string, chunks: Value[], result: unknown = {}, extra: Value = {}) {
      return run("turn.step", { turnId, ...extra }, async function* () {
        yield* chunks;
        return result;
      });
    },
    async deliver(value: Value) {
      command = value;
      await timers[1]();
    },
  };
}

it("advertises workspace attachment links only to Runtimes that name the feature", async () => {
  const older = await fixture();
  await older.flush();
  expect(older.snapshots().at(-1)?.capabilities).not.toHaveProperty("attachments");

  const enabled = await fixture({ features: ["terminal-attachments"] });
  await enabled.flush();
  expect(enabled.snapshots().at(-1)?.capabilities).toMatchObject({ attachments: true });
});

describe("Claude Code terminal subagents", () => {
  async function observed(f: Awaited<ReturnType<typeof fixture>>) {
    await f.tick();
    await f.flush();
    return f.snapshots().at(-1)?.terminalSubagents;
  }

  it("does not ask the host for subagents when the Runtime does not opt in", async () => {
    const list = vi.fn(async () => []);
    const f = await fixture({ configure: (api) => (api.agent = { list }) });
    expect(await observed(f)).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
  });

  it("reports native descriptions and scoped IDs without copying native task data", async () => {
    const nativeIds = Array.from({ length: 8 }, () => randomUUID());
    const agents = [
      { id: nativeIds[0], description: "检查测试覆盖", status: "pending" },
      { id: nativeIds[1], description: "Review permissions", status: "waiting" },
      { id: nativeIds[2], description: "sleep 30", status: "completed" },
      { id: nativeIds[3], description: "Inspect /some/private/file", status: "failed" },
      { id: nativeIds[4], description: `Task ${nativeIds[0]}`, status: "killed" },
      { id: nativeIds[5], description: "Peer work", status: "running", teammateId: "peer-id" },
      { id: nativeIds[6], description: "'git status'", status: "completed" },
      { id: nativeIds[7], description: "Touch record", status: "completed" },
    ].map((agent) => ({ ...agent, toolUseId: "synthetic-native-tool", cwd: "/some/private/root" }));
    const f = await fixture({
      features: ["terminal-subagents"],
      configure: (api) => (api.agent = { list: async () => agents }),
    });
    await expect
      .poll(() => observed(f))
      .toEqual([
        { id: expect.any(String), title: "检查测试覆盖", status: "starting" },
        { id: expect.any(String), title: "Review permissions", status: "unknown" },
        { id: expect.any(String), title: "", status: "completed" },
        { id: expect.any(String), title: "", status: "failed" },
        { id: expect.any(String), title: "", status: "stopped" },
        { id: expect.any(String), title: "", status: "completed" },
        { id: expect.any(String), title: "", status: "completed" },
      ]);
    const initial = f.snapshots().at(-1).terminalSubagents;
    const serialized = JSON.stringify(initial);
    for (const nativeValue of [
      ...nativeIds,
      "synthetic-native-tool",
      "/some/private",
      "sleep 30",
      "peer-id",
    ])
      expect(serialized).not.toContain(nativeValue);
    const firstId = initial[0].id;
    agents[0].status = "running";
    await expect
      .poll(async () => (await observed(f))?.[0])
      .toEqual({
        id: firstId,
        title: "检查测试覆盖",
        status: "running",
      });
    agents.splice(0);
    await expect.poll(() => observed(f)).toEqual([]);
    expect(f.dispatches).toBe(0);
    expect(f.stops).toBe(0);
  });

  it("clears unsupported observations without disabling the bridge", async () => {
    let rows: unknown = [{ id: randomUUID(), description: "Review changes", status: "idle" }];
    const f = await fixture({
      features: ["terminal-subagents"],
      configure: (api) => (api.agent = { list: async () => rows }),
    });
    await expect.poll(async () => (await observed(f))?.[0]?.status).toBe("unknown");
    rows = { invalid: "native shape changed" };
    await expect.poll(() => observed(f)).toBeUndefined();
    expect((await f.run("command.run", { command: "agentkib-status" })).text).toContain(
      "connected",
    );
  });

  it("clears a stuck native read and discards its late result after session.end", async () => {
    const late = deferred<Value[]>();
    const list = vi
      .fn()
      .mockResolvedValueOnce([
        { id: randomUUID(), description: "Review changes", status: "running" },
      ])
      .mockImplementation(() => late.promise);
    const f = await fixture({
      features: ["terminal-subagents"],
      configure: (api) => (api.agent = { list }),
    });
    await expect.poll(async () => (await observed(f))?.length).toBe(1);
    await expect.poll(() => observed(f)).toBeUndefined();
    expect(list).toHaveBeenCalledTimes(2);
    await f.run("session.end", { reason: "exit" });
    late.resolve([{ id: randomUUID(), description: "Late child", status: "running" }]);
    await f.tick();
    expect(f.snapshots().at(-1)?.status).toBe("disconnected");
    expect(JSON.stringify(f.snapshots())).not.toContain("Late child");
  });
});

describe("Claude Code terminal Worker activity", () => {
  it("tracks foreground tool starts and failures, and records thinking without its content", async () => {
    const f = await fixture({ features: ["terminal-worker-activity"] });
    const activity = async () => {
      await f.flush();
      return f.snapshots().at(-1)?.terminalWorkerActivity;
    };
    const turnId = randomUUID();
    await f.run("turn.start", { turnId });
    expect(await activity()).toEqual({ commands: [], revision: 0 });

    const stream = f.stream(turnId, [{ kind: "thinking", text: "private reasoning" }]);
    expect((await stream.next()).done).toBe(false);
    expect((await stream.next()).done).toBe(true);
    expect(await activity()).toEqual({ commands: [], revision: 0 });
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 15_000);
    try {
      expect(await activity()).toEqual({ commands: [], revision: 1 });
    } finally {
      now.mockRestore();
    }
    expect(JSON.stringify(f.calls)).not.toContain("private reasoning");

    const nativeId = "native-tool-id";
    const entered = deferred<void>();
    const finish = deferred<void>();
    const running = f.run("tool.call", { tool: "Bash", tool_use_id: nativeId }, async () => {
      entered.resolve();
      await finish.promise;
      throw new Error("tool failed");
    });
    await entered.promise;
    const inFlight = await activity();
    expect(inFlight).toEqual({
      commands: [{ id: expect.any(String), startedAt: expect.any(Number) }],
      revision: 2,
    });
    expect(inFlight.commands[0].id).not.toBe(nativeId);
    await f.flush();
    expect(await activity()).toEqual(inFlight);
    const rejected = expect(running).rejects.toThrow("tool failed");
    finish.resolve();
    await rejected;
    expect(await activity()).toEqual({ commands: [], revision: 3 });
    await f.run("turn.complete", { turnId, answer: "done" });
    expect(await activity()).toBeUndefined();
  });

  it("omits claims about a turn that began before the plugin observed it or an older Runtime", async () => {
    const feature = await fixture({ features: ["terminal-worker-activity"] });
    const resumed = feature.stream(randomUUID(), [{ kind: "text", text: "resuming" }]);
    expect((await resumed.next()).done).toBe(false);
    expect((await resumed.next()).done).toBe(true);
    await feature.flush();
    expect(feature.snapshots().at(-1).status).toBe("running");
    expect(feature.snapshots().at(-1)).not.toHaveProperty("terminalWorkerActivity");

    const legacy = await fixture();
    await legacy.run("turn.start", { turnId: randomUUID() });
    await legacy.flush();
    expect(legacy.snapshots().at(-1).status).toBe("running");
    expect(legacy.snapshots().at(-1)).not.toHaveProperty("terminalWorkerActivity");
  });
});

describe("Claude Code native session plugin as a Project Agent", () => {
  /** A Runtime that names `lead-tools`, with this lead info in its command replies. */
  async function leading(
    options: { feature?: boolean; register?: boolean; rateLimitFeature?: boolean } = {},
  ) {
    const registered: Value[] = [];
    const logs: string[] = [];
    let lead: Value | null = null;
    let ignoreTakenReports = false;
    let answer: Value = { text: '{"workers":[]}', isError: false };
    const f = await fixture({
      configure(api) {
        api.ui = { ...api.ui, log: (text: string) => void logs.push(text) };
        if (options.register !== false)
          api.tool = {
            register: async (spec: Value) => {
              registered.push(spec);
              return { tool: `mcp__agentkib-bridge__${spec.name}` };
            },
          };
        const fetch = api.http.fetch;
        api.http.fetch = async (url: string, init: Value) => {
          const response = await fetch(url, init);
          if (init.method === "GET" || !response.ok) return response;
          const value = JSON.parse(response.text);
          if ((url.endsWith("/pair") || url.endsWith("/reconnect")) && options.feature !== false) {
            const features = ["lead-tools"];
            if (options.rateLimitFeature) features.push("lead-rate-limit-pause");
            return { ...response, text: JSON.stringify({ ...value, features }) };
          }
          if (url.endsWith("/commands") && lead) {
            const taken: string[] = JSON.parse(init.body).takenReports ?? [];
            if (taken.length && !ignoreTakenReports)
              lead = {
                ...lead,
                reports: lead.reports.filter(({ id }: Value) => !taken.includes(id)),
              };
            return { ...response, text: JSON.stringify({ ...value, lead }) };
          }
          if (url.endsWith("/lead-call")) return { ...response, text: JSON.stringify(answer) };
          return response;
        };
      },
    });
    const polls = () =>
      f.calls.filter((call) => call.url.endsWith("/commands")).map((call) => call.body);
    return {
      f,
      registered,
      logs,
      polls,
      setLead(value: Value | null) {
        lead = value;
      },
      repeatOffers(value: boolean) {
        ignoreTakenReports = value;
      },
      setAnswer(value: Value) {
        answer = value;
      },
      call(input: Value = {}) {
        return f.run("tool.call", {
          tool: "mcp__agentkib-bridge__worker_list",
          tool_use_id: "toolu_lead",
          ...input,
        });
      },
    };
  }
  const tool = {
    name: "worker_list",
    description: "List your workers.",
    inputSchema: { type: "object", properties: {} },
  };

  async function appendNativeReport(f: Awaited<ReturnType<typeof fixture>>, text: string) {
    // Native re-entry skips this Mod's prompt.submit hook, but still exposes the entry
    // in the session and the main turn that processed it.
    await f.run("session.append", {
      door: "prompt",
      origin: { kind: "plugin", name: "agentkib-bridge", asUser: true },
      uuid: randomUUID(),
      message: { type: "user", content: [{ type: "text", text }] },
    });
  }

  async function nativeReportTurn(
    f: Awaited<ReturnType<typeof fixture>>,
    text: string,
    turnId: string,
  ) {
    await appendNativeReport(f, text);
    await f.run("turn.start", { text, turnId });
    await f.run("turn.complete", {
      answer: "Observed the report.",
      isAborted: false,
      reason: "answer",
      turnId,
    });
  }

  function watchReportSubmissions(f: Awaited<ReturnType<typeof fixture>>) {
    const submitted: string[] = [];
    f.setSubmit(async ({ text }) => {
      submitted.push(text);
      await nativeReportTurn(f, text, randomUUID());
      return { text };
    });
    return submitted;
  }

  async function limitTurn(f: Awaited<ReturnType<typeof fixture>>, extra: Value = {}) {
    const turnId = randomUUID();
    await f.run("turn.start", { turnId, ...extra });
    await f.run("classic.StopFailure", {
      session_id: f.nativeId,
      error: "rate_limit",
      ...(extra.agentId ? { agent_id: extra.agentId } : {}),
    });
    await f.run("turn.complete", {
      turnId,
      answer: "",
      reason: "error",
      isAborted: false,
      ...extra,
    });
  }

  it("registers the worker tools AgentKib gives it and runs their calls through AgentKib", async () => {
    const l = await leading();
    await l.f.tick();
    expect(l.polls().at(-1)).toMatchObject({ leadTools: true });
    l.setLead({ tools: [tool], reports: [] });
    await l.f.tick();
    expect(l.registered).toEqual([{ ...tool, isDeferred: false }]);
    // The same tools are not registered again.
    await l.f.tick();
    expect(l.registered).toHaveLength(1);
    expect(await l.call({ limit: 2 })).toEqual({ result: '{"workers":[]}' });
    const call = l.f.calls.find((entry) => entry.url.endsWith("/lead-call"))!;
    expect(call.body).toMatchObject({ name: "worker_list", input: { limit: 2 } });
    expect(call.body.input).not.toHaveProperty("tool");
    expect(call.init.headers.Authorization).toBe(`Bearer ${l.f.connection.token}`);
    l.setAnswer({ text: '{"accepted":false,"reason":"delegation-paused"}', isError: true });
    expect(await l.call()).toEqual({ deny: '{"accepted":false,"reason":"delegation-paused"}' });
  });

  it("registers and runs worker_restart only when AgentKib offers it", async () => {
    const l = await leading();
    await l.f.tick();
    const names = [
      "worker_list",
      "worker_open",
      "worker_send",
      "worker_read",
      "worker_stop",
      "worker_approve",
      "worker_answer",
      "worker_close",
    ];
    l.setLead({ tools: names.map((name) => ({ ...tool, name })), reports: [] });
    await l.f.tick();
    expect(l.registered.map((spec) => spec.name)).toEqual(names);
    expect(await l.call({ tool: "mcp__agentkib-bridge__worker_close", worker: "api" })).toEqual({
      result: '{"workers":[]}',
    });
    expect(
      l.f.calls.filter((entry) => entry.url.endsWith("/lead-call")).at(-1)!.body,
    ).toMatchObject({ name: "worker_close", input: { worker: "api" } });

    l.setLead({
      tools: [...names, "worker_restart"].map((name) => ({ ...tool, name })),
      reports: [],
    });
    await l.f.tick();
    expect(l.registered.slice(-9).map((spec) => spec.name)).toEqual([...names, "worker_restart"]);
    expect(await l.call({ tool: "mcp__agentkib-bridge__worker_restart", worker: "api" })).toEqual({
      result: '{"workers":[]}',
    });
    expect(
      l.f.calls.filter((entry) => entry.url.endsWith("/lead-call")).at(-1)!.body,
    ).toMatchObject({ name: "worker_restart", input: { worker: "api" } });
  });

  it("submits a queued report only after the Runtime accepts its acknowledgment", async () => {
    const l = await leading();
    const report = {
      id: randomUUID(),
      text: '[AgentKib report] Worker "api" (Codex) · turn ended: completed',
    };
    const before = l.f.dispatches;
    l.setLead({ tools: [tool], reports: [report] });
    await l.f.tick();
    expect(l.f.dispatches).toBe(before);
    await l.f.tick();
    expect(l.polls().at(-1)).toMatchObject({ takenReports: [report.id] });
    expect(l.f.dispatches).toBe(before + 1);
    await l.f.flush();
    expect(
      l.f
        .events()
        .filter((entry) => entry.event.type === "turn-start")
        .map((entry) => entry.event.origin),
    ).toContain("agentkib");
    // Once the Runtime has dropped it, the acknowledgment no longer repeats.
    await l.f.tick();
    expect(l.polls().at(-1)).not.toHaveProperty("takenReports");
  });

  it("sends a report once after a lost acknowledgment and repeated offer", async () => {
    const l = await leading();
    const report = { id: randomUUID(), text: "[AgentKib report] Worker finished" };
    const submitted: string[] = [];
    l.f.setSubmit(async ({ text }) => {
      submitted.push(text);
      await nativeReportTurn(l.f, text, randomUUID());
      return { text };
    });
    l.setLead({ tools: [tool], reports: [report] });
    await l.f.tick();
    expect(submitted).toEqual([]);

    let lost = false;
    l.f.setHttpInterceptor(async (url) => {
      if (url.endsWith("/commands") && l.polls().at(-1)?.takenReports && !lost) {
        lost = true;
        throw new Error("synthetic acknowledgment was lost before reaching the Runtime");
      }
    });
    await l.f.tick();
    expect(lost).toBe(true);
    expect(l.polls().at(-1)).toMatchObject({ takenReports: [report.id] });
    expect(submitted).toEqual([]);

    l.repeatOffers(true);
    await l.f.tick();
    expect(l.f.calls.some(({ url }) => url.endsWith("/v1/reconnect"))).toBe(true);
    expect(l.polls().at(-1)).toMatchObject({ takenReports: [report.id] });
    expect(submitted).toEqual([]);

    l.repeatOffers(false);
    await l.f.tick();
    await l.f.tick();
    await l.f.flush();
    expect(submitted).toEqual([report.text]);
    expect(l.f.snapshots().at(-1).outbox).toEqual([]);
  });

  it("delivers the next report after the terminal completed a Worker cancellation report", async () => {
    const l = await leading();
    const cancellation = {
      id: randomUUID(),
      text: '[AgentKib report] Worker "api" (Codex) · turn ended: cancelled',
    };
    const followUp = {
      id: randomUUID(),
      text: '[AgentKib report] Worker "api" (Codex) · waiting for approval',
    };
    const submitted: string[] = [];
    const cancellationTurn = randomUUID();
    l.f.setSubmit(async ({ text }) => {
      submitted.push(text);
      const turnId = text === cancellation.text ? cancellationTurn : randomUUID();
      await nativeReportTurn(l.f, text, turnId);
      // Losing the submit echo must not erase a turn that the native hooks confirmed.
      return text === cancellation.text ? {} : { text };
    });

    l.setLead({ tools: [tool], reports: [cancellation] });
    await l.f.tick();
    await l.f.tick();
    expect(l.f.events().map(({ event }) => event)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "turn-start",
          turnId: cancellationTurn,
          origin: "agentkib",
        }),
        expect.objectContaining({
          type: "turn-complete",
          turnId: cancellationTurn,
          aborted: false,
        }),
      ]),
    );

    l.setLead({ tools: [tool], reports: [followUp] });
    await l.f.tick();
    await l.f.tick();
    await l.f.flush();

    expect(submitted).toEqual([cancellation.text, followUp.text]);
    expect(l.f.snapshots().at(-1).outbox).toEqual([]);
  });

  it("keeps a report ahead of later queued messages while acknowledging it", async () => {
    const l = await leading();
    const report = { id: randomUUID(), text: "[AgentKib report] Worker finished" };
    const queuedText = "Please verify the changes.";
    const submitted: string[] = [];
    l.f.setSubmit(async ({ text }) => {
      submitted.push(text);
      await nativeReportTurn(l.f, text, randomUUID());
      return { text };
    });
    l.repeatOffers(true);
    l.setLead({ tools: [tool], reports: [report] });
    await l.f.tick();
    await l.f.deliver({
      kind: "queue",
      commandId: randomUUID(),
      requestId: randomUUID(),
      text: queuedText,
    });
    await l.f.tick();
    expect(submitted).toEqual([]);

    l.repeatOffers(false);
    await l.f.tick();
    await l.f.tick();
    expect(submitted).toEqual([report.text, queuedText]);
  });

  it.each([false, true])(
    "holds both unacknowledged and newly offered reports at the rate limit (negotiated: %s)",
    async (rateLimitFeature) => {
      const l = await leading({ rateLimitFeature });
      const queued = { id: randomUUID(), text: "[AgentKib report] Already in the outbox" };
      const later = { id: randomUUID(), text: "[AgentKib report] Arrived during the limit" };
      const submitted = watchReportSubmissions(l.f);
      l.setLead({ tools: [tool], reports: [queued] });
      await l.f.tick();
      await limitTurn(l.f);

      l.setLead({ tools: [tool], reports: [queued, later] });
      await l.f.tick();
      await l.f.tick();
      await l.f.flush();
      const held = l.polls().at(-1);
      if (rateLimitFeature) expect(held).toMatchObject({ leadReportsPaused: true });
      else expect(held).not.toHaveProperty("leadReportsPaused");
      expect(held).not.toHaveProperty("takenReports");
      expect(
        l.f
          .snapshots()
          .at(-1)
          .outbox.map(({ id }: Value) => id),
      ).toEqual([queued.id]);
      expect(submitted).toEqual([]);

      // Neither a background notification nor a prompt from this plugin is terminal input.
      for (const origin of [
        { kind: "task-notification" },
        { kind: "plugin", name: "agentkib-bridge", asUser: true },
      ])
        await l.f.run("prompt.submit", { text: queued.text, origin });
      await l.f.tick();
      expect(submitted).toEqual([]);

      await l.f.run("prompt.submit", { text: "Try again", origin: { kind: "composer" } });
      await l.f.tick();
      await l.f.tick();
      await l.f.tick();
      if (rateLimitFeature) expect(l.polls().at(-1)).toMatchObject({ leadReportsPaused: false });
      else expect(l.polls().every((poll) => !("leadReportsPaused" in poll))).toBe(true);
      expect(submitted).toEqual([queued.text, later.text]);
    },
  );

  it("holds an acknowledged report when a limit lands during its poll", async () => {
    const l = await leading({ rateLimitFeature: true });
    const report = { id: randomUUID(), text: "[AgentKib report] Worker finished" };
    const submitted = watchReportSubmissions(l.f);
    l.setLead({ tools: [tool], reports: [report] });
    await l.f.tick();
    const ackStarted = deferred<void>();
    const releaseAck = deferred<void>();
    l.f.setHttpInterceptor(async (url) => {
      if (url.endsWith("/commands") && l.polls().at(-1)?.takenReports?.includes(report.id)) {
        ackStarted.resolve();
        await releaseAck.promise;
      }
    });
    const poll = l.f.tick();
    await ackStarted.promise;
    try {
      await limitTurn(l.f);
    } finally {
      releaseAck.resolve();
      await poll;
      l.f.setHttpInterceptor(undefined);
    }
    await l.f.tick();
    expect(l.polls().at(-1)).toMatchObject({ leadReportsPaused: true });
    expect(submitted).toEqual([]);

    await l.f.run("prompt.submit", { text: "Continue", origin: { kind: "composer" } });
    await l.f.tick();
    await l.f.tick();
    expect(submitted).toEqual([report.text]);
  });

  it("uses a later successful main turn to resume reports", async () => {
    const l = await leading({ rateLimitFeature: true });
    const report = { id: randomUUID(), text: "[AgentKib report] Worker finished" };
    const submitted = watchReportSubmissions(l.f);
    l.setLead({ tools: [tool], reports: [] });
    await l.f.tick();
    const ordinaryFailure = randomUUID();
    await l.f.run("turn.start", { turnId: ordinaryFailure });
    await limitTurn(l.f, { agentId: "child-agent" });
    await l.f.tick();
    expect(l.polls().at(-1)).toMatchObject({ leadReportsPaused: false });
    await l.f.run("classic.StopFailure", { session_id: l.f.nativeId, error: "server_error" });
    await l.f.run("turn.complete", {
      turnId: ordinaryFailure,
      answer: "Request failed",
      reason: "error",
    });
    await l.f.tick();
    expect(l.polls().at(-1)).toMatchObject({ leadReportsPaused: false });

    await limitTurn(l.f);
    l.setLead({ tools: [tool], reports: [report] });
    const childTurn = randomUUID();
    await l.f.run("turn.start", { turnId: childTurn, agentId: "child-agent" });
    await l.f.run("turn.complete", {
      turnId: childTurn,
      agentId: "child-agent",
      reason: "answer",
      answer: "Child finished",
    });
    const interruptedTurn = randomUUID();
    await l.f.run("turn.start", { turnId: interruptedTurn });
    await l.f.run("turn.complete", {
      turnId: interruptedTurn,
      reason: "interrupted",
      isAborted: true,
      answer: "Partial answer",
    });
    await l.f.tick();
    expect(l.polls().at(-1)).toMatchObject({ leadReportsPaused: true });
    expect(submitted).toEqual([]);

    const completedTurn = randomUUID();
    await l.f.run("turn.start", { turnId: completedTurn });
    await l.f.run("turn.complete", {
      turnId: completedTurn,
      reason: "answer",
      answer: "Main turn finished",
    });
    await l.f.tick();
    await l.f.tick();
    expect(l.polls().at(-1)).toMatchObject({ leadReportsPaused: false });
    expect(submitted).toEqual([report.text]);
  });

  it.each(["quota_auto_resume_fired", "quota_auto_resume_stale", "quota_auto_resume_disabled"])(
    "restores report delivery on the native %s notification",
    async (notification_type) => {
      const l = await leading({ rateLimitFeature: true });
      const report = { id: randomUUID(), text: "[AgentKib report] Worker finished" };
      const submitted = watchReportSubmissions(l.f);
      l.setLead({ tools: [tool], reports: [] });
      await l.f.tick();
      await limitTurn(l.f);
      l.setLead({ tools: [tool], reports: [report] });
      await l.f.run("classic.Notification", {
        session_id: l.f.nativeId,
        notification_type: "permission_prompt",
        message: notification_type,
      });
      await l.f.run("classic.Notification", {
        session_id: l.f.nativeId,
        agent_id: "child-agent",
        notification_type,
        message: "Child notification.",
      });
      await l.f.run("classic.Notification", {
        session_id: randomUUID(),
        notification_type,
        message: "Notification for another terminal.",
      });
      await l.f.tick();
      expect(l.polls().at(-1)).toMatchObject({ leadReportsPaused: true });
      expect(submitted).toEqual([]);

      await l.f.run("classic.Notification", {
        session_id: l.f.nativeId,
        notification_type,
        message: "Terminal notification.",
      });
      await l.f.tick();
      await l.f.tick();
      expect(l.polls().at(-1)).toMatchObject({ leadReportsPaused: false });
      expect(submitted).toEqual([report.text]);
    },
  );

  it("waits past the latest full usage window before taking reports again", async () => {
    let now = Date.parse("2027-01-15T12:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const l = await leading({ rateLimitFeature: true });
      const report = { id: randomUUID(), text: "[AgentKib report] Worker finished" };
      const submitted = watchReportSubmissions(l.f);
      const rateLimits = [
        { kind: "five_hour", percentUsed: 100, resetsAt: "2027-01-15T12:01:00.000Z" },
        { kind: "seven_day", percentUsed: 100, resetsAt: "2027-01-15T12:02:00.000Z" },
        { kind: "seven_day_sonnet", percentUsed: 90, resetsAt: "2027-01-15T12:10:00.000Z" },
      ];
      l.f.api.session.usage = async () => ({ rateLimits });
      l.setLead({ tools: [tool], reports: [] });
      await l.f.tick();
      await limitTurn(l.f);
      l.setLead({ tools: [tool], reports: [report] });

      now += 120_000 + 29_999;
      await l.f.tick();
      expect(l.polls().at(-1)).toMatchObject({ leadReportsPaused: true });
      expect(submitted).toEqual([]);

      now += 60_002;
      await l.f.tick();
      await l.f.tick();
      expect(l.polls().at(-1)).toMatchObject({ leadReportsPaused: false });
      expect(submitted).toEqual([report.text]);
    } finally {
      clock.mockRestore();
    }
  });

  it("probes an unknown reset after five minutes only once until a native recovery", async () => {
    let now = Date.parse("2027-01-15T12:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const l = await leading({ rateLimitFeature: true });
      const probe = { id: randomUUID(), text: "[AgentKib report] First Worker finished" };
      const later = { id: randomUUID(), text: "[AgentKib report] Another Worker finished" };
      const submitted: string[] = [];
      l.f.setSubmit(async ({ text }) => {
        submitted.push(text);
        if (text === probe.text) {
          await appendNativeReport(l.f, text);
          await limitTurn(l.f, { text });
        } else await nativeReportTurn(l.f, text, randomUUID());
        return { text };
      });
      l.setLead({ tools: [tool], reports: [] });
      await l.f.tick();
      await limitTurn(l.f);
      l.setLead({ tools: [tool], reports: [probe] });
      now += 299_999;
      await l.f.tick();
      expect(l.polls().at(-1)).toMatchObject({ leadReportsPaused: true });
      expect(submitted).toEqual([]);

      now++;
      await l.f.tick();
      await l.f.tick();
      expect(submitted).toEqual([probe.text]);
      l.setLead({ tools: [tool], reports: [later] });
      now += 600_000;
      await l.f.tick();
      await l.f.tick();
      expect(l.polls().at(-1)).toMatchObject({ leadReportsPaused: true });
      expect(submitted).toEqual([probe.text]);

      await l.f.run("prompt.submit", { text: "Continue", origin: { kind: "composer" } });
      await l.f.tick();
      await l.f.tick();
      expect(submitted).toEqual([probe.text, later.text]);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([false, true])(
    "reconciles a late native turn after submit (reconnect: %s)",
    async (reconnect) => {
      const l = await leading();
      const report = { id: randomUUID(), text: "[AgentKib report] Worker finished" };
      l.f.setSubmit(async ({ text }) => {
        await appendNativeReport(l.f, text);
        return {};
      });
      l.setLead({ tools: [tool], reports: [report] });
      await l.f.tick();
      await l.f.tick();
      await l.f.flush();
      expect(l.f.dispatches).toBe(1);
      expect(l.f.snapshots().at(-1).outbox).toMatchObject([{ id: report.id }]);
      if (reconnect) {
        l.f.nextHttpResponse("/v1/commands", {
          status: 409,
          body: { error: "bridge-lease-expired" },
        });
        await l.f.tick();
        await l.f.tick();
        expect(l.f.calls.some(({ url }) => url.endsWith("/v1/reconnect"))).toBe(true);
      }

      const turnId = randomUUID();
      await l.f.run("turn.start", { text: report.text, turnId });
      await l.f.run("turn.complete", { answer: "Observed the report.", isAborted: false, turnId });
      await l.f.tick();

      expect(l.f.dispatches).toBe(1);
      expect(l.f.snapshots().at(-1).outbox).toEqual([]);
      expect(l.f.events().map(({ event }) => event)).toContainEqual(
        expect.objectContaining({ type: "turn-start", turnId, origin: "agentkib" }),
      );
    },
  );

  it.each(["reconnect", "terminal input"] as const)(
    "delivers later reports without replaying an unconfirmed report after %s",
    async (recovery) => {
      const l = await leading();
      const unconfirmed = { id: randomUUID(), text: "[AgentKib report] First Worker report" };
      const followUp = { id: randomUUID(), text: "[AgentKib report] Later Worker report" };
      const submitted: string[] = [];
      l.f.setSubmit(async ({ text }) => {
        submitted.push(text);
        if (text === followUp.text) await nativeReportTurn(l.f, text, randomUUID());
        return { text };
      });

      l.setLead({ tools: [tool], reports: [unconfirmed] });
      await l.f.tick();
      await l.f.tick();
      await l.f.flush();
      // An echo without native origin and a matching turn is still inconclusive.
      expect(l.f.snapshots().at(-1).outbox).toMatchObject([
        { id: unconfirmed.id, status: "unknown" },
      ]);
      if (recovery === "reconnect") {
        l.f.nextHttpResponse("/v1/commands", {
          status: 409,
          body: { error: "bridge-lease-expired" },
        });
        await l.f.tick();
        await l.f.tick();
        expect(l.f.calls.some(({ url }) => url.endsWith("/v1/reconnect"))).toBe(true);
      } else {
        // Even identical wording typed by the person is a distinct native turn.
        const turnId = randomUUID();
        await l.f.run("prompt.submit", { text: unconfirmed.text, origin: { kind: "composer" } });
        await l.f.run("turn.start", { text: unconfirmed.text, turnId });
        await l.f.run("turn.complete", { answer: "User turn.", isAborted: false, turnId });
        expect(l.f.events().map(({ event }) => event)).toContainEqual(
          expect.objectContaining({ type: "turn-start", turnId, origin: "terminal" }),
        );
      }

      // A duplicate offer may not turn a local unknown result into another submission.
      l.setLead({ tools: [tool], reports: [unconfirmed, followUp] });
      await l.f.tick();
      await l.f.tick();

      expect(submitted).toEqual([unconfirmed.text, followUp.text]);
    },
  );

  it("tells the terminal when delegation pauses and resumes, once a change", async () => {
    const l = await leading();
    l.setLead({ tools: [tool], reports: [], paused: null });
    await l.f.tick();
    await l.f.tick();
    expect(l.logs).toEqual([]);
    l.setLead({ tools: [tool], reports: [], paused: "auto-turn-limit" });
    await l.f.tick();
    await l.f.tick();
    expect(l.logs).toEqual([
      "AgentKib paused this Project Agent's delegation: its automatic turns reached the limit. Type a message here to continue.",
    ]);
    l.setLead({ tools: [tool], reports: [], paused: null });
    await l.f.tick();
    expect(l.logs.at(-1)).toBe("AgentKib resumed this Project Agent's delegation.");
    expect(l.logs).toHaveLength(2);
  });

  it("lets its worker tools run without asking while it leads, unless a rule or policy asks", async () => {
    const l = await leading();
    const ask = { decision: "ask", reason: "Needs approval" };
    const check = (verdict: Value, extra: Value = {}) =>
      l.f.run(
        "tool.check",
        { tool: "mcp__agentkib-bridge__worker_list", input: {}, ...extra },
        () => verdict,
      );
    // Not a Project Agent yet: the person decides.
    expect(await check(ask)).toBe(ask);
    l.setLead({ tools: [tool], reports: [] });
    await l.f.tick();
    await l.f.tick();
    expect(await check(ask)).toMatchObject({ decision: "allow" });
    for (const verdict of [
      { ...ask, rule: "mcp__agentkib-bridge__worker_list" },
      { ...ask, hook: "PreToolUse" },
      { ...ask, setting: "permissions.example" },
      { ...ask, plugin: "another-plugin" },
      { decision: "deny", reason: "Denied by a rule" },
    ])
      expect(await check(verdict)).toBe(verdict);
    expect(await check(ask, { ceiling: "ask" })).toBe(ask);
    // Not this plugin's tool.
    expect(await l.f.run("tool.check", { tool: "Bash", input: {} }, () => ask)).toBe(ask);
    // Once it stops leading, the person decides again.
    l.setLead(null);
    await l.f.tick();
    await l.f.tick();
    expect(await check(ask)).toBe(ask);
  });

  it("keeps to the 0.4.0 messages for a Runtime that does not name the feature", async () => {
    const l = await leading({ feature: false });
    l.setLead({ tools: [tool], reports: [] });
    await l.f.tick();
    await l.f.tick();
    expect(
      l
        .polls()
        .every(
          (poll) => !["leadTools", "takenReports", "leadReportsPaused"].some((key) => key in poll),
        ),
    ).toBe(true);
    expect(l.registered).toEqual([]);
    expect(await l.call()).toMatchObject({ deny: expect.stringContaining("not connected") });
    expect(l.f.calls.some((entry) => entry.url.endsWith("/lead-call"))).toBe(false);
  });

  it("tells the Runtime, and the terminal, when its tools cannot be added", async () => {
    const l = await leading({ register: false });
    await l.f.tick();
    expect(l.polls().at(-1)).toMatchObject({ leadTools: true });
    l.setLead({ tools: [tool], reports: [] });
    await l.f.tick();
    await l.f.tick();
    expect(l.polls().at(-1)).toMatchObject({ leadTools: false });
    expect(await l.call()).toMatchObject({ deny: expect.stringContaining("not connected") });
  });

  it("says who started a turn only to a Runtime that takes it", async () => {
    const l = await leading();
    await l.f.run("turn.start", { text: "typed in the terminal", turnId: randomUUID() });
    await l.f.run("turn.start", { text: "", turnId: randomUUID() });
    // Background work's notice starts a turn no one typed; the engine stamps where it came from.
    const notice = "<task-notification>build finished</task-notification>";
    await l.f.run("prompt.submit", {
      text: notice,
      wait: false,
      origin: { kind: "task-notification" },
    });
    await l.f.run("turn.start", { text: notice, turnId: randomUUID() });
    await l.f.run("prompt.submit", {
      text: "typed again",
      wait: false,
      origin: { kind: "composer" },
    });
    await l.f.run("turn.start", { text: "typed again", turnId: randomUUID() });
    const starts = l.f.events().filter((entry) => entry.event.type === "turn-start");
    await l.f.flush();
    const sent = l.f.events().filter((entry) => entry.event.type === "turn-start");
    expect(sent.map((entry) => entry.event.origin)).toEqual([
      "terminal",
      undefined,
      undefined,
      "terminal",
    ]);
    expect(starts.length).toBeLessThanOrEqual(sent.length);
  });
});

describe("Claude Code native session plugin", () => {
  it("reports the native model without making the optional getter a connection requirement", async () => {
    const f = await fixture({
      configure(api) {
        api.session.model = async () => "actual-terminal-model";
      },
    });
    expect(f.snapshots().at(-1)).toMatchObject({
      model: "actual-terminal-model",
      compacting: false,
    });
    f.api.session.model = async () => {
      throw new Error("getter temporarily unavailable");
    };
    await f.run("session.append", {});
    await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({ model: null });
    expect(f.dispatches).toBe(0);
  });

  it("withholds pre-compaction counts and sends while preserving the native compact result", async () => {
    const f = await fixture();
    const bottom = deferred<Value>();
    const result = { native: "compacted" };
    const pending = f.run("session.compact", {}, () => bottom.promise);
    await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({
      compacting: true,
      compactStartedAt: expect.any(Number),
      usage: null,
      capabilities: { send: false, steer: false, queue: false },
    });
    const compactStartedAt = f.snapshots().at(-1)?.compactStartedAt;
    bottom.resolve(result);
    await expect(pending).resolves.toBe(result);
    await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({
      compacting: false,
      compactStartedAt,
      usage: { tokens: 32 },
    });
    const error = new Error("native compaction failed");
    await expect(
      f.run("session.compact", {}, () => {
        throw error;
      }),
    ).rejects.toBe(error);
    await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({ compacting: false });
    expect(f.dispatches).toBe(0);
  });

  // 2.1.301 applies a changed hooks module as a turn ends; what the old module did not send is
  // lost with it, and AgentKib could not confirm the message that started the turn.
  it("sends a turn's end before its hook returns, after a send already under way", async () => {
    let release: (() => void) | undefined;
    let hold = false;
    const f = await fixture({
      httpInterceptor: async (url) => {
        if (url.endsWith("/events") && hold) {
          hold = false;
          await new Promise<void>((resolve) => (release = resolve));
        }
      },
      // AgentKib answers late but within the bound.
      sleep: () => new Promise<void>(() => {}),
    });
    const turnId = randomUUID();
    await f.run("turn.start", { text: "terminal", turnId });
    hold = true;
    const ticking = f.flush();
    await expect.poll(() => release).toBeDefined();
    let ended = false;
    const ending = Promise.resolve(f.run("turn.complete", { turnId, answer: "done" })).then(() => {
      ended = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(ended).toBe(false);
    release!();
    await ticking;
    await ending;
    expect(
      f
        .events()
        .filter((entry) => entry.event.type === "turn-complete" && entry.event.turnId === turnId),
    ).toHaveLength(1);
  });

  it("explains an expired connection code and the next step in the terminal", async () => {
    const f = await fixture({ connect: false });
    f.nextHttpResponse("/v1/pair", { status: 409, body: { error: "expired-bridge-challenge" } });
    const result = await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
    expect(result.text).toBe(connectionFailureText("expired-bridge-challenge"));
    expect(result.text).toContain("connection code has expired");
    expect(result.text).toContain("Generate a new connection code");
  });
  it("reports local version failures to the broker without binding the terminal", async () => {
    const f = await fixture({ connect: false });
    f.setIdentity({ version: "2.1.300" });
    const result = await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
    expect(result.text).toContain("requires Claude Code 2.1.301 or later");
    expect(f.calls.find((call) => call.url.endsWith("/pair"))?.body).toMatchObject({
      connectionError: "bridge-cli-too-old",
      cliVersion: "2.1.300",
    });
    expect((await f.run("command.run", { command: "agentkib-status" })).text).toContain(
      "not connected",
    );
  });
  it.each(["2.1.301", "2.1.307", "2.2.0"])(
    "reports the actual compatible CLI version %s and takes messages only once idle is verified",
    async (version) => {
      const f = await fixture({ version });
      expect(f.calls.find((call) => call.url.endsWith("/pair"))?.body).toMatchObject({
        cliVersion: version,
        pluginVersion: CLAUDE_BRIDGE_PLUGIN_VERSION,
        nativeCapabilities: {
          version: 1,
          available: [
            "session-identity",
            "session-messages",
            "session-usage",
            "credential-store",
            "credential-read",
          ],
        },
      });
      expect(f.snapshots().at(-1)).toMatchObject({
        cliVersion: version,
        outbox: [],
        capabilities: { read: true, send: true, steer: false, queue: true },
      });
      expect(f.dispatches).toBe(0);
    },
  );
  it.each([
    [
      "session-identity",
      (api: Value) => {
        delete api.session.id;
      },
    ],
    [
      "session-identity",
      (api: Value) => {
        api.session.cwd = async () => {
          throw new Error("private error");
        };
      },
    ],
    [
      "session-messages",
      (api: Value) => {
        delete api.session.messages;
      },
    ],
    [
      "session-messages",
      (api: Value) => {
        api.session.messages = async () => ({ rows: [] });
      },
    ],
    [
      "session-messages",
      (api: Value) => {
        api.session.messages = async () => [{ role: "user", content: [] }];
      },
    ],
    [
      "session-usage",
      (api: Value) => {
        api.session.usage = async () => {
          throw new Error("private error");
        };
      },
    ],
    [
      "session-usage",
      (api: Value) => {
        api.session.usage = async () => ({ context: { tokens: "not numeric" } });
      },
    ],
    [
      "credential-store",
      (api: Value) => {
        api.store.get = async () => undefined;
      },
    ],
    [
      "credential-read",
      (api: Value) => {
        delete api.fs.read;
      },
    ],
    [
      "credential-read",
      (api: Value) => {
        api.fs.read = async () => undefined;
      },
    ],
  ] as const)(
    "rejects missing or invalid capability %s before binding",
    async (capability, breakApi) => {
      const f = await fixture({ connect: false, version: "2.1.307" });
      breakApi(f.api);
      const result = await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
      expect(result.text).toContain("Claude Code 2.1.307");
      expect(result.text).not.toContain("private error");
      const pair = f.calls.filter((call) => call.url.endsWith("/pair"));
      expect(pair).toHaveLength(1);
      expect(pair[0].body).toMatchObject({
        connectionError: "bridge-capabilities-missing",
        cliVersion: "2.1.307",
        missingCapabilities: [capability],
      });
      expect(pair[0].body).not.toHaveProperty("nativeId");
      expect(f.snapshots()).toHaveLength(0);
      expect((await f.run("command.run", { command: "agentkib-status" })).text).toContain(
        "not connected",
      );
    },
  );
  it("rechecks capabilities before automatic reconnect instead of trusting saved version metadata", async () => {
    const f = await fixture({
      connect: false,
      storedCredential: true,
      version: "2.1.307",
      credentialVersion: "2.1.301",
    });
    await expect.poll(() => f.calls.some((call) => call.url.endsWith("/reconnect"))).toBe(true);
    const reconnects = f.calls.filter((call) => call.url.endsWith("/reconnect"));
    expect(reconnects.length).toBeGreaterThan(0);
    expect(reconnects.at(-1)?.body).toMatchObject({ cliVersion: "2.1.307" });
    f.api.session.messages = async () => {
      throw new Error("missing native history");
    };
    f.nextHttpResponse("/v1/commands", { status: 409, body: { error: "bridge-lease-expired" } });
    await f.tick();
    const before = f.calls.filter((call) => call.url.endsWith("/reconnect")).length;
    await f.tick();
    const reports = f.calls.filter((call) => call.url.endsWith("/reconnect")).slice(before);
    expect(reports).toHaveLength(1);
    expect(reports[0].body).toMatchObject({
      connectionError: "bridge-capabilities-missing",
      cliVersion: "2.1.307",
      missingCapabilities: ["session-messages"],
    });
    expect(f.dispatches).toBe(0);
  });
  it("reuses the saved root binding when Claude reloads inside a workspace subdirectory", async () => {
    const workspace = "/isolated/workspace";
    const f = await fixture({
      connect: false,
      storedCredential: true,
      configure(api) {
        api.session.root = async () => workspace;
        api.session.cwd = async () => `${workspace}/.agents/tasks`;
        api.fs.stat = async () => ({ kind: "dir", isLink: false });
      },
    });
    const handshakes = () => f.calls.filter((call) => call.url.endsWith("/reconnect"));
    await expect.poll(() => handshakes().length).toBe(1);
    expect(handshakes()[0].body).toMatchObject({
      cwd: workspace,
      bindingId: f.connection.bindingId,
      nativeId: f.nativeId,
    });
    f.nextHttpResponse("/v1/commands", { status: 409, body: { error: "bridge-lease-expired" } });
    await f.tick();
    await f.tick();
    expect(handshakes().map(({ body }) => body.bindingId)).toEqual([
      f.connection.bindingId,
      f.connection.bindingId,
    ]);
    expect(f.calls.some(({ url }) => url.endsWith("/pair"))).toBe(false);
    expect(f.dispatches).toBe(0);
  });
  it.each(["sibling directory", "symbolic link", "different checkout"])(
    "preserves the original binding when the terminal tries to reconnect from a %s",
    async (location) => {
      const workspace = "/isolated/workspace";
      let current = workspace;
      let root = workspace;
      const f = await fixture({
        connect: false,
        storedCredential: true,
        configure(api) {
          if (location === "sibling directory") current = `${workspace}-other`;
          if (location === "symbolic link") current = `${workspace}/link/child`;
          if (location === "different checkout")
            current = root = `${workspace}/.claude/worktrees/new`;
          api.session.root = async () => root;
          api.session.cwd = async () => current;
          api.fs.stat = async (path: string) => ({ kind: "dir", isLink: path.endsWith("/link") });
        },
      });
      await f.tick();
      expect(f.calls.some(({ url }) => url.endsWith("/reconnect") || url.endsWith("/pair"))).toBe(
        false,
      );
      expect(f.stored.get(`credentialPath:${f.nativeId}`)).toBe(f.connection.credentialPath);
      expect(f.dispatches).toBe(0);
    },
  );
  it.each([
    ["bridge-cli-too-old", "2.1.300"],
    ["bridge-cli-unsupported", "2.1.307-preview"],
    ["bridge-capabilities-missing", "2.1.307"],
  ])(
    "reports authenticated startup failure %s and explains it in terminal status",
    async (reason, version) => {
      const f = await fixture({
        connect: false,
        storedCredential: true,
        version,
        credentialVersion: "2.1.301",
        configure(api) {
          if (reason === "bridge-capabilities-missing")
            api.session.messages = async () => {
              throw new Error("private native error");
            };
        },
      });
      await expect
        .poll(() => f.calls.some((call) => call.body.connectionError === reason))
        .toBe(true);
      const report = f.calls.find((call) => call.body.connectionError === reason)!;
      expect(report.url).toBe("http://localhost/v1/reconnect");
      expect(report.init.headers.Authorization).toBe(`Bearer ${f.connection.token}`);
      expect(report.body).toMatchObject({
        protocol: 1,
        bindingId: f.connection.bindingId,
        nativeId: f.nativeId,
        cwd: "/isolated/workspace",
        pluginVersion: CLAUDE_BRIDGE_PLUGIN_VERSION,
      });
      expect(report.body).not.toHaveProperty("nativeCapabilities");
      expect(report.body).not.toHaveProperty("token");
      expect((await f.run("command.run", { command: "agentkib-status" })).text).toBe(
        connectionFailureText(reason, version),
      );
      expect(f.snapshots()).toHaveLength(0);
      expect(f.dispatches).toBe(0);
      expect(f.stops).toBe(0);
    },
  );
  it.each([
    "no-binding",
    "wrong-native-id",
    "wrong-cwd",
    "unsafe-socket",
    "invalid-token",
    "unreadable-identity",
  ])(
    "does not publish a reconnect diagnostic without verified credentials: %s",
    async (invalid) => {
      const f = await fixture({
        connect: false,
        storedCredential: invalid !== "no-binding",
        version: "2.1.300",
        credentialVersion: "2.1.301",
        configure(api) {
          if (invalid === "unreadable-identity")
            api.session.id = async () => {
              throw new Error("private identity failure");
            };
          const read = api.fs.read;
          api.fs.read = async (path: string) => {
            const value = JSON.parse(await read(path));
            if (invalid === "wrong-native-id") value.nativeId = randomUUID();
            if (invalid === "wrong-cwd") value.cwd = "/another/workspace";
            if (invalid === "unsafe-socket") value.socketPath = "/tmp/../bridge.sock";
            if (invalid === "invalid-token") value.token = "";
            return JSON.stringify(value);
          };
        },
      });
      await expect
        .poll(async () => (await f.run("command.run", { command: "agentkib-status" })).text)
        .toBe(connectionFailureText("bridge-cli-too-old", "2.1.300"));
      await f.tick();
      expect(f.calls).toHaveLength(0);
    },
  );
  it("does not publish delayed failure feedback after a new explicit pair succeeds", async () => {
    const reading = deferred<void>();
    const release = deferred<void>();
    const f = await fixture({
      connect: false,
      storedCredential: true,
      version: "2.1.300",
      credentialVersion: "2.1.301",
      configure(api) {
        const read = api.fs.read;
        api.fs.read = async (path: string) => {
          if (path !== "/synthetic/plugin/package.json") {
            reading.resolve();
            await release.promise;
          }
          return read(path);
        };
      },
    });
    await reading.promise;
    f.setIdentity({ version: "2.1.307" });
    expect(
      (await f.run("command.run", { command: "agentkib-connect", args: f.ticket })).text,
    ).toContain("connected");
    release.resolve();
    await f.tick();
    expect(f.calls.filter((call) => call.body.connectionError)).toHaveLength(0);
    expect((await f.run("command.run", { command: "agentkib-status" })).text).toContain(
      "is connected",
    );
    expect(f.dispatches).toBe(0);
  });
  it("does not run a superseded startup reconnect probe during explicit pairing", async () => {
    const credentialRead = deferred<void>();
    const credentialContinue = deferred<void>();
    const f = await fixture({
      connect: false,
      storedCredential: true,
      storeGetInterceptor: async (key) => {
        if (key.startsWith("credentialPath:")) {
          credentialRead.resolve();
          await credentialContinue.promise;
        }
      },
    });
    await credentialRead.promise;
    const pairProbeRead = deferred<void>();
    const pairProbeContinue = deferred<void>();
    let reads = 0;
    f.api.session.messages = async () => {
      reads++;
      if (reads === 1) {
        pairProbeRead.resolve();
        await pairProbeContinue.promise;
      }
      return [];
    };
    const pairing = f.run("command.run", { command: "agentkib-connect", args: f.ticket });
    await pairProbeRead.promise;
    credentialContinue.resolve();
    pairProbeContinue.resolve();
    expect((await pairing).text).toContain("connected");
    await f.tick();
    expect(reads).toBe(2); // The explicit pair probe and its first snapshot only.
    const hello = f.calls.find((call) => call.url.endsWith("/pair"))!.body;
    expect(f.snapshots().at(-1).nativeCapabilities).toEqual(hello.nativeCapabilities);
    expect(f.snapshots().at(-1).nativeCapabilities.available).toContain("credential-read");
  });
  it("does not let a delayed reconnect identity invalidate a pair after session.end", async () => {
    const credentialRead = deferred<void>();
    const credentialContinue = deferred<void>();
    const f = await fixture({
      connect: false,
      storedCredential: true,
      storeGetInterceptor: async (key) => {
        if (key.startsWith("credentialPath:")) {
          credentialRead.resolve();
          await credentialContinue.promise;
        }
      },
    });
    await credentialRead.promise;
    const identityRead = deferred<void>();
    const identityContinue = deferred<void>();
    const originalCwd = f.api.session.cwd;
    let reads = 0;
    f.api.session.cwd = async () => {
      const cwd = await originalCwd();
      if (++reads === 1) {
        identityRead.resolve();
        await identityContinue.promise;
      }
      return cwd;
    };
    credentialContinue.resolve();
    await identityRead.promise;
    await f.run("session.end", { reason: "clear" });
    f.setIdentity({ cwd: "/isolated/workspace-after-clear" });
    expect(
      (await f.run("command.run", { command: "agentkib-connect", args: f.ticket })).text,
    ).toContain("connected");
    identityContinue.resolve();
    await f.tick();
    expect((await f.run("command.run", { command: "agentkib-status" })).text).toContain(
      "is connected",
    );
    expect(f.events().filter((entry) => entry.event.reason === "native-identity-changed")).toEqual(
      [],
    );
    expect(f.snapshots().at(-1).cwd).toBe("/isolated/workspace-after-clear");
  });
  it.each(["version", "id", "cwd"])(
    "discards a superseded identity read after session.%s resolves",
    async (method) => {
      const f = await fixture({ connect: false });
      const state: Value = initialState();
      const read = deferred<void>();
      const resume = deferred<void>();
      const original = f.api.session[method];
      f.api.session[method] = async () => {
        const value = await original();
        read.resolve();
        await resume.promise;
        return value;
      };
      const probing = probeCapabilities(f.api, state);
      await read.promise;
      state.generation++;
      const current = { nativeId: randomUUID(), cwd: "/isolated/current-session" };
      state.identity = current;
      resume.resolve();
      await expect(probing).rejects.toThrow("stale-native-identity");
      expect(state.identity).toBe(current);
      expect(state.closed).toBe(false);
      expect(state.generation).toBe(1);
      expect(f.calls).toEqual([]);
    },
  );
  it.each([
    ["tokens", 1.5],
    ["window", 1.5],
    ["tokens", Number.MAX_SAFE_INTEGER + 1],
    ["window", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects a session-usage %s count of %s before pairing", async (key, value) => {
    const f = await fixture({ connect: false, version: "2.1.307" });
    f.api.session.usage = async () => ({ context: { tokens: 1, window: 100, [key]: value } });
    const result = await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
    expect(result.text).toContain("does not currently support");
    expect(f.calls.find((call) => call.url.endsWith("/pair"))?.body).toMatchObject({
      connectionError: "bridge-capabilities-missing",
      missingCapabilities: ["session-usage"],
    });
    expect(f.snapshots()).toEqual([]);
  });
  it.each([
    ["tool", 0],
    ["tool_use_id", 0],
    ["tool", 257],
    ["tool_use_id", 257],
  ])("rejects a projected %s of length %s before pairing", async (key, length) => {
    const f = await fixture({ connect: false, version: "2.1.307" });
    f.setMessages([
      {
        role: "assistant",
        text: "",
        toolUses: [
          { tool_use_id: "synthetic-id", tool: "synthetic-tool", [key]: "x".repeat(length) },
        ],
      },
    ]);
    const result = await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
    expect(result.text).toContain("does not currently support");
    expect(f.calls.find((call) => call.url.endsWith("/pair"))?.body).toMatchObject({
      connectionError: "bridge-capabilities-missing",
      missingCapabilities: ["session-messages"],
    });
    expect(f.snapshots()).toEqual([]);
  });
  it("accepts projected tool identity and name at the snapshot length limit", async () => {
    const f = await fixture({ connect: false, version: "2.1.307" });
    const id = "i".repeat(256);
    const name = "n".repeat(256);
    f.setMessages([{ role: "assistant", text: "", toolUses: [{ tool_use_id: id, tool: name }] }]);
    expect(
      (await f.run("command.run", { command: "agentkib-connect", args: f.ticket })).text,
    ).toContain("connected");
    expect(f.snapshots().at(-1).toolItems).toEqual([]);
  });
  it("reports a missing version method as a capability failure without fabricating the CLI version", async () => {
    const f = await fixture({ connect: false });
    delete f.api.session.version;
    const result = await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
    expect(result.text).toContain("unknown version");
    const report = f.calls.find((call) => call.url.endsWith("/pair"))?.body;
    expect(report).toMatchObject({
      connectionError: "bridge-capabilities-missing",
      missingCapabilities: ["session-identity"],
    });
    expect(report).not.toHaveProperty("cliVersion");
  });
  it("connects whatever release the plugin's files on disk come from", async () => {
    // AgentKib may have updated them under this running terminal; it checks the running plugin.
    const f = await fixture({ connect: false, version: "2.1.307" });
    const read = f.api.fs.read;
    f.api.fs.read = async (path: string) =>
      path === "/synthetic/plugin/package.json" ? JSON.stringify({ version: "0.1.0" }) : read(path);
    const result = await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
    expect(result.text).toContain("AgentKib connected");
    const pair = f.calls.find((call) => call.url.endsWith("/pair"))?.body;
    expect(pair).toMatchObject({
      pluginVersion: CLAUDE_BRIDGE_PLUGIN_VERSION,
      cliVersion: "2.1.307",
    });
    expect(pair).not.toHaveProperty("connectionError");
  });
  it.each(["2.1.301-beta", "02.1.301", "not-a-version"])(
    "rejects ambiguous version %s without displaying arbitrary native data",
    async (version) => {
      const f = await fixture({ connect: false, version });
      const result = await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
      expect(result.text).toContain("supported stable Claude Code version");
      expect(result.text).not.toContain(version);
      const report = f.calls.find((call) => call.url.endsWith("/pair"))?.body;
      expect(report).toMatchObject({ connectionError: "bridge-cli-unsupported" });
      expect(report).not.toHaveProperty("cliVersion");
      expect(f.snapshots()).toHaveLength(0);
    },
  );
  it("does not repeat filesystem and credential-store probes on ordinary snapshots and idle polls", async () => {
    const f = await fixture();
    const read = vi.fn(f.api.fs.read);
    const set = vi.fn(f.api.store.set);
    f.api.fs.read = read;
    f.api.store.set = set;
    await f.run("session.append", {
      message: { type: "user", content: [{ type: "text", text: "next native history" }] },
    });
    await f.tick();
    await f.tick();
    expect(read).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
  it("does not block terminal startup or revive an ended session after a delayed reconnect", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      connect: false,
      storedCredential: true,
      httpInterceptor: async (url) => {
        if (url.endsWith("/reconnect")) await held;
      },
    });
    expect(f.nativeStarts).toBe(1);
    await f.run("session.end", { reason: "exit" });
    release();
    await f.tick();
    const status = await f.run("command.run", { command: "agentkib-status", args: "" });
    expect(status.text).toContain("not connected");
    expect(f.snapshots().filter((snapshot) => snapshot.status !== "disconnected")).toHaveLength(0);
  });

  it("retries startup reconnect on later ticks when Runtime was initially offline", async () => {
    let fail = true;
    const f = await fixture({
      connect: false,
      storedCredential: true,
      httpInterceptor: async (url) => {
        if (url.endsWith("/reconnect") && fail) {
          fail = false;
          throw new Error("offline");
        }
      },
    });
    await expect
      .poll(() => f.calls.filter((call) => call.url.endsWith("/reconnect")).length)
      .toBe(1);
    for (let tick = 0; tick < 4; tick++) await f.tick();
    expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(2);
    expect((await f.run("command.run", { command: "agentkib-status", args: "" })).text).toContain(
      "is connected",
    );
    expect(f.dispatches).toBe(0);
  });

  it("retries saved-binding startup once the native REPL can read its history", async () => {
    let ready = false;
    const history = vi.fn(async () => {
      if (!ready)
        throw new Error(
          "$.session.messages is not available in this mode: no session is bound in this process " +
            "(the REPL has not mounted and no headless session is built); catch it and carry on",
        );
      return [{ role: "user", text: "native history" }];
    });
    const f = await fixture({
      connect: false,
      storedCredential: true,
      configure: (api) => (api.session.messages = history),
    });
    await expect.poll(() => history.mock.calls.length).toBe(1);
    expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(0);
    expect((await f.run("command.run", { command: "agentkib-status" })).text).toContain(
      "not connected",
    );
    ready = true;
    await expect
      .poll(async () => {
        await f.tick();
        return (await f.run("command.run", { command: "agentkib-status" })).text;
      })
      .toContain("is connected");
    const reconnects = f.calls.filter((call) => call.url.endsWith("/reconnect"));
    expect(reconnects).toHaveLength(1);
    expect(reconnects[0].body).not.toHaveProperty("connectionError");
    expect(reconnects[0].body.nativeCapabilities.available).toContain("session-messages");
    expect(f.dispatches).toBe(0);
    expect(f.stops).toBe(0);
  });

  it.each(["timer", "prompt.submit", "turn.start"])(
    "recovers a running terminal after Runtime returns using %s without dispatching anything",
    async (wake) => {
      const f = await fixture();
      f.nextHttpResponse("/v1/commands", { status: 409, body: { error: "bridge-lease-expired" } });
      await f.tick();
      let offline = true;
      f.setHttpInterceptor(async (url) => {
        if (url.endsWith("/reconnect") && offline) throw new Error("Runtime is offline");
      });
      await f.tick();
      expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(1);
      offline = false;
      f.setIdentity({ version: "2.1.307" });
      if (wake === "timer") {
        for (let tick = 0; tick < 40; tick++) await f.tick();
      } else {
        const event = { text: "native terminal prompt", turnId: randomUUID() };
        let nativeCalls = 0;
        const result = await f.run(wake, event, (received) => {
          nativeCalls++;
          expect(received).toBe(event);
          return { native: true };
        });
        expect(result).toEqual({ native: true });
        expect(nativeCalls).toBe(1);
        await expect
          .poll(() => f.calls.filter((call) => call.url.endsWith("/reconnect")).length)
          .toBe(2);
      }
      await f.tick();
      expect(f.calls.filter((call) => call.url.endsWith("/reconnect")).at(-1)?.body).toMatchObject({
        cliVersion: "2.1.307",
        nativeCapabilities: {
          available: expect.arrayContaining(["session-messages", "credential-read"]),
        },
      });
      expect((await f.run("command.run", { command: "agentkib-status", args: "" })).text).toContain(
        "is connected",
      );
      expect(f.snapshots().at(-1).capabilities).toMatchObject({
        read: true,
        send: wake !== "turn.start",
      });
      expect(f.dispatches).toBe(0);
      expect(f.stops).toBe(0);
    },
  );

  it("backs off repeated offline reconnects while repeating the credential and capability checks", async () => {
    const f = await fixture();
    const messages = vi.spyOn(f.api.session, "messages");
    const reads = vi.spyOn(f.api.fs, "read");
    const attempts: number[] = [];
    let tick = 0;
    f.nextHttpResponse("/v1/commands", { status: 409, body: { error: "bridge-lease-expired" } });
    await f.tick();
    f.setHttpInterceptor(async (url) => {
      if (url.endsWith("/reconnect")) {
        attempts.push(tick);
        throw new Error("Runtime stays offline");
      }
    });
    for (; tick < 96; tick++) await f.tick();
    expect(attempts.length).toBeGreaterThanOrEqual(4);
    expect(attempts.length).toBeLessThanOrEqual(6);
    const gaps = attempts.slice(1).map((value, index) => value - attempts[index]!);
    expect(
      gaps.every((gap, index) => gap >= 4 && gap <= 32 && (!index || gap >= gaps[index - 1]!)),
    ).toBe(true);
    expect(messages).toHaveBeenCalledTimes(attempts.length);
    expect(reads.mock.calls.filter(([path]) => path === f.connection.credentialPath)).toHaveLength(
      attempts.length,
    );
    expect(
      reads.mock.calls.filter(([path]) => path === "/synthetic/plugin/package.json"),
    ).toHaveLength(attempts.length);
    expect(f.dispatches).toBe(0);
  });

  it.each(["timer", "prompt.submit", "turn.start"])(
    "retains saved-binding recovery after an expired replacement pairing using %s",
    async (wake) => {
      const f = await fixture();
      f.nextHttpResponse("/v1/commands", { status: 409, body: { error: "bridge-lease-expired" } });
      await f.tick();
      let offline = true;
      f.setHttpInterceptor(async (url) => {
        if (url.endsWith("/reconnect") && offline) throw new Error("Runtime is offline");
      });
      await f.tick();
      offline = false;
      f.nextHttpResponse("/v1/pair", { status: 409, body: { error: "expired-bridge-challenge" } });
      const rejected = await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
      expect(rejected.text).toContain("has expired");
      const reads = vi.spyOn(f.api.fs, "read");
      const set = vi.spyOn(f.api.store, "set");
      if (wake === "timer") {
        for (let tick = 0; tick < 8; tick++) await f.tick();
      } else {
        await f.run(wake, { text: "native terminal prompt", turnId: randomUUID() });
      }
      await expect
        .poll(() => f.calls.filter((call) => call.url.endsWith("/reconnect")).length)
        .toBe(2);
      await f.tick();
      expect(
        reads.mock.calls.filter(([path]) => path === f.connection.credentialPath),
      ).toHaveLength(1);
      expect(
        reads.mock.calls.filter(([path]) => path === "/synthetic/plugin/package.json"),
      ).toHaveLength(1);
      expect(set).toHaveBeenCalledWith(
        "compatibility:credential-store:1",
        `agentkib-bridge:${CLAUDE_BRIDGE_PLUGIN_VERSION}:capabilities:1`,
      );
      expect((await f.run("command.run", { command: "agentkib-status", args: "" })).text).toContain(
        "is connected",
      );
      expect(f.snapshots().at(-1).capabilities.send).toBe(wake !== "turn.start");
      expect(f.dispatches).toBe(0);
      expect(f.stops).toBe(0);
    },
  );

  it("neither probes nor writes the plugin store while AgentKib is closed, and reconnects when it returns", async () => {
    const f = await fixture();
    const reconnects = () => f.calls.filter((call) => call.url.endsWith("/reconnect")).length;
    f.setReachable(false);
    f.nextHttpResponse("/v1/commands", { status: 409, body: { error: "bridge-lease-expired" } });
    const set = vi.spyOn(f.api.store, "set");
    const reads = vi.spyOn(f.api.fs, "read");
    const before = reconnects();
    // Several backoff rounds: about twenty seconds of a closed AgentKib.
    for (let tick = 0; tick < 80; tick++) await f.tick();
    expect(f.pings.length).toBeGreaterThan(2);
    expect(reconnects()).toBe(before);
    expect(set).not.toHaveBeenCalled();
    expect(
      reads.mock.calls.filter(([path]) => path === "/synthetic/plugin/package.json"),
    ).toHaveLength(0);
    f.setReachable(true);
    await expect
      .poll(async () => {
        await f.tick();
        return reconnects();
      })
      .toBe(before + 1);
    expect((await f.run("command.run", { command: "agentkib-status", args: "" })).text).toContain(
      "is connected",
    );
  });

  it("pauses saved-binding recovery during replacement pairing and resumes its bounded backoff after rejection", async () => {
    const f = await fixture();
    f.nextHttpResponse("/v1/commands", { status: 409, body: { error: "bridge-lease-expired" } });
    await f.tick();
    const held = deferred<void>();
    f.setHttpInterceptor(async (url) => {
      if (url.endsWith("/reconnect")) throw new Error("Runtime stays offline");
      if (url.endsWith("/pair")) await held.promise;
    });
    await f.tick();
    f.nextHttpResponse("/v1/pair", { status: 409, body: { error: "invalid-bridge-challenge" } });
    const pairing = f.run("command.run", { command: "agentkib-connect", args: f.ticket });
    await expect.poll(() => f.calls.filter((call) => call.url.endsWith("/pair")).length).toBe(2);
    for (let tick = 0; tick < 40; tick++) await f.tick();
    await f.run("prompt.submit", { text: "native prompt during pairing" });
    await f.run("turn.start", { text: "native prompt during pairing", turnId: randomUUID() });
    expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(1);
    held.resolve();
    expect((await pairing).text).toContain("invalid or already used");
    for (let tick = 0; tick < 96; tick++) await f.tick();
    const reconnects = f.calls.filter((call) => call.url.endsWith("/reconnect"));
    expect(reconnects.length).toBeGreaterThanOrEqual(5);
    expect(reconnects.length).toBeLessThanOrEqual(7);
    expect(f.dispatches).toBe(0);
    expect(f.stops).toBe(0);
  });

  it.each([
    { wake: "timer", order: "first-fails-first" },
    { wake: "timer", order: "first-fails-last" },
    { wake: "prompt.submit", order: "first-fails-first" },
    { wake: "prompt.submit", order: "first-fails-last" },
  ])(
    "retains recovery through overlapping rejected replacement pairings using $wake when $order",
    async ({ wake, order }) => {
      const f = await fixture();
      f.nextHttpResponse("/v1/commands", { status: 409, body: { error: "bridge-lease-expired" } });
      await f.tick();
      f.setHttpInterceptor(async (url) => {
        if (url.endsWith("/reconnect")) throw new Error("Runtime is offline");
      });
      await f.tick();
      const held = [deferred<void>(), deferred<void>()];
      let pairingIndex = 0;
      f.setHttpInterceptor(async (url) => {
        if (url.endsWith("/pair")) await held[pairingIndex++]!.promise;
      });
      const first = f.run("command.run", { command: "agentkib-connect", args: f.ticket });
      await expect.poll(() => f.calls.filter((call) => call.url.endsWith("/pair")).length).toBe(2);
      const second = f.run("command.run", { command: "agentkib-connect", args: f.ticket });
      await expect.poll(() => f.calls.filter((call) => call.url.endsWith("/pair")).length).toBe(3);
      for (let tick = 0; tick < 8; tick++) await f.tick();
      await f.run("prompt.submit", { text: "native prompt while both pairings wait" });
      expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(1);
      const earlier = order === "first-fails-first" ? 0 : 1;
      f.nextHttpResponse("/v1/pair", { status: 409, body: { error: "expired-bridge-challenge" } });
      held[earlier]!.resolve();
      await [first, second][earlier];
      if (earlier === 0) {
        for (let tick = 0; tick < 8; tick++) await f.tick();
        await f.run("prompt.submit", { text: "native prompt while latest pairing waits" });
        expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(1);
      }
      f.nextHttpResponse("/v1/pair", { status: 409, body: { error: "invalid-bridge-challenge" } });
      held[1 - earlier]!.resolve();
      await [first, second][1 - earlier];
      f.setHttpInterceptor(undefined);
      if (wake === "timer") {
        for (let tick = 0; tick < 8; tick++) await f.tick();
      } else await f.run(wake, { text: "native prompt after both pairings fail" });
      await expect
        .poll(() => f.calls.filter((call) => call.url.endsWith("/reconnect")).length)
        .toBe(2);
      await f.tick();
      expect((await f.run("command.run", { command: "agentkib-status", args: "" })).text).toContain(
        "is connected",
      );
      expect(f.snapshots().at(-1).capabilities.send).toBe(wake !== "turn.start");
      expect(f.dispatches).toBe(0);
      expect(f.stops).toBe(0);
    },
  );

  it.each(["end", "new-pair"])(
    "does not restore recovery from a replacement pairing failure after %s",
    async (action) => {
      const f = await fixture();
      f.nextHttpResponse("/v1/commands", { status: 409, body: { error: "bridge-lease-expired" } });
      await f.tick();
      f.setHttpInterceptor(async (url) => {
        if (url.endsWith("/reconnect")) throw new Error("Runtime is offline");
      });
      await f.tick();
      const held = deferred<void>();
      let holdPair = true;
      f.setHttpInterceptor(async (url) => {
        if (url.endsWith("/pair") && holdPair) {
          holdPair = false;
          await held.promise;
        }
      });
      const pairing = f.run("command.run", { command: "agentkib-connect", args: f.ticket });
      await expect.poll(() => f.calls.filter((call) => call.url.endsWith("/pair")).length).toBe(2);
      if (action === "end") await f.run("session.end", { reason: "exit" });
      else {
        const paired = await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
        expect(paired.text).toContain("connected to this");
      }
      f.nextHttpResponse("/v1/pair", { status: 409, body: { error: "expired-bridge-challenge" } });
      held.resolve();
      await pairing;
      for (let tick = 0; tick < 40; tick++) await f.tick();
      await f.run("prompt.submit", { text: "native prompt after stale pairing" });
      for (let tick = 0; tick < 40; tick++) await f.tick();
      expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(1);
      expect((await f.run("command.run", { command: "agentkib-status", args: "" })).text).toContain(
        action === "end" ? "not connected" : "is connected",
      );
    },
  );

  it.each(["end", 401, 410])(
    "does not retain overlapping pairings' recovery intent after %s",
    async (invalidation) => {
      const f = await fixture();
      f.nextHttpResponse("/v1/commands", { status: 409, body: { error: "bridge-lease-expired" } });
      await f.tick();
      f.setHttpInterceptor(async (url) => {
        if (url.endsWith("/reconnect")) throw new Error("Runtime is offline");
      });
      await f.tick();
      const held = [deferred<void>(), deferred<void>()];
      let pairingIndex = 0;
      f.setHttpInterceptor(async (url) => {
        if (url.endsWith("/pair")) await held[pairingIndex++]!.promise;
      });
      const first = f.run("command.run", { command: "agentkib-connect", args: f.ticket });
      await expect.poll(() => f.calls.filter((call) => call.url.endsWith("/pair")).length).toBe(2);
      const second = f.run("command.run", { command: "agentkib-connect", args: f.ticket });
      await expect.poll(() => f.calls.filter((call) => call.url.endsWith("/pair")).length).toBe(3);
      if (invalidation === "end") await f.run("session.end", { reason: "exit" });
      f.nextHttpResponse("/v1/pair", {
        status: invalidation === "end" ? 409 : invalidation,
        body: { error: invalidation === "end" ? "invalid-bridge-challenge" : "binding-revoked" },
      });
      held[1]!.resolve();
      await second;
      f.nextHttpResponse("/v1/pair", { status: 409, body: { error: "expired-bridge-challenge" } });
      held[0]!.resolve();
      await first;
      f.setHttpInterceptor(undefined);
      for (let tick = 0; tick < 40; tick++) await f.tick();
      await f.run("prompt.submit", {
        text: "native prompt after overlapping pairing invalidation",
      });
      for (let tick = 0; tick < 40; tick++) await f.tick();
      expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(1);
      expect((await f.run("command.run", { command: "agentkib-status", args: "" })).text).toContain(
        "not connected",
      );
      expect(f.dispatches).toBe(0);
      expect(f.stops).toBe(0);
    },
  );

  it("does not invent saved-binding recovery for overlapping first-time pairings", async () => {
    const f = await fixture({ connect: false });
    // Finish the startup lookup so it has established that no saved path exists.
    for (let tick = 0; tick < 8; tick++) await f.tick();
    const held = deferred<void>();
    let holdFirst = true;
    f.setHttpInterceptor(async (url) => {
      if (url.endsWith("/pair") && holdFirst) {
        holdFirst = false;
        await held.promise;
      }
    });
    const first = f.run("command.run", { command: "agentkib-connect", args: f.ticket });
    await expect.poll(() => f.calls.filter((call) => call.url.endsWith("/pair")).length).toBe(1);
    f.nextHttpResponse("/v1/pair", { status: 409, body: { error: "expired-bridge-challenge" } });
    await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
    f.nextHttpResponse("/v1/pair", { status: 409, body: { error: "invalid-bridge-challenge" } });
    held.resolve();
    await first;
    const identityRead = vi.spyOn(f.api.session, "version");
    for (let tick = 0; tick < 40; tick++) await f.tick();
    await f.run("prompt.submit", { text: "native prompt with no saved binding" });
    for (let tick = 0; tick < 40; tick++) await f.tick();
    expect(identityRead).not.toHaveBeenCalled();
    expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(0);
    expect(f.dispatches).toBe(0);
    expect(f.stops).toBe(0);
  });

  it.each([401, 410, "identity-change"])(
    "keeps saved-binding recovery closed after replacement pairing fails with %s",
    async (failure) => {
      const f = await fixture();
      f.nextHttpResponse("/v1/commands", { status: 409, body: { error: "bridge-lease-expired" } });
      await f.tick();
      f.setHttpInterceptor(async (url) => {
        if (url.endsWith("/reconnect")) throw new Error("Runtime is offline");
      });
      await f.tick();
      f.setHttpInterceptor(undefined);
      if (failure === "identity-change") f.setIdentity({ cwd: "/other/workspace" });
      else f.nextHttpResponse("/v1/pair", { status: failure, body: { error: "binding-revoked" } });
      await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
      for (let tick = 0; tick < 40; tick++) await f.tick();
      await f.run("prompt.submit", { text: "native prompt after invalidation" });
      await f.run("turn.start", { text: "native prompt after invalidation", turnId: randomUUID() });
      for (let tick = 0; tick < 40; tick++) await f.tick();
      expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(1);
      expect((await f.run("command.run", { command: "agentkib-status", args: "" })).text).toContain(
        "not connected",
      );
      expect(f.dispatches).toBe(0);
      expect(f.stops).toBe(0);
    },
  );

  it.each(["success", "revoked"])(
    "ignores a prior handshake's late %s after replacement pairing fails",
    async (outcome) => {
      const f = await fixture();
      f.nextHttpResponse("/v1/commands", { status: 409, body: { error: "bridge-lease-expired" } });
      await f.tick();
      const held = deferred<void>();
      f.setHttpInterceptor(async (url) => {
        if (url.endsWith("/reconnect")) await held.promise;
      });
      await f.run("prompt.submit", { text: "native prompt starts reconnect" });
      await expect
        .poll(() => f.calls.filter((call) => call.url.endsWith("/reconnect")).length)
        .toBe(1);
      f.nextHttpResponse("/v1/pair", { status: 409, body: { error: "expired-bridge-challenge" } });
      const rejected = await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
      expect(rejected.text).toContain("has expired");
      if (outcome === "revoked")
        f.nextHttpResponse("/v1/reconnect", { status: 410, body: { error: "binding-revoked" } });
      held.resolve();
      f.setHttpInterceptor(undefined);
      for (let tick = 0; tick < 8; tick++) await f.tick();
      expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(2);
      expect((await f.run("command.run", { command: "agentkib-status", args: "" })).text).toContain(
        "is connected",
      );
      expect(f.snapshots().at(-1).capabilities.send).toBe(true);
      expect(f.dispatches).toBe(0);
      expect(f.stops).toBe(0);
    },
  );

  it("does not reuse cached credentials after a failed replacement pairing and credential removal", async () => {
    const f = await fixture();
    f.nextHttpResponse("/v1/commands", { status: 409, body: { error: "bridge-lease-expired" } });
    await f.tick();
    f.setHttpInterceptor(async (url) => {
      if (url.endsWith("/reconnect")) throw new Error("Runtime is offline");
    });
    await f.tick();
    f.setHttpInterceptor(undefined);
    f.nextHttpResponse("/v1/pair", { status: 409, body: { error: "expired-bridge-challenge" } });
    await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
    const read = f.api.fs.read;
    f.api.fs.read = async (path: string) => {
      if (path === f.connection.credentialPath) throw new Error("credential no longer exists");
      return read(path);
    };
    for (let tick = 0; tick < 40; tick++) await f.tick();
    await f.run("prompt.submit", { text: "native prompt after credential removal" });
    for (let tick = 0; tick < 40; tick++) await f.tick();
    expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(1);
    expect((await f.run("command.run", { command: "agentkib-status", args: "" })).text).toBe(
      "The saved AgentKib connection for this session could not be read. Generate a new connection code in AgentKib and run it in this terminal.",
    );
    expect(f.dispatches).toBe(0);
    expect(f.stops).toBe(0);
  });

  it("does not block native events or start overlapping reconnects while a handshake is pending", async () => {
    const f = await fixture();
    f.nextHttpResponse("/v1/commands", { status: 409, body: { error: "bridge-lease-expired" } });
    await f.tick();
    const held = deferred<void>();
    f.setHttpInterceptor(async (url) => {
      if (url.endsWith("/reconnect")) await held.promise;
    });
    let nativePrompts = 0;
    await f.run("prompt.submit", { text: "native prompt" }, () => {
      nativePrompts++;
      return { native: true };
    });
    expect(nativePrompts).toBe(1);
    await expect
      .poll(() => f.calls.filter((call) => call.url.endsWith("/reconnect")).length)
      .toBe(1);
    await f.run("turn.start", { text: "native prompt", turnId: randomUUID() });
    await f.tick();
    await f.tick();
    expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(1);
    held.resolve();
    await expect
      .poll(async () => (await f.run("command.run", { command: "agentkib-status", args: "" })).text)
      .toContain("is connected");
    expect(f.dispatches).toBe(0);
  });

  it.each(["revoked", "deleted-credential"])(
    "does not recover through cached credentials after %s",
    async (reason) => {
      const f = await fixture();
      f.nextHttpResponse("/v1/commands", { status: 409, body: { error: "bridge-lease-expired" } });
      await f.tick();
      if (reason === "revoked") {
        f.nextHttpResponse("/v1/reconnect", { status: 410, body: { error: "binding-revoked" } });
      } else {
        const read = f.api.fs.read;
        f.api.fs.read = async (path: string) => {
          if (path === f.connection.credentialPath) throw new Error("credential no longer exists");
          return read(path);
        };
      }
      const eventsBefore = f.events().length;
      for (let tick = 0; tick < 40; tick++) await f.tick();
      await f.run("prompt.submit", { text: "native terminal prompt" });
      await f.run("turn.start", { turnId: randomUUID(), text: "native terminal prompt" });
      for (let tick = 0; tick < 40; tick++) await f.tick();
      expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(
        reason === "revoked" ? 1 : 0,
      );
      expect(
        f
          .events()
          .slice(eventsBefore)
          .every(
            ({ event }) =>
              event.type === "invalidated" ||
              (event.type === "snapshot" &&
                event.snapshot.status === "disconnected" &&
                event.snapshot.messages.length === 0 &&
                event.snapshot.streamText === ""),
          ),
      ).toBe(true);
      expect((await f.run("command.run", { command: "agentkib-status", args: "" })).text).toContain(
        reason === "deleted-credential" ? "saved AgentKib connection" : "not connected",
      );
      expect(f.dispatches).toBe(0);
    },
  );

  it.each(["pair", "end", "identity"])(
    "isolates an in-session reconnect failure from a later %s",
    async (action) => {
      const f = await fixture();
      f.nextHttpResponse("/v1/commands", { status: 409, body: { error: "bridge-lease-expired" } });
      await f.tick();
      const held = deferred<void>();
      f.setHttpInterceptor(async (url) => {
        if (url.endsWith("/reconnect")) {
          await held.promise;
          throw new Error("late offline failure");
        }
      });
      await f.run("prompt.submit", { text: "native prompt" });
      await expect
        .poll(() => f.calls.filter((call) => call.url.endsWith("/reconnect")).length)
        .toBe(1);
      if (action === "pair") {
        const paired = await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
        expect(paired.text).toContain("connected to this");
      } else if (action === "end") {
        await f.run("session.end", { reason: "resume" });
      } else {
        f.setIdentity({ cwd: "/other/workspace" });
      }
      held.resolve();
      for (let tick = 0; tick < 40; tick++) await f.tick();
      await f.run("prompt.submit", { text: "later native prompt" });
      for (let tick = 0; tick < 40; tick++) await f.tick();
      expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(1);
      expect((await f.run("command.run", { command: "agentkib-status", args: "" })).text).toContain(
        action === "pair" ? "is connected" : "not connected",
      );
      expect(f.dispatches).toBe(0);
    },
  );

  it("keeps a slow reconnect private from both timer lanes and preserves native completion", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      connect: false,
      storedCredential: true,
      httpInterceptor: async (url) => {
        if (url.endsWith("/reconnect")) await held;
      },
    });
    await expect.poll(() => f.calls.some((call) => call.url.endsWith("/reconnect"))).toBe(true);
    const turnId = randomUUID();
    await f.run("turn.start", { text: "native terminal", turnId });
    await f.run("turn.complete", { turnId, answer: "done", isAborted: true });
    for (let index = 0; index < 3; index++) await f.tick();
    expect(
      f.calls.every(
        (call) => !["/events", "/commands"].some((suffix) => call.url.endsWith(suffix)),
      ),
    ).toBe(true);
    release();
    await expect
      .poll(async () =>
        (await f.run("command.run", { command: "agentkib-status", args: "" })).text.includes(
          "is connected",
        ),
      )
      .toBe(true);
    await f.tick();
    const completions = f.calls
      .filter((call) => call.url.endsWith("/events"))
      .flatMap((call) => call.body.events)
      .filter((entry) => entry.event.type === "turn-complete");
    expect(completions).toHaveLength(1);
    expect(completions[0].event.turnId).toBe(turnId);
    expect(f.snapshots().at(-1).capabilities.read).toBe(true);
  });

  it("allows explicit pairing to supersede startup reconnect and ignores its late revoked response", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      connect: false,
      storedCredential: true,
      httpInterceptor: async (url) => {
        if (url.endsWith("/reconnect")) await held;
      },
    });
    await expect.poll(() => f.calls.some((call) => call.url.endsWith("/reconnect"))).toBe(true);
    f.nextHttpResponse("/v1/reconnect", { status: 410, body: { error: "binding-revoked" } });
    const connected = await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
    expect(connected.text).toContain("connected to this");
    release();
    await f.tick();
    expect((await f.run("command.run", { command: "agentkib-status", args: "" })).text).toContain(
      "is connected",
    );
    expect(f.snapshots().at(-1).capabilities.read).toBe(true);
  });

  it("preserves turn completion across delta overflow and clears only the temporary pause after snapshot ACK", async () => {
    for (const unknown of [false, true]) {
      const f = await fixture();
      if (unknown) {
        f.setSubmit(async (value) => ({ text: value.text }));
        await f.deliver({
          commandId: randomUUID(),
          kind: "send",
          requestId: randomUUID(),
          text: "unconfirmed",
          expectedRevision: 0,
        });
      }
      const turnId = randomUUID();
      const eventIndex = f.events().length;
      await f.run("turn.start", { text: "terminal", turnId });
      const callsBeforeStream = f.calls.length;
      const chunks = Array.from({ length: 300 }, () => ({ kind: "text", text: "x" }));
      const nativeResult = { turnId, answer: "x".repeat(300) };
      expect(await collectStream(f.stream(turnId, chunks, nativeResult))).toEqual({
        chunks,
        result: nativeResult,
      });
      expect(f.calls).toHaveLength(callsBeforeStream);
      f.setMessages([{ role: "assistant", text: nativeResult.answer }]);
      await f.run("turn.complete", { turnId, answer: "x".repeat(300), isAborted: true });
      for (let index = 0; index < 12; index++) await f.tick();
      const delivered = f.events().slice(eventIndex);
      expect(delivered[0].event).toMatchObject({ type: "gap", revision: 1 });
      const replacementIndex = delivered.findIndex((entry) => entry.event.type === "snapshot");
      expect(replacementIndex).toBeGreaterThan(0);
      expect(
        delivered.slice(1, replacementIndex).every((entry) => entry.event.type === "turn-complete"),
      ).toBe(true);
      const completions = delivered.filter((entry) => entry.event.type === "turn-complete");
      expect(completions).toHaveLength(1);
      expect(completions[0].event.turnId).toBe(turnId);
      expect(f.snapshots().at(-1)).toMatchObject({
        status: "idle",
        messages: [{ role: "assistant", text: nativeResult.answer }],
        streamText: nativeResult.answer,
      });
      expect(f.snapshots().at(-1).capabilities.send).toBe(!unknown);
    }
  });

  it("keeps an overflow gap and completion newer than an already in-flight event ACK", async () => {
    const f = await fixture();
    const turnId = randomUUID();
    await f.run("turn.start", { text: "terminal", turnId });
    await f.flush();
    await collectStream(f.stream(turnId, [{ kind: "text", text: "before the lost batch" }]));
    const held = deferred<void>();
    const intercepted = deferred<void>();
    f.setHttpInterceptor(async (url) => {
      if (url.endsWith("/events")) {
        intercepted.resolve();
        await held.promise;
      }
    });
    const inFlight = f.flush();
    await intercepted.promise;
    const oldBatch = f.calls.filter((call) => call.url.endsWith("/events")).at(-1)!.body.events;
    const oldAck = oldBatch.at(-1).seq;
    const eventIndex = f.events().length;
    const chunks = Array.from({ length: 300 }, () => ({ kind: "text", text: "new" }));
    const nativeResult = { answer: "native final", turnId };
    expect(await collectStream(f.stream(turnId, chunks, nativeResult))).toEqual({
      chunks,
      result: nativeResult,
    });
    f.setMessages([{ role: "assistant", text: "native final" }]);
    await f.run("turn.complete", { turnId, answer: "native final", isAborted: false });
    expect(f.events()).toHaveLength(eventIndex);
    held.resolve();
    await inFlight;
    f.setHttpInterceptor(undefined);
    for (let index = 0; index < 12; index++) await f.flush();
    const recovered = f.events().slice(eventIndex);
    expect(recovered[0].event.type).toBe("gap");
    expect(recovered[0].seq).toBeGreaterThan(oldAck);
    expect(recovered.every((entry) => entry.seq > oldAck)).toBe(true);
    expect(recovered.filter((entry) => entry.event.type === "turn-complete")).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ turnId, text: "native final", aborted: false }),
      }),
    ]);
    expect(f.snapshots().at(-1)).toMatchObject({
      status: "idle",
      messages: [{ role: "assistant", text: "native final" }],
    });
  });

  it("rejects cancellation during an unreported gap and restores it only after snapshot acknowledgement", async () => {
    const f = await fixture();
    const turnId = randomUUID();
    await f.run("turn.start", { text: "terminal", turnId });
    await f.flush();
    expect(f.snapshots().at(-1).capabilities.stop).toBe(true);
    await collectStream(
      f.stream(
        turnId,
        Array.from({ length: 300 }, () => ({ kind: "text", text: "delta" })),
      ),
    );
    const stop = () => ({
      commandId: randomUUID(),
      kind: "stop",
      turnId,
      expectedRevision: 1,
    });
    await f.deliver(stop());
    expect(f.stops).toBe(0);
    expect(f.results().at(-1).status).toBe("rejected");
    for (let index = 0; index < 12; index++) await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({
      status: "running",
      currentTurnId: turnId,
      capabilities: { stop: true },
    });
    await f.deliver(stop());
    expect(f.stops).toBe(1);
    expect(f.results().at(-1)).toMatchObject({ status: "accepted", turnId });
  });

  it("keeps cancellation fenced when previews advance before the recovery snapshot ACK", async () => {
    const f = await fixture();
    const turnId = randomUUID();
    await f.run("turn.start", { text: "terminal", turnId });
    await collectStream(
      f.stream(
        turnId,
        Array.from({ length: 300 }, () => ({ kind: "text", text: "x" })),
      ),
    );
    const held = deferred<void>();
    const intercepted = deferred<void>();
    f.setHttpInterceptor(async (url) => {
      if (url.endsWith("/events")) {
        intercepted.resolve();
        await held.promise;
      }
    });
    const recovery = f.flush();
    await intercepted.promise;
    expect(f.snapshots().at(-1)).toMatchObject({
      streamText: "x".repeat(300),
      capabilities: { stop: false },
    });
    await collectStream(f.stream(turnId, [{ kind: "text", text: "after snapshot" }]));
    held.resolve();
    await recovery;
    f.setHttpInterceptor(undefined);
    await f.deliver({
      commandId: randomUUID(),
      kind: "stop",
      turnId,
      expectedRevision: 1,
    });
    expect(f.stops).toBe(0);
    expect(f.results().at(-1)).toMatchObject({
      status: "rejected",
      reason: "session-state-unverified",
    });
    for (let index = 0; index < 3; index++) await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({
      streamText: "x".repeat(300) + "after snapshot",
      capabilities: { stop: true },
    });
  });

  it("rejects a polled cancellation when the event lane loses its lease before dispatch", async () => {
    const f = await fixture();
    const turnId = randomUUID();
    await f.run("turn.start", { text: "terminal", turnId });
    await f.flush();
    const polled = deferred<void>();
    const commandGate = deferred<void>();
    f.setHttpInterceptor(async (url) => {
      if (url.endsWith("/commands")) {
        polled.resolve();
        await commandGate.promise;
      }
    });
    const stop = () => ({
      commandId: randomUUID(),
      kind: "stop",
      turnId,
      expectedRevision: 1,
    });
    const pendingStop = f.deliver(stop());
    await polled.promise;
    await f.run("session.append", {});
    f.nextHttpResponse("/v1/events", {
      status: 409,
      body: { error: "bridge-lease-expired" },
    });
    await f.flush();
    commandGate.resolve();
    await pendingStop;
    expect(f.stops).toBe(0);
    expect(f.results().at(-1)).toMatchObject({
      status: "rejected",
      reason: "session-state-unverified",
    });
    f.setHttpInterceptor(undefined);
    await f.tick();
    await f.flush();
    expect(f.snapshots().at(-1).capabilities.stop).toBe(true);
    await f.deliver(stop());
    expect(f.stops).toBe(1);
  });

  it("recovers a hot-loaded running turn from a main step before forwarding text without inventing a start", async () => {
    const f = await fixture({ activeAtStart: true });
    expect(f.snapshots().at(-1)).toMatchObject({
      status: "running",
      currentTurnId: null,
      waiting: null,
      capabilities: { send: false, stop: false },
    });
    const turnId = randomUUID();
    await collectStream(
      f.stream(turnId, [{ kind: "text", text: "subagent text" }], {}, { agentId: "child" }),
    );
    await f.flush();
    expect(f.snapshots().at(-1).currentTurnId).toBeNull();
    const eventIndex = f.events().length;
    const chunk = { kind: "text", text: "main response" };
    const nativeResult = { answer: "main response", turnId };
    const observed = await collectStream(f.stream(turnId, [chunk], nativeResult));
    expect(observed.chunks[0]).toBe(chunk);
    expect(observed.result).toBe(nativeResult);
    await f.flush();
    const delivered = f.events().slice(eventIndex);
    const snapshotIndex = delivered.findIndex((entry) => entry.event.type === "snapshot");
    const textIndex = delivered.findIndex((entry) => entry.event.type === "text");
    expect(snapshotIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThan(snapshotIndex);
    expect(delivered[snapshotIndex].event.snapshot).toMatchObject({
      status: "running",
      currentTurnId: turnId,
      capabilities: { stop: true },
    });
    expect(delivered[textIndex].event).toMatchObject({ turnId, text: "main response" });
    expect(f.events().some((entry) => entry.event.type === "turn-start")).toBe(false);
    expect(JSON.stringify(f.events())).not.toContain("subagent text");
  });

  it("captures completion and fresh history when reload missed both the start and the stream", async () => {
    const f = await fixture({ activeAtStart: true });
    const turnId = randomUUID();
    f.setMessages([{ role: "assistant", text: "completed before the first observed step" }]);
    const nativeResult = { native: "completion result" };
    expect(
      await f.run(
        "turn.complete",
        { turnId, answer: "completed before the first observed step", isAborted: false },
        () => nativeResult,
      ),
    ).toBe(nativeResult);
    await f.flush();
    expect(f.events().filter((entry) => entry.event.type === "turn-complete")).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          turnId,
          text: "completed before the first observed step",
          aborted: false,
        }),
      }),
    ]);
    expect(f.snapshots().at(-1)).toMatchObject({
      status: "idle",
      currentTurnId: null,
      capabilities: { send: true, stop: false },
      messages: [{ role: "assistant", text: "completed before the first observed step" }],
    });
    expect(f.events().some((entry) => entry.event.type === "turn-start")).toBe(false);
  });

  it("does not let a late old completion terminate a newer native turn", async () => {
    const f = await fixture();
    const oldTurn = randomUUID();
    const currentTurn = randomUUID();
    await f.run("turn.start", { text: "old", turnId: oldTurn });
    await f.run("turn.start", { text: "current", turnId: currentTurn });
    await collectStream(f.stream(currentTurn, [{ kind: "text", text: "current stream" }]));
    await f.run("turn.complete", { turnId: oldTurn, answer: "late old result", isAborted: true });
    await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({
      status: "running",
      currentTurnId: currentTurn,
      streamText: "current stream",
      capabilities: { stop: true, send: false },
    });
    await f.deliver({
      commandId: randomUUID(),
      kind: "stop",
      turnId: currentTurn,
      expectedRevision: f.snapshots().at(-1).revision,
    });
    expect(f.stops).toBe(1);
  });

  it("replays captured completion evidence after reconnect without repeating native actions", async () => {
    const f = await fixture();
    const turnId = randomUUID();
    await f.run("turn.start", { text: "terminal", turnId });
    await f.tick();
    // The end goes out at once and is lost on the way.
    let fail = true;
    f.setHttpInterceptor(async (url) => {
      if (url.endsWith("/events") && fail) {
        fail = false;
        throw new Error("lost event");
      }
    });
    await f.run("turn.complete", { turnId, answer: "done", isAborted: true });
    await f.tick();
    await f.tick();
    const completions = f.calls
      .filter((call) => call.url.endsWith("/events"))
      .flatMap((call) => call.body.events)
      .filter((entry) => entry.event.type === "turn-complete");
    expect(completions).toHaveLength(2);
    expect(completions.every((entry) => entry.event.turnId === turnId)).toBe(true);
    expect(f.dispatches).toBe(0);
    expect(f.stops).toBe(0);
  });

  it("validates tickets, literal text and UTF-8 boundaries", () => {
    expect(safeSocket("relative.sock")).toBe(false);
    expect(safeSocket("/tmp/../other.sock")).toBe(false);
    expect(() => decodeTicket("invalid")).toThrow();
    expect(validSend({ requestId: "id", text: "你好" })).toBe(true);
    expect(validSend({ requestId: "id", text: "/logout" })).toBe(false);
    expect(validSend({ requestId: "id", text: "🙂".repeat(4097) })).toBe(false);
    const clipped = previewText("🙂".repeat(1000), 128);
    expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(128);
    expect(clipped).toContain("preview truncated");
    expect(
      visibleMessages([
        { role: "system", text: "secret" },
        { role: "assistant", text: "visible", thinking: "secret" },
      ]),
    ).toEqual([{ role: "assistant", text: "visible" }]);
  });

  it("pairs only the exact native identity over HTTP-over-UDS and never stores tokens in the plugin store", async () => {
    const f = await fixture();
    const pair = f.calls.find((call) => call.url.endsWith("/pair"))!;
    expect(pair.init.socketPath).toBe("/private/bridge.sock");
    expect(pair.body).toMatchObject({
      nativeId: f.nativeId,
      cwd: "/isolated/workspace",
      cliVersion: "2.1.301",
    });
    expect(pair.init.headers.Authorization).toBeUndefined();
    expect([...f.stored]).toEqual([
      [
        "compatibility:credential-store:1",
        `agentkib-bridge:${CLAUDE_BRIDGE_PLUGIN_VERSION}:capabilities:1`,
      ],
      [`credentialPath:${f.nativeId}`, f.connection.credentialPath],
    ]);
    expect(JSON.stringify([...f.stored])).not.toContain(f.connection.token);
    expect(f.snapshots().at(-1)).toMatchObject({
      capabilities: { read: true, send: true, approve: false, answer: false },
    });
    expect(f.dispatches).toBe(0);
  });

  it("opens only the native model chooser, receipts its dispatch once, and reads the eventual selection", async () => {
    const picker = deferred<void>();
    const run = vi.fn(() => picker.promise);
    const readbacks = new Map<number, () => void>();
    let model = "claude-sonnet";
    const f = await fixture({
      features: ["open-model-picker"],
      configure(api) {
        api.session.model = async () => model;
        api.command.list = async () => [{ name: "model", source: "builtin" }];
        api.command.run = run;
        api.clock.after = (delay: number, cb: () => void) => readbacks.set(delay, cb);
      },
    });
    const initial = f.snapshots().at(-1);
    expect(initial).toMatchObject({ model, capabilities: { modelPicker: true } });
    const command = {
      commandId: randomUUID(),
      kind: "open-model-picker",
      expectedRevision: initial.revision,
    };
    await f.deliver(command);
    expect(run.mock.calls).toEqual([[{ command: "model" }]]);
    expect(f.results().at(-1)).toMatchObject({ commandId: command.commandId, status: "accepted" });
    await f.run("ui.render", { component: "AbovePrompt", props: { isWorking: true } });
    await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({
      model,
      modelPickerOpen: true,
      currentTurnId: null,
      status: "idle",
      capabilities: { modelPicker: false, send: false },
    });
    await f.deliver(command);
    await f.deliver({ ...command, commandId: randomUUID() });
    expect(f.results().at(-1)).toMatchObject({ status: "rejected" });
    expect(run).toHaveBeenCalledTimes(1);
    picker.resolve();
    await vi.waitFor(() => expect(readbacks.size).toBe(2));
    readbacks.get(1000)!();
    await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({
      model,
      modelPickerOpen: false,
      status: "idle",
      capabilities: { modelPicker: true, send: true },
    });
    model = "claude-haiku";
    readbacks.get(3000)!();
    await f.flush();
    expect(f.snapshots().at(-1).model).toBe(model);
    expect(f.dispatches).toBe(0);
  });

  it.each([
    { feature: false, busy: false, source: "builtin", revision: 0 },
    { feature: true, busy: true, source: "builtin", revision: 0 },
    { feature: true, busy: false, source: "plugin", revision: 0 },
    { feature: true, busy: false, source: "builtin", revision: 10 },
  ])(
    "refuses an unsupported, busy, shadowed, or stale native model chooser: %j",
    async ({ feature, busy, source, revision }) => {
      const run = vi.fn();
      const f = await fixture({
        features: feature ? ["open-model-picker"] : [],
        activeAtStart: busy,
        configure(api) {
          api.command.list = async () => [{ name: "model", source }];
          api.command.run = run;
        },
      });
      await f.deliver({
        commandId: randomUUID(),
        kind: "open-model-picker",
        expectedRevision: revision,
      });
      expect(f.results().at(-1)).toMatchObject({ status: "rejected" });
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("refuses a failed native chooser without changing the observed model", async () => {
    const f = await fixture({
      features: ["open-model-picker"],
      configure(api) {
        api.session.model = async () => "claude-sonnet";
        api.command.list = async () => [{ name: "model", source: "builtin" }];
        api.command.run = async () => ({ isError: true });
      },
    });
    await f.deliver({ commandId: randomUUID(), kind: "open-model-picker", expectedRevision: 0 });
    expect(f.results().at(-1)).toMatchObject({
      status: "rejected",
      reason: "native-model-picker-unavailable",
    });
    expect(f.snapshots().at(-1)).toMatchObject({
      model: "claude-sonnet",
      capabilities: { modelPicker: false },
    });
  });

  it("requires origin and a matching actual turn to acknowledge a send, and never repeats it", async () => {
    const f = await fixture();
    const command = {
      commandId: randomUUID(),
      kind: "send",
      requestId: randomUUID(),
      text: "native follow-up",
      expectedRevision: 0,
    };
    await f.deliver(command);
    expect(f.dispatches).toBe(1);
    expect(f.results().at(-1)).toMatchObject({ status: "accepted", turnId: expect.any(String) });
    await f.deliver(command);
    expect(f.dispatches).toBe(1);
    expect(f.results()).toHaveLength(2);
  });

  it("keeps an unconfirmed native result unknown and refuses the next send", async () => {
    const f = await fixture();
    f.setSubmit(async (value) => ({ text: value.text }));
    await f.deliver({
      commandId: randomUUID(),
      kind: "send",
      requestId: randomUUID(),
      text: "unknown",
      expectedRevision: 0,
    });
    expect(f.results().at(-1)).toMatchObject({
      status: "unknown",
      reason: "native-turn-unconfirmed",
    });
    await f.deliver({
      commandId: randomUUID(),
      kind: "send",
      requestId: randomUUID(),
      text: "must not dispatch",
      expectedRevision: 0,
    });
    expect(f.results().at(-1)).toMatchObject({ status: "rejected", reason: "session-not-idle" });
    expect(f.dispatches).toBe(1);
  });

  it("resends a lost exact receipt after reconnect without dispatching its action again", async () => {
    const f = await fixture();
    let fail = true;
    f.setHttpInterceptor(async (url) => {
      if (url.endsWith("/results") && fail) {
        fail = false;
        throw new Error("lost reply");
      }
    });
    const command = {
      commandId: randomUUID(),
      kind: "send",
      requestId: randomUUID(),
      text: "once",
      expectedRevision: 0,
    };
    await f.deliver(command);
    expect(f.dispatches).toBe(1);
    expect(f.results()).toHaveLength(1);
    await f.tick();
    expect(f.results()).toHaveLength(2);
    expect(f.results()[1]).toMatchObject({
      commandId: command.commandId,
      status: "accepted",
      turnId: f.results()[0].turnId,
    });
    expect(f.dispatches).toBe(1);
    await f.tick();
    expect(f.results()).toHaveLength(2);
  });

  it.each([
    { status: 409, error: "bridge-lease-expired" },
    { status: 410, error: "bridge-source-unavailable" },
  ])("recovers from $error and respects an explicit revoke", async ({ status, error }) => {
    const f = await fixture();
    f.nextHttpResponse("/v1/commands", { status, body: { error } });
    await f.tick();
    await f.tick();
    expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(1);
    f.nextHttpResponse("/v1/commands", { status: 410, body: { error: "bridge-binding-revoked" } });
    await f.tick();
    expect((await f.run("command.run", { command: "agentkib-status", args: "" })).text).toContain(
      "This session was disconnected or cleared in AgentKib. Generate a new connection code",
    );
    await f.run("ui.render", { component: "AbovePrompt", props: { isWorking: false } });
    const connected = await f.run("command.run", { command: "agentkib-connect", args: f.ticket });
    expect(connected.text).toContain("connected to this");
    await f.tick();
    expect(f.snapshots().at(-1).capabilities.send).toBe(true);
    expect(f.dispatches).toBe(0);
  });

  it("does not acknowledge a queued or competing native prompt as this request", async () => {
    const f = await fixture();
    f.setSubmit(async (value) => {
      await f.run("session.append", {
        door: "queue",
        origin: { kind: "plugin", name: "agentkib-bridge" },
        message: { type: "user", content: [{ type: "text", text: value.text }] },
      });
      await f.run("turn.start", { text: value.text, turnId: randomUUID() });
      return { text: value.text };
    });
    await f.deliver({
      commandId: randomUUID(),
      kind: "send",
      requestId: randomUUID(),
      text: "contested",
      expectedRevision: 0,
    });
    expect(f.results().at(-1)).toMatchObject({
      status: "unknown",
      reason: "native-turn-unconfirmed",
    });
  });

  it("checks terminal activity and exact turn identity before native cancellation", async () => {
    const f = await fixture();
    const turnId = randomUUID();
    await f.run("turn.start", { text: "terminal input", turnId });
    await f.deliver({
      commandId: randomUUID(),
      kind: "send",
      requestId: randomUUID(),
      text: "no queue",
      expectedRevision: 1,
    });
    expect(f.dispatches).toBe(0);
    await f.deliver({
      commandId: randomUUID(),
      kind: "stop",
      turnId: randomUUID(),
      expectedRevision: 1,
    });
    expect(f.stops).toBe(0);
    await f.deliver({ commandId: randomUUID(), kind: "stop", turnId, expectedRevision: 1 });
    expect(f.stops).toBe(1);
    expect(f.results().at(-1)).toMatchObject({ status: "accepted", turnId });
  });

  describe("native terminal exit for handover", () => {
    function exitAdapter(api: Value) {
      api.command.list = vi.fn(async () => [{ name: "exit", source: "builtin" }]);
      api.command.run = vi.fn(async () => ({ text: "Exiting" }));
      api.session.surfaces = vi.fn(async () => ["terminal"]);
      api.clock.after = vi.fn();
    }

    it("uses the native command only after the matching turn has stopped, with one invocation on replay", async () => {
      const waiting = deferred<void>();
      const stopped = deferred<void>();
      const f = await fixture({
        features: ["terminal-handover"],
        configure: exitAdapter,
        sleep(ms) {
          if (ms !== 50) return Promise.resolve();
          waiting.resolve();
          return stopped.promise;
        },
      });
      const turnId = randomUUID();
      await f.run("turn.start", { text: "terminal input", turnId });
      await f.flush();
      const snapshot = f.snapshots().at(-1);
      expect(snapshot.capabilities.handover).toBe(true);
      const command = {
        commandId: randomUUID(),
        kind: "handover-exit",
        turnId,
        expectedRevision: snapshot.revision,
      };
      const receipt = f.deliver(command);
      await waiting.promise;
      expect(f.stops).toBe(1);
      expect(f.api.command.run).not.toHaveBeenCalled();
      await f.flush();
      expect(f.snapshots().at(-1).capabilities).toMatchObject({
        queue: false,
        send: false,
        stop: false,
      });
      await f.run("turn.complete", { turnId, isAborted: true });
      stopped.resolve();
      await receipt;
      expect(f.api.command.run).toHaveBeenCalledExactlyOnceWith({ command: "exit" });
      expect(f.dispatches).toBe(0);
      const result = f.results().at(-1);
      expect(result).toMatchObject({ commandId: command.commandId, status: "exit-initiated" });
      await f.deliver(command);
      expect(f.results().at(-1)).toEqual(result);
      expect(f.stops).toBe(1);
      expect(f.api.command.run).toHaveBeenCalledOnce();
    });

    it("leaves a new native turn running when it competes with exit", async () => {
      const abortStarted = deferred<void>();
      const resume = deferred<void>();
      const f = await fixture({ features: ["terminal-handover"], configure: exitAdapter });
      f.api.turn.abort = vi.fn(() => {
        abortStarted.resolve();
        return resume.promise;
      });
      const turnId = randomUUID();
      await f.run("turn.start", { text: "old turn", turnId });
      const receipt = f.deliver({
        commandId: randomUUID(),
        kind: "handover-exit",
        turnId,
        expectedRevision: 1,
      });
      await abortStarted.promise;
      const newTurn = randomUUID();
      await f.run("turn.start", { text: "new turn", turnId: newTurn });
      resume.resolve();
      await receipt;
      expect(f.api.turn.abort).toHaveBeenCalledExactlyOnceWith({ turnId });
      expect(f.api.command.run).not.toHaveBeenCalled();
      expect(f.results().at(-1)).toMatchObject({
        status: "unknown",
        reason: "native-stop-unconfirmed",
      });
      expect(f.snapshots().at(-1).currentTurnId).toBe(newTurn);
    });

    it("requires a matched turn and protects unsent queued submissions", async () => {
      const f = await fixture({ features: ["terminal-handover"], configure: exitAdapter });
      const turnId = randomUUID();
      await f.run("turn.start", { text: "terminal input", turnId });
      const exit = (id: string) =>
        f.deliver({
          commandId: randomUUID(),
          kind: "handover-exit",
          turnId: id,
          expectedRevision: 1,
        });
      await exit(randomUUID());
      expect(f.results().at(-1)).toMatchObject({ status: "rejected", reason: "turn-conflict" });
      await f.deliver({
        commandId: randomUUID(),
        kind: "queue",
        requestId: randomUUID(),
        text: "Keep this draft",
      });
      await exit(turnId);
      expect(f.results().at(-1)).toMatchObject({
        status: "rejected",
        reason: "session-state-unverified",
      });
      expect(f.snapshots().at(-1)).toMatchObject({
        outbox: [expect.objectContaining({ text: "Keep this draft" })],
      });
      expect(f.snapshots().at(-1).capabilities).not.toHaveProperty("handover");
      expect(f.stops).toBe(0);
      expect(f.api.command.run).not.toHaveBeenCalled();
    });

    it.each(["legacy-runtime", "missing-native-api", "nonterminal", "untrusted-command"])(
      "preserves normal operation when an exit prerequisite is absent (%s)",
      async (missing) => {
        const f = await fixture({
          features: missing === "legacy-runtime" ? [] : ["terminal-handover"],
          configure(api) {
            exitAdapter(api);
            if (missing === "missing-native-api") delete api.session.surfaces;
            if (missing === "nonterminal") api.session.surfaces = async () => ["web"];
            if (missing === "untrusted-command")
              api.command.list = async () => [{ name: "exit", source: "plugin" }];
          },
        });
        expect(f.snapshots().at(-1).capabilities).not.toHaveProperty("handover");
        await f.deliver({
          commandId: randomUUID(),
          kind: "handover-exit",
          expectedRevision: 0,
        });
        expect(f.results().at(-1)).toMatchObject({ status: "rejected" });
        expect(f.api.command.run).not.toHaveBeenCalled();
        expect(f.snapshots().at(-1).capabilities.send).toBe(true);
      },
    );

    it("invokes native exit without aborting a verified idle terminal", async () => {
      const f = await fixture({ features: ["terminal-handover"], configure: exitAdapter });
      expect(f.snapshots().at(-1).capabilities.handover).toBe(true);
      await f.deliver({ commandId: randomUUID(), kind: "handover-exit", expectedRevision: 0 });
      expect(f.stops).toBe(0);
      expect(f.api.command.run).toHaveBeenCalledExactlyOnceWith({ command: "exit" });
      expect(f.results().at(-1)).toMatchObject({ status: "exit-initiated" });
    });

    it("keeps a failed native exit invocation unknown without retrying it", async () => {
      const f = await fixture({ features: ["terminal-handover"], configure: exitAdapter });
      f.api.command.run.mockRejectedValue(new Error("native exit failed"));
      const command = { commandId: randomUUID(), kind: "handover-exit", expectedRevision: 0 };
      await f.deliver(command);
      const result = f.results().at(-1);
      expect(result).toMatchObject({ status: "unknown", reason: "native-exit-unconfirmed" });
      await f.deliver(command);
      expect(f.results().at(-1)).toEqual(result);
      expect(f.stops).toBe(0);
      expect(f.api.command.run).toHaveBeenCalledExactlyOnceWith({ command: "exit" });
    });
  });

  it("cancels a streaming turn once even when text advances before command execution", async () => {
    const f = await fixture();
    const turnId = randomUUID();
    await f.run("turn.start", { text: "terminal input", turnId });
    await f.flush();
    const revision = f.snapshots().at(-1).revision;
    const command = { commandId: randomUUID(), kind: "stop", turnId, expectedRevision: revision };
    f.setHttpInterceptor(async (url) => {
      if (url.endsWith("/commands"))
        await collectStream(
          f.stream(turnId, [
            { kind: "text", text: "first delta" },
            { kind: "text", text: "second delta" },
          ]),
        );
    });
    await f.deliver(command);
    const accepted = f.results().at(-1);
    expect(accepted).toMatchObject({ status: "accepted", turnId, revision });
    expect(f.stops).toBe(1);
    await f.deliver(command);
    expect(f.results().at(-1)).toEqual(accepted);
    expect(f.stops).toBe(1);
  });

  it("forwards native chunks and results unchanged, excluding thinking from the bridge", async () => {
    const f = await fixture();
    const turnId = randomUUID();
    await f.run("turn.start", { text: "terminal input", turnId });
    const chunks = [
      { kind: "thinking", text: "private reasoning" },
      { kind: "text", text: "visible reply" },
    ];
    const result = { answer: "visible reply", turnId, index: 0, toolUses: [] };
    const stream = f.run("turn.step", { turnId, index: 0 }, async function* () {
      yield* chunks;
      return result;
    });
    const observed = [];
    let item = await stream.next();
    while (!item.done) {
      observed.push(item.value);
      item = await stream.next();
    }
    expect(observed).toEqual(chunks);
    expect(item.value).toBe(result);
    await f.tick();
    expect(JSON.stringify(f.calls)).toContain("visible reply");
    expect(JSON.stringify(f.calls)).not.toContain("private reasoning");
  });

  it.each(["unpaired", "disconnected"] as const)(
    "does no bridge UTF-8 work on a long %s native stream",
    async (state) => {
      const f = await fixture({ connect: state !== "unpaired" });
      if (state === "disconnected") await f.run("session.end", { reason: "exit" });
      const turnId = randomUUID();
      await f.run("turn.start", { text: "native terminal", turnId });
      const chunks = [
        { kind: "text", text: "x".repeat(STREAM_BUDGET) },
        ...Array.from({ length: 64 }, () => ({ kind: "text", text: "word" })),
      ];
      const nativeResult = { answer: "native result", turnId };
      const callsBeforeStream = f.calls.length;
      const meter = measureUtf8Work();
      try {
        const observed = await collectStream(f.stream(turnId, chunks, nativeResult));
        const work = meter.checkpoint();
        expect(observed.result).toBe(nativeResult);
        expect(observed.chunks).toHaveLength(chunks.length);
        for (const [index, chunk] of chunks.entries()) expect(observed.chunks[index]).toBe(chunk);
        expect(work).toEqual({ calls: 0, readUnits: 0, capacity: 0, charCodeAtCalls: 0 });
        expect(f.calls).toHaveLength(callsBeforeStream);
      } finally {
        meter.restore();
      }
    },
  );

  it("bounds real turn-step encoding work and stops rescanning a saturated preview", async () => {
    const f = await fixture();
    const turnId = randomUUID();
    await f.run("turn.start", { text: "native terminal", turnId });
    const seed = { kind: "text", text: "x".repeat(STREAM_BUDGET) };
    const overflow = { kind: "text", text: "word" };
    const tail = Array.from({ length: 64 }, () => ({ kind: "text", text: "word" }));
    const nativeResult = { answer: "native final result", turnId };
    const meter = measureUtf8Work();
    try {
      const first = await collectStream(f.stream(turnId, [seed, overflow], nativeResult));
      const firstWork = meter.checkpoint();
      expect(first.chunks[0]).toBe(seed);
      expect(first.chunks[1]).toBe(overflow);
      expect(first.result).toBe(nativeResult);
      // Count both encoder work and pure JS UTF-8 scans. Several bounded passes
      // fit these limits; per-code-point encoder allocation or repeated full
      // prefix scans do not. Capture before assertions to exclude matcher work.
      expect(firstWork.calls + firstWork.charCodeAtCalls).toBeGreaterThan(0);
      expect(firstWork.calls).toBeLessThanOrEqual(16);
      expect(firstWork.readUnits).toBeLessThanOrEqual(STREAM_BUDGET * 8);
      expect(firstWork.capacity).toBeLessThanOrEqual(STREAM_BUDGET * 8);
      expect(firstWork.charCodeAtCalls).toBeLessThanOrEqual(STREAM_BUDGET * 8);
      meter.reset();
      const observed = await collectStream(f.stream(turnId, tail, nativeResult));
      const tailWork = meter.checkpoint();
      expect(observed.result).toBe(nativeResult);
      for (const [index, chunk] of tail.entries()) expect(observed.chunks[index]).toBe(chunk);
      const incomingUnits = tail.reduce((total, chunk) => total + chunk.text.length, 0);
      expect(tailWork.calls).toBeLessThanOrEqual(tail.length * 4);
      expect(tailWork.readUnits).toBeLessThanOrEqual(incomingUnits * 4);
      expect(tailWork.capacity).toBeLessThanOrEqual(incomingUnits * 12);
      expect(tailWork.charCodeAtCalls).toBeLessThanOrEqual(incomingUnits * 2);
    } finally {
      meter.restore();
    }
    for (let index = 0; index < 4; index++) await f.flush();
    const preview = f.snapshots().at(-1).streamText;
    expect(preview).toBe(expectedUtf8Preview(seed.text + overflow.text, STREAM_BUDGET));
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(STREAM_BUDGET);
    expect(preview.endsWith(PREVIEW_END)).toBe(true);
    expect(f.events().filter((entry) => entry.event.type === "text")).toHaveLength(66);
  });

  it("keeps Unicode and a split surrogate exact through the UTF-8 stream limit", async () => {
    const f = await fixture();
    const turnId = randomUUID();
    await f.run("turn.start", { text: "native terminal", turnId });
    const prefix = "🙂汉éA".repeat((STREAM_BUDGET - 4) / 10);
    const chunks = [
      { kind: "text", text: prefix },
      { kind: "text", text: "\ud83d" },
      { kind: "text", text: "\ude42" },
    ];
    const nativeResult = { answer: prefix + "🙂", turnId };
    const observed = await collectStream(f.stream(turnId, chunks, nativeResult));
    for (const [index, chunk] of chunks.entries()) expect(observed.chunks[index]).toBe(chunk);
    expect(observed.result).toBe(nativeResult);
    await f.flush();
    expect(Buffer.byteLength(nativeResult.answer)).toBe(STREAM_BUDGET);
    expect(f.snapshots().at(-1).streamText).toBe(nativeResult.answer);
    const overflow = { kind: "text", text: "汉🙂é" };
    const overLimit = await collectStream(f.stream(turnId, [overflow], nativeResult));
    expect(overLimit.chunks[0]).toBe(overflow);
    expect(overLimit.result).toBe(nativeResult);
    await f.run("session.append", {});
    await f.flush();
    const preview = f.snapshots().at(-1).streamText;
    expect(preview).toBe(expectedUtf8Preview(nativeResult.answer + overflow.text, STREAM_BUDGET));
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(STREAM_BUDGET);
    expect(preview.endsWith(PREVIEW_END)).toBe(true);
    expect(preview).not.toContain("\ufffd");
    expect(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(preview))).toBe(preview);
  });

  it.each(["allow", "deny", "unknown", "throw"] as const)(
    "observes nested permission %s without changing native inputs, decisions or errors",
    async (outcome) => {
      const f = await fixture();
      const turnId = randomUUID();
      await f.run("turn.start", { text: "terminal", turnId });
      const toolId = randomUUID();
      const toolEvent = { tool: "Bash", tool_use_id: toolId, command: "long native command" };
      const permissionEvent = {
        tool_name: "Bash",
        tool_input: { command: "long native command" },
      };
      const decision =
        outcome === "allow" || outcome === "deny" ? { decision: { behavior: outcome } } : {};
      const failure = new Error("native permission failed");
      const permissionGate = deferred<void>();
      const permissionReturned = deferred<void>();
      const toolGate = deferred<void>();
      let originalDecision: unknown;
      let originalError: unknown;
      const nativeResult = { content: [{ type: "text", text: "native tool output" }] };
      const tool = f.run("tool.call", toolEvent, async (value) => {
        expect(value).toBe(toolEvent);
        try {
          originalDecision = await f.run(
            "classic.PermissionRequest",
            permissionEvent,
            async (permission) => {
              expect(permission).toBe(permissionEvent);
              await permissionGate.promise;
              if (outcome === "throw") throw failure;
              return decision;
            },
          );
        } catch (error) {
          originalError = error;
        }
        permissionReturned.resolve();
        await toolGate.promise;
        return nativeResult;
      });
      await f.flush();
      expect(f.snapshots().at(-1)).toMatchObject({ status: "waiting", waiting: "permission" });
      permissionGate.resolve();
      await permissionReturned.promise;
      await f.flush();
      expect(f.snapshots().at(-1)).toMatchObject({
        status: "running",
        waiting: outcome === "allow" || outcome === "deny" ? null : "unknown",
        currentTurnId: turnId,
      });
      if (outcome === "throw") expect(originalError).toBe(failure);
      else expect(originalDecision).toBe(decision);
      await f.run("ui.render", {
        component: "ToolProgress",
        props: { kind: "background_hint", tool_use_id: randomUUID() },
      });
      await f.flush();
      expect(f.snapshots().at(-1).waiting).toBe(
        outcome === "allow" || outcome === "deny" ? null : "unknown",
      );
      await f.run("ui.render", {
        component: "ToolProgress",
        props: { kind: "background_hint", tool_use_id: toolId },
      });
      await f.flush();
      expect(f.snapshots().at(-1)).toMatchObject({ status: "running", waiting: null });
      toolGate.resolve();
      expect(await tool).toBe(nativeResult);
      await f.flush();
      expect(f.events().filter((entry) => entry.event.type === "tool-start")).toHaveLength(1);
      expect(f.events().filter((entry) => entry.event.type === "tool-complete")).toHaveLength(1);
      expect(f.snapshots().at(-1)).toMatchObject({ status: "running", waiting: null });
    },
  );

  it("keeps each unresolved permission tied to its own active tool", async () => {
    const f = await fixture();
    await f.run("turn.start", { text: "terminal", turnId: randomUUID() });
    const ids = [randomUUID(), randomUUID()];
    const returned = [deferred<void>(), deferred<void>()];
    const gates = [deferred<void>(), deferred<void>()];
    const tools = ids.map((id, index) =>
      f.run(
        "tool.call",
        { tool: "Bash", tool_use_id: id, command: `native command ${index}` },
        async () => {
          await f.run("classic.PermissionRequest", {
            tool_name: "Bash",
            tool_input: { command: `native command ${index}` },
          });
          returned[index].resolve();
          await gates[index].promise;
          return { native: index };
        },
      ),
    );
    await Promise.all(returned.map((row) => row.promise));
    await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({ status: "running", waiting: "unknown" });
    await f.run("ui.render", {
      component: "ToolProgress",
      props: { kind: "background_hint", tool_use_id: ids[0] },
    });
    gates[0].resolve();
    await tools[0];
    await f.flush();
    expect(f.snapshots().at(-1).waiting).toBe("unknown");
    await f.run("ui.render", {
      component: "ToolProgress",
      props: { kind: "background_hint", tool_use_id: ids[1] },
    });
    await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({ status: "running", waiting: null });
    gates[1].resolve();
    await tools[1];
  });

  // sec-default (managed settings, Team or Enterprise login) skips the classic hook, so an ask is
  // seen only as the tool.check verdict. Event fields follow the 2.1.311 type declarations.
  it.each(["completes", "progress", "turn-ends"] as const)(
    "notices an ask from tool.check without the classic hook, until the tool %s",
    async (end) => {
      const f = await fixture();
      const turnId = randomUUID();
      await f.run("turn.start", { text: "terminal", turnId });
      const toolId = randomUUID();
      const verdict = { decision: "ask", reason: "Bash commands need approval" };
      const check = {
        tool: "Bash",
        input: { command: "npm publish" },
        tool_use_id: toolId,
        approver: "person",
      };
      const toolGate = deferred<void>();
      const checked = deferred<void>();
      let returned: unknown;
      const nativeResult = { content: [{ type: "text", text: "native tool output" }] };
      const tool = f.run("tool.call", { tool: "Bash", tool_use_id: toolId }, async () => {
        returned = await f.run("tool.check", check, (value) => {
          expect(value).toBe(check);
          return verdict;
        });
        checked.resolve();
        await toolGate.promise;
        return nativeResult;
      });
      await checked.promise;
      await f.flush();
      expect(returned).toBe(verdict);
      expect(f.snapshots().at(-1)).toMatchObject({ status: "running", waiting: "unknown" });
      if (end === "progress") {
        await f.run("ui.render", {
          component: "ToolProgress",
          props: { kind: "background_hint", tool_use_id: toolId },
        });
        await f.flush();
        expect(f.snapshots().at(-1).waiting).toBeNull();
      }
      if (end === "turn-ends") {
        await f.run("turn.complete", { turnId, answer: "done" });
        await f.flush();
        expect(f.snapshots().at(-1)).toMatchObject({ status: "idle", waiting: null });
      }
      toolGate.resolve();
      expect(await tool).toBe(nativeResult);
      await f.flush();
      expect(f.snapshots().at(-1).waiting).toBeNull();
    },
  );

  it("leaves verdicts nobody in the terminal answers alone", async () => {
    const f = await fixture();
    await f.run("turn.start", { text: "terminal", turnId: randomUUID() });
    const cases: Array<[Value, Value]> = [
      [{}, { decision: "allow" }],
      [{}, { decision: "deny", reason: "rule" }],
      [{ approver: "host" }, { decision: "ask" }],
      [{ agentId: "agent-1" }, { decision: "ask" }],
      // A $.tool.check query carries no call.
      [{ tool_use_id: undefined }, { decision: "ask" }],
      // A call the plugin does not follow.
      [{ tool_use_id: randomUUID() }, { decision: "ask" }],
    ];
    for (const [patch, verdict] of cases) {
      const toolId = randomUUID();
      const gate = deferred<void>();
      const checked = deferred<void>();
      const tool = f.run("tool.call", { tool: "Bash", tool_use_id: toolId }, async () => {
        const result = await f.run(
          "tool.check",
          { tool: "Bash", input: { command: "ls" }, tool_use_id: toolId, ...patch },
          () => verdict,
        );
        expect(result).toBe(verdict);
        checked.resolve();
        await gate.promise;
        return {};
      });
      await checked.promise;
      await f.flush();
      expect(f.snapshots().at(-1).waiting).toBeNull();
      gate.resolve();
      await tool;
    }
  });

  it.each([true, false])(
    "publishes only negotiated, native-confirmed approval evidence (negotiated: %s)",
    async (negotiated) => {
      const f = await fixture({
        features: negotiated ? ["terminal-approval-observation"] : [],
      });
      const turnId = randomUUID();
      await f.run("turn.start", { text: "terminal", turnId });
      const toolId = randomUUID();
      const check = {
        tool: "Edit",
        tool_use_id: toolId,
        approver: "person",
        input: {
          file_path: "notes.md",
          old_string: "Draft",
          new_string: "Published",
          context: { access_token: "synthetic-not-a-credential", area: "notes" },
        },
      };
      const call = { tool: "Edit", tool_use_id: toolId, file_path: "unmodified-input.md" };
      const ask = { decision: "ask", reason: "native rule" };
      const output = { content: [{ type: "text", text: "unchanged result" }] };
      const checked = deferred<void>();
      const finishTool = deferred<void>();
      const nextCheck = vi.fn((event) => {
        expect(event).toBe(check);
        return ask;
      });
      const nextCall = vi.fn(async (event) => {
        expect(event).toBe(call);
        expect(await f.run("tool.check", check, nextCheck)).toBe(ask);
        checked.resolve();
        await finishTool.promise;
        return output;
      });
      const running = f.run("tool.call", call, nextCall);
      await checked.promise;
      await f.flush();
      expect(f.snapshots().at(-1)).not.toHaveProperty("pendingApprovalDetails");
      const notification = { notification_type: "permission_prompt", session_id: f.nativeId };
      await f.run("classic.Notification", { ...notification, session_id: randomUUID() });
      await f.run("classic.Notification", { ...notification, agent_id: randomUUID() });
      await f.flush();
      expect(f.snapshots().at(-1)).not.toHaveProperty("pendingApprovalDetails");
      expect(await f.run("classic.Notification", notification)).toBe(notification);
      await f.flush();
      if (negotiated)
        expect(f.snapshots().at(-1)).toMatchObject({
          status: "waiting",
          waiting: "permission",
          pendingApprovalDetails: {
            toolName: "Edit",
            toolUseId: toolId,
            turnId,
            input: {
              file_path: "notes.md",
              old_string: "Draft",
              new_string: "Published",
              context: { access_token: "[REDACTED]", area: "notes" },
            },
          },
          capabilities: { approve: false, answer: false },
        });
      else {
        expect(f.snapshots().at(-1).waiting).toBe("unknown");
        expect(f.snapshots().at(-1)).not.toHaveProperty("pendingApprovalDetails");
      }
      finishTool.resolve();
      expect(await running).toBe(output);
      await f.flush();
      expect(f.snapshots().at(-1)).not.toHaveProperty("pendingApprovalDetails");
      expect(nextCall).toHaveBeenCalledOnce();
      expect(nextCheck).toHaveBeenCalledOnce();
    },
  );

  it("does not guess which concurrent tool owns an unbound notification", async () => {
    const f = await fixture({ features: ["terminal-approval-observation"] });
    const turnId = randomUUID();
    await f.run("turn.start", { text: "terminal", turnId });
    const finishTools = deferred<void>();
    const ready = [deferred<void>(), deferred<void>()];
    const running = ready.map((toolReady, i) => {
      const id = randomUUID();
      return f.run("tool.call", { tool: "Bash", tool_use_id: id }, async () => {
        await f.run(
          "tool.check",
          { tool: "Bash", input: { command: `echo ${i}` }, tool_use_id: id, approver: "person" },
          () => ({ decision: "ask" }),
        );
        toolReady.resolve();
        await finishTools.promise;
        return {};
      });
    });
    await Promise.all(ready.map(({ promise }) => promise));
    await f.run("classic.Notification", {
      notification_type: "permission_prompt",
      session_id: f.nativeId,
    });
    await f.flush();
    expect(f.snapshots().at(-1)).not.toHaveProperty("pendingApprovalDetails");
    finishTools.resolve();
    await Promise.all(running);
  });

  it("bounds question summaries, hides recognizable credentials and clears summaries with the tool", async () => {
    const f = await fixture({ features: ["terminal-approval-observation"] });
    await f.run("turn.start", { text: "terminal", turnId: randomUUID() });
    for (const [question, hidden] of [
      ["Choose an option ".repeat(30), false],
      ["Where should I send Authorization: synthetic test value?", true],
    ] as const) {
      const toolId = randomUUID();
      const finish = deferred<void>();
      const running = f.run(
        "tool.call",
        { tool: "AskUserQuestion", tool_use_id: toolId, questions: [{ question }] },
        async () => {
          await finish.promise;
          return {};
        },
      );
      await f.flush();
      const snapshot = f.snapshots().at(-1);
      expect(snapshot.waiting).toBe("question");
      if (hidden) expect(snapshot).not.toHaveProperty("pendingQuestionSummary");
      else {
        expect(snapshot.pendingQuestionSummary).toContain("Choose an option");
        expect(Buffer.byteLength(snapshot.pendingQuestionSummary)).toBeLessThanOrEqual(256);
      }
      finish.resolve();
      await running;
      await f.flush();
      expect(f.snapshots().at(-1)).not.toHaveProperty("pendingQuestionSummary");
    }
  });

  it("passes a failing check through unchanged and marks nothing", async () => {
    const f = await fixture();
    await f.run("turn.start", { text: "terminal", turnId: randomUUID() });
    const toolId = randomUUID();
    const failure = new Error("native check failed");
    let caught: unknown;
    await f.run("tool.call", { tool: "Bash", tool_use_id: toolId }, async () => {
      try {
        await f.run(
          "tool.check",
          { tool: "Bash", input: {}, tool_use_id: toolId, approver: "person" },
          () => {
            throw failure;
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(f.snapshots().at(-1)?.waiting ?? null).toBeNull();
      return {};
    });
    await f.flush();
    expect(caught).toBe(failure);
    expect(f.snapshots().at(-1).waiting).toBeNull();
  });

  it("does not clear a pending native question when an unrelated tool progresses or completes", async () => {
    const f = await fixture();
    await f.run("turn.start", { text: "terminal", turnId: randomUUID() });
    const questionId = randomUUID();
    const questionGate = deferred<void>();
    const nativeAnswer = { answers: { choice: "Alpha" } };
    const question = f.run(
      "tool.call",
      { tool: "AskUserQuestion", tool_use_id: questionId, questions: [{ question: "Choose" }] },
      async () => {
        await questionGate.promise;
        return nativeAnswer;
      },
    );
    await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({ status: "waiting", waiting: "question" });
    const toolId = randomUUID();
    const gate = deferred<void>();
    const permissionReturned = deferred<void>();
    const tool = f.run(
      "tool.call",
      { tool: "Bash", tool_use_id: toolId, command: "other native tool" },
      async () => {
        await f.run(
          "classic.PermissionRequest",
          { tool_name: "Bash", tool_input: { command: "other native tool" } },
          () => ({ decision: { behavior: "allow" } }),
        );
        permissionReturned.resolve();
        await gate.promise;
        return { native: "other result" };
      },
    );
    await permissionReturned.promise;
    await f.run("ui.render", {
      component: "ToolProgress",
      props: { kind: "background_hint", tool_use_id: toolId },
    });
    await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({ status: "waiting", waiting: "question" });
    gate.resolve();
    await tool;
    await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({ status: "waiting", waiting: "question" });
    questionGate.resolve();
    expect(await question).toBe(nativeAnswer);
    await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({ status: "running", waiting: null });
  });

  it("preserves native tool exceptions and clears only the failed tool's waiting record", async () => {
    const f = await fixture();
    await f.run("turn.start", { text: "terminal", turnId: randomUUID() });
    const questionGate = deferred<void>();
    const question = f.run(
      "tool.call",
      { tool: "AskUserQuestion", tool_use_id: randomUUID(), questions: [] },
      async () => {
        await questionGate.promise;
        return { native: "answer" };
      },
    );
    const failure = new Error("native tool failed");
    // The fixture invokes hook bodies directly; native catch dispatch is not
    // emulated. This checks the original downstream exception and finally path.
    await expect(
      f.run("tool.call", { tool: "Bash", tool_use_id: randomUUID(), command: "throws" }, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({ status: "waiting", waiting: "question" });
    questionGate.resolve();
    await question;
    await f.flush();
    expect(f.snapshots().at(-1)).toMatchObject({ status: "running", waiting: null });
  });

  it("forwards stream return and throw so cancellation closes the native generator", async () => {
    let closed = 0;
    const caught: unknown[] = [];
    const source = async function* () {
      try {
        try {
          yield { kind: "text", text: "first" };
        } catch (error) {
          caught.push(error);
          yield { kind: "text", text: "recovered" };
        }
        return "native-final";
      } finally {
        closed++;
      }
    };
    const stream = observeNativeStream(source(), () => undefined);
    await stream.next();
    const failure = new Error("outer stopped");
    expect(await stream.throw(failure)).toMatchObject({
      done: false,
      value: { text: "recovered" },
    });
    expect(caught).toEqual([failure]);
    expect(await stream.next()).toEqual({ done: true, value: "native-final" });
    const cancelled = observeNativeStream(source(), () => undefined);
    await cancelled.next();
    await cancelled.return("cancelled");
    expect(closed).toBe(2);
  });

  it("invalidates old cached state immediately on session end and identity change", async () => {
    for (const action of ["end", "identity"] as const) {
      const f = await fixture();
      if (action === "end") await f.run("session.end", { reason: "resume" });
      else {
        f.setIdentity({ cwd: "/other/workspace" });
        await f.tick();
      }
      const events = f.calls
        .filter((call) => call.url.endsWith("/events"))
        .flatMap((call) => call.body.events);
      expect(events.at(-1).event.type).toBe("invalidated");
      expect(events.at(-2).event.snapshot).toMatchObject({
        status: "disconnected",
        messages: [],
        streamText: "",
        capabilities: { read: false, send: false },
      });
      const status = await f.run("command.run", { command: "agentkib-status", args: "" });
      expect(status.text).toContain("not connected");
    }
  });

  it("does not block the original terminal lifecycle on an unresolved invalidation notification", async () => {
    const f = await fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.setHttpInterceptor(async (url) => {
      if (url.endsWith("/events")) await held;
    });
    let nativeEnds = 0;
    const end = f.run("session.end", { reason: "resume" }, () => {
      nativeEnds++;
      return { ended: true };
    });
    expect(nativeEnds).toBe(1);
    await expect(end).resolves.toEqual({ ended: true });
    const status = await f.run("command.run", { command: "agentkib-status", args: "" });
    expect(status.text).toContain("not connected");
    release();
  });

  it("bounds escaped history bodies and marks clipped text as a preview", async () => {
    const f = await fixture();
    f.setMessages(
      Array.from({ length: 80 }, () => ({ role: "assistant", text: "\u0000".repeat(100_000) })),
    );
    await f.run("session.append", {});
    await f.tick();
    const calls = f.calls.filter((call) => call.url.endsWith("/events"));
    expect(calls.every((call) => Buffer.byteLength(call.init.body) <= 1024 * 1024)).toBe(true);
    expect(f.snapshots().at(-1).messages.at(-1).text).toContain("preview truncated");
  });
});
