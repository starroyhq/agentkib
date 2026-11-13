import type { SupportedLocale as Locale } from "@/core/types";
import { surfaceCopy, type SessionSurface } from "./session-surface-copy";
import type { ClaudeHandoffBlockReason } from "./claude-handoff";

export type ManagedControlBlockReason =
  | ClaudeHandoffBlockReason
  | "processing"
  | "tool"
  | "confirmation"
  | "fingerprintLoading"
  | "fingerprintUnavailable";

export const managedControlCopy: Record<Locale, Record<ManagedControlBlockReason, string>> = {
  "en-US": {
    processing:
      "An operation is in progress. Wait for its result before handing over or releasing this session.",
    uncertain:
      "The previous outcome is still being verified. Wait for confirmation; do not repeat the handoff.",
    compacting:
      "Context is being compacted. Wait for it to finish, then refresh the session before handing over or releasing it.",
    tool: "The execution tool is unavailable. Check its installation and connection on this computer, then refresh the session.",
    confirmation:
      "Before handing over, stop the original client and complete the confirmation above.",
    fingerprintLoading:
      "Verifying Claude Code history before handoff. Wait for this check to finish.",
    fingerprintUnavailable:
      "Claude Code history could not be verified. Check the source on this computer, then reopen Session actions to retry. Handoff remains disabled.",
    session:
      "The selected session and its control state do not match. Refresh the session, then reopen Session actions.",
    capability:
      "This session is not currently eligible for handoff. Refresh it and check the Agent on this computer; continue in the original client if it remains unavailable.",
    ownership:
      "The session is not awaiting handoff. Refresh its execution status before trying again.",
    turn: "The original client has not reached an idle or released state. Finish or stop its current turn and background commands, then refresh the session.",
    approvals:
      "The original client has pending approvals. Resolve them there, then refresh the session before handing it over.",
    questions:
      "The original client has unanswered questions. Answer them there, then refresh the session before handing it over.",
    access: "Access is not approved. Reconnect and approve access in AgentKib on this computer.",
    protocol:
      "The connection protocol is incompatible. Update AgentKib on this computer and reconnect.",
    experimental:
      "Execution management is not enabled. Enable it in Web settings in AgentKib on this computer, then refresh.",
    management:
      "This device lacks management permission. Authorize it in Web settings in AgentKib on this computer, then reconnect.",
    send: "This access does not include permission to send. Check its permissions on the computer running AgentKib.",
    offline:
      "The computer is offline. Reconnect and wait for the session status to refresh before handing over.",
    synchronizing: "Control status is still syncing. Wait for synchronization before handing over.",
    sessionBusy: "A session operation is in progress. Wait for it to finish before handing over.",
  },
  "zh-CN": {
    processing: "正在处理操作。请等待结果，再交接或交还此会话。",
    uncertain: "正在核对上次操作结果。请等待确认，勿重复交接。",
    compacting: "正在压缩上下文。请等待完成并刷新会话，再交接或交还。",
    tool: "执行工具暂不可用。请在这台电脑检查安装和连接，再刷新会话。",
    confirmation: "交接前请停止原客户端，并完成上方确认。",
    fingerprintLoading: "正在核验 Claude Code 历史，核验完成后才能交接。请稍候。",
    fingerprintUnavailable:
      "无法核验 Claude Code 历史。请在这台电脑检查来源，再重新打开会话操作重试；核验前无法交接。",
    session: "所选会话与控制状态不一致。请刷新会话，再重新打开会话操作。",
    capability:
      "此会话目前不具备交接条件。请刷新并检查这台电脑上的 Agent；仍不可用时请在原客户端继续。",
    ownership: "此会话当前不处于等待交接状态。请刷新执行状态后重试。",
    turn: "原客户端尚未空闲或释放会话。请结束或停止当前轮次及后台命令，再刷新会话。",
    approvals: "原客户端还有待审批事项。请先在那里处理，再刷新会话后交接。",
    questions: "原客户端还有待回答的问题。请先在那里回答，再刷新会话后交接。",
    access: "访问尚未获批。请重新连接，并在这台电脑上的 AgentKib 批准访问。",
    protocol: "连接协议不兼容。请更新这台电脑上的 AgentKib 并重新连接。",
    experimental: "尚未启用执行管理。请在这台电脑上的 AgentKib 的 Web 设置中启用，再刷新。",
    management: "此设备没有管理权限。请在这台电脑上的 AgentKib 的 Web 设置中授权，再重新连接。",
    send: "当前访问没有发送权限。请在运行 AgentKib 的电脑上检查此访问的权限。",
    offline: "这台电脑已离线。请重新连接，等待会话状态刷新后再交接。",
    synchronizing: "正在同步控制状态。请等待同步完成后再交接。",
    sessionBusy: "会话操作进行中。请等待完成后再交接。",
  },
  "zh-Hant": {
    processing: "正在處理操作。請等待結果，再交接或交還此對話。",
    uncertain: "正在核對上次操作結果。請等待確認，勿重複交接。",
    compacting: "正在壓縮上下文。請等待完成並重新整理對話，再交接或交還。",
    tool: "執行工具暫不可用。請在這台電腦檢查安裝和連線，再重新整理對話。",
    confirmation: "交接前請停止原客戶端，並完成上方確認。",
    fingerprintLoading: "正在核驗 Claude Code 歷史，核驗完成後才能交接。請稍候。",
    fingerprintUnavailable:
      "無法核驗 Claude Code 歷史。請在這台電腦檢查來源，再重新開啟對話操作重試；核驗前無法交接。",
    session: "所選對話與控制狀態不一致。請重新整理對話，再重新開啟對話操作。",
    capability:
      "此對話目前不具備交接條件。請重新整理並檢查這台電腦上的 Agent；仍不可用時請在原客戶端繼續。",
    ownership: "此對話目前不處於等待交接狀態。請重新整理執行狀態後重試。",
    turn: "原客戶端尚未閒置或釋放對話。請結束或停止目前輪次及背景命令，再重新整理對話。",
    approvals: "原客戶端還有待審批事項。請先在該處處理，再重新整理對話後交接。",
    questions: "原客戶端還有待回答的問題。請先在該處回答，再重新整理對話後交接。",
    access: "存取尚未獲准。請重新連線，並在這台電腦上的 AgentKib 批准存取。",
    protocol: "連線協定不相容。請更新這台電腦上的 AgentKib 並重新連線。",
    experimental: "尚未啟用執行管理。請在這台電腦上的 AgentKib 的 Web 設定中啟用，再重新整理。",
    management: "此裝置沒有管理權限。請在這台電腦上的 AgentKib 的 Web 設定中授權，再重新連線。",
    send: "目前存取沒有傳送權限。請在執行 AgentKib 的電腦上檢查此存取的權限。",
    offline: "這台電腦已離線。請重新連線，等待對話狀態重新整理後再交接。",
    synchronizing: "正在同步控制狀態。請等待同步完成後再交接。",
    sessionBusy: "對話操作進行中。請等待完成後再交接。",
  },
  "ja-JP": {
    processing:
      "操作を処理中です。結果を待ってから、この会話を引き渡すか元のクライアントに戻してください。",
    uncertain: "前回の操作結果を確認中です。確認が終わるまで引き渡しを繰り返さないでください。",
    compacting:
      "コンテキストを圧縮中です。完了を待って会話を更新してから、引き渡すか元のクライアントに戻してください。",
    tool: "実行ツールは現在利用できません。このコンピューターでインストールと接続を確認し、会話を更新してください。",
    confirmation: "引き渡す前に元のクライアントを停止し、上の確認項目にチェックを入れてください。",
    fingerprintLoading: "引き渡しのために Claude Code の履歴を検証中です。完了までお待ちください。",
    fingerprintUnavailable:
      "Claude Code の履歴を検証できません。このコンピューターのソースを確認し、会話の操作を開き直してください。検証前は引き渡せません。",
    session: "選択した会話と制御状態が一致しません。会話を更新し、会話の操作を開き直してください。",
    capability:
      "この会話は現在引き渡せません。会話を更新してこのコンピューターの Agent を確認してください。利用できない場合は元のクライアントで続けてください。",
    ownership:
      "この会話は現在引き渡し待ちではありません。実行状態を更新してから再試行してください。",
    turn: "元のクライアントが待機中または解放済みではありません。現在のターンとバックグラウンドコマンドを終了または停止し、会話を更新してください。",
    approvals:
      "元のクライアントに承認待ちの項目があります。元のクライアントで処理し、会話を更新してから引き渡してください。",
    questions:
      "元のクライアントに未回答の質問があります。元のクライアントで回答し、会話を更新してから引き渡してください。",
    access: "アクセスが未承認です。再接続し、このコンピューター上の AgentKib で承認してください。",
    protocol:
      "接続プロトコルに互換性がありません。このコンピューター上の AgentKib を更新して再接続してください。",
    experimental:
      "実行管理が無効です。このコンピューター上の AgentKib の Web 設定で有効にし、更新してください。",
    management:
      "このデバイスには管理権限がありません。このコンピューター上の AgentKib の Web 設定で許可し、再接続してください。",
    send: "現在のアクセスでは送信できません。AgentKib を実行しているコンピューターで、このアクセスの権限を確認してください。",
    offline:
      "このコンピューターがオフラインです。再接続して会話の状態が更新されるのを待ってから引き渡してください。",
    synchronizing: "制御状態を同期中です。同期が完了してから引き渡してください。",
    sessionBusy: "会話の操作を処理中です。完了してから引き渡してください。",
  },
};

export function managedControlCopyForSurface(locale: Locale, surface: SessionSurface = "desktop") {
  return surfaceCopy(managedControlCopy[locale], surface, locale);
}
