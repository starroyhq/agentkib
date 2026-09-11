import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ChevronRight, MonitorSmartphone, ShieldCheck, Unlink } from "lucide-react";
import { PairingLayout } from "@/features/connection/pairing-layout";
import { useSession } from "@/features/sessions/session-context";
export function PairingPage() {
  const { t, access, pair, code, setCode, name, setName, busy, locale, post, origin, disconnect } =
    useSession();
  return !access ? (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center text-muted-foreground">
      <p role="status">{t.loading}</p>
    </main>
  ) : access.status === "unpaired" ? (
    <PairingLayout words={t}>
      <div className="grid size-14 place-items-center rounded-2xl border bg-muted/50 text-foreground">
        <MonitorSmartphone size={30} />
      </div>
      <h1>{t.pairTitle}</h1>
      <p>{t.pairInfo}</p>
      <form onSubmit={pair}>
        <label>
          {t.code}
          <Input
            className="h-14 text-center text-2xl tracking-[0.4em] tabular-nums"
            value={code}
            inputMode="numeric"
            pattern="[0-9]{8}"
            minLength={8}
            maxLength={8}
            autoComplete="one-time-code"
            required
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
        </label>
        <label>
          {t.name}
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <aside className="info">
          <ShieldCheck size={19} />
          <span>{t.scope}</span>
        </aside>
        <Button variant="default" className="h-11" disabled={busy || code.length !== 8}>
          {t.pair}
          <ChevronRight size={17} />
        </Button>
      </form>
      <small className="text-muted-foreground">{t.safety}</small>
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
      <div className="grid size-14 place-items-center rounded-2xl bg-destructive/10 text-destructive">
        <Unlink size={30} />
      </div>
      <h1>{t.ended}</h1>
      <p>{t.endedInfo}</p>
      <Button
        variant="default"
        className="h-11"
        onClick={() => (origin ? disconnect?.() : void post("logout", {}))}
      >
        {t.again}
      </Button>
    </main>
  ) : null;
}
