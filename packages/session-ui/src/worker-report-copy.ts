import type { WorkerReportPart } from "@agentkib/web-client";

export type WorkerReportLocale = "zh-CN" | "zh-Hant" | "en-US" | "ja-JP";

export function normalizeWorkerReportLocale(locale: string): WorkerReportLocale {
  if (locale === "zh-Hant") return "zh-Hant";
  if (locale.startsWith("zh")) return "zh-CN";
  if (locale.startsWith("ja")) return "ja-JP";
  return "en-US";
}

export type WorkerReportCopy = {
  regionSingle: (name: string) => string;
  regionGroup: (count: number) => string;
  groupTitle: (count: number) => string;
  countRequiresUser: (count: number) => string;
  countFailed: (count: number) => string;
  countCompleted: (count: number) => string;
  countOther: (count: number) => string;
  expandAll: string;
  collapseAll: string;
  expandReply: string;
  collapseReply: string;
  replyLines: (lines: number) => string;
  replyTruncated: string;
  noReply: string;
  openSession: string;
  handleNow: string;
  verifyNow: string;
  omittedDetails: string;
  questionPreview: string;
  fileChanges: string;
  commandPreview: string;
  requestDetails: string;
  durationPrefix: (duration: string) => string;
  badges: {
    completed: string;
    ended: string;
    cancelled: string;
    failed: string;
    waitingApprovalUser: string;
    waitingApprovalDelegable: string;
    waitingQuestionUser: string;
    waitingQuestionDelegable: string;
    stalled: string;
    longCommand: string;
    restartUserOnly: string;
    restartRateLimit: string;
    restartAccepted: string;
    restartRefused: string;
    restartUnknown: string;
    restartUnconfirmedControl: string;
    offlineUser: string;
    offlineTemp: string;
    recovered: string;
    usageLimitUser: string;
    usageLimit: string;
    interruptedContinued: (byUpgrade: boolean) => string;
    interruptedNotContinued: (byUpgrade: boolean) => string;
    interruptedUnknown: string;
    deferredSent: string;
    deferredRefused: string;
    userIntervention: string;
  };
  descriptions: {
    waitingApprovalUser: string;
    waitingApprovalDelegable: string;
    waitingQuestionUser: string;
    waitingQuestionDelegable: string;
    stalled: (duration?: string) => string;
    longCommand: (duration?: string) => string;
    restartUserOnly: string;
    restartRateLimit: (retryAt?: string) => string;
    restartAccepted: string;
    restartRefused: (reason?: string) => string;
    restartUnknown: string;
    restartUnconfirmedControl: string;
    offlineUser: (duration?: string, reason?: string) => string;
    offlineTemp: (duration?: string, reason?: string) => string;
    recovered: string;
    usageLimitAuto: (resetAt?: string, continueAt?: string) => string;
    usageLimitUser: (resetAt?: string, reason?: string) => string;
    usageLimitNoSchedule: (resetAt?: string) => string;
    interruptedContinued: (byUpgrade: boolean) => string;
    interruptedNotContinued: (byUpgrade: boolean) => string;
    interruptedUnknown: (byUpgrade: boolean) => string;
    deferredSent: (intervening: boolean) => string;
    deferredRefused: (reason?: string) => string;
    userInterventionSend: string;
    userInterventionStop: string;
    userInterventionGeneric: string;
  };
  reasons: Record<string, string>;
};

const copies: Record<WorkerReportLocale, WorkerReportCopy> = {
  "zh-CN": {
    regionSingle: (name) => `Worker 汇报：${name}`,
    regionGroup: (count) => `收到 ${count} 条 Worker 汇报`,
    groupTitle: (count) => `收到 ${count} 条 Worker 汇报`,
    countRequiresUser: (count) => `${count} 条需你处理`,
    countFailed: (count) => `${count} 条失败`,
    countCompleted: (count) => `${count} 条完成`,
    countOther: (count) => `${count} 条状态`,
    expandAll: "全部展开",
    collapseAll: "全部收起",
    expandReply: "展开全部",
    collapseReply: "收起",
    replyLines: (lines) => `共 ${lines} 行`,
    replyTruncated: "正文已按长度上限截断",
    noReply: "未记录回复",
    openSession: "查看会话",
    handleNow: "前往处理",
    verifyNow: "前往核对",
    omittedDetails: "部分长正文已按大小上限省略，可点击单条「查看会话」查看全文。",
    questionPreview: "问题预览",
    fileChanges: "涉及文件改动",
    commandPreview: "请求执行命令",
    requestDetails: "请求内容",
    durationPrefix: (duration) => `用时 ${duration}`,
    badges: {
      completed: "已完成",
      ended: "已结束",
      cancelled: "已取消",
      failed: "执行失败",
      waitingApprovalUser: "需你处理 · 待审批",
      waitingApprovalDelegable: "等待审批 · 项目 Agent 可代批",
      waitingQuestionUser: "需你处理 · 待回答",
      waitingQuestionDelegable: "等待回答 · 项目 Agent 可代答",
      stalled: "可能卡住",
      longCommand: "命令耗时较长",
      restartUserOnly: "需你处理 · 重连/重启",
      restartRateLimit: "需你处理 · 重启达上限",
      restartAccepted: "重启已受理",
      restartRefused: "重启被拒绝",
      restartUnknown: "需你核对 · 重启结果不明",
      restartUnconfirmedControl: "需你核对 · 存在未确认操作",
      offlineUser: "需你处理 · 已离线",
      offlineTemp: "暂时离线",
      recovered: "连接已恢复",
      usageLimitUser: "需你处理 · 使用上限",
      usageLimit: "达到使用上限",
      interruptedContinued: (byUpgrade) =>
        byUpgrade ? "升级中断 · 已自动续跑" : "退出中断 · 已自动续跑",
      interruptedNotContinued: (byUpgrade) =>
        byUpgrade ? "升级中断 · 未续跑" : "退出中断 · 未续跑",
      interruptedUnknown: "需你核对 · 续跑状态不明",
      deferredSent: "延迟消息已送达",
      deferredRefused: "延迟发送被拒",
      userIntervention: "你已直接介入",
    },
    descriptions: {
      waitingApprovalUser: "项目 Agent 未获代批授权，处理后本轮将继续执行。",
      waitingApprovalDelegable: "项目 Agent 可代决定，也可由你直接审批（先答复的生效）。",
      waitingQuestionUser: "项目 Agent 未获代答授权，回答后本轮将继续执行。",
      waitingQuestionDelegable: "项目 Agent 可代答，也可由你直接回答（先答复的生效）。",
      stalled: (duration) =>
        duration ? `已 ${duration} 未观察到模型或命令进展。` : "一段时间内未观察到模型或命令进展。",
      longCommand: (duration) =>
        duration ? `当前命令已持续运行至少 ${duration}。` : "当前命令持续运行时间较长。",
      restartUserOnly: "该会话需要你手动重连或重启后再继续。",
      restartRateLimit: (retryAt) =>
        retryAt
          ? `近 1 小时已达到 3 次重启上限，需手动确认后继续（最早自动重试：${retryAt}）。`
          : "近 1 小时已达到 3 次重启上限，需手动确认后继续。",
      restartAccepted: "重启请求已受理，发送新任务前建议先核对会话状态。",
      restartRefused: (reason) => (reason ? `重启请求被拒绝：${reason}。` : "重启请求被拒绝。"),
      restartUnknown: "重启结果尚未确认（不会自动重试），请先核对会话状态。",
      restartUnconfirmedControl: "存在结果未确认的控制操作（不会自动重发），请先核对会话状态。",
      offlineUser: (duration, reason) =>
        [
          duration ? `已离线 ${duration}` : "当前已离线",
          reason ? `（${reason}）` : "",
          "，需要你重新连接或恢复访问。",
        ].join(""),
      offlineTemp: (duration, reason) =>
        [duration ? `暂时离线 ${duration}` : "暂时离线", reason ? `（${reason}）` : "", "。"].join(
          "",
        ),
      recovered: "连接已恢复正常。",
      usageLimitAuto: (resetAt, continueAt) =>
        [
          resetAt ? `额度将于 ${resetAt} 重置` : "已达到使用上限",
          continueAt ? `，预计 ${continueAt} 自动继续。` : "。",
        ].join(""),
      usageLimitUser: (resetAt, reason) =>
        [
          resetAt ? `额度将于 ${resetAt} 重置` : "已达到使用上限且重置时间未知",
          reason ? `（${reason}）` : "",
          "，需要你处理后继续。",
        ].join(""),
      usageLimitNoSchedule: (resetAt) =>
        resetAt
          ? `额度将于 ${resetAt} 重置，当前暂无自动续跑时间。`
          : "已达到使用上限，当前暂无自动续跑时间。",
      interruptedContinued: (byUpgrade) =>
        byUpgrade
          ? "因 AgentKib 升级中断了该轮次，已在同一会话中自动续跑。"
          : "因 AgentKib 退出中断了该轮次，已在同一会话中自动续跑。",
      interruptedNotContinued: (byUpgrade) =>
        byUpgrade
          ? "因 AgentKib 升级中断了该轮次，尚未自动续跑。"
          : "因 AgentKib 退出中断了该轮次，尚未自动续跑。",
      interruptedUnknown: (byUpgrade) =>
        byUpgrade
          ? "因 AgentKib 升级中断，未能确认是否已自动续跑（不会自动重发），请先核对记录。"
          : "因 AgentKib 退出中断，未能确认是否已自动续跑（不会自动重发），请先核对记录。",
      deferredSent: (intervening) =>
        intervening
          ? "ChatGPT 释放会话后已送达待发消息；等待期间外部产生了新的轮次。"
          : "ChatGPT 释放会话后已送达待发消息。",
      deferredRefused: (reason) =>
        reason
          ? `等待 ChatGPT 释放的延迟消息被拒绝（${reason}）。`
          : "等待 ChatGPT 释放的延迟消息被拒绝。",
      userInterventionSend: "你直接向该 Worker 发送了消息。",
      userInterventionStop: "你直接停止了该 Worker 的当前轮次。",
      userInterventionGeneric: "你直接操作了该 Worker 会话。",
    },
    reasons: {
      disconnected: "连接已断开",
      "claude-bridge-disconnected": "终端桥接已断开",
      "worker-not-running": "Worker 当前未运行",
      "session-unavailable": "会话暂不可用",
      "reset-unknown": "重置时间未知",
      "control-outcome-unconfirmed": "上次控制结果未确认",
      "worker-restart-user-only": "仅支持手动重连或重启",
      "worker-restart-rate-limit": "已达重启频率上限",
      "worker-restart-outcome-unknown": "重启结果未确认",
    },
  },
  "zh-Hant": {
    regionSingle: (name) => `Worker 回報：${name}`,
    regionGroup: (count) => `收到 ${count} 則 Worker 回報`,
    groupTitle: (count) => `收到 ${count} 則 Worker 回報`,
    countRequiresUser: (count) => `${count} 則需你處理`,
    countFailed: (count) => `${count} 則失敗`,
    countCompleted: (count) => `${count} 則完成`,
    countOther: (count) => `${count} 則狀態`,
    expandAll: "全部展開",
    collapseAll: "全部收起",
    expandReply: "展開全部",
    collapseReply: "收起",
    replyLines: (lines) => `共 ${lines} 行`,
    replyTruncated: "內容已按長度上限截斷",
    noReply: "未記錄回覆",
    openSession: "檢視會話",
    handleNow: "前往處理",
    verifyNow: "前往核對",
    omittedDetails: "部分長內容已按大小上限省略，可點擊單筆「檢視會話」查看全文。",
    questionPreview: "問題預覽",
    fileChanges: "涉及檔案變更",
    commandPreview: "請求執行命令",
    requestDetails: "請求內容",
    durationPrefix: (duration) => `耗時 ${duration}`,
    badges: {
      completed: "已完成",
      ended: "已結束",
      cancelled: "已取消",
      failed: "執行失敗",
      waitingApprovalUser: "需你處理 · 待審批",
      waitingApprovalDelegable: "等待審批 · 專案 Agent 可代批",
      waitingQuestionUser: "需你處理 · 待回答",
      waitingQuestionDelegable: "等待回答 · 專案 Agent 可代答",
      stalled: "可能卡住",
      longCommand: "命令耗時較長",
      restartUserOnly: "需你處理 · 重連/重啟",
      restartRateLimit: "需你處理 · 重啟達上限",
      restartAccepted: "重啟已受理",
      restartRefused: "重啟被拒絕",
      restartUnknown: "需你核對 · 重啟結果不明",
      restartUnconfirmedControl: "需你核對 · 存在未確認操作",
      offlineUser: "需你處理 · 已離線",
      offlineTemp: "暫時離線",
      recovered: "連線已恢復",
      usageLimitUser: "需你處理 · 使用上限",
      usageLimit: "達到使用上限",
      interruptedContinued: (byUpgrade) =>
        byUpgrade ? "升級中斷 · 已自動續跑" : "結束中斷 · 已自動續跑",
      interruptedNotContinued: (byUpgrade) =>
        byUpgrade ? "升級中斷 · 未續跑" : "結束中斷 · 未續跑",
      interruptedUnknown: "需你核對 · 續跑狀態不明",
      deferredSent: "延遲訊息已送達",
      deferredRefused: "延遲傳送被拒",
      userIntervention: "你已直接介入",
    },
    descriptions: {
      waitingApprovalUser: "專案 Agent 未獲代批授權，處理後本輪將繼續執行。",
      waitingApprovalDelegable: "專案 Agent 可代決定，也可由你直接審批（先回覆者生效）。",
      waitingQuestionUser: "專案 Agent 未獲代答授權，回答後本輪將繼續執行。",
      waitingQuestionDelegable: "專案 Agent 可代答，也可由你直接回答（先回覆者生效）。",
      stalled: (duration) =>
        duration ? `已 ${duration} 未觀察到模型或命令進展。` : "一段時間內未觀察到模型或命令進展。",
      longCommand: (duration) =>
        duration ? `目前命令已持續執行至少 ${duration}。` : "目前命令持續執行時間較長。",
      restartUserOnly: "此會話需要你手動重連或重啟後再繼續。",
      restartRateLimit: (retryAt) =>
        retryAt
          ? `近 1 小時已達到 3 次重啟上限，需手動確認後繼續（最早自動重試：${retryAt}）。`
          : "近 1 小時已達到 3 次重啟上限，需手動確認後繼續。",
      restartAccepted: "重啟請求已受理，傳送新任務前建議先核對會話狀態。",
      restartRefused: (reason) => (reason ? `重啟請求被拒絕：${reason}。` : "重啟請求被拒絕。"),
      restartUnknown: "重啟結果尚未確認（不會自動重試），請先核對會話狀態。",
      restartUnconfirmedControl: "存在結果未確認的控制操作（不會自動重傳），請先核對會話狀態。",
      offlineUser: (duration, reason) =>
        [
          duration ? `已離線 ${duration}` : "目前已離線",
          reason ? `（${reason}）` : "",
          "，需要你重新連線或恢復存取。",
        ].join(""),
      offlineTemp: (duration, reason) =>
        [duration ? `暫時離線 ${duration}` : "暫時離線", reason ? `（${reason}）` : "", "。"].join(
          "",
        ),
      recovered: "連線已恢復正常。",
      usageLimitAuto: (resetAt, continueAt) =>
        [
          resetAt ? `額度將於 ${resetAt} 重設` : "已達到使用上限",
          continueAt ? `，預計 ${continueAt} 自動繼續。` : "。",
        ].join(""),
      usageLimitUser: (resetAt, reason) =>
        [
          resetAt ? `額度將於 ${resetAt} 重設` : "已達到使用上限且重設時間未知",
          reason ? `（${reason}）` : "",
          "，需要你處理後繼續。",
        ].join(""),
      usageLimitNoSchedule: (resetAt) =>
        resetAt
          ? `額度將於 ${resetAt} 重設，目前暫無自動續跑時間。`
          : "已達到使用上限，目前暫無自動續跑時間。",
      interruptedContinued: (byUpgrade) =>
        byUpgrade
          ? "因 AgentKib 升級中斷了該輪次，已在同一會話中自動續跑。"
          : "因 AgentKib 結束中斷了該輪次，已在同一會話中自動續跑。",
      interruptedNotContinued: (byUpgrade) =>
        byUpgrade
          ? "因 AgentKib 升級中斷了該輪次，尚未自動續跑。"
          : "因 AgentKib 結束中斷了該輪次，尚未自動續跑。",
      interruptedUnknown: (byUpgrade) =>
        byUpgrade
          ? "因 AgentKib 升級中斷，未能確認是否已自動續跑（不會自動重傳），請先核對記錄。"
          : "因 AgentKib 結束中斷，未能確認是否已自動續跑（不會自動重傳），請先核對記錄。",
      deferredSent: (intervening) =>
        intervening
          ? "ChatGPT 釋放會話後已送達待傳訊息；等待期間外部產生了新的輪次。"
          : "ChatGPT 釋放會話後已送達待傳訊息。",
      deferredRefused: (reason) =>
        reason
          ? `等待 ChatGPT 釋放的延遲訊息被拒絕（${reason}）。`
          : "等待 ChatGPT 釋放的延遲訊息被拒絕。",
      userInterventionSend: "你直接向該 Worker 傳送了訊息。",
      userInterventionStop: "你直接停止了該 Worker 的目前輪次。",
      userInterventionGeneric: "你直接操作了該 Worker 會話。",
    },
    reasons: {
      disconnected: "連線已中斷",
      "claude-bridge-disconnected": "終端橋接已中斷",
      "worker-not-running": "Worker 目前未執行",
      "session-unavailable": "會話暫不可用",
      "reset-unknown": "重設時間未知",
      "control-outcome-unconfirmed": "上次控制結果未確認",
      "worker-restart-user-only": "僅支援手動重連或重啟",
      "worker-restart-rate-limit": "已達重啟頻率上限",
      "worker-restart-outcome-unknown": "重啟結果未確認",
    },
  },
  "en-US": {
    regionSingle: (name) => `Worker report: ${name}`,
    regionGroup: (count) => `${count} Worker reports`,
    groupTitle: (count) => `${count} Worker reports`,
    countRequiresUser: (count) => `${count} needs you`,
    countFailed: (count) => `${count} failed`,
    countCompleted: (count) => `${count} completed`,
    countOther: (count) => `${count} updates`,
    expandAll: "Expand all",
    collapseAll: "Collapse all",
    expandReply: "Show full reply",
    collapseReply: "Collapse",
    replyLines: (lines) => `${lines} lines`,
    replyTruncated: "Reply truncated at size limit",
    noReply: "No reply recorded",
    openSession: "Open session",
    handleNow: "Handle",
    verifyNow: "Verify",
    omittedDetails:
      "Some long details were omitted due to size limits. Open a Worker session for the full reply.",
    questionPreview: "Question",
    fileChanges: "File changes",
    commandPreview: "Command",
    requestDetails: "Request",
    durationPrefix: (duration) => `in ${duration}`,
    badges: {
      completed: "Completed",
      ended: "Ended",
      cancelled: "Cancelled",
      failed: "Failed",
      waitingApprovalUser: "Needs you · Approval",
      waitingApprovalDelegable: "Approval · Project Agent may decide",
      waitingQuestionUser: "Needs you · Question",
      waitingQuestionDelegable: "Question · Project Agent may answer",
      stalled: "May be stalled",
      longCommand: "Long-running command",
      restartUserOnly: "Needs you · Reconnect",
      restartRateLimit: "Needs you · Restart limit",
      restartAccepted: "Restart accepted",
      restartRefused: "Restart refused",
      restartUnknown: "Verify · Restart unconfirmed",
      restartUnconfirmedControl: "Verify · Unconfirmed control",
      offlineUser: "Needs you · Offline",
      offlineTemp: "Temporarily offline",
      recovered: "Reconnected",
      usageLimitUser: "Needs you · Usage limit",
      usageLimit: "Usage limit",
      interruptedContinued: (byUpgrade) =>
        byUpgrade ? "Upgrade interrupted · Continued" : "Quit interrupted · Continued",
      interruptedNotContinued: (byUpgrade) =>
        byUpgrade ? "Upgrade interrupted · Stopped" : "Quit interrupted · Stopped",
      interruptedUnknown: "Verify · Continuation unknown",
      deferredSent: "Queued message sent",
      deferredRefused: "Queued send refused",
      userIntervention: "You intervened directly",
    },
    descriptions: {
      waitingApprovalUser:
        "The Project Agent is not authorized to approve this. The turn continues after you respond.",
      waitingApprovalDelegable:
        "The Project Agent or you can decide; the first answer takes effect.",
      waitingQuestionUser:
        "The Project Agent is not authorized to answer this. The turn continues after you reply.",
      waitingQuestionDelegable:
        "The Project Agent or you can answer; the first answer takes effect.",
      stalled: (duration) =>
        duration
          ? `No model or command progress observed for ${duration}.`
          : "No model or command progress observed recently.",
      longCommand: (duration) =>
        duration
          ? `Current command has been running for at least ${duration}.`
          : "Current command has been running for a long time.",
      restartUserOnly: "This session needs manual reconnection or restart before continuing.",
      restartRateLimit: (retryAt) =>
        retryAt
          ? `Reached 3 restart attempts in the last hour. Check the session manually (earliest retry: ${retryAt}).`
          : "Reached 3 restart attempts in the last hour. Check the session manually.",
      restartAccepted: "Restart was accepted. Check the Worker state before sending new work.",
      restartRefused: (reason) =>
        reason ? `Restart was refused (${reason}).` : "Restart was refused.",
      restartUnknown:
        "Restart outcome is unconfirmed and will not retry automatically. Check the session first.",
      restartUnconfirmedControl:
        "This Worker has an unconfirmed control outcome and will not resend automatically. Verify it first.",
      offlineUser: (duration, reason) =>
        [
          duration ? `Offline for ${duration}` : "Offline",
          reason ? ` (${reason})` : "",
          ". Reconnect or restore access to continue.",
        ].join(""),
      offlineTemp: (duration, reason) =>
        [
          duration ? `Temporarily offline for ${duration}` : "Temporarily offline",
          reason ? ` (${reason})` : "",
          ".",
        ].join(""),
      recovered: "Connection recovered.",
      usageLimitAuto: (resetAt, continueAt) =>
        [
          resetAt ? `Limit resets at ${resetAt}` : "Usage limit reached",
          continueAt ? `; scheduled to continue at ${continueAt}.` : ".",
        ].join(""),
      usageLimitUser: (resetAt, reason) =>
        [
          resetAt ? `Limit resets at ${resetAt}` : "Usage limit reached with unknown reset time",
          reason ? ` (${reason})` : "",
          ". Action required to continue.",
        ].join(""),
      usageLimitNoSchedule: (resetAt) =>
        resetAt
          ? `Limit resets at ${resetAt}. No automatic continuation time is scheduled.`
          : "Usage limit reached. No automatic continuation time is scheduled.",
      interruptedContinued: (byUpgrade) =>
        byUpgrade
          ? "Turn interrupted by an AgentKib upgrade. Continuation started in the same session."
          : "Turn interrupted when AgentKib quit. Continuation started in the same session.",
      interruptedNotContinued: (byUpgrade) =>
        byUpgrade
          ? "Turn interrupted by an AgentKib upgrade. No continuation was started."
          : "Turn interrupted when AgentKib quit. No continuation was started.",
      interruptedUnknown: (byUpgrade) =>
        byUpgrade
          ? "Turn interrupted by an AgentKib upgrade. Continuation could not be confirmed (will not resend automatically)."
          : "Turn interrupted when AgentKib quit. Continuation could not be confirmed (will not resend automatically).",
      deferredSent: (intervening) =>
        intervening
          ? "Sent the waiting message after ChatGPT released the session; external turns ran while waiting."
          : "Sent the waiting message after ChatGPT released the session.",
      deferredRefused: (reason) =>
        reason
          ? `The message waiting for ChatGPT was refused (${reason}).`
          : "The message waiting for ChatGPT was refused.",
      userInterventionSend: "You sent a message to this Worker directly.",
      userInterventionStop: "You stopped this Worker's turn directly.",
      userInterventionGeneric: "You interacted with this Worker directly.",
    },
    reasons: {
      disconnected: "disconnected",
      "claude-bridge-disconnected": "terminal bridge disconnected",
      "worker-not-running": "worker not running",
      "session-unavailable": "session unavailable",
      "reset-unknown": "reset time unknown",
      "control-outcome-unconfirmed": "unconfirmed control outcome",
      "worker-restart-user-only": "manual restart required",
      "worker-restart-rate-limit": "restart rate limit reached",
      "worker-restart-outcome-unknown": "restart outcome unconfirmed",
    },
  },
  "ja-JP": {
    regionSingle: (name) => `ワーカー報告：${name}`,
    regionGroup: (count) => `${count} 件のワーカー報告`,
    groupTitle: (count) => `${count} 件のワーカー報告`,
    countRequiresUser: (count) => `${count} 件要対応`,
    countFailed: (count) => `${count} 件失敗`,
    countCompleted: (count) => `${count} 件完了`,
    countOther: (count) => `${count} 件通知`,
    expandAll: "すべて展開",
    collapseAll: "すべて折りたたむ",
    expandReply: "全文を表示",
    collapseReply: "折りたたむ",
    replyLines: (lines) => `全 ${lines} 行`,
    replyTruncated: "サイズ上限により末尾が省略されています",
    noReply: "応答記録なし",
    openSession: "会話を開く",
    handleNow: "対応する",
    verifyNow: "確認する",
    omittedDetails:
      "サイズ上限により一部詳細が省略されています。全文は各ワーカー会話で確認してください。",
    questionPreview: "質問プレビュー",
    fileChanges: "ファイル変更",
    commandPreview: "実行コマンド",
    requestDetails: "リクエスト内容",
    durationPrefix: (duration) => `所要 ${duration}`,
    badges: {
      completed: "完了",
      ended: "終了",
      cancelled: "キャンセル",
      failed: "失敗",
      waitingApprovalUser: "要対応 · 承認待ち",
      waitingApprovalDelegable: "承認待ち · プロジェクト Agent 判断可",
      waitingQuestionUser: "要対応 · 回答待ち",
      waitingQuestionDelegable: "回答待ち · プロジェクト Agent 回答可",
      stalled: "停止の可能性",
      longCommand: "長時間コマンド",
      restartUserOnly: "要対応 · 再接続/再起動",
      restartRateLimit: "要対応 · 再起動上限",
      restartAccepted: "再起動を受付",
      restartRefused: "再起動を拒否",
      restartUnknown: "要確認 · 再起動結果不明",
      restartUnconfirmedControl: "要確認 · 未確認の操作あり",
      offlineUser: "要対応 · オフライン",
      offlineTemp: "一時オフライン",
      recovered: "接続回復",
      usageLimitUser: "要対応 · 利用上限",
      usageLimit: "利用上限",
      interruptedContinued: (byUpgrade) =>
        byUpgrade ? "更新で中断 · 自動再開済み" : "終了で中断 · 自動再開済み",
      interruptedNotContinued: (byUpgrade) =>
        byUpgrade ? "更新で中断 · 未再開" : "終了で中断 · 未再開",
      interruptedUnknown: "要確認 · 再開状況不明",
      deferredSent: "保留メッセージを送信",
      deferredRefused: "保留送信を拒否",
      userIntervention: "直接操作しました",
    },
    descriptions: {
      waitingApprovalUser: "プロジェクト Agent に代理承認権限がありません。対応後に続行されます。",
      waitingApprovalDelegable: "プロジェクト Agent またはあなたが判断できます（先着有効）。",
      waitingQuestionUser: "プロジェクト Agent に代理回答権限がありません。回答後に続行されます。",
      waitingQuestionDelegable: "プロジェクト Agent またはあなたが回答できます（先着有効）。",
      stalled: (duration) =>
        duration
          ? `${duration} モデルやコマンドの進展が確認できていません。`
          : "モデルやコマンドの進展が確認できていません。",
      longCommand: (duration) =>
        duration
          ? `現在のコマンドは少なくとも ${duration} 実行中です。`
          : "現在のコマンドが長時間実行中です。",
      restartUserOnly: "続行するには手動での再接続または再起動が必要です。",
      restartRateLimit: (retryAt) =>
        retryAt
          ? `直近 1 時間で再起動上限（3 回）に達しました。手動で確認してください（次回可能目安：${retryAt}）。`
          : "直近 1 時間で再起動上限（3 回）に達しました。手動で確認してください。",
      restartAccepted: "再起動を受け付けました。次の指示前に状態を確認してください。",
      restartRefused: (reason) =>
        reason ? `再起動が拒否されました（${reason}）。` : "再起動が拒否されました。",
      restartUnknown: "再起動結果が未確認です（自動再試行はしません）。状態を確認してください。",
      restartUnconfirmedControl:
        "未確認の操作結果があります（自動再送はしません）。先に会話状態を確認してください。",
      offlineUser: (duration, reason) =>
        [
          duration ? `${duration} オフライン` : "オフライン",
          reason ? `（${reason}）` : "",
          "。再接続またはアクセスの復旧が必要です。",
        ].join(""),
      offlineTemp: (duration, reason) =>
        [
          duration ? `${duration} 一時オフライン` : "一時オフライン",
          reason ? `（${reason}）` : "",
          "。",
        ].join(""),
      recovered: "接続が回復しました。",
      usageLimitAuto: (resetAt, continueAt) =>
        [
          resetAt ? `${resetAt} にリセット予定` : "利用上限に達しました",
          continueAt ? `（${continueAt} に自動再開予定）。` : "。",
        ].join(""),
      usageLimitUser: (resetAt, reason) =>
        [
          resetAt ? `${resetAt} にリセット予定` : "利用上限に達しました（リセット時刻不明）",
          reason ? `（${reason}）` : "",
          "。続行には対応が必要です。",
        ].join(""),
      usageLimitNoSchedule: (resetAt) =>
        resetAt
          ? `${resetAt} にリセット予定。自動再開時刻は未定です。`
          : "利用上限に達しました。自動再開時刻は未定です。",
      interruptedContinued: (byUpgrade) =>
        byUpgrade
          ? "AgentKib の更新で中断されましたが、同じセッションで自動再開しました。"
          : "AgentKib の終了で中断されましたが、同じセッションで自動再開しました。",
      interruptedNotContinued: (byUpgrade) =>
        byUpgrade
          ? "AgentKib の更新で中断されました。自動再開は行われていません。"
          : "AgentKib の終了で中断されました。自動再開は行われていません。",
      interruptedUnknown: (byUpgrade) =>
        byUpgrade
          ? "AgentKib の更新で中断され、再開を確認できませんでした（自動再送しません）。履歴を確認してください。"
          : "AgentKib の終了で中断され、再開を確認できませんでした（自動再送しません）。履歴を確認してください。",
      deferredSent: (intervening) =>
        intervening
          ? "ChatGPT の解放後に保留メッセージを送信しました（待機中に外部ターンがありました）。"
          : "ChatGPT の解放後に保留メッセージを送信しました。",
      deferredRefused: (reason) =>
        reason
          ? `ChatGPT 解放待ちのメッセージが拒否されました（${reason}）。`
          : "ChatGPT 解放待ちのメッセージが拒否されました。",
      userInterventionSend: "このワーカーへ直接メッセージを送信しました。",
      userInterventionStop: "このワーカーのターンを直接停止しました。",
      userInterventionGeneric: "このワーカーを直接操作しました。",
    },
    reasons: {
      disconnected: "切断されました",
      "claude-bridge-disconnected": "ターミナル接続が切断されました",
      "worker-not-running": "ワーカーは実行中ではありません",
      "session-unavailable": "セッションは現在利用できません",
      "reset-unknown": "リセット時刻不明",
      "control-outcome-unconfirmed": "前回の操作結果が未確認です",
      "worker-restart-user-only": "手動での再接続/再起動が必要",
      "worker-restart-rate-limit": "再起動回数上限に到達",
      "worker-restart-outcome-unknown": "再起動結果が未確認",
    },
  },
};

export function workerReportCopy(locale: string): WorkerReportCopy {
  return copies[normalizeWorkerReportLocale(locale)];
}

export function formatWorkerReportDuration(
  ms: number | undefined,
  locale: string,
): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const loc = normalizeWorkerReportLocale(locale);
  if (loc === "zh-CN" || loc === "zh-Hant") {
    const hUnit = loc === "zh-Hant" ? "小時" : "小时";
    if (hours > 0) return minutes > 0 ? `${hours} ${hUnit} ${minutes} 分` : `${hours} ${hUnit}`;
    if (minutes > 0) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
    return `${seconds} 秒`;
  }
  if (loc === "ja-JP") {
    if (hours > 0) return minutes > 0 ? `${hours}時間${minutes}分` : `${hours}時間`;
    if (minutes > 0) return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分`;
    return `${seconds}秒`;
  }
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

export function formatWorkerReportClock(
  iso: string | undefined,
  locale: string,
): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  try {
    return new Intl.DateTimeFormat(normalizeWorkerReportLocale(locale), {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return undefined;
  }
}

export function formatWorkerReportReason(
  reasonCode: string | undefined,
  locale: string,
): string | undefined {
  if (!reasonCode) return undefined;
  const copy = workerReportCopy(locale);
  return copy.reasons[reasonCode] ?? reasonCode;
}

export type WorkerReportTone = "success" | "danger" | "warning" | "info" | "neutral";

export function workerReportBadgeAndTone(
  part: WorkerReportPart,
  locale: string,
): { badge: string; tone: WorkerReportTone; actionKind: "handle" | "verify" | "open" } {
  const copy = workerReportCopy(locale);
  const byUpgrade = part.meta?.interruptedBy === "upgrade";
  switch (part.kind) {
    case "turn-ended":
      if (part.outcome === "completed")
        return { badge: copy.badges.completed, tone: "success", actionKind: "open" };
      if (part.outcome === "failed")
        return { badge: copy.badges.failed, tone: "danger", actionKind: "open" };
      if (part.outcome === "cancelled")
        return { badge: copy.badges.cancelled, tone: "neutral", actionKind: "open" };
      return { badge: copy.badges.ended, tone: "neutral", actionKind: "open" };
    case "waiting-approval":
      return part.requiresUser
        ? { badge: copy.badges.waitingApprovalUser, tone: "warning", actionKind: "handle" }
        : { badge: copy.badges.waitingApprovalDelegable, tone: "info", actionKind: "open" };
    case "waiting-question":
      return part.requiresUser
        ? { badge: copy.badges.waitingQuestionUser, tone: "warning", actionKind: "handle" }
        : { badge: copy.badges.waitingQuestionDelegable, tone: "info", actionKind: "open" };
    case "stalled":
      return { badge: copy.badges.stalled, tone: "warning", actionKind: "open" };
    case "long-command":
      return { badge: copy.badges.longCommand, tone: "warning", actionKind: "open" };
    case "restart-user-only":
      return { badge: copy.badges.restartUserOnly, tone: "danger", actionKind: "handle" };
    case "restart-rate-limit":
      return { badge: copy.badges.restartRateLimit, tone: "danger", actionKind: "handle" };
    case "restart-result":
      if (part.outcome === "accepted")
        return { badge: copy.badges.restartAccepted, tone: "success", actionKind: "open" };
      if (part.outcome === "unknown")
        return { badge: copy.badges.restartUnknown, tone: "warning", actionKind: "verify" };
      if (part.outcome === "unconfirmed-control")
        return {
          badge: copy.badges.restartUnconfirmedControl,
          tone: "warning",
          actionKind: "verify",
        };
      return { badge: copy.badges.restartRefused, tone: "danger", actionKind: "open" };
    case "offline":
      return part.requiresUser
        ? { badge: copy.badges.offlineUser, tone: "danger", actionKind: "handle" }
        : { badge: copy.badges.offlineTemp, tone: "warning", actionKind: "open" };
    case "recovered":
      return { badge: copy.badges.recovered, tone: "success", actionKind: "open" };
    case "usage-limit":
      return part.requiresUser
        ? { badge: copy.badges.usageLimitUser, tone: "danger", actionKind: "handle" }
        : { badge: copy.badges.usageLimit, tone: "warning", actionKind: "open" };
    case "interrupted-by-quit":
      if (part.outcome === "continued")
        return {
          badge: copy.badges.interruptedContinued(byUpgrade),
          tone: "success",
          actionKind: "open",
        };
      if (part.outcome === "unknown")
        return { badge: copy.badges.interruptedUnknown, tone: "warning", actionKind: "verify" };
      return {
        badge: copy.badges.interruptedNotContinued(byUpgrade),
        tone: "warning",
        actionKind: "open",
      };
    case "deferred-send":
      return part.outcome === "refused"
        ? { badge: copy.badges.deferredRefused, tone: "danger", actionKind: "open" }
        : { badge: copy.badges.deferredSent, tone: "info", actionKind: "open" };
    case "user-intervention":
      return { badge: copy.badges.userIntervention, tone: "neutral", actionKind: "open" };
  }
}

export function workerReportSummaryText(
  part: WorkerReportPart,
  locale: string,
): string | undefined {
  const copy = workerReportCopy(locale);
  const duration = formatWorkerReportDuration(part.durationMs, locale);
  const reason = formatWorkerReportReason(part.reasonCode, locale);
  const byUpgrade = part.meta?.interruptedBy === "upgrade";
  switch (part.kind) {
    case "turn-ended":
      return part.reply?.trim() ? undefined : copy.noReply;
    case "waiting-approval":
      return part.requiresUser
        ? copy.descriptions.waitingApprovalUser
        : copy.descriptions.waitingApprovalDelegable;
    case "waiting-question":
      return part.requiresUser
        ? copy.descriptions.waitingQuestionUser
        : copy.descriptions.waitingQuestionDelegable;
    case "stalled":
      return copy.descriptions.stalled(duration);
    case "long-command":
      return copy.descriptions.longCommand(duration);
    case "restart-user-only":
      return copy.descriptions.restartUserOnly;
    case "restart-rate-limit": {
      const retryAt =
        typeof part.meta?.retryAt === "string"
          ? formatWorkerReportClock(part.meta.retryAt, locale)
          : undefined;
      return copy.descriptions.restartRateLimit(retryAt);
    }
    case "restart-result":
      if (part.outcome === "accepted") return copy.descriptions.restartAccepted;
      if (part.outcome === "unknown") return copy.descriptions.restartUnknown;
      if (part.outcome === "unconfirmed-control")
        return copy.descriptions.restartUnconfirmedControl;
      return copy.descriptions.restartRefused(reason);
    case "offline":
      return part.requiresUser
        ? copy.descriptions.offlineUser(duration, reason)
        : copy.descriptions.offlineTemp(duration, reason);
    case "recovered":
      return copy.descriptions.recovered;
    case "usage-limit": {
      const resetAt = formatWorkerReportClock(part.resetAt, locale);
      const continueAt = formatWorkerReportClock(part.autoContinueAt, locale);
      if (part.requiresUser) return copy.descriptions.usageLimitUser(resetAt, reason);
      if (continueAt) return copy.descriptions.usageLimitAuto(resetAt, continueAt);
      return copy.descriptions.usageLimitNoSchedule(resetAt);
    }
    case "interrupted-by-quit":
      if (part.outcome === "continued") return copy.descriptions.interruptedContinued(byUpgrade);
      if (part.outcome === "unknown") return copy.descriptions.interruptedUnknown(byUpgrade);
      return copy.descriptions.interruptedNotContinued(byUpgrade);
    case "deferred-send":
      if (part.outcome === "refused") return copy.descriptions.deferredRefused(reason);
      return copy.descriptions.deferredSent(part.meta?.interveningExternalTurns === true);
    case "user-intervention":
      if (part.meta?.operation === "send") return copy.descriptions.userInterventionSend;
      if (part.meta?.operation === "stop") return copy.descriptions.userInterventionStop;
      return copy.descriptions.userInterventionGeneric;
  }
}
