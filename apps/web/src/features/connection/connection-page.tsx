import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useState, type FormEvent } from "react";
import { useAppearance } from "@/features/preferences/use-appearance";
import { parseLanOrigin } from "@agentkib/web-client";
import { useNavigate } from "@tanstack/react-router";
import { useEnvironment } from "@/providers/environment";
import { dictionaries, type Locale } from "@/i18n";
import { Monitor, ArrowRight, ShieldAlert } from "lucide-react";
import { connectionCopy } from "@/features/connection/connection-copy";

export function ConnectionPage() {
  const env = useEnvironment();
  const navigate = useNavigate();
  return (
    <ConnectionScreen
      initialAddress={env.address}
      initialLocale={env.locale}
      initialTheme={env.theme}
      onConnect={(address, locale, theme) => {
        env.connect(address, locale, theme);
        void navigate({ to: "/pair" });
      }}
    />
  );
}
export function ConnectionScreen({
  initialAddress = "",
  initialLocale = "zh-CN",
  initialTheme = "system",
  onConnect,
}: {
  initialAddress?: string;
  initialLocale?: Locale;
  initialTheme?: string;
  onConnect: (address: string, locale: Locale, theme: string) => void;
}) {
  const [address, setAddress] = useState(initialAddress);
  const [acknowledged, setAcknowledged] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [theme, setTheme] = useState(initialTheme);
  const t = dictionaries[locale];
  const copy = connectionCopy[locale];
  useAppearance(locale, theme);
  function connect(event: FormEvent) {
    event.preventDefault();
    if (!acknowledged) return;
    try {
      onConnect(parseLanOrigin(address), locale, theme);
      setInvalid(false);
    } catch {
      setInvalid(true);
    }
  }
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-5 border-b px-6 py-5 md:px-10">
        <div className="flex items-center gap-3 text-sm">
          <img src="/favicon.svg" width="30" height="30" alt="" />
          <strong>
            AgentKib <span className="text-muted-foreground">Web</span>
          </strong>
        </div>
        <div className="flex flex-wrap gap-4 [&>label]:flex [&>label]:items-center [&>label]:gap-2 [&>label]:text-xs [&>label]:text-muted-foreground">
          <label>
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
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 px-6 py-12 md:grid-cols-2 md:gap-20 md:px-10 md:py-20">
        <section
          className="space-y-7 [&>h1]:max-w-md [&>h1]:text-4xl [&>h1]:font-medium [&>h1]:leading-tight [&>h1]:tracking-tight [&>p]:text-sm [&>p]:leading-7 [&>p]:text-muted-foreground [&>ol]:list-decimal [&>ol]:space-y-4 [&>ol]:pl-5 [&>ol]:text-sm [&>ol]:leading-6"
          aria-labelledby="connection-title"
        >
          <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs text-muted-foreground">
            <Monitor size={16} />
            {t.lanPlaintextShort}
          </span>
          <h1 id="connection-title">{copy.title}</h1>
          <p>{copy.intro}</p>
          <ol>
            {copy.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
        <section
          className="flex flex-col gap-5 rounded-2xl border bg-card p-6 shadow-sm md:p-8 [&>h2]:text-lg [&>h2]:font-semibold [&>p]:text-sm [&>p]:leading-6 [&>p]:text-muted-foreground [&>form]:grid [&>form]:gap-5 [&_label]:grid [&_label]:gap-2 [&_label]:text-xs [&_label]:font-medium [&_small]:text-xs [&_small]:leading-6 [&_small]:text-muted-foreground"
          aria-labelledby="connection-form-title"
        >
          <h2 id="connection-form-title">{copy.formTitle}</h2>
          <p>{t.lanPermission}</p>
          <form onSubmit={connect}>
            <label>
              {t.lanAddress}
              <Input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="http://192.168.1.10:1422"
                autoComplete="off"
                spellCheck={false}
                required
                maxLength={100}
                aria-describedby={
                  invalid ? "connection-address-help connection-error" : "connection-address-help"
                }
                aria-invalid={invalid || undefined}
              />
            </label>
            <small id="connection-address-help">{copy.hint}</small>
            <aside className="info">
              <ShieldAlert size={18} />
              <span>{t.lanRisk}</span>
            </aside>
            <label className="!flex items-start gap-3 leading-6 [&>input]:mt-1 [&>input]:size-4 [&>input]:shrink-0">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              {t.lanAcknowledge}
            </label>
            {invalid && (
              <p id="connection-error" role="alert">
                {t.lanInvalid}
              </p>
            )}
            <Button variant="default" className="h-11" disabled={!acknowledged}>
              {t.connect}
              <ArrowRight size={17} />
            </Button>
          </form>
        </section>
      </main>
    </div>
  );
}
