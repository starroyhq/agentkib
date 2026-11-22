import type { InteractionLocale } from "../../interaction-model";
import type {
  PermissionLabel,
  PermissionWords,
  SessionPermissionDescriptor,
} from "../session-permissions";

const copy = {
  "zh-CN": {
    title: "这一轮的权限（Devin 运行中不能询问你）",
    choices: {
      auto: { name: "只读自动", description: "只自动批准只读工具，其他操作会被拒绝" },
      "accept-edits": { name: "自动接受编辑", description: "另外自动批准工作区内的文件修改" },
      smart: { name: "智能批准", description: "另外自动执行快速模型判断为安全的操作" },
      dangerous: { name: "全部批准", description: "自动批准所有工具，包括任何命令" },
    },
  },
  "zh-Hant": {
    title: "這一輪的權限（Devin 執行中無法詢問你）",
    choices: {
      auto: { name: "唯讀自動", description: "只自動核准唯讀工具，其他操作會被拒絕" },
      "accept-edits": { name: "自動接受編輯", description: "另外自動核准工作區內的檔案修改" },
      smart: { name: "智慧核准", description: "另外自動執行快速模型判斷為安全的操作" },
      dangerous: { name: "全部核准", description: "自動核准所有工具，包括任何指令" },
    },
  },
  "en-US": {
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
  "ja-JP": {
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
} satisfies Record<InteractionLocale, PermissionWords>;

export function devinPermissionCopy(locale: InteractionLocale) {
  return copy[locale] ?? copy["en-US"];
}

function permissionLabel(id: string, locale: InteractionLocale): PermissionLabel | undefined {
  const choices = devinPermissionCopy(locale).choices as Readonly<Record<string, PermissionLabel>>;
  return Object.hasOwn(choices, id) ? choices[id] : undefined;
}

// The initial setting approves edits inside the workspace, so it is listed first.
const choices = [
  { id: "accept-edits" },
  { id: "auto" },
  { id: "smart", fullAccessOnly: true },
  { id: "dangerous", fullAccessOnly: true, risky: true },
] as const;

export const devinPermissions = {
  creation: { field: "permissionMode", choices, sendShown: true, copy: devinPermissionCopy },
  settings: {
    label: permissionLabel,
    risky: (id) => id === "dangerous",
    modeIds: choices.map(({ id }) => id),
  },
} satisfies SessionPermissionDescriptor;
