import type { SupportedLocale as Locale } from "@/core/types";
import { surfaceCopy, type SessionSurface } from "./session-surface-copy";

export const contextUsageCopy = {
  "zh-CN": {
    pending: "等待用量",
    stale: "待更新",
    unavailable: "暂不可用",
    awaitingCliReport: "暂无数据",
    awaitingCliReportDetail:
      "尚未取得 Claude Code 的上下文用量报告。继续会话后，以 CLI 实际报告为准；此状态不表示额度耗尽。",
    compacting: "正在压缩上下文",
    compactingDetail: "上下文正在压缩，用量待更新，暂时无法发送或修改执行设置。",
    pendingDetail: "这台电脑尚未上报本轮上下文用量。",
    staleDetail: "这是上次上报的用量，等待新的原生报告。",
    unavailableDetail: "当前原生接口未提供可用的上下文窗口用量。",
    permission: "当前浏览器未获上下文用量查看授权。",
    offline: "连接已断开，显示上次上报的用量。",
    window: "原生接口未上报当前模型的上下文窗口。",
    invalid: "原生用量报告不完整，暂时无法计算比例。",
    unsupported: "当前 Agent 未提供上下文用量接口。",
    reported: "上次上报",
    recentNativeReport: "最近原生报告",
    compactAction: "压缩上下文",
    compactDetail:
      "让 Claude Code 总结此前的对话，为后续轮次腾出上下文；此前的消息仍会显示在这里。",
    compactAfterTurn: "当前轮次结束后可以压缩。",
  },
  "zh-TW": {
    pending: "等待用量",
    stale: "待更新",
    unavailable: "暫不可用",
    awaitingCliReport: "暫無資料",
    awaitingCliReportDetail:
      "尚未取得 Claude Code 的上下文用量報告。繼續對話後，以 CLI 實際報告為準；此狀態不表示額度耗盡。",
    compacting: "正在壓縮上下文",
    compactingDetail: "上下文正在壓縮，用量待更新，暫時無法傳送或修改執行設定。",
    pendingDetail: "這台電腦尚未上報本回合上下文用量。",
    staleDetail: "這是上次上報的用量，等待新的原生報告。",
    unavailableDetail: "目前原生介面未提供可用的上下文視窗用量。",
    permission: "目前瀏覽器未獲上下文用量檢視授權。",
    offline: "連線已中斷，顯示上次上報的用量。",
    window: "原生介面未上報目前模型的上下文視窗。",
    invalid: "原生用量報告不完整，暫時無法計算比例。",
    unsupported: "目前 Agent 未提供上下文用量介面。",
    reported: "上次上報",
    recentNativeReport: "最近原生報告",
    compactAction: "壓縮上下文",
    compactDetail:
      "讓 Claude Code 總結先前的對話，為後續回合騰出上下文；先前的訊息仍會顯示在這裡。",
    compactAfterTurn: "目前回合結束後可以壓縮。",
  },
  "en-US": {
    pending: "Awaiting usage",
    stale: "Awaiting update",
    unavailable: "Unavailable",
    awaitingCliReport: "No data yet",
    awaitingCliReportDetail:
      "Claude Code has not provided a context usage report. After continuing the session, usage will reflect the CLI's actual report. This does not mean your quota is exhausted.",
    compacting: "Compacting context",
    compactingDetail:
      "Context is compacting. Usage awaits an update; sending and changing execution settings are unavailable.",
    pendingDetail: "The computer has not reported context usage for this turn yet.",
    staleDetail: "This is the last reported usage. Awaiting a new native report.",
    unavailableDetail:
      "The native interface does not currently provide usable context-window usage.",
    permission: "This browser does not have permission to view context usage.",
    offline: "Disconnected. Showing the last reported usage.",
    window: "The native interface has not reported this model's context window.",
    invalid: "The native usage report is incomplete; its percentage cannot be calculated.",
    unsupported: "This Agent does not provide a context usage interface.",
    reported: "Last reported",
    recentNativeReport: "Latest native report",
    compactAction: "Compact context",
    compactDetail:
      "Claude Code summarizes the conversation so far to free up context for later turns. Earlier messages still show here.",
    compactAfterTurn: "You can compact once the current turn ends.",
  },
  "ja-JP": {
    pending: "使用量を待機中",
    stale: "更新待ち",
    unavailable: "利用不可",
    awaitingCliReport: "データなし",
    awaitingCliReportDetail:
      "Claude Code のコンテキスト使用量はまだ報告されていません。会話を続けた後、CLI の実際の報告を表示します。利用枠の上限に達したという意味ではありません。",
    compacting: "コンテキストを圧縮中",
    compactingDetail:
      "コンテキストを圧縮しています。使用量の更新を待っています。送信と実行設定の変更は現在利用できません。",
    pendingDetail: "このターンのコンテキスト使用量はまだ報告されていません。",
    staleDetail: "前回報告された使用量です。新しい報告を待っています。",
    unavailableDetail: "ネイティブ API は現在、利用可能なコンテキスト使用量を提供していません。",
    permission: "このブラウザーにはコンテキスト使用量の閲覧権限がありません。",
    offline: "接続が切れました。前回の使用量を表示しています。",
    window: "現在のモデルのコンテキストウィンドウは報告されていません。",
    invalid: "使用量の報告が不完全なため、割合を計算できません。",
    unsupported: "この Agent はコンテキスト使用量 API を提供していません。",
    reported: "前回の報告",
    recentNativeReport: "最新のネイティブ報告",
    compactAction: "コンテキストを圧縮",
    compactDetail:
      "Claude Code がこれまでの会話を要約し、以降のターンのためにコンテキストを空けます。以前のメッセージは引き続きここに表示されます。",
    compactAfterTurn: "現在のターンが終わると圧縮できます。",
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
  if (reason === "usage-after-compaction-unconfirmed") return copy.staleDetail;
  if (reason === "session-compacting") return copy.compactingDetail;
  if (reason === "invalid-token-usage" || reason === "invalid-usage") return copy.invalid;
  if (reason === "unsupported" || reason === "usage-unsupported") return copy.unsupported;
  return undefined;
}

export function contextUsageCopyForSurface(locale: Locale, surface: SessionSurface = "desktop") {
  return surfaceCopy(contextUsageCopy[locale], surface, locale);
}
