import { lstatSync } from "node:fs";
import path from "node:path";

/**
 * Where Claude Code keeps its files. Every Claude module takes its paths from here instead of
 * reading `CLAUDE_CONFIG_DIR` itself.
 *
 * Basis (https://code.claude.com/docs/en):
 * - env-vars: `CLAUDE_CONFIG_DIR` overrides the configuration directory (default `~/.claude`);
 *   a settings file must hold an absolute path, so `~` and `${VAR}` are not expanded here either.
 * - claude-directory: with the variable set, every `~/.claude` path on that page (`projects/`,
 *   `rules/`, `skills/`, `plugins/`, `CLAUDE.md`, `stats-cache.json`) lives under that directory.
 * - mcp-quickstart (user scope), devcontainer and agent-sdk/claude-code-features: Claude Code reads
 *   and writes `.claude.json` inside that directory instead of `~/.claude.json`.
 * - Not documented, read from the shipped 2.1.296 binary: a legacy `<dir>/.config.json` is
 *   preferred over `.claude.json`. `claudeGlobalConfigGate` therefore fails closed when it exists.
 *
 * Reads treat an unusable value as unset; writes must call `assertClaudeConfigWritable`.
 */
export type ClaudeConfigInvalidReason =
  | "not-absolute"
  | "traversal"
  | "filesystem-root"
  | "control-character"
  | "surrounding-whitespace"
  | "too-long"
  | "unsupported-prefix"
  | "drive-relative";

export interface ClaudeConfig {
  /** Absolute whenever `home` is absolute. The default `<home>/.claude` while the variable is unset or unusable. */
  dir: string;
  /** The variable holds a non-blank value, usable or not. */
  overridden: boolean;
  /** Set when the value cannot be used: reads fall back to the default, writes must refuse. */
  invalid?: ClaudeConfigInvalidReason;
}

export interface ClaudeConfigFiles {
  projects: string;
  history: string;
  statsCache: string;
  userInstructions: string;
  userRules: string;
  skills: string;
  /** `settings.json` of the user layer. */
  settings: string;
  /** Plugin records and installed plugins (`CLAUDE_CODE_PLUGIN_CACHE_DIR` can move them). */
  plugins: string;
  commands: string;
  agents: string;
  outputStyles: string;
  workflows: string;
}

export type ClaudeGlobalConfigGate =
  | { usable: true }
  | { usable: false; why: "invalid" | "legacy-file" };

const MAX_VALUE_LENGTH = 4096;

/** The variable's name, for messages that mention it (the only place that spells it out). */
export const CLAUDE_CONFIG_DIR_VARIABLE = "CLAUDE_CONFIG_DIR";

export class ClaudeConfigError extends Error {
  readonly reason: ClaudeConfigInvalidReason;
  constructor(reason: ClaudeConfigInvalidReason) {
    // Static text and the reason code only: never echo the configured value.
    super(
      `CLAUDE_CONFIG_DIR cannot be used (${reason}): set it to an absolute path without ".." that is not the filesystem root, or unset it`,
    );
    this.name = "ClaudeConfigError";
    this.reason = reason;
  }
}

const flavor = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Judges a non-blank value in a fixed order; the first rule that matches wins. The filesystem-root
 * test runs after normalisation so `//`, `/.` or `C:\.` cannot pass as something else. The check
 * is purely lexical: a `..` segment is refused outright rather than normalised away, because
 * lexical and symlink-aware resolution disagree about it.
 */
function classify(
  raw: string,
  platform: NodeJS.Platform,
): { dir: string } | { invalid: ClaudeConfigInvalidReason } {
  const p = flavor(platform);
  const windows = platform === "win32";
  if (hasControlCharacter(raw)) return { invalid: "control-character" };
  if (raw !== raw.trim()) return { invalid: "surrounding-whitespace" };
  if (raw.length > MAX_VALUE_LENGTH) return { invalid: "too-long" };
  if (windows) {
    // UNC, device and extended-length paths would make AgentKib touch a network host or device.
    if (/^[\\/]{2}/.test(raw)) return { invalid: "unsupported-prefix" };
    if (/^[\\/]/.test(raw) || /^[A-Za-z]:(?![\\/])/.test(raw)) return { invalid: "drive-relative" };
  }
  if (!p.isAbsolute(raw)) return { invalid: "not-absolute" };
  if (raw.split(windows ? /[\\/]+/ : /\/+/).includes("..")) return { invalid: "traversal" };
  let normalized = p.normalize(raw);
  const root = p.parse(normalized).root;
  if (normalized === root) return { invalid: "filesystem-root" };
  while (normalized.length > root.length && normalized.endsWith(p.sep))
    normalized = normalized.slice(0, -1);
  return { dir: normalized };
}

/** The raw variable. Callers that only need "was it set at all" keep Claude's own truthiness. */
export function claudeConfigDirVariable(env: NodeJS.ProcessEnv): string | undefined {
  return env.CLAUDE_CONFIG_DIR;
}

/** True for a non-blank value; blank values count as unset, like an empty `||` fallback. */
export function isClaudeConfigDirSet(env: NodeJS.ProcessEnv): boolean {
  return (env.CLAUDE_CONFIG_DIR ?? "").trim() !== "";
}

/**
 * `home` comes from the caller on purpose: the modules derive it in different ways, and unifying
 * that would change where an unset variable points.
 */
export function resolveClaudeConfig(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform = process.platform,
): ClaudeConfig {
  const fallback = flavor(platform).join(home, ".claude");
  if (!isClaudeConfigDirSet(env)) return { dir: fallback, overridden: false };
  const result = classify(env.CLAUDE_CONFIG_DIR!, platform);
  return "dir" in result
    ? { dir: result.dir, overridden: true }
    : { dir: fallback, overridden: true, invalid: result.invalid };
}

/** The single place that joins names onto the configuration directory. */
export function claudeConfigFiles(
  config: ClaudeConfig,
  platform: NodeJS.Platform = process.platform,
): ClaudeConfigFiles {
  const p = flavor(platform);
  return {
    projects: p.join(config.dir, "projects"),
    history: p.join(config.dir, "history.jsonl"),
    statsCache: p.join(config.dir, "stats-cache.json"),
    userInstructions: p.join(config.dir, "CLAUDE.md"),
    userRules: p.join(config.dir, "rules"),
    skills: p.join(config.dir, "skills"),
    settings: p.join(config.dir, "settings.json"),
    plugins: p.join(config.dir, "plugins"),
    commands: p.join(config.dir, "commands"),
    agents: p.join(config.dir, "agents"),
    outputStyles: p.join(config.dir, "output-styles"),
    workflows: p.join(config.dir, "workflows"),
  };
}

/** `<dir>/.claude.json` while the variable is usable, otherwise `<home>/.claude.json`. */
export function claudeGlobalConfigFile(
  config: ClaudeConfig,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const p = flavor(platform);
  return config.overridden && !config.invalid
    ? p.join(config.dir, ".claude.json")
    : p.join(home, ".claude.json");
}

/**
 * Whether the global config file can be trusted to be the one Claude Code uses. Closed when the
 * variable is unusable or a legacy `<dir>/.config.json` exists, whether or not the variable is
 * set. Anything but a clear "not there" answer counts as existing.
 */
export function claudeGlobalConfigGate(
  config: ClaudeConfig,
  lstat: (file: string) => unknown = lstatSync,
): ClaudeGlobalConfigGate {
  if (config.invalid) return { usable: false, why: "invalid" };
  try {
    lstat(path.join(config.dir, ".config.json"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { usable: true };
  }
  return { usable: false, why: "legacy-file" };
}

/** Every write into the Claude configuration directory calls this first. */
export function assertClaudeConfigWritable(config: ClaudeConfig): void {
  if (config.invalid) throw new ClaudeConfigError(config.invalid);
}

/** Where organization policy files live (memory and managed-mcp pages); null on other platforms. */
export function claudeManagedDir(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "linux") return "/etc/claude-code";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return null;
}
