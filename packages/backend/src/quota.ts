import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import type { Commands } from "./commands";
import type { BackendStore } from "./store";
import { utcNow } from "./workspaces";
import { timestamp } from "./timestamps";

type Backend = "codex-bar-cli" | "win-codex-bar";
type RecordValue = Record<string, unknown>;
const backend: Backend = process.platform === "win32" ? "win-codex-bar" : "codex-bar-cli";

export class QuotaOwner {
  #running = false;

  constructor(
    readonly store: BackendStore,
    readonly commands: Commands,
    readonly dataDir: string,
    readonly environment: NodeJS.ProcessEnv,
  ) {}

  snapshot(): unknown {
    return this.store.quotaSnapshot();
  }

  async status(): Promise<unknown> {
    const configuration = await this.#environment();
    const executable = await this.#sidecar();
    return this.store.quotaCollectorStatus({
      backend,
      platform_supported:
        process.platform === "darwin" ||
        process.platform === "linux" ||
        (process.platform === "win32" && process.arch === "x64"),
      sidecar_available: executable !== null,
      config_source: configuration.source,
      running: this.#running,
    });
  }

  async refresh(): Promise<unknown> {
    if (this.#running) throw new Error("Quota collection is already running");
    this.#running = true;
    const queuedAt = utcNow();
    const startedAt = utcNow();
    try {
      const executable = await this.#sidecar();
      if (!executable) throw new Error("quota collector sidecar is unavailable");
      const platformSupported =
        process.platform === "darwin" ||
        process.platform === "linux" ||
        (process.platform === "win32" && process.arch === "x64");
      if (!platformSupported) throw new Error("quota collector is not supported on this platform");
      const configuration = await this.#environment();
      const output = await this.commands.run(
        executable,
        ["dashboard", "--identity", "full", "--timeout", backend === "win-codex-bar" ? "12" : "25"],
        {
          env: configuration.environment,
          timeout: 35_000,
          limit: 2 * 1024 * 1024,
          allowFailure: true,
          strictOutput: true,
          terminateDescendantsOnExit: true,
        },
      );
      if (!output.success) {
        const diagnostic = sanitize(output.error);
        throw new Error(
          diagnostic
            ? `quota collector command failed: ${diagnostic}`
            : "quota collector command failed",
        );
      }
      const snapshot = parseSnapshot(output.bytes, backend);
      if (!hasUsableQuota(snapshot))
        throw new Error("quota collector returned no usable quota for enabled providers");
      this.store.saveQuotaSnapshot(snapshot);
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
          progress_current: 1,
          progress_total: 1,
          error: null,
          next_allowed_at: null,
        },
      };
    } catch (error) {
      this.store.recordQuotaFailure(backend, "errors.quotaUnavailable", errorMessage(error));
      throw error;
    } finally {
      this.#running = false;
    }
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
    const home = os.homedir();
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
        source: config && (await fileExists(config)) ? "win-codexbar" : "automatic",
        environment,
      };
    }
    const configured = environment.CODEXBAR_CONFIG?.trim();
    if (configured) {
      const expanded =
        configured === "~"
          ? home
          : configured.startsWith("~/")
            ? path.join(home, configured.slice(2))
            : configured;
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

function parseSnapshot(bytes: Buffer, backendName: Backend): RecordValue {
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
  const providers = Array.isArray(input.providers) ? input.providers.map(normalizeProvider) : [];
  const fetched = utcNow();
  const generated = timestamp(input.generatedAt)!;
  return {
    schema_version: 1,
    backend: backendName,
    ...(typeof host.codexBarVersion === "string" ? { backend_version: host.codexBarVersion } : {}),
    generated_at: generated,
    fetched_at: fetched,
    stale_after_seconds: stale,
    freshness: Date.now() > Date.parse(generated) + Math.max(1, stale) * 1000 ? "stale" : "fresh",
    providers,
  };
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
  const rawError =
    typeof value.error === "string"
      ? value.error
      : isRecord(value.error) && typeof value.error.message === "string"
        ? value.error.message
        : undefined;
  const error = rawError
    ? sanitize(rawError)
    : typeof value.accountsError === "string"
      ? sanitize(value.accountsError)
      : undefined;
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
    const used = finite(window.usedPercent, "usedPercent"),
      remaining = finite(window.remainingPercent, "remainingPercent");
    return {
      kind: window.kind,
      label: window.label,
      used_percent: clamp(used),
      remaining_percent: clamp(remaining),
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
function hasUsableQuota(snapshot: RecordValue): boolean {
  const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
  return providers.some(
    (p) =>
      isRecord(p) &&
      p.enabled === true &&
      ((!p.error &&
        ((Array.isArray(p.windows) && p.windows.length > 0) || p.credits !== undefined)) ||
        (Array.isArray(p.accounts) &&
          p.accounts.some(
            (a) => isRecord(a) && !a.error && Array.isArray(a.windows) && a.windows.length > 0,
          ))),
  );
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
  ];
  return value
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
