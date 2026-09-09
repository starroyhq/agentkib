import { useEffect, useState } from "react";
import { Monitor, RefreshCw, ShieldCheck, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SettingsCopy,
  SettingsNotice,
  SettingsPage,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from "@/features/settings/components/SettingsLayout";
import { useI18n } from "@/core/useI18n";
import { subscribeRemoteStatus, useRemoteStore } from "./remote-store";
import { RemoteErrorDetails } from "./RemoteErrorDetails";
import { WebAccessSettings } from "./WebAccessSettings";

function useRemoteStatus() {
  const store = useRemoteStore();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    return subscribeRemoteStatus(() => {
      setNow(Date.now());
    }, 2_000);
  }, [store.refresh]);
  return { ...store, now };
}

function RemoteFeedback() {
  const { tr } = useI18n();
  const { loading, error: rawError, refresh, clearError } = useRemoteStore();
  return (
    <>
      {loading && !useRemoteStore.getState().snapshot && (
        <p role="status">{tr("remote.loading")}</p>
      )}
      {rawError !== "" && (
        <SettingsNotice tone="error" inset={false} role="alert">
          <RemoteErrorDetails error={rawError} />
          <Button variant="outline" onClick={() => void refresh()}>
            {tr("remote.retry")}
          </Button>
          <Button variant="ghost" onClick={clearError}>
            {tr("common.close")}
          </Button>
        </SettingsNotice>
      )}
    </>
  );
}

function RemoteConnections() {
  const { tr, formatDateTime } = useI18n();
  const { snapshot, busy, run } = useRemoteStore();
  const [removing, setRemoving] = useState<string | null>(null);
  return (
    <SettingsPanel title={tr("remote.connections")} contentClassName="divide-y divide-border/60">
      {!snapshot?.connections.length && (
        <p className="p-4 text-sm text-muted-foreground">{tr("remote.noConnections")}</p>
      )}
      {snapshot?.connections.map((host) => (
        <div key={host.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="grid min-w-0 gap-1">
            <strong className="flex items-center gap-2 text-sm">
              <Monitor size={16} />
              {host.name}
            </strong>
            <span className="break-all text-sm text-muted-foreground">{host.address}</span>
            <SettingsStatus tone={host.status === "online" ? "success" : "neutral"}>
              {tr(`remote.state.${host.status}`)}
            </SettingsStatus>
            {host.last_seen && (
              <small className="text-muted-foreground">
                {tr("remote.lastSeen")}: {formatDateTime(new Date(host.last_seen * 1000))}
              </small>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                busy ||
                ["revoked", "identity-changed", "expired", "rejected", "pending"].includes(
                  host.status,
                )
              }
              variant="outline"
              onClick={() =>
                void run({
                  operation: host.status === "online" ? "disconnect" : "connect",
                  id: host.id,
                })
              }
            >
              {tr(host.status === "online" ? "remote.disconnect" : "remote.connect")}
            </Button>
            <Button disabled={busy} variant="ghost" onClick={() => setRemoving(host.id)}>
              {tr("remote.remove")}
            </Button>
          </div>
        </div>
      ))}
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tr("remote.remove")}</DialogTitle>
            <DialogDescription>{tr("remote.removeConfirm")}</DialogDescription>
          </DialogHeader>
          <Button
            disabled={busy}
            onClick={async () => {
              if (removing && (await run({ operation: "remove", id: removing }))) setRemoving(null);
            }}
          >
            {tr("remote.confirm")}
          </Button>
        </DialogContent>
      </Dialog>
    </SettingsPanel>
  );
}

function PairHost({ now }: { now: number }) {
  const { tr } = useI18n();
  const { snapshot, pairing, busy, run } = useRemoteStore();
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [submitted, setSubmitted] = useState(Boolean(pairing));
  const validCode = /^\d{8}$/.test(code);
  const pairingConnection = pairing && snapshot?.connections.find((host) => host.id === pairing.id);
  const paired = pairingConnection?.status === "online";
  const expired = pairing && pairing.expires_at * 1000 <= now;
  return (
    <>
      <SettingsPanel
        title={tr("remote.nearby")}
        action={
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => void run({ operation: "discover" })}
          >
            <RefreshCw size={15} />
            {tr("remote.discover")}
          </Button>
        }
      >
        {!snapshot?.discovered.length && (
          <p className="p-4 text-sm text-muted-foreground">{tr("remote.noNearby")}</p>
        )}
        {snapshot?.discovered.map((host) => (
          <div key={host.id} className="flex items-center justify-between gap-3 border-b p-4">
            <div className="min-w-0">
              <strong className="block truncate text-sm">{host.name}</strong>
              <span className="break-all text-sm text-muted-foreground">{host.address}</span>
            </div>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setAddress(host.address);
                setSubmitted(false);
              }}
            >
              {tr("remote.select")}
            </Button>
          </div>
        ))}
      </SettingsPanel>
      <SettingsPanel title={tr("remote.pair")} contentClassName="p-4">
        <form
          className="grid gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!validCode || !address.trim()) return;
            if (await run({ operation: "pair", address: address.trim(), code })) {
              setCode("");
              setSubmitted(true);
            }
          }}
        >
          <label className="grid gap-1.5 text-sm">
            {tr("remote.address")}
            <Input
              placeholder="192.168.1.20:43123"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              disabled={busy}
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            {tr("remote.code")}
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
              inputMode="numeric"
              maxLength={8}
              autoComplete="off"
              disabled={busy}
            />
          </label>
          <Button
            className="justify-self-end"
            type="submit"
            disabled={busy || !validCode || !address.trim()}
          >
            {tr("remote.pair")}
          </Button>
        </form>
        {submitted && pairing && (
          <SettingsNotice inset={false} className="mt-3" role="status">
            <div>
              {paired ? (
                tr("remote.paired")
              ) : pairingConnection && pairingConnection.status !== "pending" ? (
                tr(`remote.state.${pairingConnection.status}`)
              ) : expired ? (
                tr("remote.expired")
              ) : (
                <>
                  <p>{tr("remote.waitApproval")}</p>
                  <strong className="my-2 block font-mono text-xl tracking-widest">
                    {pairing.verification}
                  </strong>
                  <p>{tr("remote.compare")}</p>
                </>
              )}
            </div>
          </SettingsNotice>
        )}
      </SettingsPanel>
    </>
  );
}

export function RemoteConnectionPanel({
  open,
  onOpenChange,
  onSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSettings: () => void;
}) {
  const { tr } = useI18n();
  const { now } = useRemoteStatus();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tr("settings.section.remote")}</DialogTitle>
          <DialogDescription>{tr("remote.readonly")}</DialogDescription>
        </DialogHeader>
        <RemoteFeedback />
        <RemoteConnections />
        <PairHost now={now} />
        <Button variant="outline" onClick={onSettings}>
          {tr("remote.fullSettings")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export function RemoteConnectionSettings() {
  const { tr, formatDateTime } = useI18n();
  const { snapshot, busy, now, run } = useRemoteStatus();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [revoking, setRevoking] = useState<string | null>(null);
  useEffect(() => {
    setName(snapshot?.local.name ?? "");
    setAddress(snapshot?.local.address?.split(":")[0] ?? "");
  }, [snapshot?.local.name, snapshot?.local.address]);
  const interfaceAddress = address || snapshot?.interfaces[0]?.address || "";
  const listeningAddress = interfaceAddress
    ? `${interfaceAddress}:${snapshot?.local.address?.split(":")[1] || "42987"}`
    : "";
  const liveCode =
    snapshot?.pairing_code &&
    snapshot.pairing_expires_at &&
    snapshot.pairing_expires_at * 1000 > now;
  return (
    <SettingsPage variant="management">
      <WebAccessSettings />
      <RemoteFeedback />
      <SettingsSection title={tr("remote.access")} target="remote-access">
        <SettingsNotice>{tr("remote.readonly")}</SettingsNotice>
        <SettingsRow>
          <SettingsCopy>
            <strong>{tr("remote.name")}</strong>
          </SettingsCopy>
          <Input
            aria-label={tr("remote.name")}
            value={name}
            maxLength={64}
            disabled={busy || !snapshot}
            onChange={(event) => setName(event.target.value)}
          />
        </SettingsRow>
        <SettingsRow>
          <SettingsCopy>
            <strong>{tr("remote.network")}</strong>
            <small>{tr("remote.networkHint")}</small>
          </SettingsCopy>
          <Select
            value={interfaceAddress}
            disabled={busy || !snapshot}
            onValueChange={(value) => {
              if (value !== null) setAddress(value);
            }}
          >
            <SelectTrigger className="h-9 max-w-full" aria-label={tr("remote.network")}>
              <SelectValue>
                {snapshot?.interfaces.find((network) => network.address === interfaceAddress)
                  ?.name ?? tr("remote.noNetwork")}
                {interfaceAddress && ` · ${interfaceAddress}`}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {!snapshot?.interfaces.length && (
                <SelectItem value="">{tr("remote.noNetwork")}</SelectItem>
              )}
              {snapshot?.interfaces.map((network) => (
                <SelectItem key={network.address} value={network.address}>
                  {network.name} · {network.address}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow>
          <SettingsCopy>
            <strong>{tr("remote.enable")}</strong>
            <small>
              {snapshot?.local.enabled
                ? tr("remote.listening", { address: snapshot.local.address })
                : tr("remote.disabled")}
            </small>
          </SettingsCopy>
          <Switch
            aria-label={tr("remote.enable")}
            checked={snapshot?.local.enabled ?? false}
            disabled={busy || !snapshot || (!snapshot.local.enabled && !interfaceAddress)}
            onCheckedChange={(enabled) =>
              void run({
                operation: "configure",
                enabled,
                address: listeningAddress,
                name: name.trim() || snapshot?.local.name || "AgentKib",
              })
            }
          />
        </SettingsRow>
        <div className="flex justify-end p-4">
          <Button
            disabled={busy || !snapshot || !name.trim()}
            variant="outline"
            onClick={() =>
              void run({
                operation: "configure",
                enabled: snapshot?.local.enabled ?? false,
                address: listeningAddress,
                name: name.trim(),
              })
            }
          >
            {tr("remote.save")}
          </Button>
        </div>
        {snapshot?.local.enabled && (
          <div className="grid gap-3 border-t p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">{tr("remote.code")}</span>
              <Button
                disabled={busy}
                variant="outline"
                onClick={() => void run({ operation: "generate-code" })}
              >
                {tr("remote.generate")}
              </Button>
            </div>
            {liveCode && (
              <>
                <strong className="font-mono text-2xl tracking-[0.25em]">
                  {snapshot.pairing_code}
                </strong>
                <p className="text-sm text-muted-foreground">{tr("remote.codeHint")}</p>
              </>
            )}
          </div>
        )}
      </SettingsSection>
      {!!snapshot?.pending.length && (
        <SettingsPanel title={tr("remote.requests")}>
          {snapshot.pending
            .filter((request) => request.expires_at * 1000 > now)
            .map((request) => (
              <div key={request.id} className="grid gap-3 border-b p-4">
                <strong className="flex items-center gap-2">
                  <ShieldCheck size={16} />
                  {request.name}
                </strong>
                <p className="text-sm">{tr("remote.compare")}</p>
                <strong className="font-mono text-2xl tracking-widest">
                  {request.verification}
                </strong>
                <SettingsNotice tone="warning" inset={false}>
                  {tr("remote.grantScope")}
                </SettingsNotice>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run({ operation: "reject", id: request.id })}
                  >
                    {tr("remote.reject")}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => void run({ operation: "approve", id: request.id })}
                  >
                    {tr("remote.approve")}
                  </Button>
                </div>
              </div>
            ))}
        </SettingsPanel>
      )}
      <SettingsPanel title={tr("remote.authorized")} target="remote-devices">
        {!snapshot?.authorized.length && (
          <p className="p-4 text-sm text-muted-foreground">{tr("remote.noAuthorized")}</p>
        )}
        {snapshot?.authorized.map((device) => (
          <div key={device.id} className="flex items-center justify-between gap-3 border-b p-4">
            <div className="grid min-w-0 gap-1">
              <strong className="flex items-center gap-2 text-sm">
                <Wifi size={16} />
                {device.name}
              </strong>
              <small className="text-muted-foreground">
                {tr("remote.approvedAt")}: {formatDateTime(new Date(device.approved_at * 1000))}
              </small>
              <p className="text-sm text-muted-foreground">{tr("remote.viewPermission")}</p>
              {device.last_seen && (
                <small className="text-muted-foreground">
                  {tr("remote.lastSeen")}: {formatDateTime(new Date(device.last_seen * 1000))}
                </small>
              )}
            </div>
            <Button variant="outline" disabled={busy} onClick={() => setRevoking(device.id)}>
              {tr("remote.revoke")}
            </Button>
          </div>
        ))}
      </SettingsPanel>
      <RemoteConnections />
      <PairHost now={now} />
      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tr("remote.revoke")}</DialogTitle>
            <DialogDescription>{tr("remote.revokeConfirm")}</DialogDescription>
          </DialogHeader>
          <Button
            disabled={busy}
            onClick={async () => {
              if (revoking && (await run({ operation: "revoke", id: revoking }))) setRevoking(null);
            }}
          >
            {tr("remote.confirm")}
          </Button>
        </DialogContent>
      </Dialog>
    </SettingsPage>
  );
}
