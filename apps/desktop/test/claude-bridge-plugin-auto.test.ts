// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  discoverAgentKib,
  register,
} from "../../../packages/claude-bridge-plugin/hooks/register.js";

type Value = Record<string, any>;
type Hook = (api: Value, event: Value, next: (event: Value) => any) => any;

const AUTO_KEY = "b".repeat(64);
const DISCOVERY = "/Users/demo/.agentkib/claude-bridge/auto-v1.json";
const SESSION_NOT_READY =
  "$.session.messages is not available in this mode: no session is bound in this process " +
  "(the REPL has not mounted and no headless session is built); catch it and carry on";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  options: {
    discovery?: boolean;
    storedCredential?: boolean;
    skipSessionStart?: boolean;
    storedLegacyBinding?: boolean;
    autoReplies?: Array<{ status: number; body: Value }>;
    packageVersion?: string;
    credentialPluginVersion?: string;
    /** The discovery file names a socket nothing answers on. */
    unreachable?: boolean;
    configure?: (api: Value) => void;
  } = {},
) {
  const hooks = new Map<string, Array<{ match: Value; hook: Hook }>>();
  register((name: string, matcher: Value | Hook, handler?: Hook) => {
    const hook = typeof matcher === "function" ? matcher : handler!;
    const match = typeof matcher === "function" ? {} : matcher;
    hooks.set(name, [...(hooks.get(name) ?? []), { match, hook }]);
    return { catch: () => undefined };
  });
  const nativeId = randomUUID();
  const cwd = "/Users/demo/projects/northstar-api";
  const stored = new Map<string, unknown>();
  const calls: Array<{ url: string; init: Value; body: Value }> = [];
  const timers: Array<() => Promise<void>> = [];
  const pings: string[] = [];
  let reachable = !options.unreachable;
  const replies = [...(options.autoReplies ?? [])];
  const connection = {
    protocol: 1,
    bindingId: randomUUID(),
    token: "a".repeat(64),
    leaseId: randomUUID(),
    credentialPath: "/Users/demo/Library/AgentKib/claude-bridge/credential.json",
  };
  const files = new Map<string, string>([
    [
      "/synthetic/plugin/package.json",
      JSON.stringify({ version: options.packageVersion ?? "0.4.0" }),
    ],
    [
      connection.credentialPath,
      JSON.stringify({
        ...connection,
        ...(options.storedLegacyBinding ? { bindingId: randomUUID(), token: "c".repeat(64) } : {}),
        socketPath: "/private/bridge.sock",
        nativeId,
        cwd,
        cliVersion: "2.1.301",
        pluginVersion: options.credentialPluginVersion ?? "0.4.0",
      }),
    ],
  ]);
  if (options.discovery !== false)
    files.set(
      DISCOVERY,
      JSON.stringify({ protocol: 1, socketPath: "/private/bridge.sock", autoKey: AUTO_KEY }),
    );
  if (options.storedCredential) stored.set(`credentialPath:${nativeId}`, connection.credentialPath);
  const api: Value = {
    session: {
      id: async () => nativeId,
      cwd: async () => cwd,
      root: async () => cwd,
      version: async () => ({ version: "2.1.301" }),
      messages: async () => [{ role: "user", text: "native history" }],
      usage: async () => ({ context: { tokens: 32, window: 100, percent: 32 } }),
    },
    env: { get: async (name: string) => (name === "HOME" ? "/Users/demo" : undefined) },
    command: { register: async () => undefined },
    store: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => stored.set(key, value),
    },
    plugin: { root: "/synthetic/plugin" },
    fs: {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error("missing");
        return value;
      },
    },
    clock: {
      every: (_ms: number, callback: () => Promise<void>) => timers.push(callback),
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 20))),
    },
    http: {
      fetch: async (url: string, init: Value) => {
        if (init.method === "GET") {
          pings.push(url);
          // A liveness check: a stale discovery file names a socket nothing answers on.
          if (!reachable) throw new Error("connect ECONNREFUSED");
          return {
            ok: false,
            status: 403,
            text: JSON.stringify({ error: "bridge-request-rejected" }),
          };
        }
        const body = JSON.parse(init.body);
        calls.push({ url, init, body });
        if (url.endsWith("/auto-pair") && replies.length) {
          const reply = replies.shift()!;
          return {
            ok: reply.status === 200,
            status: reply.status,
            text: JSON.stringify(reply.body),
          };
        }
        const result = url.endsWith("/events")
          ? { ackSeq: body.events.at(-1).seq }
          : url.endsWith("/commands")
            ? { commands: [] }
            : connection;
        return { ok: true, status: 200, text: JSON.stringify(result) };
      },
    },
    prompt: { submit: vi.fn() },
    turn: { abort: vi.fn() },
  };
  function run(name: string, event: Value): any {
    const rows = (hooks.get(name) ?? []).filter(({ match }) =>
      Object.entries(match).every(([key, value]) => event[key] === value),
    );
    const visit = (index: number, value: Value): any =>
      index === rows.length
        ? value
        : rows[index].hook(api, value, (next) => visit(index + 1, next));
    return visit(0, event);
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  options.configure?.(api);
  if (!options.skipSessionStart)
    await run("session.start", { cwd, isInteractive: true, surface: "terminal" });
  await settle();
  const autoPairs = () => calls.filter((call) => call.url.endsWith("/auto-pair"));
  const status = async () => (await run("command.run", { command: "agentkib-status" })).text;
  const completeTurn = async () => {
    await run("turn.complete", { turnId: randomUUID(), answer: "done" });
    await settle();
  };
  return {
    api,
    calls,
    stored,
    files,
    nativeId,
    cwd,
    connection,
    autoPairs,
    status,
    completeTurn,
    pings,
    run,
    setReachable(value: boolean) {
      reachable = value;
    },
    async tick(count = 1) {
      for (let index = 0; index < count; index++) for (const timer of timers) await timer();
    },
    publishDiscovery() {
      files.set(
        DISCOVERY,
        JSON.stringify({ protocol: 1, socketPath: "/private/bridge.sock", autoKey: AUTO_KEY }),
      );
    },
  };
}

describe("Claude bridge plugin automatic pairing", () => {
  it("reconnects a reloaded terminal using its saved credential without session.start", async () => {
    const f = await fixture({ storedCredential: true, skipSessionStart: true });
    expect(f.calls).toHaveLength(0);
    await f.run("ui.render", { component: "AbovePrompt", props: { isWorking: false } });
    await f.run("ui.render", { component: "AbovePrompt", props: { isWorking: false } });
    await expect.poll(() => f.status()).toContain("AgentKib is connected");
    expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toHaveLength(1);
    expect(f.autoPairs()).toHaveLength(0);
  });
  it("finds AgentKib through the per-user discovery file", async () => {
    const f = await fixture({ discovery: true });
    expect(await discoverAgentKib(f.api)).toEqual([
      { socketPath: "/private/bridge.sock", autoKey: AUTO_KEY },
    ]);
  });

  it("pairs a new session at start without a code", async () => {
    const f = await fixture();
    expect(f.autoPairs()).toHaveLength(1);
    const body = f.autoPairs()[0].body;
    expect(body).toMatchObject({ autoKey: AUTO_KEY, nativeId: f.nativeId, cwd: f.cwd });
    expect(f.autoPairs()[0].init.headers.Authorization).toBeUndefined();
    expect(f.stored.get(`credentialPath:${f.nativeId}`)).toBe(f.connection.credentialPath);
    expect(await f.status()).toContain("is connected");
  });

  it("explains that AgentKib could not be found without attempting to pair", async () => {
    const f = await fixture({ discovery: false });
    await f.completeTurn();
    expect(f.calls).toHaveLength(0);
    expect(await f.status()).toBe(
      "AgentKib is not running or could not be found. Open AgentKib on this computer and wait for automatic connection.",
    );
  });

  it("finds a Runtime started long after the idle terminal without another turn", async () => {
    const f = await fixture({ discovery: false });
    const history = vi.spyOn(f.api.session, "messages");
    // More than the old 20-attempt lifetime limit, with no native prompt or reload.
    await f.tick(3000);
    expect(f.calls).toHaveLength(0);
    expect(history).not.toHaveBeenCalled();
    expect(f.stored.has("compatibility:credential-store:1")).toBe(false);
    f.publishDiscovery();
    await f.tick(120);
    expect(f.autoPairs()).toHaveLength(1);
    expect(await f.status()).toContain("is connected");
    expect(f.api.prompt.submit).not.toHaveBeenCalled();
    expect(f.api.turn.abort).not.toHaveBeenCalled();
  });

  it("backs off unavailable discovery sockets and connects when one returns", async () => {
    const f = await fixture({ unreachable: true });
    const attempts = [0];
    for (let tick = 1; tick <= 400; tick++) {
      const before = f.pings.length;
      await f.tick();
      if (f.pings.length !== before) attempts.push(tick);
    }
    expect(attempts).toEqual([0, 4, 12, 28, 60, 124, 244, 364]);
    expect(f.stored.has("compatibility:credential-store:1")).toBe(false);
    f.setReachable(true);
    await f.tick(120);
    expect(f.autoPairs()).toHaveLength(1);
    expect(await f.status()).toContain("is connected");
    expect(f.api.prompt.submit).not.toHaveBeenCalled();
  });

  it("retries a session.start history probe once the native REPL is bound", async () => {
    let ready = false;
    const history = vi.fn(async () => {
      if (!ready) throw new Error(SESSION_NOT_READY);
      return [{ role: "user", text: "native history" }];
    });
    const f = await fixture({ configure: (api) => (api.session.messages = history) });
    expect(history).toHaveBeenCalledTimes(1);
    expect(f.autoPairs()).toHaveLength(0);
    expect(await f.status()).toContain("AgentKib bridge is not connected.");
    expect(f.stored.has("compatibility:credential-store:1")).toBe(false);
    await f.tick(3);
    expect(history).toHaveBeenCalledTimes(1);
    ready = true;
    await f.tick();
    expect(history).toHaveBeenCalledTimes(3); // Full probe, then the connected snapshot.
    expect(f.autoPairs()).toHaveLength(1);
    expect(f.autoPairs()[0].body.nativeCapabilities.available).toContain("session-messages");
    expect(await f.status()).toContain("is connected");
    expect(f.api.prompt.submit).not.toHaveBeenCalled();
  });

  it.each(["missing", "malformed", "other-error"])(
    "keeps rejecting a genuinely unavailable history capability: %s",
    async (failure) => {
      const history = vi.fn(async () => {
        if (failure === "other-error") throw new Error("native history unavailable");
        return { rows: [] };
      });
      const f = await fixture({
        configure: (api) => {
          if (failure === "missing") delete api.session.messages;
          else api.session.messages = history;
        },
      });
      expect(await f.status()).toContain("does not currently support");
      await f.tick(600);
      await f.completeTurn();
      expect(f.autoPairs()).toHaveLength(0);
      expect(history).toHaveBeenCalledTimes(failure === "missing" ? 0 : 1);
      expect(f.stored.get(`credentialPath:${f.nativeId}`)).toBeUndefined();
      expect(f.api.prompt.submit).not.toHaveBeenCalled();
    },
  );

  it("does not revive an ended session when its initial discovery finishes late", async () => {
    const held = deferred<boolean>();
    const f = await fixture({
      configure: (api) => {
        const exists = api.fs.exists;
        api.fs.exists = (file: string) => (file === DISCOVERY ? held.promise : exists(file));
      },
    });
    await f.run("session.end", { reason: "exit" });
    held.resolve(true);
    await f.tick(400);
    expect(f.autoPairs()).toHaveLength(0);
    expect(f.stored.get(`credentialPath:${f.nativeId}`)).toBeUndefined();
    expect(await f.status()).toContain("AgentKib bridge is not connected.");
    expect(f.api.prompt.submit).not.toHaveBeenCalled();
  });

  it.each(["version", "id", "cwd"])(
    "does not start automatic pairing after session.end interrupts startup identity.%s",
    async (read) => {
      const held = deferred<void>();
      const f = await fixture({
        configure: (api) => {
          const original = api.session[read];
          api.session[read] = async () => {
            await held.promise;
            return original();
          };
          api.session.messages = vi.fn(api.session.messages);
        },
      });
      await f.run("session.end", { reason: "exit" });
      held.resolve();
      await f.tick(400);
      expect(f.autoPairs()).toHaveLength(0);
      expect(f.api.session.messages).not.toHaveBeenCalled();
      expect(f.stored.get(`credentialPath:${f.nativeId}`)).toBeUndefined();
      expect(await f.status()).toContain("AgentKib bridge is not connected.");
      expect(f.api.prompt.submit).not.toHaveBeenCalled();
    },
  );

  it("ignores a late automatic pairing response after session.end", async () => {
    const held = deferred<void>();
    const f = await fixture({
      autoReplies: [
        {
          status: 409,
          body: { error: "bridge-auto-unavailable", reason: "workspace-not-registered" },
        },
      ],
      configure: (api) => {
        const fetch = api.http.fetch;
        api.http.fetch = async (url: string, init: Value) => {
          const result = await fetch(url, init);
          if (url.endsWith("/auto-pair")) await held.promise;
          return result;
        };
      },
    });
    expect(f.autoPairs()).toHaveLength(1);
    await f.run("session.end", { reason: "exit" });
    held.resolve();
    await f.tick(400);
    expect(f.autoPairs()).toHaveLength(1);
    expect(f.stored.get(`credentialPath:${f.nativeId}`)).toBeUndefined();
    expect(await f.status()).toContain("AgentKib bridge is not connected.");
    expect(f.api.prompt.submit).not.toHaveBeenCalled();
  });

  it("keeps an explicit pairing when an earlier discovery completes late", async () => {
    const held = deferred<boolean>();
    const f = await fixture({
      configure: (api) => {
        const exists = api.fs.exists;
        api.fs.exists = (file: string) => (file === DISCOVERY ? held.promise : exists(file));
      },
    });
    const ticket = Buffer.from(
      JSON.stringify({ protocol: 1, socketPath: "/private/bridge.sock", ticket: "t".repeat(32) }),
    ).toString("base64url");
    expect(
      (await f.run("command.run", { command: "agentkib-connect", args: ticket })).text,
    ).toContain("connected");
    held.resolve(true);
    await f.tick(120);
    expect(f.autoPairs()).toHaveLength(0);
    expect(f.calls.filter((call) => call.url.endsWith("/pair"))).toHaveLength(1);
    expect(await f.status()).toContain("is connected");
  });

  it("does not start discovery while an explicit pairing probe is pending", async () => {
    const f = await fixture({ discovery: false });
    const held = deferred<Value[]>();
    const messages = f.api.session.messages;
    const probe = vi
      .fn()
      .mockImplementationOnce(() => held.promise)
      .mockImplementation(messages);
    f.api.session.messages = probe;
    const ticket = Buffer.from(
      JSON.stringify({ protocol: 1, socketPath: "/private/bridge.sock", ticket: "t".repeat(32) }),
    ).toString("base64url");
    const pairing = f.run("command.run", { command: "agentkib-connect", args: ticket });
    await expect.poll(() => probe.mock.calls.length).toBe(1);
    f.publishDiscovery();
    await f.tick(120);
    expect(f.pings).toHaveLength(0);
    expect(f.autoPairs()).toHaveLength(0);
    held.resolve([{ role: "user", text: "native history" }]);
    expect((await pairing).text).toContain("connected");
    expect(await f.status()).toContain("is connected");
  });

  it("neither probes nor pairs through a discovery file a closed AgentKib left behind", async () => {
    const f = await fixture({ unreachable: true });
    await f.completeTurn();
    await f.completeTurn();
    expect(f.autoPairs()).toHaveLength(0);
    expect(f.stored.has("compatibility:credential-store:1")).toBe(false);
    expect(await f.status()).toBe(
      "AgentKib is not responding on this computer. Open AgentKib and wait for this terminal to connect.",
    );
  });

  it.each([
    [
      "workspace-not-registered",
      "This terminal's workspace is not registered in AgentKib. Add it in AgentKib, then wait for automatic connection.",
    ],
    [
      "session-not-indexed",
      "AgentKib has not indexed this Claude Code session yet. Make sure session indexing is enabled in AgentKib, then start or continue the conversation in this terminal and wait for automatic connection.",
    ],
  ])("explains %s and replaces the reason after a successful retry", async (reason, message) => {
    const f = await fixture({
      autoReplies: [{ status: 409, body: { error: "bridge-auto-unavailable", reason } }],
    });
    expect(await f.status()).toBe(message);
    await f.completeTurn();
    expect(f.autoPairs()).toHaveLength(2);
    expect(await f.status()).toContain("is connected");
  });

  it.each([
    ["legacy", 409, undefined],
    ["unknown", 409, `unknown ${AUTO_KEY} /private/bridge.sock`],
    ["unauthorized", 401, "workspace-not-registered"],
  ] as const)("retries a %s automatic pairing reply while idle", async (_label, code, reason) => {
    const f = await fixture({
      autoReplies: [{ status: code, body: { error: "bridge-auto-unavailable", reason } }],
    });
    const status = await f.status();
    expect(status).toBe(
      "AgentKib bridge is not connected. Check the terminal connection in AgentKib or generate a new connection code.",
    );
    expect(status).not.toContain(AUTO_KEY);
    expect(status).not.toContain("/private/bridge.sock");
    expect(f.autoPairs()).toHaveLength(1);
    await f.tick(3);
    expect(f.autoPairs()).toHaveLength(1);
    await f.tick();
    expect(f.autoPairs()).toHaveLength(2);
    expect(await f.status()).toContain("is connected");
    expect(f.api.prompt.submit).not.toHaveBeenCalled();
  });

  it.each([undefined, "session-disconnected"])(
    "stops trying after a disconnect (%s)",
    async (reason) => {
      const f = await fixture({
        autoReplies: [{ status: 409, body: { error: "bridge-auto-declined", reason } }],
      });
      await f.completeTurn();
      await f.completeTurn();
      await f.tick(600);
      expect(f.autoPairs()).toHaveLength(1);
      expect(await f.status()).toBe(
        "This session was disconnected or cleared in AgentKib. Generate a new connection code in AgentKib and run it in this terminal.",
      );
    },
  );

  it.each([undefined, "auto-connect-disabled"])(
    "can recover when auto-connect is re-enabled (%s)",
    async (reason) => {
      const f = await fixture({
        autoReplies: [
          { status: 409, body: { error: "bridge-auto-disabled", reason } },
          { status: 409, body: { error: "bridge-auto-disabled", reason } },
        ],
      });
      await f.completeTurn();
      expect(await f.status()).toBe(
        "Automatic connection is disabled for this workspace. Enable it in AgentKib or generate a new connection code.",
      );
      await f.completeTurn();
      expect(f.autoPairs()).toHaveLength(3);
      expect(await f.status()).toContain("is connected");
    },
  );

  it("explains an outdated plugin and keeps reporting it after later turns", async () => {
    const f = await fixture({
      autoReplies: [
        {
          status: 409,
          body: { error: "bridge-plugin-update-required", cliVersion: "2.1.310" },
        },
      ],
    });
    expect(await f.status()).toContain("plugin needs updating");
    await f.completeTurn();
    // A new session is indexed after its first turn, so AgentKib can show the reason.
    expect(f.autoPairs()).toHaveLength(2);
  });

  it("still connects when AgentKib has updated the plugin's files under a running terminal", async () => {
    const f = await fixture({ packageVersion: "0.9.0" });
    await f.completeTurn();
    expect(f.autoPairs()).toHaveLength(1);
    expect(f.autoPairs()[0].body).toMatchObject({ pluginVersion: "0.5.3" });
    expect(await f.status()).toContain("is connected");
  });

  it("reconnects with a credential that names another supported plugin release", async () => {
    const f = await fixture({ storedCredential: true, credentialPluginVersion: "0.6.0" });
    expect(f.calls.some((call) => call.url.endsWith("/reconnect"))).toBe(true);
    expect(f.autoPairs()).toHaveLength(0);
  });

  it("reconnects a previously paired session instead of pairing it again", async () => {
    const f = await fixture({ storedCredential: true });
    expect(f.autoPairs()).toHaveLength(0);
    expect(f.calls.some((call) => call.url.endsWith("/reconnect"))).toBe(true);
  });

  it("keeps the diagnosis when an automatic attempt finds an offline saved binding", async () => {
    const f = await fixture({ discovery: false, unreachable: true });
    f.stored.set(`credentialPath:${f.nativeId}`, f.connection.credentialPath);
    await f.completeTurn();
    expect(f.calls).toHaveLength(0);
    expect(await f.status()).toBe(
      "AgentKib is not responding on this computer. Open AgentKib and wait for this terminal to connect.",
    );
  });

  it.each(["endpoint", "overlapping binding"] as const)(
    "uses the same saved path when the shared runtime updates the %s",
    async (change) => {
      const f = await fixture({
        storedCredential: true,
        storedLegacyBinding: change === "overlapping binding",
        configure: (api) => {
          const fetch = api.http.fetch;
          api.http.fetch = (url: string, init: Value) => {
            if (init.socketPath === "/private/bridge.sock") throw new Error("connect ENOENT");
            return fetch(url, init);
          };
        },
      });
      expect(await f.status()).toBe(
        "AgentKib is not responding on this computer. Open AgentKib and wait for this terminal to connect.",
      );
      expect(f.calls).toHaveLength(0);

      const { credentialPath, bindingId, token } = f.connection;
      const credential = JSON.parse(f.files.get(credentialPath)!);
      const socketPath = "/private/shared-runtime.sock";
      f.files.set(credentialPath, JSON.stringify({ ...credential, bindingId, token, socketPath }));
      await f.tick(4);

      expect(await f.status()).toContain("is connected");
      expect(f.stored.get(`credentialPath:${f.nativeId}`)).toBe(credentialPath);
      expect(f.calls.filter((call) => call.url.endsWith("/reconnect"))).toMatchObject([
        {
          init: { socketPath, headers: { Authorization: `Bearer ${token}` } },
          body: { bindingId, nativeId: f.nativeId, cwd: f.cwd },
        },
      ]);
      expect(f.autoPairs()).toHaveLength(0);
      expect(f.api.prompt.submit).not.toHaveBeenCalled();
    },
  );
});
