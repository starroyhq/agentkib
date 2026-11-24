import type { InteractionLocale } from "../../interaction-model";
import type {
  PermissionLabel,
  PermissionWords,
  SessionPermissionDescriptor,
} from "../session-permissions";

const copy = {
  "zh-CN": {
    title: "工具权限",
    choices: {
      auto: { name: "只读", description: "只回答和阅读，不修改代码" },
      "accept-edits": {
        name: "自动接受编辑",
        description: "另外自动批准工作区内的文件修改，其他操作先问你",
      },
      smart: { name: "智能批准", description: "另外自动执行快速模型判断为安全的操作" },
      dangerous: { name: "全部批准", description: "自动批准所有工具，包括任何命令" },
    },
  },
  "zh-Hant": {
    title: "工具權限",
    choices: {
      auto: { name: "唯讀", description: "只回答和閱讀，不修改程式碼" },
      "accept-edits": {
        name: "自動接受編輯",
        description: "另外自動核准工作區內的檔案修改，其他操作先詢問你",
      },
      smart: { name: "智慧核准", description: "另外自動執行快速模型判斷為安全的操作" },
      dangerous: { name: "全部核准", description: "自動核准所有工具，包括任何指令" },
    },
  },
  "en-US": {
    title: "Tool permissions",
    choices: {
      auto: {
        name: "Read only",
        description: "Answer and read only; no code changes",
      },
      "accept-edits": {
        name: "Accept edits",
        description: "Also approve file changes inside the workspace; ask you about the rest",
      },
      smart: { name: "Smart", description: "Also run actions a fast model judges safe" },
      dangerous: {
        name: "Approve all",
        description: "Approve every tool, including any command",
      },
    },
  },
  "ja-JP": {
    title: "ツールの権限",
    choices: {
      auto: {
        name: "読み取りのみ",
        description: "回答と読み取りだけを行い、コードは変更しません",
      },
      "accept-edits": {
        name: "編集を自動承認",
        description: "ワークスペース内のファイル変更も自動承認し、それ以外はあなたに確認します",
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
  creation: {
    field: "permissionMode",
    choices,
    sendShown: false,
    defaultId: "accept-edits",
    copy: devinPermissionCopy,
  },
  settings: {
    label: permissionLabel,
    risky: (id) => id === "dangerous",
    modeIds: choices.map(({ id }) => id),
  },
} satisfies SessionPermissionDescriptor;
