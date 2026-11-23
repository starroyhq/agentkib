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
      default: { name: "默认", description: "修改文件和运行命令前先问你" },
      "accept-edits": {
        name: "自动接受编辑",
        description: "直接修改工作区内的文件，其他操作先问你",
      },
      auto: { name: "自动", description: "自动修改文件和运行安全的命令，不可撤销的操作先问你" },
      plan: { name: "计划", description: "先仔细规划，再执行任务" },
    },
  },
  "zh-Hant": {
    title: "工具權限",
    choices: {
      default: { name: "預設", description: "修改檔案和執行指令前先詢問你" },
      "accept-edits": {
        name: "自動接受編輯",
        description: "直接修改工作區內的檔案，其他操作先詢問你",
      },
      auto: {
        name: "自動",
        description: "自動修改檔案和執行安全的指令，無法復原的操作先詢問你",
      },
      plan: { name: "規劃", description: "先仔細規劃，再執行任務" },
    },
  },
  "en-US": {
    title: "Tool permissions",
    choices: {
      default: { name: "Default", description: "Ask before edits and commands" },
      "accept-edits": {
        name: "Accept edits",
        description: "Edit files in the workspace without asking; ask about the rest",
      },
      auto: {
        name: "Auto",
        description: "Make edits and run safe commands; ask before irreversible actions",
      },
      plan: { name: "Plan", description: "Plan carefully before carrying out a task" },
    },
  },
  "ja-JP": {
    title: "ツールの権限",
    choices: {
      default: {
        name: "デフォルト",
        description: "ファイルの編集やコマンドの実行前に確認します",
      },
      "accept-edits": {
        name: "編集を自動承認",
        description: "ワークスペース内のファイルを確認なしで編集し、それ以外は確認します",
      },
      auto: {
        name: "自動",
        description: "編集と安全なコマンドを自動で行い、元に戻せない操作の前に確認します",
      },
      plan: { name: "計画", description: "タスクを実行する前に慎重に計画します" },
    },
  },
} satisfies Record<InteractionLocale, PermissionWords>;

export function antigravityPermissionCopy(locale: InteractionLocale) {
  return copy[locale] ?? copy["en-US"];
}

function permissionLabel(id: string, locale: InteractionLocale): PermissionLabel | undefined {
  const choices = antigravityPermissionCopy(locale).choices as Readonly<
    Record<string, PermissionLabel>
  >;
  return Object.hasOwn(choices, id) ? choices[id] : undefined;
}

// Start with the CLI's default mode, which asks before edits and commands.
const choices = [
  { id: "default" },
  { id: "accept-edits" },
  { id: "auto", risky: true, fullAccessOnly: true },
  { id: "plan" },
] as const;

export const antigravityPermissions = {
  creation: { field: "permissionMode", choices, sendShown: true, copy: antigravityPermissionCopy },
  settings: {
    label: permissionLabel,
    risky: (id) => id === "auto",
    modeIds: choices.map(({ id }) => id),
  },
} satisfies SessionPermissionDescriptor;
