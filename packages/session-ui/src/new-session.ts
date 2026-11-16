import type { InteractionLocale } from "./interaction-model";

/**
 * What AgentKib knows about starting a session with each Agent: which Agents can start one, the
 * permission choices each offers in its own words, its presets, and the fields the host's create
 * takes. The desktop and Web composers only draw it, so a new Agent is added here.
 */

export type NewSessionAgent = "codex" | "claude-code" | "deepseek-harness" | "devin";
export type ClaudeStartMode = "default" | "acceptEdits" | "plan";
/** Devin CLI's own permission modes; each applies to a whole turn. */
export type DevinStartMode = "auto" | "accept-edits" | "smart" | "dangerous";

/** Agents a session can be started with, in the order the composer lists them. */
export const NEW_SESSION_AGENTS: readonly NewSessionAgent[] = [
  "codex",
  "claude-code",
  "deepseek-harness",
  "devin",
];

/** The start options the host reports for an Agent (`ManagedOptions` in web-client). */
export interface NewSessionOptions {
  available: boolean;
  reason?: string;
  models?: {
    id: string;
    name?: string;
    efforts?: string[];
    isDefault?: boolean;
    defaultEffort?: string;
  }[];
  defaults?: { model?: string | null; effort?: string | null };
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

interface PermissionSpec {
  /** The create field the choice is sent in. */
  field: "policyId" | "permissionMode";
  /** The choices, in the order the Agent's own client lists them. */
  ids: readonly string[];
  /** The options list the host reports them in; only reported choices are offered. */
  offered: (options: NewSessionOptions) => readonly { id: string }[] | undefined;
  /** Codex starts with the shown policy; Claude Code only takes a mode the person chose. */
  sendShown: boolean;
  /** Choices that widen what the Agent may do without asking. */
  risky?: readonly string[];
  /** Choices the host takes only from a device with full access, as it does in session settings. */
  fullAccessOnly?: readonly string[];
}

const PERMISSIONS: Partial<Record<NewSessionAgent, PermissionSpec>> = {
  codex: {
    field: "policyId",
    ids: ["workspace-write-on-request", "workspace-write-auto-review", "full-access-on-request"],
    offered: (options) => options.policies,
    sendShown: true,
    risky: ["full-access-on-request"],
    fullAccessOnly: ["workspace-write-auto-review", "full-access-on-request"],
  },
  "claude-code": {
    field: "permissionMode",
    ids: ["default", "acceptEdits", "plan"],
    offered: (options) => options.permissionModes,
    sendShown: false,
  },
  // Devin runs a turn without asking, so its mode is the whole turn's. AgentKib starts it with
  // edits inside the workspace approved, as Codex starts here, and lists that first.
  devin: {
    field: "permissionMode",
    ids: ["accept-edits", "auto", "smart", "dangerous"],
    offered: (options) => options.permissionModes,
    sendShown: true,
    risky: ["dangerous"],
    fullAccessOnly: ["smart", "dangerous"],
  },
};

/** Agents whose session starts with its first message, sent along with the create. */
export const PROMPT_AT_CREATE_AGENTS: readonly NewSessionAgent[] = ["devin"];

/** Agents that start from one of their presets, chosen only when a session starts. */
const PRESET_AGENTS: readonly NewSessionAgent[] = ["deepseek-harness"];

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
  /** The choice shown before the person picks one. */
  initial: string;
}

function offeredPermissions(
  agent: NewSessionAgent,
  options: NewSessionOptions | undefined,
  fullAccess: boolean,
) {
  const spec = PERMISSIONS[agent];
  const offered = (spec && options && spec.offered(options)) || [];
  return spec
    ? spec.ids.filter(
        (id) =>
          offered.some((item) => item.id === id) &&
          (fullAccess || !spec.fullAccessOnly?.includes(id)),
      )
    : [];
}

/**
 * The permission choices an Agent offers for a new session; none when the host reports none.
 * Without full access a device keeps the choices the host would refuse from it out of the list.
 */
export function newSessionPermissions(
  agent: NewSessionAgent,
  options: NewSessionOptions | undefined,
  locale: InteractionLocale,
  { fullAccess = true }: { fullAccess?: boolean } = {},
): NewSessionPermissions | undefined {
  const ids = offeredPermissions(agent, options, fullAccess);
  const spec = PERMISSIONS[agent];
  const words = newSessionCopy(locale).permissions[agent as keyof NewSessionCopy["permissions"]];
  if (!spec || !ids.length || !words) return undefined;
  const names = words.choices as Record<string, { name: string; description: string }>;
  return {
    title: words.title,
    initial: ids[0]!,
    choices: ids.map((id) => ({
      id,
      name: names[id]?.name ?? id,
      description: names[id]?.description ?? "",
      risky: !!spec.risky?.includes(id),
    })),
  };
}

/** The presets an Agent starts from, and the one it uses when none is chosen. */
export function newSessionPresets(agent: NewSessionAgent, options: NewSessionOptions | undefined) {
  const presets = PRESET_AGENTS.includes(agent) ? (options?.agentPresets ?? []) : [];
  return { presets, defaultId: presets.find((item) => item.isDefault)?.id };
}

export interface NewSessionSelection {
  agent: NewSessionAgent;
  workspaceId: string;
  /** The model and effort picked in the composer; empty for the Agent's defaults. */
  model?: string;
  effort?: string;
  /** The model the composer shows, which a picked effort is sent with. */
  shownModel?: string;
  /** The permission choice the person picked, if any. */
  permission?: string;
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
  policyId?: string;
  permissionMode?: ClaudeStartMode | DevinStartMode;
  agentPreset?: string;
  /** The first message, for an Agent in `PROMPT_AT_CREATE_AGENTS`. */
  prompt?: string;
}

export function newSessionCreateFields(
  selection: NewSessionSelection,
  options: NewSessionOptions | undefined,
): NewSessionCreateFields {
  const { agent, workspaceId, model, effort, shownModel, permission, preset } = selection;
  const spec = PERMISSIONS[agent];
  const ids = offeredPermissions(agent, options, selection.fullAccess ?? true);
  const sent =
    permission && ids.includes(permission) ? permission : spec?.sendShown ? ids[0] : undefined;
  const { defaultId } = newSessionPresets(agent, options);
  return {
    // Hosts that predate other Agents read a create without one as Codex.
    ...(agent !== "codex" ? { agent } : {}),
    workspaceId,
    // A chosen effort applies to the model displayed by the composer.
    ...(model || effort ? { model: model || shownModel } : {}),
    ...(effort ? { effort } : {}),
    ...(spec && sent
      ? spec.field === "policyId"
        ? { policyId: sent }
        : { permissionMode: sent as ClaudeStartMode | DevinStartMode }
      : {}),
    // Without a choice an Agent starts its own default preset.
    ...(preset && preset !== defaultId ? { agentPreset: preset } : {}),
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
    permissions: {
      codex: {
        title: "应如何批准 Codex 操作？",
        choices: {
          "workspace-write-on-request": {
            name: "请求批准",
            description: "编辑外部文件和使用互联网时始终询问",
          },
          "workspace-write-auto-review": {
            name: "帮我批准",
            description: "仅对检测到的风险操作请求批准",
          },
          "full-access-on-request": {
            name: "完全访问权限",
            description: "可不受限制地访问互联网和你电脑上的任何文件",
          },
        },
      },
      devin: {
        title: "这一轮的权限（Devin 运行中不能询问你）",
        choices: {
          auto: { name: "只读自动", description: "只自动批准只读工具，其他操作会被拒绝" },
          "accept-edits": { name: "自动接受编辑", description: "另外自动批准工作区内的文件修改" },
          smart: { name: "智能批准", description: "另外自动执行快速模型判断为安全的操作" },
          dangerous: { name: "全部批准", description: "自动批准所有工具，包括任何命令" },
        },
      },
      "claude-code": {
        title: "权限",
        choices: {
          default: { name: "默认", description: "修改文件和运行命令前先问你" },
          acceptEdits: { name: "自动接受编辑", description: "直接修改文件，运行命令前仍会问你" },
          plan: { name: "计划模式", description: "只读和规划，不修改文件" },
        },
      },
    },
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
    permissions: {
      codex: {
        title: "應如何核准 Codex 操作？",
        choices: {
          "workspace-write-on-request": {
            name: "要求核准",
            description: "一律先詢問是否要編輯外部檔案及使用網際網路",
          },
          "workspace-write-auto-review": {
            name: "代我核准",
            description: "僅對偵測為可能不安全的操作要求核准",
          },
          "full-access-on-request": {
            name: "完整存取權",
            description: "可無限制存取網際網路和您電腦上的任何檔案",
          },
        },
      },
      devin: {
        title: "這一輪的權限（Devin 執行中無法詢問你）",
        choices: {
          auto: { name: "唯讀自動", description: "只自動核准唯讀工具，其他操作會被拒絕" },
          "accept-edits": { name: "自動接受編輯", description: "另外自動核准工作區內的檔案修改" },
          smart: { name: "智慧核准", description: "另外自動執行快速模型判斷為安全的操作" },
          dangerous: { name: "全部核准", description: "自動核准所有工具，包括任何指令" },
        },
      },
      "claude-code": {
        title: "權限",
        choices: {
          default: { name: "預設", description: "修改檔案和執行指令前先問你" },
          acceptEdits: { name: "自動接受編輯", description: "直接修改檔案，執行指令前仍會問你" },
          plan: { name: "計畫模式", description: "只讀取和規劃，不修改檔案" },
        },
      },
    },
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
    permissions: {
      codex: {
        title: "How should Codex actions be approved?",
        choices: {
          "workspace-write-on-request": {
            name: "Ask for approval",
            description: "Always ask to edit external files and use the internet",
          },
          "workspace-write-auto-review": {
            name: "Approve for me",
            description: "Only ask for actions detected as potentially unsafe",
          },
          "full-access-on-request": {
            name: "Full access",
            description: "Unrestricted access to the internet and any file on your computer",
          },
        },
      },
      devin: {
        title: "Permissions for this turn (Devin cannot ask while it runs)",
        choices: {
          auto: {
            name: "Read-only auto",
            description: "Approve only read-only tools; refuse the rest",
          },
          "accept-edits": {
            name: "Accept edits",
            description: "Also approve file changes inside the workspace",
          },
          smart: { name: "Smart", description: "Also run actions a fast model judges safe" },
          dangerous: {
            name: "Approve all",
            description: "Approve every tool, including any command",
          },
        },
      },
      "claude-code": {
        title: "Permissions",
        choices: {
          default: { name: "Default", description: "Ask before editing files or running commands" },
          acceptEdits: {
            name: "Accept edits",
            description: "Edit files directly; still ask before running commands",
          },
          plan: { name: "Plan mode", description: "Read and plan only; no file changes" },
        },
      },
    },
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
    permissions: {
      codex: {
        title: "Codex の操作をどのように承認しますか？",
        choices: {
          "workspace-write-on-request": {
            name: "承認を求める",
            description: "外部ファイルの編集やインターネットの利用について、常に確認を求めます",
          },
          "workspace-write-auto-review": {
            name: "代わりに承認",
            description: "安全でない可能性があると検出された操作についてのみ確認を求めます",
          },
          "full-access-on-request": {
            name: "フルアクセス",
            description:
              "インターネットとコンピューター上のすべてのファイルに無制限でアクセスします",
          },
        },
      },
      devin: {
        title: "このターンの権限（Devin は実行中に確認できません）",
        choices: {
          auto: {
            name: "読み取りのみ自動",
            description: "読み取り専用のツールだけを自動承認し、それ以外は拒否します",
          },
          "accept-edits": {
            name: "編集を自動承認",
            description: "ワークスペース内のファイル変更も自動承認します",
          },
          smart: {
            name: "スマート承認",
            description: "高速モデルが安全と判断した操作も自動で実行します",
          },
          dangerous: {
            name: "すべて承認",
            description: "どのコマンドも含め、すべてのツールを自動承認します",
          },
        },
      },
      "claude-code": {
        title: "権限",
        choices: {
          default: {
            name: "デフォルト",
            description: "ファイルの変更やコマンドの実行前に確認します",
          },
          acceptEdits: {
            name: "編集を自動承認",
            description: "ファイルは直接変更し、コマンドの実行前には確認します",
          },
          plan: {
            name: "プランモード",
            description: "読み取りと計画のみで、ファイルは変更しません",
          },
        },
      },
    },
  },
} satisfies Record<InteractionLocale, unknown>;

export type NewSessionCopy = (typeof copy)["zh-CN"];

/** The new-session composer's words; `{name}` and `{reason}` are filled with `fillCopy`. */
export function newSessionCopy(locale: InteractionLocale): NewSessionCopy {
  return copy[locale] ?? copy["en-US"];
}
