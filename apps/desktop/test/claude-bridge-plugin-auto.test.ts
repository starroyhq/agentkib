// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  discoverAgentKib,
  register,
} from "../../../packages/claude-bridge-plugin/hooks/register.js";

type Value = Record<string, any>;
type Hook = (api: Value, event: Value, next: (event: Value) => any) => any;

const AUTO_KEY = "b".repeat(64);
const DISCOVERY = "/Users/demo/.agentkib/claude-bridge/auto-v1.json";

async function fixture(
  options: {
    discovery?: boolean;
    storedCredential?: boolean;
    autoReplies?: Array<{ status: number; body: Value }>;
    packageVersion?: string;
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
        socketPath: "/private/bridge.sock",
        nativeId,
        cwd,
        cliVersion: "2.1.301",
        pluginVersion: "0.4.0",
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
    clock: { every: () => undefined },
    http: {
      fetch: async (url: string, init: Value) => {
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
        const result = url.endsWith("/events") ? { ackSeq: body.events.at(-1).seq } : connection;
        return { ok: true, status: 200, text: JSON.stringify(result) };
      },
    },
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
  await run("session.start", { cwd, isInteractive: true, surface: "terminal" });
  await settle();
  const autoPairs = () => calls.filter((call) => call.url.endsWith("/auto-pair"));
  const status = async () => (await run("command.run", { command: "agentkib-status" })).text;
  const completeTurn = async () => {
    await run("turn.complete", { turnId: randomUUID(), answer: "done" });
    await settle();
  };
  return { api, calls, stored, nativeId, cwd, connection, autoPairs, status, completeTurn };
}

describe("Claude bridge plugin automatic pairing", () => {
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

  it("does nothing when AgentKib is not running", async () => {
    const f = await fixture({ discovery: false });
    await f.completeTurn();
    expect(f.calls).toHaveLength(0);
    expect(await f.status()).toBe("AgentKib bridge is not connected.");
  });

  it("retries after a turn until AgentKib has indexed the session", async () => {
    const f = await fixture({
      autoReplies: [{ status: 409, body: { error: "bridge-auto-unavailable" } }],
    });
    expect(await f.status()).toBe("AgentKib bridge is not connected.");
    await f.completeTurn();
    expect(f.autoPairs()).toHaveLength(2);
    expect(await f.status()).toContain("is connected");
  });

  it("stops trying when the user disconnected the session", async () => {
    const f = await fixture({
      autoReplies: [{ status: 409, body: { error: "bridge-auto-declined" } }],
    });
    await f.completeTurn();
    await f.completeTurn();
    expect(f.autoPairs()).toHaveLength(1);
    expect(await f.status()).toBe("AgentKib bridge is not connected.");
  });

  it("connects on a later turn once the workspace is switched back on", async () => {
    const f = await fixture({
      autoReplies: [
        { status: 409, body: { error: "bridge-auto-disabled" } },
        { status: 409, body: { error: "bridge-auto-disabled" } },
      ],
    });
    await f.completeTurn();
    expect(await f.status()).toBe("AgentKib bridge is not connected.");
    await f.completeTurn();
    expect(f.autoPairs()).toHaveLength(3);
    expect(await f.status()).toContain("is connected");
  });

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

  it("explains a plugin whose installed files are out of step without calling AgentKib", async () => {
    const f = await fixture({ packageVersion: "0.2.0" });
    await f.completeTurn();
    expect(f.autoPairs()).toHaveLength(0);
    expect(await f.status()).toContain("plugin needs updating");
  });

  it("reconnects a previously paired session instead of pairing it again", async () => {
    const f = await fixture({ storedCredential: true });
    expect(f.autoPairs()).toHaveLength(0);
    expect(f.calls.some((call) => call.url.endsWith("/reconnect"))).toBe(true);
  });
});
