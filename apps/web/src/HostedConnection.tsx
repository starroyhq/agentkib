import { useEffect, useState, type FormEvent } from "react";
import { parseLanOrigin } from "@agentkib/web-client";
import { SessionApp } from "./App";
import { dictionaries, type Locale } from "./i18n";
import { Monitor, ArrowRight, ShieldAlert } from "lucide-react";
import { connectionCopy } from "./connection-copy";
import "./connection.css";

export function HostedConnection() {
  const [address, setAddress] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("connect") ?? "",
  );
  const [origin, setOrigin] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [acknowledged, setAcknowledged] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [locale, setLocale] = useState<Locale>("zh-CN");
  const [theme, setTheme] = useState("system");
  const t = dictionaries[locale];
  const copy = connectionCopy[locale];
  useEffect(() => {
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  }, []);
  useEffect(() => {
    if (!origin) {
      document.documentElement.dataset.theme = theme;
      document.documentElement.lang = locale;
    }
  }, [origin, theme, locale]);
  function connect(event: FormEvent) {
    event.preventDefault();
    if (!acknowledged) return;
    try {
      setOrigin(parseLanOrigin(address));
      setAttempt((n) => n + 1);
      setInvalid(false);
    } catch {
      setInvalid(true);
    }
  }
  if (origin)
    return (
      <SessionApp
        key={attempt}
        origin={origin}
        initialLocale={locale}
        initialTheme={theme}
        disconnect={() => {
          setOrigin("");
          setAcknowledged(false);
        }}
      />
    );
  return (
    <div className="connection-shell">
      <header className="connection-header">
        <div className="brand">
          <img src="/favicon.svg" width="30" height="30" alt="" />
          <strong>
            AgentKib <span className="muted">Web</span>
          </strong>
        </div>
        <div className="connection-preferences">
          <label>
            {t.language}
            <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
              <option value="zh-CN">简体中文</option>
              <option value="zh-TW">繁體中文</option>
              <option value="en-US">English</option>
              <option value="ja-JP">日本語</option>
            </select>
          </label>
          <label>
            {t.theme}
            <select value={theme} onChange={(e) => setTheme(e.target.value)}>
              <option value="system">{t.system}</option>
              <option value="light">{t.light}</option>
              <option value="dark">{t.dark}</option>
            </select>
          </label>
        </div>
      </header>
      <main className="connection-grid">
        <section className="connection-guide" aria-labelledby="connection-title">
          <span className="connection-eyebrow">
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
        <section className="pair-page connection-panel" aria-labelledby="connection-form-title">
          <h2 id="connection-form-title">{copy.formTitle}</h2>
          <p>{t.lanPermission}</p>
          <form onSubmit={connect}>
            <label>
              {t.lanAddress}
              <input
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
            <label className="lan-consent">
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
            <button className="primary" disabled={!acknowledged}>
              {t.connect}
              <ArrowRight size={17} />
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
