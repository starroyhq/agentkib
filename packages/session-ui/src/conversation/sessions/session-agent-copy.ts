import { sessionContinuationCopy } from "../../session-continuation";
import type { InteractionLocale as Locale } from "../../interaction-model";

export const sessionAgentCopy: Record<
  Locale,
  {
    permission: string;
    queue: string;
    pauseQueue: string;
    resumeQueue: string;
    queuePaused: string;
    queueRecovery: string;
  }
> = {
  "zh-CN": {
    permission: "工具权限",
    queue: sessionContinuationCopy("zh-CN").queued,
    pauseQueue: "暂停队列",
    resumeQueue: "恢复队列",
    queuePaused: "已暂停",
    queueRecovery: "队列不会自动继续。请先核对上次操作结果，再恢复队列。",
  },
  "zh-Hant": {
    permission: "工具權限",
    queue: sessionContinuationCopy("zh-Hant").queued,
    pauseQueue: "暫停佇列",
    resumeQueue: "恢復佇列",
    queuePaused: "已暫停",
    queueRecovery: "佇列不會自動繼續。請先核對上次操作結果，再恢復佇列。",
  },
  "en-US": {
    permission: "Tool permissions",
    queue: sessionContinuationCopy("en-US").queued,
    pauseQueue: "Pause queue",
    resumeQueue: "Resume queue",
    queuePaused: "Paused",
    queueRecovery:
      "The queue will not continue automatically. Check the previous outcome before resuming the queue.",
  },
  "ja-JP": {
    permission: "ツール権限",
    queue: sessionContinuationCopy("ja-JP").queued,
    pauseQueue: "キューを一時停止",
    resumeQueue: "キューを再開",
    queuePaused: "一時停止中",
    queueRecovery:
      "キューは自動的に続行されません。前回の操作結果を確認してからキューを再開してください。",
  },
};
