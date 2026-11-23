import type {
  ClaudePermissionMode,
  SessionSettings,
  SessionSettingValues,
  DevinPermissionMode,
  Live,
  ManagedAgent,
  SessionActionBody,
  SessionCapabilities,
} from "@agentkib/web-client";
import { claudeTerminalPermission } from "./claude-terminal-permission";
import type { InteractionLocale } from "./interaction-model";
import { newSessionPermissions } from "./new-session";
import { changeClaudeTerminalPermissionCopy } from "./permission-mode-copy";
import { codexPolicyLabel, dshPolicyLabel } from "./policy-labels";
import { sessionCollaborationMode } from "./session-collaboration-mode";
import { observedClaudePermissionLabel } from "./session-composer-capabilities";

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
    live.executionMode === "claude-managed" &&
    live.executionLocation === "agentkib" &&
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

const CLAUDE_PERMISSION_IDS: readonly ClaudePermissionMode[] = ["default", "acceptEdits"];
const DEVIN_PERMISSION_IDS: readonly DevinPermissionMode[] = [
  "auto",
  "accept-edits",
  "smart",
  "dangerous",
];

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
  settings,
  selection,
  live,
  sessionId,
  locale,
  locked,
  full,
  write,
}: {
  agent: ManagedAgent | null;
  settings?: SessionSettings;
  selection?: SessionSettingValues;
  live?: Live;
  sessionId: string;
  locale: InteractionLocale;
  locked: boolean;
  full: boolean;
  write: (fields: Partial<SessionActionBody>) => Promise<boolean>;
}) {
  const modeAgent = agent === "claude-code" || agent === "devin" ? agent : undefined;
  const availableSettings = settings?.available ? settings : undefined;
  const permissionField = modeAgent
    ? availableSettings?.writable.permissionMode
    : availableSettings?.writable.policy;
  const canChoosePermission = !locked && permissionField?.available === true;
  const policyLabel = agent === "deepseek-harness" ? dshPolicyLabel : codexPolicyLabel;
  const policyId =
    selection?.policyId ??
    (settings?.sessionId === sessionId ? settings.current.policyId : undefined);
  const permissionItems = modeAgent
    ? (
        newSessionPermissions(
          modeAgent,
          { available: true, permissionModes: availableSettings?.options.permissionModes },
          locale,
        )?.choices ?? []
      ).flatMap((choice) => {
        const permissionMode = (
          modeAgent === "claude-code" ? CLAUDE_PERMISSION_IDS : DEVIN_PERMISSION_IDS
        ).find((id) => id === choice.id);
        return permissionMode
          ? [
              {
                ...choice,
                selected: selection?.permissionMode === permissionMode,
                disabled: !canChoosePermission,
                fields: { permissionMode },
              },
            ]
          : [];
      })
    : (availableSettings?.options.policies ?? []).map((item) => {
        const label = policyLabel(item.id, locale);
        return {
          id: item.id,
          name: label?.name ?? item.name,
          description: label?.description ?? item.description,
          risky: item.id === "full-access-on-request" || item.id === "danger-full-access",
          selected: policyId === item.id,
          disabled: !canChoosePermission,
          fields: { policyId: item.id },
        };
      });
  const currentPermission = permissionItems.find((item) => item.selected);
  const observedPolicy = policyId ? policyLabel(policyId, locale) : undefined;
  const terminalPermission =
    agent === "claude-code"
      ? claudeTerminalPermission(live, sessionId, selection?.permissionMode, locale)
      : undefined;
  const permissionHint =
    agent === "claude-code" &&
    live?.sessionId === sessionId &&
    live.executionMode === "claude-follower" &&
    live.executionLocation === "terminal"
      ? changeClaudeTerminalPermissionCopy[locale]
      : undefined;
  const observedPermission =
    agent === "claude-code"
      ? observedClaudePermissionLabel(
          selection?.permissionMode ??
            (live?.sessionId === sessionId ? live.permission?.mode : undefined) ??
            undefined,
          locale,
        )
      : undefined;

  const collaboration = sessionCollaborationMode(settings, selection);
  const clearSavedMode =
    agent === "codex" &&
    !collaboration &&
    availableSettings?.writable.mode?.available === true &&
    !!availableSettings.selected?.mode;
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
    if (item && !item.disabled && !item.selected) void write(item.fields);
  }

  function setPlan(mode: "default" | "plan") {
    if (planAvailable && collaboration?.modes.includes(mode) && planOn !== (mode === "plan"))
      void write(collaboration.change(mode));
  }

  function clearPlan() {
    if (canClearSavedMode) void write({ mode: null });
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
      observedPolicy?.name,
    permissionDescription: terminalPermission?.description,
    permissionHint,
    permissionRisky: terminalPermission?.risky ?? currentPermission?.risky,
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
