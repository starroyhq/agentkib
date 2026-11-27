import type {
  SessionProviderCapabilities,
  SessionSettings,
  SessionSettingValues,
  Live,
  ManagedAgent,
  SessionActionBody,
  SessionCapabilities,
} from "@agentkib/web-client";
import { hasManagedPreparedSettings } from "./agents/session-model-settings";
import { sessionPermissionDescriptor } from "./agents/session-permissions";
import { sessionPermissionObservation } from "./agents/session-permission-observations";
import type { InteractionLocale } from "./interaction-model";
import { sessionCollaborationMode } from "./session-collaboration-mode";

export type PendingComposerSettings = Pick<
  SessionActionBody,
  | "model"
  | "effort"
  | "mode"
  | "policyId"
  | "serviceTierId"
  | "restoreDefaults"
  | "permissionMode"
  | "expectedRevision"
> & { followerAuthority?: object; nextTurn?: boolean };

export function composerSettingsSelection(
  settings: SessionSettings,
  prepared: boolean,
  options: { live?: Live; staged?: PendingComposerSettings } = {},
) {
  if (!prepared) return settings.selected ?? settings.current;
  const { live, staged } = options;
  const managedWorker =
    live?.sessionId === settings.sessionId &&
    live.revision === settings.revision &&
    hasManagedPreparedSettings(live) &&
    (live.execution ? live.execution.observed : live.executionLocation === "agentkib") &&
    ["idle", "running", "waiting-approval", "awaiting-approval", "waiting-input"].includes(
      live.status,
    );
  if (
    settings.applicationStatus === "pending" &&
    settings.selected &&
    (managedWorker ||
      (staged?.nextTurn &&
        confirmsComposerSettings(settings, staged, { prepared, variants: false, follower: false })))
  ) {
    // Editable values describe the saved override even while the current worker uses its old one.
    return {
      modelId:
        settings.defaults.modelId ??
        (Object.keys(settings.selected).length ? settings.current.modelId : undefined),
      ...settings.selected,
    };
  }
  return {
    ...settings.current,
    ...settings.selected,
    modelId: settings.selected?.modelId ?? settings.current.modelId,
    effort: settings.selected?.effort ?? settings.current.effort,
    permissionMode: settings.selected?.permissionMode ?? settings.current.permissionMode,
  };
}

export function confirmsComposerSettings(
  settings: SessionSettings | undefined,
  pending: PendingComposerSettings | undefined,
  { prepared, variants, follower }: { prepared: boolean; variants: boolean; follower: boolean },
) {
  if (!settings?.available || !pending) return false;
  if (settings.applicationStatus === "unknown") return false;
  if (pending.nextTurn && settings.revision <= pending.expectedRevision) return false;
  if (!pending.nextTurn && settings.applicationStatus === "pending") return false;
  if (
    !pending.nextTurn &&
    (prepared || variants || follower) &&
    (settings.applicationStatus !== "confirmed" || settings.revision <= pending.expectedRevision)
  )
    return false;

  const { selected, defaults } = settings;
  const current = pending.nextTurn && !follower ? selected : settings.current;
  if (!current) return false;
  if (pending.nextTurn && prepared && pending.restoreDefaults)
    return (
      current.modelId === undefined &&
      current.effort === undefined &&
      current.permissionMode === undefined
    );
  const expected: Omit<PendingComposerSettings, "expectedRevision"> = pending.restoreDefaults
    ? {
        model: defaults.modelId,
        effort: defaults.effort,
        serviceTierId: defaults.serviceTierId,
        permissionMode: defaults.permissionMode,
      }
    : pending;
  return (
    (expected.model === undefined ||
      current.modelId === expected.model ||
      (prepared &&
        !!current.modelId &&
        settings.options.models.find((item) => item.id === expected.model)?.resolvedModel ===
          current.modelId)) &&
    (expected.effort === undefined ||
      (prepared && expected.effort === null
        ? selected !== undefined && selected.effort === undefined
        : current.effort === (expected.effort ?? undefined))) &&
    (expected.mode === undefined ||
      (expected.mode === null
        ? selected !== undefined && selected.mode === undefined
        : current.mode === expected.mode)) &&
    (expected.policyId === undefined || current.policyId === expected.policyId) &&
    (expected.permissionMode === undefined || current.permissionMode === expected.permissionMode) &&
    (expected.serviceTierId === undefined ||
      (expected.serviceTierId === null
        ? current.serviceTierId == null ||
          (!variants && current.serviceTierId === defaults.serviceTierId)
        : current.serviceTierId === expected.serviceTierId))
  );
}

export function composerSettingsWriteLocked({
  settings,
  online,
  busy,
  stale,
  uncertain,
  live,
  capabilities,
  feature,
}: {
  settings?: SessionSettings;
  online: boolean;
  busy: boolean;
  stale: boolean;
  uncertain: boolean;
  live?: Live;
  capabilities?: SessionCapabilities;
  feature?: { available: boolean };
}) {
  return (
    !online ||
    busy ||
    stale ||
    uncertain ||
    !settings?.available ||
    feature?.available !== true ||
    live?.activity === "compacting" ||
    live?.status === "outcome-unknown" ||
    live?.reason === "control-outcome-unconfirmed" ||
    capabilities?.reason === "control-outcome-unconfirmed"
  );
}

export function projectComposerSettingsControls({
  agent,
  provider,
  settings,
  selection,
  live,
  sessionId,
  locale,
  locked,
  full,
  local,
  write,
}: {
  agent: ManagedAgent | null;
  provider?: SessionProviderCapabilities;
  settings?: SessionSettings;
  selection?: SessionSettingValues;
  live?: Live;
  sessionId: string;
  locale: InteractionLocale;
  locked: boolean;
  full: boolean;
  local: boolean;
  write: (fields: Partial<SessionActionBody>, control: "permission" | "plan") => Promise<boolean>;
}) {
  const permission = sessionPermissionDescriptor(agent ?? undefined)?.settings;
  const available = settings?.available ? settings : undefined;
  const field = provider?.permissionField;
  const observation = sessionPermissionObservation(provider);
  const permissionField =
    field === "permissionMode"
      ? available?.writable.permissionMode
      : field === "policyId"
        ? available?.writable.policy
        : undefined;
  const canChoosePermission = !locked && permissionField?.available === true;
  const policyId =
    selection?.policyId ??
    (settings?.sessionId === sessionId ? settings.current.policyId : undefined);
  const permissionItems =
    field === "permissionMode"
      ? (permission?.modeIds ?? []).flatMap((permissionMode) => {
          const item = available?.options.permissionModes?.find(({ id }) => id === permissionMode);
          if (!item) return [];
          const label = permission?.label(permissionMode, locale);
          return [
            {
              id: permissionMode,
              name: label?.name ?? observation?.label(permissionMode, locale) ?? permissionMode,
              description: label?.description,
              risky: permission?.risky(permissionMode),
              selected: selection?.permissionMode === permissionMode,
              disabled: !canChoosePermission || item.available === false,
              fields: { permissionMode },
            },
          ];
        })
      : field === "policyId"
        ? (available?.options.policies ?? []).map((item) => {
            const label = permission?.label(item.id, locale);
            return {
              id: item.id,
              name: label?.name ?? item.name,
              description: label?.description ?? item.description,
              risky: permission?.risky(item.id),
              selected: policyId === item.id,
              disabled: !canChoosePermission,
              fields: { policyId: item.id },
            };
          })
        : [];
  const currentPermission = permissionItems.find((item) => item.selected);
  const observedPolicy =
    field === "policyId" && policyId ? permission?.label(policyId, locale) : undefined;
  const terminalPermission = observation?.terminal(
    live,
    sessionId,
    selection?.permissionMode,
    locale,
  );
  const permissionHint =
    local &&
    observation?.isTerminal(live, sessionId) &&
    (live?.execution?.owner === "terminal" || live?.executionLocation === "terminal")
      ? observation.terminalHint(locale)
      : undefined;
  const livePermission = live?.sessionId === sessionId ? live.permission : undefined;
  const observedPermission = observation?.label(
    selection?.permissionMode ?? livePermission?.mode ?? undefined,
    locale,
  );
  const permissionMode =
    selection?.permissionMode ?? (livePermission?.previous ? undefined : livePermission?.mode);
  const knownMode =
    field === "permissionMode" && permissionMode
      ? permission?.label(permissionMode, locale)
      : undefined;

  const collaboration = sessionCollaborationMode(settings, selection);
  const clearSavedMode =
    provider?.create.planMode === "mode" &&
    !collaboration &&
    available?.writable.mode?.available === true &&
    !!available.selected?.mode;
  const canClearSavedMode = clearSavedMode && !locked;
  const planOn =
    (collaboration?.field
      ? selection?.[collaboration.field]
      : (selection?.mode ?? selection?.permissionMode)) === "plan";
  const planAvailable = full && !locked && collaboration?.writable === true;
  const toggledMode = planOn ? "default" : "plan";
  const canExitPlan =
    canClearSavedMode || (planAvailable && collaboration?.modes.includes("default") === true);
  const canTogglePlan = planAvailable && collaboration?.modes.includes(toggledMode) === true;

  function changePermission(id: string) {
    const item = permissionItems.find((item) => item.id === id);
    if (item && !item.disabled && !item.selected) void write(item.fields, "permission");
  }

  function setPlan(mode: "default" | "plan") {
    if (planAvailable && collaboration?.modes.includes(mode) && planOn !== (mode === "plan"))
      void write(collaboration.change(mode), "plan");
  }

  function clearPlan() {
    if (canClearSavedMode) void write({ mode: null }, "plan");
  }

  return {
    permissionItems,
    permissionField,
    permissionReadOnlyWithoutMenu:
      permissionField?.available === false &&
      !permissionItems.length &&
      !terminalPermission?.description &&
      !permissionHint,
    permissionLabel:
      terminalPermission?.name ??
      currentPermission?.name ??
      observedPermission ??
      knownMode?.name ??
      observedPolicy?.name,
    permissionDescription: terminalPermission?.description ?? permission?.menuDescription?.(locale),
    permissionHint,
    permissionRisky:
      terminalPermission?.risky ??
      currentPermission?.risky ??
      (knownMode && permissionMode ? permission?.risky(permissionMode) : undefined),
    changePermission,
    collaboration,
    planOn,
    planAvailable,
    canTogglePlan,
    canExitPlan,
    clearSavedMode,
    canClearSavedMode,
    setPlan,
    clearPlan,
    togglePlan: () => setPlan(toggledMode),
    exitPlan: () => (canClearSavedMode ? clearPlan() : setPlan("default")),
  };
}
