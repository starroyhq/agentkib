import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleCheck,
  CircleX,
  Copy,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  QrCode,
  SlidersHorizontal,
  Smartphone,
  TriangleAlert,
  User,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { remotePhoneCopy } from "./remote-phone-copy";
import type { DesktopAccountStatus } from "../../../electron/main/account/state";
import {
  getWebAdminState,
  requestWebAdmin,
  subscribeWebStatus,
  useWebAdminState,
} from "./web-status";
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
import { useRemoteStore } from "./remote-store";
import { remotePageCopy } from "./remote-page-copy";
import { CardIcon, clockTime } from "./RemoteCard";
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
const OFFICIAL_BROKER_URL = "https://api.agentkib.com";
function normalizeBrokerUrl(value: string) {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    )
      return url.origin;
  } catch {
    // Invalid broker input is left for the existing native validation.
  }
  return trimmed;
}
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
  /** LAN only: the "only on the same Wi-Fi" steps inside the connect-phone window. */
  mode?: "wifi";
  onBack?: () => void;
  children?: ReactNode;
  advancedContent?: ReactNode;
  onSaveAdvanced?: () => Promise<boolean>;
  onDiscardAdvanced?: () => void;
  advancedDirty?: boolean;
  advancedBusy?: boolean;
  advancedValid?: boolean;
  hideNetworkFields?: boolean;
  advancedOpen?: boolean;
  onAdvancedOpenChange?: (open: boolean) => void;
  onOpenNetworkSettings?: () => void;
};

/** Where the connect-phone window is: one step at a time, decided by the live state. */
type PhoneStep = "loading" | "login" | "prepare" | "preparing" | "error" | "scan" | "connected";

export function WebAccessSettings({
  target,
  mode,
  onBack,
  children,
  advancedContent,
  onSaveAdvanced,
  onDiscardAdvanced,
  advancedDirty = false,
  advancedBusy = false,
  advancedValid = true,
  hideNetworkFields = false,
  advancedOpen,
  onAdvancedOpenChange,
  onOpenNetworkSettings,
}: WebAccessSettingsProps = {}) {
  const { locale, tr, formatDateTime } = useI18n();
  const lan = target === "lan";
  const p = remotePhoneCopy[locale];
  const l = lanSettingsCopy[locale];
  const pc = remotePageCopy[locale];
  const [localAdvancedOpen, setLocalAdvancedOpen] = useState(false);
  const [setupComplete, setSetupComplete] = useState(false);
  const setupInProgress = useRef(false);
  const [accountStatus, setAccountStatus] = useState<DesktopAccountStatus>();
  const [lanStatus, setLanStatus] = useState<WebAdminStatus>();
  const [lanUnavailable, setLanUnavailable] = useState(false);
  const [lanOpen, setLanOpen] = useState(false);
  // The connect-phone window and which path it shows: with an account, or the same Wi-Fi only.
  const [connect, setConnect] = useState<"account" | "wifi">();
  // Browsers authorized before the window reached its code, so a new one shows as connected.
  const [baseline, setBaseline] = useState<string[]>();
  const autoPrepared = useRef(false);
  const [autoArmed, setAutoArmed] = useState(false);
  const [autoDone, setAutoDone] = useState(false);
  const autoCode = useRef<WebAccessLevel>(undefined);
  const [accountOpen, setAccountOpen] = useState(false);
  const [lanChoice, setLanChoice] = useState<string>();
  const [lanAcknowledged, setLanAcknowledged] = useState(false);
  const saveOutcome = useRef<"saved" | "failed">(undefined);
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
  const sharedAdmin = useWebAdminState(target);
  const busy = operationBusy || advancedBusy || sharedAdmin.busy;
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
    if (locked.current || getWebAdminState(target).busy || useRemoteStore.getState().busy) return;
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
                saveOutcome.current = "failed";
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
                saveOutcome.current = extraSaved ? "saved" : "failed";
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
          if (input.operation === "configure") saveOutcome.current = "failed";
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
    normalizeBrokerUrl(status?.config.relay?.brokerUrl ?? ""),
  );
  const officialBroker = normalizeBrokerUrl(relayBroker) === OFFICIAL_BROKER_URL;
  const customBroker =
    Boolean(relayBroker.trim()) &&
    !officialBroker &&
    !legacyBrokerUrls.includes(normalizeBrokerUrl(relayBroker));
  const migrating = legacyBroker && officialBroker;
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
  const unsaved = localConfigDirty || localSaveFailed || sharedAdmin.configurationUncertain;
  const connectionDirty = Boolean(
    status &&
    (normalizeBrokerUrl(relayBroker) !==
      normalizeBrokerUrl(status.config.relay?.brokerUrl || OFFICIAL_BROKER_URL) ||
      frpcPath.trim() !== (status.config.relay?.frpcPath || "").trim()),
  );
  const brokerChanged = Boolean(
    status?.config.relay &&
    normalizeBrokerUrl(relayBroker) !== normalizeBrokerUrl(status.config.relay.brokerUrl),
  );
  const signedIn = accountStatus?.phase === "signed-in" && Boolean(accountStatus.account);
  const relayReady = status?.running && status.relay?.phase === "ready";
  const relayActive = Boolean(status?.config.relay?.enabled);
  const connectionDisabled =
    busy ||
    !config ||
    !relayBroker.trim() ||
    (officialBroker && !signedIn) ||
    (legacyBroker && legacyBrokerUrls.includes(normalizeBrokerUrl(relayBroker))) ||
    (!officialBroker && status?.relay?.reason === "revoked" && !inviteCode.trim());
  const enableConnection = () => {
    if (connectionDisabled) return;
    if (!setupComplete) setupInProgress.current = true;
    return run({
      operation: "remote-enable",
      brokerUrl: relayBroker,
      ...(frpcPath.trim() ? { frpcPath: frpcPath.trim() } : {}),
      ...(customBroker && inviteCode ? { inviteCode } : {}),
      ...(status?.relay?.reason === "revoked" ? { reenroll: true } : {}),
    });
  };
  const savedRelay = status?.config.relay;
  const resumeNeedsLogin =
    !relayActive &&
    normalizeBrokerUrl(savedRelay?.brokerUrl ?? "") === OFFICIAL_BROKER_URL &&
    !signedIn;
  const resumeDisabled =
    busy ||
    !savedRelay?.brokerUrl.trim() ||
    legacyBrokerUrls.includes(normalizeBrokerUrl(savedRelay.brokerUrl)) ||
    status?.relay?.reason === "revoked";
  const resumeConnection = () => {
    if (resumeDisabled || !savedRelay) return;
    return run({
      operation: "remote-enable",
      brokerUrl: savedRelay.brokerUrl,
      ...(savedRelay.frpcPath ? { frpcPath: savedRelay.frpcPath } : {}),
    });
  };
  /** Saves the local Web service and the shared network settings; true when nothing failed. */
  async function saveSettings() {
    if (busy || locked.current || getWebAdminState(target).busy || useRemoteStore.getState().busy)
      return false;
    if (!unsaved && !advancedDirty) {
      setOperationError(undefined);
      setSaveState(undefined);
      return true;
    }
    if (unsaved) {
      saveOutcome.current = undefined;
      await run({ operation: "configure", ...configToSave! });
      return saveOutcome.current === "saved";
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
      return Boolean(saved);
    } catch {
      if (mounted.current) {
        setSaveState("failed");
        setOperationError("save");
      }
      return false;
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
  const settingsInvalid =
    !config ||
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
        !status?.addresses?.some(({ address }) => address === config.lanAddress)));
  const settingsForm = !config ? (
    <p>{c.loading}</p>
  ) : (
    <>
      {/* The advanced window has its own Save and Cancel; only the LAN window needs the hint. */}
      {lan && <SettingsNotice id={saveHintId}>{c.saveHint}</SettingsNotice>}
      {lan &&
        hideNetworkFields &&
        !status?.addresses?.some(({ address }) => address === config.lanAddress) && (
          <SettingsNotice>
            <div>
              <p>{c.lanNetworkRequired}</p>
              {onOpenNetworkSettings && (
                <Button
                  variant="link"
                  size="content"
                  disabled={busy}
                  onClick={onOpenNetworkSettings}
                >
                  {c.openNetworkSettings}
                </Button>
              )}
            </div>
          </SettingsNotice>
        )}
      <SettingsRow>
        <SettingsCopy>
          <strong>{c.enabled}</strong>
          <small>{status?.running ? `${c.running} · ${status.localUrl}` : c.stopped}</small>
        </SettingsCopy>
        <Checkbox
          aria-label={c.enabled}
          checked={config.enabled}
          disabled={busy}
          aria-describedby={lan ? saveHintId : undefined}
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
      {(lan || manualAccess) && (
        <div className="flex flex-wrap justify-end gap-2 border-b px-5 py-3">
          {lan && (
            <Button disabled={busy || settingsInvalid} onClick={() => void saveSettings()}>
              {activeOperation === "configure" ? c.saving : c.save}
            </Button>
          )}
          {accessLevelSelect}
          <Button
            variant="outline"
            disabled={busy || !status?.running}
            aria-describedby={generateHint ? generateHintId : undefined}
            onClick={() => void generateCode()}
          >
            {codeAccess ? c.generateAccess : c.generate}
          </Button>
        </div>
      )}
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
      {status?.devices.map((device) => (
        <div key={device.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
            <Smartphone className="size-4 text-muted-foreground" aria-hidden="true" />
          </span>
          <div className="grid min-w-0 flex-1 gap-0.5">
            <strong className="break-words font-medium">{device.name}</strong>
            {!(codeAccess && device.accessLevel) && (
              <small className="text-muted-foreground">
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
            )}
            {device.accountBound && (
              <small className="text-muted-foreground">{c.accountBound}</small>
            )}
          </div>
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
        </div>
      ))}
    </>
  );
  const diagnostics = (
    <>
      {" "}
      {(status?.relay?.phase === "offline" || status?.relay?.phase === "error") &&
        (status.relay.failure || status.relay.connectorExit || status.relay.channels) && (
          <Collapsible className="space-y-3">
            <CollapsibleTrigger className="cursor-pointer text-muted-foreground">
              {c.diagnostics}
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3">
              {status.relay.failure && (
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
              {status.relay.channels && (
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
  // Dialogs place notices flush with their content; a step that shows its own result skips "saved".
  const renderNotices = ({ inset = true, saved = true } = {}) => (
    <>
      {(unsaved || advancedDirty) && (
        <SettingsNotice tone="warning" inset={inset} role="status">
          <strong>{c.unsaved}</strong>
        </SettingsNotice>
      )}
      {saved && !unsaved && !advancedDirty && saveState === "saved" && (
        <SettingsNotice inset={inset} role="status">
          {c.saved}
        </SettingsNotice>
      )}
      {status?.acceptanceSessionId && (
        <SettingsNotice inset={inset}>
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
  // Self-hosted services can retain invitation enrollment; official enrollment uses the account.
  const invitation = customBroker &&
    (!status?.config.relay ||
      (!setupComplete && !relayReady) ||
      brokerChanged ||
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
      ? officialBroker
        ? r.reenrollAccount
        : r.reenroll
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
  const connectionSummary = (
    <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
      {(activeOperation === "remote-enable" ||
        ["registering", "certifying", "connecting"].includes(status?.relay?.phase ?? "")) && (
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
      )}
      {activeOperation === "remote-enable"
        ? r.phases.connecting
        : setupComplete && !relayActive
          ? p.pausedHint
          : status?.relay?.phase === "offline"
            ? p.offline
            : r.phases[status?.relay?.phase ?? "disabled"]}
      {status?.relay?.reason ? ` · ${r.reasons[status.relay.reason]}` : ""}
    </p>
  );
  const connectionDetails = (
    <>
      {status?.relay?.retryAt && status.relay.retryAt > now && (
        <p className="text-xs text-muted-foreground">
          {r.retryAt} {formatDateTime(new Date(status.relay.retryAt))}
        </p>
      )}
      {diagnostics}
    </>
  );
  const connectionState = (
    <div className="space-y-2">
      {connectionSummary}
      {connectionDetails}
    </div>
  );
  const relayPhase = status?.relay?.phase;
  const enabling =
    activeOperation === "remote-enable" ||
    ["registering", "certifying", "connecting"].includes(relayPhase ?? "");
  const relayFailed =
    (relayActive && !enabling && (relayPhase === "error" || relayPhase === "offline")) ||
    // An enable request that failed outright leaves remote access off with an error to show.
    (!relayActive && !enabling && (operationError === "request" || Boolean(status?.error)));
  const needsLogin = setupComplete ? resumeNeedsLogin : officialBroker && !signedIn;
  // The window turns remote access on by itself only where nothing is left to choose: the
  // official service as set up, or resuming what was saved. Migration, a self-hosted invitation
  // or re-registration still take the explicit action.
  const autoPrepare = setupComplete
    ? !resumeNeedsLogin && !resumeDisabled
    : officialBroker &&
      signedIn &&
      !migrating &&
      !brokerChanged &&
      status?.relay?.reason !== "revoked" &&
      !connectionDisabled;
  const prepare = () => (setupComplete ? resumeConnection() : enableConnection());
  const connectedDevice = baseline
    ? status?.devices.find((device) => !baseline.includes(device.id))
    : undefined;
  // A revoked device needs a deliberate re-registration, never an automatic or plain retry.
  const revoked = status?.relay?.reason === "revoked";
  const phoneStep: PhoneStep = !status
    ? "loading"
    : relayReady
      ? connectedDevice
        ? "connected"
        : "scan"
      : needsLogin
        ? "login"
        : enabling
          ? "preparing"
          : revoked
            ? "prepare"
            : relayFailed
              ? "error"
              : relayActive || (autoArmed && !autoDone && autoPrepare)
                ? "preparing"
                : "prepare";
  const liveCode = Boolean(
    status?.code &&
    status.code.expiresAt > now &&
    !phoneGenerateHint &&
    (!codeAccess || status.code.access === codeLevel),
  );
  useEffect(() => {
    // Only an opening that found remote access off turns it on, once: a pause made while the
    // window is open stays paused and leaves the explicit action.
    if (connect !== "account" || phoneStep !== "preparing" || !autoArmed) return;
    if (autoPrepared.current || busy || relayActive || !autoPrepare) return;
    autoPrepared.current = true;
    void Promise.resolve(prepare()).finally(() => {
      if (mounted.current) setAutoDone(true);
    });
  });
  useEffect(() => {
    // One code per opening and level, counting a code that was already showing: an expired code
    // waits for an explicit "regenerate".
    if (connect !== "account" || phoneStep !== "scan" || busy) return;
    if (autoCode.current === codeLevel) return;
    autoCode.current = codeLevel;
    if (!liveCode) void generatePhoneCode();
  });
  function openConnect(path: "account" | "wifi" = "account") {
    autoPrepared.current = false;
    autoCode.current = undefined;
    setAutoArmed(!relayActive);
    setAutoDone(false);
    setOperationError(undefined);
    setBaseline(status?.devices.map((device) => device.id) ?? []);
    setLanChoice(undefined);
    setLanAcknowledged(false);
    setConnect(path);
  }
  const advancedIsOpen = advancedOpen ?? localAdvancedOpen;
  function setAdvanced(open: boolean) {
    setLocalAdvancedOpen(open);
    onAdvancedOpenChange?.(open);
  }
  function cancelAdvanced() {
    if (busy) return;
    if (status) {
      setConfig(status.config);
      setRelayBroker(status.config.relay?.brokerUrl || OFFICIAL_BROKER_URL);
      setFrpcPath(status.config.relay?.frpcPath || "");
    }
    setExtraRootsText(undefined);
    setInviteCode("");
    setSaveState(undefined);
    onDiscardAdvanced?.();
    setAdvanced(false);
  }
  async function saveAdvancedDialog() {
    if (!(await saveSettings())) return;
    if (connectionDirty) {
      // Any change of service, migration included, clears the browser grants: confirm it first.
      if (brokerChanged) {
        setConfirmation("connection");
        return;
      }
      const result = await enableConnection();
      if (!result || result.error) return;
    }
    setAdvanced(false);
  }
  // A retired official address is neither choice until its migration notice is acted on.
  const serviceChoice = officialBroker
    ? "official"
    : legacyBrokerUrls.includes(normalizeBrokerUrl(relayBroker))
      ? ""
      : "self";
  const selfHostedDraft = useRef("");
  const usage = accountStatus?.relayUsage;
  const usedPercent = usage
    ? Math.min(100, Math.round((usage.usedBytes / usage.limitBytes) * 100))
    : undefined;
  const usageNear = Boolean(
    usage && (usage.exhausted || usage.usedBytes >= usage.limitBytes * 0.8),
  );
  const usageText =
    usage && usedPercent !== undefined
      ? usage.exhausted
        ? pc.relayExhausted
        : usageNear
          ? pc.relayAlmost.replace("{percent}", String(usedPercent))
          : pc.relayUsed
              .replace("{percent}", String(usedPercent))
              .replace(
                "{date}",
                new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }).format(
                  new Date(usage.periodEnd),
                ),
              )
      : undefined;
  const phoneSummary = [
    pc.devices.replace("{count}", String(status?.devices.length ?? 0)),
    usageText,
  ]
    .filter(Boolean)
    .join(" · ");
  const badge = !relayActive
    ? { label: pc.paused, className: "bg-muted text-muted-foreground", dot: "bg-muted-foreground" }
    : relayReady
      ? {
          label: pc.on,
          className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
          dot: "bg-emerald-600",
        }
      : relayFailed
        ? {
            label: pc.interrupted,
            className: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
            dot: "bg-amber-600",
          }
        : { label: pc.connecting, className: "bg-muted text-muted-foreground", dot: "bg-primary" };
  const levelPicker = codeAccess && (
    <div className="grid gap-2">
      <span className="text-xs text-muted-foreground">{pc.levelQuestion}</span>
      <div
        role="group"
        aria-label={c.accessLevel}
        className="inline-flex w-fit rounded-lg border bg-background p-1"
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
    </div>
  );
  const phoneConnection = (
    <div className="grid gap-4">
      {liveCode && status?.code ? (
        <div className="flex flex-wrap items-center gap-5">
          {status.relay?.phase === "ready" && status.relay.publicUrl && (
            <ConnectionQr url={status.relay.publicUrl} label={r.scan} />
          )}
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">{p.code}</span>
            <strong
              className="block font-mono text-3xl tracking-wider"
              aria-label={status.code.value}
            >
              {status.code.value.replace(/(\d{4})(\d{4})/, "$1 $2")}
            </strong>
            <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              {pc.validUntil.replace("{time}", clockTime(status.code.expiresAt, locale))}
              <span aria-hidden="true">·</span>
              <Button
                variant="link"
                size="content"
                className="text-xs"
                disabled={busy}
                onClick={() => void generatePhoneCode()}
              >
                {p.regenerate}
              </Button>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 justify-self-start"
              disabled={busy}
              onClick={() => void copyPairingCode(status.code!.value)}
            >
              {codeCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {tr(codeCopied ? "handoff.copied" : "common.copy")}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          className="justify-self-start"
          disabled={busy || Boolean(phoneGenerateHint)}
          aria-describedby={phoneGenerateHint ? generateHintId : undefined}
          onClick={() => void generatePhoneCode()}
        >
          {codeAccess ? c.generateAccess : c.generate}
        </Button>
      )}
      {levelPicker}
      {phoneGenerateHint && (
        <p id={generateHintId} className="text-xs text-muted-foreground">
          {phoneGenerateHint}
        </p>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        {codeAccess ? c.codeScope : p.codeHint}
      </p>
    </div>
  );
  const wifiLink = (
    <div className="border-t pt-3">
      <Button variant="link" size="content" className="gap-1.5" onClick={() => setConnect("wifi")}>
        <Wifi aria-hidden="true" />
        {pc.wifiLink}
      </Button>
    </div>
  );
  const reasonText = status?.relay?.reason
    ? r.reasons[status.relay.reason]
    : r.phases[relayPhase ?? "disabled"];
  const connectBody =
    phoneStep === "loading" ? (
      <p role="status">{c.loading}</p>
    ) : phoneStep === "login" ? (
      <div className="grid gap-4">
        <StepIntro icon={<User aria-hidden="true" />} title={pc.loginTitle} info={pc.loginInfo} />
        <RemoteAccountSettings variant="step" primary onStatusChange={setAccountStatus} />
        {wifiLink}
      </div>
    ) : phoneStep === "prepare" ? (
      <div className="grid gap-4">
        <StepIntro icon={<Smartphone aria-hidden="true" />} title={pc.prepareTitle} />
        {migrationNotice}
        {invitation}
        <Button
          className="justify-self-start"
          disabled={connectionDisabled || enabling}
          onClick={() => {
            if (brokerChanged && !migrating) setConfirmation("connection");
            else void enableConnection();
          }}
        >
          {connectionActionLabel}
        </Button>
        {connectionState}
        {wifiLink}
      </div>
    ) : phoneStep === "preparing" ? (
      <div className="grid gap-4">
        <StepIntro
          icon={<LoaderCircle className="animate-spin" aria-hidden="true" />}
          title={pc.preparingTitle}
        />
        {connectionSummary}
        <p className="text-xs text-muted-foreground">{pc.preparingHint}</p>
      </div>
    ) : phoneStep === "error" ? (
      <div className="grid gap-4">
        <StepIntro
          tone="error"
          icon={<CircleX aria-hidden="true" />}
          title={relayPhase === "offline" ? pc.interruptedTitle : pc.failedTitle}
          info={reasonText}
        />
        {status?.relay?.retryAt && status.relay.retryAt > now && (
          <p className="-mt-2 text-sm text-muted-foreground">
            {pc.nextRetry.replace("{time}", clockTime(status.relay.retryAt, locale))}
          </p>
        )}
        {diagnostics}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={() => setConnect(undefined)}>
            {pc.close}
          </Button>
          <Button
            disabled={busy || (setupComplete ? resumeDisabled : connectionDisabled)}
            onClick={() => void prepare()}
          >
            {pc.retryNow}
          </Button>
        </div>
      </div>
    ) : phoneStep === "scan" ? (
      phoneConnection
    ) : (
      <div className="grid gap-4">
        <StepIntro
          tone="success"
          icon={<CircleCheck aria-hidden="true" />}
          title={pc.connectedTitle.replace("{name}", connectedDevice?.name ?? "")}
          info={connectedDevice?.accessLevel === "read" ? pc.readInfo : pc.fullInfo}
        />
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            onClick={() => {
              autoCode.current = undefined;
              setBaseline(status?.devices.map((device) => device.id) ?? []);
            }}
          >
            {pc.connectAnother}
          </Button>
          <Button onClick={() => setConnect(undefined)}>{pc.done}</Button>
        </div>
      </div>
    );
  const stepIndex = { login: 0, prepare: 1, preparing: 1, error: 1, scan: 2 } as Partial<
    Record<PhoneStep, number>
  >;
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
              if (result && !result.error) {
                if (confirmation === "connection") setAdvanced(false);
                setConfirmation(undefined);
              }
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
  if (lan && mode === "wifi") {
    const addresses = status?.addresses ?? [];
    const chosen =
      lanChoice ??
      (addresses.some(({ address }) => address === config?.lanAddress)
        ? (config?.lanAddress ?? "")
        : "");
    const listening = Boolean(status?.running && status.config.enabled && status.connectionUrl);
    if (listening && status?.connectionUrl)
      return (
        <div className="grid gap-4 text-sm">
          <div className="flex flex-wrap items-start gap-4">
            <ConnectionQr url={status.connectionUrl} label={l.qr} />
            <div className="grid min-w-0 flex-1 gap-2">
              <span className="inline-flex w-fit items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                <WifiOff className="size-3.5" aria-hidden="true" />
                {pc.unencrypted}
              </span>
              <p>{pc.wifiScan}</p>
              <code className="break-all text-xs text-muted-foreground">{status.localUrl}</code>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{pc.wifiOnly}</p>
          <div className="grid gap-2 border-t pt-3">
            <p className="text-xs text-muted-foreground">{c.pairingCodeHint}</p>
            {status.code && status.code.expiresAt > now ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <strong
                  className="font-mono text-2xl tracking-wider"
                  aria-label={status.code.value}
                >
                  {status.code.value.replace(/(\d{4})(\d{4})/, "$1 $2")}
                </strong>
                <span className="text-xs text-muted-foreground">
                  {pc.validUntil.replace("{time}", clockTime(status.code.expiresAt, locale))}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void copyPairingCode(status.code!.value)}
                >
                  {codeCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {tr(codeCopied ? "handoff.copied" : "common.copy")}
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                className="justify-self-start"
                disabled={busy}
                onClick={() => void generateCode()}
              >
                {c.generate}
              </Button>
            )}
          </div>
          {!!status.pending.length && (
            <section aria-label={c.pending}>
              <h3 className="text-sm font-medium">{c.pending}</h3>
              {pendingRequests}
            </section>
          )}
          {renderNotices({ inset: false, saved: false })}
          {confirmations}
        </div>
      );
    return (
      <div className="grid gap-4 text-sm">
        <SettingsNotice tone="warning" inset={false}>
          <div className="flex gap-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>{pc.wifiRisk}</p>
          </div>
        </SettingsNotice>
        <div className="grid gap-1.5">
          <label htmlFor="remote-wifi-network">{pc.wifiNetwork}</label>
          <Select
            value={chosen || null}
            disabled={busy || !config}
            onValueChange={(value) => setLanChoice(value ?? "")}
          >
            <SelectTrigger id="remote-wifi-network" className="w-full min-w-0">
              <SelectValue placeholder={l.choose}>
                {chosen
                  ? `${addresses.find((entry) => entry.address === chosen)?.name ?? ""} · ${chosen}`
                  : l.choose}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {addresses.map(({ name, address }) => (
                  <SelectItem key={`${name}-${address}`} value={address}>
                    {name} · {address}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {status && !addresses.length && (
            <p className="text-xs text-muted-foreground">{l.noAddress}</p>
          )}
        </div>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={lanAcknowledged}
            disabled={busy}
            onCheckedChange={(checked) => setLanAcknowledged(checked === true)}
          />
          {pc.wifiAck}
        </label>
        {renderNotices({ inset: false })}
        <Button
          disabled={busy || !config || !chosen || !lanAcknowledged}
          onClick={() => {
            if (!config || !chosen || !lanAcknowledged) return;
            void run({
              operation: "configure",
              ...config,
              enabled: true,
              lanAddress: chosen,
              allowPlaintext: true,
            });
          }}
        >
          {activeOperation === "configure" ? c.saving : pc.wifiStart}
        </Button>
        {onBack && (
          <div className="border-t pt-3">
            <Button variant="link" size="content" className="gap-1.5" onClick={onBack}>
              <ArrowLeft aria-hidden="true" />
              {pc.wifiBack}
            </Button>
          </div>
        )}
      </div>
    );
  }
  if (lan)
    return (
      <SettingsSection title={c.title}>
        <SettingsNotice>
          <div>
            <p>{c.scope}</p>
            <p>{c.pairingCodeHint}</p>
          </div>
        </SettingsNotice>
        {renderNotices()}
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
        <div className="divide-y">{browserRows}</div>
        {confirmations}
      </SettingsSection>
    );
  const moreMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="icon" aria-label={pc.more} disabled={busy} />}
      >
        <MoreHorizontal aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-56">
        {relayActive && (
          <DropdownMenuItem onClick={() => setConfirmation("pause")}>
            <Pause aria-hidden="true" />
            {pc.pauseAccess}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => setAccountOpen(true)}>
          <User aria-hidden="true" />
          {pc.account}
          {accountStatus?.account?.username && (
            <span className="ml-auto max-w-40 truncate pl-4 text-xs text-muted-foreground">
              {accountStatus.account.username}
            </span>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setAdvanced(true)}>
          <SlidersHorizontal aria-hidden="true" />
          {pc.advanced}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const frpcField = (
    <>
      <label className="grid gap-1.5">
        {r.frpc}
        <Input
          value={frpcPath}
          disabled={busy}
          aria-describedby={frpcHintId}
          placeholder={r.bundled}
          onChange={(e) => setFrpcPath(e.target.value)}
        />
      </label>
      <p id={frpcHintId} className="-mt-3 text-xs text-muted-foreground">
        {r.frpcHint}
      </p>
    </>
  );
  const bandwidthField = (
    <label className="grid gap-1.5">
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
  );
  return (
    <div className="grid gap-5">
      {!advancedIsOpen && connect === undefined && renderNotices()}
      {lanStatus?.config.enabled && (
        <SettingsNotice tone="warning">
          <div className="grid gap-1">
            <strong>{l.plaintextActiveTitle}</strong>
            {lanStatus.running && !lanUnavailable ? (
              <>
                <p>{r.lanRunning}</p>
                <p>{l.plaintextActive}</p>
              </>
            ) : (
              <p>{r.lanUnavailable}</p>
            )}
            <Button
              variant="link"
              size="content"
              className="justify-self-start"
              disabled={busy}
              onClick={() => {
                if (!getWebAdminState().busy) setLanOpen(true);
              }}
            >
              {pc.lanManage}
            </Button>
          </div>
        </SettingsNotice>
      )}
      <section className="rounded-xl border bg-card" aria-labelledby="remote-phone-title">
        <header className="flex flex-wrap items-start gap-3 p-5">
          <CardIcon>
            <Smartphone aria-hidden="true" />
          </CardIcon>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="remote-phone-title" className="text-base font-semibold">
                {pc.phone}
              </h2>
              {setupComplete && (
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${badge.className}`}
                >
                  <span aria-hidden="true" className={`size-1.5 rounded-full ${badge.dot}`} />
                  {badge.label}
                </span>
              )}
            </div>
            {setupComplete ? (
              relayActive ? (
                <p
                  className={`flex items-center gap-1.5 text-sm ${usageNear ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
                >
                  {usageNear && <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />}
                  {phoneSummary}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">{pc.pausedInfo}</p>
              )
            ) : (
              <p className="text-sm text-muted-foreground">{pc.phoneInfo}</p>
            )}
            {setupComplete && relayActive && !relayReady && connectionState}
            {!setupComplete && (
              <Button className="mt-3" disabled={busy} onClick={() => openConnect()}>
                <QrCode aria-hidden="true" />
                {pc.connectPhone}
              </Button>
            )}
          </div>
          {setupComplete && (
            <div className="flex items-center gap-2">
              {relayActive ? (
                // Opens even while not ready: the window shows connecting, the failure or the
                // re-registration a revoked device needs.
                <Button disabled={busy} onClick={() => openConnect()}>
                  <Plus aria-hidden="true" />
                  {p.connectNew}
                </Button>
              ) : (
                <Button
                  disabled={resumeNeedsLogin ? busy : resumeDisabled}
                  onClick={() => {
                    if (resumeNeedsLogin) openConnect();
                    else void resumeConnection();
                  }}
                >
                  <Play aria-hidden="true" />
                  {pc.resume}
                </Button>
              )}
              {moreMenu}
            </div>
          )}
        </header>
        {setupComplete && (
          <div className="px-5 pb-5 sm:pl-[4.5rem]">
            {status?.devices.length ? (
              <div
                aria-label={p.browsers.replace("{count}", String(status.devices.length))}
                className="divide-y rounded-lg border"
              >
                {browserRows}
              </div>
            ) : (
              status &&
              !loadFailed &&
              !operationError &&
              !status.error &&
              !busy && <p className="text-sm text-muted-foreground">{p.noBrowsers}</p>
            )}
          </div>
        )}
        {!!status?.pending.length && (
          <div className="border-t pb-2">
            <h3 className="px-5 pt-4 text-sm font-medium">{c.pending}</h3>
            {pendingRequests}
          </div>
        )}
      </section>
      <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
        {children}
      </fieldset>
      <Button
        variant="ghost"
        id="remote-advanced-trigger"
        className="justify-self-start text-muted-foreground"
        aria-label={pc.advanced}
        aria-describedby="remote-advanced-info"
        onClick={() => setAdvanced(true)}
      >
        <SlidersHorizontal aria-hidden="true" />
        {pc.advanced}
        <span id="remote-advanced-info" className="text-xs font-normal">
          {pc.advancedInfo}
        </span>
        <ChevronRight aria-hidden="true" />
      </Button>
      <Dialog
        open={advancedIsOpen}
        onOpenChange={(open) => {
          if (open) setAdvanced(true);
          else cancelAdvanced();
        }}
      >
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{pc.advanced}</DialogTitle>
            <DialogDescription className="sr-only">{pc.advancedInfo}</DialogDescription>
          </DialogHeader>
          {/* Only the fields scroll; Cancel and Save stay in view however long the form gets. */}
          <div className="-mx-4 grid min-h-0 flex-1 gap-5 overflow-y-auto px-4 py-1 text-sm">
            {migrationNotice}
            <div className="grid gap-2">
              <span className="font-medium">{pc.service}</span>
              <RadioGroup
                aria-label={pc.service}
                value={serviceChoice}
                disabled={busy}
                className="flex flex-wrap gap-x-6 gap-y-2"
                onValueChange={(value) => {
                  if (value === "official") {
                    if (serviceChoice === "self") selfHostedDraft.current = relayBroker;
                    setRelayBroker(OFFICIAL_BROKER_URL);
                    setInviteCode("");
                  } else if (value === "self") {
                    setRelayBroker(selfHostedDraft.current);
                    setInviteCode("");
                  }
                }}
              >
                <label className="flex items-center gap-2">
                  <RadioGroupItem value="official" />
                  {pc.official}
                  <span className="text-xs text-muted-foreground">{pc.officialInfo}</span>
                </label>
                <label className="flex items-center gap-2">
                  <RadioGroupItem value="self" />
                  {pc.selfHosted}
                  <span className="text-xs text-muted-foreground">{pc.selfHostedInfo}</span>
                </label>
              </RadioGroup>
            </div>
            {serviceChoice === "self" && (
              <>
                <label className="grid gap-1.5">
                  {pc.serviceAddress}
                  <Input
                    type="url"
                    value={relayBroker}
                    disabled={busy}
                    placeholder="https://relay.example.com"
                    onChange={(e) => {
                      setRelayBroker(e.target.value);
                      setInviteCode("");
                    }}
                  />
                </label>
                {invitation}
                {frpcField}
                {bandwidthField}
              </>
            )}
            {connectionDirty && (
              <p role="status" className="text-xs text-muted-foreground">
                {p.connectionDraft}
              </p>
            )}
            {brokerChanged && <p className="text-xs text-muted-foreground">{r.switchWarning}</p>}
            <fieldset disabled={busy} className="m-0 grid min-w-0 gap-3 border-0 p-0">
              {advancedContent}
            </fieldset>
            <Collapsible className="rounded-lg border">
              <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium">
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 transition-transform group-aria-expanded:rotate-90"
                />
                {pc.moreSettings}
                <span className="ml-auto text-xs font-normal text-muted-foreground">
                  {p.localWeb}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent keepMounted className="grid gap-3 border-t pt-3">
                {serviceChoice !== "self" && (
                  <div className="grid gap-3 px-3">
                    {frpcField}
                    {bandwidthField}
                  </div>
                )}
                <h3 className="px-3 pt-2 font-medium">{p.localWeb}</h3>
                {settingsForm}
              </CollapsibleContent>
            </Collapsible>
            {advancedIsOpen && renderNotices({ inset: false })}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={cancelAdvanced}>
              {pc.cancel}
            </Button>
            <Button
              disabled={
                busy ||
                settingsInvalid ||
                (connectionDirty && connectionDisabled) ||
                (!unsaved && !advancedDirty && !connectionDirty)
              }
              onClick={() => void saveAdvancedDialog()}
            >
              {activeOperation === "configure" || activeOperation === "remote-enable"
                ? c.saving
                : pc.save}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={connect !== undefined}
        onOpenChange={(open) => {
          if (!open) setConnect(undefined);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {connect === "wifi" ? pc.wifiTitle : pc.dialogTitle}
              {connect === "account" && stepIndex[phoneStep] !== undefined && (
                <span aria-hidden="true" className="flex gap-1">
                  {[0, 1, 2].map((index) => (
                    <span
                      key={index}
                      className={`size-1.5 rounded-full ${index === stepIndex[phoneStep] ? "bg-primary" : "bg-muted-foreground/30"}`}
                    />
                  ))}
                </span>
              )}
            </DialogTitle>
            <DialogDescription className="sr-only">{p.connectHint}</DialogDescription>
          </DialogHeader>
          {connect === "wifi" ? (
            <WebAccessSettings target="lan" mode="wifi" onBack={() => setConnect("account")} />
          ) : (
            <>
              {connectBody}
              {renderNotices({ inset: false })}
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={lanOpen} onOpenChange={setLanOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader className="sr-only">
            <DialogTitle>{p.lanSummary}</DialogTitle>
            <DialogDescription>{l.scope}</DialogDescription>
          </DialogHeader>
          {lanOpen && (
            <WebAccessSettings
              target="lan"
              hideNetworkFields
              onOpenNetworkSettings={() => {
                setLanOpen(false);
                setAdvanced(true);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <RemoteAccountSettings
        variant="dialog"
        manageOpen={accountOpen}
        onManageOpenChange={setAccountOpen}
        onStatusChange={setAccountStatus}
      />
      {confirmations}
    </div>
  );
}

function StepIntro({
  icon,
  title,
  info,
  tone = "primary",
}: {
  icon: ReactNode;
  title: string;
  info?: string;
  tone?: "primary" | "success" | "error";
}) {
  const colors =
    tone === "success"
      ? "bg-emerald-500/10 text-emerald-600"
      : tone === "error"
        ? "bg-destructive/10 text-destructive-text"
        : "bg-primary/10 text-primary-text";
  return (
    <div className="grid justify-items-start gap-2">
      <span
        className={`flex size-10 items-center justify-center rounded-full [&_svg]:size-5 ${colors}`}
      >
        {icon}
      </span>
      <h3 data-step-heading tabIndex={-1} className="text-base font-semibold outline-none">
        {title}
      </h3>
      {info && <p className="text-sm text-muted-foreground">{info}</p>}
    </div>
  );
}
