import type { InteractionLocale } from "../../interaction-model";
import type {
  PermissionLabel,
  PermissionWords,
  SessionPermissionDescriptor,
} from "../session-permissions";

const copy = {
  "zh-CN": {
    title: "应如何批准 Codex 操作？",
    choices: {
      "workspace-write-on-request": { name: "请求批准" },
      "workspace-write-auto-review": { name: "帮我批准" },
      "full-access-on-request": { name: "完全访问权限" },
    },
  },
  "zh-Hant": {
    title: "應如何核准 Codex 操作？",
    choices: {
      "workspace-write-on-request": { name: "要求核准" },
      "workspace-write-auto-review": { name: "代我核准" },
      "full-access-on-request": { name: "完整存取權" },
    },
  },
  "en-US": {
    title: "How should Codex actions be approved?",
    choices: {
      "workspace-write-on-request": { name: "Ask for approval" },
      "workspace-write-auto-review": { name: "Approve for me" },
      "full-access-on-request": { name: "Full access" },
    },
  },
  "ja-JP": {
    title: "Codex の操作をどのように承認しますか？",
    choices: {
      "workspace-write-on-request": { name: "承認を求める" },
      "workspace-write-auto-review": { name: "代わりに承認" },
      "full-access-on-request": { name: "フルアクセス" },
    },
  },
} satisfies Record<InteractionLocale, PermissionWords>;

export function codexPermissionCopy(locale: InteractionLocale) {
  return copy[locale] ?? copy["en-US"];
}

export function codexPolicyLabel(
  id: string,
  locale: InteractionLocale,
): PermissionLabel | undefined {
  const choices = codexPermissionCopy(locale).choices as Readonly<Record<string, PermissionLabel>>;
  return Object.hasOwn(choices, id) ? choices[id] : undefined;
}

const choices = [
  { id: "workspace-write-on-request" },
  { id: "workspace-write-auto-review", fullAccessOnly: true },
  { id: "full-access-on-request", fullAccessOnly: true, risky: true },
] as const;

export const codexPermissions = {
  creation: { field: "policyId", choices, sendShown: true, copy: codexPermissionCopy },
  settings: {
    label: codexPolicyLabel,
    risky: (id) => id === "full-access-on-request" || id === "danger-full-access",
  },
} satisfies SessionPermissionDescriptor;
