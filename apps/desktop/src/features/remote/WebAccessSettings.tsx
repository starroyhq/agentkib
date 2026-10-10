import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Check, Copy } from "lucide-react";
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

export function WebAccessSettings({ target }: { target?: "lan" } = {}) {
  const { locale, tr, formatDateTime } = useI18n();
  const lan = target === "lan";
  const l = lanSettingsCopy[locale];
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeOperation, setActiveOperation] = useState<WebAdminRequest["operation"]>();
  const [codeCopied, setCodeCopied] = useState(false);
  const [extraRootsText, setExtraRootsText] = useState<string>();
  const [relayBroker, setRelayBroker] = useState("");
  const [frpcPath, setFrpcPath] = useState("");
  const frpcHintId = useId();
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
  const now = useDeadlineClock(status?.code?.expiresAt, status?.relay?.retryAt);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeWebStatus(target, {
      status: (next) => {
        setStatus(next);
        setConfig((old) => old ?? next.config);
        setRelayBroker((old) => old || next.config.relay?.brokerUrl || "https://api.agentkib.com");
        setFrpcPath((old) => old || next.config.relay?.frpcPath || "");
      },
      error: () => setError(c.unavailable),
      success: () => setError(""),
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [c.unavailable, lan, target]);
  async function run(input: WebAdminRequest) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setActiveOperation(input.operation);
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          const next = await requestWebAdmin({ ...input, ...(lan ? { target } : {}) });
          if (mounted.current) {
            setStatus(next);
            if (
              input.operation === "configure" ||
              input.operation === "relay-start" ||
              input.operation === "remote-enable" ||
              input.operation === "relay-stop"
            )
              setConfig(next.config);
          }
        } catch {
          if (mounted.current) setError(c.unavailable);
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
  const levelLabel = (level: WebAccessLevel) =>
    level === "read" ? c.readOnlyAccess : c.fullAccess;
  const generateCode = () =>
    run({ operation: "generate-code", ...(codeAccess ? { access: codeLevel } : {}) });
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
      <SettingsRow>
        <SettingsCopy>
          <strong>{c.enabled}</strong>
          <small>{status?.running ? `${c.running} · ${status.localUrl}` : c.stopped}</small>
        </SettingsCopy>
        <Switch
          aria-label={c.enabled}
          checked={config.enabled}
          disabled={busy}
          onCheckedChange={(enabled) => setConfig({ ...config, enabled })}
        />
      </SettingsRow>
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
      {lan ? (
        <>
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
          <Switch
            aria-label={c.experimental}
            checked={config.experimentalEnabled}
            disabled={busy || !status?.experimentalAvailable}
            onCheckedChange={(experimentalEnabled) => setConfig({ ...config, experimentalEnabled })}
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
              value={
                extraRootsText ?? (config.extraRoots ?? []).map((root) => root.path).join("\n")
              }
              onChange={(event) => setExtraRootsText(event.target.value)}
            />
          </label>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2 border-b px-5 py-3">
        <Button
          disabled={
            busy ||
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
          onClick={() =>
            void run({
              operation: "configure",
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
            })
          }
        >
          {c.save}
        </Button>
        {(lan || manualAccess) && (
          <>
            {accessLevelSelect}
            <Button
              variant="outline"
              disabled={busy || !status?.running}
              onClick={() => void generateCode()}
            >
              {codeAccess ? c.generateAccess : c.generate}
            </Button>
          </>
        )}
      </div>
      {manualAccess && (
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">{r.manualAccess}</p>
          {pairingCode}
        </div>
      )}
    </>
  );
  return (
    <SettingsSection title={c.title}>
      {!lan && <RemoteAccountSettings />}
      <SettingsNotice>{codeAccess ? c.codeScope : c.scope}</SettingsNotice>
      {status?.acceptanceSessionId && (
        <SettingsNotice>
          {c.acceptance} <code>{status.acceptanceSessionId}</code>
        </SettingsNotice>
      )}
      {error && (
        <SettingsNotice tone="error" inset={false} className="text-sm" role="alert">
          {error}
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
      {lan && settingsForm}
      {!lan && (
        <div className="space-y-3 border-b px-5 py-4 text-sm">
          <h3 className="font-medium">{r.remoteTitle}</h3>
          <p className="text-xs text-muted-foreground">
            {codeAccess ? r.codeInstructions : r.instructions}
          </p>
          {!config && <p role="status">{c.loading}</p>}

          {legacyBroker && (
            <SettingsNotice tone="warning" role="status">
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
            </SettingsNotice>
          )}
          {!remoteEnabled && (
            <label className="block">
              {r.invitation}
              <Input
                type="password"
                autoComplete="off"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
              />
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                busy ||
                remoteEnabled ||
                !config ||
                !relayBroker.trim() ||
                (legacyBroker && legacyBrokerUrls.includes(relayBroker.replace(/\/$/, ""))) ||
                ((status?.relay?.reason === "revoked" || migrating) && !inviteCode.trim())
              }
              onClick={() => {
                void run({
                  operation: "remote-enable",
                  brokerUrl: relayBroker,
                  ...(frpcPath.trim() ? { frpcPath: frpcPath.trim() } : {}),
                  ...(inviteCode ? { inviteCode } : {}),
                  ...(status?.relay?.reason === "revoked" ? { reenroll: true } : {}),
                });
                setInviteCode("");
              }}
            >
              {remoteEnabled
                ? r.enabledRemote
                : migrating
                  ? r.confirmMigration
                  : status?.relay?.reason === "revoked"
                    ? r.reenroll
                    : r.enable}
            </Button>
            <Button
              variant="outline"
              disabled={busy || !status?.relay || status.relay.phase === "disabled"}
              onClick={() => void run({ operation: "relay-stop" })}
            >
              {r.pause}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{r.pauseHint}</p>
          <p role="status">
            {activeOperation === "remote-enable"
              ? r.phases.connecting
              : status?.relay?.phase === "ready" && status.pending.length
                ? r.pendingPhone
                : r.phases[status?.relay?.phase ?? "disabled"]}
            {status?.relay?.reason
              ? ` · ${r.reasons[status.relay.reason]}`
              : status?.relay?.error
                ? ` · ${status.relay.error}`
                : ""}
          </p>
          {status?.relay?.failure && status.relay.phase !== "ready" && (
            <p className="text-xs text-muted-foreground" role="status">
              {r.failureStages[status.relay.failure.stage]}:{" "}
              {r.failureCodes[status.relay.failure.code]}
            </p>
          )}
          {status?.relay?.connectorExit && (
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
          {status?.relay?.retryAt && status.relay.retryAt > now && (
            <p className="text-xs text-muted-foreground">
              {r.retryAt} {formatDateTime(new Date(status.relay.retryAt))}
            </p>
          )}
          {status?.relay?.channels && status.relay.phase !== "disabled" && (
            <p className="text-xs text-muted-foreground">
              {r.control}：{status.relay.channels.control ? "✓" : "…"}
              {" · "}
              {r.preview}：{status.relay.channels.preview ? "✓" : "…"}
            </p>
          )}
          {status?.relay?.certificateWarning && (
            <p role="status" className="text-xs text-muted-foreground">
              {r.certificateWarning}
            </p>
          )}
          {status?.relay?.phase === "ready" && (
            <div className="flex flex-wrap items-center gap-2">
              {accessLevelSelect}
              <Button variant="outline" disabled={busy} onClick={() => void generateCode()}>
                {codeAccess ? c.generateAccess : c.generate}
              </Button>
            </div>
          )}
          {status?.relay?.phase === "ready" && status.relay.publicUrl && (
            <div className="space-y-2">
              <ConnectionQr url={status.relay.publicUrl} label={r.scan} />
              <Input readOnly value={status.relay.publicUrl} onFocus={(e) => e.target.select()} />
            </div>
          )}
          <Collapsible className="space-y-3">
            <CollapsibleTrigger className="cursor-pointer text-muted-foreground">
              {r.advanced}
            </CollapsibleTrigger>
            <CollapsibleContent keepMounted className="space-y-3">
              <label className="block">
                {r.broker}
                <Input
                  type="url"
                  value={relayBroker}
                  placeholder="https://api.agentkib.com"
                  onChange={(e) => setRelayBroker(e.target.value)}
                />
              </label>
              <label className="block">
                {r.frpc}
                <Input
                  value={frpcPath}
                  aria-describedby={frpcHintId}
                  placeholder={r.bundled}
                  onChange={(e) => setFrpcPath(e.target.value)}
                />
              </label>
              <p id={frpcHintId} className="text-xs text-muted-foreground">
                {r.frpcHint}
              </p>
              <label className="block">
                {r.bandwidth}
                <Input
                  type="number"
                  min={16}
                  max={1048576}
                  step={1}
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
              <p className="text-xs text-muted-foreground">{r.switchWarning}</p>
              {settingsForm}
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
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
      {(lan || status?.relay?.phase === "ready") && pairingCode}
      {(!codeAccess || Boolean(status?.pending.length)) && (
        <h3 className="px-5 pt-4 text-sm font-medium">{c.pending}</h3>
      )}
      {!codeAccess && !status?.pending.length && (
        <p className="px-5 py-3 text-sm text-muted-foreground">{c.empty}</p>
      )}
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
      <h3 className="px-5 pt-4 text-sm font-medium">{c.devices}</h3>
      {!status?.devices.length && (
        <p className="px-5 py-3 text-sm text-muted-foreground">{c.empty}</p>
      )}
      {status?.devices.map((device) => (
        <SettingsRow key={device.id}>
          <SettingsCopy>
            <strong>{device.name}</strong>
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
              variant="outline"
              disabled={busy}
              onClick={() => void run({ operation: "revoke", id: device.id })}
            >
              {c.revoke}
            </Button>
          </div>
        </SettingsRow>
      ))}
    </SettingsSection>
  );
}
