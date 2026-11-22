import type {
  SessionSettings,
  ManagedOptions,
  SessionProviderCapabilities,
} from "@agentkib/web-client";
import { useMemo, useState } from "react";
import type { ComposerModelChange } from "./composer-model-picker";
import { modelEffortsForTier, modelSupportsTier } from "./model-capabilities";

const available = { available: true };
const unavailable = { available: false };

/** Adapts a verified create catalog to the model picker's settings view. */
export function newSessionModelSettings(
  options: ManagedOptions | undefined,
  provider: SessionProviderCapabilities | undefined,
): SessionSettings | undefined {
  if (!options?.available || !options.models?.length) return undefined;
  const reported = options.defaults?.model;
  const defaultModel = reported
    ? (options.models.find((item) => item.id === reported) ??
      options.models.find((item) => item.resolvedModel === reported))
    : options.models.find((item) => item.isDefault);
  const defaults = {
    modelId: defaultModel?.id ?? reported ?? undefined,
    effort: options.defaults?.effort ?? undefined,
    serviceTierId: options.defaults?.serviceTierId ?? undefined,
  };
  const serviceTiers = provider?.create.serviceTiers ? (options.serviceTiers ?? []) : [];
  return {
    sessionId: "",
    available: true,
    revision: 0,
    provider,
    current: defaults,
    defaults,
    writable: {
      model: available,
      effort: available,
      mode: unavailable,
      policy: unavailable,
      serviceTier: serviceTiers.length ? available : unavailable,
      restoreDefaults: available,
    },
    options: {
      models: options.models.map((item) => ({
        id: item.id,
        name: item.name,
        resolvedModel: item.resolvedModel,
        group: item.group,
        efforts: item.efforts ?? [],
        defaultEffort: item.defaultEffort,
        serviceTierIds: provider?.create.serviceTiers ? (item.serviceTierIds ?? []) : [],
        variants: item.variants,
        maxContextTokens: item.maxContextTokens,
      })),
      policies: [],
      serviceTiers,
    },
  };
}

type ModelDraft = {
  scope: string;
  model: string;
  effort: string;
  serviceTierId?: string;
  exactModel?: string;
};

export function useNewSessionModel({
  agent,
  workspaceId,
  authority,
  options,
  provider,
}: {
  agent: string;
  workspaceId?: string;
  authority: string;
  options?: ManagedOptions;
  provider?: SessionProviderCapabilities;
}) {
  const [draft, setDraft] = useState<ModelDraft>();
  const scope = JSON.stringify([
    authority,
    agent,
    provider?.create.catalogScope === "host" ? null : workspaceId,
  ]);
  const settings = useMemo(
    () => (provider?.create.modelPicker ? newSessionModelSettings(options, provider) : undefined),
    [options, provider],
  );
  const saved = draft?.scope === scope ? draft : undefined;
  const models = settings?.options.models ?? [];
  const selectedModel = models.find((item) => item.id === saved?.model);
  const current = selectedModel ?? models.find((item) => item.id === settings?.defaults.modelId);
  const modelId = current?.id ?? settings?.defaults.modelId;
  const chosenTier =
    saved?.serviceTierId !== undefined &&
    provider?.create.serviceTiers &&
    modelSupportsTier(current, saved.serviceTierId, saved.effort || undefined)
      ? saved.serviceTierId
      : undefined;
  const shownTier = chosenTier ?? (!selectedModel ? settings?.defaults.serviceTierId : undefined);
  const effort =
    saved?.effort && modelEffortsForTier(current, shownTier).includes(saved.effort)
      ? saved.effort
      : "";
  const shownEffort =
    effort ||
    (selectedModel
      ? provider?.models.effortDefault === false
        ? selectedModel.defaultEffort
        : undefined
      : settings?.defaults.effort);
  const canClearEffort =
    provider?.models.clearEffort === true &&
    !!effort &&
    (!shownTier || modelSupportsTier(current, shownTier));
  const model =
    chosenTier === "" && current?.variants?.some((item) => item.id === saved?.exactModel)
      ? (saved?.exactModel ?? "")
      : (selectedModel?.id ?? "");

  function reset() {
    setDraft(undefined);
  }

  async function change(update: ComposerModelChange) {
    if (update.restoreDefaults) {
      reset();
      return true;
    }

    const nextModel = update.model ? models.find((item) => item.id === update.model) : current;
    if (!nextModel) return false;
    if (provider?.models.selection === "variants" && update.model !== undefined) {
      setDraft({ scope, model: nextModel.id, effort: "" });
      return true;
    }

    const tierChanged = update.serviceTierId !== undefined;
    const tier = tierChanged ? (update.serviceTierId ?? "") : chosenTier;
    const nextEffort =
      update.effort !== undefined
        ? (update.effort ?? "")
        : update.model !== undefined
          ? effort
          : tierChanged
            ? (shownEffort ?? "")
            : effort;
    const matched = tierChanged
      ? nextModel.variants?.filter(
          (variant) =>
            variant.serviceTierId === (tier || undefined) &&
            (!nextEffort || variant.effort === nextEffort),
        )
      : undefined;
    if (matched && matched.length !== 1) return false;
    const variant = matched?.[0];
    const supportsEffort = modelEffortsForTier(nextModel, tier ?? shownTier).includes(nextEffort);
    setDraft({
      scope,
      model: update.model ?? (tierChanged ? nextModel.id : (selectedModel?.id ?? "")),
      effort: supportsEffort ? nextEffort : (variant?.effort ?? ""),
      serviceTierId: tier,
      // A tier with one effort-free variant can only be named by its concrete model.
      exactModel: tierChanged && !tier && !variant?.effort ? variant?.id : undefined,
    });
    return true;
  }

  return {
    scope,
    settings,
    modelId,
    model,
    effort,
    chosenTier,
    shownTier,
    shownEffort,
    canClearEffort,
    change,
    reset,
  };
}
