import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  LocalCostProvider,
  LocalCostSnapshot,
  LocalCostStatus,
  LocalCostUpdate,
} from "@agentkib/runtime-protocol";
import type { Commands } from "./commands";
import type { BackendStore } from "./store";
import { localDay, parseLocalCosts, type CostBackend } from "./local-cost-parser";
import { claudeConfigDirVariable } from "./claude-config";

export interface PreparedCostCollector {
  environment: NodeJS.ProcessEnv;
  executable: string | null;
  timezone: string;
  scope_key: string;
}
interface CostJob {
  provider: LocalCostProvider;
  prepared: PreparedCostCollector;
  scope: string;
  generation: number;
  controller: AbortController;
}
const PAGE_MAX_AGE = 5 * 60_000;
const BACKGROUND_MAX_AGE = 15 * 60_000;

/** Costs are intentionally independent of quota RPCs and the global refresh lane. */
export class LocalCosts {
  #observed: LocalCostProvider | null = null;
  #automatic = false;
  #stopped = false;
  #generation = 0;
  #activityRevision = 0;
  #source = "";
  #active?: CostJob;
  #queue: CostJob[] = [];
  #known = new Set<LocalCostProvider>();
  #timer?: NodeJS.Timeout;
  #updating = false;

  constructor(
    readonly store: BackendStore,
    readonly commands: Commands,
    readonly backend: CostBackend,
    readonly prepare: () => Promise<PreparedCostCollector>,
    readonly notify: (method: string, params: unknown) => void,
  ) {
    // A restarted process cannot still own a running scanner. Retain its last success.
    for (const row of store.sql.rows(
      "SELECT scope_key,provider,status_json FROM local_cost_cache",
    )) {
      if (row.provider === "codex" || row.provider === "claude") this.#known.add(row.provider);
      const status = JSON.parse(String(row.status_json)) as LocalCostStatus;
      if (["queued", "running"].includes(status.state))
        this.#writeStatus({ ...status, state: "cancelled" });
    }
  }

  async snapshot(provider: LocalCostProvider): Promise<LocalCostSnapshot | undefined> {
    const { scope } = await this.#scope(provider);
    const row = this.store.sql.one(
      "SELECT snapshot_json FROM local_cost_cache WHERE scope_key=?",
      scope,
    );
    return typeof row?.snapshot_json === "string"
      ? currentDayProjection(JSON.parse(row.snapshot_json) as LocalCostSnapshot)
      : undefined;
  }

  async status(provider: LocalCostProvider): Promise<LocalCostStatus> {
    const { scope } = await this.#scope(provider);
    return this.#status(provider, scope);
  }

  async refresh(provider: LocalCostProvider, force = false): Promise<LocalCostStatus> {
    const activityRevision = this.#activityRevision;
    const { prepared, scope } = await this.#scope(provider);
    if (this.#stopped) throw new Error("cost collector is stopped");
    const previous = this.#status(provider, scope);
    if (activityRevision !== this.#activityRevision) return { ...previous, state: "cancelled" };
    if (
      (this.#active?.scope === scope && !this.#active.controller.signal.aborted) ||
      this.#queue.some((job) => job.scope === scope)
    )
      return previous;
    const last = Date.parse(
      previous.state === "cancelled"
        ? (previous.last_success_at ?? "")
        : (previous.last_attempt_at ?? previous.last_success_at ?? ""),
    );
    const maxAge = this.#observed === provider ? PAGE_MAX_AGE : BACKGROUND_MAX_AGE;
    const today = localDay(new Date(), prepared.timezone);
    const cached = this.store.sql.one(
      "SELECT snapshot_json FROM local_cost_cache WHERE scope_key=?",
      scope,
    );
    const cachedDay =
      typeof cached?.snapshot_json === "string"
        ? (JSON.parse(cached.snapshot_json) as LocalCostSnapshot).range_end
        : undefined;
    // An attempt made before midnight cannot make yesterday's `today` fresh.
    // A failed attempt already made today still keeps the usual retry interval.
    const dayChanged =
      this.#observed === provider &&
      cachedDay !== undefined &&
      cachedDay !== today &&
      (!Number.isFinite(last) || localDay(new Date(last), prepared.timezone) !== today);
    if (!force && !dayChanged && Number.isFinite(last) && Date.now() - last < maxAge)
      return previous;
    const job: CostJob = {
      provider,
      prepared,
      scope,
      generation: this.#generation,
      controller: new AbortController(),
    };
    this.#queue.push(job);
    this.#writeStatus({
      ...previous,
      state: "queued",
      last_attempt_at: new Date().toISOString(),
      error_key: undefined,
      error_detail: undefined,
    });
    this.#emit(provider, scope);
    void this.#drain();
    return this.#status(provider, scope);
  }

  async observe(provider: LocalCostProvider | null, autoRefresh: boolean): Promise<void> {
    this.#observed = provider;
    this.#automatic = autoRefresh;
    this.#applyScheduling();
    if (provider) await this.refresh(provider);
  }

  setAutomatic(enabled: boolean): void {
    this.#automatic = enabled;
    this.#applyScheduling();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#generation++;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#cancelAll();
  }

  #applyScheduling(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#stopped) return;
    if (!this.#observed && !this.#automatic) {
      this.#activityRevision++;
      this.#generation++;
      this.#cancelAll();
      return;
    }
    // The tick only queues due scopes; it never forces a scan or overlaps processes.
    this.#timer = setInterval(() => {
      void this.#tick();
    }, 60_000);
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
    if (this.#updating || this.#stopped) return;
    this.#updating = true;
    try {
      // refresh() may start the first job immediately; order before admission,
      // not just when choosing among jobs that are already waiting.
      const providers = [...this.#known].sort(
        (left, right) => Number(right === this.#observed) - Number(left === this.#observed),
      );
      for (const provider of providers)
        if (this.#automatic || this.#observed === provider) await this.refresh(provider);
    } catch {
      /* Preserve cached data; the next explicit request reports configuration failures. */
    } finally {
      this.#updating = false;
    }
  }

  async #scope(
    provider: LocalCostProvider,
  ): Promise<{ prepared: PreparedCostCollector; scope: string }> {
    if (this.#stopped) throw new Error("cost collector is stopped");
    const prepared = await this.prepare();
    if (this.#stopped) throw new Error("cost collector is stopped");
    const changed = this.#source && prepared.scope_key !== this.#source;
    if (changed) {
      this.#generation++;
      this.#cancelAll();
    }
    this.#source = prepared.scope_key;
    this.#known.add(provider);
    const scope = createHash("sha256")
      .update(`${provider}:${prepared.scope_key}:native-local:rolling30:v1`)
      .digest("hex");
    if (changed) this.#emit(provider, scope);
    return { prepared, scope };
  }

  #status(provider: LocalCostProvider, scope: string): LocalCostStatus {
    const row = this.store.sql.one(
      "SELECT status_json FROM local_cost_cache WHERE scope_key=?",
      scope,
    );
    return row
      ? (JSON.parse(String(row.status_json)) as LocalCostStatus)
      : { provider, scope_key: scope, state: "idle" };
  }

  #writeStatus(status: LocalCostStatus, snapshot?: LocalCostSnapshot): void {
    this.store.sql.run(
      "INSERT INTO local_cost_cache(scope_key,provider,status_json,snapshot_json) VALUES (?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET status_json=excluded.status_json,snapshot_json=COALESCE(excluded.snapshot_json,local_cost_cache.snapshot_json)",
      status.scope_key,
      status.provider,
      JSON.stringify(status),
      snapshot ? JSON.stringify(snapshot) : null,
    );
  }

  #emit(provider: LocalCostProvider, scope: string): void {
    if (this.#stopped) return;
    const row = this.store.sql.one(
      "SELECT snapshot_json FROM local_cost_cache WHERE scope_key=?",
      scope,
    );
    const update: LocalCostUpdate = {
      provider,
      status: this.#status(provider, scope),
      ...(typeof row?.snapshot_json === "string"
        ? { snapshot: currentDayProjection(JSON.parse(row.snapshot_json) as LocalCostSnapshot) }
        : {}),
    };
    this.notify("quota.costUpdated", update);
  }

  #cancelAll(): void {
    for (const job of this.#queue.splice(0)) this.#cancel(job);
    if (this.#active) this.#cancel(this.#active);
  }

  #cancel(job: CostJob): void {
    job.controller.abort(new Error("cost collection cancelled"));
    this.#writeStatus({ ...this.#status(job.provider, job.scope), state: "cancelled" });
    this.#emit(job.provider, job.scope);
  }

  async #drain(): Promise<void> {
    if (this.#active || this.#stopped) return;
    const selected = this.#queue.findIndex((job) => job.provider === this.#observed);
    const job = this.#queue.splice(Math.max(0, selected), 1)[0];
    if (!job) return;
    this.#active = job;
    this.#writeStatus({ ...this.#status(job.provider, job.scope), state: "running" });
    this.#emit(job.provider, job.scope);
    try {
      if (process.platform === "win32" && process.arch !== "x64")
        throw new Error("cost collector is not supported on this platform");
      if (!job.prepared.executable) throw new Error("cost collector sidecar is unavailable");
      const args = [
        "cost",
        "--provider",
        job.provider,
        "--days",
        "30",
        "--provider-native-only",
        "--agentkib-native-only",
        "--format",
        "json",
      ];
      if (this.backend !== "win-codex-bar") args.push("--json-only");
      const output = await this.commands.run(job.prepared.executable, args, {
        env: job.prepared.environment,
        timeout: 300_000,
        limit: 16 * 1024 * 1024,
        allowFailure: true,
        strictOutput: true,
        terminateDescendantsOnExit: true,
        signal: job.controller.signal,
      });
      if (this.#stopped || job.controller.signal.aborted || job.generation !== this.#generation)
        return;
      if (output.truncated || output.bytes.length > 16 * 1024 * 1024)
        throw new Error("cost output exceeds the 16 MiB limit");
      let snapshot: LocalCostSnapshot;
      try {
        snapshot = parseLocalCosts(output.bytes, this.backend, job.provider, {
          scope_key: job.scope,
          timezone: job.prepared.timezone,
        });
        if (!output.success) {
          snapshot.today.partial = true;
          snapshot.last_30_days.partial = true;
        }
      } catch (error) {
        if (
          !output.success &&
          /unknown|unexpected|unrecognized|unsupported.*argument/i.test(output.error)
        )
          throw new Error("cost collector options unsupported; update collector");
        throw error;
      }
      const current = await this.prepare();
      if (
        this.#stopped ||
        job.controller.signal.aborted ||
        job.generation !== this.#generation ||
        current.scope_key !== job.prepared.scope_key
      )
        return;
      this.#writeStatus(
        {
          ...this.#status(job.provider, job.scope),
          state: "succeeded",
          last_success_at: new Date().toISOString(),
          data_version: snapshot.data_version,
          error_key: undefined,
          error_detail: undefined,
        },
        snapshot,
      );
      this.#emit(job.provider, job.scope);
    } catch (error) {
      if (this.#stopped || job.controller.signal.aborted || job.generation !== this.#generation)
        return;
      const message = error instanceof Error ? error.message : "";
      // Upstream error payloads can contain paths and credentials; expose only our fixed diagnostics.
      const unsupported = /not supported on this platform/.test(message);
      const updateRequired = !unsupported && /unsupported|update collector/.test(message);
      const detail = unsupported
        ? "Cost collection is not supported on this platform"
        : /timed out/.test(message)
          ? "Cost collection timed out after five minutes"
          : /limit|exceeds/.test(message)
            ? "Cost output exceeded the 16 MiB limit"
            : /unsupported|update collector/.test(message)
              ? "Update the quota collector to use independent local costs"
              : /unavailable/.test(message)
                ? "Cost collector is unavailable"
                : "Cost collection failed or returned invalid aggregate data";
      this.#writeStatus({
        ...this.#status(job.provider, job.scope),
        state: "failed",
        error_key: unsupported
          ? "errors.quotaUnsupportedPlatform"
          : updateRequired
            ? "errors.quotaCollectorUpdateRequired"
            : "errors.localCostsUnavailable",
        error_detail: detail,
      });
      this.#emit(job.provider, job.scope);
    } finally {
      if (this.#active === job) this.#active = undefined;
      void this.#drain();
    }
  }
}

function currentDayProjection(snapshot: LocalCostSnapshot): LocalCostSnapshot {
  const today = localDay(new Date(), snapshot.timezone);
  if (snapshot.today.date === today) return snapshot;
  return {
    ...snapshot,
    today: { date: today, cost_usd: null, tokens: null, partial: true, models: [] },
  };
}

/** Hash private configuration/root identities; no paths or configuration contents reach IPC. */
export async function costScope(
  environment: NodeJS.ProcessEnv,
): Promise<{ scope_key: string; timezone: string }> {
  const timezone = Intl.DateTimeFormat(undefined, {
    timeZone: environment.TZ || undefined,
  }).resolvedOptions().timeZone;
  const config = environment.CODEXBAR_CONFIG;
  let content = "";
  if (config) {
    try {
      content = await readFile(config, "utf8");
    } catch {
      content = "unavailable";
    }
  }
  const roots = Object.fromEntries(
    [
      "HOME",
      "USERPROFILE",
      "CODEX_HOME",
      "CLAUDE_HOME",
      "XDG_CONFIG_HOME",
      "APPDATA",
      "LOCALAPPDATA",
      "CODEXBAR_CONFIG",
    ].map((key) => [key, environment[key] ?? ""]),
  );
  roots.claude_config_dir = claudeConfigDirVariable(environment) ?? "";
  return {
    timezone,
    scope_key: createHash("sha256")
      .update(
        JSON.stringify({
          roots,
          content,
          timezone,
          period: "rolling:30",
          source: "native-local",
          revision: 1,
        }),
      )
      .digest("hex"),
  };
}
