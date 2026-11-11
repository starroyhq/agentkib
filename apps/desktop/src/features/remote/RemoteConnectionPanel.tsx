import { useEffect, useRef, useState } from "react";
import { Monitor, Pencil, Plus, ShieldCheck, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SettingsNotice,
  SettingsPage,
  SettingsPageHeader,
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
import { remotePageCopy } from "./remote-page-copy";
import { remotePhoneCopy } from "./remote-phone-copy";
import { remoteNetworkCopy } from "./remote-network-copy";
import { CardIcon, clockTime } from "./RemoteCard";
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
  const { tr, locale } = useI18n();
  const copy = remotePageCopy[locale];
  const { snapshot, busy, run } = useRemoteStore();
  const [removing, setRemoving] = useState<string | null>(null);
  return (
    <div className="grid gap-2">
      {snapshot?.connections.map((host) => (
        <div key={host.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
          <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <strong className="break-words text-sm font-medium">{host.name}</strong>
            <span className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
              <SettingsStatus tone={host.status === "online" ? "success" : "neutral"}>
                {tr(`remote.state.${host.status}`)}
              </SettingsStatus>
              {host.status === "online" && <span>· {copy.viewOnly}</span>}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {!["revoked", "identity-changed", "expired", "rejected", "pending"].includes(
              host.status,
            ) && (
              <Button
                disabled={busy}
                variant="ghost"
                size="sm"
                onClick={() =>
                  void run({
                    operation: host.status === "online" ? "disconnect" : "connect",
                    id: host.id,
                  })
                }
              >
                {tr(host.status === "online" ? "remote.disconnect" : "remote.connect")}
              </Button>
            )}
            <Button
              disabled={busy}
              variant="ghost"
              size="sm"
              aria-label={`${tr("remote.remove")}: ${host.name}`}
              onClick={() => setRemoving(host.id)}
            >
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
    </div>
  );
}

/** "Add computer": the same window from settings and from the session page. */
export function RemoteConnectionPanel({
  open,
  onOpenChange,
  onSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSettings?: () => void;
}) {
  const { tr, locale } = useI18n();
  const { now } = useRemoteStatus();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{remotePageCopy[locale].addComputer}</DialogTitle>
          <DialogDescription className="sr-only">
            {remoteEntryCopy[locale].nativeDescription}
          </DialogDescription>
        </DialogHeader>
        <RemoteFeedback />
        {open && <QuickConnect now={now} onDone={() => onOpenChange(false)} />}
        {onSettings && (
          <Button
            variant="ghost"
            className="justify-self-start text-muted-foreground"
            onClick={onSettings}
          >
            {tr("remote.quick.settings")}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NameEditor({
  name,
  saved,
  error,
  disabled,
  onChange,
  onSave,
}: {
  name: string;
  saved: boolean;
  error: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onSave: () => Promise<boolean>;
}) {
  const { tr, locale } = useI18n();
  const copy = remotePageCopy[locale];
  const settings = remoteSettingsCopy[locale];
  const [editing, setEditing] = useState(false);
  async function save() {
    if (await onSave()) setEditing(false);
  }
  return (
    <div className="grid gap-1 text-sm">
      {editing || error ? (
        <Input
          autoFocus
          aria-label={tr("remote.name")}
          value={name}
          maxLength={64}
          disabled={disabled}
          className="h-8 w-48"
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void save();
            }
          }}
        />
      ) : (
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground">{tr("remote.name")}</span>
          <span className="break-all font-medium">{name}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={copy.editName}
            disabled={disabled}
            onClick={() => setEditing(true)}
          >
            <Pencil aria-hidden="true" />
          </Button>
        </span>
      )}
      {saved && (
        <small role="status" className="text-muted-foreground">
          {settings.saved}
        </small>
      )}
      {error && (
        <Button
          variant="link"
          size="content"
          className="justify-self-start"
          disabled={disabled}
          onClick={() => void save()}
        >
          {settings.retryName}
        </Button>
      )}
    </div>
  );
}

function ComputerConnectionSettings({
  network,
  name,
  onNameChange,
  onNameSave,
  nameSaved,
  nameError,
  networkBusy,
  onAddComputer,
}: {
  network: {
    address: string;
    interfaces: { name: string; address: string }[];
    save: (address?: string) => Promise<boolean>;
  };
  name: string;
  onNameChange: (value: string) => void;
  onNameSave: () => Promise<boolean>;
  nameSaved: boolean;
  nameError: boolean;
  networkBusy: boolean;
  onAddComputer: () => void;
}) {
  const { tr, formatDateTime, locale } = useI18n();
  const { snapshot, busy, now, run } = useRemoteStatus();
  const copy = remotePageCopy[locale];
  const [revoking, setRevoking] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [choice, setChoice] = useState("");
  const [starting, setStarting] = useState(false);
  const starts = useRef(false);
  const port = snapshot?.local.address?.split(":")[1] || "42987";
  const listeningAddress = network.address ? `${network.address}:${port}` : "";
  const disabled = busy || networkBusy || starting;
  const enabled = snapshot?.local.enabled ?? false;
  const liveCode =
    snapshot?.pairing_code &&
    snapshot.pairing_expires_at &&
    snapshot.pairing_expires_at * 1000 > now;
  const pending = snapshot?.pending.filter((request) => request.expires_at * 1000 > now) ?? [];
  async function startSharing() {
    if (
      starts.current ||
      disabled ||
      !snapshot ||
      !network.interfaces.some((i) => i.address === choice)
    )
      return;
    starts.current = true;
    setStarting(true);
    try {
      // The interface is shared with phone LAN access, so it is saved as that choice first.
      if (!(await network.save(choice))) return;
      const current = useRemoteStore.getState().snapshot;
      const result = await run({
        operation: "configure",
        enabled: true,
        address: `${choice}:${port}`,
        name: current?.local.name || "AgentKib",
      });
      if (result) setChoosing(false);
    } finally {
      starts.current = false;
      setStarting(false);
    }
  }
  return (
    <section className="rounded-xl border bg-card" aria-labelledby="remote-computers-title">
      <header className="flex items-start gap-3 p-5 pb-3">
        <CardIcon>
          <Monitor aria-hidden="true" />
        </CardIcon>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 id="remote-computers-title" className="text-base font-semibold">
            {copy.computers}
          </h2>
          <p className="text-sm text-muted-foreground">{copy.computersInfo}</p>
        </div>
      </header>
      <div className="grid gap-4 px-5 pb-5 sm:pl-[4.5rem]">
        <RemoteFeedback />
        <div
          id={settingsTargetId("remote-access")}
          tabIndex={-1}
          className="flex items-start justify-between gap-4 outline-none"
        >
          <div className="grid min-w-0 gap-0.5 text-sm">
            <strong className="font-medium">{copy.share}</strong>
            <span className="text-muted-foreground">
              {enabled
                ? tr("remote.listening", { address: snapshot?.local.address ?? "" })
                : copy.shareInfo}
            </span>
          </div>
          <Switch
            aria-label={copy.share}
            checked={enabled || choosing}
            disabled={disabled || !snapshot}
            onCheckedChange={(on) => {
              if (!on && !enabled) {
                setChoosing(false);
                return;
              }
              if (on && !network.address) {
                setChoice("");
                setChoosing(true);
                return;
              }
              void run({
                operation: "configure",
                enabled: on,
                // Stopping must remain possible when the shared interface is lost
                // or conflicts. The backend ignores this address when disabled.
                address: on ? listeningAddress : snapshot?.local.address || "127.0.0.1:42987",
                name: snapshot?.local.name || "AgentKib",
              });
            }}
          />
        </div>
        {choosing && !enabled && (
          <div className="grid gap-2 rounded-lg border bg-muted/40 p-4 text-sm">
            <label htmlFor="remote-share-network" className="font-medium">
              {copy.shareNetwork}
            </label>
            {network.interfaces.length ? (
              <div className="flex flex-wrap gap-2">
                <Select
                  value={choice || null}
                  disabled={disabled}
                  onValueChange={(value) => setChoice(value ?? "")}
                >
                  <SelectTrigger id="remote-share-network" className="min-w-0 flex-1">
                    <SelectValue placeholder={remoteNetworkCopy[locale].choose}>
                      {choice
                        ? `${network.interfaces.find((entry) => entry.address === choice)?.name ?? ""} · ${choice}`
                        : remoteNetworkCopy[locale].choose}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {network.interfaces.map((entry) => (
                        <SelectItem key={entry.address} value={entry.address}>
                          {entry.name} · {entry.address}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button disabled={disabled || !choice} onClick={() => void startSharing()}>
                  {copy.startSharing}
                </Button>
              </div>
            ) : (
              <p role="status">{tr("remote.noNetwork")}</p>
            )}
            <small className="text-muted-foreground">{copy.shareNetworkHint}</small>
          </div>
        )}
        {enabled && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border bg-muted/40 p-4">
            <div className="grid gap-1">
              <span className="text-xs text-muted-foreground">{tr("remote.code")}</span>
              {liveCode ? (
                <>
                  <strong className="font-mono text-2xl tracking-wider">
                    {snapshot.pairing_code!.replace(/^(\d{4})(\d{4})$/, "$1 $2")}
                  </strong>
                  <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    {copy.codeValid.replace(
                      "{time}",
                      clockTime(snapshot.pairing_expires_at! * 1000, locale),
                    )}
                    <span aria-hidden="true">·</span>
                    <Button
                      variant="link"
                      size="content"
                      className="text-xs"
                      disabled={busy}
                      onClick={() => void run({ operation: "generate-code" })}
                    >
                      {remotePhoneCopy[locale].regenerate}
                    </Button>
                  </span>
                </>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run({ operation: "generate-code" })}
                >
                  {tr("remote.generate")}
                </Button>
              )}
            </div>
            <p className="min-w-48 flex-1 text-sm text-muted-foreground">{copy.codeInfo}</p>
            <NameEditor
              name={name}
              saved={nameSaved}
              error={nameError}
              disabled={disabled || !snapshot}
              onChange={onNameChange}
              onSave={onNameSave}
            />
          </div>
        )}
        {!!pending.length && (
          <section aria-label={tr("remote.requests")} className="grid gap-2">
            <h3 className="text-sm font-medium">{tr("remote.requests")}</h3>
            {pending.map((request) => (
              <div key={request.id} className="grid gap-3 rounded-lg border p-4">
                <strong className="flex items-center gap-2 text-sm">
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
          </section>
        )}
        {!!snapshot?.authorized.length && (
          <section
            id={settingsTargetId("remote-devices")}
            tabIndex={-1}
            aria-label={copy.viewers}
            className="grid gap-2 outline-none"
          >
            <h3 className="text-sm font-medium">{copy.viewers}</h3>
            {snapshot.authorized.map((device) => (
              <div key={device.id} className="flex items-center gap-3 rounded-lg border p-3">
                <Wifi className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <strong className="break-words text-sm font-medium">{device.name}</strong>
                  <small className="text-muted-foreground">
                    {tr("remote.approvedAt")}: {formatDateTime(new Date(device.approved_at * 1000))}
                    {device.last_seen && (
                      <>
                        {" · "}
                        {tr("remote.lastSeen")}: {formatDateTime(new Date(device.last_seen * 1000))}
                      </>
                    )}
                  </small>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setRevoking(device.id)}
                >
                  {tr("remote.revoke")}
                </Button>
              </div>
            ))}
          </section>
        )}
        <div className="grid gap-2 border-t pt-4">
          <div className="flex items-center justify-between gap-3">
            <div className="grid gap-0.5 text-sm">
              <strong className="font-medium">{copy.connected}</strong>
              {!snapshot?.connections.length && (
                <span className="text-muted-foreground">{copy.noneYet}</span>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={onAddComputer}>
              <Plus aria-hidden="true" />
              {copy.addComputer}
            </Button>
          </div>
          {!!snapshot?.connections.length && <RemoteConnections />}
        </div>
      </div>
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
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
      if (element) {
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
  return (
    <SettingsPage variant="management">
      <SettingsPageHeader title={copy.title} />
      <WebAccessSettings
        advancedOpen={advancedOpen}
        onAdvancedOpenChange={setAdvancedOpen}
        advancedContent={network.content}
        advancedDirty={network.dirty}
        advancedBusy={network.busy || busy || nameSaving}
        advancedValid={network.valid}
        onSaveAdvanced={saveAdvanced}
        onDiscardAdvanced={network.reset}
      >
        <div className="space-y-3">
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
            network={network}
            networkBusy={network.busy || nameSaving}
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
            onAddComputer={() => setAddOpen(true)}
          />
        </div>
      </WebAccessSettings>
      {addOpen && <RemoteConnectionPanel open={addOpen} onOpenChange={setAddOpen} />}
    </SettingsPage>
  );
}
