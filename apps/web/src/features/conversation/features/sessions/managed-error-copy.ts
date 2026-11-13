import type { Locale } from "../../i18n";
import { surfaceCopy, type SessionSurface } from "./session-surface-copy";
export const managedErrorCopy: Record<
  Locale,
  { failed: string; connection: string; unconfirmed: string; details: string }
> = {
  "zh-CN": {
    failed: "无法完成操作，请刷新会话并检查这台电脑状态后重试。",
    connection: "连接中断，请先检查任务列表再重试。",
    unconfirmed: "操作结果尚未确认，请刷新检查结果，勿重复操作。",
    details: "错误详情",
  },
  "zh-Hant": {
    failed: "無法完成操作，請重新整理對話並檢查這台電腦狀態後重試。",
    connection: "連線中斷，請先檢查任務列表再重試。",
    unconfirmed: "操作結果尚未確認，請重新整理檢查結果，勿重複操作。",
    details: "錯誤詳細資料",
  },
  "en-US": {
    failed: "The operation failed. Refresh the session and check this computer before retrying.",
    connection: "Connection lost. Verify the task list before retrying.",
    unconfirmed: "The outcome is unconfirmed. Refresh and check it; do not repeat the operation.",
    details: "Error details",
  },
  "ja-JP": {
    failed:
      "操作に失敗しました。会話を更新し、このコンピューターの状態を確認してから再試行してください。",
    connection: "接続が切れました。再試行の前にタスク一覧を確認してください。",
    unconfirmed: "操作結果が未確認です。更新して結果を確認し、操作を繰り返さないでください。",
    details: "エラーの詳細",
  },
};

export function managedErrorCopyForSurface(locale: Locale, surface: SessionSurface = "desktop") {
  return surfaceCopy(managedErrorCopy[locale], surface, locale);
}
