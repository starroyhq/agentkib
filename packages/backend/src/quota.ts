import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { RUNTIME_METHODS, type LocalCostProvider } from "@agentkib/runtime-protocol";
import type { Commands } from "./commands";
import type { BackendStore } from "./store";
import { utcNow } from "./workspaces";
import { timestamp } from "./timestamps";
import { isSensitiveSessionKey, sanitizeSessionText } from "./session-handoff";
import { LocalCosts, costScope } from "./local-costs";

type Backend = "codex-bar-cli" | "win-codex-bar";
type RecordValue = Record<string, unknown>;
const backend: Backend = process.platform === "win32" ? "win-codex-bar" : "codex-bar-cli";

export class QuotaOwner {
  #active = new Map<string, Promise<void>>();
  #queue: Array<() => void> = [];
  #processes = 0;
  #controllers = new Set<AbortController>();
  #generation = 0;
  #source = "";
  #stopped = false;
  #preparing?: Promise<{ source: string; environment: NodeJS.ProcessEnv }>;
  readonly #costs: LocalCosts;

  constructor(
    readonly store: BackendStore,
    readonly commands: Commands,
    readonly dataDir: string,
    readonly environment: NodeJS.ProcessEnv,
    readonly notify: (method: string, params: unknown) => void = () => {},
  ) {
    this.#costs = new LocalCosts(
      store,
      commands,
      backend,
      async () => {
        const configuration = await this.#configuration();
        const scope = await costScope(configuration.environment);
        return {
          ...scope,
          environment: {
            ...configuration.environment,
            AGENTKIB_COST_CACHE: path.join(this.dataDir, "quota", "local-costs", scope.scope_key),
          },
          executable: await this.#sidecar(),
        };
      },
      notify,
    );
    for (const row of store.sql.rows("SELECT provider,status_json FROM quota_provider_status")) {
      const status = JSON.parse(String(row.status_json)) as RecordValue;
      if (["queued", "running"].includes(String(status.state)))
        store.saveQuotaProviderStatus(String(row.provider), { ...status, state: "cancelled" });
    }
  }

  costSnapshot(provider: LocalCostProvider) {
    return this.#costs.snapshot(provider);
  }
  costStatus(provider: LocalCostProvider) {
    return this.#costs.status(provider);
  }
  refreshCost(provider: LocalCostProvider, force = false) {
    return this.#costs.refresh(provider, force);
  }
  observeCosts(provider: LocalCostProvider | null, autoRefresh: boolean) {
    return this.#costs.observe(provider, autoRefresh);
  }
  setCostAutoRefresh(enabled: boolean): void {
    this.#costs.setAutomatic(enabled);
  }
  stop(): void {
    this.#stopped = true;
    this.#generation++;
    this.#costs.stop();
    for (const controller of this.#controllers)
      controller.abort(new Error("quota collection cancelled"));
    this.#queue.splice(0).forEach((start) => start());
  }

  snapshot(): unknown {
    return this.store.quotaSnapshot();
  }

  async status(): Promise<unknown> {
    const configuration = await this.#configuration();
    const executable = await this.#sidecar();
    const status = this.store.quotaCollectorStatus({
      backend,
      platform_supported:
        process.platform === "darwin" ||
        process.platform === "linux" ||
        (process.platform === "win32" && process.arch === "x64"),
      sidecar_available: executable !== null,
      config_source: configuration.source,
      running: this.#active.size > 0,
    }) as RecordValue;
    const providers = await this.#enabledProviders(configuration.environment).catch(() => []);
    return {
      ...status,
      providers: Object.fromEntries(
        providers.map((id) => [id, this.store.quotaProviderStatus(id)]),
      ),
    };
  }

  async refresh(provider?: string): Promise<unknown> {
    if (this.#stopped) throw new Error("quota collector is stopped");
    if (provider !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(provider))
      throw new Error("invalid quota provider");
    const queuedAt = utcNow();
    const startedAt = utcNow();
    let preparing = true;
    let preparationGeneration = this.#generation;
    try {
      const configuration = await this.#configuration();
      const scope = await costScope(configuration.environment);
      if (this.#stopped) throw new Error("quota collector is stopped");
      if (this.#source && this.#source !== scope.scope_key) {
        this.#generation++;
        for (const controller of this.#controllers)
          controller.abort(new Error("quota configuration changed"));
      }
      this.#source = scope.scope_key;
      const generation = this.#generation;
      preparationGeneration = generation;
      const providers = provider
        ? [provider]
        : await this.#enabledProviders(configuration.environment);
      if (!providers.length) {
        throw new Error(
          "quota collector returned no usable quota for enabled providers\nNo providers are enabled.",
        );
      }
      preparing = false;
      const results = await Promise.allSettled(
        providers.map((id) => this.#refreshProvider(id, configuration, scope.scope_key)),
      );
      if (this.#stopped || generation !== this.#generation)
        throw new Error("quota collection cancelled");
      const current = await costScope((await this.#configuration()).environment);
      if (this.#stopped || current.scope_key !== scope.scope_key)
        throw new Error("quota configuration changed");
      const failed = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed.length === results.length) {
        const cached = this.snapshot() as RecordValue | undefined;
        const allUnavailable = failed.every((result) =>
          String(result.reason).includes("no usable quota"),
        );
        const message = allUnavailable
          ? unavailableDiagnostics({
              providers: (Array.isArray(cached?.providers) ? cached.providers : []).filter(
                (item) => isRecord(item) && providers.includes(String(item.id)),
              ),
            })
          : failed
              .map((result) => errorMessage(result.reason))
              .join("\n")
              .slice(0, 1000);
        this.store.recordQuotaFailure(
          backend,
          failed.every((result) => String(result.reason).includes("update collector"))
            ? "errors.quotaCollectorUpdateRequired"
            : "errors.quotaUnavailable",
          message,
        );
        throw new Error(message);
      }
      return {
        kind: "quota",
        disposition: "queued",
        request_id: `${Date.parse(queuedAt)}-electron`,
        status: {
          kind: "quota",
          state: "succeeded",
          request_id: `${Date.parse(queuedAt)}-electron`,
          queued_at: queuedAt,
          started_at: startedAt,
          finished_at: utcNow(),
          progress_current: providers.length,
          progress_total: providers.length,
          error: null,
          next_allowed_at: null,
        },
      };
    } catch (error) {
      if (preparing && !this.#stopped && preparationGeneration === this.#generation) {
        const message = error instanceof Error ? error.message : "";
        const detail =
          message === "invalid quota collector configuration" ||
          message.includes("No providers are enabled.")
            ? message
            : "quota collector configuration is unavailable";
        this.store.recordQuotaFailure(backend, "errors.quotaUnavailable", detail);
        throw new Error(detail);
      }
      throw error;
    }
  }

  #refreshProvider(
    id: string,
    configuration: { source: string; environment: NodeJS.ProcessEnv },
    scope: string,
  ): Promise<void> {
    const key = `${scope}:${id}`;
    const active = this.#active.get(key);
    if (active) return active;
    const generation = this.#generation;
    const previous = this.store.quotaProviderStatus(id);
    this.store.saveQuotaProviderStatus(id, {
      ...previous,
      state: "queued",
      last_attempt_at: utcNow(),
    });
    const promise = new Promise<void>((resolve, reject) => {
      const start = () => {
        this.#processes++;
        const finish = () => {
          this.#processes--;
          this.#active.delete(key);
          this.#queue.shift()?.();
        };
        void this.#collectProvider(id, configuration, scope, generation).then(
          () => {
            finish();
            resolve();
          },
          (error: unknown) => {
            finish();
            reject(error);
          },
        );
      };
      if (this.#processes < 2) start();
      else this.#queue.push(start);
    });
    this.#active.set(key, promise);
    return promise;
  }

  async #collectProvider(
    id: string,
    configuration: { source: string; environment: NodeJS.ProcessEnv },
    scope: string,
    generation: number,
  ): Promise<void> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    let returnedProvider: RecordValue | undefined;
    try {
      if (this.#stopped || generation !== this.#generation)
        throw new Error("quota collection cancelled");
      this.store.saveQuotaProviderStatus(id, {
        ...this.store.quotaProviderStatus(id),
        state: "running",
      });
      const executable = await this.#sidecar();
      if (!executable) throw new Error("quota collector sidecar is unavailable");
      if (
        !(
          process.platform === "darwin" ||
          process.platform === "linux" ||
          (process.platform === "win32" && process.arch === "x64")
        )
      )
        throw new Error("quota collector is not supported on this platform");
      const output = await this.commands.run(
        executable,
        [
          "dashboard",
          "--no-local-costs",
          "--provider",
          id,
          "--identity",
          "full",
          "--timeout",
          backend === "win-codex-bar" ? "12" : "25",
        ],
        {
          env: configuration.environment,
          timeout: 35_000,
          limit: 2 * 1024 * 1024,
          allowFailure: true,
          strictOutput: true,
          terminateDescendantsOnExit: true,
          signal: controller.signal,
        },
      );
      if (this.#stopped || controller.signal.aborted || generation !== this.#generation)
        throw new Error("quota collection cancelled");
      if (output.truncated) throw new Error("quota collector output exceeds the 2 MiB limit");
      let parsed: ReturnType<typeof parseSnapshot>;
      try {
        parsed = parseSnapshot(output.bytes, backend, id);
      } catch (error) {
        if (!output.success)
          throw new Error(
            /unknown|unexpected|unrecognized.*argument/i.test(output.error)
              ? "quota collector options unsupported; update collector"
              : `quota collector command failed: ${sanitize(output.error) || "invalid dashboard data"}`,
          );
        throw error;
      }
      const { snapshot, usable } = parsed;
      returnedProvider = (snapshot.providers as RecordValue[]).find((item) => item.id === id);
      if (!usable) throw new Error(unavailableDiagnostics(snapshot));
      const current = await costScope((await this.#configuration()).environment);
      if (this.#stopped || generation !== this.#generation || scope !== current.scope_key)
        throw new Error("quota configuration changed");
      const result = (snapshot.providers as RecordValue[]).find((item) => item.id === id)!;
      const version = randomUUID();
      this.store.saveQuotaProvider(snapshot, {
        ...result,
        fetched_at: utcNow(),
        refresh_state: "succeeded",
        data_version: version,
      });
      this.store.saveQuotaProviderStatus(id, {
        state: "succeeded",
        last_attempt_at: this.store.quotaProviderStatus(id).last_attempt_at,
        last_success_at: utcNow(),
        data_version: version,
      });
      this.notify("quota.updated", this.snapshot());
    } catch (error) {
      let sameScope = false;
      if (!this.#stopped && generation === this.#generation) {
        try {
          sameScope =
            (await costScope((await this.#configuration()).environment)).scope_key === scope;
        } catch {
          /* Invalid or changing configuration cannot authorize an old result. */
        }
      }
      if (!this.#stopped && generation === this.#generation && sameScope) {
        this.store.saveQuotaProviderStatus(id, {
          ...this.store.quotaProviderStatus(id),
          state: "failed",
          error_key: errorMessage(error).includes("update collector")
            ? "errors.quotaCollectorUpdateRequired"
            : "errors.quotaUnavailable",
          error_detail: errorMessage(error),
        });
        this.store.recordQuotaProviderFailure(
          returnedProvider ?? { id, name: id, enabled: true, windows: [], accounts: [] },
          returnedProvider?.error ? String(returnedProvider.error) : errorMessage(error),
        );
        this.notify("quota.updated", this.snapshot());
      }
      throw error;
    } finally {
      this.#controllers.delete(controller);
    }
  }

  async #enabledProviders(environment: NodeJS.ProcessEnv): Promise<string[]> {
    const config = environment.CODEXBAR_CONFIG;
    if (config) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(config, "utf8"));
      } catch {
        throw new Error("invalid quota collector configuration");
      }
      if (!isRecord(parsed)) throw new Error("invalid quota collector configuration");
      const raw = Array.isArray(parsed.providers)
        ? parsed.providers
            // CodexBar v0.83.0 metadata defaults only Codex on. Claude and all
            // other providers remain opt-in when `enabled` is omitted/null.
            .filter(
              (value) =>
                isRecord(value) &&
                (value.enabled === true || (value.enabled == null && value.id === "codex")),
            )
            .map((value) => (value as RecordValue).id)
        : (parsed.enabled_providers ?? parsed.enabledProviders);
      if (Array.isArray(raw))
        return [
          ...new Set(
            raw.filter(
              (id): id is string => typeof id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(id),
            ),
          ),
        ];
    }
    return process.platform === "win32" ? ["codex", "claude"] : ["codex"];
  }

  #configuration(): Promise<{ source: string; environment: NodeJS.ProcessEnv }> {
    if (!this.#preparing)
      this.#preparing = this.#environment().finally(() => {
        this.#preparing = undefined;
      });
    return this.#preparing;
  }

  async #sidecar(): Promise<string | null> {
    const candidates = [
      this.environment.AGENTKIB_QUOTA_SIDECAR,
      path.join(
        path.dirname(process.execPath),
        process.platform === "win32" ? "agentkib-quota-sidecar.exe" : "agentkib-quota-sidecar",
      ),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    for (const candidate of candidates) {
      try {
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        // Continue with the packaged sidecar location.
      }
    }
    return null;
  }

  async #environment(): Promise<{ source: string; environment: NodeJS.ProcessEnv }> {
    const environment = { ...process.env, ...this.environment };
    const home = environment.HOME || environment.USERPROFILE || os.homedir();
    const configured = environment.CODEXBAR_CONFIG?.trim();
    const expanded =
      configured === "~"
        ? home
        : configured?.startsWith("~/")
          ? path.join(home, configured.slice(2))
          : configured;
    if (process.platform === "win32") {
      const appData = environment.APPDATA?.trim();
      const config = appData ? path.join(appData, "CodexBar", "settings.json") : "";
      const inheritedProxy = Object.keys(environment).some((key) =>
        ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].some((name) => key.toUpperCase() === name),
      );
      if (!inheritedProxy) {
        const proxy = await this.#windowsProxy(environment);
        if (proxy) {
          environment.HTTP_PROXY = proxy;
          environment.HTTPS_PROXY = proxy;
        }
      }
      return {
        source: expanded
          ? "environment"
          : config && (await fileExists(config))
            ? "win-codexbar"
            : "automatic",
        environment: expanded
          ? { ...environment, CODEXBAR_CONFIG: expanded }
          : config && (await fileExists(config))
            ? { ...environment, CODEXBAR_CONFIG: config }
            : environment,
      };
    }
    if (expanded) {
      return { source: "environment", environment: { ...environment, CODEXBAR_CONFIG: expanded } };
    }
    const xdgRoot = environment.XDG_CONFIG_HOME;
    const candidates = [
      xdgRoot && path.isAbsolute(xdgRoot) ? path.join(xdgRoot, "codexbar", "config.json") : "",
      path.join(home, ".config", "codexbar", "config.json"),
      path.join(home, ".codexbar", "config.json"),
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (await fileExists(candidate))
        return { source: "codexbar", environment: { ...environment, CODEXBAR_CONFIG: candidate } };
    }
    const managed = path.join(this.dataDir, "quota", "codexbar-config.json");
    const installations = this.store.catalog.request(RUNTIME_METHODS.listAgentInstallations, {});
    const installed = Array.isArray(installations) ? installations.filter(isRecord) : [];
    const providers = ["codex", "claude", "cursor"].filter((id) =>
      installed.some(
        (item) => item.installed === true && item.agent === (id === "claude" ? "claude-code" : id),
      ),
    );
    if (!providers.length) providers.push("codex");
    await mkdir(path.dirname(managed), { recursive: true, mode: 0o700 });
    await writePrivateJson(managed, {
      version: 1,
      providers: providers.map((id) => ({ id, enabled: true })),
    });
    return {
      source: "agentkib-managed",
      environment: { ...environment, CODEXBAR_CONFIG: managed },
    };
  }

  async #windowsProxy(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const enabled = await this.commands.run("reg.exe", ["query", key, "/v", "ProxyEnable"], {
      env: environment,
      limit: 16 * 1024,
      timeout: 3_000,
      allowFailure: true,
      terminateDescendantsOnExit: true,
    });
    if (
      !enabled.success ||
      !/ProxyEnable\s+REG_DWORD\s+0x0*1\b/i.test(enabled.bytes.toString("utf8"))
    )
      return undefined;
    const result = await this.commands.run("reg.exe", ["query", key, "/v", "ProxyServer"], {
      env: environment,
      limit: 16 * 1024,
      timeout: 3_000,
      allowFailure: true,
      terminateDescendantsOnExit: true,
    });
    if (!result.success) return undefined;
    const value = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(result.bytes.toString("utf8"))?.[1]?.trim();
    if (!value) return undefined;
    const candidate = value.includes("=")
      ? (value
          .split(";")
          .map((entry) => entry.split("=", 2).map((part) => part.trim()))
          .find(([protocol, address]) => protocol?.toLowerCase() === "https" && address)
          ?.at(1) ??
        value
          .split(";")
          .map((entry) => entry.split("=", 2).map((part) => part.trim()))
          .find(([protocol, address]) => protocol?.toLowerCase() === "http" && address)
          ?.at(1))
      : value;
    if (!candidate || /[\r\n\0]/.test(candidate)) return undefined;
    return candidate.includes("://") ? candidate : `http://${candidate}`;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await rename(temp, file);
  } catch (error) {
    await import("node:fs/promises").then(({ unlink }) => unlink(temp).catch(() => undefined));
    throw error;
  }
}

function parseSnapshot(
  bytes: Buffer,
  backendName: Backend,
  requestedProvider?: string,
): { snapshot: RecordValue; usable: boolean } {
  const input = JSON.parse(bytes.toString("utf8")) as RecordValue;
  if (
    input.schemaVersion !== 1 ||
    typeof input.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(input.generatedAt))
  )
    throw new Error("invalid dashboard-v1 JSON");
  const stale = finite(input.staleAfterSeconds, "staleAfterSeconds");
  if (!Number.isSafeInteger(stale) || stale < 0) throw new Error("staleAfterSeconds is invalid");
  if (input.providers !== undefined && !Array.isArray(input.providers))
    throw new Error("providers is not an array");
  const host = isRecord(input.host) ? input.host : {};
  if (requestedProvider)
    input.providers = (Array.isArray(input.providers) ? input.providers : []).filter(
      (value) => isRecord(value) && value.id === requestedProvider,
    );
  const providers = Array.isArray(input.providers) ? input.providers.map(normalizeProvider) : [];
  const fetched = utcNow();
  const generated = timestamp(input.generatedAt)!;
  const snapshot = {
    schema_version: 1,
    backend: backendName,
    ...(typeof host.codexBarVersion === "string" ? { backend_version: host.codexBarVersion } : {}),
    generated_at: generated,
    fetched_at: fetched,
    stale_after_seconds: stale,
    freshness: Date.now() > Date.parse(generated) + Math.max(1, stale) * 1000 ? "stale" : "fresh",
    providers,
  };
  // Classification uses complete collector errors; formatting may redact or
  // discard text. Only the normalized snapshot is persisted or returned.
  return { snapshot, usable: hasUsableQuota(input) };
}

function normalizeProvider(value: unknown): RecordValue {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.enabled !== "boolean"
  )
    throw new Error("invalid dashboard provider");
  const identity = normalizeIdentity(value.identity);
  const windows = normalizeWindows(value.windows);
  const accounts = (Array.isArray(value.accounts) ? value.accounts : []).map((raw) => {
    if (
      !isRecord(raw) ||
      typeof raw.id !== "string" ||
      typeof raw.label !== "string" ||
      typeof raw.active !== "boolean"
    )
      throw new Error("invalid dashboard account");
    return {
      id: raw.id,
      label: raw.label,
      active: raw.active,
      ...(normalizeIdentity(raw.identity) ? { identity: normalizeIdentity(raw.identity) } : {}),
      windows: normalizeWindows(raw.windows),
      ...(typeof raw.error === "string" ? { error: sanitize(raw.error) } : {}),
      ...(validDate(raw.updatedAt) ? { updated_at: timestamp(raw.updatedAt)! } : {}),
    };
  });
  const status =
    isRecord(value.status) &&
    typeof value.status.level === "string" &&
    typeof value.status.label === "string"
      ? {
          level: value.status.level,
          label: value.status.label,
          ...(validDate(value.status.updatedAt)
            ? { updated_at: timestamp(value.status.updatedAt)! }
            : {}),
        }
      : undefined;
  const credits = isRecord(value.credits)
    ? {
        remaining: finite(value.credits.remaining, "credits.remaining"),
        unit: String(value.credits.unit ?? ""),
      }
    : undefined;
  const rawError = providerErrorMessage(value);
  const error = [
    rawError,
    typeof value.accountsError === "string" ? value.accountsError : undefined,
  ]
    .filter((message): message is string => Boolean(message))
    .map(sanitize)
    .join("\n");
  return {
    id: value.id,
    name: value.name,
    enabled: value.enabled,
    ...(typeof value.source === "string" ? { source: value.source } : {}),
    ...(status ? { status } : {}),
    ...(identity ? { identity } : {}),
    windows,
    ...(credits ? { credits } : {}),
    ...(error ? { error } : {}),
    ...(validDate(value.updatedAt) ? { updated_at: timestamp(value.updatedAt)! } : {}),
    accounts,
  };
}

function normalizeWindows(value: unknown): RecordValue[] {
  return (Array.isArray(value) ? value : []).map((window) => {
    if (!isRecord(window) || typeof window.kind !== "string" || typeof window.label !== "string")
      throw new Error("invalid dashboard quota window");
    const known = window.usageKnown !== false && window.idle !== true;
    const used = known ? finite(window.usedPercent, "usedPercent") : null,
      remaining = known ? finite(window.remainingPercent, "remainingPercent") : null;
    return {
      kind: window.kind,
      label: window.label,
      used_percent: used === null ? null : clamp(used),
      remaining_percent: remaining === null ? null : clamp(remaining),
      usage_known: known,
      ...(validDate(window.resetAt) ? { reset_at: timestamp(window.resetAt)! } : {}),
    };
  });
}

function normalizeIdentity(value: unknown): RecordValue | undefined {
  if (!isRecord(value)) return undefined;
  const result: RecordValue = {};
  if (typeof value.accountEmail === "string") result.account_email = value.accountEmail;
  if (typeof value.plan === "string") result.plan = value.plan;
  return Object.keys(result).length ? result : undefined;
}
function providerErrorMessage(provider: RecordValue): string | undefined {
  return typeof provider.error === "string"
    ? provider.error
    : isRecord(provider.error) && typeof provider.error.message === "string"
      ? provider.error.message
      : undefined;
}
function hasUsableQuota(snapshot: RecordValue): boolean {
  const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
  return providers.some(
    (p) =>
      isRecord(p) &&
      p.enabled === true &&
      ((quotaErrorAllowsData(p, snapshot) &&
        ((Array.isArray(p.windows) && p.windows.some(knownWindow)) || isRecord(p.credits))) ||
        (Array.isArray(p.accounts) &&
          p.accounts.some(
            (a) =>
              isRecord(a) && !a.error && Array.isArray(a.windows) && a.windows.some(knownWindow),
          ))),
  );
}

function knownWindow(value: unknown): boolean {
  // An explicit unknown is a valid measurement and must replace a prior numeric cache.
  return (
    isRecord(value) &&
    (value.usageKnown === false ||
      value.idle === true ||
      (typeof value.remainingPercent === "number" && Number.isFinite(value.remainingPercent)))
  );
}

function quotaErrorAllowsData(provider: RecordValue, snapshot: RecordValue): boolean {
  if (!provider.error && !provider.accountsError) return true;
  // CodexBar dashboard-v1 folds the separate local cost scan into the provider
  // error even when usage succeeded. Only these verified cost-only failures
  // may retain quota; authentication, usage and unknown failures still reject it.
  if (
    !["codex", "claude"].includes(String(provider.id)) ||
    providerErrorMessage(provider) !== `${provider.id} cost refresh timed out` ||
    Boolean(provider.accountsError)
  )
    return false;
  const updated = typeof provider.updatedAt === "string" ? Date.parse(provider.updatedAt) : NaN;
  const generated = Date.parse(String(snapshot.generatedAt));
  return (
    Number.isFinite(updated) &&
    updated <= generated &&
    updated >= generated - Number(snapshot.staleAfterSeconds) * 1000
  );
}

function unavailableDiagnostics(snapshot: RecordValue): string {
  const providers = (Array.isArray(snapshot.providers) ? snapshot.providers : []).filter(
    (provider): provider is RecordValue => isRecord(provider) && provider.enabled === true,
  );
  const heading = "quota collector returned no usable quota for enabled providers";
  if (!providers.length) return `${heading}\nNo providers are enabled.`;
  const shown = providers.slice(0, 8);
  // Leave room in the existing 1000-character failure field for each provider.
  const budget = Math.floor(850 / shown.length);
  const details = shown.map((provider) => {
    const errors = [
      provider.error,
      ...(Array.isArray(provider.accounts)
        ? provider.accounts.filter(isRecord).map((account) => account.error)
        : []),
    ].filter((error): error is string => typeof error === "string" && Boolean(error));
    const detail = errors.length
      ? [...new Set(errors)].join("; ")
      : "No usable quota windows or credits were returned.";
    const line = sanitize(`${String(provider.id).slice(0, 48)}: ${detail}`).replace(/\s+/g, " ");
    return line.length > budget ? `${line.slice(0, budget - 1)}…` : line;
  });
  if (providers.length > shown.length)
    details.push(`${providers.length - shown.length} more providers omitted.`);
  return [heading, ...details].join("\n");
}

function isSensitiveDiagnosticKey(key: string): boolean {
  // Bound nested JSON decoding: an escape chain can shrink only five characters
  // per pass. Conservatively redact candidates still encoded after eight passes.
  for (let depth = 0; depth < 8; depth += 1) {
    if (isSensitiveSessionKey(key)) return true;
    try {
      const decoded = JSON.parse(`"${key}"`) as string;
      if (decoded.length >= key.length) return false;
      key = decoded;
    } catch {
      return false;
    }
  }
  return true;
}

function redactCredentialFields(value: string): string {
  // Scan field/option names only, never values: a normal prefix such as
  // "Upstream:" must not consume a later sensitive field. Overlapping candidates
  // also cover escaped JSON and spaced names such as "access key id".
  // CLI names use the same classification regardless of value quoting/separator.
  // Nested diagnostic strings encode whitespace between the key and colon;
  // recognize those separators without decoding or copying credential values.
  const whitespace = String.raw`(?:\s|\\+(?:[nrt]|u00(?:09|0[aAdD]|20)))*`;
  const fields = new RegExp(
    String.raw`(?=\\?"([^"\r\n]*?)\\?"${whitespace}[:=]|\\?'([^'\r\n]*?)\\?'${whitespace}[:=]|(?<![A-Za-z\d_$-])--?([A-Za-z_$][A-Za-z\d_$-]*)|(?<![A-Za-z\d_$-])([A-Za-z_$][A-Za-z\d_$-]*(?:[ \t]+[A-Za-z\d_$-]+){0,2})${whitespace}[:=])`,
    "g",
  );
  for (const match of value.matchAll(fields)) {
    const key = (match[1] ?? match[2] ?? match[3] ?? match[4]).replace(/\\+$/, "");
    // Values can span lines or contain incomplete nested objects. Preserve the
    // ordinary error prefix, but do not guess where sensitive content ends.
    if (isSensitiveDiagnosticKey(key))
      return `${value.slice(0, match.index)}[credential diagnostic redacted]`;
  }
  return value;
}

function sanitize(value: string): string {
  const markers = [
    "authorization",
    "api_key",
    "api-key",
    "apikey",
    "access_token",
    "refresh_token",
    "token=",
    '"token"',
    "cookie",
    "bearer ",
    "secret",
    "password",
    "passwd",
    "passphrase",
  ];
  const withoutPrivateKeys = redactCredentialFields(value).replace(
    /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)/gi,
    "[credential diagnostic redacted]",
  );
  return sanitizeSessionText(withoutPrivateKeys, { value: 0 })
    .replace(/https?:(?:\\*\/){2}[^\s<>"']+/gi, "[URL redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[credential diagnostic redacted]",
    )
    .replace(
      /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      "[account redacted]",
    )
    .split(/\r?\n/)
    .slice(0, 12)
    .map((line) =>
      markers.some((marker) => line.toLowerCase().includes(marker))
        ? "[credential diagnostic redacted]"
        : line.trim(),
    )
    .filter(Boolean)
    .join("\n")
    .slice(0, 1000);
}
function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} is not finite`);
  return value;
}
function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}
function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function errorMessage(error: unknown): string {
  return sanitize(error instanceof Error ? error.message : String(error));
}
