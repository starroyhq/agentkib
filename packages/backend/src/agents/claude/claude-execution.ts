import type { ClaudeBridge } from "./claude-bridge";
import type { ClaudeManagedReadOwner } from "./claude-managed-read";
import type { ClaudeRecord } from "./claude-managed-record";
import type { UnknownManagedCommands } from "../../managed-ledger";

type ClaudeCatalogExecution = { owned: boolean; commands: UnknownManagedCommands };
export type ClaudeCatalogFacts = {
  owners: Set<string>;
  commands: ReadonlyMap<string, UnknownManagedCommands>;
};

const hasPendingSteering = (snapshot: Record<string, unknown>): boolean =>
  Array.isArray(snapshot.pendingSteeringIds) && snapshot.pendingSteeringIds.length > 0;

/** A stored snapshot of a turn the CLI started by itself that had not ended when it was stored. */
export const interruptedSelfTurn = (snapshot: Record<string, unknown>): boolean =>
  snapshot.turnOrigin === "self" &&
  !hasPendingSteering(snapshot) &&
  ["running", "waiting-approval", "waiting-input"].includes(String(snapshot.status));

export function coldClaudeStatus(snapshot: Record<string, unknown>) {
  return snapshot.status === "idle" || interruptedSelfTurn(snapshot) ? "idle" : "outcome-unknown";
}

export function coldClaudeHandoverTurn(record: ClaudeRecord | null): string | undefined {
  if (!record?.terminalHandover || !record.adopted || record.released || record.fresh) return;
  // A completed opener says nothing about an accepted steer that may have run separately.
  if (hasPendingSteering(record.snapshot)) return;
  const { turnId, status, turnOrigin, terminalResult } = record.snapshot;
  if (status !== "outcome-unknown" || turnOrigin !== "host" || typeof turnId !== "string") return;
  if (
    terminalResult &&
    typeof terminalResult === "object" &&
    "turnId" in terminalResult &&
    terminalResult.turnId === turnId &&
    "success" in terminalResult &&
    terminalResult.success === false
  )
    return;
  return turnId || undefined;
}

export function settledClaudeSnapshot(snapshot: Record<string, unknown>, turnId: string | null) {
  return {
    ...snapshot,
    status: "idle",
    lastOutcome: turnId ? "succeeded" : null,
    reason: null,
    turnId,
    sendEnabled: true,
    stopEnabled: false,
    approvals: [],
    questions: [],
    streamText: "",
    streamTextTruncated: false,
    activity: null,
    apiRetry: null,
    revision: Number(snapshot.revision ?? 0) + 1,
  };
}

/** A retained credential lets Claude reconnect. Only a lease or an unsettled bridge command
 * claims execution on the terminal side. Managed ownership survives runner retirement. */
export function claudeExecutionSource(
  id: string,
  managed: Pick<ClaudeManagedReadOwner, "managedWorkspace"> | undefined,
  bridge: Pick<ClaudeBridge, "claimsExecution"> | undefined,
  catalog?: ClaudeCatalogExecution,
): "terminal" | "agentkib" | null {
  if (bridge?.claimsExecution(id, catalog?.commands)) return "terminal";
  return (catalog?.owned ?? Boolean(managed?.managedWorkspace(id))) ? "agentkib" : null;
}
