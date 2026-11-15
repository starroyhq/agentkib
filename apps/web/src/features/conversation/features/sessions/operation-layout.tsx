import { ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";
import { cn } from "../../lib/utils";

/**
 * The session operations dialog's layout, the same as the desktop app's: a titled group whose
 * rows share one bordered card. Every section of the dialog uses it, so they read as one surface.
 */
export function OperationGroup({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("grid gap-2", className)} aria-label={title}>
      <h3 className="px-0.5">{title}</h3>
      <div className="overflow-hidden rounded-xl border border-border/70 [&>*:last-child]:border-b-0">
        {children}
      </div>
    </section>
  );
}

/** One row of a group: what it is at the start, its control at the end. */
export function OperationRow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-14 items-center gap-4 border-b border-border/60 px-4 py-3",
        className,
      )}
      {...props}
    />
  );
}

/** A row's words: its name, and under it what there is to know about it. */
export function OperationCopy({
  title,
  children,
  className,
}: {
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid min-w-0 flex-1 gap-0.5", className)}>
      {title && <p className="truncate">{title}</p>}
      {children && <div className="text-xs leading-5 text-muted-foreground">{children}</div>}
    </div>
  );
}

/** A part that stays folded until asked for: a row that opens what is under it. */
export function OperationDisclosure({
  title,
  children,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Disclosure className={cn("group", className)}>
      <DisclosureSummary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-2.5 outline-none hover:bg-muted/50 focus-visible:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
        {title}
      </DisclosureSummary>
      <div className="grid gap-4 border-t border-border/60 px-4 py-3">{children}</div>
    </Disclosure>
  );
}

/** A finger needs the taller target; a mouse keeps the app's compact buttons. */
export const TOUCH_TARGET = "pointer-coarse:min-h-11";
