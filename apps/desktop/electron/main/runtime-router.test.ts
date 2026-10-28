import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { HISTORY_SEARCH_METHODS } from "@agentkib/runtime-protocol";
import {
  BACKEND_INITIALIZE,
  BACKEND_PREFERENCES,
  BACKEND_PLAN_WORKSPACE,
  BACKEND_PLAN_DISCOVERY,
  NATIVE_CONTEXT,
  NATIVE_CONFIGURED_DISCOVERY,
  NATIVE_SCAN_ROOT_DISCOVERY,
  BACKEND_INSPECT,
} from "@agentkib/backend/migration";
import {
  PROTOCOL_VERSION,
  RUNTIME_METHODS,
  type RuntimeHandshakeResult,
} from "../generated/runtime-protocol";
import { type RuntimeHost, type RuntimeHostStatus, RuntimeUnavailableError } from "./runtime-host";
import { RuntimeRouter } from "./runtime-router";

const handshake: RuntimeHandshakeResult = {
  protocolVersion: PROTOCOL_VERSION,
  runtime: { name: "fixture", version: "0.13.0" },
  pid: 1,
  capabilities: ["fixture"],
};

class Host extends EventEmitter implements RuntimeHost {
  status: RuntimeHostStatus = { state: "stopping", restartCount: 0 };
  handler: (method: string, params: unknown) => unknown = (method) => {
    if (method === RUNTIME_METHODS.runtimeInfo)
      return { data_dir: "/fixture", session_index_enabled: true };
    if (method === BACKEND_PREFERENCES || method === RUNTIME_METHODS.setLocale)
      return { locale_preference: "zh-TW" };
    return [];
  };
  calls: string[] = [];
  start = vi.fn(async () => {
    this.ready();
    return handshake;
  });
  retry = vi.fn(async () => {
    this.ready();
    return handshake;
  });
  stop = vi.fn(async () => {
    this.status.state = "stopping";
    this.emit("exit", { expected: true });
  });
  async request<T>(method: string, params: unknown): Promise<T> {
    this.calls.push(method);
    return (await this.handler(method, params)) as T;
  }
  ready() {
    this.status.state = "ready";
    this.emit("ready", handshake);
  }
  crash() {
    this.status = { state: "restarting", restartCount: this.status.restartCount + 1 };
    this.emit("exit", { expected: false });
    this.emit("state", this.status);
  }
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const historyLocation = {
  sessionId: "source-session",
  recordId: "source-record",
  chunkId: "source-chunk",
  sourceRevision: "source-revision",
};
const historyRequests = [
  {
    method: HISTORY_SEARCH_METHODS.query,
    params: {
      query: "fixture needle",
      workspaceIds: ["workspace"],
      agents: ["codex"],
      kinds: ["assistant"],
      archived: false,
      limit: 7,
      allowedSessionIds: ["source-session"],
    },
  },
  { method: HISTORY_SEARCH_METHODS.locate, params: { location: historyLocation } },
  {
    method: HISTORY_SEARCH_METHODS.references,
    params: {
      references: [{ ...historyLocation, start: 0, end: 7, contentHash: "a".repeat(64) }],
    },
  },
  { method: HISTORY_SEARCH_METHODS.status, params: { allowedSessionIds: ["source-session"] } },
  { method: HISTORY_SEARCH_METHODS.configure, params: { enabled: true } },
  { method: HISTORY_SEARCH_METHODS.clear, params: {} },
  { method: HISTORY_SEARCH_METHODS.refresh, params: {} },
  {
    method: HISTORY_SEARCH_METHODS.cancel,
    params: { requestId: "00000000-0000-4000-8000-000000000001" },
  },
];

describe("RuntimeRouter Skill ownership", () => {
  it.each(Object.values(RUNTIME_METHODS).filter((method) => method.startsWith("skills.")))(
    "forwards %s through the real router exactly once",
    async (method) => {
      const host = new Host();
      const router = new RuntimeRouter(host);
      await router.start();
      const params = { marker: method };
      const result = { accepted: method };
      const received = vi.fn(() => result);
      host.handler = received;
      expect(await router.request(method, params)).toBe(result);
      expect(received).toHaveBeenCalledExactlyOnceWith(method, params);
      await router.stop();
    },
  );
});

describe("RuntimeRouter read-only Codex continuation", () => {
  it("forwards resume-command as a TypeScript history read without invoking controls", async () => {
    const host = new Host();
    const router = new RuntimeRouter(host);
    await router.start();
    const params = { operation: "resume-command", sessionId: "session" };
    const result = { available: true, command: "verified command", shell: "posix", runOn: "host" };
    const received = vi.fn(() => result);
    host.handler = received;
    expect(await router.request(RUNTIME_METHODS.webRequest, params)).toBe(result);
    expect(received).toHaveBeenCalledExactlyOnceWith(RUNTIME_METHODS.webRequest, params);
    await router.stop();
  });
});

describe("RuntimeRouter Codex compaction and background terminals", () => {
  it.each([
    [RUNTIME_METHODS.webRequest, "compact"],
    [RUNTIME_METHODS.webRequest, "terminals-clean"],
    [RUNTIME_METHODS.codexManaged, "compact"],
    [RUNTIME_METHODS.codexManaged, "terminals-clean"],
  ])("forwards %s %s to the TypeScript backend once", async (method, operation) => {
    const host = new Host();
    const router = new RuntimeRouter(host);
    await router.start();
    const params = { operation, sessionId: "session", requestId: "request" };
    const result = { accepted: true, completed: operation === "terminals-clean" };
    const received = vi.fn(() => result);
    host.handler = received;
    expect(await router.request(method, params)).toBe(result);
    expect(received).toHaveBeenCalledExactlyOnceWith(method, params);
    await router.stop();
  });
});

describe("RuntimeRouter history search ownership", () => {
  it.each(historyRequests)(
    "forwards $method and its exact parameters once",
    async ({ method, params }) => {
      const ts = new Host();
      const router = new RuntimeRouter(ts);
      await router.start();
      const result = { marker: method };
      const received = vi.fn((_method: string, _params: unknown) => result);
      ts.handler = received;

      expect(await router.request(method, params)).toBe(result);
      expect(received).toHaveBeenCalledExactlyOnceWith(method, params);
      expect(received.mock.calls[0]?.[1]).toBe(params);
      await router.stop();
    },
  );

  it.each(historyRequests)(
    "returns the original $method error without replay",
    async ({ method, params }) => {
      const ts = new Host();
      const router = new RuntimeRouter(ts);
      await router.start();
      const failure = new Error(`fixture ${method} failed`);
      const received = vi.fn(() => {
        throw failure;
      });
      ts.handler = received;

      await expect(router.request(method, params)).rejects.toBe(failure);
      expect(received).toHaveBeenCalledExactlyOnceWith(method, params);
      expect(router.status.state).toBe("ready");
      await router.stop();
    },
  );

  it("rejects an unregistered history method before calling the backend", async () => {
    const ts = new Host();
    const router = new RuntimeRouter(ts);
    await router.start();
    const received = vi.fn();
    ts.handler = received;

    await expect(router.request("sessions.searchContentUnknown", {})).rejects.toThrow(
      "No backend owner is registered for runtime method sessions.searchContentUnknown",
    );
    expect(received).not.toHaveBeenCalled();
    await router.stop();
  });

  it.each([false, true])(
    "serializes configure with preference writers and snapshots after errors (configure fails: %s)",
    async (configureFails) => {
      const ts = new Host();
      const router = new RuntimeRouter(ts);
      await router.start();
      ts.calls.length = 0;
      const writing = gate();
      const configuring = gate();
      const writeFailure = new Error("fixture preference write failed");
      const configureFailure = new Error("fixture history configuration failed");
      ts.handler = async (method) => {
        if (method === RUNTIME_METHODS.updateMcpNetwork) {
          await writing.promise;
          throw writeFailure;
        }
        if (method === HISTORY_SEARCH_METHODS.configure) {
          await configuring.promise;
          if (configureFails) throw configureFailure;
          return { enabled: true };
        }
        if (method === RUNTIME_METHODS.runtimeInfo)
          return { data_dir: "/fixture", session_content_search_enabled: !configureFails };
        return { locale_preference: "zh-TW" };
      };
      const first = router.request(RUNTIME_METHODS.updateMcpNetwork, { settings: {} });
      const configured = router.request(HISTORY_SEARCH_METHODS.configure, { enabled: true });
      const snapshot = router.request(RUNTIME_METHODS.runtimeInfo, {});
      const following = router.request(RUNTIME_METHODS.setLocale, { preference: "zh-TW" });
      const requests = [first, configured, snapshot, following];
      for (const request of requests) void request.catch(() => undefined);
      try {
        await vi.waitFor(() => expect(ts.calls).toEqual([RUNTIME_METHODS.updateMcpNetwork]));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(ts.calls).toEqual([RUNTIME_METHODS.updateMcpNetwork]);

        writing.resolve();
        await expect(first).rejects.toBe(writeFailure);
        await vi.waitFor(() =>
          expect(ts.calls).toEqual([
            RUNTIME_METHODS.updateMcpNetwork,
            HISTORY_SEARCH_METHODS.configure,
          ]),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(ts.calls).toEqual([
          RUNTIME_METHODS.updateMcpNetwork,
          HISTORY_SEARCH_METHODS.configure,
        ]);

        configuring.resolve();
        if (configureFails) await expect(configured).rejects.toBe(configureFailure);
        else await expect(configured).resolves.toEqual({ enabled: true });
        await expect(snapshot).resolves.toMatchObject({
          session_content_search_enabled: !configureFails,
        });
        await expect(following).resolves.toEqual({ locale_preference: "zh-TW" });
        expect(ts.calls).toEqual([
          RUNTIME_METHODS.updateMcpNetwork,
          HISTORY_SEARCH_METHODS.configure,
          RUNTIME_METHODS.runtimeInfo,
          RUNTIME_METHODS.setLocale,
        ]);
      } finally {
        writing.resolve();
        configuring.resolve();
        await Promise.allSettled(requests);
        await router.stop();
      }
    },
  );

  it("dispatches another query and cancellation while a search read is pending", async () => {
    const ts = new Host();
    const router = new RuntimeRouter(ts);
    await router.start();
    ts.calls.length = 0;
    const searching = gate();
    const pendingParams = {
      query: "slow fixture",
      requestId: "00000000-0000-4000-8000-000000000001",
    };
    const quickParams = {
      query: "quick fixture",
      requestId: "00000000-0000-4000-8000-000000000002",
    };
    const received = vi.fn((method: string, params: unknown) => {
      if (params === pendingParams) return searching.promise.then(() => ({ hits: ["slow"] }));
      if (method === HISTORY_SEARCH_METHODS.query) return { hits: ["quick"] };
      return null;
    });
    ts.handler = received;
    const pending = router.request(HISTORY_SEARCH_METHODS.query, pendingParams);
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() =>
        expect(received).toHaveBeenCalledExactlyOnceWith(
          HISTORY_SEARCH_METHODS.query,
          pendingParams,
        ),
      );
      await expect(router.request(HISTORY_SEARCH_METHODS.query, quickParams)).resolves.toEqual({
        hits: ["quick"],
      });
      const cancelParams = { requestId: pendingParams.requestId };
      await expect(router.request(HISTORY_SEARCH_METHODS.cancel, cancelParams)).resolves.toBeNull();
      expect(received.mock.calls).toEqual([
        [HISTORY_SEARCH_METHODS.query, pendingParams],
        [HISTORY_SEARCH_METHODS.query, quickParams],
        [HISTORY_SEARCH_METHODS.cancel, cancelParams],
      ]);
    } finally {
      searching.resolve();
      await Promise.allSettled([pending]);
      await router.stop();
    }
  });

  it("dispatches query and cancellation while history configuration is pending", async () => {
    const ts = new Host();
    const router = new RuntimeRouter(ts);
    await router.start();
    ts.calls.length = 0;
    const configuring = gate();
    ts.handler = (method) => {
      if (method === HISTORY_SEARCH_METHODS.configure)
        return configuring.promise.then(() => ({ enabled: true }));
      if (method === HISTORY_SEARCH_METHODS.query) return { hits: [] };
      return null;
    };
    const pending = router.request(HISTORY_SEARCH_METHODS.configure, { enabled: true });
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(ts.calls).toContain(HISTORY_SEARCH_METHODS.configure));
      await expect(
        router.request(HISTORY_SEARCH_METHODS.query, { query: "fixture" }),
      ).resolves.toEqual({ hits: [] });
      await expect(
        router.request(HISTORY_SEARCH_METHODS.cancel, {
          requestId: "00000000-0000-4000-8000-000000000001",
        }),
      ).resolves.toBeNull();
      expect(ts.calls).toEqual([
        HISTORY_SEARCH_METHODS.configure,
        HISTORY_SEARCH_METHODS.query,
        HISTORY_SEARCH_METHODS.cancel,
      ]);
    } finally {
      configuring.resolve();
      await Promise.allSettled([pending]);
      await router.stop();
    }
  });
});

describe("RuntimeRouter migration ownership and recovery", () => {
  it.each([
    RUNTIME_METHODS.mcpConnectionInfo,
    RUNTIME_METHODS.planMcpConnection,
    RUNTIME_METHODS.verifyMcpConnection,
  ])("routes %s directly to the backend which owns the current Hub status", async (method) => {
    const ts = new Host();
    const router = new RuntimeRouter(ts);
    await router.start();
    const received = vi.fn((_method: string, _params: unknown) => ({ marker: method }));
    ts.handler = (requested, params) => received(requested, params);
    const request = { workspaceId: "workspace", targetAgent: "cursor" };

    expect(await router.request(method, request)).toEqual({ marker: method });
    expect(received).toHaveBeenCalledExactlyOnceWith(method, request);
    await router.stop();
  });

  it("routes Skill version and batch operations to the TypeScript backend once", async () => {
    const ts = new Host();
    const router = new RuntimeRouter(ts);
    await router.start();
    ts.handler = (method) => ({ method });
    for (const method of [
      RUNTIME_METHODS.listSkillVersions,
      RUNTIME_METHODS.prepareSkillVersionChange,
      RUNTIME_METHODS.prepareSkillImports,
      RUNTIME_METHODS.applySkillImports,
      RUNTIME_METHODS.discardSkillPreview,
    ]) {
      expect(await router.request(method, {})).toEqual({ method });
      expect(ts.calls.filter((called) => called === method)).toHaveLength(1);
    }
    await router.stop();
  });

  it("waits for shared database initialization before serving migrated requests", async () => {
    const ts = new Host();
    const initialized = gate();
    ts.handler = (method) => (method === BACKEND_INITIALIZE ? initialized.promise : ["typescript"]);
    const router = new RuntimeRouter(ts, "/fixture");
    const starting = router.start();
    const reading = router.request(RUNTIME_METHODS.listWorkspaces, {});
    await vi.waitFor(() => expect(ts.calls).toContain(BACKEND_INITIALIZE));
    expect(ts.calls).not.toContain(RUNTIME_METHODS.listWorkspaces);
    initialized.resolve();
    await starting;
    expect(await reading).toEqual(["typescript"]);
    expect(ts.calls.filter((method) => method === RUNTIME_METHODS.listWorkspaces)).toHaveLength(1);
    expect(ts.calls).not.toContain(RUNTIME_METHODS.handshake);
    await router.stop();
  });

  it("serializes preference writers and continues after an error", async () => {
    const ts = new Host();
    const router = new RuntimeRouter(ts);
    await router.start();
    const writing = gate();
    ts.handler = (method) => {
      if (method === RUNTIME_METHODS.updateMcpNetwork)
        return writing.promise.then(() => {
          throw new Error("fixture write failed");
        });
      if (method === RUNTIME_METHODS.setLocale || method === BACKEND_PREFERENCES)
        return { locale_preference: "zh-TW" };
      return { data_dir: "/fixture", session_index_enabled: true };
    };
    const first = expect(
      router.request(RUNTIME_METHODS.updateMcpNetwork, { settings: {} }),
    ).rejects.toThrow("fixture write failed");
    const second = router.request(RUNTIME_METHODS.setLocale, { preference: "zh-TW" });
    const snapshot = router.request(RUNTIME_METHODS.runtimeInfo, {});
    await vi.waitFor(() => expect(ts.calls).toContain(RUNTIME_METHODS.updateMcpNetwork));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ts.calls).not.toContain(RUNTIME_METHODS.setLocale);
    expect(ts.calls).not.toContain(BACKEND_PREFERENCES);
    writing.resolve();
    await first;
    expect(await second).toMatchObject({ locale_preference: "zh-TW" });
    expect(await snapshot).toMatchObject({ data_dir: "/fixture", session_index_enabled: true });
    expect(ts.calls.filter((method) => method === RUNTIME_METHODS.setLocale)).toHaveLength(1);
    await router.stop();
  });

  it("returns failed TypeScript operations without replay", async () => {
    const ts = new Host();
    const router = new RuntimeRouter(ts);
    await router.start();
    ts.handler = () => {
      throw new Error("typescript failure");
    };
    for (const method of [
      RUNTIME_METHODS.setLocale,
      RUNTIME_METHODS.scanWorkspace,
      RUNTIME_METHODS.prepareManifest,
      RUNTIME_METHODS.resolveContext,
      RUNTIME_METHODS.workspaceDoctorReport,
      RUNTIME_METHODS.workspaceDoctorSummaries,
      RUNTIME_METHODS.planChanges,
      RUNTIME_METHODS.applyChanges,
      RUNTIME_METHODS.workspaceGitSummary,
      RUNTIME_METHODS.insightsView,
      RUNTIME_METHODS.workspaceSessions,
      RUNTIME_METHODS.sessionEvents,
      NATIVE_CONTEXT,
      RUNTIME_METHODS.proposeMemory,
    ]) {
      await expect(router.request(method, {})).rejects.toThrow("typescript failure");
      expect(ts.calls.filter((called) => called === method)).toHaveLength(1);
    }
    await router.stop();
  });

  it("owns workspace mutations in TypeScript and serializes scans with exclusions", async () => {
    const ts = new Host();
    const router = new RuntimeRouter(ts);
    await router.start();
    const scanning = gate();
    const plan = { id: "workspace", path: "/fixture/project", sources: [] };
    const inspection = { summary: null, assets: [], error: null };
    ts.handler = (method, params) => {
      if (method === BACKEND_INSPECT)
        return scanning.promise.then(() => [{ id: "workspace", inspection }]);
      if (method === BACKEND_PLAN_WORKSPACE) return plan;
      if (method === RUNTIME_METHODS.addWorkspace) {
        expect(params).toMatchObject({ _plan: plan, _inspection: inspection });
        return { id: "workspace" };
      }
      return null;
    };
    const adding = router.request(RUNTIME_METHODS.addWorkspace, {
      path: "/fixture/project",
      _plan: { injected: true },
    });
    const excluding = router.request(RUNTIME_METHODS.excludeWorkspace, { id: "workspace" });
    await vi.waitFor(() => expect(ts.calls).toContain(BACKEND_INSPECT));
    expect(ts.calls).not.toContain(RUNTIME_METHODS.excludeWorkspace);
    scanning.resolve();
    expect(await adding).toEqual({ id: "workspace" });
    expect(await excluding).toBeNull();
    expect(ts.calls.filter((method) => method === RUNTIME_METHODS.addWorkspace)).toHaveLength(1);
    expect(ts.calls.filter((method) => method === RUNTIME_METHODS.excludeWorkspace)).toHaveLength(
      1,
    );
    await router.stop();
  });

  it("keeps discovery persistence in TypeScript and fences a crash-interrupted operation", async () => {
    const ts = new Host();
    const router = new RuntimeRouter(ts);
    await router.start();
    const snapshot = {
      candidates: [],
      installations: [],
      home_assets: [],
      errors: [],
      source_diagnostics: [],
    };
    const plan = { workspaces: [], managed_homes: [] };
    const scanning = gate();
    let interrupted = false;
    ts.handler = (method, params) => {
      if (method === RUNTIME_METHODS.listScanRoots)
        return [
          { path: "/enabled", enabled: true, max_depth: 3 },
          { path: "/disabled", enabled: false, max_depth: 8 },
        ];
      if (method === NATIVE_SCAN_ROOT_DISCOVERY) {
        expect(params).toEqual({ roots: [{ path: "/enabled", max_depth: 3 }] });
        return { candidates: [], errors: [], source_diagnostics: [] };
      }
      if (method === NATIVE_CONFIGURED_DISCOVERY)
        return {
          candidates: [],
          errors: [],
          source_diagnostics: [],
          home_assets: [],
          installations: [],
        };
      if (method === NATIVE_CONTEXT) return { agent_homes: [], agentkib_home: null };
      if (method === BACKEND_INSPECT) return interrupted ? scanning.promise.then(() => []) : [];
      if (method === BACKEND_PLAN_DISCOVERY) return plan;
      if (method === RUNTIME_METHODS.refreshDiscovery) {
        expect(params).toMatchObject({ _plan: plan, _snapshot: snapshot, _inspections: [] });
        return { kind: "discovery" };
      }
      return null;
    };
    expect(await router.request(RUNTIME_METHODS.refreshDiscovery, {})).toEqual({
      kind: "discovery",
    });
    expect(ts.calls.filter((method) => method === RUNTIME_METHODS.refreshDiscovery)).toHaveLength(
      1,
    );
    interrupted = true;
    const pending = expect(
      router.request(RUNTIME_METHODS.refreshDiscovery, {}),
    ).rejects.toBeInstanceOf(RuntimeUnavailableError);
    await vi.waitFor(() =>
      expect(ts.calls.filter((method) => method === BACKEND_INSPECT)).toHaveLength(2),
    );
    ts.crash();
    scanning.resolve();
    await pending;
    expect(ts.calls.filter((method) => method === RUNTIME_METHODS.refreshDiscovery)).toHaveLength(
      1,
    );
    await router.stop();
  });

  it("writes and refreshes the session index through the TypeScript host", async () => {
    const ts = new Host();
    const router = new RuntimeRouter(ts);
    await router.start();
    ts.handler = () => ({ session_index_enabled: false });
    const result = await router.request(RUNTIME_METHODS.setSessionIndexEnabled, { enabled: false });
    expect(result).toMatchObject({ session_index_enabled: false });
    expect(ts.calls).toContain(RUNTIME_METHODS.setSessionIndexEnabled);
    ts.calls.length = 0;
    await router.request(RUNTIME_METHODS.refreshWorkspaceSessions, { workspaceId: "workspace" });
    expect(ts.calls).toContain(RUNTIME_METHODS.refreshWorkspaceSessions);
    expect(
      ts.calls.filter((method) => method === RUNTIME_METHODS.refreshWorkspaceSessions),
    ).toHaveLength(1);
    await router.request(RUNTIME_METHODS.clearSessionIndex, { workspaceId: "workspace" });
    expect(ts.calls).toContain(RUNTIME_METHODS.clearSessionIndex);
    await router.stop();
  });

  it("reinitializes the TypeScript backend after process recovery", async () => {
    const ts = new Host();
    const router = new RuntimeRouter(ts);
    await router.start();
    ts.crash();
    const waiting = router.request(RUNTIME_METHODS.runtimeInfo, {});
    expect(router.status.state).toBe("restarting");
    ts.ready();
    expect(await waiting).toMatchObject({
      data_dir: "/fixture",
      session_index_enabled: true,
    });
    expect(ts.calls.filter((method) => method === BACKEND_INITIALIZE)).toHaveLength(2);
    expect(ts.retry).not.toHaveBeenCalled();
    await router.stop();
  });

  it("keeps terminal failures until manual retry even if the host emits ready", async () => {
    const ts = new Host();
    const router = new RuntimeRouter(ts);
    await router.start();
    ts.status = { state: "failed", restartCount: 3, error: "crash loop" };
    ts.emit("state", ts.status);
    ts.ready();
    await expect(router.request(RUNTIME_METHODS.runtimeInfo, {})).rejects.toBeInstanceOf(
      RuntimeUnavailableError,
    );
    expect(router.status.state).toBe("failed");
    await router.retry();
    expect(router.status.state).toBe("ready");
    await router.stop();
  });

  it("cancels queued requests and cannot become ready after shutdown", async () => {
    const ts = new Host();
    const initialized = gate();
    ts.handler = (method) => (method === BACKEND_INITIALIZE ? initialized.promise : undefined);
    const router = new RuntimeRouter(ts, "/fixture");
    const starting = expect(router.start()).rejects.toBeInstanceOf(RuntimeUnavailableError);
    const waiting = expect(
      router.request(RUNTIME_METHODS.listWorkspaces, {}),
    ).rejects.toBeInstanceOf(RuntimeUnavailableError);
    await vi.waitFor(() => expect(ts.calls).toContain(BACKEND_INITIALIZE));
    await router.stop();
    initialized.resolve();
    await Promise.all([starting, waiting]);
    expect(router.status.state).toBe("stopping");
    expect(ts.stop).toHaveBeenCalledTimes(1);
  });
});
