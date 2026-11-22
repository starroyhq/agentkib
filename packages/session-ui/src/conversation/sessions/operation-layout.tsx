import { Check, ChevronRight, Copy } from "lucide-react";
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { useSessionPlatform } from "../../session-platform";

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
  const { mergeClassNames } = useSessionPlatform().components;
  return (
    <section className={mergeClassNames("grid gap-2", className)} aria-label={title}>
      <h3 className="px-0.5">{title}</h3>
      <div className="overflow-hidden rounded-xl border border-border/70 [&>*:last-child]:border-b-0">
        {children}
      </div>
    </section>
  );
}

/** One row of a group: what it is at the start, its control at the end. */
export function OperationRow({ className, ...props }: ComponentProps<"div">) {
  const { mergeClassNames } = useSessionPlatform().components;
  return (
    <div
      className={mergeClassNames(
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
  const { mergeClassNames } = useSessionPlatform().components;
  return (
    <div className={mergeClassNames("grid min-w-0 flex-1 gap-0.5", className)}>
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
  const { collapsible, Disclosure, DisclosureSummary, mergeClassNames } =
    useSessionPlatform().components;
  if (!collapsible) {
    return (
      <Disclosure className={mergeClassNames("group", className)}>
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
  const { Collapsible, CollapsibleTrigger, CollapsibleContent } = collapsible;
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
  const { Button } = useSessionPlatform().components;
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

/** A finger needs the taller target; a mouse keeps the app's compact buttons. */
export const TOUCH_TARGET = "pointer-coarse:min-h-11";
