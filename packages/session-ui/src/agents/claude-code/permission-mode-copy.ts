import type { InteractionLocale as Locale } from "../../interaction-model";

/** Short labels keep the permission risk visible in the notice bar. */
export const permissionModeSummaryCopy = {
  "zh-CN": {
    auto: "auto：操作由分类器审批",
    dontAsk: "dontAsk：不弹出审批",
    bypassPermissions: "跳过权限检查",
    possiblyAuto: "权限模式未确认，可能自动审批",
  },
  "zh-Hant": {
    auto: "auto：操作由分類器審批",
    dontAsk: "dontAsk：不彈出審批",
    bypassPermissions: "略過權限檢查",
    possiblyAuto: "權限模式未確認，可能自動審批",
  },
  "en-US": {
    auto: "auto: classifier approves actions",
    dontAsk: "don't-ask: no approval prompts",
    bypassPermissions: "Permission checks bypassed",
    possiblyAuto: "Mode unconfirmed; auto approval is possible",
  },
  "ja-JP": {
    auto: "auto：分類器が操作を承認",
    dontAsk: "dontAsk：承認確認なし",
    bypassPermissions: "権限チェックを省略",
    possiblyAuto: "権限モード未確認・自動承認の可能性",
  },
} satisfies Record<Locale, Record<string, string>>;
