import { McpChoice } from "@/features/mcp/McpControls";
import { SelectItem } from "@agentkib/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useRef, useState } from "react";
import type {
  McpAgent,
  McpToolPolicyRule,
  McpToolPolicySnapshot,
} from "@agentkib/runtime-protocol";
import { api } from "@/core/api";
import { AGENT_LABELS } from "@/core/agents";
import { MCP_MANAGED_AGENTS } from "./mcp-targets";
import { useI18n } from "@/core/useI18n";
import { Button } from "@agentkib/ui/button";
import { McpRuntimeProbe } from "./McpRuntimeProbe";

export function McpPolicyEditor({
  project,
  serverId,
  revision,
  onSaved,
}: {
  project?: string;
  serverId: string | null;
  revision: string;
  onSaved: () => Promise<void>;
}) {
  const { tr, localizeMessage } = useI18n();
  const [snapshot, setSnapshot] = useState<McpToolPolicySnapshot>();
  const [agent, setAgent] = useState<McpAgent>("codex");
  const [rules, setRules] = useState<McpToolPolicyRule[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  const active = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    active.current = true;
    let cancelled = false;

    void api
      .getMcpPolicy({ project })
      .then((value) => {
        if (!cancelled) {
          setSnapshot((previous) =>
            dirty.current && previous ? { ...value, revision: previous.revision } : value,
          );
          if (!dirty.current) setRules(value.rules);
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(localizeMessage(reason));
      });
    return () => {
      cancelled = true;
      active.current = false;
    };
  }, [project, revision, localizeMessage]);
  const entry = snapshot?.catalog.find((item) => item.server_id === serverId);
  const current = rules.find((rule) => rule.agent === agent && rule.server_id === serverId);
  const mode = current?.mode ?? "inherit";
  const selected = current?.tools ?? [];
  const tools = [...new Set([...(entry?.tools.map((tool) => tool.name) ?? []), ...selected])];
  function update(nextMode: McpToolPolicyRule["mode"], names: string[] = []) {
    dirty.current = true;
    setRules((old) => [
      ...old.filter((rule) => !(rule.agent === agent && rule.server_id === serverId)),
      { agent, server_id: serverId, mode: nextMode, tools: nextMode === "selected" ? names : [] },
    ]);
  }
  async function save() {
    if (!snapshot || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await api.saveMcpPolicy({ project, revision: snapshot.revision, rules });
      if (active.current) {
        dirty.current = false;
        setSnapshot(next);
        setRules(next.rules);
        await onSaved();
      }
    } catch (reason) {
      if (active.current) setError(localizeMessage(reason));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <div className="grid gap-3 rounded-lg border p-4">
      <h3 className="font-medium">
        {tr(serverId === null ? "mcp.manage.builtins" : "mcp.manage.toolPolicy")}
      </h3>
      {error && (
        <p role="alert" className="text-destructive-text">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <label>
          {tr("mcp.manage.agent")}{" "}
          <McpChoice
            aria-label={tr("mcp.manage.agent")}
            value={agent}
            disabled={busy}
            onValueChange={(value) => setAgent(value as McpAgent)}
          >
            {MCP_MANAGED_AGENTS.map((value) => (
              <SelectItem key={value} value={value}>
                {AGENT_LABELS[value]}
              </SelectItem>
            ))}
          </McpChoice>
        </label>
        <label>
          {tr("mcp.manage.rule")}{" "}
          <McpChoice
            aria-label={tr("mcp.manage.rule")}
            value={mode}
            disabled={busy || !snapshot}
            onValueChange={(value) => update(value as McpToolPolicyRule["mode"], [])}
          >
            {(["inherit", "all", "selected"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {tr(`mcp.manage.rule_${value}`)}
              </SelectItem>
            ))}
          </McpChoice>
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{tr("mcp.manage.policyHint")}</p>
      {entry && !entry.probed && serverId !== null && (
        <>
          <p>{tr("mcp.manage.unprobed")}</p>
          <McpRuntimeProbe
            key={revision}
            serverId={serverId}
            project={project}
            onProbed={onSaved}
          />
        </>
      )}
      {mode === "selected" && (
        <div className="grid gap-2">
          {tools.map((name) => (
            <label key={name} className="flex items-center gap-2">
              <Checkbox
                disabled={busy}
                checked={selected.includes(name)}
                onCheckedChange={(checked) =>
                  update(
                    "selected",
                    checked ? [...selected, name] : selected.filter((value) => value !== name),
                  )
                }
              />
              <code>{name}</code>
              {!entry?.tools.some((tool) => tool.name === name) && (
                <small>{tr("mcp.manage.undiscovered")}</small>
              )}
            </label>
          ))}
        </div>
      )}
      <Button disabled={busy || !snapshot} onClick={() => void save()}>
        {tr("common.save")}
      </Button>
    </div>
  );
}
