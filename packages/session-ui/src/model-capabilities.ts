type ModelOptions = {
  efforts?: readonly string[];
  serviceTierIds?: readonly string[];
  variants?: readonly { effort?: string; serviceTierId?: string }[];
};

/** Reasoning stops for the requested tier, in the provider's reported order. */
export function modelEffortsForTier(
  model: ModelOptions | undefined,
  tier?: string | null,
): readonly string[] {
  const efforts = model?.efforts ?? [];
  const variants = model?.variants;
  return variants?.length
    ? efforts.filter((effort) => modelSupportsTier(model, tier, effort))
    : efforts;
}

/** A provider with variants must resolve to exactly one native model for this pair. */
export function modelSupportsTier(
  model: ModelOptions | undefined,
  tier?: string | null,
  effort?: string,
): boolean {
  if (!model) return false;
  const variants = model.variants;
  if (!variants?.length) return !tier || model.serviceTierIds?.includes(tier) === true;
  return (
    variants.filter(
      (variant) =>
        variant.serviceTierId === (tier || undefined) && (!effort || variant.effort === effort),
    ).length === 1
  );
}
