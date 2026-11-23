import type { Live, SessionCapabilities, SessionProviderDeclaration } from "@agentkib/web-client";
import { claudeTurnControls, isLegacyClaudeFollower } from "./claude-code/turn-controls";
import { dshTurnControls } from "./deepseek-harness/turn-controls";

type ConnectionKind = NonNullable<SessionProviderDeclaration["connection"]>["kind"];

export interface SessionTurnControlRegistration {
  allowsSendStatus(live: Live): boolean;
  stopRequiresCapability?(live: Live): boolean;
}

const turnControls: Partial<Record<ConnectionKind, SessionTurnControlRegistration>> = {
  "terminal-bridge": claudeTurnControls,
  "plugin-bridge": dshTurnControls,
};

function registeredTurnControls(provider: SessionProviderDeclaration | undefined) {
  const connection = provider?.connection?.kind;
  return connection ? turnControls[connection] : undefined;
}

/** Checks only whether the status permits sending. Device and live grants remain required. */
export function sessionSendStatusAllows(
  provider: SessionProviderDeclaration | undefined,
  live: Live,
): boolean {
  return (
    live.status === "idle" || registeredTurnControls(provider)?.allowsSendStatus(live) === true
  );
}

/** A terminal following a session requires a current stop grant for that session. */
export function sessionStopCapabilityAllows(
  live: Live | undefined,
  capabilities: SessionCapabilities | undefined,
  selected: string,
  provider?: SessionProviderDeclaration,
): boolean {
  if (!live) return false;
  const requiresCapability =
    isLegacyClaudeFollower(live) ||
    registeredTurnControls(provider)?.stopRequiresCapability?.(live) === true;
  return (
    !requiresCapability ||
    (live.sessionId === selected &&
      capabilities?.sessionId === selected &&
      capabilities.features.stop?.available === true)
  );
}
