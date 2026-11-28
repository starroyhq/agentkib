import { McpChoice } from "@/features/mcp/McpControls";
import { SelectItem } from "@agentkib/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useRef, useState } from "react";
import type {
  ManagedMcpServer,
  McpManagedEntry,
  McpSecretOperation,
} from "@agentkib/runtime-protocol";
import { api } from "@/core/api";
import { useI18n } from "@/core/useI18n";
import { Button } from "@agentkib/ui/button";
import { Input } from "@agentkib/ui/input";
import { Textarea } from "@agentkib/ui/textarea";
import { AGENT_LABELS } from "@/core/agents";
import { changeMcpTargets, MCP_MANAGED_AGENTS } from "./mcp-targets";

export interface McpEditorDraft {
  json: string;
  secrets: { env: Record<string, McpSecretOperation>; headers: Record<string, McpSecretOperation> };
}
export function newMcpDraft(entry?: McpManagedEntry): McpEditorDraft {
  const config = entry?.config ?? {
    id: "my-server",
    name: "My Server",
    enabled: false,
    transport: "streamable-http",
    url: "https://example.com/mcp",
    env: {},
    headers: {},
    targets: [],
    allow_tools: [],
    lan_allow_tools: [],
    supports_parallel_tool_calls: false,
  };
  return {
    json: JSON.stringify({ ...config, env: {}, headers: {} }, null, 2),
    secrets: { env: {}, headers: {} },
  };
}
export function McpServiceEditor({
  project,
  revision,
  entry,
  draft,
  onDraft,
  onSaved,
  onCancel,
}: {
  project?: string;
  revision: string;
  entry?: McpManagedEntry;
  draft: McpEditorDraft;
  onDraft: (draft: McpEditorDraft) => void;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const { tr, localizeMessage } = useI18n();
  const [mode, setMode] = useState<"form" | "json">("form");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [extra, setExtra] = useState({ env: "", headers: "" });
  const alive = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  let config: ManagedMcpServer | undefined;
  try {
    const parsed: unknown = JSON.parse(draft.json);
    if (
      parsed &&
      typeof parsed === "object" &&
      "transport" in parsed &&
      "id" in parsed &&
      "name" in parsed &&
      "targets" in parsed &&
      typeof parsed.id === "string" &&
      typeof parsed.name === "string" &&
      Array.isArray(parsed.targets) &&
      parsed.targets.every((value) => typeof value === "string") &&
      (parsed.transport === "stdio"
        ? "command" in parsed &&
          typeof parsed.command === "string" &&
          "args" in parsed &&
          Array.isArray(parsed.args) &&
          parsed.args.every((value) => typeof value === "string")
        : ["streamable-http", "sse"].includes(String(parsed.transport)) &&
          "url" in parsed &&
          typeof parsed.url === "string")
    )
      config = parsed as ManagedMcpServer;
  } catch {
    /* Keep invalid JSON editable. */
  }
  function update(patch: Partial<ManagedMcpServer>) {
    if (config) onDraft({ ...draft, json: JSON.stringify({ ...config, ...patch }, null, 2) });
  }
  function secret(group: "env" | "headers", key: string, operation: McpSecretOperation) {
    onDraft({
      ...draft,
      secrets: { ...draft.secrets, [group]: { ...draft.secrets[group], [key]: operation } },
    });
  }
  async function save() {
    if (pending.current) return;
    setError("");
    try {
      const parsed = JSON.parse(draft.json) as ManagedMcpServer;
      if (entry && parsed.id !== entry.config.id) throw new Error(tr("mcp.manage.idLocked"));
      if (!entry) parsed.enabled = false;
      if (Object.keys(parsed.env ?? {}).length || Object.keys(parsed.headers ?? {}).length)
        throw new Error(tr("mcp.manage.useSecretFields"));
      pending.current = true;
      setBusy(true);
      await api.saveMcpConfiguration({
        project,
        revision,
        server: parsed,
        originalId: entry?.config.id,
        secretOperations: draft.secrets,
        overrideInherited: entry?.inherited ?? false,
      });
      if (alive.current) await onSaved();
    } catch (reason) {
      if (alive.current) setError(localizeMessage(reason));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="grid gap-4 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3>
          {tr(
            entry
              ? entry.inherited
                ? "mcp.manage.createOverride"
                : "mcp.manage.edit"
              : "mcp.manage.add",
          )}
        </h3>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setMode(mode === "form" ? "json" : "form")}
          >
            {mode === "form" ? "JSON" : tr("mcp.manage.form")}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            {tr("common.cancel")}
          </Button>
        </div>
      </div>
      {!entry && <p className="text-sm">{tr("mcp.manage.disabledByDefault")}</p>}
      {error && (
        <p role="alert" className="text-destructive-text">
          {error}
        </p>
      )}
      {mode === "json" || !config ? (
        <label>
          JSON
          <Textarea
            disabled={busy}
            aria-label="MCP JSON"
            className="min-h-64 font-mono"
            spellCheck={false}
            value={draft.json}
            onChange={(e) => onDraft({ ...draft, json: e.target.value })}
          />
        </label>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <label>
            ID
            <Input
              disabled={busy || !!entry}
              value={config.id ?? ""}
              onChange={(e) => update({ id: e.target.value })}
            />
          </label>
          <label>
            {tr("mcp.manage.name")}
            <Input
              disabled={busy}
              value={config.name ?? ""}
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          <label>
            {tr("mcp.manage.transport")}{" "}
            <McpChoice
              disabled={busy}
              value={config.transport}
              onValueChange={(value) =>
                onDraft({
                  ...draft,
                  json: JSON.stringify(
                    {
                      ...config,
                      transport: value,
                      ...(value === "stdio"
                        ? { command: "", args: [], url: undefined }
                        : {
                            url: "https://example.com/mcp",
                            command: undefined,
                            args: undefined,
                            cwd: undefined,
                          }),
                    },
                    null,
                    2,
                  ),
                })
              }
            >
              <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
              <SelectItem value="stdio">stdio</SelectItem>
            </McpChoice>
          </label>
          {config.transport === "stdio" ? (
            <>
              <label>
                {tr("mcp.manage.command")}
                <Input
                  disabled={busy}
                  value={config.command ?? ""}
                  onChange={(e) => update({ command: e.target.value })}
                />
              </label>
              <label>
                {tr("mcp.manage.arguments")}
                <Textarea
                  disabled={busy}
                  value={(config.args ?? []).join("\n")}
                  onChange={(e) =>
                    update({ args: e.target.value ? e.target.value.split("\n") : [] })
                  }
                />
              </label>
              <label>
                {tr("mcp.manage.cwd")}
                <Input
                  disabled={busy}
                  value={config.cwd ?? ""}
                  onChange={(e) => update({ cwd: e.target.value || undefined })}
                />
              </label>
            </>
          ) : (
            <label>
              URL
              <Input
                disabled={busy}
                value={config.url ?? ""}
                onChange={(e) => update({ url: e.target.value })}
              />
            </label>
          )}
          <div className="col-span-full flex flex-wrap gap-3">
            <span>{tr("mcp.manage.targets")}</span>
            {MCP_MANAGED_AGENTS.map((agent) => (
              <label key={agent} className="flex gap-1">
                <Checkbox
                  disabled={busy}
                  checked={!config?.targets.length || config.targets.includes(agent)}
                  onCheckedChange={(checked) => {
                    const next = changeMcpTargets(config?.targets ?? [], agent, checked);
                    if (!next) {
                      setError(tr("mcp.manage.lastTarget"));
                      return;
                    }
                    update({ targets: next });
                  }}
                />
                {AGENT_LABELS[agent]}
              </label>
            ))}
          </div>
        </div>
      )}
      {(["env", "headers"] as const).map((group) => {
        const groupLabel = tr(group === "env" ? "mcp.environmentSecrets" : "mcp.headerSecrets");
        const keys = [
          ...new Set([
            ...((group === "env" ? entry?.configured_env : entry?.configured_headers) ?? []),
            ...((group === "env" ? entry?.required_env : entry?.required_headers) ?? []),
            ...Object.keys(draft.secrets[group]),
          ]),
        ];
        return (
          <div key={group} className="grid gap-2">
            <h4>{groupLabel}</h4>
            {keys.map((key) => {
              const op = draft.secrets[group][key] ?? { action: "keep" };
              return (
                <div key={key} className="flex flex-wrap items-center gap-2">
                  <code>{key}</code>
                  <McpChoice
                    aria-label={tr("mcp.manage.secretAction", {
                      group: groupLabel,
                      key,
                    })}
                    disabled={busy}
                    value={op.action}
                    onValueChange={(value) =>
                      secret(
                        group,
                        key,
                        value === "replace"
                          ? { action: "replace", value: "" }
                          : { action: value as "keep" | "delete" },
                      )
                    }
                  >
                    {(["keep", "replace", "delete"] as const).map((action) => (
                      <SelectItem value={action} key={action}>
                        {tr(`mcp.manage.secret_${action}`)}
                      </SelectItem>
                    ))}
                  </McpChoice>
                  {op.action === "replace" && (
                    <Input
                      type="password"
                      autoComplete="off"
                      aria-label={tr("mcp.manage.secretValue", {
                        group: groupLabel,
                        key,
                      })}
                      disabled={busy}
                      value={op.value}
                      onChange={(e) =>
                        secret(group, key, { action: "replace", value: e.target.value })
                      }
                    />
                  )}
                </div>
              );
            })}
            <div className="flex gap-2">
              <Input
                aria-label={tr("mcp.manage.secretKeyLabel", {
                  group: groupLabel,
                })}
                placeholder={tr("mcp.manage.secretKey")}
                disabled={busy}
                value={extra[group]}
                onChange={(e) => setExtra((old) => ({ ...old, [group]: e.target.value }))}
              />
              <Button
                variant="outline"
                disabled={busy || !extra[group].trim()}
                onClick={() => {
                  secret(group, extra[group].trim(), { action: "replace", value: "" });
                  setExtra((old) => ({ ...old, [group]: "" }));
                }}
              >
                {tr("mcp.manage.addKey")}
              </Button>
            </div>
          </div>
        );
      })}
      <Button disabled={busy} onClick={() => void save()}>
        {tr("common.save")}
      </Button>
    </section>
  );
}
