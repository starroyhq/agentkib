import { useI18n } from "@/core/useI18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@agentkib/ui/dialog";
import {
  currentAppPlatform,
  formatShortcut,
  shortcutsForGroup,
  type ShortcutGroup,
} from "@/core/keyboard-shortcuts";

export function ShortcutHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { tr } = useI18n();
  const platform = currentAppPlatform();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(560px,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>{tr("shortcuts.title")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-5">
          <ShortcutGroupSection group="navigation" platform={platform} />
          <ShortcutGroupSection group="actions" platform={platform} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutGroupSection({
  group,
  platform,
}: {
  group: ShortcutGroup;
  platform: ReturnType<typeof currentAppPlatform>;
}) {
  const { tr } = useI18n();
  return (
    <section aria-labelledby={`shortcut-group-${group}`}>
      <h3
        id={`shortcut-group-${group}`}
        className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {tr(`shortcuts.group.${group}`)}
      </h3>
      <div className="divide-y divide-border/60 rounded-lg border border-border/70">
        {shortcutsForGroup(group).map((definition) => (
          <div key={definition.id} className="flex items-center justify-between gap-4 px-3 py-2.5">
            <span className="min-w-0 truncate">{tr(definition.labelKey)}</span>
            <kbd className="shrink-0 rounded border border-border bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
              {formatShortcut(definition, platform)}
            </kbd>
          </div>
        ))}
      </div>
    </section>
  );
}
