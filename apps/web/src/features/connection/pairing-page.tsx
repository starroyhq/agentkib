import { Input } from "@/features/conversation/components/ui/input";
import { Button } from "@/features/conversation/components/ui/button";
import { ChevronRight, MonitorSmartphone, ShieldCheck, Unlink } from "lucide-react";
import { PairingLayout } from "@/features/connection/pairing-layout";
import { useSession } from "@/features/conversation/features/sessions/session-context";
import { codePairingCopy } from "./code-pairing-copy";
import { pairingErrorCopy, pairingErrorText } from "./pairing-error-copy";
import { useState } from "react";
import { beginComputerAccountLogin } from "./account-login";
import { accountLoginCopy } from "./account-login-copy";
export function PairingPage() {
  const {
    t,
    access,
    pair,
    code,
    setCode,
    name,
    setName,
    busy,
    pairingError,
    refresh,
    locale,
    post,
    connection,
    disconnect,
  } = useSession();
  const direct = connection.type === "same-origin" && access?.pairingMode === "code";
  const copy = codePairingCopy[locale];
  const cloud = accountLoginCopy[locale];
  const [signingIn, setSigningIn] = useState(false);
  const [loginError, setLoginError] = useState(false);
  if (access?.accountLogin?.required && !access.accountLogin.bound)
    return (
      <main className="mx-auto flex w-full max-w-lg flex-col justify-center gap-5 p-6 md:p-10">
        <h1>{cloud.title}</h1>
        <p>{cloud.info}</p>
        {loginError && <p role="alert">{cloud.unavailable}</p>}
        <Button
          disabled={signingIn}
          onClick={() => {
            setSigningIn(true);
            setLoginError(false);
            void beginComputerAccountLogin(access)
              .then((url) => location.assign(url))
              .catch(() => {
                setLoginError(true);
                setSigningIn(false);
              });
          }}
        >
          {cloud.login}
        </Button>
      </main>
    );
  return !access ? (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center text-muted-foreground">
      <p role="status">{t.loading}</p>
    </main>
  ) : access.status === "unpaired" ? (
    <PairingLayout words={direct ? { ...t, code: copy.code } : t} direct={direct}>
      <div className="grid size-14 place-items-center rounded-2xl border bg-muted/50 text-foreground">
        <MonitorSmartphone size={30} />
      </div>
      <h1>{direct ? copy.title : t.pairTitle}</h1>
      <p>{direct ? copy.info : t.pairInfo}</p>
      <form onSubmit={pair} aria-busy={busy}>
        <label>
          {direct ? copy.code : t.code}
          <Input
            className="h-14 text-center text-2xl tracking-[0.4em] tabular-nums"
            value={code}
            inputMode="numeric"
            pattern="[0-9]{8}"
            minLength={8}
            maxLength={8}
            autoComplete="one-time-code"
            required
            disabled={busy}
            aria-invalid={pairingError === "invalid_pairing_code" || undefined}
            aria-describedby={pairingError ? "pairing-error" : undefined}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
        </label>
        <label>
          {t.name}
          <Input
            value={name}
            maxLength={80}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <aside className="info">
          <ShieldCheck size={19} />
          <span>{direct ? copy.scope : t.scope}</span>
        </aside>
        {pairingError && (
          <div className="grid gap-2">
            <p id="pairing-error" role="alert" className="text-sm text-destructive-text">
              {pairingErrorText(locale, pairingError, direct ? "access" : "pairing")}
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void refresh(true)}
            >
              {t.retry}
            </Button>
          </div>
        )}
        <Button variant="default" className="h-11" disabled={busy || code.length !== 8}>
          {busy ? pairingErrorCopy[locale].requesting : direct ? copy.connect : t.pair}
          <ChevronRight size={17} />
        </Button>
      </form>
      <small className="text-muted-foreground">{direct ? copy.safety : t.safety}</small>
    </PairingLayout>
  ) : access.status === "pending" ? (
    <PairingLayout words={t} pending>
      <div className="grid size-14 place-items-center rounded-2xl bg-amber-500/10 text-amber-600">
        <ShieldCheck size={30} />
      </div>
      <h1>{t.pending}</h1>
      <p>{t.verify}</p>
      <strong className="rounded-xl border bg-muted/40 py-6 text-center text-3xl tracking-[0.25em] tabular-nums">
        {access.pending?.verification}
      </strong>
      {access.pending?.expiresAt && (
        <small>
          {t.expires} {new Date(access.pending.expiresAt).toLocaleString(locale)}
        </small>
      )}
      <aside className="info">{t.scope}</aside>
      <Button variant="ghost" onClick={() => void post("pair/cancel", {})} disabled={busy}>
        {t.cancel}
      </Button>
    </PairingLayout>
  ) : access.status === "ended" ? (
    <main className="mx-auto flex w-full max-w-lg flex-col gap-5 overflow-auto p-6 md:p-10">
      <div className="grid size-14 place-items-center rounded-2xl bg-destructive/10 text-destructive-icon">
        <Unlink size={30} />
      </div>
      <h1>{t.ended}</h1>
      <p>{t.endedInfo}</p>
      <Button
        variant="default"
        className="h-11"
        onClick={() => (connection.type === "lan-http" ? disconnect?.() : void post("logout", {}))}
      >
        {t.again}
      </Button>
    </main>
  ) : null;
}
