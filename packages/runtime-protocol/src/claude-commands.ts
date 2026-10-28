/**
 * Slash commands in a managed Claude Code session.
 *
 * Claude Code runs a message that starts with `/name` as a command. Its own commands act on the
 * CLI, on its settings or on this computer; skills, custom and plugin commands expand into a
 * prompt for the model. AgentKib sends most of them on, as the terminal would, with two limits:
 *
 * - Commands AgentKib cannot follow are refused for every device. `/clear` moves the CLI to a
 *   new native session, `/loop` and `/batch` start background work, and `/goal`, `/rename` and
 *   `/model` or `/effort` with an argument change what AgentKib keeps itself. Clients run
 *   AgentKib's own action for most of them instead.
 * - A remote device may run only the built-in commands listed here. The others can change
 *   Claude Code settings or files on this computer with no approval prompt, for example
 *   `/config permissionMode=auto` makes every later session start in auto mode.
 *
 * The backend checks a message when it accepts it and again just before writing it to the CLI,
 * against the catalog the CLI reported then. Clients use the same rules for the `/` menu.
 */

/** One entry of the catalog the CLI reports at initialize (`commands`). */
export interface ClaudeCommandEntry {
  name: string;
  description?: string;
  argumentHint?: string;
  /** Set by the CLI on its own commands. Skills, custom and plugin commands leave it out. */
  builtin?: boolean;
  aliases?: string[];
}

/** Why AgentKib did not send a message; clients explain each one. */
export const CLAUDE_COMMAND_REFUSALS = [
  "claude-command-clear",
  "claude-command-background",
  "claude-command-goal",
  "claude-command-rename",
  "claude-command-settings",
  "claude-command-owner-only",
] as const;
export type ClaudeCommandRefusal = (typeof CLAUDE_COMMAND_REFUSALS)[number];

export function isClaudeCommandRefusal(value: unknown): value is ClaudeCommandRefusal {
  return (CLAUDE_COMMAND_REFUSALS as readonly unknown[]).includes(value);
}

export interface ClaudeSlashCommand {
  /** The name as typed, lowercased and without the slash. It may be an alias. */
  name: string;
  /** Everything after the name, trimmed. */
  args: string;
}

export interface ClaudeCommandAccess {
  /** The device acts for the person at this computer (the desktop app), not a paired browser. */
  owner: boolean;
  /** The catalog the CLI reported. Empty or absent before any worker has reported one. */
  commands?: readonly ClaudeCommandEntry[] | null;
}

export interface ClaudeCommandDecision extends ClaudeSlashCommand {
  /** The command the name runs, with aliases resolved. */
  command: string;
  refusal: ClaudeCommandRefusal | null;
}

/** A command the `/` menu offers. */
export interface ClaudeMenuCommand {
  name: string;
  description?: string;
  /** Left out where the command may only run without an argument. */
  argumentHint?: string;
  aliases: string[];
}

// The CLI treats `/name` as a command only when whitespace or the end follows the name, so a
// path such as `/private/tmp` stays text for the model.
const COMMAND = /^\/([A-Za-z0-9_][A-Za-z0-9_:.-]{0,127})(?=\s|$)([\s\S]*)$/;

/**
 * Built-in commands of Claude Code 2.1.311, the verified version. The catalog marks them
 * `builtin`; this list covers the time before a worker has reported a catalog.
 */
const BUILTIN = new Set([
  "agents",
  "auto-mode-setup",
  "autocompact",
  "batch",
  "claude-api",
  "clear",
  "code-review",
  "color",
  "compact",
  "config",
  "context",
  "dataviz",
  "debug",
  "deep-research",
  "doctor",
  "effort",
  "fast",
  "fewer-permission-prompts",
  "focus",
  "goal",
  "heapdump",
  "init",
  "insights",
  "list-agents",
  "loop",
  "mcp",
  "model",
  "output-style",
  "plugin-authoring",
  "recap",
  "reload-plugins",
  "reload-skills",
  "rename",
  "run",
  "run-skill-generator",
  "security-review",
  "simplify",
  "team-onboarding",
  "update-config",
  "usage",
  "verify",
  "workflow-authoring",
  "workflow-launch-exec",
  "__remote-workflow",
]);

/** Aliases of 2.1.311; the catalog's `aliases` add any a newer CLI reports. */
const ALIASES = new Map([
  ["checkup", "doctor"],
  ["cost", "usage"],
  ["name", "rename"],
  ["new", "clear"],
  ["peers", "list-agents"],
  ["proactive", "loop"],
  ["reset", "clear"],
  ["review", "code-review"],
  ["settings", "config"],
  ["stats", "usage"],
]);

/**
 * Built-in commands a remote device may run. They report on the session, or expand into a
 * prompt whose tool calls go through the usual approvals.
 */
const REMOTE = new Set([
  "agents",
  "claude-api",
  "code-review",
  "color",
  "compact",
  "context",
  "dataviz",
  "deep-research",
  "fast",
  "focus",
  "init",
  "recap",
  "reload-skills",
  "run",
  "security-review",
  "simplify",
  "usage",
  "verify",
]);

/** Without an argument these only report; with one they change settings on this computer. */
const REMOTE_WITHOUT_ARGUMENTS = new Set(["autocompact", "effort", "mcp", "model", "output-style"]);

/** Commands that only serve the CLI's own server-launched sessions. */
const INTERNAL = new Set(["workflow-launch-exec"]);

export function parseClaudeSlashCommand(text: string): ClaudeSlashCommand | null {
  const match = COMMAND.exec(text.trimStart());
  return match ? { name: match[1]!.toLowerCase(), args: match[2]!.trim() } : null;
}

const entryName = (entry: ClaudeCommandEntry): string | null =>
  typeof entry?.name === "string" ? entry.name.toLowerCase() : null;

// Every command a typed name might run: an alias target, then the name itself. When a skill
// shares a name with an alias, which one the CLI picks is not verified, so both are checked.
function candidates(name: string, commands: readonly ClaudeCommandEntry[]): string[] {
  const names = new Set<string>();
  const alias = ALIASES.get(name);
  if (alias) names.add(alias);
  for (const entry of commands) {
    const target = entryName(entry);
    if (
      target &&
      Array.isArray(entry.aliases) &&
      entry.aliases.some((alias) => typeof alias === "string" && alias.toLowerCase() === name)
    )
      names.add(target);
  }
  names.add(name);
  return [...names];
}

function refusal(
  name: string,
  args: string,
  owner: boolean,
  commands: readonly ClaudeCommandEntry[],
): ClaudeCommandRefusal | null {
  if (name === "clear") return "claude-command-clear";
  if (name === "loop" || name === "batch") return "claude-command-background";
  if (name === "goal") return "claude-command-goal";
  if (name === "rename") return "claude-command-rename";
  if ((name === "model" || name === "effort") && args) return "claude-command-settings";
  if (owner || REMOTE.has(name)) return null;
  if (REMOTE_WITHOUT_ARGUMENTS.has(name)) return args ? "claude-command-owner-only" : null;
  const builtin =
    BUILTIN.has(name) ||
    commands.some((entry) => entry?.builtin === true && entryName(entry) === name);
  return builtin ? "claude-command-owner-only" : null;
}

/** What AgentKib does with a message, or null when the message is not a command. */
export function claudeCommandDecision(
  text: string,
  access: ClaudeCommandAccess,
): ClaudeCommandDecision | null {
  const parsed = parseClaudeSlashCommand(text);
  if (!parsed) return null;
  const commands = access.commands ?? [];
  const names = candidates(parsed.name, commands);
  for (const name of names) {
    const found = refusal(name, parsed.args, access.owner, commands);
    if (found) return { ...parsed, command: name, refusal: found };
  }
  return { ...parsed, command: names[0]!, refusal: null };
}

/** Why AgentKib does not send this text to Claude Code, or null when it does. */
export function claudeCommandRefusal(
  text: string,
  access: ClaudeCommandAccess,
): ClaudeCommandRefusal | null {
  return claudeCommandDecision(text, access)?.refusal ?? null;
}

/**
 * The first refusal among the text of a message: a string, or content blocks, each text block
 * checked. Which block the CLI reads a command from is not verified.
 */
export function claudeInputCommandRefusal(
  input: unknown,
  access: ClaudeCommandAccess,
): ClaudeCommandRefusal | null {
  const texts =
    typeof input === "string"
      ? [input]
      : Array.isArray(input)
        ? input.flatMap((block: unknown) =>
            block !== null &&
            typeof block === "object" &&
            (block as { type?: unknown }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string"
              ? [(block as { text: string }).text]
              : [],
          )
        : [];
  for (const text of texts) {
    const found = claudeCommandRefusal(text, access);
    if (found) return found;
  }
  return null;
}

/**
 * The commands a `/` menu offers, in catalog order. Background commands, `/clear` (AgentKib
 * starts a new session instead) and internal ones are left out for everyone; a remote device
 * also loses the built-ins it may not run, and the argument hint of those it may only run
 * without an argument. `/goal`, `/rename`, `/model` and `/effort` stay: clients run or open
 * AgentKib's own control for them.
 */
export function claudeMenuCommands(
  commands: readonly ClaudeCommandEntry[],
  owner: boolean,
): ClaudeMenuCommand[] {
  const seen = new Set<string>();
  const menu: ClaudeMenuCommand[] = [];
  for (const entry of commands) {
    const name = entryName(entry);
    if (!name || seen.has(name) || name.startsWith("_") || INTERNAL.has(name)) continue;
    seen.add(name);
    // Offered exactly when typing it bare would not be refused for this reason.
    const bare = claudeCommandDecision(`/${name}`, { owner, commands });
    if (
      !bare ||
      bare.refusal === "claude-command-background" ||
      bare.refusal === "claude-command-clear" ||
      bare.refusal === "claude-command-owner-only"
    )
      continue;
    const argumentsAllowed =
      owner || !REMOTE_WITHOUT_ARGUMENTS.has(name) || name === "model" || name === "effort";
    menu.push({
      name: entry.name,
      ...(typeof entry.description === "string" && entry.description
        ? { description: entry.description }
        : {}),
      ...(argumentsAllowed && typeof entry.argumentHint === "string" && entry.argumentHint
        ? { argumentHint: entry.argumentHint }
        : {}),
      aliases: Array.isArray(entry.aliases)
        ? entry.aliases.filter((alias): alias is string => typeof alias === "string")
        : [],
    });
  }
  return menu;
}
