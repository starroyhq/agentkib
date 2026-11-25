import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import { cn } from "cn";
import { Switch } from "@/components/ui/switch";
import { desktopApi } from "@/core/desktop";
import { useI18n } from "@/core/useI18n";
import { remotePageCopy } from "@/features/remote/remote-page-copy";
import { remoteAccountCopy } from "@/features/remote/remote-account-copy";
import {
  needsRemoteAccountRelogin,
  OFFICIAL_BROKER_URL,
  RemoteAccountRelogin,
} from "@/features/remote/RemoteAccountRelogin";
import type { DesktopAccountStatus } from "../../../electron/main/account/state";
import type { WebAdminStatus } from "../../../electron/main/web/service";

/**
 * Remote access as the remote page reports it, with a switch to pause or resume it. The row is
 * left out until remote access has been set up; the first setup happens on the remote page.
 */
export function MenuBarRemote({
  status,
  onChanged,
  onOpenSettings,
}: {
  status: WebAdminStatus;
  onChanged: () => void;
  onOpenSettings: () => void;
}) {
  const { locale, tr } = useI18n();
  const pc = remotePageCopy[locale];
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const relay = status.config.relay;
  const official = relay?.brokerUrl?.replace(/\/$/, "") === OFFICIAL_BROKER_URL;
  const [accountStatus, setAccountStatus] = useState<DesktopAccountStatus>();
  useEffect(() => {
    if (!official) return;
    const account = desktopApi().account;
    if (!account) return;
    let current = true;
    let observed = false;
    const release = account.onStatus((value) => {
      observed = true;
      if (current) setAccountStatus(value);
    });
    void account
      .request({ operation: "status" })
      .then((value) => {
        if (current && !observed) setAccountStatus(value);
      })
      .catch(() => undefined);
    return () => {
      current = false;
      release();
    };
  }, [official]);
  if (!relay?.brokerUrl) return null;
  const relogin = official && needsRemoteAccountRelogin(accountStatus);
  const active = Boolean(relay.enabled);
  const phase = status.relay?.phase;
  const ready = !relogin && active && status.running && phase === "ready";
  const interrupted = relogin || (active && (phase === "error" || phase === "offline"));
  const state = relogin
    ? remoteAccountCopy[locale].accountSignedOut
    : !active
      ? pc.paused
      : ready
        ? pc.on
        : interrupted
          ? pc.interrupted
          : pc.connecting;
  // Who is connected says more than how many are paired.
  const online = status.devices.filter((device) => device.online);
  const presence = !ready
    ? undefined
    : online.length === 1
      ? tr("menubar.deviceOnline", { name: online[0].name })
      : online.length > 1
        ? tr("menubar.devicesOnline", { name: online[0].name, others: online.length - 1 })
        : undefined;
  const devices = ready ? pc.devices.replace("{count}", String(status.devices.length)) : undefined;
  const toggle = async (on: boolean) => {
    setBusy(true);
    setFailed(false);
    try {
      const result = (await desktopApi().web.request(
        on
          ? {
              operation: "remote-enable",
              brokerUrl: relay.brokerUrl,
              ...(relay.frpcPath ? { frpcPath: relay.frpcPath } : {}),
            }
          : { operation: "relay-stop" },
      )) as { error?: unknown } | undefined;
      if (result?.error) throw new Error(String(result.error));
    } catch {
      // Resuming may need a sign-in or a new code; the remote page walks through it.
      if (on) onOpenSettings();
      else setFailed(true);
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <div className="grid gap-1 px-4 py-2">
      <div className="flex items-center gap-2.5">
        <Smartphone aria-hidden="true" size={16} className="shrink-0 text-muted-foreground" />
        <span className="text-sm">{tr("menubar.remote")}</span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            ready
              ? "text-emerald-700 dark:text-emerald-400"
              : interrupted
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted-foreground",
          )}
        >
          {presence ?? (devices ? `${state} · ${devices}` : state)}
        </span>
        <Switch
          checked={active}
          disabled={busy}
          aria-label={tr("menubar.remote")}
          onCheckedChange={(checked) => void toggle(checked)}
        />
      </div>
      {relogin && (
        <div className="flex flex-wrap items-center gap-2 pl-[26px]">
          <RemoteAccountRelogin compact disabled={busy || !accountStatus?.secureStorage} />
        </div>
      )}
      {failed && (
        <p role="alert" className="pl-[26px] text-xs text-destructive-text">
          {tr("menubar.remoteFailed")}
        </p>
      )}
    </div>
  );
}
