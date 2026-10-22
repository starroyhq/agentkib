import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Check, ChevronRight, Copy, LoaderCircle, Smartphone, Wifi } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { remotePhoneCopy } from "./remote-phone-copy";
import type { DesktopAccountStatus } from "../../../electron/main/account/state";
import { requestWebAdmin, subscribeWebStatus } from "./web-status";
import { useI18n } from "@/core/useI18n";
import { withAsyncCleanup } from "@/lib/utils";
import {
  SettingsSection,
  SettingsRow,
  SettingsCopy,
  SettingsNotice,
} from "@/features/settings/components/SettingsLayout";
import type {
  WebAccessLevel,
  WebAdminRequest,
  WebAdminStatus,
  WebConfig,
} from "../../../electron/main/web/service";
import { webSettingsCopy } from "./web-settings-copy";
import { lanSettingsCopy } from "./lan-settings-copy";
import { remoteEntryCopy } from "./remote-entry-copy";
import { ConnectionQr } from "./ConnectionQr";
import { RemoteAccountSettings } from "./RemoteAccountSettings";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// setTimeout 的最大延迟约 24.8 天，超过会立即触发。
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const configFields = [
  "enabled",
  "port",
  "externalOrigin",
  "experimentalEnabled",
  "lanAddress",
  "allowPlaintext",
  "allowedWorkspaceIds",
  "extraRoots",
  "previewBytesPerSecond",
  "relay",
] as const;

function mergeConfigDraft(draft: WebConfig, previous: WebConfig, next: WebConfig): WebConfig {
  const merged = { ...next };
  for (const key of configFields) {
    // Remote connection operations can update config while unrelated form edits are unsaved.
    if (JSON.stringify(draft[key]) !== JSON.stringify(previous[key]))
      Object.assign(merged, { [key]: draft[key] });
  }
  return merged;
}

function comparableConfig(config: WebConfig) {
  return configFields.map((key) =>
    key === "extraRoots" ? (config.extraRoots?.map((root) => root.path) ?? []) : config[key],
  );
}

/**
 * 返回"当前时间"，只在下一个截止时间到达时刷新一次。
 * 页面里依赖时间的只有配对码过期和 relay 重试时间，没必要每秒重渲染整个设置页。
 */
function useDeadlineClock(...deadlines: Array<number | undefined>) {
  const [now, setNow] = useState(() => Date.now());
  const next = Math.min(
    ...deadlines.filter((deadline): deadline is number => deadline !== undefined && deadline > now),
  );
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const delay = Math.min(Math.max(0, next - Date.now()), MAX_TIMEOUT_MS);
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
    // 依赖 now：计时器提前触发时 next 不变，要靠 now 的变化重新挂一个计时器。
  }, [next, now]);
  return now;
}

export type WebAccessSettingsProps = {
  target?: "lan";
  phoneVisible?: boolean;
  children?: ReactNode;
  advancedContent?: ReactNode;
  onSaveAdvanced?: () => Promise<boolean>;
  advancedDirty?: boolean;
  advancedBusy?: boolean;
  advancedValid?: boolean;
  hideNetworkFields?: boolean;
  advancedOpen?: boolean;
  onAdvancedOpenChange?: (open: boolean) => void;
};

function SetupStep({
  number,
  title,
  hint,
  active,
  done,
  children,
}: {
  number: number;
  title: string;
  hint?: string;
  active?: boolean;
  done?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`relative flex gap-3 pb-5 last:pb-0 ${!active && !done ? "opacity-50" : ""}`}>
      <span
        className={`z-10 flex size-6 shrink-0 items-center justify-center rounded-full text-xs ${done ? "bg-emerald-500/10 text-emerald-600" : active ? "bg-primary text-primary-foreground" : "border bg-card text-muted-foreground"}`}
      >
        {done ? <Check className="size-3.5" aria-hidden="true" /> : number}
      </span>
      {number < 4 && (
        <span
          aria-hidden="true"
          className="absolute left-3 top-6 bottom-0 border-l border-border"
        />
      )}
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        {title && (
          <h4 className={`text-sm ${active ? "font-semibold" : "font-medium"}`}>{title}</h4>
        )}
        {hint && <p className="text-xs leading-5 text-muted-foreground">{hint}</p>}
        {children}
      </div>
    </div>
  );
}

export function WebAccessSettings({
  target,
  phoneVisible = true,
  children,
  advancedContent,
  onSaveAdvanced,
  advancedDirty = false,
  advancedBusy = false,
  advancedValid = true,
  hideNetworkFields = false,
  advancedOpen,
  onAdvancedOpenChange,
}: WebAccessSettingsProps = {}) {
  const { locale, tr, formatDateTime } = useI18n();
  const lan = target === "lan";
  const p = remotePhoneCopy[locale];
  const l = lanSettingsCopy[locale];
  const [localAdvancedOpen, setLocalAdvancedOpen] = useState(false);
  const [setupComplete, setSetupComplete] = useState(false);
  const setupInProgress = useRef(false);
  const [accountStatus, setAccountStatus] = useState<DesktopAccountStatus>();
  const [lanStatus, setLanStatus] = useState<WebAdminStatus>();
  const [lanUnavailable, setLanUnavailable] = useState(false);
  const [lanOpen, setLanOpen] = useState(false);
  const [newPhoneOpen, setNewPhoneOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<"pause" | "connection" | { device: string }>();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const r = remoteEntryCopy[locale];
  const c = { ...webSettingsCopy[locale], ...(lan ? l : {}) };
  const fieldPrefix = lan ? "lan-web" : "web";
  const [status, setStatus] = useState<WebAdminStatus>();
  // 默认保持原有行为（完全控制）；用户可在生成授权码前切换为只读。
  const [codeLevel, setCodeLevel] = useState<WebAccessLevel>("full");
  const codeAccess = !lan && status?.pairingMode === "code";
  const showLegacyPermissions =
    !codeAccess ||
    status?.devices.some((device) => device.accessMode !== "full") ||
    Boolean(status?.pending.length);
  const [config, setConfig] = useState<WebConfig>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [operationError, setOperationError] = useState<"save" | "request">();
  const [localSaveFailed, setLocalSaveFailed] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "failed">();
  const [operationBusy, setBusy] = useState(false);
  const busy = operationBusy || advancedBusy;
  const [activeOperation, setActiveOperation] = useState<WebAdminRequest["operation"]>();
  const [codeCopied, setCodeCopied] = useState(false);
  const [extraRootsText, setExtraRootsText] = useState<string>();
  const [relayBroker, setRelayBroker] = useState("");
  const [frpcPath, setFrpcPath] = useState("");
  const frpcHintId = useId();
  const invitationId = useId();
  const invitationHintId = useId();
  const generateHintId = useId();
  const saveHintId = useId();
  const [inviteCode, setInviteCode] = useState("");
  const [grants, setGrants] = useState<
    Record<
      string,
      {
        send: boolean;
        approve: boolean;
        manage?: boolean;
        files?: boolean;
        attachments?: boolean;
        advancedControl?: boolean;
        organize?: boolean;
        settings?: boolean;
        extendedApproval?: boolean;
      }
    >
  >({});
  const mounted = useRef(false);
  const locked = useRef(false);
  const serverConfig = useRef<WebConfig | undefined>(undefined);
  const now = useDeadlineClock(status?.code?.expiresAt, status?.relay?.retryAt);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeWebStatus(target, {
      status: (next) => {
        const previous = serverConfig.current;
        serverConfig.current = next.config;
        setStatus(next);
        // Defaults have no relay; a saved pause records an earlier explicit setup.
        // During setup started here, keep step three until its first browser is authorized.
        const previouslyConfigured = Boolean(
          next.relay?.publicUrl || next.config.relay?.enabled === false,
        );
        if (
          target !== "lan" &&
          (next.devices.length || (!setupInProgress.current && previouslyConfigured))
        ) {
          setSetupComplete(true);
          setupInProgress.current = false;
        }
        setConfig((old) =>
          old && previous ? mergeConfigDraft(old, previous, next.config) : next.config,
        );
        setRelayBroker((old) =>
          !previous || old === (previous.relay?.brokerUrl || "https://api.agentkib.com")
            ? next.config.relay?.brokerUrl || "https://api.agentkib.com"
            : old,
        );
        setFrpcPath((old) =>
          !previous || old === (previous.relay?.frpcPath || "")
            ? next.config.relay?.frpcPath || ""
            : old,
        );
      },
      error: () => setLoadFailed(true),
      success: () => setLoadFailed(false),
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [target]);
  useEffect(() => {
    if (lan) return;
    return subscribeWebStatus("lan", {
      status: setLanStatus,
      error: () => setLanUnavailable(true),
      success: () => setLanUnavailable(false),
    });
  }, [lan]);
  async function run(input: WebAdminRequest) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setActiveOperation(input.operation);
    setOperationError(undefined);
    setLoadFailed(false);
    return await withAsyncCleanup(
      async () => {
        try {
          const next = await requestWebAdmin({ ...input, ...(lan ? { target } : {}) });
          if (mounted.current) {
            setStatus(next);
            if (input.operation === "configure") {
              if (next.error) {
                setLocalSaveFailed(true);
                setSaveState("failed");
                setOperationError("save");
              } else {
                setConfig(next.config);
                setExtraRootsText(undefined);
                setLocalSaveFailed(false);
                let extraSaved = true;
                if (advancedDirty && onSaveAdvanced) {
                  try {
                    extraSaved = await onSaveAdvanced();
                  } catch {
                    extraSaved = false;
                  }
                }
                if (mounted.current) {
                  setSaveState(extraSaved ? "saved" : "failed");
                  if (!extraSaved) setOperationError("save");
                }
              }
            }
            if (input.operation === "remote-enable" && !next.error)
              setInviteCode((old) => (old === input.inviteCode ? "" : old));
            return next;
          }
        } catch {
          if (mounted.current) {
            setOperationError(input.operation === "configure" ? "save" : "request");
            if (input.operation === "configure") {
              setLocalSaveFailed(true);
              setSaveState("failed");
            }
          }
        }
      },
      () => {
        locked.current = false;
        if (mounted.current) {
          setBusy(false);
          setActiveOperation(undefined);
        }
      },
    );
  }
  async function copyPairingCode(code: string) {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(code);
      setCodeCopied(true);
      window.setTimeout(() => setCodeCopied(false), 1600);
    } catch {
      // Clipboard access can be unavailable in an embedded or restricted web view.
    }
  }
  const legacyBrokerUrls = ["https://remote.agentkib.com", "https://api.remote.agentkib.com"];
  const legacyBroker = legacyBrokerUrls.includes(
    status?.config.relay?.brokerUrl?.replace(/\/$/, "") ?? "",
  );
  const migrating = legacyBroker && relayBroker.replace(/\/$/, "") === "https://api.agentkib.com";
  const remoteEnabled =
    status?.relay?.phase === "ready" &&
    relayBroker.trim().replace(/\/$/, "") ===
      status.config.relay?.brokerUrl.trim().replace(/\/$/, "") &&
    frpcPath.trim() === (status.config.relay?.frpcPath ?? "").trim();
  const manualAccess =
    !lan &&
    status?.running &&
    !status.config.relay?.enabled &&
    (!status.relay || status.relay.phase === "disabled");
  const configToSave = config
    ? {
        ...config,
        ...(status?.config.relay?.enabled
          ? { externalOrigin: status.config.externalOrigin, relay: status.config.relay }
          : {}),
        ...(extraRootsText === undefined
          ? {}
          : {
              extraRoots: extraRootsText
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .map((path, index) => ({
                  id: `extra-${index}`,
                  name: path.split("/").filter(Boolean).at(-1) ?? path,
                  path,
                })),
            }),
      }
    : undefined;
  const localConfigDirty = Boolean(
    configToSave &&
    status &&
    JSON.stringify(comparableConfig(configToSave)) !==
      JSON.stringify(comparableConfig(status.config)),
  );
  const unsaved = localConfigDirty || localSaveFailed;
  const connectionDirty = Boolean(
    status &&
    (relayBroker.trim().replace(/\/$/, "") !==
      (status.config.relay?.brokerUrl || "https://api.agentkib.com").replace(/\/$/, "") ||
      frpcPath.trim() !== (status.config.relay?.frpcPath || "").trim()),
  );
  const brokerChanged = Boolean(
    status?.config.relay &&
    relayBroker.trim().replace(/\/$/, "") !== status.config.relay.brokerUrl.replace(/\/$/, ""),
  );
  const signedIn = accountStatus?.phase === "signed-in" && Boolean(accountStatus.account);
  const relayReady = status?.running && status.relay?.phase === "ready";
  const relayActive = Boolean(status?.config.relay?.enabled);
  const connectionDisabled =
    busy ||
    !config ||
    !relayBroker.trim() ||
    (legacyBroker && legacyBrokerUrls.includes(relayBroker.replace(/\/$/, ""))) ||
    ((status?.relay?.reason === "revoked" || migrating) && !inviteCode.trim());
  const enableConnection = () => {
    if (!setupComplete) setupInProgress.current = true;
    return run({
      operation: "remote-enable",
      brokerUrl: relayBroker,
      ...(frpcPath.trim() ? { frpcPath: frpcPath.trim() } : {}),
      ...(inviteCode ? { inviteCode } : {}),
      ...(status?.relay?.reason === "revoked" ? { reenroll: true } : {}),
    });
  };
  async function saveSettings() {
    if (busy || locked.current) return;
    if (!localConfigDirty && !localSaveFailed && !advancedDirty) {
      setOperationError(undefined);
      setSaveState(undefined);
      return;
    }
    if (localConfigDirty || localSaveFailed) {
      await run({ operation: "configure", ...configToSave! });
      return;
    }
    locked.current = true;
    setBusy(true);
    setOperationError(undefined);
    try {
      const saved = await onSaveAdvanced?.();
      if (mounted.current) {
        setSaveState(saved ? "saved" : "failed");
        if (!saved) setOperationError("save");
      }
    } catch {
      if (mounted.current) {
        setSaveState("failed");
        setOperationError("save");
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const generateHint = !status?.running
    ? lan
      ? c.generateNeedsLanService
      : c.generateNeedsService
    : !lan && !manualAccess && status.relay?.phase !== "ready"
      ? c.generateNeedsConnection
      : undefined;
  // Phone access requires the public connection even when the loopback service
  // remains available for manual HTTPS access after pausing the relay.
  const phoneGenerateHint = !status?.running
    ? c.generateNeedsService
    : !relayReady
      ? c.generateNeedsConnection
      : undefined;
  const levelLabel = (level: WebAccessLevel) =>
    level === "read" ? c.readOnlyAccess : c.fullAccess;
  const generateCode = () => {
    if (generateHint) return;
    return run({ operation: "generate-code", ...(codeAccess ? { access: codeLevel } : {}) });
  };
  const generatePhoneCode = () => {
    if (!relayReady) return;
    return generateCode();
  };
  const accessLevelSelect = codeAccess ? (
    <Select
      value={codeLevel}
      disabled={busy}
      onValueChange={(value) => {
        if (value === "read" || value === "full") setCodeLevel(value);
      }}
    >
      <SelectTrigger className="h-9 w-auto" aria-label={c.accessLevel}>
        <SelectValue>{levelLabel(codeLevel)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>{c.accessLevel}</SelectLabel>
          <SelectItem value="read">{c.readOnlyAccess}</SelectItem>
          <SelectItem value="full">{c.fullAccess}</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ) : null;
  const pairingCode =
    status?.code && status.code.expiresAt > now ? (
      <SettingsNotice className="items-center justify-end gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline justify-end gap-x-3 gap-y-1">
          <strong className="font-mono text-xl tracking-widest">{status.code.value}</strong>
          <p>
            {c.expires} {formatDateTime(new Date(status.code.expiresAt))}
          </p>
          {codeAccess && (
            <p>
              {c.accessLevel}: {levelLabel(status.code.access)}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void copyPairingCode(status.code!.value)}
        >
          {codeCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {tr(codeCopied ? "handoff.copied" : "common.copy")}
        </Button>
      </SettingsNotice>
    ) : null;
  const settingsForm = !config ? (
    <p>{c.loading}</p>
  ) : (
    <>
      <SettingsNotice id={saveHintId}>{c.saveHint}</SettingsNotice>
      <SettingsRow>
        <SettingsCopy>
          <strong>{c.enabled}</strong>
          <small>{status?.running ? `${c.running} · ${status.localUrl}` : c.stopped}</small>
        </SettingsCopy>
        <Checkbox
          aria-label={c.enabled}
          checked={config.enabled}
          disabled={busy}
          aria-describedby={saveHintId}
          onCheckedChange={(enabled) => setConfig({ ...config, enabled: enabled === true })}
        />
      </SettingsRow>
      {(!lan || !hideNetworkFields) && (
        <SettingsRow>
          <label htmlFor={`${fieldPrefix}-port`}>{c.port}</label>
          <Input
            id={`${fieldPrefix}-port`}
            type="number"
            min={1024}
            max={65535}
            value={config.port}
            disabled={busy}
            onChange={(e) => setConfig({ ...config, port: Number(e.target.value) })}
          />
        </SettingsRow>
      )}
      {lan ? (
        <>
          {!hideNetworkFields && (
            <SettingsRow>
              <label htmlFor="lan-web-address">{l.address}</label>
              <Select
                value={config.lanAddress || null}
                disabled={busy}
                onValueChange={(value) => setConfig({ ...config, lanAddress: value || "" })}
              >
                <SelectTrigger id="lan-web-address" className="max-w-full min-w-0">
                  <SelectValue placeholder={l.choose} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>{l.address}</SelectLabel>
                    {(status?.addresses ?? []).map(({ name, address }) => (
                      <SelectItem key={`${name}-${address}`} value={address}>
                        {name} · {address}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </SettingsRow>
          )}
          {!status?.addresses?.length && <SettingsNotice>{l.noAddress}</SettingsNotice>}
          {!!config.lanAddress &&
            !status?.addresses?.some(({ address }) => address === config.lanAddress) && (
              <SettingsNotice>{l.addressLost}</SettingsNotice>
            )}
          <div className="border-b px-5 py-4">
            <label className="flex items-start gap-3 text-sm leading-relaxed">
              <Checkbox
                checked={config.allowPlaintext === true}
                disabled={busy}
                onCheckedChange={(checked) =>
                  setConfig({ ...config, allowPlaintext: checked === true })
                }
              />
              <span>{l.risk}</span>
            </label>
          </div>
        </>
      ) : (
        <SettingsRow>
          <label htmlFor="web-origin">{c.origin}</label>
          <Input
            id="web-origin"
            type="url"
            readOnly={status?.config.relay?.enabled === true}
            placeholder="https://agent.example.com"
            value={
              status?.config.relay?.enabled ? status.config.externalOrigin : config.externalOrigin
            }
            disabled={busy}
            onChange={(e) => setConfig({ ...config, externalOrigin: e.target.value })}
          />
        </SettingsRow>
      )}
      {codeAccess && showLegacyPermissions && (
        <SettingsNotice>
          <strong>{r.legacyPermissions}</strong>
          <p>{r.legacyPermissionsHint}</p>
        </SettingsNotice>
      )}
      {showLegacyPermissions && (
        <SettingsRow>
          <SettingsCopy>
            <strong>{c.experimental}</strong>
            <small>{status?.experimentalAvailable ? c.warning : c.unverified}</small>
          </SettingsCopy>
          <Checkbox
            aria-label={c.experimental}
            checked={config.experimentalEnabled}
            disabled={busy || !status?.experimentalAvailable}
            onCheckedChange={(experimentalEnabled) =>
              setConfig({ ...config, experimentalEnabled: experimentalEnabled === true })
            }
          />
        </SettingsRow>
      )}
      {!lan && (
        <div className="space-y-3 border-b px-5 py-4 text-sm">
          {showLegacyPermissions && (
            <>
              <strong>{r.workspaces}</strong>
              {!codeAccess && <p className="text-xs text-muted-foreground">{r.newPermissions}</p>}
              {(status?.workspaces ?? []).map((workspace) => (
                <label key={workspace.id} className="flex items-center gap-2">
                  <Checkbox
                    checked={config.allowedWorkspaceIds?.includes(workspace.id) === true}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      setConfig({
                        ...config,
                        allowedWorkspaceIds: checked
                          ? [...(config.allowedWorkspaceIds ?? []), workspace.id]
                          : (config.allowedWorkspaceIds ?? []).filter((id) => id !== workspace.id),
                      })
                    }
                  />
                  <span title={workspace.path}>{workspace.name}</span>
                </label>
              ))}
            </>
          )}
          <label className="block space-y-1">
            <span>{r.extraRoots}</span>
            <Textarea
              className="w-full rounded-md border bg-background p-2"
              rows={3}
              disabled={busy}
              value={
                extraRootsText ?? (config.extraRoots ?? []).map((root) => root.path).join("\n")
              }
              onChange={(event) => setExtraRootsText(event.target.value)}
            />
          </label>
        </div>
      )}
      {!lan && (
        <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
          {advancedContent}
        </fieldset>
      )}
      <div className="flex flex-wrap justify-end gap-2 border-b px-5 py-3">
        <Button
          variant={lan ? "default" : "outline"}
          disabled={
            busy ||
            !advancedValid ||
            !Number.isInteger(config.port) ||
            config.port < 1024 ||
            config.port > 65535 ||
            (config.previewBytesPerSecond !== undefined &&
              (!Number.isSafeInteger(config.previewBytesPerSecond) ||
                config.previewBytesPerSecond < 16 * 1024 ||
                config.previewBytesPerSecond > 1024 * 1024 * 1024)) ||
            (lan &&
              config.enabled &&
              (!config.allowPlaintext ||
                !status?.addresses?.some(({ address }) => address === config.lanAddress)))
          }
          onClick={() => void saveSettings()}
        >
          {activeOperation === "configure" ? c.saving : c.save}
        </Button>
        {(lan || manualAccess) && (
          <>
            {accessLevelSelect}
            <Button
              variant="outline"
              disabled={busy || !status?.running}
              aria-describedby={generateHint ? generateHintId : undefined}
              onClick={() => void generateCode()}
            >
              {codeAccess ? c.generateAccess : c.generate}
            </Button>
          </>
        )}
      </div>
      {lan && generateHint && <SettingsNotice id={generateHintId}>{generateHint}</SettingsNotice>}
      {manualAccess && (
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">{r.manualAccess}</p>
          {pairingCode}
        </div>
      )}
    </>
  );
  const pendingRequests = (
    <>
      {" "}
      {status?.pending.map((pending) => {
        const grant = grants[pending.id] ?? { send: false, approve: false };
        return (
          <div key={pending.id} className="mx-5 my-3 space-y-3 rounded-lg border p-4 text-sm">
            <strong>{pending.name}</strong>
            <p>
              {c.verify}: <span className="font-mono">{pending.verification}</span>
            </p>
            <p>
              {c.read} · {c.scope}
            </p>
            {(lan
              ? (["send", "approve"] as const)
              : ([
                  "send",
                  "approve",
                  "manage",
                  "files",
                  "attachments",
                  "advancedControl",
                  "organize",
                  "settings",
                  "extendedApproval",
                ] as const)
            ).map((permission) => (
              <label key={permission} className="mr-4 inline-flex items-center gap-2">
                <Checkbox
                  disabled={busy}
                  checked={grant[permission] === true}
                  onCheckedChange={(checked) =>
                    setGrants((old) => ({
                      ...old,
                      [pending.id]: { ...grant, [permission]: checked },
                    }))
                  }
                />
                {c[permission]}
              </label>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run({ operation: "approve", id: pending.id, ...grant })}
              >
                {c.accept}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run({ operation: "reject", id: pending.id })}
              >
                {c.reject}
              </Button>
            </div>
          </div>
        );
      })}
    </>
  );
  const browserRows = (
    <>
      {" "}
      {status?.devices.map((device) => (
        <SettingsRow key={device.id}>
          <SettingsCopy>
            <strong className="flex items-center gap-2">
              <Smartphone className="size-4 text-muted-foreground" aria-hidden="true" />
              {device.name}
            </strong>
            <small>
              {device.accessLevel
                ? levelLabel(device.accessLevel)
                : device.accessMode === "full"
                  ? c.fullAccess
                  : [
                      c.read,
                      device.send && c.send,
                      device.approve && c.approve,
                      device.manage && c.manage,
                      device.files && c.files,
                      device.attachments && c.attachments,
                      device.advancedControl && c.advancedControl,
                      device.organize && c.organize,
                      device.settings && c.settings,
                      device.extendedApproval && c.extendedApproval,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
            </small>
          </SettingsCopy>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {codeAccess && device.accessLevel && (
              <Select
                value={device.accessLevel}
                disabled={busy}
                onValueChange={(value) => {
                  if ((value === "read" || value === "full") && value !== device.accessLevel)
                    void run({ operation: "set-access", id: device.id, access: value });
                }}
              >
                <SelectTrigger
                  className="h-9 w-auto"
                  aria-label={`${c.accessLevel}: ${device.name}`}
                >
                  <SelectValue>{levelLabel(device.accessLevel)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>{`${c.accessLevel}: ${device.name}`}</SelectLabel>
                    <SelectItem value="read">{c.readOnlyAccess}</SelectItem>
                    <SelectItem value="full">{c.fullAccess}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmation({ device: device.id })}
            >
              {c.revoke}
            </Button>
          </div>
        </SettingsRow>
      ))}
    </>
  );
  const diagnostics = (
    <>
      {" "}
      {(status?.relay?.failure || status?.relay?.connectorExit || status?.relay?.channels) && (
        <Collapsible className="space-y-3">
          <CollapsibleTrigger className="cursor-pointer text-muted-foreground">
            {c.diagnostics}
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3">
            {status.relay.failure && status.relay.phase !== "ready" && (
              <p className="text-xs text-muted-foreground">
                {r.failureStages[status.relay.failure.stage]}:{" "}
                {r.failureCodes[status.relay.failure.code]}
              </p>
            )}
            {status.relay.connectorExit && (
              <p className="text-xs text-muted-foreground">
                {status.relay.connectorExit.code !== undefined && (
                  <>
                    {r.exitCode}: {status.relay.connectorExit.code}
                  </>
                )}
                {status.relay.connectorExit.signal && (
                  <>
                    {r.exitSignal}: {status.relay.connectorExit.signal}
                  </>
                )}
              </p>
            )}
            {status.relay.channels && status.relay.phase !== "disabled" && (
              <p className="text-xs text-muted-foreground">
                {r.control}：{status.relay.channels.control ? "✓" : "…"}
                {" · "}
                {r.preview}：{status.relay.channels.preview ? "✓" : "…"}
              </p>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
      {status?.relay?.certificateWarning && (
        <p role="status" className="text-xs text-muted-foreground">
          {r.certificateWarning}
        </p>
      )}
    </>
  );
  const notices = (
    <>
      {(unsaved || advancedDirty) && (
        <SettingsNotice tone="warning" role="status">
          <strong>{c.unsaved}</strong>
        </SettingsNotice>
      )}
      {!unsaved && !advancedDirty && saveState === "saved" && (
        <SettingsNotice role="status">{c.saved}</SettingsNotice>
      )}
      {status?.acceptanceSessionId && (
        <SettingsNotice>
          {c.acceptance} <code>{status.acceptanceSessionId}</code>
        </SettingsNotice>
      )}
      {(loadFailed || operationError) &&
        !(operationError === "save" && status?.error === "web_state_save_failed") && (
          <SettingsNotice tone="error" inset={false} className="text-sm" role="alert">
            <p>{operationError === "save" ? r.saveFailed : c.unavailable}</p>
            {!config && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run({ operation: "status" })}
              >
                {c.retryLoad}
              </Button>
            )}
          </SettingsNotice>
        )}
      {status?.error && (
        <SettingsNotice tone="error" inset={false} className="text-sm" role="alert">
          {status.error === "port_in_use"
            ? c.portError
            : status.error === "web_state_save_failed"
              ? r.saveFailed
              : status.error === "web_start_failed"
                ? r.startFailed
                : lan && status.error === "lan_address_unavailable"
                  ? l.addressLost
                  : c.unavailable}
        </SettingsNotice>
      )}
    </>
  );
  // Enable persists the relay intent before enrollment can fail, so that intent alone
  // must not hide the invitation while the first setup is still unfinished.
  const invitation = (!status?.config.relay ||
    (!setupComplete && !relayReady) ||
    brokerChanged ||
    migrating ||
    status?.relay?.reason === "revoked") && (
    <div className="space-y-1">
      <label htmlFor={invitationId}>{r.invitation}</label>
      <Input
        id={invitationId}
        aria-describedby={invitationHintId}
        type="password"
        autoComplete="off"
        value={inviteCode}
        disabled={busy}
        onChange={(e) => setInviteCode(e.target.value)}
      />
      <p id={invitationHintId} className="text-xs text-muted-foreground">
        {c.invitationCodeHint}
      </p>
    </div>
  );
  const connectionActionLabel = migrating
    ? r.confirmMigration
    : status?.relay?.reason === "revoked"
      ? r.reenroll
      : r.enable;
  const migrationNotice = legacyBroker && (
    <SettingsNotice tone="warning" inset={false}>
      <div className="space-y-2">
        <p>{r.migrationNotice}</p>
        <p>{r.switchWarning}</p>
        {!migrating && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setRelayBroker("https://api.agentkib.com");
              setInviteCode("");
            }}
          >
            {r.prepareMigration}
          </Button>
        )}
      </div>
    </SettingsNotice>
  );
  const connectionState = (
    <div className="space-y-2">
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        {(activeOperation === "remote-enable" ||
          ["registering", "certifying", "connecting"].includes(status?.relay?.phase ?? "")) && (
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
        )}
        {activeOperation === "remote-enable"
          ? r.phases.connecting
          : status?.relay?.phase === "offline"
            ? p.offline
            : r.phases[status?.relay?.phase ?? "disabled"]}
        {status?.relay?.reason ? ` · ${r.reasons[status.relay.reason]}` : ""}
      </p>
      {status?.relay?.retryAt && status.relay.retryAt > now && (
        <p className="text-xs text-muted-foreground">
          {r.retryAt} {formatDateTime(new Date(status.relay.retryAt))}
        </p>
      )}
      {diagnostics}
    </div>
  );
  const phoneConnection = (
    <div className="space-y-3">
      {codeAccess && (
        <div
          role="group"
          aria-label={c.accessLevel}
          className="inline-flex rounded-lg border bg-background p-1"
        >
          {(["full", "read"] as const).map((level) => (
            <Button
              key={level}
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-pressed={codeLevel === level}
              className={
                codeLevel === level ? "bg-primary/10 text-primary-text" : "text-muted-foreground"
              }
              onClick={() => setCodeLevel(level)}
            >
              {level === "full" ? c.fullAccess : p.readOnly}
            </Button>
          ))}
        </div>
      )}
      {status?.code && status.code.expiresAt > now && !phoneGenerateHint ? (
        <div className="flex flex-wrap items-center gap-5 rounded-lg border bg-background p-4">
          {status.relay?.phase === "ready" && status.relay.publicUrl && (
            <div className="space-y-1 text-center">
              <ConnectionQr url={status.relay.publicUrl} label={r.scan} />
              <p className="text-xs text-muted-foreground">{r.scan}</p>
            </div>
          )}
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{p.code}</p>
            <strong
              className="block font-mono text-3xl tracking-wider"
              aria-label={status.code.value}
            >
              {status.code.value.replace(/(\d{4})(\d{4})/, "$1 $2")}
            </strong>
            <p className="text-xs text-muted-foreground">
              {c.accessLevel}: {levelLabel(status.code.access)}
            </p>
            <p className="text-xs text-muted-foreground">
              {c.expires}{" "}
              {new Intl.DateTimeFormat(locale, {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              }).format(new Date(status.code.expiresAt))}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy} onClick={() => void generatePhoneCode()}>
                {p.regenerate}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void copyPairingCode(status.code!.value)}
              >
                {codeCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                {tr(codeCopied ? "handoff.copied" : "common.copy")}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <Button
          disabled={busy || Boolean(phoneGenerateHint)}
          aria-describedby={phoneGenerateHint ? generateHintId : undefined}
          onClick={() => void generatePhoneCode()}
        >
          {codeAccess ? c.generateAccess : c.generate}
        </Button>
      )}
      {phoneGenerateHint && (
        <p id={generateHintId} className="text-xs text-muted-foreground">
          {phoneGenerateHint}
        </p>
      )}
      <p className="text-xs leading-5 text-muted-foreground">{p.codeHint}</p>
    </div>
  );
  const confirmations = (
    <Dialog
      open={Boolean(confirmation)}
      onOpenChange={(open) => {
        if (!open) setConfirmation(undefined);
      }}
    >
      <DialogContent initialFocus={cancelRef}>
        <DialogHeader>
          <DialogTitle>
            {confirmation === "pause"
              ? p.pauseTitle
              : confirmation === "connection"
                ? p.applyConnection
                : p.revokeTitle}
          </DialogTitle>
          <DialogDescription>
            {confirmation === "pause"
              ? p.pauseHint
              : confirmation === "connection"
                ? r.switchWarning
                : p.revokeHint}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button
            ref={cancelRef}
            variant="outline"
            disabled={busy}
            onClick={() => setConfirmation(undefined)}
          >
            {p.cancel}
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              const result =
                confirmation === "pause"
                  ? await run({ operation: "relay-stop" })
                  : confirmation === "connection"
                    ? await enableConnection()
                    : confirmation
                      ? await run({ operation: "revoke", id: confirmation.device })
                      : undefined;
              if (result && !result.error) setConfirmation(undefined);
            }}
          >
            {confirmation === "pause"
              ? p.confirmPause
              : confirmation === "connection"
                ? p.applyConnection
                : p.confirmRevoke}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
  if (lan)
    return (
      <SettingsSection title={c.title}>
        <SettingsNotice>
          <div>
            <p>{c.scope}</p>
            <p>{c.pairingCodeHint}</p>
          </div>
        </SettingsNotice>
        {notices}
        {settingsForm}
        {lan && status?.running && status.connectionUrl && (
          <SettingsNotice>
            <div className="flex flex-wrap items-start gap-4">
              <ConnectionQr url={status.connectionUrl} label={l.qr} />
              <div className="min-w-0 flex-1 space-y-2 break-all">
                <p>
                  {l.endpoint}: <code>{status.localUrl}</code>
                </p>
                <label htmlFor="lan-web-link">{l.link}</label>
                <Input
                  id="lan-web-link"
                  readOnly
                  value={status.connectionUrl}
                  onFocus={(event) => event.target.select()}
                />
              </div>
            </div>
            <p className="mt-3">{l.session}</p>
          </SettingsNotice>
        )}

        {pairingCode}
        {!!status?.pending.length && <h3 className="px-5 pt-4 text-sm font-medium">{c.pending}</h3>}
        {pendingRequests}
        {!!status?.devices.length && <h3 className="px-5 pt-4 text-sm font-medium">{c.devices}</h3>}
        {browserRows}
        {confirmations}
      </SettingsSection>
    );
  return (
    <div className="grid gap-5">
      {notices}
      {lanStatus?.config.enabled && (
        <SettingsNotice tone="warning">
          <div>
            <strong>{l.plaintextActiveTitle}</strong>
            {lanStatus.running && !lanUnavailable ? (
              <>
                <p>{r.lanRunning}</p>
                <p>{l.plaintextActive}</p>
              </>
            ) : (
              <p>{r.lanUnavailable}</p>
            )}
          </div>
        </SettingsNotice>
      )}
      <div hidden={!phoneVisible} className="space-y-5">
        {!setupComplete ? (
          <section className="space-y-5 rounded-xl border bg-card p-5">
            <header className="space-y-1">
              <h3 className="text-sm font-semibold">{p.introTitle}</h3>
              <p className="text-xs text-muted-foreground">{p.lifetime}</p>
            </header>
            <div>
              <SetupStep
                number={1}
                title={signedIn ? "" : p.loginStep}
                hint={!signedIn ? p.loginHint : undefined}
                active={!signedIn}
                done={signedIn}
              >
                <RemoteAccountSettings
                  variant="step"
                  primary={!relayReady}
                  onStatusChange={setAccountStatus}
                />
              </SetupStep>
              <SetupStep
                number={2}
                title={relayReady ? p.readyResult : p.enableStep}
                hint={!relayReady ? p.enableHint : undefined}
                active={signedIn && !relayReady}
                done={Boolean(relayReady)}
              >
                {signedIn && !relayReady && (
                  <div className="space-y-3">
                    {migrationNotice}
                    {invitation}
                    <Button
                      disabled={
                        connectionDisabled ||
                        ["registering", "certifying", "connecting"].includes(
                          status?.relay?.phase ?? "",
                        )
                      }
                      onClick={() => {
                        if (brokerChanged && !migrating) setConfirmation("connection");
                        else void enableConnection();
                      }}
                    >
                      {connectionActionLabel}
                    </Button>
                    {connectionState}
                  </div>
                )}
              </SetupStep>
              <SetupStep
                number={3}
                title={p.connectStep}
                hint={!relayReady ? p.connectHint : undefined}
                active={Boolean(relayReady)}
              >
                {relayReady && phoneConnection}
              </SetupStep>
              <SetupStep number={4} title={p.manageStep} hint={p.manageHint} />
            </div>
            {relayReady && diagnostics}
          </section>
        ) : (
          <>
            <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm">
                  <span
                    aria-hidden="true"
                    className={`size-2 rounded-full ${relayReady ? "bg-emerald-600" : "bg-muted-foreground"}`}
                  />
                  <strong>{relayActive ? r.enabledRemote : p.paused}</strong>
                </div>
                {connectionState}
              </div>
              <div className="flex flex-wrap gap-2">
                {relayActive ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => setConfirmation("pause")}
                  >
                    {p.pause}
                  </Button>
                ) : (
                  <Button disabled={connectionDisabled} onClick={() => void enableConnection()}>
                    {connectionActionLabel}
                  </Button>
                )}
              </div>
            </section>
            <section className="space-y-2">
              <header className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-medium">
                  {p.browsers.replace("{count}", String(status?.devices.length ?? 0))}
                </h3>
                <Button
                  variant={relayReady && !newPhoneOpen ? "default" : "outline"}
                  disabled={busy || Boolean(phoneGenerateHint)}
                  onClick={() => setNewPhoneOpen(true)}
                >
                  {p.connectNew}
                </Button>
              </header>
              <div className="overflow-hidden rounded-xl border bg-card">{browserRows}</div>
            </section>
          </>
        )}
        {!!status?.pending.length && (
          <section className="rounded-xl border bg-card">
            <h3 className="px-5 pt-4 text-sm font-medium">{c.pending}</h3>
            {pendingRequests}
          </section>
        )}
        <section className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex min-w-0 items-center gap-3">
              <Wifi className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {setupComplete
                    ? `${p.lanSummary} · ${lanStatus?.config.enabled ? p.lanOn : p.lanOff}`
                    : p.lanTitle}
                </p>
                {!setupComplete && (
                  <p className="text-xs leading-5 text-muted-foreground">{p.lanHint}</p>
                )}
              </div>
            </div>
            <Button variant="outline" onClick={() => setLanOpen(true)}>
              {setupComplete ? p.settings : p.lanSetup}
            </Button>
          </div>
          {setupComplete && (
            <div className="border-t p-4">
              <RemoteAccountSettings variant="footer" onStatusChange={setAccountStatus} />
            </div>
          )}
        </section>
      </div>
      {children}
      <Collapsible
        open={advancedOpen ?? localAdvancedOpen}
        onOpenChange={(open) => {
          setLocalAdvancedOpen(open);
          onAdvancedOpenChange?.(open);
        }}
        className="overflow-hidden rounded-xl border bg-card"
      >
        <CollapsibleTrigger
          aria-label={p.advanced}
          id="remote-advanced-trigger"
          className="group flex w-full cursor-pointer flex-wrap items-center gap-2 px-4 py-3 text-sm font-medium"
        >
          <ChevronRight
            aria-hidden="true"
            className="size-4 transition-transform group-aria-expanded:rotate-90"
          />
          {p.advanced}
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {p.advancedHint}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted className="border-t">
          <div className="space-y-3 px-5 py-4 text-sm">
            {!(signedIn && !relayReady && !setupComplete) && migrationNotice}
            <label className="block space-y-1">
              {r.broker}
              <Input
                type="url"
                value={relayBroker}
                disabled={busy}
                placeholder="https://api.agentkib.com"
                onChange={(e) => setRelayBroker(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              {r.frpc}
              <Input
                value={frpcPath}
                disabled={busy}
                aria-describedby={frpcHintId}
                placeholder={r.bundled}
                onChange={(e) => setFrpcPath(e.target.value)}
              />
            </label>
            <p id={frpcHintId} className="text-xs text-muted-foreground">
              {r.frpcHint}
            </p>
            <p className="text-xs leading-5 text-muted-foreground">{c.connectionApplyHint}</p>
            {connectionDirty && (
              <p role="status" className="text-xs text-muted-foreground">
                {p.connectionDraft}
              </p>
            )}
            {/* Keep explicit enrollment available for custom brokers and existing invitation-only computers. */}
            {!(signedIn && !relayReady && !setupComplete) && invitation}
            <Button
              variant="outline"
              disabled={connectionDisabled || (remoteEnabled && !connectionDirty)}
              onClick={() => {
                if (brokerChanged) setConfirmation("connection");
                else void enableConnection();
              }}
            >
              {p.applyConnection}
            </Button>
            {!setupComplete && relayActive && (
              <Button variant="outline" disabled={busy} onClick={() => setConfirmation("pause")}>
                {p.pause}
              </Button>
            )}
            {!signedIn && connectionState}
            <label className="block space-y-1">
              {r.bandwidth}
              <Input
                type="number"
                min={16}
                max={1048576}
                step={1}
                disabled={busy || !config}
                value={(config?.previewBytesPerSecond ?? 2 * 1024 * 1024) / 1024}
                onChange={(event) =>
                  setConfig((old) =>
                    old
                      ? {
                          ...old,
                          previewBytesPerSecond: Math.round(Number(event.target.value) * 1024),
                        }
                      : old,
                  )
                }
              />
            </label>
            <h3 className="pt-2 font-medium">{p.localWeb}</h3>
          </div>
          {settingsForm}
        </CollapsibleContent>
      </Collapsible>
      <Dialog open={lanOpen} onOpenChange={setLanOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader className="sr-only">
            <DialogTitle>{p.lanSummary}</DialogTitle>
            <DialogDescription>{l.scope}</DialogDescription>
          </DialogHeader>
          {lanOpen && <WebAccessSettings target="lan" hideNetworkFields />}
        </DialogContent>
      </Dialog>
      <Dialog open={newPhoneOpen} onOpenChange={setNewPhoneOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{p.connectNew}</DialogTitle>
            <DialogDescription>{p.connectHint}</DialogDescription>
          </DialogHeader>
          {phoneConnection}
        </DialogContent>
      </Dialog>
      {confirmations}
    </div>
  );
}
