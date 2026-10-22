import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { desktopApi } from "@/core/desktop";
import { useI18n } from "@/core/useI18n";
import type {
  DesktopAccountStatus,
  DesktopAccountRequest,
} from "../../../electron/main/account/state";
import { remoteAccountCopy } from "./remote-account-copy";
import { remotePhoneCopy } from "./remote-phone-copy";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { requestWebAdmin } from "./web-status";
import { withAsyncCleanup } from "@/lib/utils";

export function RemoteAccountSettings({
  variant = "standalone",
  onStatusChange,
  primary = variant !== "footer",
}: {
  variant?: "standalone" | "step" | "footer";
  onStatusChange?: (status: DesktopAccountStatus | undefined) => void;
  primary?: boolean;
} = {}) {
  const { locale } = useI18n();
  const c = remoteAccountCopy[locale];
  const p = remotePhoneCopy[locale];
  const [manageOpen, setManageOpen] = useState(false);
  const [status, setStatus] = useState<DesktopAccountStatus>();
  const [failed, setFailed] = useState(() => !desktopApi().account);
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const locked = useRef(false);
  const revision = useRef(0);
  useEffect(() => {
    alive.current = true;
    const account = desktopApi().account;
    if (!account) {
      return () => {
        alive.current = false;
      };
    }
    const release = account.onStatus((value) => {
      revision.current += 1;
      if (alive.current) {
        setStatus(value);
        if (value.phase !== "signed-in") setManageOpen(false);
        setFailed(false);
      }
    });
    const initial = revision.current;
    void account
      .request({ operation: "status" })
      .then((value) => {
        if (alive.current && initial === revision.current) setStatus(value);
      })
      .catch(() => {
        if (alive.current && initial === revision.current) setFailed(true);
      });
    return () => {
      alive.current = false;
      revision.current += 1;
      release();
    };
  }, []);
  useEffect(() => onStatusChange?.(status), [status, onStatusChange]);
  async function run(operation: DesktopAccountRequest["operation"]) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setFailed(false);
    const requestRevision = ++revision.current;
    await withAsyncCleanup(
      async () => {
        try {
          const next = await desktopApi().account.request({ operation });
          if (alive.current && requestRevision === revision.current) {
            setStatus(next);
            if (next.phase !== "signed-in") setManageOpen(false);
          }
          if (operation === "logout" || operation === "claim") {
            await requestWebAdmin({ operation: "status" });
          }
        } catch {
          if (alive.current) setFailed(true);
        }
      },
      () => {
        locked.current = false;
        if (alive.current) setBusy(false);
      },
    );
  }
  const signingIn = status?.phase === "signing-in";
  const signedIn = status?.phase === "signed-in" && Boolean(status.account);
  const errorText = status?.error
    ? ((
        {
          account_secure_storage_unavailable: c.storage,
          account_login_expired: c.expired,
          account_login_required: c.expired,
          account_login_timeout: c.timeout,
          account_device_conflict: c.conflict,
          device_limit: c.limit,
          account_device_limit: c.limit,
          account_remote_logout_unconfirmed: c.revokeFailed,
          account_connection_failed: c.unavailable,
          account_forbidden: c.suspended,
          account_claim_pending: c.claimPending,
          account_profile_refresh_failed: c.profileFailed,
          account_suspended: c.suspended,
        } as Record<string, string>
      )[status.error] ?? c.failed)
    : undefined;
  const accountDetails = (
    <>
      {signedIn && (
        <>
          <p>
            {c.quota}: {status!.account!.deviceCount} / {status!.account!.deviceLimit}
          </p>
          <p>
            {c.totp}: {status!.account!.totpEnabled ? c.on : c.off}
          </p>
          {status?.device && (
            <p className="text-muted-foreground leading-6">
              {status.device.ownership === "owned"
                ? c.owned
                : status.device.ownership === "other"
                  ? c.other
                  : c.unclaimed}
            </p>
          )}
        </>
      )}
      {status && !status.secureStorage && <p className="text-destructive-text">{c.storage}</p>}
      {errorText && (
        <p role="alert" className="text-destructive-text">
          {errorText}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-destructive-text">
          {c.unavailable}
        </p>
      )}
    </>
  );
  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {signingIn ? (
        <Button variant="outline" disabled={busy} onClick={() => void run("cancel-login")}>
          {c.cancel}
        </Button>
      ) : (
        !signedIn && (
          <>
            <Button
              variant={primary ? "default" : "outline"}
              disabled={busy || !status?.secureStorage}
              onClick={() => void run("login")}
            >
              {c.login}
            </Button>
            {variant === "step" && (
              <span className="text-xs text-muted-foreground">{p.registerHint}</span>
            )}
          </>
        )
      )}
      {signedIn && (
        <>
          {status?.device?.ownership === "unclaimed" && (
            <Button variant="outline" disabled={busy} onClick={() => void run("claim")}>
              {c.claim}
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={() => void run("manage")}>
            {variant === "standalone" ? c.manage : p.accountWebsite}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void run("logout")}>
            {c.logout}
          </Button>
        </>
      )}
      {(failed || errorText) && (
        <Button variant="outline" disabled={busy} onClick={() => void run("status")}>
          {c.retry}
        </Button>
      )}
    </div>
  );
  if (variant !== "standalone")
    return (
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status">
            {signingIn
              ? c.signingIn
              : signedIn
                ? p.loggedIn.replace("{account}", status!.account!.username)
                : status
                  ? c.signedOut
                  : failed
                    ? c.unavailable
                    : c.loading}
          </p>
          {signedIn && (
            <Button variant="link" onClick={() => setManageOpen(true)}>
              {c.manage}
            </Button>
          )}
        </div>
        {!signedIn && actions}
        {signedIn ? (
          <>
            {(errorText || status?.device?.ownership === "other" || !status?.secureStorage) &&
              accountDetails}
            <Dialog open={manageOpen} onOpenChange={setManageOpen}>
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>{c.manage}</DialogTitle>
                  <DialogDescription>{c.intro}</DialogDescription>
                </DialogHeader>
                {accountDetails}
                {actions}
                <p className="text-xs text-muted-foreground">{c.logoutHint}</p>
              </DialogContent>
            </Dialog>
          </>
        ) : (
          accountDetails
        )}
      </div>
    );
  return (
    <section
      className="space-y-3 border-b px-5 py-4 text-sm"
      aria-labelledby="remote-account-title"
    >
      <h3 id="remote-account-title" className="font-medium">
        {c.title}
      </h3>
      <p className="text-muted-foreground leading-6">{c.intro}</p>
      <p role="status">
        {signingIn
          ? c.signingIn
          : signedIn
            ? status!.account!.username
            : status
              ? c.signedOut
              : failed
                ? c.unavailable
                : c.loading}
      </p>
      {accountDetails}
      {actions}
      {signedIn && <p className="text-muted-foreground leading-6">{c.logoutHint}</p>}
    </section>
  );
}
