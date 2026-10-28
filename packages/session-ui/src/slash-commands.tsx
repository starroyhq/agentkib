import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

/**
 * The `/` menu of a session composer. Composers pass the commands their device may use
 * (runtime-protocol's `claudeMenuCommands`, or its `CODEX_MENU_COMMANDS` through
 * `codexSlashOptions`); this module matches what was typed, handles the keyboard and renders the
 * list. The textarea keeps focus and points at the active option through `aria-activedescendant`.
 */
export interface SlashCommandOption {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases: string[];
}

const copies = {
  "zh-CN": {
    label: "Claude Code 命令",
    empty: "Claude Code 在这条会话里运行过一次后，这里会列出可用的命令。",
    model: "更改下一轮模型",
    effort: "更改下一轮思考强度",
    rename: "在 AgentKib 中重命名会话",
    goal: "设置持续目标",
    codexLabel: "Codex 命令",
    codexCompact: "压缩上下文",
    codexPlan: "下一轮使用计划模式",
    codexPermissions: "更改执行策略",
    codexStatus: "查看下一轮设置",
    codexFork: "分支会话",
    codexStop: "结束后台终端",
    codexArchive: "归档会话",
    codexDiff: "查看文件与差异",
  },
  "zh-TW": {
    label: "Claude Code 指令",
    empty: "Claude Code 在這段對話中執行過一次後，這裡會列出可用的指令。",
    model: "變更下一輪模型",
    effort: "變更下一輪思考強度",
    rename: "在 AgentKib 中重新命名對話",
    goal: "設定持續目標",
    codexLabel: "Codex 指令",
    codexCompact: "壓縮上下文",
    codexPlan: "下一輪使用計畫模式",
    codexPermissions: "變更執行策略",
    codexStatus: "查看下一輪設定",
    codexFork: "分支對話",
    codexStop: "結束背景終端機",
    codexArchive: "封存對話",
    codexDiff: "查看檔案與差異",
  },
  "en-US": {
    label: "Claude Code commands",
    empty: "Commands are listed here once Claude Code has run in this session.",
    model: "Change the next-turn model",
    effort: "Change the next-turn reasoning effort",
    rename: "Rename the session in AgentKib",
    goal: "Set a persistent goal",
    codexLabel: "Codex commands",
    codexCompact: "Compact the context",
    codexPlan: "Use Plan mode for the next turn",
    codexPermissions: "Change the execution policy",
    codexStatus: "Show next-turn settings",
    codexFork: "Fork the session",
    codexStop: "Stop background terminals",
    codexArchive: "Archive the session",
    codexDiff: "Show files and diffs",
  },
  "ja-JP": {
    label: "Claude Code のコマンド",
    empty: "この会話で Claude Code が一度動くと、使えるコマンドがここに表示されます。",
    model: "次のターンのモデルを変更",
    effort: "次のターンの推論の強度を変更",
    rename: "AgentKib で会話の名前を変更",
    goal: "継続目標を設定",
    codexLabel: "Codex のコマンド",
    codexCompact: "コンテキストを圧縮",
    codexPlan: "次のターンを計画モードにする",
    codexPermissions: "実行ポリシーを変更",
    codexStatus: "次のターンの設定を表示",
    codexFork: "会話を分岐",
    codexStop: "バックグラウンドのターミナルを終了",
    codexArchive: "会話をアーカイブ",
    codexDiff: "ファイルと差分を表示",
  },
};

export function slashCommandCopy(locale: string) {
  return copies[
    locale === "zh-TW"
      ? "zh-TW"
      : locale.startsWith("zh")
        ? "zh-CN"
        : locale.startsWith("ja")
          ? "ja-JP"
          : "en-US"
  ];
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
  const copy = slashCommandCopy(locale);
  return commands.map((command) => {
    const name = command.name.toLowerCase();
    if (!handled(name)) return command;
    return { ...command, argumentHint: HANDLED[name], description: copy[name] };
  });
}

/** What each Codex menu command does in AgentKib, with the argument it takes. */
const CODEX_OPTIONS: Record<
  string,
  { key: keyof ReturnType<typeof slashCommandCopy>; hint?: string }
> = {
  compact: { key: "codexCompact" },
  plan: { key: "codexPlan", hint: "[message]" },
  model: { key: "model", hint: "[model]" },
  permissions: { key: "codexPermissions" },
  status: { key: "codexStatus" },
  rename: { key: "rename", hint: "[name]" },
  goal: { key: "goal", hint: "[objective]" },
  fork: { key: "codexFork" },
  stop: { key: "codexStop" },
  archive: { key: "codexArchive" },
  diff: { key: "codexDiff" },
};

/**
 * Menu options for a Codex session from runtime-protocol's `CODEX_MENU_COMMANDS`: each runs or
 * opens AgentKib's own control, so it is described in AgentKib's terms.
 */
export function codexSlashOptions(names: readonly string[], locale: string): SlashCommandOption[] {
  const copy = slashCommandCopy(locale);
  return names.flatMap((name) => {
    const option = CODEX_OPTIONS[name];
    return option
      ? [
          {
            name,
            description: copy[option.key],
            ...(option.hint ? { argumentHint: option.hint } : {}),
            aliases: [],
          },
        ]
      : [];
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

/** The name typed so far while the draft is only `/` and a name, else null. */
export function slashCommandQuery(draft: string): string | null {
  const match = /^\/([A-Za-z0-9_:.-]*)$/.exec(draft);
  return match ? match[1]!.toLowerCase() : null;
}

/** Names that start with the query, then aliases that do, then names that contain it. */
export function matchSlashCommands(
  options: readonly SlashCommandOption[],
  query: string,
): SlashCommandOption[] {
  if (!query) return [...options];
  const starts = (value: string) => value.toLowerCase().startsWith(query);
  const byName = options.filter((option) => starts(option.name));
  const byAlias = options.filter((option) => !starts(option.name) && option.aliases.some(starts));
  const inside = options.filter(
    (option) =>
      !starts(option.name) &&
      !option.aliases.some(starts) &&
      option.name.toLowerCase().includes(query),
  );
  return [...byName, ...byAlias, ...inside];
}

export function useSlashCommandMenu({
  value,
  options,
  enabled,
  catalogKnown,
  locale,
  label,
  onChoose,
}: {
  value: string;
  options: readonly SlashCommandOption[];
  /** False while the composer cannot send, and for agents without slash commands. */
  enabled: boolean;
  /** Whether the session has reported a catalog. Before that the menu says why it is empty. */
  catalogKnown: boolean;
  locale: string;
  /** The list's accessible name; Claude Code's commands by default. */
  label?: string;
  /** Receives the draft with the chosen command, followed by a space. */
  onChoose: (text: string) => void;
}) {
  const id = useId();
  const listboxId = `${id}commands`;
  const copy = slashCommandCopy(locale);
  const list = useRef<HTMLUListElement>(null);
  // Escape closes the menu for this exact draft; typing reopens it.
  const [dismissed, setDismissed] = useState<string>();
  const [cursor, setCursor] = useState({ query: "", index: 0 });
  const query = enabled ? slashCommandQuery(value) : null;
  const matches = useMemo(
    () => (query === null ? [] : matchSlashCommands(options, query)),
    [options, query],
  );
  const open = query !== null && dismissed !== value && (matches.length > 0 || !catalogKnown);
  const listOpen = open && matches.length > 0;
  const index = cursor.query === query ? Math.min(cursor.index, matches.length - 1) : 0;
  useEffect(() => {
    if (!listOpen) return;
    const element = list.current?.children[index] as HTMLElement | undefined;
    element?.scrollIntoView?.({ block: "nearest" });
  }, [listOpen, index]);
  const choose = (option: SlashCommandOption) => onChoose(`/${option.name} `);
  /** Handles the key when the menu uses it; returns whether it did. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean => {
    if (!open || composing || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(value);
      return true;
    }
    if (!listOpen || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setCursor({ query: query ?? "", index: (index + step + matches.length) % matches.length });
      return true;
    }
    if (event.key !== "Enter" && event.key !== "Tab") return false;
    const option = matches[index]!;
    // Enter on a complete name sends it; Tab and Enter otherwise complete the name.
    if (event.key === "Enter" && value.toLowerCase() === `/${option.name.toLowerCase()}`)
      return false;
    event.preventDefault();
    choose(option);
    return true;
  };
  const menu = open ? (
    <div className="absolute inset-x-0 bottom-full z-30 mb-2 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
      {listOpen ? (
        <ul
          ref={list}
          id={listboxId}
          role="listbox"
          aria-label={label ?? copy.label}
          className="max-h-64 overflow-y-auto"
        >
          {matches.map((option, position) => (
            <li
              key={option.name}
              id={`${listboxId}-${position}`}
              role="option"
              aria-selected={position === index}
              className={`cursor-default rounded-md px-2 py-1.5 ${
                position === index ? "bg-accent text-accent-foreground" : ""
              }`}
              // Keep focus in the textarea, which owns the keyboard.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => {
                if (position !== index) setCursor({ query: query ?? "", index: position });
              }}
              onClick={() => choose(option)}
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 font-mono text-sm">/{option.name}</span>
                {option.argumentHint && (
                  <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                    {option.argumentHint}
                  </span>
                )}
              </span>
              {option.description && (
                <span className="block truncate text-xs leading-5 text-muted-foreground">
                  {option.description}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p role="status" className="px-2 py-1.5 text-xs leading-5 text-muted-foreground">
          {copy.empty}
        </p>
      )}
    </div>
  ) : null;
  return {
    open,
    onKeyDown,
    /** Spread on the textarea. */
    inputProps: {
      "aria-autocomplete": "list" as const,
      "aria-controls": listOpen ? listboxId : undefined,
      "aria-activedescendant": listOpen ? `${listboxId}-${index}` : undefined,
    },
    menu,
  };
}
