import {
  sessionProviderDeclaration,
  type CodexCommandAction,
  type SessionCapabilities,
  type SessionCommandEntry,
  type SessionCommandMenu,
  type SessionProviderDeclaration,
} from "@agentkib/web-client";
import {
  claudeCommandCopy,
  claudeCommands,
  type AgentKibCommand,
  type AgentKibPanel,
} from "./claude-code/commands";
import { codexCommandCopy, codexCommands } from "./codex/commands";
import { dshCommandCopy, dshCommands } from "./deepseek-harness/commands";

export {
  agentKibCommand,
  agentKibPanel,
  claudeSlashOptions,
  unsupportedEffortReason,
  type AgentKibCommand,
  type AgentKibPanel,
} from "./claude-code/commands";
export { codexSlashOptions } from "./codex/commands";
export { dshSlashOptions } from "./deepseek-harness/commands";

export interface SlashCommandOption {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases: string[];
  disabledReason?: string;
}

export type ParsedCommandAction = CodexCommandAction | AgentKibCommand;
type LocalControl = "model" | "effort" | "goal";
export type RegisteredCommandOption = SlashCommandOption & {
  localControl?: LocalControl;
  action?: ParsedCommandAction["action"];
  native?: boolean;
};
export type ParsedSessionCommand = {
  command: string;
  args: string;
  refusal?: string | null;
  refusalReason?: string;
  invalidGoalReason?: string;
  panel?: AgentKibPanel;
  action?: ParsedCommandAction;
  localControl?: LocalControl;
} & (
  | { kind: "native"; panel?: never; action?: never }
  | { kind: "client" }
  | { kind: "refused"; refusal: string; panel?: never; action?: never }
);

export type CommandContext = {
  menu?: SessionCommandMenu;
  legacy?: SessionCapabilities["commands"];
  owner: { local: boolean; full: boolean };
  canSend: boolean;
  canReadNativeCommands: boolean;
  locale: string;
};

export type CommandRegistration = {
  source: NonNullable<SessionProviderDeclaration["commands"]>["source"];
  connection: NonNullable<SessionProviderDeclaration["connection"]>["kind"];
  emptyMenu?: boolean;
  localArgumentHints?: boolean;
  copy(locale: string): { label: string; empty?: string };
  configure(context: CommandContext): {
    options: RegisteredCommandOption[];
    parse(text: string): ParsedSessionCommand | null;
  };
};

const localCopy = {
  "zh-CN": {
    model: "更改下一轮模型",
    effort: "更改下一轮思考强度",
    rename: "在 AgentKib 中重命名会话",
    goal: "设置持续目标",
    planMode: "开启计划模式",
  },
  "zh-Hant": {
    model: "變更下一輪模型",
    effort: "變更下一輪思考強度",
    rename: "在 AgentKib 中重新命名對話",
    goal: "設定持續目標",
    planMode: "開啟計畫模式",
  },
  "en-US": {
    model: "Change the next-turn model",
    effort: "Change the next-turn reasoning effort",
    rename: "Rename the session in AgentKib",
    goal: "Set a persistent goal",
    planMode: "Turn on Plan mode",
  },
  "ja-JP": {
    model: "次のターンのモデルを変更",
    effort: "次のターンの推論の強度を変更",
    rename: "AgentKib で会話の名前を変更",
    goal: "継続目標を設定",
    planMode: "計画モードをオンにする",
  },
};

export function commandLocale(locale: string) {
  return locale === "zh-Hant"
    ? "zh-Hant"
    : locale.startsWith("zh")
      ? "zh-CN"
      : locale.startsWith("ja")
        ? "ja-JP"
        : "en-US";
}

export function localCommandCopy(locale: string) {
  return localCopy[commandLocale(locale)];
}

/** Compatibility copy for legacy callers of the menu hook. */
export function legacyCommandMenuCopy(locale: string) {
  return claudeCommandCopy(locale);
}

export function slashCommandCopy(locale: string) {
  return {
    ...claudeCommandCopy(locale),
    ...localCommandCopy(locale),
    ...codexCommandCopy(locale),
    ...dshCommandCopy(locale),
  };
}

const localHints = {
  model: "[model]",
  effort: "[low|medium|high|xhigh|max]",
  goal: "[objective]",
};

/** Add only controls AgentKib can handle locally; the CLI still owns its native catalog. */
export function composerLocalSlashOptions(
  commands: readonly SlashCommandOption[],
  controls: { model: boolean; effort: boolean; goal: boolean },
  locale: string,
): SlashCommandOption[] {
  const copy = localCommandCopy(locale);
  const offered = commands.filter(
    (command) =>
      !Object.hasOwn(controls, command.name) || controls[command.name as keyof typeof controls],
  );
  return [
    ...offered,
    ...(["model", "effort", "goal"] as const).flatMap((name) =>
      controls[name] && !commands.some((command) => command.name === name)
        ? [{ name, aliases: [], argumentHint: localHints[name], description: copy[name] }]
        : [],
    ),
  ];
}

export function composerPanelShortcut(text: string, model: boolean, goal: boolean) {
  switch (text.trim().toLowerCase()) {
    case "/model":
      return model ? "model" : undefined;
    case "/effort":
      return model ? "effort" : undefined;
    case "/goal":
      return goal ? "goal" : undefined;
    default:
      return undefined;
  }
}

/** The menu entry for plan mode where an agent's own list has none. */
export function planSlashOption(locale: string): SlashCommandOption {
  return { name: "plan", description: localCommandCopy(locale).planMode, aliases: [] };
}

export function findCommandEntry(entries: readonly SessionCommandEntry[], name: string) {
  const normalized = name.toLowerCase();
  return (
    entries.find((entry) => entry.name.toLowerCase() === normalized) ??
    entries.find((entry) => entry.aliases?.some((alias) => alias.toLowerCase() === normalized))
  );
}

function commandRegistration(
  provider?: SessionProviderDeclaration,
): CommandRegistration | undefined {
  return [codexCommands, claudeCommands, dshCommands].find(
    (entry) =>
      entry.source === provider?.commands?.source &&
      entry.connection === provider?.connection?.kind,
  );
}

function commandOptions(
  registration: CommandRegistration | undefined,
  native: readonly RegisteredCommandOption[],
  context: CommandContext,
  controls: { model: boolean; effort: boolean; goal: boolean },
  preserveReportedClientOptions = false,
): RegisteredCommandOption[] {
  if (registration?.localArgumentHints) {
    const reported = context.menu?.state === "ready" ? context.menu.entries : undefined;
    if (!preserveReportedClientOptions || !reported)
      return composerLocalSlashOptions(native, controls, context.locale);
    const visible = native.filter((option) => {
      if (!Object.hasOwn(controls, option.name) || controls[option.name as keyof typeof controls])
        return true;
      return findCommandEntry(reported, option.name)?.run.kind === "client";
    });
    return [
      ...visible,
      ...composerLocalSlashOptions([], controls, context.locale).filter(
        (panel) => !native.some((entry) => entry.name === panel.name),
      ),
    ];
  }
  return [
    ...native,
    ...composerLocalSlashOptions([], controls, context.locale)
      .filter((panel) => !native.some((entry) => entry.name === panel.name))
      .map(({ argumentHint: _hint, ...panel }) => panel),
  ];
}

/** Compatibility for callers with only the legacy catalog. */
export function sessionSlashOptions(
  agent: string | undefined,
  catalog: SessionCapabilities["commands"],
  options: {
    canSend: boolean;
    claudeOwner: boolean;
    dshOwner: boolean;
    model: boolean;
    goal: boolean;
    locale: string;
  },
): SlashCommandOption[] {
  const { canSend, claudeOwner, dshOwner, model, goal, locale } = options;
  const registration = commandRegistration(sessionProviderDeclaration(agent));
  const context = {
    locale,
    canSend,
    canReadNativeCommands: canSend,
    owner: { local: claudeOwner, full: dshOwner },
    legacy: catalog,
  };
  const configured = registration?.configure(context);
  return commandOptions(registration, configured?.options ?? [], context, {
    model,
    effort: model,
    goal,
  }).map(({ localControl: _control, action: _action, native: _native, ...option }) => option);
}

export function resolveSessionCommands({
  provider,
  selected,
  capabilities,
  canSend,
  canReadNativeCommands = canSend,
  localOwner,
  fullAccess,
  model,
  goal,
  locale,
  fallbackLabel,
  modelDisabledReason,
  goalDisabledReason,
  nativeDisabledReason,
  canRun,
  actionDisabledReason,
}: {
  provider?: SessionProviderDeclaration;
  selected: string;
  capabilities?: Pick<SessionCapabilities, "sessionId" | "commands" | "commandMenu">;
  canSend: boolean;
  canReadNativeCommands?: boolean;
  localOwner: boolean;
  fullAccess: boolean;
  model: boolean;
  goal: boolean;
  locale: string;
  fallbackLabel?: string;
  modelDisabledReason?: string;
  goalDisabledReason?: string;
  nativeDisabledReason?: string;
  canRun?: (action: ParsedCommandAction["action"]) => boolean;
  actionDisabledReason?: (action: ParsedCommandAction["action"]) => string | undefined;
}) {
  const registration = commandRegistration(provider);
  const scoped = capabilities?.sessionId === selected ? capabilities : undefined;
  const context: CommandContext = {
    menu: scoped?.commandMenu,
    legacy: scoped?.commands,
    canSend,
    canReadNativeCommands,
    locale,
    owner: { local: localOwner, full: localOwner || fullAccess },
  };
  const configured = registration?.configure(context);
  const options = commandOptions(
    registration,
    configured?.options ?? [],
    context,
    { model, effort: model, goal },
    true,
  ).map(({ localControl, action, native, ...option }) => {
    const disabledReason =
      (!model && (localControl === "model" || localControl === "effort")
        ? modelDisabledReason
        : !goal && localControl === "goal"
          ? goalDisabledReason
          : undefined) ??
      (native && !canSend ? nativeDisabledReason : undefined) ??
      (action && canRun?.(action) === false ? actionDisabledReason?.(action) : undefined);
    return disabledReason ? { ...option, disabledReason } : option;
  });
  const copy = registration?.copy(locale);
  const catalogKnown = context.menu
    ? context.menu.state === "ready"
    : registration?.source === "built-in" || options.length > 0 || !!context.legacy?.length;
  return {
    options,
    label: copy?.label ?? fallbackLabel ?? claudeCommandCopy(locale).label,
    empty: catalogKnown ? undefined : copy?.empty,
    catalogKnown,
    enabled: !!registration?.emptyMenu || options.length > 0,
    parse: (draft: string) => configured?.parse(draft) ?? null,
  };
}
