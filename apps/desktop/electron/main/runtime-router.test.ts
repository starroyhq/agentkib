import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
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

describe("RuntimeRouter migration ownership and recovery", () => {
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
