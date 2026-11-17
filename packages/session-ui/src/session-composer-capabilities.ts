import type { SessionCapabilities, SessionProviderCapabilities } from "@agentkib/web-client";

const goalFeatures = ["goal", "goal-set", "goal-pause", "goal-resume", "goal-clear"] as const;

export function sessionComposerCapabilities({
  capabilities,
  sessionId,
  legacyReads,
  attachmentsGranted,
  settingsSlots,
}: {
  capabilities?: SessionCapabilities;
  sessionId: string;
  legacyReads: boolean;
  attachmentsGranted: boolean;
  settingsSlots?: Pick<SessionProviderCapabilities["create"], "modelPicker" | "permissionPicker">;
}) {
  const feature = (name: keyof SessionCapabilities["features"]) => capabilities?.features[name];
  const attachments =
    capabilities?.sessionId === sessionId && feature("attachments")?.available === true;
  const settingsReadReason =
    capabilities?.sessionId === sessionId
      ? (feature("settings-state")?.reason ?? feature("settings")?.reason)
      : undefined;
  const settingsAccessDenied =
    settingsReadReason === "permission_denied" || settingsReadReason === "same_origin_required";

  return {
    feature,
    settingsReadable:
      legacyReads || !!(feature("settings-state")?.available || feature("settings")?.available),
    settingsReadReason,
    reservesModelSlot: !settingsAccessDenied && settingsSlots?.modelPicker === true,
    reservesPermissionSlot: !settingsAccessDenied && settingsSlots?.permissionPicker === true,
    goalReadable: legacyReads || goalFeatures.some((key) => feature(key)?.available),
    goalDraftOffered:
      capabilities?.sessionId === sessionId && feature("goal-draft")?.available === true,
    resourcesReadable:
      legacyReads || !!(feature("resources")?.available || feature("context")?.available),
    attachmentOffered: legacyReads || attachments,
    attachmentAllowed: attachments && attachmentsGranted,
  };
}
