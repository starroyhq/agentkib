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
import { subscribeVisiblePolling } from "./visible-polling";
import { relayUsageCopy } from "./relay-usage-copy";
import { trafficAmount } from "../../../electron/main/account/relay-usage";

export function RemoteAccountSettings({
  variant = "standalone",
  onStatusChange,
  primary = variant !== "footer",
  manageOpen: controlledOpen,
  onManageOpenChange,
}: {
  /** "dialog" renders only the account window, opened from the remote page's menu. */
  variant?: "standalone" | "step" | "footer" | "dialog";
  onStatusChange?: (status: DesktopAccountStatus | undefined) => void;
  primary?: boolean;
  manageOpen?: boolean;
  onManageOpenChange?: (open: boolean) => void;
} = {}) {
  const { locale } = useI18n();
  const c = remoteAccountCopy[locale];
  const p = remotePhoneCopy[locale];
  const traffic = relayUsageCopy[locale];
  const [localOpen, setLocalOpen] = useState(false);
  const manageOpen = controlledOpen ?? localOpen;
  // The account window opened from the page menu stays open through sign-in and sign-out.
  const dialogOnly = variant === "dialog";
  const setManageOpen = (open: boolean) => {
    setLocalOpen(open);
    onManageOpenChange?.(open);
  };
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
        if (value.phase !== "signed-in" && !dialogOnly) setLocalOpen(false);
        setFailed(false);
      }
    });
    let reading = false;
    const stopPolling = subscribeVisiblePolling({
      interval: 30_000,
      enabled: () => !locked.current,
      run: async () => {
        if (reading || locked.current) return;
        reading = true;
        const initial = revision.current;
        try {
          const value = await account.request({ operation: "status" });
          if (alive.current && initial === revision.current) {
            setStatus(value);
            setFailed(false);
          }
        } catch {
          if (alive.current && initial === revision.current) setFailed(true);
        } finally {
          reading = false;
        }
      },
    });
    return () => {
      alive.current = false;
      revision.current += 1;
      stopPolling();
      release();
    };
  }, [dialogOnly]);
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
            if (next.phase !== "signed-in" && !dialogOnly) setLocalOpen(false);
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
  const recovering = status?.phase === "error" && Boolean(status.account);
  const recoveringText = c.recovering.replace("{account}", status?.account?.username ?? "");
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
          {status?.relayUsage && (
            <section aria-label={traffic.title} className="space-y-2 break-words">
              <p className="font-medium">{traffic.title}</p>
              <p>
                {trafficAmount(status.relayUsage.usedBytes, locale)} /{" "}
                {trafficAmount(status.relayUsage.limitBytes, locale)}
              </p>
              <progress
                className="w-full"
                aria-label={traffic.title}
                max={1}
                value={Math.min(1, status.relayUsage.usedBytes / status.relayUsage.limitBytes)}
              />
              <p>
                {traffic.remaining}: {trafficAmount(status.relayUsage.remainingBytes, locale)}
              </p>
              <p>
                {traffic.reset}: {new Date(status.relayUsage.periodEnd).toLocaleString(locale)}
              </p>
              <p className="text-muted-foreground">
                {traffic.updated}: {new Date(status.relayUsage.updatedAt).toLocaleString(locale)}
              </p>
              <p className="text-muted-foreground">{traffic.hint}</p>
              {status.relayUsage.usedBytes >= status.relayUsage.limitBytes * 0.8 && (
                <p role="status">
                  {status.relayUsage.exhausted
                    ? traffic.exhausted
                    : status.relayUsage.usedBytes >= status.relayUsage.limitBytes * 0.95
                      ? traffic.almost
                      : traffic.warning}
                </p>
              )}
            </section>
          )}
          {status?.relayUsageUnavailable && <p role="alert">{traffic.unavailable}</p>}
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
          {status?.device?.ownership === "owned" && status.device.name && (
            <p className="text-muted-foreground leading-6">
              {c.appearsAs.replace("{name}", status.device.name)}
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
      {(signedIn || recovering) && (
        <>
          {signedIn && status?.device?.ownership === "unclaimed" && (
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
  if (dialogOnly)
    return (
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{c.title}</DialogTitle>
            <DialogDescription>{c.intro}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p role="status">
              {signingIn
                ? c.signingIn
                : signedIn
                  ? p.loggedIn.replace("{account}", status!.account!.username)
                  : recovering
                    ? recoveringText
                    : status
                      ? c.signedOut
                      : failed
                        ? c.unavailable
                        : c.loading}
            </p>
            {accountDetails}
            {actions}
            {signedIn && <p className="text-xs text-muted-foreground">{c.logoutHint}</p>}
          </div>
        </DialogContent>
      </Dialog>
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
                : recovering
                  ? recoveringText
                  : status
                    ? // The sign-in step's own heading already says to sign in first.
                      variant === "step"
                      ? ""
                      : c.signedOut
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
            : recovering
              ? recoveringText
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
