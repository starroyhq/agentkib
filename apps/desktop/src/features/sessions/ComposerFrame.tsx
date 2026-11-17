import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function ComposerFrame(props: Pick<ComponentProps<"form">, "children" | "onSubmit">) {
  return (
    <form
      className="session-composer-frame relative w-full space-y-2 rounded-3xl border border-border bg-background px-2 pt-2 pb-1 shadow-sm transition-colors focus-within:border-ring/40 md:px-3 md:pt-3"
      {...props}
    />
  );
}

export function ComposerTextarea(
  props: Omit<ComponentProps<typeof Textarea>, "className" | "rows">,
) {
  return (
    <Textarea
      className="min-h-10 max-h-40 w-full resize-none overflow-y-auto rounded-none border-0 bg-transparent px-3 py-2 text-sm shadow-none placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
      rows={1}
      {...props}
    />
  );
}

export function ComposerToolbar({
  leading,
  trailing,
}: {
  leading: ReactNode;
  trailing: ReactNode;
}) {
  return (
    <div className="@container -mx-1 flex min-w-0 items-center justify-between gap-2 pt-4">
      <div className="flex min-w-0 flex-1 items-center gap-0.5">{leading}</div>
      <div className="ml-auto flex min-w-0 items-center gap-1">{trailing}</div>
    </div>
  );
}

export function ComposerIconButton({
  compact = false,
  ...props
}: Omit<ComponentProps<typeof Button>, "className" | "size"> & { compact?: boolean }) {
  return (
    <Button
      className={`shrink-0 rounded-full p-0 ${compact ? "pointer-coarse:size-11" : "size-11"}`}
      size="icon"
      {...props}
    />
  );
}
