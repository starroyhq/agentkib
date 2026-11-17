import type {
  CodexSessionSettings,
  ManagedOptions,
  SessionProviderCapabilities,
} from "@agentkib/web-client";

const available = { available: true };
const unavailable = { available: false };

/** Adapts a verified create catalog to the model picker's settings view. */
export function newSessionModelSettings(
  options: ManagedOptions | undefined,
  provider: SessionProviderCapabilities | undefined,
): CodexSessionSettings | undefined {
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
