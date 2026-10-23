import { useEffect, useRef, useState } from "react";
import { Monitor, RefreshCw, Search, Share2, ShieldCheck, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
  SettingsPageHeader,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  settingsTargetRequestEvent,
  settingsTargetId,
} from "@/features/settings/components/SettingsLayout";
import { useI18n } from "@/core/useI18n";
import { subscribeRemoteStatus, useRemoteStore } from "./remote-store";
import { RemoteErrorDetails } from "./RemoteErrorDetails";
import { WebAccessSettings } from "./WebAccessSettings";
import { remoteEntryCopy } from "./remote-entry-copy";
import { QuickConnect } from "./QuickConnect";
import { remoteSettingsCopy } from "./remote-settings-copy";
import { useRemoteNetworkSettings } from "./RemoteNetworkSettings";
import { getWebAdminState } from "./web-status";

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
  const { loading, error: rawError, refresh, clearError, snapshot } = useRemoteStore();
  return (
    <>
      {loading && !snapshot && <p role="status">{tr("remote.loading")}</p>}
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
            variant="destructive"
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

function PairHost({ now, onEdit }: { now: number; onEdit?: () => void }) {
  const { tr, locale } = useI18n();
  const { snapshot, pairing, busy, loading, error, run } = useRemoteStore();
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
            {remoteSettingsCopy[locale].find}
          </Button>
        }
      >
        {snapshot && !snapshot.discovered.length && !loading && !busy && error === "" && (
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
                onEdit?.();
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
              onChange={(event) => {
                setAddress(event.target.value);
                onEdit?.();
              }}
              disabled={busy}
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            {tr("remote.code")}
            <Input
              value={code}
              onChange={(event) => {
                setCode(event.target.value.replace(/\D/g, "").slice(0, 8));
                onEdit?.();
              }}
              inputMode="numeric"
              maxLength={8}
              autoComplete="off"
              disabled={busy}
            />
          </label>
          <Button
            variant="outline"
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
  const { tr, locale } = useI18n();
  const { now } = useRemoteStatus();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{remoteEntryCopy[locale].nativeTitle}</DialogTitle>
          <DialogDescription>{remoteEntryCopy[locale].nativeDescription}</DialogDescription>
          <span className="text-xs text-muted-foreground">{tr("remote.quick.readonly")}</span>
        </DialogHeader>
        <RemoteFeedback />
        {open && <QuickConnect now={now} onDone={() => onOpenChange(false)} />}
        <Button
          variant="ghost"
          className="justify-self-start text-muted-foreground"
          onClick={onSettings}
        >
          {tr("remote.quick.settings")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function ComputerConnectionSettings({
  networkAddress,
  name,
  onNameChange,
  onNameSave,
  nameSaved,
  nameError,
  onShowAdvanced,
  networkBusy,
  revealSetup,
}: {
  networkAddress: string;
  name: string;
  onNameChange: (value: string) => void;
  onNameSave: () => Promise<boolean>;
  nameSaved: boolean;
  nameError: boolean;
  onShowAdvanced: () => void;
  networkBusy: boolean;
  revealSetup: boolean;
}) {
  const { tr, formatDateTime, locale } = useI18n();
  const { snapshot, busy, now, run } = useRemoteStatus();
  const copy = remoteSettingsCopy[locale];
  const [showSetup, setShowSetup] = useState(false);
  const focusSetup = useRef(false);
  const setup = useRef<HTMLElement>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const listeningAddress = networkAddress
    ? `${networkAddress}:${snapshot?.local.address?.split(":")[1] || "42987"}`
    : "";
  const disabled = busy || networkBusy;
  const empty = Boolean(
    snapshot &&
    !showSetup &&
    !revealSetup &&
    !snapshot.local.enabled &&
    !snapshot.authorized.length &&
    !snapshot.pending.some((request) => request.expires_at * 1000 > now) &&
    !snapshot.connections.length &&
    !snapshot.discovered.length,
  );
  useEffect(() => {
    if (showSetup && focusSetup.current) {
      setup.current?.focus();
      focusSetup.current = false;
    }
  }, [showSetup]);
  const liveCode =
    snapshot?.pairing_code &&
    snapshot.pairing_expires_at &&
    snapshot.pairing_expires_at * 1000 > now;
  return (
    <section className="space-y-6" aria-label={copy.computers}>
      <RemoteFeedback />
      {empty ? (
        <div className="grid justify-items-center gap-3 rounded-xl border bg-card px-6 py-10 text-center">
          <Monitor className="size-8 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-base font-semibold">{copy.emptyTitle}</h2>
          <p className="max-w-[60ch] text-sm text-muted-foreground">{copy.emptyInfo}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => {
                focusSetup.current = true;
                setShowSetup(true);
                void run({ operation: "discover" });
              }}
            >
              <Search aria-hidden="true" />
              {copy.discover}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                focusSetup.current = true;
                setShowSetup(true);
              }}
            >
              <Share2 aria-hidden="true" />
              {copy.shareAction}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <section
            ref={setup}
            tabIndex={-1}
            className="space-y-3 outline-none"
            aria-label={copy.share}
          >
            <SettingsSection title={copy.share} target="remote-access">
              <SettingsNotice>{tr("remote.readonly")}</SettingsNotice>
              <SettingsRow>
                <SettingsCopy>
                  <strong>{tr("remote.name")}</strong>
                </SettingsCopy>
                <div className="grid min-w-0 gap-1.5">
                  <Input
                    aria-label={tr("remote.name")}
                    value={name}
                    maxLength={64}
                    disabled={disabled || !snapshot}
                    onChange={(event) => onNameChange(event.target.value)}
                    onBlur={() => void onNameSave()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void onNameSave();
                      }
                    }}
                  />
                  {nameSaved && (
                    <small role="status" className="text-muted-foreground">
                      {copy.saved}
                    </small>
                  )}
                  {nameError && (
                    <Button
                      variant="link"
                      size="content"
                      disabled={disabled}
                      onClick={() => void onNameSave()}
                    >
                      {copy.retryName}
                    </Button>
                  )}
                </div>
              </SettingsRow>
              <SettingsRow>
                <SettingsCopy>
                  <strong>{copy.enable}</strong>
                  <small>
                    {snapshot?.local.enabled
                      ? tr("remote.listening", { address: snapshot.local.address })
                      : tr("remote.disabled")}
                  </small>
                </SettingsCopy>
                <Switch
                  aria-label={copy.enable}
                  checked={snapshot?.local.enabled ?? false}
                  disabled={disabled || !snapshot || (!snapshot.local.enabled && !networkAddress)}
                  onCheckedChange={(enabled) =>
                    void run({
                      operation: "configure",
                      enabled,
                      // Stopping must remain possible when the shared interface is lost
                      // or conflicts. The backend ignores this address when disabled.
                      address: enabled
                        ? listeningAddress
                        : snapshot?.local.address || "127.0.0.1:42987",
                      name: snapshot?.local.name || "AgentKib",
                    })
                  }
                />
              </SettingsRow>
              {!networkAddress && !snapshot?.local.enabled && (
                <SettingsNotice>
                  <div>
                    <p>{copy.networkRequired}</p>
                    <Button variant="link" size="content" onClick={onShowAdvanced}>
                      {copy.advanced}
                    </Button>
                  </div>
                </SettingsNotice>
              )}
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
                          variant="outline"
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
            {!!snapshot?.authorized.length && (
              <SettingsPanel title={tr("remote.authorized")} target="remote-devices">
                {snapshot?.authorized.map((device) => (
                  <div
                    key={device.id}
                    className="flex items-center justify-between gap-3 border-b p-4"
                  >
                    <div className="grid min-w-0 gap-1">
                      <strong className="flex items-center gap-2 text-sm">
                        <Wifi size={16} />
                        {device.name}
                      </strong>
                      <small className="text-muted-foreground">
                        {tr("remote.approvedAt")}:{" "}
                        {formatDateTime(new Date(device.approved_at * 1000))}
                      </small>
                      <p className="text-sm text-muted-foreground">{tr("remote.viewPermission")}</p>
                      {device.last_seen && (
                        <small className="text-muted-foreground">
                          {tr("remote.lastSeen")}:{" "}
                          {formatDateTime(new Date(device.last_seen * 1000))}
                        </small>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setRevoking(device.id)}
                    >
                      {tr("remote.revoke")}
                    </Button>
                  </div>
                ))}
              </SettingsPanel>
            )}
          </section>
          <section className="space-y-3" aria-label={copy.view}>
            <h2 className="text-base font-semibold">{copy.view}</h2>
            {!!snapshot?.connections.length && <RemoteConnections />}
            <PairHost now={now} onEdit={() => setShowSetup(true)} />
          </section>
        </>
      )}
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
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              if (revoking && (await run({ operation: "revoke", id: revoking }))) setRevoking(null);
            }}
          >
            {tr("remote.confirm")}
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function RemoteConnectionSettings() {
  const { locale } = useI18n();
  const copy = remoteSettingsCopy[locale];
  const { snapshot, busy, run } = useRemoteStore();
  const network = useRemoteNetworkSettings();
  const [tab, setTab] = useState("phone");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [revealSetup, setRevealSetup] = useState(false);
  const [focusTarget, setFocusTarget] = useState<"remote-access" | "remote-devices">();
  const [name, setName] = useState(() => snapshot?.local.name ?? "");
  const previousName = useRef(snapshot?.local.name);
  const [nameError, setNameError] = useState(false);
  const [nameSaving, setNameSaving] = useState(false);
  const [savedName, setSavedName] = useState<string>();
  const nameLocked = useRef(false);
  const nameValue = useRef(name);
  const alive = useRef(true);
  useEffect(() => {
    function reveal(event: Event) {
      const target = (event as CustomEvent<unknown>).detail;
      if (target !== "remote-access" && target !== "remote-devices") return;
      setTab("computers");
      setRevealSetup(true);
      setFocusTarget(target);
    }
    window.addEventListener(settingsTargetRequestEvent, reveal);
    return () => window.removeEventListener(settingsTargetRequestEvent, reveal);
  }, []);
  useEffect(() => {
    if (!focusTarget) return;
    const frame = requestAnimationFrame(() => {
      const element =
        document.getElementById(settingsTargetId(focusTarget)) ??
        document.getElementById(settingsTargetId("remote-access"));
      if (element && !element.closest("[hidden]")) {
        element.scrollIntoView({ block: "nearest" });
        element.focus({ preventScroll: true });
      }
      setFocusTarget(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusTarget]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const next = snapshot?.local.name;
    if (next === undefined) return;
    const previous = previousName.current;
    if (previous === undefined || nameValue.current === previous) {
      nameValue.current = next;
      setName(next);
    }
    previousName.current = next;
  }, [snapshot?.local.name]);
  const nameDirty = Boolean(snapshot && name.trim() !== snapshot.local.name);
  const validName = !!name.trim() && name.trim().length <= 64;
  async function saveAdvanced() {
    if (nameLocked.current || useRemoteStore.getState().busy || getWebAdminState().busy)
      return false;
    return network.save();
  }
  useEffect(() => {
    if (savedName === undefined) return;
    const timeout = setTimeout(() => setSavedName(undefined), 2_000);
    return () => clearTimeout(timeout);
  }, [savedName]);
  async function saveName() {
    if (
      !alive.current ||
      nameLocked.current ||
      network.busy ||
      getWebAdminState().busy ||
      useRemoteStore.getState().busy
    )
      return false;
    const current = useRemoteStore.getState().snapshot;
    const submitted = nameValue.current;
    const nextName = submitted.trim();
    if (!current || !nextName || nextName.length > 64) return false;
    if (nextName === current.local.name) {
      nameValue.current = nextName;
      setName(nextName);
      setNameError(false);
      return true;
    }
    if (current.local.enabled && !current.local.address) return false;
    nameLocked.current = true;
    setNameSaving(true);
    setSavedName(undefined);
    try {
      const result = await run({
        operation: "configure",
        enabled: current.local.enabled,
        // Keep the current listener unchanged; disabled configure still needs a
        // nonempty address but ignores this placeholder without binding to it.
        address: current.local.address ?? `${network.address || "127.0.0.1"}:42987`,
        name: nextName,
      });
      const saved = !!result && "local" in result && result.local.name === nextName;
      if (alive.current && nameValue.current === submitted) {
        setNameError(!saved);
        if (saved) {
          nameValue.current = nextName;
          setName(nextName);
          setSavedName(nextName);
        }
      }
      return saved;
    } finally {
      nameLocked.current = false;
      if (alive.current) setNameSaving(false);
    }
  }
  function showAdvanced() {
    setAdvancedOpen(true);
    requestAnimationFrame(() => {
      if (!alive.current) return;
      const trigger = document.getElementById("remote-advanced-trigger");
      trigger?.scrollIntoView({ block: "nearest" });
      trigger?.focus();
    });
  }
  return (
    <SettingsPage variant="management">
      <SettingsPageHeader title={copy.title} />
      <ToggleGroup
        aria-label={copy.title}
        value={[tab]}
        onValueChange={(values) => {
          if (values[0] === "phone" || values[0] === "computers") setTab(values[0]);
        }}
        className="rounded-lg border bg-card p-1"
        spacing={1}
      >
        <ToggleGroupItem
          value="phone"
          className="aria-pressed:bg-primary/10 aria-pressed:text-primary-text"
        >
          {copy.phone}
        </ToggleGroupItem>
        <ToggleGroupItem
          value="computers"
          className="aria-pressed:bg-primary/10 aria-pressed:text-primary-text"
        >
          {copy.computers}
        </ToggleGroupItem>
      </ToggleGroup>
      <WebAccessSettings
        phoneVisible={tab === "phone"}
        advancedOpen={advancedOpen}
        onAdvancedOpenChange={setAdvancedOpen}
        advancedContent={network.content}
        advancedDirty={network.dirty}
        advancedBusy={network.busy || busy || nameSaving}
        advancedValid={network.valid}
        onSaveAdvanced={saveAdvanced}
      >
        <div hidden={tab !== "computers"} className="space-y-3">
          {nameError && (
            <SettingsNotice tone="error" role="alert">
              {copy.saveFailed}
            </SettingsNotice>
          )}
          {nameDirty && !validName && (
            <SettingsNotice tone="error" role="alert">
              {copy.invalidName}
            </SettingsNotice>
          )}
          <ComputerConnectionSettings
            networkAddress={network.address}
            networkBusy={network.busy || nameSaving}
            revealSetup={revealSetup}
            name={name}
            onNameChange={(value) => {
              nameValue.current = value;
              setName(value);
              setNameError(false);
              setSavedName(undefined);
            }}
            onNameSave={saveName}
            nameSaved={
              savedName !== undefined &&
              savedName === snapshot?.local.name &&
              name.trim() === savedName
            }
            nameError={nameError}
            onShowAdvanced={showAdvanced}
          />
        </div>
      </WebAccessSettings>
    </SettingsPage>
  );
}
