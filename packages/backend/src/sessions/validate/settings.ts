import { ControlValidationError } from "./error";

export type SettingsModel = {
  id?: string;
  resolvedModel?: string;
  efforts?: string[];
  serviceTiers?: (string | { id?: string })[];
  serviceTierIds?: string[];
};

export type SettingsPolicy = {
  matchModel?: (typed: string, models: readonly SettingsModel[]) => string;
  resolvedModel?: boolean;
  clearEffort?: boolean;
  clearMode?: boolean;
  clearServiceTier?: boolean;
  requireWriteScope?: boolean;
  permissionModes?: readonly string[];
  fullAccessPermissionModes?: readonly string[];
};

type SettingsValues = { model?: string };
type SettingsState = {
  executionMode?: string;
  settings?: {
    current?: SettingsValues;
    selected?: SettingsValues;
    writable?: Record<string, unknown>;
    defaults?: Record<string, unknown>;
  };
  current?: SettingsValues;
  selected?: SettingsValues;
  writable?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  models?: SettingsModel[];
  collaborationModes?: { id?: string }[];
  policies?: { id?: string }[];
  revision?: number;
  writeScope?: string;
};

function available(value: unknown): boolean {
  return value && typeof value === "object"
    ? (value as { available?: unknown }).available === true
    : value === true;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= 128 ? value : undefined;
}

function settingField(value: unknown, nullable = false): string | null | undefined {
  if (value === undefined || (value === null && nullable)) return value;
  const text = optionalString(value);
  if (!text || [...text].some((character) => character.charCodeAt(0) <= 0x1f))
    throw new ControlValidationError(400, "invalid_input");
  return text;
}

/** Match the restore button's existing availability, which uses the returned settings mode. */
function canRestoreDefaults(state: SettingsState, writable: Record<string, unknown> | undefined) {
  if (["claude-managed", "claude-follower", "devin-print"].includes(state.executionMode ?? ""))
    return available(writable?.restoreDefaults);
  const defaults = state.defaults ?? state.settings?.defaults;
  return available(writable?.model) && !!optionalString(defaults?.model ?? defaults?.modelId);
}

/** Project the settings fields that the current provider and its live catalog accept. */
export function validateProviderSettings(
  body: Record<string, unknown>,
  value: unknown,
  policy: SettingsPolicy,
  requireFullAccess: () => void,
): Record<string, unknown> {
  const state = value as SettingsState;
  if (state.revision !== body.expectedRevision)
    throw new ControlValidationError(409, "stale_state");

  const params: Record<string, unknown> = {};
  if (policy.requireWriteScope) {
    const scope = optionalString(body.expectedSettingsScope);
    if (!scope || scope !== state.writeScope) throw new ControlValidationError(409, "stale_state");
    params.expectedSettingsScope = scope;
  }
  const currentModel =
    state.selected?.model ??
    state.settings?.selected?.model ??
    state.current?.model ??
    state.settings?.current?.model;
  const writable = state.writable ?? state.settings?.writable;
  const ensureWritable = (key: string) => {
    if (!available(writable?.[key])) throw new ControlValidationError(409, "setting_unavailable");
  };
  const typedModel = settingField(body.model);
  const model = typedModel
    ? (policy.matchModel?.(typedModel, state.models ?? []) ?? typedModel)
    : typedModel;
  const effort = settingField(body.effort, policy.clearEffort);
  const mode = settingField(body.mode, policy.clearMode);
  const serviceTier = settingField(body.serviceTierId, policy.clearServiceTier);
  const policyId = settingField(body.policyId);
  if (body.restoreDefaults !== undefined && body.restoreDefaults !== true)
    throw new ControlValidationError(400, "invalid_restore_defaults");
  if (model) {
    ensureWritable("model");
    if (!state.models?.some((item) => item.id === model))
      throw new ControlValidationError(400, "unsupported_model");
    params.model = model;
  }
  const effectiveModel = model ?? currentModel;
  const selectedModel =
    state.models?.find((item) => item.id === effectiveModel) ??
    (policy.resolvedModel && effectiveModel
      ? state.models?.find((item) => item.resolvedModel === effectiveModel)
      : undefined);
  if (effort !== undefined) {
    ensureWritable("effort");
    if (effort !== null && !selectedModel?.efforts?.includes(effort))
      throw new ControlValidationError(400, "unsupported_effort");
    params.effort = effort;
  }
  if (body.permissionMode !== undefined) {
    if (!policy.permissionModes)
      throw new ControlValidationError(400, "unsupported_permission_mode");
    ensureWritable("permissionMode");
    const permissionMode = String(body.permissionMode);
    if (!policy.permissionModes.includes(permissionMode))
      throw new ControlValidationError(400, "unsupported_permission_mode");
    if (policy.fullAccessPermissionModes?.includes(permissionMode)) requireFullAccess();
    params.permissionMode = body.permissionMode;
  }
  if (mode !== undefined) {
    ensureWritable("mode");
    if (
      mode !== null &&
      (!["default", "plan"].includes(mode) ||
        !state.collaborationModes?.some((item) => item.id === mode))
    )
      throw new ControlValidationError(400, "unsupported_mode");
    params.mode = mode;
  }
  if (serviceTier !== undefined) {
    ensureWritable("serviceTier");
    if (
      serviceTier !== null &&
      ![
        ...(selectedModel?.serviceTiers ?? []).flatMap((entry) =>
          typeof entry === "string" ? [entry] : entry.id ? [entry.id] : [],
        ),
        ...(selectedModel?.serviceTierIds ?? []),
      ].includes(serviceTier)
    )
      throw new ControlValidationError(400, "unsupported_service_tier");
    params.serviceTier = serviceTier;
  }
  if (policyId) {
    ensureWritable("policy");
    if (!state.policies?.some((item) => item.id === policyId))
      throw new ControlValidationError(400, "unsupported_policy");
    params.policyId = policyId;
  }
  if (body.restoreDefaults === true) {
    if (!canRestoreDefaults(state, writable))
      throw new ControlValidationError(409, "defaults_unavailable");
    params.resetDefaults = true;
  }
  if (
    !model &&
    effort === undefined &&
    mode === undefined &&
    serviceTier === undefined &&
    !policyId &&
    body.permissionMode === undefined &&
    body.restoreDefaults !== true
  )
    throw new ControlValidationError(400, "empty_settings");
  return params;
}
