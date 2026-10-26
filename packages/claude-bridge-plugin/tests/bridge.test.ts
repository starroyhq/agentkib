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
  expect(result.text).toBe("AgentKib bridge is not connected.");
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

test("the native engine bounds a connected register stream without changing native values", async () => {
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
  const nativeId = crypto.randomUUID();
  const connection = {
    protocol: 1,
    bindingId: crypto.randomUUID(),
    leaseId: crypto.randomUUID(),
    token: "a".repeat(64),
    credentialPath: "/private/synthetic-credential.json",
  };
  // The API is local synthetic data; this exercises the production observer in
  // Claude's actual plugin JS engine without opening a socket or calling a model.
  const stored = new Map<string, unknown>();
  const api = {
    session: {
      id: async () => nativeId,
      cwd: async () => "/synthetic/workspace",
      version: async () => ({ version: "2.1.301" }),
      messages: async () => [],
      usage: async () => null,
    },
    command: { register: async () => undefined },
    store: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => {
        stored.set(key, value);
      },
    },
    plugin: { root: "/synthetic/plugin" },
    fs: { read: async () => JSON.stringify({ version: "0.3.0" }) },
    clock: { every: (_ms: number, callback: () => Promise<void>) => timers.push(callback) },
    http: {
      fetch: async (url: string, init: Value) => {
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
            url.endsWith("/pair")
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
  for (let index = 0; index < 3; index++) await timers[0]();
  const text = snapshots.at(-1)!.streamText;
  expect(text).toContain("preview truncated");
  expect(new TextEncoder().encode(text).length <= 96 * 1024).toBe(true);
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
            ? { version: "0.3.0" }
            : {
                ...connection,
                socketPath: "/synthetic/bridge.sock",
                nativeId,
                cwd: "/synthetic/workspace",
                cliVersion: "2.1.307",
                pluginVersion: "0.3.0",
              },
        ),
    },
    http: {
      fetch: async (url: string, init: Value) => {
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
  expect(reconnects).toBe(1);
  offline = false;
  const event = { text: "native prompt after Runtime restarts" };
  expect(await run("prompt.submit", event)).toBe(event);
  for (let index = 0; index < 64; index++) await Promise.resolve();
  expect(reconnects).toBe(2);
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
    fs: { read: async () => JSON.stringify({ version: "0.3.0" }) },
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
