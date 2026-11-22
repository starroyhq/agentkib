import {
  CODEX_MENU_COMMANDS,
  codexCommandDecision,
  parseClaudeSlashCommand,
  type CodexCommandDecision,
  type SessionCommandEntry,
} from "@agentkib/web-client";
import {
  commandLocale,
  findCommandEntry,
  localCommandCopy,
  type CommandRegistration,
  type ParsedSessionCommand,
  type RegisteredCommandOption,
  type SlashCommandOption,
} from "../session-commands";

const copy = {
  "zh-CN": {
    codexLabel: "Codex 命令",
    codexCompact: "压缩上下文",
    codexReview: "审查未提交的改动，或对比某个分支",
    codexInit: "为这个目录写一份 AGENTS.md",
    codexPlan: "下一轮使用计划模式",
    codexPermissions: "更改执行策略",
    codexStatus: "查看下一轮设置",
    codexFork: "分支会话",
    codexStop: "结束后台终端",
    codexArchive: "归档会话",
    codexDiff: "查看文件与差异",
  },
  "zh-Hant": {
    codexLabel: "Codex 指令",
    codexCompact: "壓縮上下文",
    codexReview: "審查尚未提交的變更，或與某個分支比較",
    codexInit: "為這個目錄寫一份 AGENTS.md",
    codexPlan: "下一輪使用計畫模式",
    codexPermissions: "變更執行策略",
    codexStatus: "查看下一輪設定",
    codexFork: "分支對話",
    codexStop: "結束背景終端機",
    codexArchive: "封存對話",
    codexDiff: "查看檔案與差異",
  },
  "en-US": {
    codexLabel: "Codex commands",
    codexCompact: "Compact the context",
    codexReview: "Review uncommitted changes, or against a branch",
    codexInit: "Write an AGENTS.md for this directory",
    codexPlan: "Use Plan mode for the next turn",
    codexPermissions: "Change the execution policy",
    codexStatus: "Show next-turn settings",
    codexFork: "Fork the session",
    codexStop: "Stop background terminals",
    codexArchive: "Archive the session",
    codexDiff: "Show files and diffs",
  },
  "ja-JP": {
    codexLabel: "Codex のコマンド",
    codexCompact: "コンテキストを圧縮",
    codexReview: "未コミットの変更、またはブランチとの差分をレビュー",
    codexInit: "このディレクトリの AGENTS.md を作成",
    codexPlan: "次のターンを計画モードにする",
    codexPermissions: "実行ポリシーを変更",
    codexStatus: "次のターンの設定を表示",
    codexFork: "会話を分岐",
    codexStop: "バックグラウンドのターミナルを終了",
    codexArchive: "会話をアーカイブ",
    codexDiff: "ファイルと差分を表示",
  },
};

export function codexCommandCopy(locale: string) {
  return copy[commandLocale(locale)];
}

/** What each Codex menu command does in AgentKib, with the argument it takes. */
const CODEX_OPTIONS: Record<
  string,
  {
    key: keyof (typeof copy)["en-US"] | "model" | "rename" | "goal";
    hint?: string;
    localControl?: RegisteredCommandOption["localControl"];
    action?: RegisteredCommandOption["action"];
  }
> = {
  compact: { key: "codexCompact", action: "compact" },
  review: { key: "codexReview", hint: "[branch]", action: "send" },
  plan: { key: "codexPlan", hint: "[message]", action: "settings" },
  model: { key: "model", hint: "[model]", localControl: "model" },
  permissions: { key: "codexPermissions" },
  status: { key: "codexStatus" },
  rename: { key: "rename", hint: "[name]" },
  goal: { key: "goal", hint: "[objective]", localControl: "goal" },
  fork: { key: "codexFork", action: "fork" },
  stop: { key: "codexStop", action: "terminals-clean" },
  archive: { key: "codexArchive" },
  diff: { key: "codexDiff" },
  init: { key: "codexInit", action: "send" },
};

/**
 * Menu options for a Codex session from runtime-protocol's `CODEX_MENU_COMMANDS`: each runs or
 * opens AgentKib's own control, so it is described in AgentKib's terms.
 */
export function codexSlashOptions(names: readonly string[], locale: string): SlashCommandOption[] {
  const copy = { ...localCommandCopy(locale), ...codexCommandCopy(locale) };
  return names.flatMap((name) => {
    const option = Object.hasOwn(CODEX_OPTIONS, name) ? CODEX_OPTIONS[name] : undefined;
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

function registeredOption(option: SlashCommandOption, key: string): RegisteredCommandOption {
  const { localControl, action } = CODEX_OPTIONS[key]!;
  return { ...option, localControl, action };
}

function codexOption(entry: SessionCommandEntry, locale: string): RegisteredCommandOption[] {
  if (entry.run.kind !== "client") return [];
  const key = entry.run.command;
  return codexSlashOptions([key], locale).map((option) =>
    registeredOption({ ...option, name: entry.name, aliases: [...(entry.aliases ?? [])] }, key),
  );
}

function parsedCommand(decision: CodexCommandDecision | null): ParsedSessionCommand | null {
  if (!decision) return null;
  const { command, args, refusal, panel, action } = decision;
  if (!panel && !action) return { kind: "refused", command, args, refusal };
  return {
    kind: "client",
    command,
    args,
    refusal,
    panel,
    action,
    ...(action?.action === "goal-set" ? { invalidGoalReason: "claude-command-goal" } : {}),
  };
}

export const codexCommands: CommandRegistration = {
  source: "built-in",
  connection: "native-app",
  emptyMenu: true,
  copy: (locale) => ({ label: codexCommandCopy(locale).codexLabel }),
  configure({ menu, locale }) {
    const entries = menu?.state === "ready" ? menu.entries : [];
    const options = menu
      ? entries.flatMap((entry) => codexOption(entry, locale))
      : codexSlashOptions(CODEX_MENU_COMMANDS, locale).map((option) =>
          registeredOption(option, option.name),
        );
    return {
      options,
      parse(text) {
        const legacy = codexCommandDecision(text);
        if (!menu) return parsedCommand(legacy);
        const typed = parseClaudeSlashCommand(text);
        if (!typed) return null;
        if (legacy?.refusal === "codex-command-terminal" || legacy?.refusal === "codex-command-new")
          return parsedCommand(legacy);
        const entry =
          findCommandEntry(entries, typed.name) ??
          (legacy ? findCommandEntry(entries, legacy.command) : undefined);
        if (entry?.run.kind === "client" && Object.hasOwn(CODEX_OPTIONS, entry.run.command))
          return parsedCommand(codexCommandDecision(`/${entry.run.command} ${typed.args}`));
        // Even an omitted menu entry cannot turn a terminal command into an ordinary message.
        if (!legacy) return null;
        return {
          kind: "refused",
          command: legacy.command,
          args: legacy.args,
          refusal: legacy.refusal,
        };
      },
    };
  },
};
