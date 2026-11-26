import {
  sessionProviderCapabilities,
  sessionProviderDeclaration,
} from "@agentkib/runtime-protocol";

type RecordValue = Record<string, unknown>;
type SettingOption = { id: string; label: string };
type ModelOption = SettingOption & {
  efforts: string[];
  serviceTiers: SettingOption[];
  defaultEffort?: string;
  defaultServiceTier?: string;
  resolvedModel?: string;
};

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function records(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function option(value: unknown): SettingOption | undefined {
  const row = record(value);
  const id = string(row.id) ?? string(value);
  return id ? { id, label: string(row.name) ?? id } : undefined;
}

function writable(value: unknown): boolean {
  return value === true || record(value).available === true;
}

export function workerSettingsChanging(input: RecordValue): boolean {
  return ["modelId", "reasoningEffort", "serviceTierId"].some((key) => Object.hasOwn(input, key));
}

export function workerSettingsInput(input: RecordValue) {
  const keys = new Set(["worker", "modelId", "reasoningEffort", "serviceTierId"]);
  if (Object.keys(input).some((key) => !keys.has(key))) throw new Error("invalid-input");
  const read = (key: string, nullable = false) => {
    const value = input[key];
    if (value === undefined || (nullable && value === null)) return value;
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 128 ||
      [...value].some((character) => character.charCodeAt(0) <= 0x1f)
    )
      throw new Error("invalid-input");
    return value;
  };
  return {
    modelId: read("modelId") ?? undefined,
    effort: read("reasoningEffort", true),
    serviceTier: read("serviceTierId", true),
  };
}

/** Use the same selected, effective and catalog values as the session model picker. */
export function projectWorkerSettings(
  agent: string | undefined,
  live: RecordValue | null,
  raw: unknown,
  status: string,
) {
  const capability = sessionProviderDeclaration(agent);
  const modelControls = sessionProviderCapabilities(agent)?.models;
  const tiersSupported = capability?.projectAgent?.workerServiceTiers === true;
  const state = record(raw);
  const snapshot = record(live?.settings);
  const settings = record(state.settings);
  const models: ModelOption[] = [];
  const tiers = new Map<string, SettingOption>();
  for (const row of records(state.serviceTiers ?? record(state.options).serviceTiers)) {
    const tier = option(row);
    if (tiersSupported && tier) tiers.set(tier.id, tier);
  }
  for (const row of records(state.models ?? record(state.options).models)) {
    const model = option(row);
    if (!model) continue;
    const serviceTiers: SettingOption[] = [];
    const offered = row.serviceTierOptions ?? row.serviceTiers ?? row.serviceTierIds;
    if (tiersSupported && Array.isArray(offered)) {
      for (const entry of offered) {
        const tier = option(entry);
        if (!tier) continue;
        const display = tiers.get(tier.id) ?? tier;
        tiers.set(tier.id, display);
        serviceTiers.push(display);
      }
    }
    models.push({
      ...model,
      efforts: Array.isArray(row.efforts)
        ? row.efforts.flatMap((entry) => string(entry) ?? [])
        : [],
      serviceTiers,
      defaultEffort: string(row.defaultEffort),
      defaultServiceTier: string(row.defaultServiceTier),
      resolvedModel: string(row.resolvedModel),
    });
  }
  const current = record(state.current ?? settings.current ?? snapshot.current ?? live);
  const selected = record(state.selected ?? settings.selected ?? snapshot.selected);
  const defaults = record(state.defaults ?? settings.defaults ?? snapshot.defaults);
  const modelOf = (row: RecordValue) => string(row.model ?? row.modelId);
  const running = workerSettingsRunning(live, status);
  const effective = running ? current : selected;
  const providerDefault = records(state.models).find((row) => row.isDefault === true);
  const modelId =
    modelOf(effective) ?? modelOf(current) ?? modelOf(defaults) ?? string(providerDefault?.id);
  const matchingModel = modelId
    ? models.find(({ id, resolvedModel }) => id === modelId || resolvedModel === modelId)
    : undefined;
  const currentMatches = modelOf(current) === modelId;
  const defaultsMatch = modelOf(defaults) === modelId;
  const pending =
    !running &&
    (state.applicationStatus ?? settings.applicationStatus ?? snapshot.applicationStatus) ===
      "pending";
  const reasoningEffort =
    string(effective.effort) ??
    (currentMatches && !(pending && effective.effort === null)
      ? string(current.effort)
      : undefined) ??
    matchingModel?.defaultEffort ??
    (defaultsMatch ? string(defaults.effort) : undefined) ??
    null;
  const clearingTier =
    !running &&
    effective !== current &&
    (effective.serviceTier === null || effective.serviceTierId === null);
  const tierId =
    string(effective.serviceTier ?? effective.serviceTierId) ??
    (currentMatches && !clearingTier
      ? string(current.serviceTier ?? current.serviceTierId)
      : undefined) ??
    (defaultsMatch ? string(defaults.serviceTier ?? defaults.serviceTierId) : undefined) ??
    matchingModel?.defaultServiceTier;
  const speed =
    tiersSupported &&
    (tierId || (modelId && (state.available === true || Object.hasOwn(current, "serviceTier"))))
      ? tierId
        ? (tiers.get(tierId) ?? { id: tierId })
        : { id: null }
      : null;
  const fields = record(state.writable ?? settings.writable);
  const canEdit = {
    model: writable(fields.model) && models.length > 0,
    effort: writable(fields.effort) && models.some((model) => model.efforts.length > 0),
    serviceTier: tiersSupported && writable(fields.serviceTier) && (tiers.size > 0 || !!tierId),
  };
  const editable =
    !running &&
    status === "idle" &&
    live?.activity !== "compacting" &&
    live?.reason !== "control-outcome-unconfirmed" &&
    state.available === true &&
    Object.values(canEdit).some(Boolean);
  const reason = running ? "worker-running" : !editable ? "worker-settings-unavailable" : undefined;
  return {
    settings: {
      model: modelId ? { id: modelId, label: matchingModel?.label ?? modelId } : null,
      reasoningEffort,
      speed,
      editable,
      ...(reason ? { reason } : {}),
    },
    options: {
      models: models.map(({ id, label, efforts, serviceTiers, resolvedModel, defaultEffort }) => ({
        id,
        label,
        efforts,
        serviceTiers,
        resolvedModel,
        defaultEffort,
      })),
      serviceTiers: tiers.size ? [{ id: null, label: "Standard" }, ...tiers.values()] : [],
    },
    expected: {
      revision: typeof state.revision === "number" ? state.revision : undefined,
      runtimeBootId: string(state.runtimeBootId) ?? string(live?.runtimeBootId),
      writeScope: string(state.writeScope),
    },
    canEdit,
    tiersSupported,
    independent: modelControls?.selection === "independent",
    effortDefault: modelControls?.effortDefault === true,
    clearEffort: modelControls?.clearEffort === true,
  };
}

export function workerSettingsRunning(live: RecordValue | null, status: string): boolean {
  return (
    typeof live?.turnId === "string" ||
    ["running", "starting", "awaiting-approval", "waiting-approval", "waiting-input"].includes(
      status,
    )
  );
}

export function delegatedWorkerSettings(
  settings: ReturnType<typeof projectWorkerSettings>["settings"],
  paused: boolean,
) {
  return paused && settings.editable
    ? { ...settings, editable: false, reason: "delegation-paused" }
    : settings;
}

export function workerSettingsPatch(
  input: ReturnType<typeof workerSettingsInput>,
  view: ReturnType<typeof projectWorkerSettings>,
) {
  const { modelId } = input;
  let { effort, serviceTier } = input;
  const selected = modelId ?? view.settings.model?.id;
  const model = view.options.models.find(
    ({ id, resolvedModel }) =>
      id === selected || (modelId === undefined && resolvedModel === selected),
  );
  if (modelId !== undefined && !model) throw new Error("unsupported-model");
  if (
    effort === null ? !view.clearEffort : effort !== undefined && !model?.efforts.includes(effort)
  )
    throw new Error("unsupported-effort");
  if (
    serviceTier !== undefined &&
    (!view.tiersSupported ||
      (serviceTier !== null && !model?.serviceTiers.some(({ id }) => id === serviceTier)))
  )
    throw new Error("unsupported-service-tier");
  if (
    (modelId !== undefined && !view.canEdit.model) ||
    (effort !== undefined && !view.canEdit.effort) ||
    (serviceTier !== undefined && !view.canEdit.serviceTier)
  )
    throw new Error("worker-settings-unavailable");
  if (modelId !== undefined && model && modelId !== view.settings.model?.id && view.independent) {
    const priorEffort = view.settings.reasoningEffort;
    if (
      effort === undefined &&
      view.canEdit.effort &&
      priorEffort &&
      !model.efforts.includes(priorEffort)
    )
      effort =
        model.defaultEffort ??
        (!view.clearEffort ? model.efforts[0] : undefined) ??
        (view.clearEffort || !view.effortDefault ? null : undefined);
    const priorTier = view.settings.speed?.id;
    if (
      serviceTier === undefined &&
      view.canEdit.serviceTier &&
      priorTier &&
      !model.serviceTiers.some(({ id }) => id === priorTier)
    )
      serviceTier = null;
  }
  return {
    ...(modelId !== undefined ? { model: modelId } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
  };
}

/** A project panel polls while open. Coalesce reads and reuse only unchanged live observations. */
export class WorkerSettingsReads {
  #cache = new Map<string, { version: string; expiresAt: number; result: Promise<unknown> }>();

  summary(id: string, live: RecordValue | null, read: () => Promise<unknown>): Promise<unknown> {
    const settings = record(live?.settings);
    // Native stream deltas can change revision without touching the model or its choices.
    const model = Object.hasOwn(settings, "selected")
      ? [settings.current, settings.selected, settings.applicationStatus]
      : live?.revision;
    const version = JSON.stringify([live?.runtimeBootId, live?.status, live?.executionMode, model]);
    const prior = this.#cache.get(id);
    if (prior?.version === version && Date.now() < prior.expiresAt) return prior.result;
    if (this.#cache.size >= 128) this.#cache.delete(this.#cache.keys().next().value!);
    const entry = {
      version,
      expiresAt: Infinity,
      result: Promise.resolve()
        .then(read)
        .catch(() => null),
    };
    this.#cache.set(id, entry);
    void entry.result.then(() => {
      entry.expiresAt = Date.now() + 15_000;
    });
    return entry.result;
  }

  invalidate(id: string): void {
    this.#cache.delete(id);
  }
}
