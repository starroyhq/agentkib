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
      auto: { name: "只读" },
      "accept-edits": { name: "自动接受编辑" },
      smart: { name: "智能批准" },
      dangerous: { name: "全部批准" },
    },
  },
  "zh-Hant": {
    title: "工具權限",
    choices: {
      auto: { name: "唯讀" },
      "accept-edits": { name: "自動接受編輯" },
      smart: { name: "智慧核准" },
      dangerous: { name: "全部核准" },
    },
  },
  "en-US": {
    title: "Tool permissions",
    choices: {
      auto: { name: "Read only" },
      "accept-edits": { name: "Accept edits" },
      smart: { name: "Smart" },
      dangerous: { name: "Approve all" },
    },
  },
  "ja-JP": {
    title: "ツールの権限",
    choices: {
      auto: { name: "読み取りのみ" },
      "accept-edits": { name: "編集を自動承認" },
      smart: { name: "スマート承認" },
      dangerous: { name: "すべて承認" },
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
