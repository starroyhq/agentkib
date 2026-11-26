const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export type ManagedModelOption = {
  id: string;
  name?: string;
  isDefault: boolean;
  defaultEffort: string | null;
  defaultServiceTier: string | null;
  efforts: string[];
  serviceTiers: string[];
  serviceTierOptions?: { id: string; name?: string }[];
};

export function projectManagedModels(value: unknown): ManagedModelOption[] {
  const rows = isObject(value) && Array.isArray(value.data) ? value.data : null;
  if (!rows) throw new Error("invalid-model-catalog");
  return rows
    .filter((model) => isObject(model) && model.hidden !== true)
    .slice(0, 100)
    .map((model) => {
      const row = model as Record<string, unknown>;
      const tiers = Array.isArray(row.serviceTiers)
        ? row.serviceTiers.slice(0, 16).flatMap((tier: unknown) => {
            if (!isObject(tier) || typeof tier.id !== "string" || !tier.id) return [];
            return [{ id: tier.id, ...(typeof tier.name === "string" ? { name: tier.name } : {}) }];
          })
        : [];
      return {
        name: typeof row.displayName === "string" ? row.displayName : undefined,
        id: typeof row.model === "string" ? row.model : "",
        isDefault: row.isDefault === true,
        defaultEffort:
          typeof row.defaultReasoningEffort === "string" ? row.defaultReasoningEffort : null,
        defaultServiceTier:
          typeof row.defaultServiceTier === "string" ? row.defaultServiceTier : null,
        efforts: Array.isArray(row.supportedReasoningEfforts)
          ? row.supportedReasoningEfforts
              .filter(isObject)
              .map((effort: Record<string, unknown>) => effort.reasoningEffort)
              .filter((effort: unknown): effort is string => typeof effort === "string")
          : [],
        serviceTiers: tiers.map(({ id }) => id),
        serviceTierOptions: tiers,
      };
    })
    .filter((model) => model.id.length > 0);
}
