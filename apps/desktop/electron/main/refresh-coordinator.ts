import type {
  DiscoveryReport,
  InsightsStatus,
  QuotaCollectorStatus,
  QuotaSnapshot,
  RefreshJobStatus,
  RefreshKind,
  RefreshReceipt,
  RemoteGatewaySummary,
  RuntimeInfo,
} from "../../src/core/types";
import { RUNTIME_METHODS } from "../generated/runtime-protocol";
import { RuntimeUnavailableError, type DesktopRuntimeHost } from "./runtime-host";

const REFRESH_KINDS: RefreshKind[] = ["discovery", "insights", "gateways", "quota", "storage"];
const SCHEDULER_INTERVAL_MS = 60_000;
const DISCOVERY_INITIAL_DELAY_MS = 3_000;
const GATEWAYS_INITIAL_DELAY_MS = 5_000;
const INSIGHTS_INITIAL_DELAY_MS = 30_000;
const QUOTA_INITIAL_DELAY_MS = 1_000;
const DISCOVERY_MAX_AGE_MS = 15 * 60_000;
const GATEWAYS_MAX_AGE_MS = 15 * 60_000;
const INSIGHTS_MAX_AGE_MS = 30 * 60_000;
const QUOTA_VISIBLE_MAX_AGE_MS = 5 * 60_000;
const QUOTA_BACKGROUND_MAX_AGE_MS = 15 * 60_000;
export interface QuotaScheduleState {
  failures: number;
  lastAttemptAt?: string;
  nextAllowedAt?: string;
}

interface RefreshCoordinatorOptions {
  runtime(): DesktopRuntimeHost;
  loadQuotaSchedule?(): Promise<QuotaScheduleState | undefined>;
  saveQuotaSchedule?(state: QuotaScheduleState): Promise<void>;
  isMainWindowVisible(): boolean;
  onStatus(status: RefreshJobStatus): void;
  onQuotaSnapshot(snapshot: QuotaSnapshot): void;
}

interface JobRecord {
  status: RefreshJobStatus;
  failures: number;
}

export class ElectronRefreshCoordinator {
  readonly #options: RefreshCoordinatorOptions;
  readonly #jobs = new Map<RefreshKind, JobRecord>(
    REFRESH_KINDS.map((kind) => [kind, { status: idleStatus(kind), failures: 0 }]),
  );
  readonly #active = new Map<RefreshKind, Promise<RefreshReceipt>>();
  readonly #initializedLocalKinds = new Set<RefreshKind>();
  readonly #manualRequests = new Set<RefreshKind>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #refreshLane: Promise<void> = Promise.resolve();
  #sequence = 1;
  #accepting = false;
  #runtimeAvailable = true;
  #suspended = false;
  #resumeTimer?: NodeJS.Timeout;
  #quotaLastAttemptAt?: string;

  constructor(options: RefreshCoordinatorOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#accepting) return;
    this.#accepting = true;
    void Promise.all([this.#seedFreshness(), this.#restoreQuotaSchedule()])
      .catch(() => undefined)
      .finally(() => {
        if (!this.#accepting || this.#suspended) return;
        this.#schedule("quota", QUOTA_INITIAL_DELAY_MS);
        this.#schedule("discovery", DISCOVERY_INITIAL_DELAY_MS);
        this.#schedule("gateways", GATEWAYS_INITIAL_DELAY_MS);
        this.#schedule("insights", INSIGHTS_INITIAL_DELAY_MS);
      });
  }

  stop(): void {
    this.#accepting = false;
    clearTimeout(this.#resumeTimer);
    for (const timer of this.#timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.#timers.clear();
  }

  setRuntimeAvailable(available: boolean): void {
    this.#runtimeAvailable = available;
    if (!available) return;
    this.activityChanged();
  }

  setSuspended(suspended: boolean): void {
    if (this.#suspended === suspended) return;
    this.#suspended = suspended;
    if (suspended) {
      for (const timer of this.#timers) clearTimeout(timer);
      this.#timers.clear();
    } else if (this.#accepting) {
      for (const kind of ["quota", "discovery", "gateways", "insights"] as const)
        this.#schedule(kind, 2_000);
    }
    this.activityChanged();
  }

  activityChanged(): void {
    clearTimeout(this.#resumeTimer);
    this.#resumeTimer = undefined;
    if (!this.#accepting || this.#suspended) return;
    this.#resumeTimer = setTimeout(() => {
      this.#resumeTimer = undefined;
      void this.refreshIfDue();
    }, 2_000);
  }

  statuses(): RefreshJobStatus[] {
    return REFRESH_KINDS.map((kind) => ({ ...this.#record(kind).status }));
  }

  request(kind: RefreshKind, force = false, automatic = false): Promise<RefreshReceipt> {
    const active = this.#active.get(kind);
    if (active) {
      if (!automatic) this.#manualRequests.add(kind);
      const status = { ...this.#record(kind).status };
      return Promise.resolve({
        kind,
        disposition: "already-running",
        request_id: status.request_id ?? this.#requestId(kind),
        status,
      });
    }
    if (!this.#accepting) return Promise.reject(new Error("Refresh coordinator is shutting down"));
    if (!this.#runtimeAvailable) return Promise.reject(new Error("AgentKib runtime is restarting"));

    const record = this.#record(kind);
    const now = Date.now();
    const nextAllowedAt = parseTime(record.status.next_allowed_at);
    if (!force && Number.isFinite(nextAllowedAt) && nextAllowedAt > now) {
      record.status = { ...record.status, state: "backoff" };
      this.#emit(record.status);
      return Promise.resolve({
        kind,
        disposition: "backoff",
        request_id: record.status.request_id ?? this.#requestId(kind),
        status: { ...record.status },
      });
    }

    const previousNextAllowed = record.status.next_allowed_at;
    const requestId = this.#requestId(kind);
    const queuedAt = new Date().toISOString();
    record.status = {
      kind,
      state: "queued",
      request_id: requestId,
      queued_at: queuedAt,
      progress_current: 0,
      progress_total: 1,
    };
    this.#emit(record.status);

    const promise = this.#enqueue(() =>
      this.#execute(kind, requestId, automatic, previousNextAllowed),
    );
    this.#active.set(kind, promise);
    void promise
      .finally(() => {
        if (this.#active.get(kind) === promise) {
          this.#active.delete(kind);
          this.#manualRequests.delete(kind);
        }
      })
      .catch(() => undefined);
    return promise;
  }

  async requestAll(force = false): Promise<RefreshReceipt[]> {
    return Promise.all(
      (["discovery", "insights", "gateways", "quota"] satisfies RefreshKind[]).map((kind) =>
        this.request(kind, force),
      ),
    );
  }

  async refreshIfDue(): Promise<void> {
    await Promise.allSettled(
      (["discovery", "insights", "gateways", "quota"] as const).map((kind) =>
        this.#requestScheduled(kind),
      ),
    );
  }

  async #execute(
    kind: RefreshKind,
    requestId: string,
    automatic: boolean,
    previousNextAllowed: string | undefined,
  ): Promise<RefreshReceipt> {
    const record = this.#record(kind);
    const wasInitialized = this.#initializedLocalKinds.has(kind);
    const previousQuotaAttempt = this.#quotaLastAttemptAt;
    try {
      if (automatic && !this.#manualRequests.has(kind) && !(await this.#automaticAllowed(kind))) {
        record.status = { ...record.status, state: "idle" };
        this.#emit(record.status);
        return {
          kind,
          disposition: "backoff",
          request_id: requestId,
          status: { ...record.status },
        };
      }
      if (!this.#accepting) throw new Error("Refresh coordinator is shutting down");
      if (!this.#runtimeAvailable)
        throw new RuntimeUnavailableError(new Error("AgentKib runtime is restarting"));
      if (kind === "discovery" || kind === "insights") this.#initializedLocalKinds.add(kind);
      const startedAt = new Date().toISOString();
      record.status = {
        ...record.status,
        state: "running",
        started_at: startedAt,
      };
      this.#emit(record.status);
      if (kind === "quota") {
        this.#quotaLastAttemptAt = startedAt;
        await this.#persistQuotaSchedule();
      }

      if (kind === "gateways") await this.#refreshGateways(record);
      else await this.#requestRuntimeRefresh(kind);
      if (kind === "quota") await this.#emitLatestQuotaSnapshot();

      record.failures = 0;
      record.status = {
        ...record.status,
        state: "succeeded",
        finished_at: new Date().toISOString(),
        progress_current: record.status.progress_total,
        error: undefined,
        next_allowed_at: undefined,
      };
      if (kind === "quota") await this.#persistQuotaSchedule();
      this.#emit(record.status);
      return {
        kind,
        disposition: "queued",
        request_id: requestId,
        status: { ...record.status },
      };
    } catch (error) {
      const unavailable = error instanceof RuntimeUnavailableError;
      if (unavailable) {
        if (!wasInitialized) this.#initializedLocalKinds.delete(kind);
        if (kind === "quota") this.#quotaLastAttemptAt = previousQuotaAttempt;
      } else record.failures += 1;
      const nextAllowedAt = unavailable
        ? previousNextAllowed
        : new Date(Date.now() + backoffDelay(record.failures)).toISOString();
      record.status = {
        ...record.status,
        state: "failed",
        finished_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        next_allowed_at: nextAllowedAt,
      };
      if (kind === "quota") await this.#persistQuotaSchedule();
      this.#emit(record.status);
      throw error;
    }
  }

  #enqueue(operation: () => Promise<RefreshReceipt>): Promise<RefreshReceipt> {
    const result = this.#refreshLane.catch(() => undefined).then(operation);
    this.#refreshLane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #requestRuntimeRefresh(kind: Exclude<RefreshKind, "gateways">): Promise<unknown> {
    const method = {
      discovery: RUNTIME_METHODS.refreshDiscovery,
      insights: RUNTIME_METHODS.refreshInsights,
      quota: RUNTIME_METHODS.refreshQuota,
      storage: RUNTIME_METHODS.refreshStorage,
    }[kind];
    return this.#options.runtime().request(method, {});
  }

  async #refreshGateways(record: JobRecord): Promise<void> {
    const runtime = this.#options.runtime();
    const gateways = await runtime.request<RemoteGatewaySummary[]>(
      RUNTIME_METHODS.listRemoteGateways,
      {},
    );
    record.status = {
      ...record.status,
      progress_current: 0,
      progress_total: gateways.length,
    };
    this.#emit(record.status);
    for (const [index, gateway] of gateways.entries()) {
      await runtime.request(RUNTIME_METHODS.refreshRemoteGateway, { id: gateway.id });
      record.status = { ...record.status, progress_current: index + 1 };
      this.#emit(record.status);
    }
  }

  async #emitLatestQuotaSnapshot(): Promise<void> {
    const snapshot = await this.#options
      .runtime()
      .request<QuotaSnapshot | undefined>(RUNTIME_METHODS.quotaSnapshot, {});
    if (snapshot) this.#options.onQuotaSnapshot(snapshot);
  }

  async #seedFreshness(): Promise<void> {
    if (!this.#runtimeAvailable) return;
    const runtime = this.#options.runtime();
    const [discovery, insights, quota, gateways] = await Promise.allSettled([
      runtime.request<DiscoveryReport | undefined>(RUNTIME_METHODS.discoveryReport, {}),
      runtime.request<InsightsStatus>(RUNTIME_METHODS.insightsStatus, {}),
      runtime.request<QuotaCollectorStatus>(RUNTIME_METHODS.quotaCollectorStatus, {}),
      runtime.request<RemoteGatewaySummary[]>(RUNTIME_METHODS.listRemoteGateways, {}),
    ]);
    if (discovery.status === "fulfilled") {
      this.#seed("discovery", discovery.value?.finished_at);
    }
    if (insights.status === "fulfilled") this.#seed("insights", insights.value.refreshed_at);
    if (quota.status === "fulfilled") this.#seed("quota", quota.value.last_success_at);
    if (gateways.status === "fulfilled" && gateways.value.length > 0) {
      const finishedAt = gateways.value
        .map((gateway) => gateway.last_connected_at)
        .filter((value): value is string => Boolean(value))
        .sort()[0];
      if (finishedAt && gateways.value.every((gateway) => gateway.last_connected_at)) {
        this.#seed("gateways", finishedAt);
      }
    }
  }

  #seed(kind: RefreshKind, finishedAt: string | undefined): void {
    if (!finishedAt) return;
    const record = this.#record(kind);
    if (kind === "discovery" || kind === "insights") this.#initializedLocalKinds.add(kind);
    record.status = { ...record.status, state: "succeeded", finished_at: finishedAt };
  }

  #schedule(kind: "discovery" | "insights" | "gateways" | "quota", initialDelay: number): void {
    const initial = setTimeout(() => {
      this.#timers.delete(initial);
      void this.#requestScheduled(kind).catch(() => undefined);
      if (!this.#accepting) return;
      const interval = setInterval(
        () => void this.#requestScheduled(kind).catch(() => undefined),
        SCHEDULER_INTERVAL_MS,
      );
      this.#timers.add(interval);
    }, initialDelay);
    this.#timers.add(initial);
  }

  async #requestScheduled(kind: "discovery" | "insights" | "gateways" | "quota"): Promise<void> {
    if (!(await this.#automaticAllowed(kind))) return;
    if (kind === "gateways") {
      if (await this.#gatewaysNeedRefresh())
        await this.request(kind, false, true).catch(() => undefined);
      return;
    }
    if (kind === "quota") {
      if (await this.#quotaNeedsRefresh())
        await this.request(kind, false, true).catch(() => undefined);
      return;
    }
    const maxAge = kind === "discovery" ? DISCOVERY_MAX_AGE_MS : INSIGHTS_MAX_AGE_MS;
    if (this.#isStale(kind, maxAge)) await this.request(kind, false, true).catch(() => undefined);
  }

  async #gatewaysNeedRefresh(): Promise<boolean> {
    if (!this.#isStale("gateways", GATEWAYS_MAX_AGE_MS)) return false;
    const gateways = await this.#options
      .runtime()
      .request<RemoteGatewaySummary[]>(RUNTIME_METHODS.listRemoteGateways, {});
    return gateways.length > 0;
  }

  async #automaticAllowed(kind: RefreshKind): Promise<boolean> {
    if (!this.#accepting || !this.#runtimeAvailable || this.#suspended || this.#resumeTimer)
      return false;
    const next = parseTime(this.#record(kind).status.next_allowed_at);
    if (Number.isFinite(next) && next > Date.now()) return false;
    if (kind === "discovery" || kind === "insights") {
      if (!this.#options.isMainWindowVisible()) return false;
      const info = await this.#options
        .runtime()
        .request<RuntimeInfo>(RUNTIME_METHODS.runtimeInfo, {});
      return info.local_auto_refresh_enabled !== false || !this.#initializedLocalKinds.has(kind);
    }
    if (kind === "quota") return this.#quotaNeedsRefresh();
    return true;
  }

  async #quotaNeedsRefresh(): Promise<boolean> {
    const runtime = this.#options.runtime();
    const info = await runtime.request<RuntimeInfo>(RUNTIME_METHODS.runtimeInfo, {});
    if (!info.quota_auto_refresh_enabled) return false;
    const collector = await runtime.request<QuotaCollectorStatus>(
      RUNTIME_METHODS.quotaCollectorStatus,
      {},
    );
    const last = Math.max(
      parseTime(this.#quotaLastAttemptAt) || 0,
      parseTime(collector.last_success_at) || 0,
    );
    const age = this.#options.isMainWindowVisible()
      ? QUOTA_VISIBLE_MAX_AGE_MS
      : QUOTA_BACKGROUND_MAX_AGE_MS;
    return !last || Date.now() - last >= age;
  }

  async #restoreQuotaSchedule(): Promise<void> {
    const state = await this.#options.loadQuotaSchedule?.().catch(() => undefined);
    if (!state || !Number.isInteger(state.failures) || state.failures < 0) return;
    const record = this.#record("quota");
    record.failures = state.failures;
    this.#quotaLastAttemptAt = state.lastAttemptAt;
    record.status.next_allowed_at = state.nextAllowedAt;
  }

  async #persistQuotaSchedule(): Promise<void> {
    const record = this.#record("quota");
    await this.#options
      .saveQuotaSchedule?.({
        failures: record.failures,
        lastAttemptAt: this.#quotaLastAttemptAt,
        nextAllowedAt: record.status.next_allowed_at,
      })
      .catch(() => undefined);
  }

  #isStale(kind: RefreshKind, maxAge: number): boolean {
    const record = this.#record(kind);
    if (record.status.state === "queued" || record.status.state === "running") return false;
    if (record.status.state === "failed" || record.status.state === "backoff") return true;
    const finishedAt = parseTime(record.status.finished_at);
    return !Number.isFinite(finishedAt) || Date.now() - finishedAt >= maxAge;
  }

  #record(kind: RefreshKind): JobRecord {
    const record = this.#jobs.get(kind);
    if (!record) throw new Error(`Unknown refresh kind: ${kind}`);
    return record;
  }

  #requestId(kind: RefreshKind): string {
    return `electron-${kind}-${Date.now()}-${this.#sequence++}`;
  }

  #emit(status: RefreshJobStatus): void {
    if (this.#accepting) this.#options.onStatus({ ...status });
  }
}

function idleStatus(kind: RefreshKind): RefreshJobStatus {
  return { kind, state: "idle" };
}

function parseTime(value: string | undefined): number {
  return value ? Date.parse(value) : Number.NaN;
}

function backoffDelay(failures: number): number {
  if (failures <= 1) return 5 * 60_000;
  if (failures === 2) return 15 * 60_000;
  if (failures === 3) return 30 * 60_000;
  return 60 * 60_000;
}
