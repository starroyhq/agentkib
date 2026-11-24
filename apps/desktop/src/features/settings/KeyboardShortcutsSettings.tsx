import { alternateFollowUpShortcut } from "@agentkib/session-ui";
import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import {
  currentAppPlatform,
  formatShortcut,
  shortcutsForGroup,
  type ShortcutGroup,
} from "@/core/keyboard-shortcuts";
import { SettingsPage, SettingsPageHeader, SettingsSection } from "./components/SettingsLayout";
import { useShortcutHelp } from "@/features/app/ShortcutHelpContext";

export function KeyboardShortcutsSettings() {
  const { tr } = useI18n();
  const platform = currentAppPlatform();
  const { openShortcutHelp } = useShortcutHelp();
  return (
    <SettingsPage>
      <SettingsPageHeader
        title={tr("settings.section.shortcuts")}
        action={
          <Button variant="outline" size="sm" onClick={openShortcutHelp}>
            {tr("settings.viewShortcuts")}
          </Button>
        }
      />
      <SettingsSection title={tr("shortcuts.group.navigation")} target="shortcuts-list">
        <ShortcutRows group="navigation" platform={platform} />
      </SettingsSection>
      <SettingsSection title={tr("shortcuts.group.actions")} target="shortcuts-actions">
        <ShortcutRows group="actions" platform={platform} />
      </SettingsSection>
    </SettingsPage>
  );
}

function ShortcutRows({
  group,
  platform,
}: {
  group: ShortcutGroup;
  platform: ReturnType<typeof currentAppPlatform>;
}) {
  const { tr } = useI18n();
  const rows: { id: string; label: string; keys: string }[] = shortcutsForGroup(group).map(
    (definition) => ({
      id: definition.id,
      label: tr(definition.labelKey),
      keys: formatShortcut(definition, platform),
    }),
  );
  if (group === "actions") {
    rows.push({
      id: "alternate-follow-up",
      label: tr("conversation.alternateFollowUp"),
      keys: alternateFollowUpShortcut(platform === "macos"),
    });
  }
  return (
    <div className="divide-y divide-border/60">
      {rows.map(({ id, label, keys }) => (
        <div key={id} className="flex min-h-12 items-center justify-between gap-4 px-5 py-2.5">
          <span className="min-w-0 truncate">{label}</span>
          <kbd className="shrink-0 rounded border border-border bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
            {keys}
          </kbd>
        </div>
      ))}
    </div>
  );
}
