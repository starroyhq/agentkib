import type { ComposerModelLocale as Locale } from "./composer-model-copy";
import { surfaceCopy, type SessionSurface } from "./session-surface-copy";

export const contextUsageCopy = {
  "zh-CN": {
    title: "上下文用量",
    unknown: "这台电脑尚未提供上下文窗口用量",
    close: "关闭",
    capacityShort: "上限 {total}",
    windowTitle: "上下文窗口",
    capacity: "模型上下文上限 {total} Token",
    usedRemaining: "已使用 {used}%（剩余 {remaining}%）",
    tokenUsage: "已使用 {used} / {total} Token",
    tokenUsageOnly: "已使用 {used} Token",
    stale: "待更新",
    unavailable: "暂不可用",
    awaitingCliReport: "暂无用量数据",
    lastReading: "上次读数",
    compacting: "正在压缩上下文",
    compactingDetail: "上下文正在压缩，用量待更新，暂时无法发送或修改执行设置。",
    pendingDetail: "这台电脑尚未上报本轮上下文用量。",
    permission: "当前浏览器未获上下文用量查看授权。",
    offline: "连接已断开。",
    window: "原生接口未上报当前模型的上下文窗口。",
    invalid: "原生用量报告不完整，暂时无法计算比例。",
    unsupported: "当前 Agent 未提供上下文用量接口。",
    compactAction: "压缩上下文",
    compactDetail:
      "让 Claude Code 总结此前的对话，为后续轮次腾出上下文；此前的消息仍会显示在这里。",
    compactAfterTurn: "当前轮次结束后可以压缩。",
    compactDetailCodex:
      "让 Codex 总结此前的对话，为后续轮次腾出上下文；压缩作为单独的一轮运行，此前的消息仍会显示在这里。",
  },
  "zh-Hant": {
    title: "上下文用量",
    unknown: "這台電腦尚未提供上下文視窗用量",
    close: "關閉",
    capacityShort: "上限 {total}",
    windowTitle: "上下文視窗",
    capacity: "模型上下文上限 {total} Token",
    usedRemaining: "已使用 {used}%（剩餘 {remaining}%）",
    tokenUsage: "已使用 {used} / {total} Token",
    tokenUsageOnly: "已使用 {used} Token",
    stale: "待更新",
    unavailable: "暫不可用",
    awaitingCliReport: "暫無用量資料",
    lastReading: "上次讀數",
    compacting: "正在壓縮上下文",
    compactingDetail: "上下文正在壓縮，用量待更新，暫時無法傳送或修改執行設定。",
    pendingDetail: "這台電腦尚未上報本回合上下文用量。",
    permission: "目前瀏覽器未獲上下文用量檢視授權。",
    offline: "連線已中斷。",
    window: "原生介面未上報目前模型的上下文視窗。",
    invalid: "原生用量報告不完整，暫時無法計算比例。",
    unsupported: "目前 Agent 未提供上下文用量介面。",
    compactAction: "壓縮上下文",
    compactDetail:
      "讓 Claude Code 總結先前的對話，為後續回合騰出上下文；先前的訊息仍會顯示在這裡。",
    compactAfterTurn: "目前回合結束後可以壓縮。",
    compactDetailCodex:
      "讓 Codex 總結先前的對話，為後續回合騰出上下文；壓縮會作為單獨的一回合執行，先前的訊息仍會顯示在這裡。",
  },
  "en-US": {
    title: "Context usage",
    unknown: "The computer has not reported context-window usage",
    close: "Close",
    capacityShort: "{total} limit",
    windowTitle: "Context window",
    capacity: "Model context limit of {total} tokens",
    usedRemaining: "{used}% used ({remaining}% remaining)",
    tokenUsage: "{used} / {total} tokens used",
    tokenUsageOnly: "{used} tokens used",
    stale: "Awaiting update",
    unavailable: "Unavailable",
    awaitingCliReport: "No usage data yet",
    lastReading: "Last reading",
    compacting: "Compacting context",
    compactingDetail:
      "Context is compacting. Usage awaits an update; sending and changing execution settings are unavailable.",
    pendingDetail: "The computer has not reported context usage for this turn yet.",
    permission: "This browser does not have permission to view context usage.",
    offline: "Disconnected.",
    window: "The native interface has not reported this model's context window.",
    invalid: "The native usage report is incomplete; its percentage cannot be calculated.",
    unsupported: "This Agent does not provide a context usage interface.",
    compactAction: "Compact context",
    compactDetail:
      "Claude Code summarizes the conversation so far to free up context for later turns. Earlier messages still show here.",
    compactAfterTurn: "You can compact once the current turn ends.",
    compactDetailCodex:
      "Codex summarizes the conversation so far to free up context for later turns. Compaction runs as a turn of its own; earlier messages still show here.",
  },
  "ja-JP": {
    title: "コンテキスト使用量",
    unknown: "このコンピューターからコンテキストウィンドウの使用量が提供されていません",
    close: "閉じる",
    capacityShort: "上限 {total}",
    windowTitle: "コンテキストウィンドウ",
    capacity: "モデルのコンテキスト上限 {total} トークン",
    usedRemaining: "{used}% 使用（残り {remaining}%）",
    tokenUsage: "{used} / {total} トークン使用",
    tokenUsageOnly: "{used} トークン使用",
    stale: "更新待ち",
    unavailable: "利用不可",
    awaitingCliReport: "使用量データなし",
    lastReading: "前回の測定値",
    compacting: "コンテキストを圧縮中",
    compactingDetail:
      "コンテキストを圧縮しています。使用量の更新を待っています。送信と実行設定の変更は現在利用できません。",
    pendingDetail: "このターンのコンテキスト使用量はまだ報告されていません。",
    permission: "このブラウザーにはコンテキスト使用量の閲覧権限がありません。",
    offline: "接続が切れました。",
    window: "現在のモデルのコンテキストウィンドウは報告されていません。",
    invalid: "使用量の報告が不完全なため、割合を計算できません。",
    unsupported: "この Agent はコンテキスト使用量 API を提供していません。",
    compactAction: "コンテキストを圧縮",
    compactDetail:
      "Claude Code がこれまでの会話を要約し、以降のターンのためにコンテキストを空けます。以前のメッセージは引き続きここに表示されます。",
    compactAfterTurn: "現在のターンが終わると圧縮できます。",
    compactDetailCodex:
      "Codex がこれまでの会話を要約し、以降のターンのためにコンテキストを空けます。圧縮は独立したターンとして実行され、以前のメッセージは引き続きここに表示されます。",
  },
} satisfies Record<Locale, Record<string, string>>;

export function contextUsageReason(
  locale: Locale,
  reason?: string,
  surface: SessionSurface = "desktop",
) {
  const copy = contextUsageCopyForSurface(locale, surface);
  if (reason === "permission_denied" || reason === "permission-denied") return copy.permission;
  if (reason === "offline" || reason === "disconnected") return copy.offline;
  if (reason === "compacting" || reason === "context-compacting") return copy.compactingDetail;
  if (reason === "usage-not-reported" || reason === "not-reported") return copy.pendingDetail;
  if (
    reason === "context-window-unavailable" ||
    reason === "model-context-window-unavailable" ||
    reason === "usage-model-window-unavailable"
  )
    return copy.window;
  if (reason === "usage-after-compaction-unconfirmed") return copy.stale;
  if (reason === "session-compacting") return copy.compactingDetail;
  if (reason === "invalid-token-usage" || reason === "invalid-usage") return copy.invalid;
  if (reason === "unsupported" || reason === "usage-unsupported") return copy.unsupported;
  return undefined;
}

export function contextUsageCopyForSurface(locale: Locale, surface: SessionSurface = "desktop") {
  return surfaceCopy(contextUsageCopy[locale], surface, locale);
}
