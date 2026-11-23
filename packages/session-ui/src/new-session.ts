import {
  sessionProviderCapabilities,
  sessionProviderDeclaration,
  type ManagedAgent,
  type SessionProviderDeclaration,
} from "@agentkib/web-client";
import { DEFAULT_NEW_SESSION_AGENT, sessionCreationDescription } from "./agents/session-creation";
import {
  newSessionPermissionCopy,
  sessionPermissionDescriptor,
} from "./agents/session-permissions";
import type { InteractionLocale } from "./interaction-model";

/**
 * Shared new-session selection and request fields. The Provider declares available controls, and
 * the host supplies the options that the current device can use.
 */
export type NewSessionAgent = ManagedAgent;
export { NEW_SESSION_AGENTS, PROMPT_AT_CREATE_AGENTS } from "./agents/session-creation";
export type ClaudeStartMode = "default" | "acceptEdits" | "plan";
/** Devin CLI's own permission modes; each applies to a whole turn. */
export type DevinStartMode = "auto" | "accept-edits" | "smart" | "dangerous";

/** The start options the host reports for an Agent (`ManagedOptions` in web-client). */
export interface NewSessionOptions {
  available: boolean;
  reason?: string;
  provider?: {
    create: NewSessionProviderCreate;
    permissionField?: SessionProviderDeclaration["permissionField"];
  };
  models?: {
    id: string;
    name?: string;
    efforts?: string[];
    isDefault?: boolean;
    defaultEffort?: string;
  }[];
  defaults?: { model?: string | null; effort?: string | null };
  serviceTiers?: { id: string }[];
  policies?: { id: string }[];
  permissionModes?: { id: string }[];
  agentPresets?: {
    id: string;
    name: string | null;
    description: string | null;
    isDefault: boolean;
    broken: string | null;
  }[];
}

type NewSessionProviderCreate = {
  serviceTiers: boolean;
  permissionPicker?: boolean;
  agentPresets?: boolean;
  verifyStartupModel?: boolean;
  planMode?: "mode" | "permissionMode";
};

export interface NewSessionPermissionChoice {
  id: string;
  name: string;
  description: string;
  risky: boolean;
}

export interface NewSessionPermissions {
  /** The menu's heading in the Agent's own words. */
  title: string;
  choices: NewSessionPermissionChoice[];
  /** The choice applied at startup without an explicit selection, if the Agent sends one. */
  initial?: string;
}

function creationPermissions(
  agent: NewSessionAgent,
  options?: NewSessionOptions,
  create = options?.provider?.create,
) {
  const declared = sessionProviderDeclaration(agent);
  const descriptor = sessionPermissionDescriptor(agent)?.creation;
  if (!declared || !("create" in declared) || !descriptor) return undefined;
  const field = options?.provider?.permissionField ?? declared.permissionField;
  if (
    (create?.permissionPicker ?? declared.create.permissionPicker) !== true ||
    field !== descriptor.field
  )
    return undefined;
  return descriptor;
}

function offeredPermissions(
  spec: NonNullable<ReturnType<typeof creationPermissions>>,
  options: NewSessionOptions | undefined,
  fullAccess: boolean,
) {
  const offered = spec.field === "policyId" ? options?.policies : options?.permissionModes;
  return spec.choices.filter(
    ({ id, fullAccessOnly }) =>
      offered?.some((item) => item.id === id) && (fullAccess || !fullAccessOnly),
  );
}

/** The label used when a registered permission picker has no usable options. */
export function newSessionPermissionFallbackTitle(
  agent: NewSessionAgent,
  locale: InteractionLocale,
): string | undefined {
  const spec = creationPermissions(agent);
  return spec?.fallbackTitle ? spec.copy(locale).title : undefined;
}

/** The permission choices this device can start a session with, from the reported catalog. */
export function newSessionPermissions(
  agent: NewSessionAgent,
  options: NewSessionOptions | undefined,
  locale: InteractionLocale,
  { fullAccess = true }: { fullAccess?: boolean } = {},
): NewSessionPermissions | undefined {
  const spec = creationPermissions(agent, options);
  if (!spec) return undefined;
  const choices = offeredPermissions(spec, options, fullAccess).filter(
    ({ separatePlan }) => !separatePlan,
  );
  if (!choices.length) return undefined;
  const words = spec.copy(locale);
  return {
    title: words.title,
    initial: spec.sendShown ? choices[0].id : undefined,
    choices: choices.map(({ id, risky }) => ({
      id,
      name: words.choices[id]?.name ?? id,
      description: words.choices[id]?.description ?? "",
      risky: !!risky,
    })),
  };
}

/** The presets an Agent starts from, and the one it uses when none is chosen. */
export function newSessionPresets(
  agent: NewSessionAgent,
  options: NewSessionOptions | undefined,
  create = options?.provider?.create ?? sessionProviderCapabilities(agent)?.create,
) {
  const presets = create?.agentPresets === true ? (options?.agentPresets ?? []) : [];
  return { presets, defaultId: presets.find((item) => item.isDefault)?.id };
}

export function newSessionPresetChoices(
  agent: NewSessionAgent,
  options: NewSessionOptions | undefined,
  locale: InteractionLocale,
  create?: NewSessionProviderCreate,
) {
  const { presets, defaultId } = newSessionPresets(agent, options, create);
  const display = sessionCreationDescription(agent)?.preset;
  return {
    defaultId,
    presets: presets.map((item) => ({
      id: item.id,
      ...(display?.text(item, locale) ?? {
        name: item.name ?? item.id,
        description: item.description,
      }),
      disabledReason: item.broken
        ? (display?.copy(locale).broken ?? newSessionCopy(locale).optionsUnavailable)
        : undefined,
    })),
  };
}

export interface NewSessionSelection {
  agent: NewSessionAgent;
  workspaceId: string;
  /** The model and settings picked in the composer; empty for the Agent's defaults. */
  model?: string;
  effort?: string;
  serviceTierId?: string;
  /** The model the composer shows, which a picked effort or tier is sent with. */
  shownModel?: string;
  /** The permission choice the person picked, if any. */
  permission?: string;
  planning?: boolean;
  /** The preset the person picked, if any. */
  preset?: string;
  /** Whether this device has full access; see `newSessionPermissions`. */
  fullAccess?: boolean;
}

/** The fields the host's managed create takes for this selection (`ManagedActionBody`). */
export interface NewSessionCreateFields {
  agent?: NewSessionAgent;
  workspaceId: string;
  model?: string;
  effort?: string;
  serviceTierId?: string;
  policyId?: string;
  mode?: "plan";
  permissionMode?: ClaudeStartMode | DevinStartMode;
  agentPreset?: string;
  /** The first message for a provider that creates sessions with a message. */
  prompt?: string;
  verifyStartupModel?: true;
}

export function newSessionCreateFields(
  selection: NewSessionSelection,
  options: NewSessionOptions | undefined,
  create = options?.provider?.create,
): NewSessionCreateFields {
  const { agent, workspaceId, model, effort, shownModel, permission, preset } = selection;
  const canChooseTier =
    create?.serviceTiers ?? options?.serviceTiers?.some(({ id }) => id === selection.serviceTierId);
  const serviceTierId = canChooseTier ? selection.serviceTierId : undefined;
  const spec = creationPermissions(agent, options, create);
  const ids = spec
    ? offeredPermissions(spec, options, selection.fullAccess ?? true).map(({ id }) => id)
    : [];
  const planMode = create?.planMode;
  const requestedPermission =
    selection.planning && planMode === "permissionMode" ? "plan" : permission;
  const sent =
    requestedPermission && ids.includes(requestedPermission)
      ? requestedPermission
      : spec?.sendShown
        ? ids[0]
        : undefined;
  const { presets, defaultId } = newSessionPresets(agent, options, create);
  return {
    // Hosts that predate other Agents read a create without one as Codex.
    ...(agent !== DEFAULT_NEW_SESSION_AGENT ? { agent } : {}),
    workspaceId,
    // Effort and service tier apply to the model displayed by the composer.
    ...(model || effort || serviceTierId ? { model: model || shownModel } : {}),
    ...(effort ? { effort } : {}),
    ...(serviceTierId ? { serviceTierId } : {}),
    ...(selection.planning && planMode === "mode" ? { mode: "plan" as const } : {}),
    ...(create?.verifyStartupModel && options?.models?.length && workspaceId && (model || effort)
      ? { verifyStartupModel: true }
      : {}),
    ...(spec && sent
      ? spec.field === "policyId"
        ? { policyId: sent }
        : { permissionMode: sent as ClaudeStartMode | DevinStartMode }
      : {}),
    // Without a choice an Agent starts its own default preset.
    ...(preset && preset !== defaultId && presets.some(({ id, broken }) => id === preset && !broken)
      ? { agentPreset: preset }
      : {}),
  };
}

const copy = {
  "zh-CN": {
    newSession: "新建会话",
    placeholder: "描述要做的事，在所选工作区新建会话…",
    message: "第一条消息",
    workspace: "工作区",
    searchWorkspaces: "搜索工作区",
    recentWorkspaces: "最近使用",
    allWorkspaces: "全部工作区",
    noWorkspaceMatch: "没有找到工作区",
    addWorkspace: "添加工作区…",
    agent: "Agent",
    notInstalled: "未安装",
    preset: "预设",
    permission: "权限",
    model: "模型",
    loadingOptions: "正在加载选项…",
    optionsUnavailable: "选项不可用",
    attach: "添加文件",
    send: "发送",
    details: "详情",
    unknown: "还不确定会话有没有建好，正在核对。核对完之前不能再发送。",
    openSettings: "去设置",
    noWorkspace: "还没有工作区",
    noWorkspaceHint: "添加工作区后，就能在这里新建会话。",
    addWorkspaceButton: "添加工作区",
    removeFile: "移除 {name}",
    notCreated: "没有建成会话：{reason}",
    startModelUnconfirmed: "无法确认新会话已应用所选模型。首条消息已保留为草稿。",
    startModelUnavailable: "暂时无法核对 DeepSeek Harness 的模型目录，请稍后再试。",
    startModelUpgrade: "请更新 DeepSeek Harness 中的 AgentKib 插件，以便在创建会话时选择模型。",
    claudeStartupModelsUnavailable: "暂时无法核对 Claude Code 的模型目录，请稍后再试。",
    agentUnavailable: "{reason}可以换一个 Agent，或去设置里查看。",
    agentUnavailableHere: "{reason}可以换一个 Agent。",
    permissions: newSessionPermissionCopy("zh-CN"),
  },
  "zh-Hant": {
    newSession: "新增對話",
    placeholder: "描述要做的事，在所選工作區新增對話…",
    message: "第一則訊息",
    workspace: "工作區",
    searchWorkspaces: "搜尋工作區",
    recentWorkspaces: "最近使用",
    allWorkspaces: "全部工作區",
    noWorkspaceMatch: "找不到工作區",
    addWorkspace: "新增工作區…",
    agent: "Agent",
    notInstalled: "未安裝",
    preset: "預設",
    permission: "權限",
    model: "模型",
    loadingOptions: "正在載入選項…",
    optionsUnavailable: "選項無法使用",
    attach: "新增檔案",
    send: "傳送",
    details: "詳細資料",
    unknown: "還不確定對話有沒有建立，正在核對。核對完成前不能再傳送。",
    openSettings: "前往設定",
    noWorkspace: "還沒有工作區",
    noWorkspaceHint: "新增工作區後，就能在這裡新增對話。",
    addWorkspaceButton: "新增工作區",
    removeFile: "移除 {name}",
    notCreated: "沒有建立對話：{reason}",
    startModelUnconfirmed: "無法確認新對話已套用所選模型。第一則訊息已保留為草稿。",
    startModelUnavailable: "暫時無法核對 DeepSeek Harness 的模型清單，請稍後再試。",
    startModelUpgrade: "請更新 DeepSeek Harness 中的 AgentKib 外掛，以便在建立對話時選擇模型。",
    claudeStartupModelsUnavailable: "暫時無法核對 Claude Code 的模型清單，請稍後再試。",
    agentUnavailable: "{reason}可以換一個 Agent，或到設定裡查看。",
    agentUnavailableHere: "{reason}可以換一個 Agent。",
    permissions: newSessionPermissionCopy("zh-Hant"),
  },
  "en-US": {
    newSession: "New session",
    placeholder: "Describe the task to start a session in the chosen workspace…",
    message: "First message",
    workspace: "Workspace",
    searchWorkspaces: "Search workspaces",
    recentWorkspaces: "Recent",
    allWorkspaces: "All workspaces",
    noWorkspaceMatch: "No workspace found",
    addWorkspace: "Add workspace…",
    agent: "Agent",
    notInstalled: "Not installed",
    preset: "Preset",
    permission: "Permissions",
    model: "Model",
    loadingOptions: "Loading options…",
    optionsUnavailable: "Options unavailable",
    attach: "Add files",
    send: "Send",
    details: "Details",
    unknown:
      "Not sure yet whether the session was created; checking. You can't send again until the check finishes.",
    openSettings: "Open Settings",
    noWorkspace: "No workspaces yet",
    noWorkspaceHint: "Add a workspace to start sessions here.",
    addWorkspaceButton: "Add workspace",
    removeFile: "Remove {name}",
    notCreated: "The session was not created: {reason}",
    startModelUnconfirmed:
      "Could not confirm the model for the new session. Your first message is still a draft.",
    startModelUnavailable: "Could not check the DeepSeek Harness model catalog. Try again shortly.",
    startModelUpgrade:
      "Update the AgentKib plugin in DeepSeek Harness to select a model before starting a session.",
    claudeStartupModelsUnavailable:
      "Could not check the Claude Code model catalog. Try again shortly.",
    agentUnavailable: "{reason} Choose another Agent, or check Settings.",
    agentUnavailableHere: "{reason} Choose another Agent.",
    permissions: newSessionPermissionCopy("en-US"),
  },
  "ja-JP": {
    newSession: "新しい会話",
    placeholder: "やりたいことを書くと、選んだワークスペースで新しい会話を始めます…",
    message: "最初のメッセージ",
    workspace: "ワークスペース",
    searchWorkspaces: "ワークスペースを検索",
    recentWorkspaces: "最近使用",
    allWorkspaces: "すべてのワークスペース",
    noWorkspaceMatch: "ワークスペースが見つかりません",
    addWorkspace: "ワークスペースを追加…",
    agent: "Agent",
    notInstalled: "未インストール",
    preset: "プリセット",
    permission: "権限",
    model: "モデル",
    loadingOptions: "選択肢を読み込み中…",
    optionsUnavailable: "選択肢を利用できません",
    attach: "ファイルを追加",
    send: "送信",
    details: "詳細",
    unknown: "会話が作成されたかまだ確認できていません。確認が終わるまで再送信できません。",
    openSettings: "設定を開く",
    noWorkspace: "ワークスペースがまだありません",
    noWorkspaceHint: "ワークスペースを追加すると、ここで新しい会話を始められます。",
    addWorkspaceButton: "ワークスペースを追加",
    removeFile: "{name} を削除",
    notCreated: "会話を作成できませんでした：{reason}",
    startModelUnconfirmed:
      "新しい会話に選択したモデルが適用されたか確認できませんでした。最初のメッセージは下書きに残っています。",
    startModelUnavailable:
      "DeepSeek Harness のモデル一覧を確認できませんでした。しばらくしてからもう一度お試しください。",
    startModelUpgrade:
      "会話の作成前にモデルを選択するには、DeepSeek Harness の AgentKib プラグインを更新してください。",
    claudeStartupModelsUnavailable:
      "Claude Code のモデル一覧を確認できませんでした。しばらくしてからもう一度お試しください。",
    agentUnavailable: "{reason}別の Agent を選ぶか、設定を確認してください。",
    agentUnavailableHere: "{reason}別の Agent を選んでください。",
    permissions: newSessionPermissionCopy("ja-JP"),
  },
} satisfies Record<InteractionLocale, unknown>;

export type NewSessionCopy = (typeof copy)["zh-CN"];

/** The new-session composer's words; `{name}` and `{reason}` are filled with `fillCopy`. */
export function newSessionCopy(locale: InteractionLocale): NewSessionCopy {
  return copy[locale] ?? copy["en-US"];
}
