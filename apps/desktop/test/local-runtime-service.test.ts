// @vitest-environment node
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  connectLocalRuntime,
  LOCAL_RUNTIME_PRESENCE,
  LOCAL_RUNTIME_PRESENCE_CHANGED,
  localRuntimePaths,
  type LocalRuntimePresence,
} from "@agentkib/backend/local-runtime-ipc";
import { serveLocalRuntime } from "@agentkib/backend/local-runtime-service";
import { BACKEND_INITIALIZE } from "@agentkib/backend/migration";
import {
  PROTOCOL_VERSION,
  RUNTIME_METHODS,
  type QuitWorkPreview,
  type SessionSubscription,
} from "@agentkib/runtime-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/agents/claude/claude-managed-read";
import { LocalCosts } from "../../../packages/backend/src/local-costs";
import { acquirePortableFileLease } from "../../../packages/backend/src/managed-session-lock";
import { QuitWork } from "../../../packages/backend/src/sessions/quit-work";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function client(socket: Socket) {
  let nextId = 0;
  const pending = new Map<number, (value: { result?: unknown; error?: unknown }) => void>();
  const presence: LocalRuntimePresence[] = [];
  const lines = createInterface({ input: socket });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    if (value.method === LOCAL_RUNTIME_PRESENCE_CHANGED) presence.push(value.params);
    pending.get(value.id)?.(value);
    pending.delete(value.id);
  });
  cleanups.push(() => {
    socket.destroy();
  });
  return {
    request: async <T>(method: string, params: unknown = {}) => {
      const id = ++nextId;
      const response = new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
        pending.set(id, resolve);
      });
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      const reply = await response;
      if (reply.error) throw new Error(JSON.stringify(reply.error));
      return reply.result as T;
    },
    closed: () => once(socket, "close"),
    presence,
    socket,
  };
}

async function prepare() {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "akrt-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const endpoint = path.join(directory, "ipc");
  const dataDir = path.join(directory, "data");
  const legacyDevDataDir = path.join(directory, "legacy-dev");
  const home = path.join(directory, "home");
  mkdirSync(dataDir);
  mkdirSync(home);
  const portProbe = createServer().listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const address = portProbe.address();
  if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  writeFileSync(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({
      mcp_network: { port: address.port, lan_enabled: false, lan_risk_accepted: false },
    }),
  );
  const environment = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    AGENTKIB_HOME: path.join(home, ".agentkib"),
    AGENTKIB_APP_FLAVOR: "ai.agentkib.dev",
    AGENTKIB_LEGACY_DEV_DATA_DIR: legacyDevDataDir,
  };
  const serve = async (idleTimeoutMs = 250) => {
    const daemon = await serveLocalRuntime(endpoint, dataDir, environment, idleTimeoutMs);
    cleanups.push(daemon.close);
    return daemon;
  };
  const attach = async (name: string, protocolVersion = PROTOCOL_VERSION as number) => {
    const desktop = client(await connectLocalRuntime(endpoint));
    await desktop.request(RUNTIME_METHODS.handshake, {
      protocolVersion,
      client: { name, version: "1.0.0" },
    });
    await desktop.request(BACKEND_INITIALIZE, { dataDir });
    return desktop;
  };
  return { attach, dataDir, endpoint, legacyDevDataDir, mcpPort: address.port, serve };
}

async function fixture() {
  const setup = await prepare();
  return { ...setup, daemon: await setup.serve() };
}

describe("shared local runtime service", () => {
  it("keeps one initialized backend and one live session source for both clients", async () => {
    const runtime = await fixture();
    const stable = await runtime.attach("stable");
    const first = await stable.request<SessionSubscription>(RUNTIME_METHODS.sessionsSubscribe, {
      sessionId: "",
    });
    const dev = await runtime.attach("dev");
    const second = await dev.request<SessionSubscription>(RUNTIME_METHODS.sessionsSubscribe, {
      sessionId: "",
    });
    expect(second.subscriptionId).not.toBe(first.subscriptionId);
    expect(second.events[0]).toMatchObject({
      epoch: first.events[0]!.epoch,
      runtimeBootId: first.events[0]!.runtimeBootId,
    });
    expect(
      await dev.request(RUNTIME_METHODS.sessionsUnsubscribe, {
        subscriptionId: first.subscriptionId,
      }),
    ).toEqual({ removed: false });

    const closed = stable.closed();
    await stable.request(RUNTIME_METHODS.shutdown);
    await closed;
    await expect(dev.request(RUNTIME_METHODS.runtimeInfo)).resolves.toMatchObject({
      data_dir: runtime.dataDir,
    });
    expect(
      await dev.request(RUNTIME_METHODS.sessionsUnsubscribe, {
        subscriptionId: second.subscriptionId,
      }),
    ).toEqual({ removed: true });

    dev.socket.destroy();
    await runtime.daemon.closed;
    await expect(connectLocalRuntime(runtime.endpoint)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies quit work only when the last desktop explicitly leaves and the runtime stops", async () => {
    const runtime = await fixture();
    const stop = vi.spyOn(QuitWork.prototype, "stop");
    const leaving = await runtime.attach("leaving");
    const remaining = await runtime.attach("remaining");

    const leavingClosed = leaving.closed();
    await leaving.request(RUNTIME_METHODS.shutdown, {
      quitWork: { ticket: randomUUID(), resume: true },
    });
    await leavingClosed;
    expect(stop).not.toHaveBeenCalled();

    const decision = { ticket: randomUUID(), resume: false };
    const remainingClosed = remaining.closed();
    await remaining.request(RUNTIME_METHODS.shutdown, { quitWork: decision });
    await remainingClosed;
    expect(stop).not.toHaveBeenCalled();
    await runtime.daemon.closed;
    expect(stop).toHaveBeenCalledExactlyOnceWith(decision);
  });

  it("resumes the selected managed session through the same runtime RPCs after restart", async () => {
    const runtime = await fixture();
    const sessionId = "managed-claude-session";
    const turnId = randomUUID();
    const evidence = { turnId, checkpoint: "native-transcript-verified" };
    const catalogRow = {
      id: sessionId,
      agent: "claude-code",
      title: "Managed Claude",
      availability: "readable",
      continuation: { status: "running", executionLocation: "agentkib" },
    };
    vi.spyOn(ClaudeManagedReadOwner.prototype, "catalog").mockReturnValue([
      catalogRow,
      {
        ...catalogRow,
        id: "terminal-session",
        continuation: { status: "running", executionLocation: "terminal" },
      },
    ]);
    const candidate = vi
      .spyOn(ClaudeManagedReadOwner.prototype, "quitCandidate")
      .mockResolvedValue({ turnId });
    const interrupt = vi
      .spyOn(ClaudeManagedReadOwner.prototype, "interruptForQuit")
      .mockResolvedValue(evidence);
    const resume = vi
      .spyOn(ClaudeManagedReadOwner.prototype, "resumeAfterQuit")
      .mockResolvedValue("continued");

    const quitting = await runtime.attach("quitting");
    await expect(
      quitting.request(RUNTIME_METHODS.setQuitResumePreference, { value: false }),
    ).resolves.toMatchObject({ resume_after_quit: false });
    const preview = await quitting.request<QuitWorkPreview>(RUNTIME_METHODS.quitWorkPrepare);
    expect(preview.resumeByDefault).toBe(false);
    expect(preview.work).toEqual([
      { id: expect.any(String), title: "Managed Claude", agent: "claude-code", resumable: true },
    ]);
    expect(candidate).toHaveBeenCalledExactlyOnceWith(sessionId);

    await quitting.request(RUNTIME_METHODS.shutdown, {
      quitWork: { ticket: preview.ticket, resume: true },
    });
    await runtime.daemon.closed;
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(sessionId, turnId);
    expect(resume).not.toHaveBeenCalled();

    await runtime.serve();
    expect(resume).not.toHaveBeenCalled();
    const reopened = await runtime.attach("reopened");
    await expect.poll(() => resume.mock.calls.length).toBe(1);
    expect(resume).toHaveBeenCalledExactlyOnceWith(
      sessionId,
      evidence,
      preview.work[0]!.id,
      "The previous turn was interrupted when AgentKib quit. Please continue from where it stopped.",
    );
    await reopened.request(BACKEND_INITIALIZE, { dataDir: runtime.dataDir });
    await expect(reopened.request(RUNTIME_METHODS.quitWorkList)).resolves.toEqual([]);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("drops the quit decision when another desktop reopens the shared runtime", async () => {
    const runtime = await prepare();
    const daemon = await runtime.serve(750);
    const stop = vi.spyOn(QuitWork.prototype, "stop");
    const leaving = await runtime.attach("leaving");
    const leavingClosed = leaving.closed();
    await leaving.request(RUNTIME_METHODS.shutdown, {
      quitWork: { ticket: randomUUID(), resume: true },
    });
    await leavingClosed;
    const reopened = await runtime.attach("reopened");
    expect(stop).not.toHaveBeenCalled();

    reopened.socket.destroy();
    await daemon.closed;
    expect(stop).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("does not let a competing launch or unauthenticated client own the backend", async () => {
    const runtime = await fixture();
    const desktop = await runtime.attach("desktop");
    await expect(runtime.serve()).rejects.toThrow("session-managed-by-another-runtime");
    const raw = createConnection(localRuntimePaths(runtime.endpoint).endpoint);
    const closed = once(raw, "close");
    raw.write("agentkib.handshake\n");
    await closed;
    await expect(runtime.attach("old", PROTOCOL_VERSION - 1)).rejects.toThrow(
      "Incompatible protocol version",
    );
    await expect(desktop.request(RUNTIME_METHODS.runtimeInfo)).resolves.toMatchObject({
      data_dir: runtime.dataDir,
    });
  });

  it("assigns primary duties to the earliest compatible client and announces failover", async () => {
    const runtime = await fixture();
    const stable = await runtime.attach("stable");
    await expect(stable.request(LOCAL_RUNTIME_PRESENCE)).resolves.toEqual({
      peers: 0,
      primary: true,
    });
    const dev = await runtime.attach("dev");
    await expect(dev.request(LOCAL_RUNTIME_PRESENCE)).resolves.toEqual({
      peers: 1,
      primary: false,
    });
    await expect.poll(() => stable.presence.at(-1)).toEqual({ peers: 1, primary: true });

    const closed = stable.closed();
    await stable.request(RUNTIME_METHODS.shutdown);
    await closed;
    await expect.poll(() => dev.presence.at(-1)).toEqual({ peers: 0, primary: true });

    const relaunchedStable = await runtime.attach("stable");
    await expect(relaunchedStable.request(LOCAL_RUNTIME_PRESENCE)).resolves.toEqual({
      peers: 1,
      primary: false,
    });
    await expect.poll(() => dev.presence.at(-1)).toEqual({ peers: 1, primary: true });
  });

  it("restores the remaining client's cost observer when the latest observer leaves", async () => {
    const runtime = await fixture();
    const cost = vi.spyOn(LocalCosts.prototype, "observe").mockResolvedValue(undefined);
    const stable = await runtime.attach("stable");
    const dev = await runtime.attach("dev");
    await stable.request(RUNTIME_METHODS.observeLocalCosts, { provider: "codex" });
    await dev.request(RUNTIME_METHODS.observeLocalCosts, { provider: null });
    expect(cost).toHaveBeenLastCalledWith("codex", false);
    await dev.request(RUNTIME_METHODS.observeLocalCosts, { provider: "claude" });
    expect(cost).toHaveBeenLastCalledWith("claude", false);

    const closed = dev.closed();
    await dev.request(RUNTIME_METHODS.shutdown);
    await closed;
    await expect.poll(() => cost.mock.calls.at(-1)?.[0]).toBe("codex");
    await stable.request(RUNTIME_METHODS.observeLocalCosts, { provider: null });
    expect(cost).toHaveBeenLastCalledWith(null, false);
  });

  it.each(["claude-bridge", "dsh-bridge"])(
    "rejects a held %s lease in the old Dev profile",
    async (bridge) => {
      const runtime = await prepare();
      const directory = path.join(runtime.legacyDevDataDir, bridge);
      mkdirSync(directory, { recursive: true });
      const release = acquirePortableFileLease(path.join(directory, "broker.lock"));
      try {
        await expect(runtime.serve()).rejects.toThrow(
          "older AgentKib runtime holds a local Agent bridge",
        );
        expect(existsSync(path.join(runtime.dataDir, "agentkib.db"))).toBe(false);
      } finally {
        release();
      }
      const daemon = await runtime.serve();
      await daemon.close();
    },
  );

  it("checks the older mandatory MCP listener before opening the shared database", async () => {
    const runtime = await prepare();
    const legacy = createServer((socket) => {
      socket.destroy();
    });
    legacy.listen(runtime.mcpPort, "127.0.0.1");
    await once(legacy, "listening");
    try {
      await expect(runtime.serve()).rejects.toThrow("local AgentKib MCP port is in use");
      expect(existsSync(path.join(runtime.dataDir, "agentkib.db"))).toBe(false);
      expect(legacy.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => legacy.close(() => resolve()));
    }
  });
});
