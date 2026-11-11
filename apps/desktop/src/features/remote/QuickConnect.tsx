import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, Monitor, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OtpField } from "@/components/ui/otp-field";
import { useI18n } from "@/core/useI18n";
import { useRemoteStore } from "./remote-store";
import { remotePageCopy } from "./remote-page-copy";
import { withAsyncCleanup } from "@/lib/utils";

/**
 * The "add computer" flow shared by settings and the session page: nearby computers first, then
 * the pairing code (sent as soon as all eight digits are in), then the other computer's approval.
 */
export function QuickConnect({ now, onDone }: { now: number; onDone: () => void }) {
  const { tr, locale } = useI18n();
  const copy = remotePageCopy[locale];
  const { snapshot, pairing, busy, run } = useRemoteStore();
  const pending = Boolean(
    pairing &&
    pairing.expires_at * 1000 > now &&
    (!snapshot?.connections.find((h) => h.id === pairing.id) ||
      snapshot.connections.find((h) => h.id === pairing.id)?.status === "pending"),
  );
  const [step, setStep] = useState<"list" | "pair" | "result">(pending ? "result" : "list");
  const [target, setTarget] = useState<{ name: string; address: string } | null>(null);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [connectedId, setConnectedId] = useState<string | null>(null);
  const discoveredOnce = useRef(false);
  const locked = useRef(false);
  const mounted = useRef(true);
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useRef("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const discover = useCallback(async () => {
    if (locked.current || useRemoteStore.getState().busy) return;
    locked.current = true;
    setSearching(true);
    await withAsyncCleanup(
      () => run({ operation: "discover" }),
      () => {
        locked.current = false;
        if (mounted.current) setSearching(false);
      },
    );
  }, [run]);
  useEffect(() => {
    if (step === "list" && !busy && !discoveredOnce.current) {
      discoveredOnce.current = true;
      void discover();
    }
  }, [step, busy, discover]); // One discovery per mounted opening, including under StrictMode.
  useEffect(() => {
    if (step === "list") {
      const buttons = root.current?.querySelectorAll<HTMLButtonElement>("button");
      const previous = Array.from(buttons ?? []).find(
        (button) => button.dataset.focusKey === returnFocus.current && !button.disabled,
      );
      (previous ?? Array.from(buttons ?? []).find((button) => !button.disabled))?.focus();
    } else root.current?.querySelector<HTMLElement>("input, [data-step-heading]")?.focus();
  }, [step]);
  const host = snapshot?.connections.find((h) => h.id === (connectedId ?? pairing?.id));
  const online = host?.status === "online";
  const expired = pairing && pairing.expires_at * 1000 <= now;
  const disabled = busy || submitting || searching;
  const nearby =
    snapshot?.discovered.filter((h) => !snapshot.connections.some((saved) => saved.id === h.id)) ??
    [];
  const reconnectable =
    snapshot?.connections.filter(
      (item) =>
        !["online", "pending", "revoked", "identity-changed", "expired", "rejected"].includes(
          item.status,
        ),
    ) ?? [];
  async function pair(value: string) {
    if (locked.current || disabled || pending || !address.trim() || !/^\d{8}$/.test(value)) return;
    locked.current = true;
    setSubmitting(true);
    await withAsyncCleanup(
      async () => {
        const result = await run({ operation: "pair", address: address.trim(), code: value });
        if (mounted.current && result) {
          setCode("");
          setConnectedId(null);
          setStep("result");
        }
      },
      () => {
        locked.current = false;
        if (mounted.current) setSubmitting(false);
      },
    );
  }
  function openManual(focusKey: string) {
    returnFocus.current = focusKey;
    setTarget(null);
    setAddress("");
    setCode("");
    setStep("pair");
  }
  return (
    <div ref={root} className="min-h-0 space-y-4">
      {step === "list" && (
        <>
          {pending && (
            <Button
              variant="outline"
              data-focus-key="resume"
              onClick={(event) => {
                returnFocus.current = event.currentTarget.dataset.focusKey ?? "";
                setConnectedId(null);
                setStep("result");
              }}
            >
              {tr("remote.quick.resume")}
            </Button>
          )}
          {searching ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              {copy.searching}
            </p>
          ) : nearby.length ? (
            <section aria-label={tr("remote.nearby")} className="grid gap-2">
              {nearby.map((item) => (
                <div key={item.id} className="flex items-center gap-3 rounded-lg border p-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                    <Monitor className="size-4 text-muted-foreground" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium">{item.name}</span>
                    <span className="block break-all font-mono text-xs text-muted-foreground">
                      {item.address}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    data-focus-key={`discover:${item.id}`}
                    disabled={disabled || pending}
                    aria-label={`${tr("remote.pair")}: ${item.name}`}
                    onClick={(event) => {
                      returnFocus.current = event.currentTarget.dataset.focusKey ?? "";
                      setTarget(item);
                      setAddress(item.address);
                      setCode("");
                      setStep("pair");
                    }}
                  >
                    {copy.pair}
                  </Button>
                </div>
              ))}
            </section>
          ) : (
            <section className="grid justify-items-start gap-2">
              <Search className="size-5 text-muted-foreground" aria-hidden="true" />
              <h3 className="text-sm font-semibold">{copy.notFoundTitle}</h3>
              <p className="text-sm text-muted-foreground">{copy.notFoundInfo}</p>
              <Button
                variant="outline"
                size="sm"
                data-focus-key="search"
                disabled={disabled}
                onClick={(event) => {
                  returnFocus.current = event.currentTarget.dataset.focusKey ?? "";
                  void discover();
                }}
              >
                <RefreshCw aria-hidden="true" />
                {tr("remote.quick.searchAgain")}
              </Button>
            </section>
          )}
          {!!reconnectable.length && (
            <section className="grid gap-2">
              <h3 className="text-sm font-medium">{tr("remote.quick.saved")}</h3>
              {reconnectable.map((item) => (
                <div key={item.id} className="flex items-center gap-3 rounded-lg border p-3">
                  <Monitor size={18} className="shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium">{item.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {tr(`remote.state.${item.status}`)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    data-focus-key={`connect:${item.id}`}
                    disabled={disabled}
                    onClick={async (event) => {
                      if (locked.current) return;
                      returnFocus.current = event.currentTarget.dataset.focusKey ?? "";
                      locked.current = true;
                      setSubmitting(true);
                      await withAsyncCleanup(
                        async () => {
                          const result = await run({ operation: "connect", id: item.id });
                          if (
                            mounted.current &&
                            result &&
                            "local" in result &&
                            result.connections.some(
                              (h) => h.id === item.id && h.status === "online",
                            )
                          ) {
                            setConnectedId(item.id);
                            setStep("result");
                          }
                        },
                        () => {
                          locked.current = false;
                          if (mounted.current) setSubmitting(false);
                        },
                      );
                    }}
                  >
                    {tr("remote.connect")}
                  </Button>
                </div>
              ))}
            </section>
          )}
          <div className="border-t pt-3">
            <Button
              variant="link"
              size="content"
              data-focus-key="manual"
              disabled={disabled || pending}
              onClick={(event) => openManual(event.currentTarget.dataset.focusKey ?? "")}
            >
              {nearby.length || searching ? copy.notFoundLink : copy.enterAddress}
            </Button>
          </div>
        </>
      )}
      {step === "pair" && (
        <div className="space-y-4">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 text-muted-foreground"
            disabled={submitting}
            onClick={() => {
              setCode("");
              setStep("list");
            }}
          >
            <ArrowLeft size={16} />
            {target ? target.name : tr("remote.nearby")}
          </Button>
          {target ? (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">
                {copy.codeTitle.replace("{name}", target.name)}
              </h3>
              <OtpField
                length={8}
                value={code}
                disabled={disabled || pending}
                aria-label={tr("remote.code")}
                onValueChange={(value) => setCode(value)}
                onValueComplete={(value) => void pair(value)}
              />
              <p className="text-sm text-muted-foreground">{copy.codeWhere}</p>
              {submitting && (
                <p role="status" className="text-sm text-muted-foreground">
                  {tr("remote.quick.submitting")}
                </p>
              )}
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void pair(code);
              }}
            >
              <label className="grid gap-2 text-sm">
                {copy.computerAddress}
                <Input
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="192.168.1.20:43123"
                  autoComplete="off"
                  className="font-mono"
                  disabled={disabled}
                />
              </label>
              <label className="grid gap-2 text-sm">
                {tr("remote.code")}
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
                  inputMode="numeric"
                  maxLength={8}
                  autoComplete="off"
                  className="font-mono"
                  disabled={disabled}
                  aria-describedby="quick-code-hint"
                />
              </label>
              <p id="quick-code-hint" className="text-sm text-muted-foreground">
                {tr("remote.quick.codeHint")}
              </p>
              <Button
                type="submit"
                className="w-full"
                disabled={disabled || pending || !address.trim() || !/^\d{8}$/.test(code)}
              >
                {tr(submitting ? "remote.quick.submitting" : "remote.pair")}
              </Button>
            </form>
          )}
        </div>
      )}
      {step === "result" && (
        <div className="space-y-3" role="status">
          {!online && (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 text-muted-foreground"
              onClick={() => {
                setCode("");
                setStep("list");
              }}
            >
              <ArrowLeft size={16} />
              {tr("remote.quick.back")}
            </Button>
          )}
          <p data-step-heading tabIndex={-1} className="font-medium">
            {online
              ? tr("remote.quick.connected")
              : host && host.status !== "pending"
                ? tr(`remote.state.${host.status}`)
                : expired
                  ? tr("remote.expired")
                  : tr("remote.waitApproval")}
          </p>
          {!online && (!host || host.status === "pending") && !expired && pairing && (
            <>
              <strong className="block font-mono text-2xl tracking-widest">
                {pairing.verification}
              </strong>
              <p className="text-sm text-muted-foreground">{tr("remote.compare")}</p>
            </>
          )}
          {online && <Button onClick={onDone}>{tr("remote.quick.done")}</Button>}
        </div>
      )}
    </div>
  );
}
