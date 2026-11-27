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

/** Display-only name for a Claude Code ID when the CLI doesn't provide a label. */
export function claudeModelDisplayName(modelId: string): string | undefined {
  // Short aliases are the CLI's shortcuts. Versioned IDs can introduce new families.
  if (/^(?:opus|sonnet|haiku)$/.test(modelId))
    return modelId.replace(/^./, (first) => first.toUpperCase());

  // Older IDs put the version before the family.
  const base = modelId.replace(/\[\d+[km]\]$/i, "");
  const normalized = base.replace(/^claude-(\d+(?:-\d+)?)-([a-z]+)(?=-|$)/, "claude-$2-$1");
  // Prefer a trailing date over an eight-digit minor version.
  const version = /^claude-([a-z]+)-(\d+)(?:-(?:\d{8}|latest)|-(\d+)(?:-(?:\d{8}|latest))?)?$/.exec(
    normalized,
  );
  if (!version) return undefined;
  const [, family, major, minor] = version;
  const name = family.replace(/^./, (first) => first.toUpperCase());
  return `${name} ${minor ? `${major}.${minor}` : major}`;
}
