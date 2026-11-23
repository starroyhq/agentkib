import {
  type Access,
  type SessionSettings,
  type Live,
  type SessionActionBody,
  type SessionCapabilities,
  type SessionProviderCapabilities,
  type WebClient,
} from "@agentkib/web-client";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { resolveSessionProvider } from "./session-provider";
import { nativeAppControlsSession } from "./agents/codex/settings-ownership";
import { sessionModelSettings } from "./agents/session-model-settings";

export { observedClaudePermissionLabel } from "./agents/claude-code/permission-observation";

const goalFeatures = ["goal", "goal-set", "goal-pause", "goal-resume", "goal-clear"] as const;

export function canSubmitGoalDraft(capabilities?: SessionCapabilities) {
  return !!(
    capabilities?.features["goal-draft"]?.available || capabilities?.features["goal-set"]?.available
  );
}

export function composerFollowerSettingsRequest(
  fields: Partial<SessionActionBody>,
  scope: string | undefined,
) {
  const keys = Object.keys(fields);
  if (!scope || !keys.length || keys.some((key) => key !== "model" && key !== "effort"))
    return undefined;
  return { ...fields, expectedSettingsScope: scope };
}

/** The live stream can display settings. Only a dedicated settings read can authorize a write. */
export function useComposerFollowerSettings(
  client: WebClient,
  access: Access | undefined,
  sessionId: string,
  live: Live | undefined,
) {
  const follower = nativeAppControlsSession(live, sessionId);
  const authority = useMemo(
    () => ({ client, sessionId, follower }),
    [
      client,
      sessionId,
      follower,
      access?.status,
      access?.bootId,
      access?.device?.id,
      access?.device?.accessMode,
      access?.device?.advancedControl,
      live?.connectionGeneration,
      live?.runtimeBootId,
    ],
  );
  const currentAuthority = useRef(authority);
  useLayoutEffect(() => {
    currentAuthority.current = authority;
  }, [authority]);
  const last = useRef<{ authority: typeof authority; settings: SessionSettings }>(undefined);
  const rememberRead = useCallback(
    (settings: SessionSettings) => {
      if (authority !== currentAuthority.current || settings.sessionId !== authority.sessionId)
        return;
      last.current = { authority, settings };
    },
    [authority],
  );
  const settings = last.current?.authority === authority ? last.current.settings : undefined;
  const writeScope =
    follower &&
    access?.status === "approved" &&
    access.device?.accessMode === "full" &&
    access.device.advancedControl === true &&
    settings?.available &&
    settings.executionMode === "codex-follower" &&
    settings.revision === live?.revision
      ? settings.writeScope
      : undefined;
  return { follower, writeScope, rememberRead, followerAuthority: authority };
}

export function existingSessionComposerCapabilities({
  capabilities,
  sessionId,
  currentId,
  agent,
  access,
  legacyReads,
}: {
  capabilities?: SessionCapabilities;
  sessionId: string;
  currentId?: string;
  agent?: string;
  access?: Access;
  legacyReads: boolean;
}) {
  const declaration = resolveSessionProvider(
    currentId === sessionId && currentId && agent ? { id: currentId, agent } : undefined,
    capabilities,
  );
  return sessionComposerCapabilities({
    capabilities,
    sessionId,
    legacyReads,
    attachmentsGranted: access?.device?.attachments === true,
    provider: declaration && "models" in declaration ? declaration : undefined,
    slotsGranted:
      currentId === sessionId &&
      access?.status === "approved" &&
      access.device?.accessMode === "full" &&
      access.device.advancedControl === true,
  });
}

export function sessionComposerCapabilities({
  capabilities,
  sessionId,
  legacyReads,
  attachmentsGranted,
  settingsSlots,
  provider,
  slotsGranted = false,
}: {
  capabilities?: SessionCapabilities;
  sessionId: string;
  legacyReads: boolean;
  attachmentsGranted: boolean;
  settingsSlots?: Pick<SessionProviderCapabilities["create"], "modelPicker" | "permissionPicker">;
  provider?: SessionProviderCapabilities;
  slotsGranted?: boolean;
}) {
  const selectedCapabilities = capabilities?.sessionId === sessionId ? capabilities : undefined;
  const legacyFallback = legacyReads && capabilities === undefined;
  const feature = (name: keyof SessionCapabilities["features"]) =>
    selectedCapabilities?.features[name];
  const attachments =
    capabilities?.sessionId === sessionId && feature("attachments")?.available === true;
  const settingsRead = feature("settings-state");
  const settingsReadReason = settingsRead ? settingsRead.reason : feature("settings")?.reason;
  const settingsAccessDenied =
    settingsReadReason === "permission_denied" || settingsReadReason === "same_origin_required";
  const slots = slotsGranted ? provider?.composer : undefined;
  const settingsWriteReason =
    feature("settings")?.available === false ? feature("settings")?.reason : undefined;
  const terminalModel = sessionModelSettings(provider)?.inTerminal(selectedCapabilities) === true;
  const goalReadable = legacyFallback || goalFeatures.some((key) => feature(key)?.available);
  const goalDraftOffered = feature("goal-draft")?.available === true;
  const resourcesReadable =
    legacyFallback || !!(feature("resources")?.available || feature("context")?.available);

  return {
    feature,
    settingsReadable:
      !settingsAccessDenied &&
      (legacyFallback ||
        !!(feature("settings-state")?.available || feature("settings")?.available)),
    settingsWritable: feature("settings")?.available === true,
    settingsReadOnly:
      settingsWriteReason === "follower-operation-unverified" ||
      settingsWriteReason === "native-operation-not-integrated" ||
      settingsWriteReason === "open-in-original-client",
    terminalModel,
    canOpenTerminalModel:
      !settingsAccessDenied && slotsGranted && feature("open-model-picker")?.available === true,
    settingsAccessDenied,
    settingsReadReason,
    modelRegistered: (provider?.composer?.modelPicker ?? settingsSlots?.modelPicker) === true,
    permissionRegistered:
      (provider?.composer?.permissionPicker ?? settingsSlots?.permissionPicker) === true,
    reservesModelSlot:
      !settingsAccessDenied && (slots?.modelPicker ?? settingsSlots?.modelPicker) === true,
    reservesPermissionSlot:
      !settingsAccessDenied &&
      (slots?.permissionPicker ?? settingsSlots?.permissionPicker) === true,
    goalReadable,
    goalDraftOffered,
    goalOffered: slots?.goal === true || goalReadable || goalDraftOffered,
    planOffered: slots?.plan === true,
    resourcesReadable,
    resourcesOffered: slots?.workspaceResources === true || resourcesReadable,
    attachmentOffered: slots?.attachments === true || legacyFallback || attachments,
    attachmentAllowed: attachments && attachmentsGranted,
  };
}
