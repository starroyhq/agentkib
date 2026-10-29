import type { SessionWorktree } from "@agentkib/web-client";
import type { SupportedLocale as Locale } from "@/core/types";

/** Words for git worktree marks; "工作树" matches Codex's Chinese. */
export const worktreeCopy = {
  "zh-CN": {
    present: (name: string) => `在 git 工作树 ${name} 中运行`,
    deleted: (name: string) => `工作树 ${name} 的文件夹已经不在了，会话记录仍可查看`,
    unknown: (name: string) => `无法检查工作树 ${name} 的状态`,
    branch: "分支",
    chip: (name: string) => `工作树 ${name}`,
    deletedState: "已删除",
    unknownState: "状态未知",
    group: "这是 git 工作树",
    count: (count: number) => `${count} 个工作树`,
    showExecution: "显示程序启动的会话",
    execution: "程序启动的会话",
  },
  "zh-TW": {
    present: (name: string) => `在 git 工作樹 ${name} 中執行`,
    deleted: (name: string) => `工作樹 ${name} 的資料夾已經不在了，對話記錄仍可查看`,
    unknown: (name: string) => `無法檢查工作樹 ${name} 的狀態`,
    branch: "分支",
    chip: (name: string) => `工作樹 ${name}`,
    deletedState: "已刪除",
    unknownState: "狀態未知",
    group: "這是 git 工作樹",
    count: (count: number) => `${count} 個工作樹`,
    showExecution: "顯示程式啟動的對話",
    execution: "程式啟動的對話",
  },
  "en-US": {
    present: (name: string) => `Running in git worktree ${name}`,
    deleted: (name: string) =>
      `The folder of worktree ${name} is gone; the conversation history is still readable`,
    unknown: (name: string) => `Couldn't check the status of worktree ${name}`,
    branch: "branch",
    chip: (name: string) => `Worktree ${name}`,
    deletedState: "deleted",
    unknownState: "status unknown",
    group: "This is a git worktree",
    count: (count: number) => `${count} ${count === 1 ? "worktree" : "worktrees"}`,
    showExecution: "Show program-started sessions",
    execution: "Started by a program",
  },
  "ja-JP": {
    present: (name: string) => `git ワークツリー ${name} で実行`,
    deleted: (name: string) =>
      `ワークツリー ${name} のフォルダはもうありません。履歴は引き続き読めます`,
    unknown: (name: string) => `ワークツリー ${name} の状態を確認できません`,
    branch: "ブランチ",
    chip: (name: string) => `ワークツリー ${name}`,
    deletedState: "削除済み",
    unknownState: "状態不明",
    group: "これは git ワークツリーです",
    count: (count: number) => `${count} 個のワークツリー`,
    showExecution: "プログラムが起動したセッションを表示",
    execution: "プログラムが起動したセッション",
  },
} satisfies Record<Locale, Record<string, unknown>>;

/** Hover text and accessible name of a worktree mark; status is spelled out, not colored. */
export function worktreeLabel(worktree: SessionWorktree, locale: Locale): string {
  const c = worktreeCopy[locale];
  if (worktree.status === "deleted") return `${c.deleted(worktree.name)} · ${worktree.path}`;
  if (worktree.status === "unknown") return `${c.unknown(worktree.name)} · ${worktree.path}`;
  return [
    c.present(worktree.name),
    worktree.branch ? `${c.branch} ${worktree.branch}` : "",
    worktree.path,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The session page's chip: "工作树 <名称> · <分支>", or the status when the folder is gone. */
export function worktreeChip(worktree: SessionWorktree, locale: Locale): string {
  const c = worktreeCopy[locale];
  const detail =
    worktree.status === "deleted"
      ? c.deletedState
      : worktree.status === "unknown"
        ? c.unknownState
        : worktree.branch;
  return detail ? `${c.chip(worktree.name)} · ${detail}` : c.chip(worktree.name);
}
