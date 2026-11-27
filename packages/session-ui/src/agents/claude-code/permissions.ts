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
      default: { name: "手动审批", description: "修改文件和运行命令前先问你" },
      acceptEdits: { name: "自动接受编辑", description: "直接修改文件，运行命令前仍会问你" },
    },
  },
  "zh-Hant": {
    title: "工具權限",
    choices: {
      default: { name: "手動核准", description: "修改檔案和執行指令前先問你" },
      acceptEdits: { name: "自動接受編輯", description: "直接修改檔案，執行指令前仍會問你" },
    },
  },
  "en-US": {
    title: "Tool permissions",
    choices: {
      default: {
        name: "Manual approval",
        description: "Ask before editing files or running commands",
      },
      acceptEdits: {
        name: "Accept edits",
        description: "Edit files directly; still ask before running commands",
      },
    },
  },
  "ja-JP": {
    title: "ツール権限",
    choices: {
      default: {
        name: "手動承認",
        description: "ファイルの変更やコマンドの実行前に確認します",
      },
      acceptEdits: {
        name: "編集を自動承認",
        description: "ファイルは直接変更し、コマンドの実行前には確認します",
      },
    },
  },
} satisfies Record<InteractionLocale, PermissionWords>;

export function claudePermissionCopy(locale: InteractionLocale) {
  return copy[locale] ?? copy["en-US"];
}

function permissionLabel(id: string, locale: InteractionLocale): PermissionLabel | undefined {
  const choices = claudePermissionCopy(locale).choices as Readonly<Record<string, PermissionLabel>>;
  return Object.hasOwn(choices, id) ? choices[id] : undefined;
}

const editableModes = ["default", "acceptEdits"] as const;

export const claudePermissions = {
  creation: {
    field: "permissionMode",
    choices: [...editableModes.map((id) => ({ id })), { id: "plan", separatePlan: true }],
    sendShown: false,
    copy: claudePermissionCopy,
    fallbackTitle: true,
  },
  settings: {
    label: permissionLabel,
    risky: () => false,
    modeIds: [...editableModes, "auto"],
  },
} satisfies SessionPermissionDescriptor;
