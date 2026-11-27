import type { InteractionLocale } from "../../interaction-model";
import type { PermissionLabel, SessionPermissionDescriptor } from "../session-permissions";

// Names from DeepSeek Harness's own client (dsh-client-ui-permission-presets); DSH has no
// Traditional Chinese, so that column is AgentKib's.
const DSH_POLICIES: Record<string, Record<InteractionLocale, PermissionLabel>> = {
  "read-only": {
    "zh-CN": { name: "仅可查看" },
    "zh-Hant": { name: "僅可檢視" },
    "en-US": { name: "Read Only" },
    "ja-JP": { name: "読み取り専用" },
  },
  "workspace-write": {
    "zh-CN": { name: "工作区内修改" },
    "zh-Hant": { name: "工作區內修改" },
    "en-US": { name: "Workspace Write" },
    "ja-JP": { name: "ワークスペース書き込み" },
  },
  "danger-full-access": {
    "zh-CN": { name: "完全权限" },
    "zh-Hant": { name: "完整權限" },
    "en-US": { name: "Full access" },
    "ja-JP": { name: "フルアクセス" },
  },
  auto: {
    "zh-CN": { name: "自动审查" },
    "zh-Hant": { name: "自動審查" },
    "en-US": { name: "Auto review" },
    "ja-JP": { name: "自動認可レビュー" },
  },
};

export function dshPolicyLabel(id: string, locale: InteractionLocale): PermissionLabel | undefined {
  return Object.hasOwn(DSH_POLICIES, id) ? DSH_POLICIES[id]?.[locale] : undefined;
}

const titles: Record<InteractionLocale, string> = {
  "zh-CN": "权限",
  "zh-Hant": "權限",
  "en-US": "Permissions",
  "ja-JP": "権限",
};

export const deepSeekHarnessPermissions = {
  creation: {
    field: "policyId",
    choices: [
      { id: "read-only" },
      { id: "workspace-write" },
      { id: "danger-full-access", risky: true },
      { id: "full-access-on-request", risky: true },
      { id: "auto", risky: true },
    ],
    sendShown: false,
    fullAccessOnly: true,
    useNativeCatalog: true,
    verifyPolicyId: true,
    fallbackTitle: true,
    copy: (locale) => ({
      title: titles[locale],
      choices: Object.fromEntries(
        Object.entries(DSH_POLICIES).map(([id, words]) => [id, words[locale]]),
      ),
    }),
  },
  settings: {
    label: dshPolicyLabel,
    risky: (id) => id === "full-access-on-request" || id === "danger-full-access",
  },
} satisfies SessionPermissionDescriptor;
