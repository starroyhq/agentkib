import { useI18n } from "@/core/useI18n";
import { useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
  const { tr, formatDateTime } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.content);
  return (
    <article>
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
      {editing ? (
        <Textarea
          className="min-h-24 resize-y"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : (
        <p>{record.content}</p>
      )}
      {record.source_agent && <small>{tr("memory.source", { source: record.source_agent })}</small>}
      {record.status === "pending" && (
        <footer>
          <Button
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={() => onReview(record.id, "approved", editing ? draft : undefined)}
          >
            <Check size={15} />
            {editing ? tr("memory.saveApprove") : tr("common.approve")}
          </Button>
          <Button
            className="border border-transparent bg-transparent text-foreground hover:bg-muted"
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? <X size={14} /> : <Pencil size={14} />}
            {editing ? tr("memory.cancelEdit") : tr("common.edit")}
          </Button>
          <Button
            className="border border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10"
            onClick={() => onReview(record.id, "rejected")}
          >
            {tr("common.reject")}
          </Button>
        </footer>
      )}
      {record.status === "approved" && (
        <footer>
          <Button
            className="border border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10"
            onClick={() => onReview(record.id, "invalidated")}
          >
            {tr("memory.invalidate")}
          </Button>
        </footer>
      )}
    </article>
  );
}
