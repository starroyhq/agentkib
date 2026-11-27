import type { InteractionLocale } from "../../interaction-model";
import type {
  PermissionLabel,
  PermissionWords,
  SessionPermissionDescriptor,
} from "../session-permissions";
import { observedClaudePermissionLabel } from "./permission-observation";

const copy = {
  "zh-CN": {
    title: "工具权限",
    choices: {
      default: { name: "手动审批" },
      acceptEdits: { name: "自动接受编辑" },
    },
  },
  "zh-Hant": {
    title: "工具權限",
    choices: {
      default: { name: "手動核准" },
      acceptEdits: { name: "自動接受編輯" },
    },
  },
  "en-US": {
    title: "Tool permissions",
    choices: {
      default: { name: "Manual approval" },
      acceptEdits: { name: "Accept edits" },
    },
  },
  "ja-JP": {
    title: "ツール権限",
    choices: {
      default: { name: "手動承認" },
      acceptEdits: { name: "編集を自動承認" },
    },
  },
} satisfies Record<InteractionLocale, PermissionWords>;

export function claudePermissionCopy(locale: InteractionLocale) {
  return copy[locale] ?? copy["en-US"];
}

function permissionLabel(id: string, locale: InteractionLocale): PermissionLabel | undefined {
  const choices = claudePermissionCopy(locale).choices as Readonly<Record<string, PermissionLabel>>;
  if (Object.hasOwn(choices, id)) return choices[id];
  if (id === "auto") {
    const name = observedClaudePermissionLabel(id, locale);
    return name ? { name } : undefined;
  }
  return undefined;
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
    risky: (id) => id === "auto" || id === "dontAsk" || id === "bypassPermissions",
    modeIds: [...editableModes, "auto"],
  },
} satisfies SessionPermissionDescriptor;
