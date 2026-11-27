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
