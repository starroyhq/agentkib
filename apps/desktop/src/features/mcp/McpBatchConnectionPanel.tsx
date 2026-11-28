import { McpChoice, McpDisclosure } from "@/features/mcp/McpControls";
import { SelectItem } from "@agentkib/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  McpAgent,
  McpBatchConnectionPlan,
  McpBatchConnectionReport,
} from "@agentkib/runtime-protocol";
import { api } from "@/core/api";
import { AGENT_LABELS } from "@/core/agents";
import { MCP_MANAGED_AGENTS } from "./mcp-targets";
import type { WorkspaceSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { Button } from "@agentkib/ui/button";
import { diffLines } from "@/features/workspace/diff";

export function McpBatchConnectionPanel({
  workspaces,
  project,
  servicesRevision,
}: {
  workspaces: WorkspaceSummary[];
  project?: string;
  servicesRevision: string;
}) {
  const { tr, localizeMessage } = useI18n();
  const [workspaceId, setWorkspace] = useState(
    workspaces.find((workspace) => workspace.path === project)?.id ?? "",
  );
  const [agents, setAgents] = useState<McpAgent[]>(["codex", "claude-code"]);
  const [rebind, setRebind] = useState<McpAgent[]>([]);
  const [plan, setPlan] = useState<McpBatchConnectionPlan>();
  const [report, setReport] = useState<McpBatchConnectionReport>();
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [verification, setVerification] = useState({
    revision: servicesRevision,
    tools: {} as Record<string, string>,
  });
  const verified = verification.revision === servicesRevision ? verification.tools : {};
  const visibleRevision = useRef(servicesRevision);
  useLayoutEffect(() => {
    visibleRevision.current = servicesRevision;
  }, [servicesRevision]);
  const alive = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function reset() {
    setPlan(undefined);
    setReport(undefined);
    setApproved(false);
    setVerification({ revision: servicesRevision, tools: {} });
    setError("");
  }
  async function prepare() {
    if (pending.current || !workspaceId) return;
    pending.current = true;
    setBusy(true);
    reset();
    try {
      const result = await api.planMcpConnections({
        workspaceId,
        targetAgents: agents,
        rebindAgents: rebind,
      });
      if (alive.current) setPlan(result);
    } catch (reason) {
      if (alive.current) setError(localizeMessage(reason));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function apply() {
    if (pending.current || !plan) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api.applyMcpConnections({ token: plan.token, approveHome: approved });
      if (alive.current) {
        setReport(result);
        setPlan(undefined);
        for (const target of result.targets) {
          if (!alive.current) break;
          if (target.status === "applied" || target.status === "unchanged")
            await verifyOne(target.agent);
        }
      }
    } catch (reason) {
      if (alive.current) {
        setError(localizeMessage(reason));
        setPlan(undefined);
      }
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function verifyOne(agent: McpAgent) {
    const expectedRevision = visibleRevision.current;
    try {
      const value = await api.verifyMcpConnection(workspaceId, agent);
      if (alive.current && expectedRevision === visibleRevision.current)
        setVerification((old) => ({
          revision: expectedRevision,
          tools: {
            ...(old.revision === expectedRevision ? old.tools : {}),
            [agent]:
              [...(value.builtin_tool_names ?? []), ...value.external_tools].join(", ") ||
              tr("mcp.manage.noTools"),
          },
        }));
    } catch (reason) {
      if (alive.current && expectedRevision === visibleRevision.current)
        setVerification((old) => ({
          revision: expectedRevision,
          tools: {
            ...(old.revision === expectedRevision ? old.tools : {}),
            [agent]: localizeMessage(reason),
          },
        }));
    }
  }
  async function verify(agent: McpAgent) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await verifyOne(agent);
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function renderVerification(agent: McpAgent) {
    return (
      <>
        <Button variant="outline" disabled={busy} onClick={() => void verify(agent)}>
          {tr("mcp.manage.verifyHub")}
        </Button>
        {verified[agent] && <p className="break-all text-xs">{verified[agent]}</p>}
      </>
    );
  }
  return (
    <section className="grid gap-4 rounded-xl border p-5">
      <h3>{tr("mcp.manage.connect")}</h3>
      <p className="text-sm text-muted-foreground">{tr("mcp.manage.connectHint")}</p>
      <label>
        {tr("mcp.manage.workspace")}{" "}
        <McpChoice
          aria-label={tr("mcp.manage.workspace")}
          value={workspaceId}
          disabled={busy}
          onValueChange={(value) => {
            setWorkspace(value);
            setRebind([]);
            reset();
          }}
        >
          <SelectItem value="">{tr("mcp.manage.chooseWorkspace")}</SelectItem>
          {workspaces.map((workspace) => (
            <SelectItem key={workspace.id} value={workspace.id}>
              {workspace.name}
            </SelectItem>
          ))}
        </McpChoice>
      </label>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          setAgents([...MCP_MANAGED_AGENTS]);
          reset();
        }}
      >
        {tr("mcp.manage.selectAllAgents")}
      </Button>
      <div className="flex flex-wrap gap-4">
        {MCP_MANAGED_AGENTS.map((agent) => (
          <label key={agent} className="flex gap-2">
            <Checkbox
              disabled={busy}
              checked={agents.includes(agent)}
              onCheckedChange={(checked) => {
                setAgents((old) =>
                  checked ? [...old, agent] : old.filter((value) => value !== agent),
                );
                setRebind([]);
                reset();
              }}
            />
            {AGENT_LABELS[agent]}
          </label>
        ))}
      </div>
      <Button disabled={busy || !workspaceId || !agents.length} onClick={() => void prepare()}>
        {tr("mcp.manage.checkPreview")}
      </Button>
      {error && (
        <p role="alert" className="text-destructive-text">
          {error}
        </p>
      )}
      {plan && (
        <div className="grid gap-4">
          {plan.targets.map((target) => (
            <div key={target.agent} className="rounded border p-3">
              <strong>{AGENT_LABELS[target.agent]}</strong> ·{" "}
              {tr(`mcp.manage.connection_${target.status}`)}
              <p className="text-sm">
                {localizeMessage(target.reason_message ?? target.reason ?? "")}
              </p>
              <code className="break-all text-xs">
                {target.target} {target.scope}
              </code>
              {target.status === "correct" && renderVerification(target.agent)}
              {target.status === "other-workspace" && (
                <label className="flex gap-2">
                  <Checkbox
                    disabled={busy}
                    checked={rebind.includes(target.agent)}
                    onCheckedChange={(checked) => {
                      setRebind((old) =>
                        checked
                          ? [...old, target.agent]
                          : old.filter((value) => value !== target.agent),
                      );
                      setPlan(undefined);
                    }}
                  />
                  {tr("mcp.manage.rebind")}
                </label>
              )}
            </div>
          ))}
          {plan.changes.map((change) => (
            <McpDisclosure key={change.target} defaultOpen title={<>{change.target}</>}>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
                {diffLines(change.before ?? "", change.after).map((line, index) => (
                  <div
                    key={index}
                  >{`${line.type === "added" ? "+" : line.type === "removed" ? "−" : " "} ${line.content}`}</div>
                ))}
              </pre>
            </McpDisclosure>
          ))}
          {plan.requires_home_approval && (
            <label className="flex gap-2">
              <Checkbox
                disabled={busy}
                checked={approved}
                onCheckedChange={(checked) => setApproved(checked)}
              />
              {tr("mcp.manage.homeApproval")}
            </label>
          )}
          <Button
            disabled={busy || !plan.changes.length || (plan.requires_home_approval && !approved)}
            onClick={() => void apply()}
          >
            {tr("mcp.manage.applyConnection")}
          </Button>
        </div>
      )}
      {report && (
        <div role="status" className="grid gap-2">
          <p>{tr("mcp.manage.reloadHint")}</p>
          {report.message && (
            <p role={report.success === false ? "alert" : "status"}>
              {report.diagnostics?.map((message) => localizeMessage(message)).join(" ") ??
                report.message}
            </p>
          )}
          {report.backup_dir && (
            <p className="break-all">
              {tr("mcp.manage.backup")}: {report.backup_dir}
            </p>
          )}
          {report.recovery?.map((item) => (
            <p key={item.target} className="break-all">
              {item.target} · {tr(`mcp.manage.recovery_${item.status}`)} {item.backup}
            </p>
          ))}
          {report.targets.map((target) => (
            <div key={target.agent}>
              <strong>{AGENT_LABELS[target.agent]}</strong> ·{" "}
              {tr(`mcp.manage.result_${target.status}`)}{" "}
              {localizeMessage(target.reason_message ?? target.reason ?? "")}
              {renderVerification(target.agent)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
