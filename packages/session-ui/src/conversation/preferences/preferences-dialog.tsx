import { Languages } from "lucide-react";
import type { InteractionLocale } from "../../interaction-model";
import { useSessionPlatform } from "../../session-platform";
import {
  setSendWhileRunning,
  useSendWhileRunning,
  type SendWhileRunning,
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
  | "sendWhileRunningSteer";

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
        <label>
          {t.sendWhileRunning}
          <NativeSelect
            value={sendWhileRunning}
            onChange={(e) => setSendWhileRunning(e.target.value as SendWhileRunning)}
          >
            <option value="queue">{t.sendWhileRunningQueue}</option>
            <option value="steer">{t.sendWhileRunningSteer}</option>
          </NativeSelect>
        </label>
      </div>
    </SessionDialog>
  );
}
