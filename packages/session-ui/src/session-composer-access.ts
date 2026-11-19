import {
  sessionDetailCapabilities,
  type Access,
  type SessionCapabilities,
  type ConversationSessionSummary,
} from "@agentkib/web-client";
import { canSubmitGoalDraft } from "./session-composer-capabilities";

/** Which composer the current device can use for this entry in its readable catalog. */
export function sessionComposerSurface(
  session: ConversationSessionSummary | undefined,
  access: Access,
): "managed" | "basic" | "history" {
  const surface = sessionDetailCapabilities(session?.agent).composer?.surface;
  if (
    !session ||
    access.status !== "approved" ||
    !access.experimentalEnabled ||
    access.protocolVersion !== 2 ||
    !surface ||
    session.availability === "metadata-only" ||
    session.origin === "auxiliary" ||
    session.origin === "execution" ||
    ("remote" in session && session.remote)
  )
    return "history";
  const device = access.device;
  if (surface === "managed") {
    return device?.send || (device?.accessMode === "full" && device.advancedControl)
      ? "managed"
      : "history";
  }
  return device?.send ? "basic" : "history";
}

/** An already prepared input stays in the draft until the selected executor can consume it. */
export function composerDraftUnavailableReason(
  sessionId: string,
  capabilities: SessionCapabilities | undefined,
  device: Access["device"],
  draft: { attachments: boolean; references: boolean; goal: boolean },
): string | undefined {
  const scoped = capabilities?.sessionId === sessionId ? capabilities : undefined;
  if (draft.attachments) {
    if (!device?.attachments) return "permission_denied";
    if (!scoped?.features.attachments?.available)
      return scoped?.features.attachments?.reason ?? "capability_unavailable";
  }
  if (!draft.references && !draft.goal) return;
  if (device?.accessMode !== "full" || !device.advancedControl) return "permission_denied";
  if (draft.references && !scoped?.features.context?.available)
    return scoped?.features.context?.reason ?? "capability_unavailable";
  if (draft.goal && !canSubmitGoalDraft(scoped))
    return scoped?.features["goal-set"]?.reason ?? "capability_unavailable";
}
