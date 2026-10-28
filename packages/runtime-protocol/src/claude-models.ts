/** A model Claude Code lists at initialize. */
export interface ClaudeListedModel {
  /** The name the CLI takes, such as `opus` or `default`. Next-turn settings keep this name. */
  value: string;
  /** The full model ID the name means now, when the CLI reports one. */
  resolvedModel?: string;
}

/**
 * The listed model a typed name means, as `/model` accepts it: an alias in any case, or the full
 * model ID an alias resolves to. A full ID prefers a named alias over `default`, which follows
 * Claude Code's recommendation rather than naming one model.
 *
 * The WebAccessService checks a request with it and the backend checks again against the list
 * its runner holds, so both accept the same names.
 */
export function claudeModelOption<T extends ClaudeListedModel>(
  models: readonly T[],
  name: string,
): T | undefined {
  const wanted = name.trim().toLowerCase();
  const resolves = (model: T) => model.resolvedModel?.toLowerCase() === wanted;
  return (
    models.find((model) => model.value === name) ??
    models.find((model) => model.value.toLowerCase() === wanted) ??
    models.find((model) => model.value !== "default" && resolves(model)) ??
    models.find(resolves)
  );
}
