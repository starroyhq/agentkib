/**
 * Slash commands in a managed Codex session.
 *
 * Codex's terminal UI runs `/name` itself (`SlashCommand` in codex-rs/tui, 0.163.0). The
 * app-server AgentKib drives has no slash commands: its input is text, images, skills and
 * mentions, so a message starting with `/compact` would only reach the model as text. AgentKib
 * decides what such a message does instead:
 *
 * - For a command AgentKib has its own action for, the composer runs that action (`/compact`,
 *   `/fork`, `/stop`, `/plan`, `/model <model>`, `/rename <name>`, `/goal <objective>`) or, without an
 *   argument, opens the control for it (`/model`, `/permissions`, `/status`, `/rename`, `/goal`,
 *   `/archive`, `/diff`).
 * - `/review [branch]` and `/init` send a message AgentKib writes, as an ordinary turn. Codex
 *   Desktop (26.1023) does the same: `review/start` reports one turn id in `turn/started` and
 *   another for its items and `turn/completed` (0.163.0), and init has no method at all.
 * - The other commands only work in the terminal UI. They are not sent, and the composer says why.
 * - Any other `/name` is sent as text, like every message.
 *
 * Unlike Claude Code's commands, nothing here limits what the host accepts: text such as `/quit`
 * does no harm in a turn. These rules only spare the user a turn that does not do what they meant.
 */

/** Why a command is not sent; clients explain each one. */
export const CODEX_COMMAND_REFUSALS = [
  /** AgentKib's own action or control stands in for it, but is not available right now. */
  "codex-command-agentkib",
  /** AgentKib's action for it takes no argument. */
  "codex-command-arguments",
  "codex-command-new",
  /** `/review` takes one branch, tag or commit, or nothing. */
  "codex-command-review",
  /** It works only in Codex's terminal UI. */
  "codex-command-terminal",
] as const;
export type CodexCommandRefusal = (typeof CODEX_COMMAND_REFUSALS)[number];

export function isCodexCommandRefusal(value: unknown): value is CodexCommandRefusal {
  return (CODEX_COMMAND_REFUSALS as readonly unknown[]).includes(value);
}

/** The AgentKib control a command opens. */
export type CodexCommandPanel = "settings" | "goal" | "actions" | "files";

/**
 * A message AgentKib writes for a command; composers word it in the reader's language. `base` is
 * what `/review` compares with, or null for the uncommitted changes.
 */
export type CodexCommandPrompt = { kind: "review"; base: string | null } | { kind: "init" };

/** The session action a command runs, with its fields. */
export type CodexCommandAction =
  /** Sent as an ordinary message, in place of the command. */
  | { action: "send"; prompt: CodexCommandPrompt }
  | { action: "compact" }
  | { action: "fork" }
  | { action: "terminals-clean" }
  | { action: "rename"; fields: { name: string } }
  | { action: "goal-set"; fields: { objective: string; intent: "start" } }
  /** `draft` is what the composer keeps once the setting is saved. */
  | { action: "settings"; fields: { mode: "plan" } | { model: string }; draft?: string };

export interface CodexCommandDecision {
  /** The command, aliases resolved, lowercased and without the slash. */
  command: string;
  /** Everything after the name, trimmed. */
  args: string;
  /** Shown when the composer neither runs `action` nor opens `panel`. */
  refusal: CodexCommandRefusal;
  action?: CodexCommandAction;
  panel?: CodexCommandPanel;
}

// As in Claude Code: `/name` is a command only when whitespace or the end follows the name, so a
// path such as `/private/tmp` stays text.
const COMMAND = /^\/([A-Za-z0-9_][A-Za-z0-9_:.-]{0,127})(?=\s|$)([\s\S]*)$/;

// One revision such as `main`, `origin/main`, `v1.2` or `HEAD~3`. The message asks Codex to run
// `git merge-base HEAD <base>`, so nothing a shell reads specially, and no leading `-`.
const REVIEW_BASE = /^(?![-./])[\p{L}\p{N}._/@{}~^+-]{1,200}$/u;

/** `SlashCommand` of Codex 0.163.0, by the names its terminal UI accepts. */
const TERMINAL_COMMANDS = new Set([
  "model",
  "daybreak",
  "ide",
  "permissions",
  "keymap",
  "vim",
  "setup-default-sandbox",
  "experimental",
  "approve",
  "memories",
  "skills",
  "import",
  "hooks",
  "review",
  "rename",
  "new",
  "archive",
  "delete",
  "resume",
  "fork",
  "worktree",
  "app",
  "init",
  "compact",
  "config",
  "recap",
  "plan",
  "voice",
  "goal",
  "agents",
  "side",
  "btw",
  "copy",
  "export",
  "raw",
  "tui",
  "diff",
  "mention",
  "status",
  "daemon",
  "warnings",
  "cd",
  "pwd",
  "usage",
  "debug-config",
  "title",
  "statusline",
  "theme",
  "pets",
  "mcp",
  "apps",
  "plugins",
  "logout",
  "quit",
  "exit",
  "feedback",
  "rollout",
  "ps",
  "stop",
  "clear",
  "test-approval",
  "subagents",
  "debug-m-drop",
  "debug-m-update",
]);
const ALIASES = new Map([
  ["cwd", "pwd"],
  ["pet", "pets"],
  ["clean", "stop"],
]);

/** What AgentKib does with a message in a Codex session, or null when it is sent as text. */
export function codexCommandDecision(text: string): CodexCommandDecision | null {
  const match = COMMAND.exec(text.trimStart());
  if (!match) return null;
  const typed = match[1]!.toLowerCase();
  const command = ALIASES.get(typed) ?? typed;
  if (!TERMINAL_COMMANDS.has(command)) return null;
  const args = match[2]!.trim();
  const own = { command, args, refusal: "codex-command-agentkib" } as const;
  const bare = (outcome: Pick<CodexCommandDecision, "action" | "panel">): CodexCommandDecision =>
    args ? { command, args, refusal: "codex-command-arguments" } : { ...own, ...outcome };
  switch (command) {
    case "compact":
      return bare({ action: { action: "compact" } });
    case "fork":
      return bare({ action: { action: "fork" } });
    case "stop":
      // Ends the commands still running in the background, as in the terminal.
      return bare({ action: { action: "terminals-clean" } });
    case "permissions":
    case "status":
      return bare({ panel: "settings" });
    case "archive":
      return bare({ panel: "actions" });
    case "diff":
      return bare({ panel: "files" });
    case "plan":
      // Like the terminal's `/plan <prompt>`: switch, then the prompt waits in the composer.
      return {
        ...own,
        action: { action: "settings", fields: { mode: "plan" }, ...(args ? { draft: args } : {}) },
      };
    case "model":
      return args
        ? { ...own, action: { action: "settings", fields: { model: args } } }
        : { ...own, panel: "settings" };
    case "rename":
      return args
        ? { ...own, action: { action: "rename", fields: { name: args } } }
        : { ...own, panel: "actions" };
    case "goal":
      return args
        ? { ...own, action: { action: "goal-set", fields: { objective: args, intent: "start" } } }
        : { ...own, panel: "goal" };
    case "new":
    case "clear":
      return { command, args, refusal: "codex-command-new" };
    case "review":
      if (args && !REVIEW_BASE.test(args))
        return { command, args, refusal: "codex-command-review" };
      return {
        ...own,
        action: { action: "send", prompt: { kind: "review", base: args || null } },
      };
    case "init":
      return bare({ action: { action: "send", prompt: { kind: "init" } } });
    default:
      return { command, args, refusal: "codex-command-terminal" };
  }
}

/** The commands a Codex `/` menu offers: those AgentKib runs or opens a control for. */
export const CODEX_MENU_COMMANDS = [
  "compact",
  "review",
  "plan",
  "model",
  "permissions",
  "status",
  "rename",
  "goal",
  "fork",
  "stop",
  "archive",
  "diff",
  "init",
] as const;
export type CodexMenuCommand = (typeof CODEX_MENU_COMMANDS)[number];
