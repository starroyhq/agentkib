import { sessionContinuationCopy } from "@agentkib/session-ui";
import type { SupportedLocale as Locale } from "@/core/types";

export const sessionAgentCopy: Record<
  Locale,
  {
    permission: string;
    nextTurnPermission: string;
    queue: string;
    pauseQueue: string;
    resumeQueue: string;
    queuePaused: string;
    queueRecovery: string;
  }
> = {
  "zh-CN": {
    permission: "工具权限",
    nextTurnPermission: "下一轮的权限（Devin 运行中不能询问你）",
    queue: sessionContinuationCopy("zh-CN").queued,
    pauseQueue: "暂停队列",
    resumeQueue: "恢复队列",
    queuePaused: "队列已暂停，恢复后才会继续执行。",
    queueRecovery: "队列不会自动继续。请先核对上次操作结果，再恢复队列。",
  },
  "zh-Hant": {
    permission: "工具權限",
    nextTurnPermission: "下一輪的權限（Devin 執行中無法詢問你）",
    queue: sessionContinuationCopy("zh-Hant").queued,
    pauseQueue: "暫停佇列",
    resumeQueue: "恢復佇列",
    queuePaused: "佇列已暫停，恢復後才會繼續執行。",
    queueRecovery: "佇列不會自動繼續。請先核對上次操作結果，再恢復佇列。",
  },
  "en-US": {
    permission: "Tool permissions",
    nextTurnPermission: "Permissions for the next turn (Devin cannot ask while it runs)",
    queue: sessionContinuationCopy("en-US").queued,
    pauseQueue: "Pause queue",
    resumeQueue: "Resume queue",
    queuePaused: "The queue is paused. Resume it to continue execution.",
    queueRecovery:
      "The queue will not continue automatically. Check the previous outcome before resuming the queue.",
  },
  "ja-JP": {
    permission: "ツール権限",
    nextTurnPermission: "次のターンの権限（Devin は実行中に確認できません）",
    queue: sessionContinuationCopy("ja-JP").queued,
    pauseQueue: "キューを一時停止",
    resumeQueue: "キューを再開",
    queuePaused: "キューは一時停止中です。再開すると実行を続けます。",
    queueRecovery:
      "キューは自動的に続行されません。前回の操作結果を確認してからキューを再開してください。",
  },
};
