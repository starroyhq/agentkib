import { ConnectionPreferences } from "./connection-preferences";
import { Input } from "@/features/conversation/components/ui/input";
import { Button } from "@/features/conversation/components/ui/button";
import { useState, type FormEvent } from "react";
import { useAppearance } from "@agentkib/session-ui";
import { parseLanOrigin } from "@agentkib/web-client";
import { useNavigate } from "@tanstack/react-router";
import { useEnvironment } from "@/providers/environment";
import { dictionaries, type Locale } from "@/features/conversation/i18n";
import { Monitor, ArrowRight, ShieldAlert, ChevronDown } from "lucide-react";
import { connectionCopy } from "@/features/connection/connection-copy";

export function ConnectionPage() {
  const env = useEnvironment();
  const navigate = useNavigate();
  return (
    <ConnectionScreen
      key={env.attempt}
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
  const [instructionsOpen, setInstructionsOpen] = useState(false);
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
      <header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-b px-4 py-2 md:px-10 md:py-4">
        <div className="flex items-center gap-3 text-sm">
          <img src="/favicon.svg" width="30" height="30" alt="" />
          <strong>
            AgentKib <span className="text-muted-foreground">Web</span>
          </strong>
        </div>
        <ConnectionPreferences
          locale={locale}
          theme={theme}
          onChange={(nextLocale, nextTheme) => {
            setLocale(nextLocale);
            setTheme(nextTheme);
          }}
        />
      </header>
      <main className="mx-auto grid w-full max-w-6xl content-start gap-6 px-4 py-6 md:flex-1 md:grid-cols-2 md:content-center md:gap-x-16 md:gap-y-7 md:px-10 md:py-16">
        <section
          className="space-y-3 md:col-start-1 md:row-start-1 [&>h1]:max-w-md [&>h1]:text-3xl md:[&>h1]:text-4xl [&>h1]:font-medium [&>h1]:leading-tight [&>h1]:tracking-tight [&>p]:text-sm [&>p]:leading-7 [&>p]:text-muted-foreground"
          aria-labelledby="connection-title"
        >
          <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs text-muted-foreground">
            <Monitor size={16} />
            {t.lanPlaintextShort}
          </span>
          <h1 id="connection-title">{copy.title}</h1>
          <p>{copy.intro}</p>
        </section>
        <section
          className="flex min-w-0 flex-col gap-4 rounded-2xl border bg-card p-4 shadow-sm md:col-start-2 md:row-start-1 md:row-span-2 md:p-8 [&>h2]:text-lg [&>h2]:font-semibold [&>p]:text-sm [&>p]:leading-6 [&>p]:text-muted-foreground [&>form]:grid [&>form]:gap-4 [&_label]:grid [&_label]:gap-2 [&_label]:text-xs [&_label]:font-medium [&_small]:text-xs [&_small]:leading-6 [&_small]:text-muted-foreground"
          aria-labelledby="connection-form-title"
        >
          <h2 id="connection-form-title">{copy.formTitle}</h2>
          <p>{t.lanPermission}</p>
          <form onSubmit={connect}>
            <label>
              {t.lanAddress}
              <Input
                className="h-11"
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
            <label className="!flex min-h-11 items-start gap-3 leading-6 [&>input]:mt-1 [&>input]:size-4 [&>input]:shrink-0">
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
        <section
          className="md:col-start-1 md:row-start-2"
          aria-labelledby="connection-instructions-title"
        >
          <h2 id="connection-instructions-title" className="hidden text-sm font-medium md:block">
            {copy.addressHelp}
          </h2>
          <button
            type="button"
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-2 text-left text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring md:hidden"
            aria-expanded={instructionsOpen}
            aria-controls="connection-instructions"
            onClick={() => setInstructionsOpen((value) => !value)}
          >
            {copy.addressHelp}
            <ChevronDown
              size={16}
              aria-hidden="true"
              className={instructionsOpen ? "rotate-180" : ""}
            />
          </button>
          <ol
            id="connection-instructions"
            className={`${instructionsOpen ? "block" : "hidden"} mt-3 list-decimal space-y-3 pl-5 text-sm leading-6 text-muted-foreground md:block`}
          >
            {copy.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
      </main>
    </div>
  );
}
