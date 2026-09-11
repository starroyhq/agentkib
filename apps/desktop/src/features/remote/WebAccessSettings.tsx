import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Check, Copy } from "lucide-react";
import { requestWebAdmin, subscribeWebStatus } from "./web-status";
import { useI18n } from "@/core/useI18n";
import {
  SettingsSection,
  SettingsRow,
  SettingsCopy,
  SettingsNotice,
} from "@/features/settings/components/SettingsLayout";
import type {
  WebAdminRequest,
  WebAdminStatus,
  WebConfig,
} from "../../../electron/main/web/service";
import { webSettingsCopy } from "./web-settings-copy";
import { lanSettingsCopy } from "./lan-settings-copy";
import { ConnectionQr } from "./ConnectionQr";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function WebAccessSettings({ target }: { target?: "lan" } = {}) {
  const { locale, tr, formatDateTime } = useI18n();
  const lan = target === "lan";
  const l = lanSettingsCopy[locale];
  const c = { ...webSettingsCopy[locale], ...(lan ? l : {}) };
  const fieldPrefix = lan ? "lan-web" : "web";
  const [status, setStatus] = useState<WebAdminStatus>();
  const [config, setConfig] = useState<WebConfig>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [grants, setGrants] = useState<Record<string, { send: boolean; approve: boolean }>>({});
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeWebStatus(target, {
      status: (next) => {
        setStatus(next);
        setConfig((old) => old ?? next.config);
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
    setBusy(true);
    setError("");
    try {
      const next = await requestWebAdmin({ ...input, ...(lan ? { target } : {}) });
      if (mounted.current) {
        setStatus(next);
        if (input.operation === "configure") setConfig(next.config);
      }
    } catch {
      if (mounted.current) setError(c.unavailable);
    } finally {
      if (mounted.current) setBusy(false);
    }
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
  return (
    <SettingsSection title={c.title}>
      <SettingsNotice>{c.scope}</SettingsNotice>
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
            : lan && status.error === "lan_address_unavailable"
              ? l.addressLost
              : c.unavailable}
        </SettingsNotice>
      )}
      {!config ? (
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
                    {(status?.addresses ?? []).map(({ name, address }) => (
                      <SelectItem key={`${name}-${address}`} value={address}>
                        {name} · {address}
                      </SelectItem>
                    ))}
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
                placeholder="https://agent.example.com"
                value={config.externalOrigin}
                disabled={busy}
                onChange={(e) => setConfig({ ...config, externalOrigin: e.target.value })}
              />
            </SettingsRow>
          )}
          <SettingsRow>
            <SettingsCopy>
              <strong>{c.experimental}</strong>
              <small>{status?.experimentalAvailable ? c.warning : c.unverified}</small>
            </SettingsCopy>
            <Switch
              aria-label={c.experimental}
              checked={config.experimentalEnabled}
              disabled={busy || !status?.experimentalAvailable}
              onCheckedChange={(experimentalEnabled) =>
                setConfig({ ...config, experimentalEnabled })
              }
            />
          </SettingsRow>
          <div className="flex flex-wrap justify-end gap-2 border-b px-5 py-3">
            <Button
              disabled={
                busy ||
                !Number.isInteger(config.port) ||
                config.port < 1024 ||
                config.port > 65535 ||
                (lan &&
                  config.enabled &&
                  (!config.allowPlaintext ||
                    !status?.addresses?.some(({ address }) => address === config.lanAddress)))
              }
              onClick={() => void run({ operation: "configure", ...config })}
            >
              {c.save}
            </Button>
            <Button
              variant="outline"
              disabled={busy || !status?.running}
              onClick={() => void run({ operation: "generate-code" })}
            >
              {c.generate}
            </Button>
          </div>
        </>
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
      {status?.code && status.code.expiresAt > Date.now() && (
        <SettingsNotice className="items-center justify-end gap-3">
          <div className="flex min-w-0 flex-wrap items-baseline justify-end gap-x-3 gap-y-1">
            <strong className="font-mono text-xl tracking-widest">{status.code.value}</strong>
            <p>
              {c.expires} {formatDateTime(new Date(status.code.expiresAt))}
            </p>
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
      )}
      <h3 className="px-5 pt-4 text-sm font-medium">{c.pending}</h3>
      {!status?.pending.length && (
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
            {(["send", "approve"] as const).map((permission) => (
              <label key={permission} className="mr-4 inline-flex items-center gap-2">
                <Checkbox
                  disabled={busy}
                  checked={grant[permission]}
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
            <div className="flex gap-2">
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
              {[c.read, device.send && c.send, device.approve && c.approve]
                .filter(Boolean)
                .join(" · ")}
            </small>
          </SettingsCopy>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run({ operation: "revoke", id: device.id })}
          >
            {c.revoke}
          </Button>
        </SettingsRow>
      ))}
    </SettingsSection>
  );
}
