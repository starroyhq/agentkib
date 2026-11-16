import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { desktopApi } from "@/core/desktop";
import { SettingsCopy, SettingsRow } from "./components/SettingsLayout";

/** A bridge that cannot answer, however it fails, leaves the setting unread. */
const request = (params: Record<string, unknown>) =>
  Promise.resolve().then(() => desktopApi().claude.request(params));

const autoContinueOf = (value: unknown): boolean | undefined =>
  value && typeof value === "object" && "autoContinue" in value
    ? typeof value.autoContinue === "boolean"
      ? value.autoContinue
      : undefined
    : undefined;

/**
 * Whether a Claude Code or Codex session that met its account's usage limit continues by itself
 * after the reset. On by default; kept on this computer. Until it is read the switch shows on
 * and disabled.
 */
export function UsageLimitAutoContinueSetting() {
  const { t: tr } = useTranslation();
  const [enabled, setEnabled] = useState<boolean>();
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    let current = true;
    void request({ operation: "usage-limit-auto-continue" }).then(
      (value) => current && setEnabled(autoContinueOf(value)),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);
  const toggle = (next: boolean) => {
    setSwitching(true);
    void request({ operation: "usage-limit-auto-continue", enabled: next })
      .then(
        (value) => setEnabled((previous) => autoContinueOf(value) ?? previous),
        () => undefined,
      )
      .finally(() => setSwitching(false));
  };
  return (
    <SettingsRow>
      <SettingsCopy>
        <strong>{tr("settings.usageLimitAutoContinue")}</strong>
        <small>{tr("settings.usageLimitAutoContinueHint")}</small>
      </SettingsCopy>
      <Label className="inline-flex items-center justify-self-end">
        <Switch
          aria-label={tr("settings.usageLimitAutoContinue")}
          checked={enabled !== false}
          disabled={switching || enabled === undefined}
          onCheckedChange={toggle}
        />
      </Label>
    </SettingsRow>
  );
}
