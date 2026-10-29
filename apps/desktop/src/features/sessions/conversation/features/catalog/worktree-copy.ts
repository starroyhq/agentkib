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
    group: "这是 git 工作树",
    count: (count: number) => `${count} 个工作树`,
    deletedNotice: "这个工作树的文件夹已经不在了。记录仍可查看；要继续这个会话，请先恢复文件夹。",
    showExecution: "显示程序启动的会话",
    execution: "程序启动的会话",
  },
  "zh-TW": {
    present: (name: string) => `在 git 工作樹 ${name} 中執行`,
    deleted: (name: string) => `工作樹 ${name} 的資料夾已經不在了，對話記錄仍可查看`,
    unknown: (name: string) => `無法檢查工作樹 ${name} 的狀態`,
    branch: "分支",
    chip: (name: string) => `工作樹 ${name}`,
    group: "這是 git 工作樹",
    count: (count: number) => `${count} 個工作樹`,
    deletedNotice: "這個工作樹的資料夾已經不在了。記錄仍可查看；要繼續這個對話，請先還原資料夾。",
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
    group: "This is a git worktree",
    count: (count: number) => `${count} ${count === 1 ? "worktree" : "worktrees"}`,
    deletedNotice:
      "This worktree's folder is gone. The history is still readable; restore the folder before continuing the session.",
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
    group: "これは git ワークツリーです",
    count: (count: number) => `${count} 個のワークツリー`,
    deletedNotice:
      "このワークツリーのフォルダはもうありません。履歴は読めます。セッションを続けるには、先にフォルダを戻してください。",
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

/** The session page's chip: "工作树 <名称> · <分支>". */
export function worktreeChip(worktree: SessionWorktree, locale: Locale): string {
  const chip = worktreeCopy[locale].chip(worktree.name);
  return worktree.branch ? `${chip} · ${worktree.branch}` : chip;
}
