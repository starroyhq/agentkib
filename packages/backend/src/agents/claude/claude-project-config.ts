// The per-project entry of Claude Code's global configuration file (`projects["<path>"]`).
//
// That file also records the path, history and trust state of every other project the user has
// ever opened, so nothing but the matching entry may leave this module. The result type below
// holds only the fields AgentKib shows, and the other entries are neither kept nor returned.
//
// Basis, https://code.claude.com/docs/en/mcp: the "local" scope is stored in `~/.claude.json`
// under the project's path, and `/mcp` records a disabled server there as well. Which path
// names the project is documented for trust only (permissions page: the git repository root, or
// the launch directory outside git); for the MCP entry it is not stated, so callers pass both
// the repository root and the workspace root and the first key that matches wins.

export interface ClaudeProjectEntry {
  /** The raw `mcpServers` object, when the entry has one. */
  mcpServers?: Record<string, unknown>;
  /** Names switched off for this project with `/mcp`. */
  disabledMcpServers: string[];
  /** `hasTrustDialogAccepted === true` for this exact folder; any other value is untrusted. */
  trusted: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Windows treats `\` and `/` alike and ignores case; elsewhere a path is compared exactly, since a
 * backslash is an ordinary file name character on POSIX. A trailing separator never counts.
 */
export function claudeProjectKeyForm(value: string, platform: NodeJS.Platform): string {
  let text = platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value;
  while (text.length > 1 && text.endsWith("/")) text = text.slice(0, -1);
  return text;
}

/** Whether there is a `projects` table to look in at all, so callers can skip finding the keys. */
export function hasClaudeProjects(root: unknown): boolean {
  return isObject(root) && isObject(root.projects);
}

/**
 * The entry of the first of `keys` that `root.projects` holds. `keys` come from real paths of the
 * current workspace, never from the file.
 */
export function readClaudeProjectEntry(
  root: unknown,
  keys: readonly string[],
  platform: NodeJS.Platform,
): ClaudeProjectEntry | undefined {
  const projects = isObject(root) ? root.projects : undefined;
  if (!isObject(projects)) return undefined;
  // The caller bounds the entire native configuration before parsing it. A second
  // display-count limit here must not silently discard this project's disable rules.
  const entries = Object.entries(projects);
  for (const key of keys) {
    const wanted = claudeProjectKeyForm(key, platform);
    for (const [candidate, value] of entries) {
      if (claudeProjectKeyForm(candidate, platform) !== wanted) continue;
      return isObject(value) ? pick(value) : undefined;
    }
  }
  return undefined;
}

function pick(entry: Record<string, unknown>): ClaudeProjectEntry {
  const disabled = entry.disabledMcpServers;
  return {
    trusted: entry.hasTrustDialogAccepted === true,
    ...(isObject(entry.mcpServers) ? { mcpServers: entry.mcpServers } : {}),
    // Callers already bound the configuration file before parsing it. Keep every valid name:
    // a display limit must not turn a disabled server into an apparently active one.
    disabledMcpServers: Array.isArray(disabled)
      ? disabled.filter((name): name is string => typeof name === "string")
      : [],
  };
}
