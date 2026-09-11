import { Languages } from "lucide-react";
import { NativeSelect } from "@/components/ui/native-select";
import { Dialog } from "@/components/dialog";
import { useSession } from "@/features/sessions/session-context";
import type { Locale } from "@/i18n";
export function PreferencesDialog() {
  const { t, locale, setLocale, theme, setTheme, accent, setAccent, setModal } = useSession();
  return (
    <Dialog closeLabel={t.close} title={t.preferences} onClose={() => setModal(undefined)}>
      <div className="grid gap-5 [&>label]:flex [&>label]:items-center [&>label]:justify-between [&>label]:gap-3 [&>label]:text-sm">
        <label>
          <Languages size={16} />
          {t.language}
          <NativeSelect value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
            <option value="zh-CN">简体中文</option>
            <option value="zh-TW">繁體中文</option>
            <option value="en-US">English</option>
            <option value="ja-JP">日本語</option>
          </NativeSelect>
        </label>
        <label>
          {t.theme}
          <NativeSelect value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="system">{t.system}</option>
            <option value="light">{t.light}</option>
            <option value="dark">{t.dark}</option>
          </NativeSelect>
        </label>
        <label>
          {t.accent}
          <NativeSelect value={accent} onChange={(e) => setAccent(e.target.value)}>
            <option value="blue">{t.blue}</option>
            <option value="violet">{t.violet}</option>
            <option value="green">{t.green}</option>
          </NativeSelect>
        </label>
      </div>
    </Dialog>
  );
}
