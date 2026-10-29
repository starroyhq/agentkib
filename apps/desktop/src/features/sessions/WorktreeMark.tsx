import { Split } from "lucide-react";
import { cn } from "cn";

/**
 * Marks a git worktree with an icon only; hovering or a screen reader gives the details.
 * A deleted worktree is dimmed, and its label says so in words.
 */
export function WorktreeMark({
  label,
  deleted = false,
  className,
}: {
  label: string;
  deleted?: boolean;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-worktree-mark={deleted ? "deleted" : ""}
      className={cn(
        "inline-flex shrink-0 items-center text-muted-foreground",
        deleted && "opacity-45",
        className,
      )}
    >
      <Split size={12} aria-hidden="true" />
    </span>
  );
}
