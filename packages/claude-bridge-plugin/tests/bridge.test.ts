import { expect, test } from "claude-code/testing";
import {
  initialState,
  previewText,
  probeCapabilities,
  register,
  safeSocket,
  validSend,
} from "../hooks/register.js";

test("validates literal sends and private Unix socket paths without executing a model", async () => {
  expect(safeSocket("/private/tmp/agentkib/bridge.sock")).toBe(true);
  expect(safeSocket("/private/tmp/../other.sock")).toBe(false);
  expect(validSend({ requestId: "request", text: "a normal prompt" })).toBe(true);
  expect(validSend({ requestId: "request", text: "/logout" })).toBe(false);
  expect(previewText("a".repeat(1000), 128)).toContain("preview truncated");
});

test("connection status never calls a model or installs configuration", async ($) => {
  const result = await $.command.run({ command: "agentkib-status", args: "" });
  expect(result.text).toBe(
    "AgentKib bridge is not connected. Check the terminal connection in AgentKib or generate a new connection code.",
  );
});

test("native permission and tool results pass through unchanged", async ($, on) => {
  on("tool.call", () => ({ result: "native tool response" }));
  on("classic.PermissionRequest", () => ({}));
  const tool = await $.tool.call({ tool: "Read", file_path: "/synthetic/fixture.txt" });
  expect(tool).toEqual({ result: "native tool response" });
  const permission = await $.classic.PermissionRequest({
    tool_name: "Bash",
    tool_input: { command: "echo fixture" },
  });
  expect(permission).toEqual({});
});

test("a native tool.check verdict passes through unchanged", async ($, on) => {
  on("tool.check", () => ({ decision: "ask", reason: "fixture rule" }));
  const verdict = await $.tool.check({ tool: "Bash", input: { command: "echo fixture" } });
  expect(verdict).toMatchObject({ decision: "ask", reason: "fixture rule" });
});

test("the native stream and final result pass through unchanged", async ($, on) => {
  on("turn.step", async function* (_$, e) {
    yield { kind: "text", index: 0, text: "fixture answer" };
    return {
      turnId: e.turnId,
      index: e.index,
      answer: "fixture answer",
      toolUses: [],
      stopReason: "end_turn",
      usage: null,
    };
  });
  const stream = $.turn.step({ turnId: "turn", index: 0, model: "fixture", messageCount: 1 });
  const first = await stream.next();
  expect(first.value).toEqual({ kind: "text", index: 0, text: "fixture answer" });
  const final = await stream.next();
  expect(final.done).toBe(true);
  expect(final.value.answer).toBe("fixture answer");
});

async function connectedBridgeFixture(
  features: string[] = [],
  previous?: {
    nativeId: string;
    receipts: Map<string, unknown>;
    messages: Array<{ role: string; text: string }>;
  },
) {
  type Value = Record<string, any>;
  type Hook = (api: Value, event: Value, next: (event: Value) => any) => any;
  const hooks = new Map<string, Array<{ match: Value; hook: Hook }>>();
  const timers: Array<() => Promise<void>> = [];
  const snapshots: Value[] = [];
  register((name: string, matcher: Value | Hook, handler?: Hook) => {
    const match = typeof matcher === "function" ? {} : matcher;
    const hook = typeof matcher === "function" ? matcher : handler!;
    hooks.set(name, [...(hooks.get(name) ?? []), { match, hook }]);
    return { catch: () => undefined };
  });
  const nativeId = previous?.nativeId ?? crypto.randomUUID();
  const connection = {
    protocol: 1,
    features,
    bindingId: crypto.randomUUID(),
    leaseId: crypto.randomUUID(),
    token: "a".repeat(64),
    credentialPath: "/private/synthetic-credential.json",
  };
  // The API is local synthetic data; this exercises the production observer in
  // Claude's actual plugin JS engine without opening a socket or calling a model.
  const stored = new Map<string, unknown>();
  const receipts = previous?.receipts ?? new Map<string, unknown>();
  const messages = previous?.messages ?? [];
  const polls: Value[] = [];
  let failPoll = false;
  let reconnects = 0;
  let reports: Array<{ id: string; text: string }> = [];
  let submit = async (_text: string): Promise<Value> => ({});
  const api = {
    session: {
      id: async () => nativeId,
      cwd: async () => "/synthetic/workspace",
      root: async () => "/synthetic/workspace",
      version: async () => ({ version: "2.1.301" }),
      messages: async () => messages,
      usage: async () => null,
    },
    command: { register: async () => undefined },
    tool: { register: async () => undefined },
    ui: { log: async () => undefined },
    prompt: { submit: ({ text }: Value) => submit(text) },
    store: {
      get: async (key: string) => (key.startsWith("lead-report:1:") ? receipts : stored).get(key),
      set: async (key: string, value: unknown) => {
        (key.startsWith("lead-report:1:") ? receipts : stored).set(key, value);
      },
    },
    plugin: { root: "/synthetic/plugin" },
    fs: {
      read: async (path: string) =>
        JSON.stringify(
          path === connection.credentialPath
            ? {
                ...connection,
                nativeId,
                cwd: "/synthetic/workspace",
                cliVersion: "2.1.301",
                pluginVersion: "0.5.11",
                socketPath: "/private/synthetic.sock",
              }
            : { version: "0.4.0" },
        ),
    },
    clock: {
      every: (_ms: number, callback: () => Promise<void>) => timers.push(callback),
      sleep: async () => undefined,
    },
    http: {
      fetch: async (url: string, init: Value) => {
        // A liveness check; the Runtime refuses anything but POST.
        if (init.method === "GET") return { ok: false, status: 403, text: "{}" };
        const body = JSON.parse(init.body);
        if (url.endsWith("/commands")) {
          polls.push(body);
          if (failPoll) {
            failPoll = false;
            throw new Error("synthetic connection lost");
          }
          reports = reports.filter((report) => !body.takenReports?.includes(report.id));
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({
              commands: [],
              lead: {
                tools: [
                  {
                    name: "worker_list",
                    description: "List workers.",
                    inputSchema: { type: "object" },
                  },
                ],
                reports,
              },
            }),
          };
        }
        if (url.endsWith("/events"))
          snapshots.push(
            ...body.events
              .filter((entry: Value) => entry.event.type === "snapshot")
              .map((entry: Value) => entry.event.snapshot),
          );
        if (url.endsWith("/reconnect")) reconnects += 1;
        return {
          ok: true,
          status: 200,
          text: JSON.stringify(
            url.endsWith("/pair") || url.endsWith("/reconnect")
              ? connection
              : url.endsWith("/events")
                ? { ackSeq: body.events.at(-1).seq }
                : { commands: [] },
          ),
        };
      },
    },
  };
  const run = (name: string, event: Value, bottom: (value: Value) => any = (value) => value) => {
    const rows = (hooks.get(name) ?? []).filter(({ match }) =>
      Object.entries(match).every(([key, value]) => event[key] === value),
    );
    const visit = (index: number, value: Value): any =>
      index === rows.length
        ? bottom(value)
        : rows[index].hook(api, value, (next) => visit(index + 1, next));
    return visit(0, event);
  };
  await run("session.start", {});
  await run("ui.render", { component: "AbovePrompt", props: { isWorking: false } });
  const ticket = btoa(
    JSON.stringify({ protocol: 1, socketPath: "/private/synthetic.sock", ticket: "t".repeat(32) }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  await run("command.run", { command: "agentkib-connect", args: ticket });
  return {
    run,
    nativeId,
    snapshots,
    tick: timers[0],
    poll: timers[1],
    dispatch: timers[2],
    polls,
    receipts,
    messages,
    disconnectNextPoll() {
      failPoll = true;
    },
    reconnectCount() {
      return reconnects;
    },
    offer(values: typeof reports) {
      reports = values;
    },
    submit(fn: typeof submit) {
      submit = fn;
    },
  };
}

const RECEIPT_FEATURES = ["lead-tools", "lead-report-acks"];

async function nativeReportAppended(
  fixture: Awaited<ReturnType<typeof connectedBridgeFixture>>,
  text: string,
  uuid?: string,
) {
  await fixture.run("session.append", {
    door: "prompt",
    origin: { kind: "plugin", name: "agentkib-bridge", asUser: true },
    uuid,
    message: { type: "user", content: [{ type: "text", text }] },
  });
}

test("project report receipt follows native turn evidence even when submit loses its result", async () => {
  const fixture = await connectedBridgeFixture(RECEIPT_FEATURES);
  const report = { id: crypto.randomUUID(), text: "A worker completed the fixture" };
  const submitted: string[] = [];
  fixture.offer([report]);
  fixture.submit(async (text) => {
    submitted.push(text);
    await nativeReportAppended(fixture, text);
    throw new Error("synthetic lost submit result");
  });

  await fixture.poll();
  expect(fixture.polls.at(-1)?.reportAckIds).toEqual([]);
  expect(fixture.polls.at(-1)?.takenReports).toBeUndefined();
  await fixture.dispatch();
  await fixture.poll();
  await fixture.dispatch();
  expect(submitted.length).toBe(1);
  expect(fixture.polls.at(-1)?.reportAckIds).toEqual([]);

  const turnId = crypto.randomUUID();
  await fixture.run("turn.start", { turnId, text: submitted[0] });
  // The first native receipt is lost with the connection. Its retry carries
  // exactly the same ID after the next lease.
  fixture.disconnectNextPoll();
  await fixture.poll();
  expect(fixture.polls.at(-1)?.reportAckIds).toEqual([report.id]);
  expect(fixture.polls.at(-1)?.reportAckMessages).toBeUndefined();
  await fixture.poll();
  expect(fixture.reconnectCount()).toBe(1);
  expect(fixture.polls.at(-1)?.reportAckIds).toEqual([report.id]);
  expect([...fixture.receipts.values()]).toEqual(["delivered"]);

  // The host can offer an old ID again even after the plugin receives its own ACK.
  await fixture.run("turn.complete", { turnId, answer: "Fixture reply", reason: "answer" });
  await fixture.poll();
  await fixture.dispatch();
  expect(fixture.polls.at(-1)?.reportAckIds).toEqual([report.id]);
  expect(submitted.length).toBe(1);
});

test("acknowledges only the engine-stamped report message and retains its UUID on reload", async () => {
  const features = [...RECEIPT_FEATURES, "lead-report-message-ids"];
  const fixture = await connectedBridgeFixture(features);
  const report = { id: crypto.randomUUID(), text: "A synthetic worker report" };
  const messageId = crypto.randomUUID();
  fixture.offer([report]);
  fixture.submit(async (text) => {
    await nativeReportAppended(fixture, text, messageId);
    await fixture.run("session.append", {
      door: "prompt",
      origin: { kind: "composer" },
      uuid: crypto.randomUUID(),
      message: { type: "user", content: [{ type: "text", text }] },
    });
    return { text };
  });

  await fixture.poll();
  await fixture.dispatch();
  await fixture.poll();
  expect(fixture.polls.at(-1)?.reportAckMessages).toBeUndefined();

  await fixture.run("turn.start", {
    turnId: crypto.randomUUID(),
    text: `${report.text}\n\n[AgentKib report ID: ${report.id}]`,
  });
  await fixture.poll();
  expect(fixture.polls.at(-1)?.reportAckIds).toEqual([report.id]);
  expect(fixture.polls.at(-1)?.reportAckMessages).toEqual([{ reportId: report.id, messageId }]);

  const reloaded = await connectedBridgeFixture(features, fixture);
  reloaded.offer([report]);
  await reloaded.poll();
  await reloaded.poll();
  expect(reloaded.polls.at(-1)?.reportAckMessages).toEqual([{ reportId: report.id, messageId }]);
});

test("reloading the terminal plugin reconciles a claimed report without submitting it twice", async () => {
  const original = await connectedBridgeFixture(RECEIPT_FEATURES);
  const report = { id: crypto.randomUUID(), text: "A report with reusable wording" };
  let nativeText = "";
  original.offer([report]);
  original.submit(async (text) => {
    nativeText = text;
    throw new Error("synthetic crash after native dispatch");
  });
  await original.poll();
  await original.dispatch();
  expect([...original.receipts.values()]).toEqual(["submitting"]);

  // A new instance shares native history and the existing plugin store only.
  // An assistant response to identical wording without the marker proves nothing.
  original.messages.push({ role: "user", text: report.text }, { role: "assistant", text: "Other" });
  const reloaded = await connectedBridgeFixture(RECEIPT_FEATURES, original);
  reloaded.offer([report]);
  const furtherSubmissions: string[] = [];
  reloaded.submit(async (text) => {
    furtherSubmissions.push(text);
    const turnId = crypto.randomUUID();
    await nativeReportAppended(reloaded, text);
    await reloaded.run("turn.start", { turnId, text });
    await reloaded.run("turn.complete", { turnId, answer: "Fixture reply", reason: "answer" });
    return { text };
  });
  await reloaded.poll();
  await reloaded.dispatch();
  expect(furtherSubmissions).toEqual([]);
  expect(reloaded.polls.at(-1)?.reportAckIds).toEqual([]);

  const following = { ...report, id: crypto.randomUUID() };
  reloaded.offer([report, following]);
  await reloaded.poll();
  await reloaded.dispatch();
  await reloaded.poll();
  expect(reloaded.polls.at(-1)?.reportAckIds).toEqual([following.id]);
  expect(furtherSubmissions.length).toBe(1);
  expect(furtherSubmissions[0]).toContain(following.id);

  // Recover a receipt after Claude has recorded the report's own response.
  original.messages.push({ role: "user", text: nativeText });
  const appended = await connectedBridgeFixture(RECEIPT_FEATURES, original);
  appended.offer([report]);
  await appended.poll();
  await appended.poll();
  expect(appended.polls.at(-1)?.reportAckIds).toEqual([]);

  original.messages.push({ role: "assistant", text: "Fixture reply" });
  const reconciled = await connectedBridgeFixture(RECEIPT_FEATURES, original);
  reconciled.offer([report]);
  await reconciled.poll();
  await reconciled.poll();
  expect(reconciled.polls.at(-1)?.reportAckIds).toEqual([report.id]);
  expect([...original.receipts.values()]).toEqual(["delivered", "delivered"]);
});

test("compaction delays a report and a legacy Runtime keeps the old intake acknowledgment", async () => {
  const fixture = await connectedBridgeFixture(RECEIPT_FEATURES);
  const report = { id: crypto.randomUUID(), text: "Fixture report during compaction" };
  const submitted: string[] = [];
  fixture.submit(async (text) => {
    submitted.push(text);
    return { drop: "Fixture refusal" };
  });
  let finish!: () => void;
  const compacted = new Promise<void>((resolve) => (finish = resolve));
  const compact = fixture.run("session.compact", {}, () => compacted);
  fixture.offer([report]);
  await fixture.poll();
  await fixture.dispatch();
  expect(submitted).toEqual([]);
  finish();
  await compact;
  await fixture.poll();
  await fixture.dispatch();
  expect(submitted.length).toBe(1);
  expect(submitted[0]).toContain(report.id);

  const legacy = await connectedBridgeFixture(["lead-tools"]);
  legacy.offer([report]);
  legacy.submit(async (text) => {
    expect(text).toBe(report.text);
    submitted.push(text);
    return { drop: "Fixture refusal" };
  });
  await legacy.poll();
  await legacy.dispatch();
  expect(submitted.length).toBe(1);
  await legacy.poll();
  await legacy.dispatch();
  expect(submitted.length).toBe(2);
  expect(legacy.polls.at(-1)?.takenReports).toEqual([report.id]);
  expect(legacy.polls.at(-1)?.reportAckIds).toBeUndefined();
});

test("native receipt mode keeps existing long reports intact", async () => {
  const fixture = await connectedBridgeFixture(RECEIPT_FEATURES);
  const report = { id: crypto.randomUUID(), text: "A full report\n" + "件".repeat(18_000) };
  fixture.offer([report]);
  const submitted: string[] = [];
  fixture.submit(async (text) => {
    submitted.push(text);
    return { drop: "Synthetic refusal" };
  });
  await fixture.poll();
  await fixture.dispatch();
  expect(submitted).toEqual([`${report.text}\n\n[AgentKib report ID: ${report.id}]`]);
});

test("the native engine bounds a connected register stream without changing native values", async () => {
  const { run, snapshots, tick } = await connectedBridgeFixture();
  const turnId = crypto.randomUUID();
  await run("turn.start", { turnId, text: "synthetic stream" });
  const chunks = [
    { kind: "text", text: "x".repeat(96 * 1024) },
    ...Array.from({ length: 64 }, () => ({ kind: "text", text: "word" })),
  ];
  const result = { answer: "native final", turnId };
  const stream = run("turn.step", { turnId }, async function* () {
    yield* chunks;
    return result;
  });
  for (const chunk of chunks) expect((await stream.next()).value).toBe(chunk);
  const final = await stream.next();
  expect(final.done).toBe(true);
  expect(final.value).toBe(result);
  for (let index = 0; index < 3; index++) await tick();
  const text = snapshots.at(-1)!.streamText;
  expect(text).toContain("preview truncated");
  expect(new TextEncoder().encode(text).length <= 96 * 1024).toBe(true);
});

test("the native notification exposes a single pending human ask through the bridge", async ($, on) => {
  const { run, nativeId, snapshots, tick } = await connectedBridgeFixture([
    "terminal-approval-observation",
  ]);
  const turnId = crypto.randomUUID();
  const tool_use_id = crypto.randomUUID();
  const input = { command: "echo fixture", description: "Print a fixture" };
  const call = { tool: "Bash", tool_use_id, ...input };
  const check = { tool: "Bash", input, tool_use_id, approver: "person" };
  const verdict = { decision: "ask", reason: "fixture rule" };
  const result = { result: "fixture output" };
  let finish!: () => void;
  let checked!: () => void;
  const toolFinished = new Promise<void>((resolve) => (finish = resolve));
  const checkFinished = new Promise<void>((resolve) => (checked = resolve));
  await run("turn.start", { turnId, text: "synthetic terminal prompt" });
  const running = run("tool.call", call, async (nativeCall) => {
    expect(nativeCall).toBe(call);
    expect(
      await run("tool.check", check, (nativeCheck) => {
        expect(nativeCheck).toBe(check);
        return verdict;
      }),
    ).toBe(verdict);
    checked();
    await toolFinished;
    return result;
  });
  await checkFinished;
  await tick();
  expect(snapshots.at(-1)?.pendingApprovalDetails).toBeUndefined();
  on("classic.Notification", (_$, notification) =>
    run("classic.Notification", notification, (unchanged) => {
      expect(unchanged).toBe(notification);
      return {};
    }),
  );
  await $.classic.Notification({
    session_id: nativeId,
    notification_type: "permission_prompt",
    message: "Synthetic native permission prompt",
  });
  await tick();
  expect(snapshots.at(-1)?.pendingApprovalDetails).toEqual({
    turnId,
    toolUseId: tool_use_id,
    toolName: "Bash",
    input,
  });
  finish();
  expect(await running).toBe(result);
  await tick();
  expect(snapshots.at(-1)?.pendingApprovalDetails).toBeUndefined();
});

test("the native engine recovers a running terminal on its next prompt after an offline retry", async () => {
  type Value = Record<string, any>;
  type Hook = (api: Value, event: Value, next: (event: Value) => any) => any;
  const hooks = new Map<string, Array<{ match: Value; hook: Hook }>>();
  const timers: Array<() => Promise<void>> = [];
  const stored = new Map<string, unknown>();
  const snapshots: Value[] = [];
  register((name: string, matcher: Value | Hook, handler?: Hook) => {
    const match = typeof matcher === "function" ? {} : matcher;
    const hook = typeof matcher === "function" ? matcher : handler!;
    hooks.set(name, [...(hooks.get(name) ?? []), { match, hook }]);
    return { catch: () => undefined };
  });
  const nativeId = "00000000-0000-4000-8000-000000000001";
  const connection = {
    protocol: 1,
    bindingId: "00000000-0000-4000-8000-000000000002",
    leaseId: "00000000-0000-4000-8000-000000000003",
    token: "a".repeat(64),
    credentialPath: "/synthetic/credential.json",
  };
  let offline = false;
  let reconnects = 0;
  let pings = 0;
  const api = {
    ...capabilityApi("2.1.307"),
    store: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => stored.set(key, value),
    },
    command: { register: async () => undefined },
    clock: { every: (_ms: number, callback: () => Promise<void>) => timers.push(callback) },
    fs: {
      read: async (path: string) =>
        JSON.stringify(
          path.endsWith("package.json")
            ? { version: "0.4.0" }
            : {
                ...connection,
                socketPath: "/synthetic/bridge.sock",
                nativeId,
                cwd: "/synthetic/workspace",
                cliVersion: "2.1.307",
                pluginVersion: "0.4.0",
              },
        ),
    },
    http: {
      fetch: async (url: string, init: Value) => {
        if (init.method === "GET") {
          // A liveness check; the Runtime refuses anything but POST.
          pings++;
          if (offline) throw new Error("synthetic offline Runtime");
          return { ok: false, status: 403, text: "{}" };
        }
        if (url.endsWith("/reconnect")) reconnects++;
        if (offline) throw new Error("synthetic offline Runtime");
        const body = JSON.parse(init.body);
        if (url.endsWith("/events"))
          snapshots.push(
            ...body.events
              .filter((entry: Value) => entry.event.type === "snapshot")
              .map((entry: Value) => entry.event.snapshot),
          );
        return {
          ok: true,
          status: 200,
          text: JSON.stringify(
            url.endsWith("/pair") || url.endsWith("/reconnect")
              ? connection
              : url.endsWith("/events")
                ? { ackSeq: body.events.at(-1).seq }
                : { commands: [] },
          ),
        };
      },
    },
  };
  const run = (name: string, event: Value) => {
    const rows = (hooks.get(name) ?? []).filter(({ match }) =>
      Object.entries(match).every(([key, value]) => event[key] === value),
    );
    const visit = (index: number, value: Value): any =>
      index === rows.length
        ? value
        : rows[index].hook(api, value, (next) => visit(index + 1, next));
    return visit(0, event);
  };
  await run("session.start", {});
  const ticket = btoa(
    JSON.stringify({ protocol: 1, socketPath: "/synthetic/bridge.sock", ticket: "t".repeat(32) }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  await run("command.run", { command: "agentkib-connect", args: ticket });
  offline = true;
  await timers[1]();
  await timers[1]();
  // The retry found no Runtime, so it neither probed the session nor asked to reconnect.
  expect(pings).toBe(1);
  expect(reconnects).toBe(0);
  offline = false;
  const event = { text: "native prompt after Runtime restarts" };
  expect(await run("prompt.submit", event)).toBe(event);
  for (let index = 0; index < 64; index++) await Promise.resolve();
  expect(reconnects).toBe(1);
  await timers[0]();
  expect(snapshots.at(-1)!.capabilities.send).toBe(false);
  expect((await run("command.run", { command: "agentkib-status", args: "" })).text).toContain(
    "is connected",
  );
});

function capabilityApi(version: string) {
  const stored = new Map<string, unknown>();
  return {
    session: {
      id: async () => "00000000-0000-4000-8000-000000000001",
      cwd: async () => "/synthetic/workspace",
      root: async () => "/synthetic/workspace",
      version: async () => ({ version }),
      messages: async () => [],
      usage: async () => null,
    },
    store: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => {
        stored.set(key, value);
      },
    },
    plugin: { root: "/synthetic/plugin" },
    fs: { read: async () => JSON.stringify({ version: "0.4.0" }) },
  };
}

test("required readonly capabilities use explicit safe calls and preserve the observed CLI version", async () => {
  for (const version of ["2.1.301", "2.1.307"]) {
    const observed = await probeCapabilities(capabilityApi(version), initialState());
    expect(observed.cliVersion).toBe(version);
    expect(observed.nativeCapabilities.available).toEqual([
      "session-identity",
      "session-messages",
      "session-usage",
      "credential-store",
      "credential-read",
    ]);
  }
});

test("missing session-messages is reported without accepting a compatible version alone", async () => {
  const api = capabilityApi("2.1.307");
  api.session.messages = async () => {
    throw new Error("unavailable native method");
  };
  let failure: any;
  try {
    await probeCapabilities(api, initialState());
  } catch (error) {
    failure = error;
  }
  expect(failure.message).toBe("bridge-capabilities-missing");
  expect(failure.missingCapabilities).toEqual(["session-messages"]);
  expect(failure.cliVersion).toBe("2.1.307");
});

test("the native hook metadata identifies an absolute plugin root outside the metadata directory", async ($, on) => {
  // The test's $ only raises events. Read metadata from the actual native hook
  // context, without stubbing it or returning a local path to the test output.
  on("command.run", { command: "agentkib-test-native-root" }, async (native) => {
    const root = native.plugin.root;
    const valid =
      typeof root === "string" &&
      root.startsWith("/") &&
      root.length > 1 &&
      !root.replace(/\/+$/, "").endsWith("/.claude-plugin");
    return { text: valid ? "ok" : "invalid" };
  });
  const result = await $.command.run({ command: "agentkib-test-native-root", args: "" });
  expect(result.text).toBe("ok");
});
