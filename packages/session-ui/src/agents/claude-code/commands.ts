import {
  claudeCommandDecision,
  claudeMenuCommands,
  type ClaudeCommandEntry,
  type ClaudeCommandRefusal,
  type SessionCommandEntry,
} from "@agentkib/web-client";
import {
  commandLocale,
  localCommandCopy,
  type CommandContext,
  type CommandRegistration,
  type ParsedSessionCommand,
  type RegisteredCommandOption,
  type SlashCommandOption,
} from "../session-commands";

const copy = {
  "zh-CN": {
    label: "Claude Code 命令",
    empty: "Claude Code 在这条会话里运行过一次后，这里会列出可用的命令。",
  },
  "zh-Hant": {
    label: "Claude Code 指令",
    empty: "Claude Code 在這段對話中執行過一次後，這裡會列出可用的指令。",
  },
  "en-US": {
    label: "Claude Code commands",
    empty: "Commands are listed here once Claude Code has run in this session.",
  },
  "ja-JP": {
    label: "Claude Code のコマンド",
    empty: "この会話で Claude Code が一度動くと、使えるコマンドがここに表示されます。",
  },
};

export function claudeCommandCopy(locale: string) {
  return copy[commandLocale(locale)];
}

/**
 * Commands AgentKib handles itself, with the argument AgentKib takes. Without one they open
 * AgentKib's control for the same thing (`agentKibPanel`), so the argument is optional.
 */
const HANDLED: Record<"model" | "effort" | "rename" | "goal", string> = {
  model: "[model]",
  effort: "[low|medium|high|xhigh|max]",
  rename: "[name]",
  goal: "[objective]",
};
const handled = (name: string): name is keyof typeof HANDLED =>
  Object.prototype.hasOwnProperty.call(HANDLED, name);

/** Menu options, describing AgentKib's action for the commands it handles. */
export function claudeSlashOptions(
  commands: readonly SlashCommandOption[],
  locale: string,
): SlashCommandOption[] {
  const copy = localCommandCopy(locale);
  return commands.map((command) => {
    const name = command.name.toLowerCase();
    if (!handled(name)) return command;
    return { ...command, argumentHint: HANDLED[name], description: copy[name] };
  });
}

/** What AgentKib runs for a refused command, given its decision from runtime-protocol. */
export type AgentKibCommand =
  | { action: "settings"; fields: { model: string } | { effort: string } }
  | { action: "rename"; fields: { name: string } }
  | { action: "goal-set"; fields: { objective: string; intent: "start" } };

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * AgentKib's own action for `/model <name>`, `/effort <level>`, `/rename <name>` and
 * `/goal <objective>`. Without an argument these open AgentKib's control instead
 * (`agentKibPanel`); anything else only gets the refusal explained.
 */
export function agentKibCommand(decision: {
  command: string;
  args: string;
  refusal: string | null;
}): AgentKibCommand | null {
  const { command, args, refusal } = decision;
  if (!args) return null;
  if (refusal === "claude-command-settings" && command === "model")
    return { action: "settings", fields: { model: args } };
  if (refusal === "claude-command-settings" && command === "effort")
    return EFFORTS.includes(args.toLowerCase())
      ? { action: "settings", fields: { effort: args.toLowerCase() } }
      : null;
  if (refusal === "claude-command-rename") return { action: "rename", fields: { name: args } };
  if (refusal === "claude-command-goal")
    return { action: "goal-set", fields: { objective: args, intent: "start" } };
  return null;
}

/**
 * The explanation for `/effort` with a level next-turn settings do not take (`auto`,
 * `ultracode`, a typo), or null. Composers show it instead of the refusal, which reads as if
 * AgentKib kept no effort at all.
 */
export function unsupportedEffortReason(decision: {
  command: string;
  args: string;
  refusal: string | null;
}): "claude-effort-unsupported" | null {
  const { command, args, refusal } = decision;
  // `/effort` is refused only with an argument, so the level is never empty here.
  return refusal === "claude-command-settings" &&
    command === "effort" &&
    !EFFORTS.includes(args.toLowerCase())
    ? "claude-effort-unsupported"
    : null;
}

/**
 * Where AgentKib's own control for a command lives: next-turn settings for `/model` and
 * `/effort`, the persistent goal for `/goal`, the session actions, which hold rename, for
 * `/rename`, and, in Codex sessions, files and diffs for `/diff`.
 */
export type AgentKibPanel = "settings" | "goal" | "actions" | "files";

/** The control a command typed without an argument opens, or null when it opens none. */
export function agentKibPanel(decision: { command: string; args: string }): AgentKibPanel | null {
  if (decision.args) return null;
  if (decision.command === "model" || decision.command === "effort") return "settings";
  if (decision.command === "goal") return "goal";
  if (decision.command === "rename") return "actions";
  return null;
}

function recognizedEntry(entry: SessionCommandEntry) {
  return entry.run.kind === "native" || handled(entry.run.command);
}

function restrictedRefusal(reason?: ClaudeCommandRefusal | null) {
  return reason === "claude-command-owner-only" ||
    reason === "claude-command-clear" ||
    reason === "claude-command-background"
    ? reason
    : undefined;
}

function localControl(command: string) {
  return command === "model" || command === "effort" || command === "goal" ? command : undefined;
}

function reportedCommands({ menu, legacy, owner }: CommandContext) {
  const entries = new Map<string, SessionCommandEntry>();
  if (!menu) return { entries, commands: legacy ?? [] };
  if (menu.state !== "ready") return { entries, commands: [] };

  // The typed projection drops builtin metadata. Index the older report only for authorization.
  const builtins = new Set<string>();
  const legacyAliases = new Map<string, ClaudeCommandEntry[]>();
  for (const command of legacy ?? []) {
    if (typeof command?.name !== "string") continue;
    if (command.builtin === true) builtins.add(command.name.toLowerCase());
    for (const alias of Array.isArray(command.aliases) ? command.aliases : []) {
      if (typeof alias !== "string") continue;
      const name = alias.toLowerCase();
      const targets = legacyAliases.get(name);
      if (targets) targets.push(command);
      else legacyAliases.set(name, [command]);
    }
  }
  const blockedAlias = (name: string) => {
    const aliases = legacyAliases.get(name.toLowerCase());
    if (!aliases) return false;
    const targets = aliases.map((command) => ({
      ...command,
      builtin: builtins.has(command.name.toLowerCase()),
    }));
    return !!restrictedRefusal(
      claudeCommandDecision(`/${name}`, { owner: owner.local, commands: targets })?.refusal,
    );
  };
  const commands: ClaudeCommandEntry[] = [];
  for (const entry of menu.entries) {
    const name = entry.name.toLowerCase();
    if (entries.has(name) || !recognizedEntry(entry) || blockedAlias(name)) continue;
    entries.set(name, entry);
    commands.push({
      name: entry.name,
      description: entry.description,
      argumentHint: entry.argumentHint,
      aliases: entry.aliases?.filter((alias) => !blockedAlias(alias)),
      builtin: builtins.has(name),
    });
  }
  return { entries, commands };
}

function parseClaudeSessionCommand(
  text: string,
  context: CommandContext,
  { entries, commands }: ReturnType<typeof reportedCommands>,
): ParsedSessionCommand | null {
  const { owner, menu, legacy } = context;
  const decision = claudeCommandDecision(text, { owner: owner.local, commands });
  if (!decision) return null;
  const legacyDecision =
    menu && legacy?.length
      ? claudeCommandDecision(text, { owner: owner.local, commands: legacy })
      : undefined;
  // Known unsafe aliases and builtins remain refused even if the projected menu dropped metadata.
  const refusal = restrictedRefusal(decision.refusal) ?? restrictedRefusal(legacyDecision?.refusal);
  if (refusal) return { kind: "refused", command: decision.command, args: decision.args, refusal };

  const entry = entries.get(decision.command.toLowerCase());
  const key =
    entry?.run.kind === "client" && handled(entry.run.command) ? entry.run.command : undefined;
  const local = key
    ? claudeCommandDecision(`/${key} ${decision.args}`, { owner: owner.local, commands })
    : decision;
  if (!local) return null;
  const clientAllowed = menu?.state !== "ready" || key !== undefined;
  const { command, args } = local;
  const panel = clientAllowed ? agentKibPanel(local) : null;
  const action = clientAllowed ? agentKibCommand(local) : null;
  const refusalReason = unsupportedEffortReason(local) ?? undefined;
  const control = clientAllowed ? localControl(command) : undefined;

  if (panel || action || control)
    return {
      kind: "client",
      command,
      args,
      refusal: local.refusal,
      refusalReason,
      panel: panel ?? undefined,
      action: action ?? undefined,
      localControl: control,
      ...(action?.action === "goal-set" ? { invalidGoalReason: "claude-command-goal" } : {}),
    };
  if (local.refusal)
    return { kind: "refused", command, args, refusal: local.refusal, refusalReason };
  return { kind: "native", command, args };
}

export const claudeCommands: CommandRegistration = {
  source: "reported",
  connection: "terminal-bridge",
  emptyMenu: true,
  localArgumentHints: true,
  copy: claudeCommandCopy,
  configure(context) {
    const reported = reportedCommands(context);
    const { menu, locale, owner, canSend, canReadNativeCommands } = context;
    const options = canReadNativeCommands ? claudeMenuCommands(reported.commands, owner.local) : [];
    const copy = localCommandCopy(locale);
    return {
      options: options.flatMap<RegisteredCommandOption>((option) => {
        const name = option.name.toLowerCase();
        const run = reported.entries.get(name)?.run;
        const key = menu?.state === "ready" ? (run?.kind === "client" ? run.command : "") : name;
        if (!handled(key)) return [{ ...option, native: true }];
        if (!canSend && menu?.state !== "ready") return [];
        return [
          {
            ...option,
            argumentHint: HANDLED[key],
            description: copy[key],
            localControl: localControl(key),
          },
        ];
      }),
      parse: (text) => parseClaudeSessionCommand(text, context, reported),
    };
  },
};
