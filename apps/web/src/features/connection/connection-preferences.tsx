import { useId, useState } from "react";
import { Settings2 } from "lucide-react";
import { NativeSelect } from "@/features/conversation/components/ui/native-select";
import { dictionaries, type Locale } from "@/features/conversation/i18n";

/** One set of controls: collapsed on phones and always visible on desktop. */
export function ConnectionPreferences({
  locale,
  theme,
  onChange,
}: {
  locale: Locale;
  theme: string;
  onChange: (locale: Locale, theme: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const t = dictionaries[locale];
  return (
    <>
      <button
        type="button"
        className="flex min-h-11 min-w-11 items-center justify-center rounded-lg hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring md:hidden"
        aria-label={t.preferences}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <Settings2 size={20} aria-hidden="true" />
      </button>
      <div
        id={id}
        className={`${open ? "flex" : "hidden"} w-full flex-wrap gap-4 border-t pt-3 text-xs text-muted-foreground md:flex md:w-auto md:border-0 md:pt-0`}
      >
        <label className="flex items-center gap-2">
          {t.language}
          <NativeSelect
            className="h-11"
            value={locale}
            onChange={(event) => onChange(event.target.value as Locale, theme)}
          >
            <option value="zh-CN">简体中文</option>
            <option value="zh-Hant">繁體中文</option>
            <option value="en-US">English</option>
            <option value="ja-JP">日本語</option>
          </NativeSelect>
        </label>
        <label className="flex items-center gap-2">
          {t.theme}
          <NativeSelect
            className="h-11"
            value={theme}
            onChange={(event) => onChange(locale, event.target.value)}
          >
            <option value="system">{t.system}</option>
            <option value="light">{t.light}</option>
            <option value="dark">{t.dark}</option>
          </NativeSelect>
        </label>
      </div>
    </>
  );
}
