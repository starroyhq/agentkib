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
      default: { name: "默认" },
      "accept-edits": { name: "自动接受编辑" },
      auto: { name: "自动" },
      plan: { name: "计划" },
    },
  },
  "zh-Hant": {
    title: "工具權限",
    choices: {
      default: { name: "預設" },
      "accept-edits": { name: "自動接受編輯" },
      auto: { name: "自動" },
      plan: { name: "規劃" },
    },
  },
  "en-US": {
    title: "Tool permissions",
    choices: {
      default: { name: "Default" },
      "accept-edits": { name: "Accept edits" },
      auto: { name: "Auto" },
      plan: { name: "Plan" },
    },
  },
  "ja-JP": {
    title: "ツールの権限",
    choices: {
      default: { name: "デフォルト" },
      "accept-edits": { name: "編集を自動承認" },
      auto: { name: "自動" },
      plan: { name: "計画" },
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
  creation: {
    field: "permissionMode",
    choices,
    sendShown: true,
    defaultId: "default",
    copy: antigravityPermissionCopy,
  },
  settings: {
    label: permissionLabel,
    risky: (id) => id === "auto",
    modeIds: choices.map(({ id }) => id),
  },
} satisfies SessionPermissionDescriptor;
