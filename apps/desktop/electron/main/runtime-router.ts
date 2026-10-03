import { EventEmitter } from "node:events";
import {
  BACKEND_INITIALIZE,
  TYPESCRIPT_READ_METHODS,
  TYPESCRIPT_PREFERENCE_METHODS,
  PREFERENCE_WRITE_METHODS,
  TYPESCRIPT_WORKSPACE_METHODS,
  TYPESCRIPT_WORKSPACE_OPENER_METHODS,
  TYPESCRIPT_GIT_METHODS,
  TYPESCRIPT_CATALOG_METHODS,
  BACKEND_PLAN_WORKSPACE,
  BACKEND_PLAN_DISCOVERY,
  NATIVE_CONTEXT,
  NATIVE_SCAN_ROOT_DISCOVERY,
  NATIVE_CONFIGURED_DISCOVERY,
  BACKEND_INSPECT,
  TYPESCRIPT_ASSET_METHODS,
  TYPESCRIPT_INSIGHT_METHODS,
  TYPESCRIPT_SESSION_READ_METHODS,
  TYPESCRIPT_SESSION_INDEX_METHODS,
  TYPESCRIPT_SESSION_HANDOFF_METHODS,
  TYPESCRIPT_OBSIDIAN_METHODS,
  TYPESCRIPT_SKILL_METHODS,
  TYPESCRIPT_AGENT_TOOL_METHODS,
  TYPESCRIPT_MCP_METHODS,
  TYPESCRIPT_REMOTE_GATEWAY_METHODS,
  TYPESCRIPT_STORAGE_METHODS,
  TYPESCRIPT_QUOTA_METHODS,
  type NativeContext,
  type WorkspacePlan,
  type InspectedWorkspace,
  type DiscoverySnapshot,
  type DiscoveryPlan,
} from "@agentkib/backend/migration";
import { RUNTIME_METHODS, type RuntimeHandshakeResult } from "../generated/runtime-protocol";
import {
  RuntimeUnavailableError,
  type RuntimeHost,
  type RuntimeHostState,
  type RuntimeHostStatus,
} from "./runtime-host";

/** Own each method explicitly; failures are returned to the caller without replay. */
export class RuntimeRouter extends EventEmitter implements RuntimeHost {
  #state: RuntimeHostState = "stopping";
  #readiness = readyCycle();
  #generation = 0;
  #initializing?: symbol;
  #handshake?: RuntimeHandshakeResult;
  #typescriptHandshake?: RuntimeHandshakeResult;
  #error?: Error;
  #preferenceWrites: Promise<void> = Promise.resolve();
  #workspaceWrites: Promise<void> = Promise.resolve();

  readonly typescript: RuntimeHost;
  readonly dataDir?: string;

  constructor(typescript: RuntimeHost, dataDir?: string) {
    super();
    this.typescript = typescript;
    this.dataDir = dataDir;
    for (const host of [this.typescript]) {
      host.on("ready", (handshake: RuntimeHandshakeResult) => {
        this.#typescriptHandshake = handshake;
        this.#initialize();
      });
      host.on("state", (status: RuntimeHostStatus) => {
        if (this.#state === "stopping") return;
        if (status.state === "failed") this.#fail(new Error(status.error ?? "Backend failed"));
        else this.emit("state", this.status);
      });
      host.on("exit", (event: { expected: boolean }) => {
        if (this.#state !== "stopping" && !event.expected) {
          this.#generation += 1;
          this.#initializing = undefined;
          if (this.#state === "ready") this.#readiness = readyCycle();
          this.#handshake = undefined;
          this.#typescriptHandshake = undefined;
          if (this.#state !== "failed") this.#setState("restarting");
        }
        this.emit("exit", event);
      });
      for (const event of ["notification", "protocol-error", "restart-error", "crash-loop"]) {
        host.on(event, (...args: unknown[]) => this.emit(event, ...args));
      }
    }
  }

  get status(): RuntimeHostStatus {
    return {
      state: this.#state,
      restartCount: this.typescript.status.restartCount,
      ...(this.#error ? { error: this.#error.message } : {}),
    };
  }

  async start(): Promise<RuntimeHandshakeResult> {
    if (this.#state !== "stopping") throw new Error("AgentKib runtime has already been started");
    this.#readiness = readyCycle();
    this.#error = undefined;
    this.#generation += 1;
    const generation = this.#generation;
    this.#setState("starting");
    void this.typescript.start().catch((error: unknown) => {
      if (generation === this.#generation && this.#state !== "stopping") this.#fail(asError(error));
    });
    return this.#readiness.promise;
  }

  async retry(): Promise<RuntimeHandshakeResult> {
    if (this.#state === "ready") return this.#handshake!;
    if (this.#state !== "failed") return this.#readiness.promise;
    this.#readiness = readyCycle();
    this.#error = undefined;
    this.#generation += 1;
    const generation = this.#generation;
    this.#setState("starting");
    void this.typescript
      .retry()
      .then(() => this.#initialize())
      .catch((error: unknown) => {
        if (generation === this.#generation && this.#state !== "stopping")
          this.#fail(asError(error));
      });
    return this.#readiness.promise;
  }

  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    const execute = async () => {
      await this.#waitUntilReady();
      return this.#dispatch<TResult>(method, params);
    };
    // Snapshot reads must not observe a concurrent writer's partial update.
    if (
      PREFERENCE_WRITE_METHODS.has(method) ||
      method === RUNTIME_METHODS.runtimeInfo ||
      method === RUNTIME_METHODS.quotaPreferences
    ) {
      const result = this.#preferenceWrites.then(execute);
      this.#preferenceWrites = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }
    // Native scans happen outside SQLite transactions; serialize mutations so their plans stay current.
    if (TYPESCRIPT_WORKSPACE_METHODS.has(method) || method === RUNTIME_METHODS.applyChanges) {
      const result = this.#workspaceWrites.then(execute);
      this.#workspaceWrites = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }
    return execute();
  }

  async stop(): Promise<void> {
    if (this.#state === "stopping") return;
    this.#generation += 1;
    this.#setState("stopping");
    this.#readiness.reject(new RuntimeUnavailableError(new Error("AgentKib runtime is stopping")));
    const results = await Promise.allSettled([this.typescript.stop()]);
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length)
      throw new AggregateError(
        failed.map((result) => result.reason),
        "Backend shutdown failed",
      );
  }

  async #waitUntilReady(): Promise<void> {
    while (this.#state === "starting" || this.#state === "restarting")
      await this.#readiness.promise;
    if (this.#state !== "ready")
      throw new RuntimeUnavailableError(this.#error ?? new Error("AgentKib runtime is stopping"));
  }

  async #dispatch<TResult>(method: string, params: unknown): Promise<TResult> {
    if (method === NATIVE_CONTEXT) return this.typescript.request<TResult>(method, params);
    if (method === RUNTIME_METHODS.relayCreateCsr)
      return this.typescript.request<TResult>(method, params);
    if (method === RUNTIME_METHODS.remoteRequest)
      return this.typescript.request<TResult>(method, params);
    if (method === RUNTIME_METHODS.controlReceipt)
      return this.typescript.request<TResult>(method, params);
    if (method === RUNTIME_METHODS.claudeManaged) {
      return this.typescript.request<TResult>(method, params);
    }
    if (
      method === RUNTIME_METHODS.codexManaged &&
      typeof params === "object" &&
      params !== null &&
      !Array.isArray(params) &&
      "operation" in params &&
      [
        "options",
        "create",
        "adopt",
        "release",
        "reconcile",
        "resume",
        "queue-list",
        "unarchive",
        "settings-state",
        "capabilities",
        "inspect",
        "send",
        "stop",
        "approve",
        "answer",
        "steer",
        "queue-add",
        "queue-update",
        "queue-delete",
        "queue-reorder",
        "rename",
        "archive",
        "settings",
        "goal-set",
        "goal-pause",
        "goal-resume",
        "goal-clear",
        "fork",
      ].includes(String(params.operation))
    ) {
      return this.typescript.request<TResult>(method, params);
    }
    if (
      method === RUNTIME_METHODS.webRequest &&
      typeof params === "object" &&
      params !== null &&
      !Array.isArray(params) &&
      "operation" in params &&
      [
        "live",
        "capabilities",
        "inspect",
        "resume",
        "queue-list",
        "unarchive",
        "settings-state",
        "send",
        "stop",
        "approve",
        "answer",
        "steer",
        "queue-add",
        "queue-update",
        "queue-delete",
        "queue-reorder",
        "rename",
        "archive",
        "settings",
        "goal-set",
        "goal-pause",
        "goal-resume",
        "goal-clear",
        "fork",
      ].includes(String(params.operation))
    ) {
      return this.typescript.request<TResult>(method, params);
    }
    if (
      method === RUNTIME_METHODS.webRequest &&
      typeof params === "object" &&
      params !== null &&
      !Array.isArray(params) &&
      "operation" in params &&
      ["diff", "catalog", "events", "context", "usage", "goal", "resources"].includes(
        String(params.operation),
      )
    )
      return this.typescript.request<TResult>(method, params);
    if (
      method === RUNTIME_METHODS.prepareSessionHandoff ||
      method === RUNTIME_METHODS.planSessionHandoff ||
      method === RUNTIME_METHODS.planSessionMcpConnection ||
      method === RUNTIME_METHODS.planMcpMigration
    ) {
      const mcpHubStatus = await this.typescript.request<unknown>(RUNTIME_METHODS.mcpHubStatus, {});
      const values =
        typeof params === "object" && params !== null && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};
      return this.typescript.request<TResult>(method, { ...values, mcpHubStatus });
    }
    if (TYPESCRIPT_WORKSPACE_METHODS.has(method))
      return this.#workspaceRequest<TResult>(method, params);
    if (method === RUNTIME_METHODS.setQuotaPreferences)
      return this.typescript.request<TResult>(method, params);
    if (TYPESCRIPT_SESSION_INDEX_METHODS.has(method)) {
      return this.typescript.request<TResult>(method, params);
    }
    if (
      TYPESCRIPT_READ_METHODS.has(method) ||
      TYPESCRIPT_GIT_METHODS.has(method) ||
      TYPESCRIPT_CATALOG_METHODS.has(method) ||
      TYPESCRIPT_ASSET_METHODS.has(method) ||
      TYPESCRIPT_INSIGHT_METHODS.has(method) ||
      TYPESCRIPT_SESSION_READ_METHODS.has(method) ||
      TYPESCRIPT_SESSION_INDEX_METHODS.has(method) ||
      TYPESCRIPT_SESSION_HANDOFF_METHODS.has(method) ||
      TYPESCRIPT_OBSIDIAN_METHODS.has(method) ||
      TYPESCRIPT_SKILL_METHODS.has(method) ||
      TYPESCRIPT_AGENT_TOOL_METHODS.has(method) ||
      TYPESCRIPT_MCP_METHODS.has(method) ||
      TYPESCRIPT_REMOTE_GATEWAY_METHODS.has(method) ||
      TYPESCRIPT_STORAGE_METHODS.has(method) ||
      TYPESCRIPT_QUOTA_METHODS.has(method)
    )
      return this.typescript.request<TResult>(method, params);
    if (TYPESCRIPT_WORKSPACE_OPENER_METHODS.has(method))
      return this.typescript.request<TResult>(method, params);
    if (TYPESCRIPT_PREFERENCE_METHODS.has(method) || method === RUNTIME_METHODS.runtimeInfo)
      return this.typescript.request<TResult>(method, params);
    throw new RuntimeUnavailableError(
      new Error(`No backend owner is registered for runtime method ${method}`),
    );
  }

  async #workspaceRequest<TResult>(method: string, params: unknown): Promise<TResult> {
    const generation = this.#generation;
    const current = () => {
      if (generation !== this.#generation || this.#state !== "ready")
        throw new RuntimeUnavailableError(new Error("Backend changed during workspace operation"));
    };
    if (typeof params !== "object" || params === null || Array.isArray(params))
      return this.typescript.request<TResult>(method, params);
    const values = params as Record<string, unknown>;
    if (method === RUNTIME_METHODS.addWorkspace || method === RUNTIME_METHODS.refreshWorkspace) {
      const context =
        method === RUNTIME_METHODS.addWorkspace
          ? await this.typescript.request<NativeContext>(NATIVE_CONTEXT, {})
          : { agent_homes: [], agentkib_home: null };
      current();
      const plan = await this.typescript.request<WorkspacePlan>(BACKEND_PLAN_WORKSPACE, {
        ...values,
        operation: method === RUNTIME_METHODS.addWorkspace ? "add" : "refresh",
        context,
      });
      current();
      const scans = await this.typescript.request<InspectedWorkspace[]>(BACKEND_INSPECT, {
        workspaces: [{ id: plan.id, path: plan.path }],
      });
      if (scans.length !== 1 || scans[0]?.id !== plan.id)
        throw new Error("Incomplete native workspace inspection");
      current();
      return this.typescript.request<TResult>(method, {
        ...values,
        _plan: plan,
        _inspection: scans[0].inspection,
      });
    }
    if (method === RUNTIME_METHODS.refreshDiscovery) {
      const queuedAt = new Date().toISOString().replace(".000Z", "Z");
      const startedAt = new Date().toISOString().replace(".000Z", "Z");
      const roots = await this.typescript.request<
        { path: string; enabled: boolean; max_depth: number }[]
      >(RUNTIME_METHODS.listScanRoots, {});
      current();
      const enabledRoots = roots
        .filter((root) => root.enabled)
        .map((root) => ({ path: root.path, max_depth: root.max_depth }));
      const [scanRoots, configured] = await Promise.all([
        this.typescript.request<
          Pick<DiscoverySnapshot, "candidates" | "errors" | "source_diagnostics">
        >(NATIVE_SCAN_ROOT_DISCOVERY, { roots: enabledRoots }),
        this.typescript.request<
          Pick<
            DiscoverySnapshot,
            | "candidates"
            | "errors"
            | "source_diagnostics"
            | "home_assets"
            | "installations"
            | "non_workspace_paths"
          >
        >(NATIVE_CONFIGURED_DISCOVERY, {}),
      ]);
      const snapshot: DiscoverySnapshot = {
        non_workspace_paths: configured.non_workspace_paths,
        candidates: [...scanRoots.candidates, ...configured.candidates],
        installations: configured.installations,
        home_assets: configured.home_assets,
        errors: [...scanRoots.errors, ...configured.errors],
        source_diagnostics: [...scanRoots.source_diagnostics, ...configured.source_diagnostics],
      };
      current();
      const context = await this.typescript.request<NativeContext>(NATIVE_CONTEXT, {});
      current();
      const plan = await this.typescript.request<DiscoveryPlan>(BACKEND_PLAN_DISCOVERY, {
        snapshot,
        context,
      });
      current();
      const inspections = await this.typescript.request<InspectedWorkspace[]>(BACKEND_INSPECT, {
        workspaces: plan.workspaces.map(({ id, path }) => ({ id, path })),
      });
      current();
      return this.typescript.request<TResult>(method, {
        ...values,
        _plan: plan,
        _snapshot: snapshot,
        _inspections: inspections,
        _queuedAt: queuedAt,
        _startedAt: startedAt,
      });
    }
    return this.typescript.request<TResult>(method, params);
  }

  #initialize(): void {
    if (
      this.#state === "stopping" ||
      this.#state === "failed" ||
      this.#state === "ready" ||
      this.#initializing ||
      this.typescript.status.state !== "ready"
    )
      return;
    const generation = this.#generation;
    const attempt = Symbol();
    this.#initializing = attempt;
    void (async () => {
      const dataDir =
        this.dataDir ??
        (await this.typescript.request<{ data_dir: string }>(RUNTIME_METHODS.runtimeInfo, {}))
          .data_dir;
      if (!dataDir) throw new Error("TypeScript backend data directory is unavailable");
      await this.typescript.request(BACKEND_INITIALIZE, { dataDir });
      if (generation !== this.#generation || this.#state === "stopping") return;
      const handshake = this.#typescriptHandshake;
      if (!handshake) throw new Error("TypeScript backend handshake is unavailable");
      this.#handshake = {
        ...handshake,
        capabilities: [
          ...handshake.capabilities,
          "typescript-preferences",
          "typescript-cached-reads",
          "typescript-workspaces",
        ],
      };
      this.#error = undefined;
      this.#setState("ready");
      this.#readiness.resolve(this.#handshake);
      this.emit("ready", this.#handshake);
    })()
      .catch((error: unknown) => {
        if (
          generation === this.#generation &&
          this.#state !== "stopping" &&
          this.typescript.status.state === "ready"
        )
          this.#fail(asError(error));
      })
      .finally(() => {
        if (this.#initializing === attempt) this.#initializing = undefined;
      });
  }

  #fail(error: Error): void {
    this.#error = error;
    this.#setState("failed");
    this.#readiness.reject(new RuntimeUnavailableError(error));
  }

  #setState(state: RuntimeHostState): void {
    this.#state = state;
    this.emit("state", this.status);
  }
}

function readyCycle() {
  let resolve!: (value: RuntimeHandshakeResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<RuntimeHandshakeResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
