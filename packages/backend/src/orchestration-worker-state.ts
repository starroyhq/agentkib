import type { UsageLimitView } from "./usage-limit";

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export type WorkerLimit = Pick<UsageLimitView, "kind" | "resetsAt" | "continueAt" | "manual">;

export function workerIsRunning(status: unknown): boolean {
  return (
    status === "running" ||
    status === "awaiting-approval" ||
    status === "waiting-approval" ||
    status === "waiting-input"
  );
}

export function reasonCode(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(value) ? value : null;
}

export function dateField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15
    ? value
    : null;
}

export function workerLimit(live: Record<string, unknown> | null): WorkerLimit | null {
  const limit = live?.usageLimit;
  if (!isObject(limit)) return null;
  return {
    kind: reasonCode(limit.kind) as WorkerLimit["kind"],
    resetsAt: dateField(limit.resetsAt),
    continueAt: dateField(limit.continueAt),
    manual: reasonCode(limit.manual) as WorkerLimit["manual"],
  };
}

export function workerCommands(live: Record<string, unknown> | null) {
  const commands: unknown = live?.commands;
  return Array.isArray(commands) &&
    commands.every(
      (value): value is { id: string; startedAt?: unknown } =>
        isObject(value) && typeof value.id === "string" && value.id.length > 0,
    )
    ? commands
    : null;
}

export function progressSignal(live: Record<string, unknown>, turnId: string): string | null {
  const observedItems = typeof live.workerProgress === "string" ? live.workerProgress : null;
  const output =
    live.streamTextTruncated !== true && typeof live.streamText === "string"
      ? live.streamText
      : null;
  if (
    observedItems === null &&
    (output === null ||
      (live.executionMode === "codex-managed" && Buffer.byteLength(output) >= 120 * 1024))
  )
    return null;
  const external = isObject(live.externalTurn) ? live.externalTurn : null;
  // Status revisions include wait heartbeats. Count actual work within one runtime and turn.
  return JSON.stringify([
    live.runtimeBootId,
    live.executionMode,
    live.connectionGeneration,
    external?.turnId === turnId ? external.startedAt : null,
    observedItems,
    output?.length,
    output?.slice(-128),
  ]);
}

export function codexExternalTurn(live: Record<string, unknown> | null) {
  const turn = live?.externalTurn;
  return (live?.executionMode === "codex-follower" ||
    live?.ownershipReason === "codex-owner-busy") &&
    isObject(turn) &&
    turn.status === "running"
    ? turn
    : null;
}

export function workerStatus(live: Record<string, unknown> | null): string {
  const status = typeof live?.status === "string" ? live.status : "unavailable";
  if (status !== "idle") return status;
  if (codexExternalTurn(live)) return "running";
  return live?.ownershipReason === "codex-owner-busy" || live?.reason === "codex-owner-busy"
    ? "busy"
    : status;
}

export function workerReason(live: Record<string, unknown> | null): string | undefined {
  return typeof live?.reason === "string"
    ? live.reason
    : live?.ownershipReason === "codex-owner-busy"
      ? live.ownershipReason
      : undefined;
}

const OFFLINE_REASONS = new Set([
  "claude-bridge-disconnected",
  "claude-bridge-not-connected",
  "claude-bridge-session-unavailable",
  "codex-disconnected",
  "session-unavailable",
]);
export const ACCESS_REASONS = new Set([
  "claude-bridge-registry-invalid",
  "claude-bridge-unavailable",
  "claude-cli-too-old",
  "claude-cli-unavailable",
  "codex-cli-unavailable",
  "devin-cli-unavailable",
  "devin-login-required",
  "dsh-runtime-offline",
  "dsh-session-controller-unavailable",
  "dsh-version-unsupported",
]);

export function offlineState(
  live: Record<string, unknown> | null,
): { reason: string; userOnly: boolean } | null {
  const follower = live?.executionMode === "claude-follower";
  const failure = live?.bridgeConnectionFailure;
  const bridgeReason = isObject(failure) ? reasonCode(failure.reason) : null;
  const reason = reasonCode(live?.reason);
  if (bridgeReason) return { reason: bridgeReason, userOnly: true };
  if (
    live?.executionMode === "acp-managed" &&
    typeof live.reason === "string" &&
    /^(antigravity-cli-unavailable$|Antigravity ACP executable|Unverified Antigravity ACP server)/.test(
      live.reason,
    )
  )
    return { reason: "antigravity-acp-unavailable", userOnly: true };
  if (follower && reason !== "claude-bridge-event-gap" && live.executionLocation === null)
    return {
      reason: reason && OFFLINE_REASONS.has(reason) ? reason : "claude-bridge-disconnected",
      userOnly: true,
    };
  if (
    !live ||
    live.status === "disconnected" ||
    live.status === "unavailable" ||
    (reason && (OFFLINE_REASONS.has(reason) || ACCESS_REASONS.has(reason)))
  )
    return {
      reason: reason ?? (live ? "disconnected" : "live-unavailable"),
      userOnly: follower || (reason !== null && ACCESS_REASONS.has(reason)),
    };
  return null;
}

/** "42s", "3m 12s", "1h 05m". */
export function elapsed(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function stringField(
  input: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new Error(`invalid-${key}`);
  return value;
}

export function limitReport(limit: WorkerLimit): string {
  const timestamp = (value: number | null) =>
    value === null ? "unknown" : new Date(value).toISOString();
  return `usage limit (${limit.kind ?? "unknown"}). Resets at ${timestamp(limit.resetsAt)}. ${
    limit.continueAt !== null
      ? `AgentKib will continue at ${timestamp(limit.continueAt)}.`
      : limit.manual
        ? `Requires user action (${limit.manual}).`
        : "No automatic continuation time is currently available."
  }`;
}
