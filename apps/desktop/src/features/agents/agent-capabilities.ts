import type { AgentInstallation, AgentSupport, ContinuationCapability } from "@/core/types";

/**
 * Support is reported by the runtime for a concrete installation. Do not infer
 * capabilities from the agent kind: old runtimes may be able to discover an
 * agent while still not reporting which surfaces are safe to use.
 */
export function agentSupport(installation?: AgentInstallation): AgentSupport | undefined {
  return installation?.support;
}

/** Only a successful check of this session's concrete format enables continuation. */
export function canContinueFromHistory(capability?: ContinuationCapability): boolean {
  return capability?.status === "supported";
}

/** Why a session cannot be handed off: copy where there is some (DSH's reasons), else as reported. */
export function sourceCapabilityReason(
  tr: (key: string) => string,
  reason?: string | null,
): string | undefined {
  if (!reason) return undefined;
  const key = `handoff.sourceReason.${reason}`;
  return tr(key) === key ? reason : tr(key);
}
