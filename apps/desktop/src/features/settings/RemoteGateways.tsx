import { useI18n } from "@/core/useI18n";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { useState } from "react";
import { Pencil, Plus, RefreshCw, Server, Trash2, X } from "lucide-react";
import { api } from "@/core/api";
import type {
  RemoteGatewayAuthKind,
  RemoteGatewayInput,
  RemoteGatewayKind,
  RemoteGatewaySummary,
} from "@/core/types";
import { SettingsNotice, SettingsPanel } from "./components/SettingsLayout";
import { withAsyncCleanup } from "@/lib/utils";

const emptyGateway = (): RemoteGatewayInput => ({
  kind: "open-claw",
  name: "OpenClaw",
  url: "",
  auth_kind: "token",
});
const gatewayControlClass = "h-10";

function authKinds(kind: RemoteGatewayKind): RemoteGatewayAuthKind[] {
  return kind === "open-claw" ? ["token", "password", "none"] : ["session-token", "basic", "none"];
}

export function RemoteGatewaysSettings({
  gateways,
  onChanged,
}: {
  gateways: RemoteGatewaySummary[];
  onChanged: () => Promise<void>;
}) {
  const { tr, formatDateTime, localizeMessage } = useI18n();
  const dialogs = useAppDialogs();
  const [draft, setDraft] = useState<RemoteGatewayInput>();
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState("");

  const edit = (gateway?: RemoteGatewaySummary) => {
    setError("");
    setDraft(
      gateway
        ? {
            id: gateway.id,
            kind: gateway.kind,
            name: gateway.name,
            url: gateway.url,
            auth_kind: gateway.auth_kind,
            username: gateway.username,
          }
        : emptyGateway(),
    );
  };

  const save = async () => {
    if (!draft) return;
    setBusyId(draft.id ?? "new");
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          const saved = await api.saveRemoteGateway(draft);
          await api.refreshRemoteGateway(saved.id);
          setDraft(undefined);
          await onChanged();
        } catch (cause) {
          setError(localizeMessage(cause));
        }
      },
      () => setBusyId(undefined),
    );
  };

  const refresh = async (id: string) => {
    setBusyId(id);
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          await api.refreshRemoteGateway(id);
          await onChanged();
        } catch (cause) {
          setError(localizeMessage(cause));
        }
      },
      () => setBusyId(undefined),
    );
  };

  const remove = async (id: string) => {
    if (!(await dialogs.confirm({ description: tr("gateway.removeConfirm"), tone: "destructive" })))
      return;
    setBusyId(id);
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          await api.removeRemoteGateway(id);
          await onChanged();
        } catch (cause) {
          setError(localizeMessage(cause));
        }
      },
      () => setBusyId(undefined),
    );
  };

  return (
    <SettingsPanel
      title={tr("gateway.title")}
      action={
        <Button onClick={() => edit()}>
          <Plus size={14} />
          {tr("gateway.add")}
        </Button>
      }
    >
      {error && (
        <SettingsNotice tone="error" role="alert">
          {error}
        </SettingsNotice>
      )}
      {draft && (
        <form
          className="grid gap-4 border-b border-border/60 bg-muted/10 p-5 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Label className="grid gap-1.5 text-xs text-muted-foreground">
            <span>{tr("gateway.kind")}</span>
            <Select
              value={draft.kind}
              onValueChange={(value) => {
                if (value === null) return;
                const kind = String(value) as RemoteGatewayKind;
                setDraft({
                  ...draft,
                  kind,
                  auth_kind: authKinds(kind)[0],
                  name: draft.id ? draft.name : kind === "open-claw" ? "OpenClaw" : "Hermes",
                });
              }}
            >
              <SelectTrigger className={gatewayControlClass} aria-label={tr("gateway.kind")}>
                <SelectValue>{draft.kind === "open-claw" ? "OpenClaw" : "Hermes"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open-claw">OpenClaw</SelectItem>
                <SelectItem value="hermes">Hermes</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          <Label className="grid gap-1.5 text-xs text-muted-foreground">
            <span>{tr("gateway.name")}</span>
            <Input
              required
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Label>
          <Label className="grid gap-1.5 text-xs text-muted-foreground sm:col-span-2">
            <span>{tr("gateway.url")}</span>
            <Input
              required
              type="url"
              value={draft.url}
              placeholder={
                draft.kind === "open-claw"
                  ? "wss://gateway.example.com"
                  : "https://hermes.example.com"
              }
              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
            />
          </Label>
          <Label className="grid gap-1.5 text-xs text-muted-foreground">
            <span>{tr("gateway.auth")}</span>
            <Select
              value={draft.auth_kind}
              onValueChange={(value) => {
                if (value !== null)
                  setDraft({ ...draft, auth_kind: String(value) as RemoteGatewayAuthKind });
              }}
            >
              <SelectTrigger className={gatewayControlClass} aria-label={tr("gateway.auth")}>
                <SelectValue>{tr(`gateway.auth.${draft.auth_kind}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {authKinds(draft.kind).map((kind) => (
                  <SelectItem value={kind} key={kind}>
                    {tr(`gateway.auth.${kind}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
          {draft.auth_kind === "basic" && (
            <Label className="grid gap-1.5 text-xs text-muted-foreground">
              <span>{tr("gateway.username")}</span>
              <Input
                required
                value={draft.username ?? ""}
                onChange={(event) => setDraft({ ...draft, username: event.target.value })}
              />
            </Label>
          )}
          {draft.auth_kind !== "none" && (
            <Label className="grid gap-1.5 text-xs text-muted-foreground">
              <span>{tr("gateway.secret")}</span>
              <Input
                type="password"
                required={
                  !draft.id ||
                  gateways.find((gateway) => gateway.id === draft.id)?.auth_kind !== draft.auth_kind
                }
                value={draft.secret ?? ""}
                placeholder={draft.id ? tr("gateway.secretKeep") : ""}
                onChange={(event) => setDraft({ ...draft, secret: event.target.value })}
              />
            </Label>
          )}
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => setDraft(undefined)}>
              <X size={14} />
              {tr("common.cancel")}
            </Button>
            <Button type="submit" disabled={Boolean(busyId)}>
              {tr("common.save")}
            </Button>
          </div>
        </form>
      )}
      <div className="grid">
        {gateways.map((gateway) => (
          <article
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-t border-border/60 px-5 py-4 first:border-t-0"
            key={gateway.id}
          >
            <Server size={17} className="mt-0.5 text-primary" />
            <div className="grid min-w-0 gap-1.5">
              <div className="flex items-center gap-2">
                <strong className="text-sm">{gateway.name}</strong>
                <Badge variant={gateway.state === "connected" ? "secondary" : "outline"}>
                  {tr(`gateway.state.${gateway.state}`)}
                </Badge>
              </div>
              <code className="truncate text-xs text-muted-foreground">{gateway.url}</code>
              <small className="text-xs text-muted-foreground">
                {tr("gateway.workspaceCount", { count: gateway.workspaces.length })} ·{" "}
                {tr("gateway.sessionCount", { count: gateway.session_count })} ·{" "}
                {tr("gateway.assetCount", { count: gateway.assets.length })}
                {gateway.last_connected_at ? ` · ${formatDateTime(gateway.last_connected_at)}` : ""}
              </small>
              {gateway.kind === "hermes" && gateway.state === "connected" && (
                <small className="text-xs text-amber-600">{tr("gateway.hermesPartial")}</small>
              )}
              {gateway.pairing_request_id && (
                <div className="mt-1 grid gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                  <strong>{tr("gateway.pairingRequired")}</strong>
                  <code className="overflow-x-auto text-amber-700">
                    openclaw devices approve {gateway.pairing_request_id}
                  </code>
                </div>
              )}
              {gateway.last_error && (
                <small className="whitespace-pre-wrap text-xs text-destructive">
                  {gateway.last_error}
                </small>
              )}
            </div>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="icon"
                title={tr("gateway.refresh")}
                disabled={Boolean(busyId)}
                onClick={() => void refresh(gateway.id)}
              >
                <RefreshCw size={14} className={busyId === gateway.id ? "animate-spin" : ""} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title={tr("gateway.edit")}
                disabled={Boolean(busyId)}
                onClick={() => edit(gateway)}
              >
                <Pencil size={14} />
              </Button>
              <Button
                variant="destructive"
                size="icon"
                title={tr("gateway.remove")}
                disabled={Boolean(busyId)}
                onClick={() => void remove(gateway.id)}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </article>
        ))}
        {!gateways.length && !draft && (
          <div className="px-5 py-5 text-sm text-muted-foreground">{tr("gateway.empty")}</div>
        )}
      </div>
    </SettingsPanel>
  );
}
