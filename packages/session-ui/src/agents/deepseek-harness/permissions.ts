import type { InteractionLocale } from "../../interaction-model";
import type { PermissionLabel, SessionPermissionDescriptor } from "../session-permissions";

// Names from DeepSeek Harness's own client (dsh-client-ui-permission-presets); DSH has no
// Traditional Chinese, so that column is AgentKib's. Descriptions are AgentKib's: the host only
// reports the preset keys.
const DSH_POLICIES: Record<string, Record<InteractionLocale, PermissionLabel>> = {
  "read-only": {
    "zh-CN": { name: "仅可查看", description: "可读取工作区；修改和其他操作需要你批准。" },
    "zh-Hant": { name: "僅可檢視", description: "可讀取工作區；修改和其他操作需要你核准。" },
    "en-US": {
      name: "Read Only",
      description: "Can read the workspace; changes and other actions require user approval.",
    },
    "ja-JP": {
      name: "読み取り専用",
      description: "ワークスペースを読み取れます。変更やその他の操作には承認が必要です。",
    },
  },
  "workspace-write": {
    "zh-CN": {
      name: "工作区内修改",
      description: "可在工作区和允许的临时目录内写入；更大范围的访问需要你批准。",
    },
    "zh-Hant": {
      name: "工作區內修改",
      description: "可在工作區和允許的暫存目錄內寫入；更大範圍的存取需要你核准。",
    },
    "en-US": {
      name: "Workspace Write",
      description:
        "Can write inside the workspace and permitted temporary directories; wider access requires user approval.",
    },
    "ja-JP": {
      name: "ワークスペース書き込み",
      description:
        "ワークスペースと許可された一時ディレクトリに書き込めます。それ以外へのアクセスには承認が必要です。",
    },
  },
  "danger-full-access": {
    "zh-CN": { name: "完全权限", description: "可访问所有文件并运行命令，不再请求批准。" },
    "zh-Hant": { name: "完整權限", description: "可存取所有檔案並執行指令，不再要求核准。" },
    "en-US": {
      name: "Full access",
      description: "Can access all files and run commands without prompting for approvals.",
    },
    "ja-JP": {
      name: "フルアクセス",
      description: "すべてのファイルにアクセスし、承認を求めずにコマンドを実行できます。",
    },
  },
  auto: {
    "zh-CN": {
      name: "自动审查",
      description: "无沙箱运行；每次工具调用前由同一模型先审查，被拒绝的调用由你决定。",
    },
    "zh-Hant": {
      name: "自動審查",
      description: "無沙箱執行；每次工具呼叫前由同一模型先審查，被拒絕的呼叫由你決定。",
    },
    "en-US": {
      name: "Auto review",
      description:
        "Runs without a sandbox; the same model reviews each tool call first, and the user decides the calls it denies.",
    },
    "ja-JP": {
      name: "自動認可レビュー",
      description:
        "サンドボックスなしで実行します。同じモデルが各ツール呼び出しを先にレビューし、拒否された呼び出しはあなたが判断します。",
    },
  },
};

export function dshPolicyLabel(id: string, locale: InteractionLocale): PermissionLabel | undefined {
  return DSH_POLICIES[id]?.[locale];
}

export const deepSeekHarnessPermissions = {
  settings: {
    label: dshPolicyLabel,
    risky: (id) => id === "full-access-on-request" || id === "danger-full-access",
  },
} satisfies SessionPermissionDescriptor;
