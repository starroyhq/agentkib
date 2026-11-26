import { LoaderCircle } from "lucide-react";
import { useDelayedBusy } from "./delayed-busy";

/** Wrap this in a fixed-width icon slot when a button has no icon to replace. */
export function DelayedSpinner({
  active,
  className = "size-3.5",
}: {
  active: boolean;
  className?: string;
}) {
  return useDelayedBusy(active) ? (
    <LoaderCircle aria-hidden className={`${className} animate-spin motion-reduce:animate-none`} />
  ) : null;
}

export function LoadingSkeleton({
  label,
  layout = "list",
  rows = layout === "conversation" ? 4 : 3,
  className = "",
}: {
  label: string;
  layout?: "list" | "conversation" | "code";
  rows?: number;
  className?: string;
}) {
  if (!useDelayedBusy(true)) return null;

  return (
    <div
      role="status"
      aria-label={label}
      className={`space-y-2 animate-pulse motion-reduce:animate-none ${className}`}
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className={
            layout === "list"
              ? "flex h-9 items-center gap-2 rounded-md border border-border/60 px-2"
              : layout === "conversation"
                ? `mb-5 w-3/5 space-y-2 rounded-xl bg-muted/60 p-3 ${index % 2 ? "" : "ml-auto max-w-xs"}`
                : "h-4"
          }
        >
          {layout === "list" && <span className="size-4 shrink-0 rounded bg-muted" />}
          <span className={`block h-2.5 rounded bg-muted ${index % 2 ? "w-2/5" : "w-3/5"}`} />
          {layout === "conversation" && index % 2 > 0 && (
            <span className="block h-2.5 w-4/5 rounded bg-muted" />
          )}
        </div>
      ))}
    </div>
  );
}
