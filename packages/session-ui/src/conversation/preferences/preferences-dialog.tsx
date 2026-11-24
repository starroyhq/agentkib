import { Languages } from "lucide-react";
import type { InteractionLocale } from "../../interaction-model";
import { useSessionPlatform } from "../../session-platform";
import {
  alternateFollowUpShortcut,
  setSendWhileRunning,
  useSendWhileRunning,
} from "./send-while-running";

type PreferenceLabel =
  | "close"
  | "preferences"
  | "language"
  | "theme"
  | "system"
  | "light"
  | "dark"
  | "accent"
  | "blue"
  | "violet"
  | "green"
  | "sendWhileRunning"
  | "sendWhileRunningQueue"
  | "sendWhileRunningSteer"
  | "sessionPreferences"
  | "keyboardShortcuts"
  | "alternateFollowUp";

export function PreferencesDialog({
  labels: t,
  locale,
  theme,
  accent,
  onLocaleChange,
  onThemeChange,
  onAccentChange,
  onClose,
}: {
  labels: Readonly<Record<PreferenceLabel, string>>;
  locale: InteractionLocale;
  theme: string;
  accent: string;
  onLocaleChange: (locale: InteractionLocale) => void;
  onThemeChange: (theme: string) => void;
  onAccentChange: (accent: string) => void;
  onClose: () => void;
}) {
  const {
    components: { SessionDialog, NativeSelect },
    desktop,
  } = useSessionPlatform();
  const sendWhileRunning = useSendWhileRunning();
  return (
    <SessionDialog closeLabel={t.close} title={t.preferences} onClose={onClose}>
      <div className="grid gap-5 [&>label]:flex [&>label]:items-center [&>label]:justify-between [&>label]:gap-3 [&>label]:text-sm">
        <label>
          <Languages size={16} />
          {t.language}
          <NativeSelect
            value={locale}
            onChange={(e) => onLocaleChange(e.target.value as InteractionLocale)}
          >
            <option value="zh-CN">简体中文</option>
            <option value="zh-Hant">繁體中文</option>
            <option value="en-US">English</option>
            <option value="ja-JP">日本語</option>
          </NativeSelect>
        </label>
        <label>
          {t.theme}
          <NativeSelect value={theme} onChange={(e) => onThemeChange(e.target.value)}>
            <option value="system">{t.system}</option>
            <option value="light">{t.light}</option>
            <option value="dark">{t.dark}</option>
          </NativeSelect>
        </label>
        <label>
          {t.accent}
          <NativeSelect value={accent} onChange={(e) => onAccentChange(e.target.value)}>
            <option value="blue">{t.blue}</option>
            <option value="violet">{t.violet}</option>
            <option value="green">{t.green}</option>
          </NativeSelect>
        </label>
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-semibold">{t.sessionPreferences}</legend>
          <label className="flex items-center justify-between gap-3 text-sm">
            {t.sendWhileRunning}
            <NativeSelect
              value={sendWhileRunning}
              onChange={(event) => {
                const mode = event.target.value;
                if (mode === "queue" || mode === "steer") setSendWhileRunning(mode);
              }}
            >
              <option value="steer">{t.sendWhileRunningSteer}</option>
              <option value="queue">{t.sendWhileRunningQueue}</option>
            </NativeSelect>
          </label>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">{t.keyboardShortcuts}</legend>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>{t.alternateFollowUp}</span>
            <kbd className="shrink-0 rounded border bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
              {alternateFollowUpShortcut(desktop?.isMacOS)}
            </kbd>
          </div>
        </fieldset>
      </div>
    </SessionDialog>
  );
}
