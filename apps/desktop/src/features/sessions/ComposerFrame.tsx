import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function ComposerFrame(props: Pick<ComponentProps<"form">, "children" | "onSubmit">) {
  return (
    <form
      className="session-composer-frame relative w-full space-y-2 rounded-3xl border border-border bg-background p-2 shadow-sm transition-colors focus-within:border-ring/40 md:p-3"
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
    <div className="@container flex min-w-0 items-center justify-between gap-2 px-1">
      <div className="flex min-w-0 flex-1 items-center gap-0.5">{leading}</div>
      <div className="ml-auto flex min-w-0 items-center gap-1">{trailing}</div>
    </div>
  );
}

export function ComposerIconButton(
  props: Omit<ComponentProps<typeof Button>, "className" | "size">,
) {
  return <Button className="size-11 shrink-0 rounded-full p-0" size="icon" {...props} />;
}
