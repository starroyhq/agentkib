import { useI18n } from "@/core/useI18n";
import { useEffect, useRef, useState } from "react";
import { DelayedSpinner, useDelayedBusy } from "@agentkib/session-ui";
import { Check, LoaderCircle, Pencil, X } from "lucide-react";
import { Button } from "@agentkib/ui/button";
import { Textarea } from "@agentkib/ui/textarea";
import { cn } from "cn";
import type { MemoryRecord } from "@/core/types";

export function MemoryCard({
  record,
  onReview,
}: {
  record: MemoryRecord;
  onReview: (
    id: string,
    status: "approved" | "rejected" | "invalidated",
    editedContent?: string,
  ) => Promise<void>;
}) {
  const { tr, formatDateTime, localizeMessage } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.content);
  const [action, setAction] = useState<"approved" | "rejected" | "invalidated" | null>(null);
  const busy = action !== null;
  const spinning = useDelayedBusy(busy);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const review = async (status: "approved" | "rejected" | "invalidated") => {
    if (pending.current) return;
    pending.current = true;
    setAction(status);
    setError("");
    try {
      await onReview(record.id, status, status === "approved" && editing ? draft : undefined);
      if (alive.current) setEditing(false);
    } catch (reason) {
      if (alive.current) setError(localizeMessage(reason));
    } finally {
      pending.current = false;
      if (alive.current) setAction(null);
    }
  };
  return (
    <article aria-busy={busy}>
      <div>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-md text-xs font-medium",
            record.status === "approved"
              ? "text-emerald-600"
              : record.status === "pending"
                ? "text-amber-700"
                : "text-muted-foreground",
          )}
        >
          {tr(`status.memory.${record.status}`)}
        </span>
        <span className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
          {tr(`status.memoryType.${record.memory_type}`)}
        </span>
        <time>{formatDateTime(record.created_at)}</time>
      </div>
      {editing && record.status === "pending" ? (
        <Textarea
          className="min-h-24 resize-y"
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : (
        <p>{record.content}</p>
      )}
      {record.source_agent && <small>{tr("memory.source", { source: record.source_agent })}</small>}
      {error && (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      )}
      {record.status === "pending" && (
        <footer>
          <Button
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={busy}
            onClick={() => void review("approved")}
          >
            {spinning && action === "approved" ? (
              <LoaderCircle
                aria-hidden
                size={15}
                className="animate-spin motion-reduce:animate-none"
              />
            ) : (
              <Check size={15} />
            )}
            {editing ? tr("memory.saveApprove") : tr("common.approve")}
          </Button>
          <Button
            className="border border-transparent bg-transparent text-foreground hover:bg-muted"
            disabled={busy}
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? <X size={14} /> : <Pencil size={14} />}
            {editing ? tr("memory.cancelEdit") : tr("common.edit")}
          </Button>
          <Button
            className="border border-destructive/30 bg-destructive/5 text-destructive-text hover:bg-destructive/10"
            disabled={busy}
            onClick={() => void review("rejected")}
          >
            <span aria-hidden className="size-3.5">
              <DelayedSpinner active={action === "rejected"} />
            </span>
            {tr("common.reject")}
          </Button>
        </footer>
      )}
      {record.status === "approved" && (
        <footer>
          <Button
            className="border border-destructive/30 bg-destructive/5 text-destructive-text hover:bg-destructive/10"
            disabled={busy}
            onClick={() => void review("invalidated")}
          >
            <span aria-hidden className="size-3.5">
              <DelayedSpinner active={action === "invalidated"} />
            </span>
            {tr("memory.invalidate")}
          </Button>
        </footer>
      )}
    </article>
  );
}
