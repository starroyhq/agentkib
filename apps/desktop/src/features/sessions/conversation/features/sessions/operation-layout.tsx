import { Check, ChevronRight, Copy } from "lucide-react";
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/**
 * The session operations dialog's layout: a titled group whose rows share one bordered card, as
 * the settings pages lay theirs out, at a dialog's scale. Every section of the dialog uses it, so
 * they read as one surface.
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
  defaultOpen = false,
  children,
  className,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className={className}>
      <CollapsibleTrigger className="group flex min-h-11 w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted/50">
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-90"
        />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-4 border-t border-border/60 px-4 py-3">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A line to copy, such as a directory or a command: cut short to fit, whole in its tooltip, with
 * the button that copies it.
 */
export function CopyField({
  value,
  label,
  copiedLabel,
}: {
  value: string;
  label: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 3000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-lg border border-border/70 bg-muted/40 py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={copied ? copiedLabel : label}
        title={copied ? copiedLabel : label}
        onClick={() =>
          void navigator.clipboard.writeText(value).then(
            () => setCopied(true),
            () => undefined,
          )
        }
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
