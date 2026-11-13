import type { SupportedLocale as Locale } from "@/core/types";

// Wording for the Claude permission mode notice. Each line states what the CLI does in that mode;
// none of it describes a control AgentKib offers.
export const permissionModeCopy = {
  "zh-CN": {
    auto: "此会话处于 auto 模式：由分类器审核操作并自动放行或拦截，不会逐项询问你。",
    dontAsk: "此会话处于 dontAsk 模式：不会弹出审批；未被规则预先批准的操作会被自动拒绝。",
    bypassPermissions: "此会话跳过权限检查：工具无需审批即可运行，仅显式的询问规则仍会提示。",
    possiblyAuto:
      "AgentKib 未能读取此会话的权限模式。Claude Code 2.1.285 及以上版本在拿不到功能开关时（例如使用第三方 provider 或关闭遥测）可能以 auto 模式启动，此时由分类器代替你审批操作。",
    previous: "这是此会话上一次观察到的模式，下次启动时可能不同。",
  },
  "zh-Hant": {
    auto: "此對話處於 auto 模式：由分類器審核操作並自動放行或攔截，不會逐項詢問你。",
    dontAsk: "此對話處於 dontAsk 模式：不會彈出審批；未被規則預先核准的操作會被自動拒絕。",
    bypassPermissions: "此對話略過權限檢查：工具無需審批即可執行，僅明確的詢問規則仍會提示。",
    possiblyAuto:
      "AgentKib 未能讀取此對話的權限模式。Claude Code 2.1.285 以上版本在取不到功能開關時（例如使用第三方 provider 或關閉遙測）可能以 auto 模式啟動，此時由分類器代替你審批操作。",
    previous: "這是此對話上一次觀察到的模式，下次啟動時可能不同。",
  },
  "en-US": {
    auto: "This session is in auto mode: a classifier reviews actions and allows or blocks them instead of asking you each time.",
    dontAsk:
      "This session is in don't-ask mode: approval prompts are off, and anything not pre-approved by rules is denied automatically.",
    bypassPermissions:
      "This session bypasses permission checks: tools run without approval prompts unless an explicit ask rule applies.",
    possiblyAuto:
      "AgentKib could not read this session's permission mode. Claude Code 2.1.285 or later may start in auto mode when feature flags are unavailable (for example with a third-party provider or telemetry off), where a classifier approves actions instead of you.",
    previous: "This is the mode last observed in this session; the next run may start differently.",
  },
  "ja-JP": {
    auto: "このセッションは auto モードです。分類器が操作を審査して許可またはブロックするため、操作ごとの確認は表示されません。",
    dontAsk:
      "このセッションは dontAsk モードです。承認の確認は表示されず、ルールで事前許可されていない操作は自動的に拒否されます。",
    bypassPermissions:
      "このセッションは権限チェックを省略します。明示的な確認ルールがない限り、ツールは承認なしで実行されます。",
    possiblyAuto:
      "AgentKib はこのセッションの権限モードを読み取れませんでした。Claude Code 2.1.285 以降では、機能フラグを取得できない環境（サードパーティ provider やテレメトリー無効など）で auto モードで起動し、分類器があなたの代わりに操作を承認することがあります。",
    previous: "このセッションで最後に確認されたモードです。次回の起動では異なる場合があります。",
  },
} satisfies Record<Locale, Record<string, string>>;

/** Short labels keep the risk visible while the full explanation remains expandable. */
export const permissionModeSummaryCopy = {
  "zh-CN": {
    auto: "auto：操作由分类器审批",
    dontAsk: "dontAsk：不弹出审批",
    bypassPermissions: "跳过权限检查",
    possiblyAuto: "权限模式未确认，可能自动审批",
    previous: "上次观察",
  },
  "zh-Hant": {
    auto: "auto：操作由分類器審批",
    dontAsk: "dontAsk：不彈出審批",
    bypassPermissions: "略過權限檢查",
    possiblyAuto: "權限模式未確認，可能自動審批",
    previous: "上次觀察",
  },
  "en-US": {
    auto: "auto: classifier approves actions",
    dontAsk: "don't-ask: no approval prompts",
    bypassPermissions: "Permission checks bypassed",
    possiblyAuto: "Mode unconfirmed; auto approval is possible",
    previous: "Last observed",
  },
  "ja-JP": {
    auto: "auto：分類器が操作を承認",
    dontAsk: "dontAsk：承認確認なし",
    bypassPermissions: "権限チェックを省略",
    possiblyAuto: "権限モード未確認・自動承認の可能性",
    previous: "前回の状態",
  },
} satisfies Record<Locale, Record<string, string>>;
