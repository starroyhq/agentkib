// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeBridge } from "../../../packages/backend/src/claude-bridge";
import { register } from "../../../packages/claude-bridge-plugin/hooks/register.js";

type Value = Record<string, any>;
type Hook = (api: Value, event: Value, next: (event: Value) => any) => any;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-capability-test-")));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const target = {
    sessionId: "synthetic-capability-session",
    nativeId: randomUUID(),
    workspaceId: "synthetic-workspace",
    workspace,
    registeredWorkspace: workspace,
  };
  const bridge = new ClaudeBridge({
    dataDir: path.join(root, "data"),
    bootId: randomUUID(),
    pluginDirectory: path.join(root, "plugin"),
    platform: "darwin",
    publish: () => undefined,
    target: async () => ({ ...target }),
    validate: () => undefined,
  });
  cleanups.push(async () => {
    await bridge.close();
    rmSync(root, { recursive: true, force: true });
  });
  const challenge = async () => {
    const result = (await bridge.management({
      operation: "bridge-challenge",
      sessionId: target.sessionId,
      deviceId: "agentkib-local-owner",
    })) as { challenge: string };
    return result.challenge;
  };
  const firstChallenge = await challenge();
  const ticket = JSON.parse(Buffer.from(firstChallenge, "base64url").toString());
  const statuses: Array<{ url: string; status: number }> = [];
  const connect = async (code: string, usage: Value, messages: Value[] = []) => {
    let connectHook!: Hook;
    register((name: string, matcher: Hook | Value, handler?: Hook) => {
      if (name === "command.run" && typeof matcher !== "function") {
        if (matcher.command === "agentkib-connect") connectHook = handler!;
      }
      return { catch() {} };
    });
    const store = new Map<string, unknown>();
    const api = {
      plugin: { root: "/synthetic/plugin" },
      fs: { read: async () => JSON.stringify({ version: "0.2.0" }) },
      session: {
        id: async () => target.nativeId,
        cwd: async () => workspace,
        version: async () => ({ version: "2.1.307" }),
        messages: async () => messages,
        usage: async () => usage,
      },
      store: {
        get: async (key: string) => store.get(key),
        set: async (key: string, value: unknown) => {
          store.set(key, value);
        },
      },
      http: {
        fetch: async (url: string, init: Value) => {
          const response = await new Promise<{ status: number; body: Value }>((resolve, reject) => {
            const req = request(
              {
                socketPath: ticket.socketPath,
                path: new URL(url).pathname,
                method: "POST",
                headers: { Host: "localhost", Connection: "close", ...init.headers },
              },
              (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                res.on("end", () =>
                  resolve({
                    status: res.statusCode!,
                    body: JSON.parse(Buffer.concat(chunks).toString()),
                  }),
                );
              },
            );
            req.on("error", reject);
            req.end(init.body);
          });
          statuses.push({ url, status: response.status });
          return {
            ok: response.status === 200,
            status: response.status,
            text: JSON.stringify(response.body),
          };
        },
      },
    };
    return connectHook(api, { command: "agentkib-connect", args: code }, (event) => event);
  };
  return {
    bridge,
    target,
    challenge,
    firstChallenge,
    connect,
    statuses,
    live: () => bridge.live(target.sessionId, true),
  };
}

describe.skipIf(process.platform === "win32")("native capability and snapshot contract", () => {
  it.each([
    ["tokens", 1.5],
    ["window", 1.5],
    ["tokens", Number.MAX_SAFE_INTEGER + 1],
    ["window", Number.MAX_SAFE_INTEGER + 1],
  ])("preserves the active lease when session-usage %s is %s", async (key, value) => {
    const f = await fixture();
    expect(
      (await f.connect(f.firstChallenge, { context: { tokens: 1, window: 100, percent: 1 } })).text,
    ).toContain("connected");
    const generation = f.live().connectionGeneration;
    expect(f.live().executionLocation).toBe("terminal");
    const code = await f.challenge();
    expect(
      (await f.connect(code, { context: { tokens: 1, window: 100, [key]: value } })).text,
    ).toContain("does not currently support");
    expect(f.live().connectionGeneration).toBe(generation);
    expect(f.live().executionLocation).toBe("terminal");
    // A refused probe leaves the code usable; valid usage must reach the real snapshot schema.
    expect(
      (
        await f.connect(code, {
          context: { tokens: 0, window: Number.MAX_SAFE_INTEGER, percent: 0.5 },
        })
      ).text,
    ).toContain("connected");
    expect(f.live().connectionGeneration).not.toBe(generation);
    expect(f.live().executionLocation).toBe("terminal");
    expect(
      f.statuses
        .filter((entry) => entry.url.endsWith("/events"))
        .every((entry) => entry.status === 200),
    ).toBe(true);
  });
  it.each([
    ["tool", 0],
    ["tool_use_id", 0],
    ["tool", 257],
    ["tool_use_id", 257],
  ])("preserves the active lease when a projected %s has length %s", async (key, length) => {
    const f = await fixture();
    const usage = { context: { tokens: 1, window: 100, percent: 1 } };
    expect((await f.connect(f.firstChallenge, usage)).text).toContain("connected");
    const generation = f.live().connectionGeneration;
    const code = await f.challenge();
    const invalidMessages = [
      {
        role: "assistant",
        text: "",
        toolUses: [
          { tool_use_id: "synthetic-id", tool: "synthetic-tool", [key]: "x".repeat(length) },
        ],
      },
    ];
    expect((await f.connect(code, usage, invalidMessages)).text).toContain(
      "does not currently support",
    );
    expect(f.live().connectionGeneration).toBe(generation);
    expect(f.live().executionLocation).toBe("terminal");
    const validMessages = [
      {
        role: "assistant",
        text: "",
        toolUses: [{ tool_use_id: "i".repeat(256), tool: "n".repeat(256) }],
      },
    ];
    expect((await f.connect(code, usage, validMessages)).text).toContain("connected");
    expect(f.live().connectionGeneration).not.toBe(generation);
    expect(f.live().executionLocation).toBe("terminal");
    expect(
      f.statuses
        .filter((entry) => entry.url.endsWith("/events"))
        .every((entry) => entry.status === 200),
    ).toBe(true);
  });
});
