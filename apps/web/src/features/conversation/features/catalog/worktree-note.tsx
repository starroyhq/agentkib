import { Split } from "lucide-react";
import type { SessionWorktree } from "@agentkib/web-client";
import type { Locale } from "../../i18n";
import { worktreeChip, worktreeCopy, worktreeLabel } from "./worktree-copy";

/** Icon only; hovering or a screen reader gives the worktree's name, branch, path and status. */
export function WorktreeMark({ worktree, locale }: { worktree: SessionWorktree; locale: Locale }) {
  const label = worktreeLabel(worktree, locale);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-worktree-mark={worktree.status === "deleted" ? "deleted" : ""}
      className={`inline-flex shrink-0 items-center text-muted-foreground ${worktree.status === "deleted" ? "opacity-45" : ""}`}
    >
      <Split size={12} aria-hidden="true" />
    </span>
  );
}

/** The session page's worktree chip, and a notice once the worktree's folder is gone. */
export function WorktreeNote({ worktree, locale }: { worktree: SessionWorktree; locale: Locale }) {
  return (
    <>
      <p
        className="mx-auto mb-4 flex w-full max-w-3xl items-center gap-1.5 text-xs text-muted-foreground"
        title={worktreeLabel(worktree, locale)}
      >
        <WorktreeMark worktree={worktree} locale={locale} />
        <span className="min-w-0 truncate">{worktreeChip(worktree, locale)}</span>
      </p>
      {worktree.status === "deleted" && (
        <aside role="note" className="info mx-auto mb-5 max-w-3xl">
          {worktreeCopy[locale].deletedNotice}
        </aside>
      )}
    </>
  );
}
