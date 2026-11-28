import type { ClaudeBridge } from "./claude-bridge";
import type { ClaudeManagedReadOwner } from "./claude-managed-read";

/** A stored snapshot of a turn the CLI started by itself that had not ended when it was stored. */
export const interruptedSelfTurn = (snapshot: Record<string, unknown>): boolean =>
  snapshot.turnOrigin === "self" &&
  ["running", "waiting-approval", "waiting-input"].includes(String(snapshot.status));

export function coldClaudeStatus(snapshot: Record<string, unknown>) {
  return snapshot.status === "idle" || interruptedSelfTurn(snapshot) ? "idle" : "outcome-unknown";
}

/** A retained credential lets Claude reconnect. Only a lease or an unsettled bridge command
 * claims execution on the terminal side. Managed ownership survives runner retirement. */
export function claudeExecutionSource(
  id: string,
  managed: Pick<ClaudeManagedReadOwner, "managedWorkspace"> | undefined,
  bridge: Pick<ClaudeBridge, "claimsExecution"> | undefined,
): "terminal" | "agentkib" | null {
  if (bridge?.claimsExecution(id)) return "terminal";
  return managed?.managedWorkspace(id) ? "agentkib" : null;
}
