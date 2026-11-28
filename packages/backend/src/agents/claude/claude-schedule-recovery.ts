import { usageLimitContinue } from "../../usage-limit";
import type { ClaudeHostState, ClaudeHostWork } from "./claude-host-state";

type SchedulePermit = { sessionId: string; item: ClaudeHostWork };

export function fenceClaudeSchedulePermit(
  permits: Map<string, SchedulePermit>,
  sessionId: string,
  bootId: string,
  target: Record<string, unknown>,
): boolean {
  const { permitId, runtimeBootId, itemId, requestId, deviceId } = target;
  if (typeof itemId !== "string" || !itemId || typeof permitId !== "string" || !permitId)
    return false;

  const matches = (permit: SchedulePermit) =>
    permit.sessionId === sessionId &&
    permit.item.id === itemId &&
    permit.item.requestId === requestId &&
    permit.item.deviceId === deviceId;
  const current = permits.get(permitId);
  if (current && (runtimeBootId !== bootId || !matches(current))) return false;
  // A newer permit may own the claim after the original expired. Leave it intact.
  for (const [id, permit] of permits)
    if (id !== permitId && permit.sessionId === sessionId && permit.item.id === itemId)
      return false;
  if (current) permits.delete(permitId);
  return true;
}

export function claudeScheduleListEntry(
  record: { id: string; workspaceId: string },
  revision: unknown,
  host: ClaudeHostState,
  next: ClaudeHostWork | null,
) {
  return {
    sessionId: record.id,
    workspaceId: record.workspaceId,
    runtimeBootId: host.bootId,
    revision,
    scheduleRevision: host.revision,
    paused: host.paused,
    reason: host.reason,
    // The scheduler asks the backend to continue when the usage limit clears.
    continueAt:
      host.paused &&
      host.reason === "usage-limit" &&
      usageLimitContinue(host.usageLimit, host.bootId) !== "never"
        ? host.usageLimit!.continueAt
        : null,
    next: next
      ? {
          itemId: next.id,
          requestId: next.requestId,
          originRequestId: next.originRequestId,
          deviceId: next.deviceId,
          originDeviceId: next.originDeviceId,
          kind: next.kind,
          requiresAttachments: next.requiresAttachments,
          goalGeneration: next.goalGeneration,
        }
      : null,
  };
}
