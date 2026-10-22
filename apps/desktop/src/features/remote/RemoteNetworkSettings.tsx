import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsNotice, SettingsRow } from "@/features/settings/components/SettingsLayout";
import { useI18n } from "@/core/useI18n";
import type { WebAdminStatus } from "../../../electron/main/web/service";
import { useRemoteStore } from "./remote-store";
import {
  getWebAdminState,
  requestWebAdmin,
  subscribeWebStatus,
  useWebAdminState,
} from "./web-status";
import { remoteNetworkCopy } from "./remote-network-copy";

type SaveResult = {
  lan: "saved" | "failed" | "unchanged";
  native: "saved" | "failed" | "unchanged" | "not-applied";
};

function privateIPv4(address: string) {
  const parts = address.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)
  )
    return false;
  const [first, second] = parts.map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function useRemoteNetworkSettings(): {
  content: ReactNode;
  dirty: boolean;
  busy: boolean;
  valid: boolean;
  save: () => Promise<boolean>;
  address: string;
} {
  const { locale } = useI18n();
  const c = remoteNetworkCopy[locale];
  const { snapshot, busy: nativeBusy, run } = useRemoteStore();
  const admin = useWebAdminState("lan");
  const [status, setStatus] = useState<WebAdminStatus>();
  const [savedLanAddress, setSavedLanAddress] = useState("");
  const [addressDraft, setAddressDraft] = useState<string>();
  const [portDraft, setPortDraft] = useState<number>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult>();
  const [retryLan, setRetryLan] = useState(false);
  const [retryNative, setRetryNative] = useState(false);
  const locked = useRef(false);
  const uncommittedLan = useRef(false);
  const mounted = useRef(false);
  const id = useId();
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeWebStatus("lan", {
      status: (next) => {
        setStatus(next);
        // A failed save may be visible in a later in-memory status before it reaches disk.
        // Do not let that status authorize a sharing switch to apply the unsaved address.
        if (
          !locked.current &&
          !uncommittedLan.current &&
          !getWebAdminState("lan").configurationUncertain
        )
          setSavedLanAddress(next.config.lanAddress ?? "");
      },
      error: () => setLoadFailed(true),
      success: () => setLoadFailed(false),
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, []);
  const nativeHost = snapshot?.local.address?.split(":")[0] ?? "";
  const conflict = Boolean(
    snapshot?.local.enabled && nativeHost && savedLanAddress && nativeHost !== savedLanAddress,
  );
  // A computer-sharing address does not mean phone LAN access saved that choice.
  // Keep it unselected until the user explicitly saves the shared interface.
  const savedAddress = conflict ? "" : savedLanAddress;
  const interfaces = (status?.addresses ?? []).filter(
    ({ address }, index, entries) =>
      privateIPv4(address) &&
      snapshot?.interfaces.some((entry) => entry.address === address) &&
      entries.findIndex((entry) => entry.address === address) === index,
  );
  const available = (address: string) => interfaces.some((entry) => entry.address === address);
  const chosenAddress =
    addressDraft ??
    (admin.configurationUncertain ? (status?.config.lanAddress ?? "") : savedAddress);
  const port = portDraft ?? status?.config.port ?? 1422;
  const lanChanged = Boolean(
    status &&
    ((addressDraft !== undefined && addressDraft !== (status.config.lanAddress ?? "")) ||
      (portDraft !== undefined && portDraft !== status.config.port) ||
      retryLan ||
      admin.configurationUncertain),
  );
  const nativeChanged = Boolean(
    snapshot?.local.enabled &&
    addressDraft !== undefined &&
    (nativeHost !== addressDraft || retryNative),
  );
  const dirty = lanChanged || nativeChanged;
  const portValid = Number.isInteger(port) && port >= 1024 && port <= 65535;
  const valid =
    !dirty ||
    Boolean(
      status &&
      snapshot &&
      !loadFailed &&
      portValid &&
      (!conflict || addressDraft !== undefined) &&
      (!(
        addressDraft !== undefined ||
        status.config.enabled ||
        nativeChanged ||
        (admin.configurationUncertain && chosenAddress)
      ) ||
        available(chosenAddress)),
    );
  const busy = saving || nativeBusy || admin.busy;
  const failed = result?.lan === "failed" || result?.native === "failed";
  const lost = Boolean(savedAddress && !available(savedAddress));

  async function save() {
    if (locked.current || busy || getWebAdminState("lan").busy || !valid) return false;
    if (!dirty) return true;
    if (!status || !snapshot) return false;
    locked.current = true;
    setSaving(true);
    setResult(undefined);
    const outcome: SaveResult = {
      lan: "unchanged",
      native: nativeChanged ? "not-applied" : "unchanged",
    };
    try {
      if (lanChanged) {
        uncommittedLan.current = true;
        try {
          const next = await requestWebAdmin({
            operation: "configure",
            target: "lan",
            ...status.config,
            ...(addressDraft === undefined ? {} : { lanAddress: addressDraft }),
            port,
          });
          if (next.error === "web_state_save_failed" || (next.config.enabled && next.error))
            throw new Error("lan_configuration_failed");
          uncommittedLan.current = false;
          outcome.lan = "saved";
          if (mounted.current) {
            setStatus(next);
            setSavedLanAddress(next.config.lanAddress ?? "");
            setRetryLan(false);
          }
        } catch {
          outcome.lan = "failed";
          if (mounted.current) setRetryLan(true);
          return false;
        }
      }
      if (nativeChanged) {
        const current = useRemoteStore.getState().snapshot;
        // The switch may have been turned off elsewhere while the LAN save was pending.
        // Saving an interface must never turn sharing back on.
        if (current?.local.enabled) {
          const next = await run({
            operation: "configure",
            enabled: current.local.enabled,
            name: current.local.name,
            address: `${chosenAddress}:${current.local.address?.split(":")[1] || "42987"}`,
          });
          if (!next || !("local" in next)) {
            outcome.native = "failed";
            if (mounted.current) setRetryNative(true);
            return false;
          }
          outcome.native = "saved";
        } else outcome.native = "unchanged";
        if (mounted.current) setRetryNative(false);
      }
      if (mounted.current) {
        // The parent can queue this callback behind another service's save.
        // Clear only the drafts it submitted, preserving edits made meanwhile.
        setAddressDraft((current) => (current === addressDraft ? undefined : current));
        setPortDraft((current) => (current === portDraft ? undefined : current));
      }
      return true;
    } catch {
      outcome.native = "failed";
      if (mounted.current) setRetryNative(true);
      return false;
    } finally {
      locked.current = false;
      if (mounted.current) {
        setSaving(false);
        setResult(outcome);
      }
    }
  }

  const outcomeText =
    result &&
    `${
      result.lan === "saved" ? c.lanSaved : result.lan === "failed" ? c.lanFailed : c.lanUnchanged
    } ${
      result.native === "saved"
        ? c.nativeSaved
        : result.native === "failed"
          ? c.nativeFailed
          : result.native === "not-applied"
            ? c.nativeNotApplied
            : c.nativeUnchanged
    }`;
  const warnings = [
    loadFailed && c.unavailable,
    status && snapshot && !interfaces.length && c.noInterface,
    conflict && c.conflict,
    lost && c.lost,
    dirty && !portValid && c.invalidPort,
    failed && outcomeText,
  ].filter(Boolean);
  return {
    dirty,
    busy,
    valid,
    save,
    address:
      !admin.configurationUncertain && !retryLan && !saving && available(savedAddress)
        ? savedAddress
        : "",
    content: (
      <div className="space-y-3 border-t pt-4" aria-label={c.title}>
        <h3 className="px-5 text-sm font-medium">{c.title}</h3>
        <p className="px-5 text-xs text-muted-foreground">{c.explicitChoice}</p>
        <SettingsRow>
          <label htmlFor={`${id}-interface`}>{c.interface}</label>
          <Select
            value={chosenAddress || null}
            disabled={busy || !status || !snapshot}
            onValueChange={(value) => {
              if (value !== null) {
                setAddressDraft(value);
                setResult(undefined);
              }
            }}
          >
            <SelectTrigger id={`${id}-interface`} className="max-w-full min-w-0">
              <SelectValue placeholder={c.choose}>
                {chosenAddress
                  ? `${interfaces.find((entry) => entry.address === chosenAddress)?.name ?? ""} · ${chosenAddress}`
                  : c.choose}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {interfaces.map(({ name, address }) => (
                  <SelectItem key={address} value={address}>
                    {name} · {address}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow>
          <label htmlFor={`${id}-port`}>{c.port}</label>
          <Input
            id={`${id}-port`}
            type="number"
            min={1024}
            max={65535}
            value={port}
            disabled={busy || !status}
            onChange={(event) => {
              setPortDraft(Number(event.target.value));
              setResult(undefined);
            }}
          />
        </SettingsRow>
        {lanChanged && <SettingsNotice tone="warning">{c.revokeWarning}</SettingsNotice>}
        {!!warnings.length && (
          <SettingsNotice tone="warning" role="alert">
            {warnings.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
          </SettingsNotice>
        )}
        {result && !failed && <SettingsNotice role="status">{outcomeText}</SettingsNotice>}
      </div>
    ),
  };
}
