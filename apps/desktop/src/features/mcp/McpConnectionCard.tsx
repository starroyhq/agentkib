import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Copy, FileCode2, PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/core/api";
import { AGENT_KINDS, AGENT_LABELS } from "@/core/agents";
import type {
  AgentKind,
  ChangeSet,
  McpConnectionInfo,
  McpConnectionVerification,
  RuntimeInfo,
  WorkspaceSummary,
} from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { diffLines } from "@/features/workspace/diff";
import { cn } from "cn";
import { withAsyncCleanup } from "@/lib/utils";

const CONNECTION_AGENTS = AGENT_KINDS.filter((agent) => agent !== "deepseek-harness");
type Operation = "plan" | "apply" | "verify";

export function McpConnectionCard({
  workspaces,
  runtime,
  servicesRevision,
  onManageWorkspaces,
}: {
  workspaces: WorkspaceSummary[];
  runtime?: Pick<RuntimeInfo, "mcp_network" | "mcp_hub">;
  servicesRevision: string;
  onManageWorkspaces: () => void;
}) {
  const { tr, localizeMessage, formatDateTime } = useI18n();
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [targetAgent, setTargetAgent] = useState<AgentKind>("codex");
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const selectedId = selectedWorkspace?.id ?? workspaces[0]?.id ?? "";
  const workspace = workspaces.find((item) => item.id === selectedId);
  const [applyingContext, setApplyingContext] = useState<{ key: string; request: number }>();
  const liveContextKey = JSON.stringify([
    selectedId,
    targetAgent,
    runtime?.mcp_network?.port,
    workspace?.path,
    workspace?.manifest_workspace_id,
    runtime?.mcp_hub?.port,
    runtime?.mcp_hub?.running,
    runtime?.mcp_hub?.accessible_addresses,
    servicesRevision,
  ]);
  // Finish the reviewed write before a background refresh invalidates its diff.
  const contextKey = applyingContext?.key ?? liveContextKey;
  const generation = useRef(0);
  const pendingOperation = useRef<Operation | null>(null);
  const writeFailure = useRef<
    | {
        workspaceId: string;
        targetAgent: AgentKind;
        reason: unknown;
      }
    | undefined
  >(undefined);
  const [loadedKey, setLoadedKey] = useState("");
  const [info, setInfo] = useState<McpConnectionInfo>();
  const [infoError, setInfoError] = useState<unknown>();
  const [retry, setRetry] = useState(0);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [error, setError] = useState<unknown>();
  const [plan, setPlan] = useState<ChangeSet>();
  const [homeApproved, setHomeApproved] = useState(false);
  const [applied, setApplied] = useState(false);
  const [verification, setVerification] = useState<McpConnectionVerification>();
  const [copied, setCopied] = useState<"url" | "config">();

  useEffect(() => {
    const request = ++generation.current;
    pendingOperation.current = null;
    setLoadedKey("");
    setInfo(undefined);
    setInfoError(undefined);
    const failedWrite = writeFailure.current;
    writeFailure.current = undefined;
    setError(
      failedWrite?.workspaceId === selectedId && failedWrite.targetAgent === targetAgent
        ? failedWrite.reason
        : undefined,
    );
    setOperation(null);
    setPlan(undefined);
    setHomeApproved(false);
    setApplied(false);
    setVerification(undefined);
    setCopied(undefined);
    if (selectedId) {
      void api
        .mcpConnectionInfo(selectedId, targetAgent)
        .then((result) => {
          if (request !== generation.current) return;
          setInfo(result);
          setLoadedKey(contextKey);
        })
        .catch((reason) => {
          if (request !== generation.current) return;
          setInfoError(reason);
          setLoadedKey(contextKey);
        });
    }
    return () => {
      generation.current += 1;
    };
  }, [contextKey, retry, selectedId, targetAgent]);

  const currentInfo = loadedKey === contextKey ? info : undefined;
  const isLoading = Boolean(selectedId) && loadedKey !== contextKey;
  const isApplying = operation === "apply";
  const isBusy = Boolean(operation);
  const agentName = AGENT_LABELS[targetAgent];
  const run = async (
    nextOperation: Operation,
    action: (isCurrent: () => boolean) => Promise<void>,
  ) => {
    if (!currentInfo || pendingOperation.current) return;
    const request = generation.current;
    const isCurrent = () => request === generation.current;
    pendingOperation.current = nextOperation;
    setOperation(nextOperation);
    writeFailure.current = undefined;
    setError(undefined);
    setCopied(undefined);
    await withAsyncCleanup(
      async () => {
        try {
          await action(isCurrent);
        } catch (reason) {
          if (isCurrent()) {
            if (nextOperation === "apply")
              writeFailure.current = { workspaceId: selectedId, targetAgent, reason };
            setError(reason);
          }
        }
      },
      () => {
        if (isCurrent()) {
          pendingOperation.current = null;
          setOperation(null);
        }
        // A workspace refresh can invalidate this request while it still owns
        // the frozen context. Release only its freeze, never a newer write's.
        if (nextOperation === "apply")
          setApplyingContext((current) => (current?.request === request ? undefined : current));
      },
    );
  };
  const preview = () =>
    run("plan", async (isCurrent) => {
      setPlan(undefined);
      setHomeApproved(false);
      setApplied(false);
      setVerification(undefined);
      const result = await api.planMcpConnection(selectedId, targetAgent);
      if (isCurrent()) setPlan(result);
    });
  const apply = () =>
    run("apply", async (isCurrent) => {
      if (!plan?.changes.length || (plan.requires_home_approval && !homeApproved)) return;
      setApplyingContext({ key: contextKey, request: generation.current });
      setVerification(undefined);
      await api.apply(plan, homeApproved);
      if (isCurrent()) {
        setApplied(true);
        setPlan(undefined);
        setHomeApproved(false);
      }
    });
  const verify = () =>
    run("verify", async (isCurrent) => {
      setVerification(undefined);
      const result = await api.verifyMcpConnection(selectedId, targetAgent);
      if (!isCurrent()) return;
      if (result.url !== currentInfo?.url) {
        setError({ key: "mcp.connection.urlChanged" });
        return;
      }
      setVerification(result);
    });
  const copy = async (field: "url" | "config") => {
    if (!currentInfo) return;
    const request = generation.current;
    try {
      await navigator.clipboard.writeText(currentInfo[field]);
      if (request === generation.current) setCopied(field);
    } catch (reason) {
      if (request === generation.current) setError(reason);
    }
  };

  return (
    <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <CardHeader className="gap-2 border-b border-border p-5">
        <CardTitle className="flex items-center gap-2 text-lg">
          <PlugZap size={19} />
          {tr("mcp.connection.title")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{tr("mcp.connection.description")}</p>
      </CardHeader>
      <CardContent className="grid gap-4 p-5">
        {!workspaces.length ? (
          <div className="grid justify-items-start gap-3 rounded-xl border border-dashed border-border p-4">
            <p className="text-sm text-muted-foreground">{tr("mcp.connection.noWorkspace")}</p>
            <Button variant="outline" onClick={onManageWorkspaces}>
              {tr("mcp.connection.addWorkspace")}
            </Button>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Label className="!grid gap-2">
                <span>{tr("mcp.connection.workspace")}</span>
                <Select
                  value={selectedId}
                  disabled={isApplying}
                  onValueChange={(value) => {
                    if (value !== null) setWorkspaceId(String(value));
                  }}
                >
                  <SelectTrigger className="w-full" aria-label={tr("mcp.connection.workspace")}>
                    <SelectValue>
                      {workspaces.find((workspace) => workspace.id === selectedId)?.name}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>{tr("mcp.connection.workspace")}</SelectLabel>
                      {workspaces.map((workspace) => (
                        <SelectItem key={workspace.id} value={workspace.id}>
                          {workspace.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Label>
              <Label className="!grid gap-2">
                <span>{tr("mcp.connection.agent")}</span>
                <Select
                  value={targetAgent}
                  disabled={isApplying}
                  onValueChange={(value) => {
                    if (value !== null) setTargetAgent(value as AgentKind);
                  }}
                >
                  <SelectTrigger className="w-full" aria-label={tr("mcp.connection.agent")}>
                    <SelectValue>
                      <AgentIcon agent={targetAgent} compact />
                      {agentName}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>{tr("mcp.connection.agent")}</SelectLabel>
                      {CONNECTION_AGENTS.map((agent) => (
                        <SelectItem key={agent} value={agent}>
                          <AgentIcon agent={agent} compact />
                          {AGENT_LABELS[agent]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Label>
            </div>
            {isLoading && (
              <p role="status" className="text-sm text-muted-foreground">
                {tr("mcp.connection.loading")}
              </p>
            )}
            {loadedKey === contextKey && infoError !== undefined && (
              <div role="alert" className="grid justify-items-start gap-2 text-sm text-destructive">
                <p>{localizeMessage(infoError)}</p>
                <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
                  {tr("mcp.connection.retry")}
                </Button>
              </div>
            )}
            {currentInfo && (
              <>
                <div className="grid gap-2 rounded-xl border border-border bg-muted/20 p-4 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{tr("mcp.connection.url")}</strong>
                    <Button variant="outline" size="sm" onClick={() => void copy("url")}>
                      <Copy size={13} />
                      {tr("mcp.connection.copyUrl")}
                    </Button>
                  </div>
                  <code className="select-text break-all" data-testid="mcp-connection-url">
                    {currentInfo.url}
                  </code>
                  <span
                    className={currentInfo.hub_running ? "text-emerald-600" : "text-destructive"}
                  >
                    {tr(currentInfo.hub_running ? "mcp.running" : "mcp.connection.hubStopped")}
                  </span>
                  <p className="text-muted-foreground">{tr("mcp.connection.localOnly")}</p>
                </div>
                <div className="grid min-w-0 gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-sm">
                      {tr("mcp.connection.config")} · {currentInfo.format.toUpperCase()}
                    </strong>
                    <Button variant="outline" size="sm" onClick={() => void copy("config")}>
                      <Copy size={13} />
                      {tr("mcp.connection.copyConfig")}
                    </Button>
                  </div>
                  <pre
                    className="max-h-72 overflow-auto rounded-xl border border-border bg-muted/30 p-4 text-xs"
                    data-testid="mcp-connection-config"
                  >
                    {currentInfo.config}
                  </pre>
                  <p className="text-sm text-muted-foreground">
                    {tr("mcp.connection.mergeConfig")}
                  </p>
                  <p className="text-sm">
                    <span className="text-muted-foreground">
                      {tr("mcp.connection.target")} · {tr(`status.scope.${currentInfo.scope}`)}
                    </span>
                    <br />
                    <code className="select-text break-all">{currentInfo.target}</code>
                  </p>
                  {currentInfo.scope === "agent-home" && (
                    <p className="text-sm text-amber-700 dark:text-amber-300">
                      {tr("mcp.connection.homeScope", { workspace: workspace?.name })}
                    </p>
                  )}
                </div>
                {copied && (
                  <p role="status" className="text-sm text-emerald-600">
                    {tr(
                      copied === "url" ? "mcp.connection.urlCopied" : "mcp.connection.configCopied",
                    )}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button disabled={isBusy} onClick={() => void preview()}>
                    <FileCode2 size={15} />
                    {tr(
                      operation === "plan" ? "mcp.connection.planning" : "mcp.connection.preview",
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={isBusy || !currentInfo.hub_running}
                    onClick={() => void verify()}
                  >
                    {tr(
                      operation === "verify" ? "mcp.connection.verifying" : "mcp.connection.verify",
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={isBusy}
                    onClick={() => setRetry((value) => value + 1)}
                  >
                    {tr("mcp.connection.retry")}
                  </Button>
                </div>
                <Dialog
                  open={Boolean(plan)}
                  onOpenChange={(open, details) => {
                    if (!open && isApplying) {
                      details.cancel();
                      return;
                    }
                    if (!open) {
                      setPlan(undefined);
                      setHomeApproved(false);
                    }
                  }}
                >
                  <DialogContent
                    className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"
                    showCloseButton={!isApplying}
                  >
                    <DialogHeader>
                      <DialogTitle>{tr("mcp.connection.review")}</DialogTitle>
                      <DialogDescription>
                        {workspace?.name} · {agentName}
                      </DialogDescription>
                    </DialogHeader>
                    {plan && (
                      <>
                        {!plan.changes.length && (
                          <p role="status" className="text-sm text-muted-foreground">
                            {tr("mcp.connection.noChanges")}
                          </p>
                        )}
                        {plan.changes.map((change) => (
                          <div key={change.target} className="grid min-w-0 gap-2">
                            <p className="text-xs">
                              <code className="break-all">{change.target}</code> ·{" "}
                              {tr(`status.scope.${change.scope}`)}
                            </p>
                            <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-muted/20 text-xs">
                              {diffLines(change.before, change.after).map((line, index) => (
                                <div
                                  key={index}
                                  className={cn(
                                    "flex px-3 py-0.5",
                                    line.type === "added" &&
                                      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                                    line.type === "removed" && "bg-destructive/10 text-destructive",
                                  )}
                                >
                                  <span className="w-5 shrink-0">
                                    {line.type === "added"
                                      ? "+"
                                      : line.type === "removed"
                                        ? "−"
                                        : " "}
                                  </span>
                                  {line.content || " "}
                                </div>
                              ))}
                            </pre>
                          </div>
                        ))}
                        {currentInfo.scope === "agent-home" && (
                          <p className="text-sm text-amber-700 dark:text-amber-300">
                            {tr("mcp.connection.homeScope", { workspace: workspace?.name })}
                          </p>
                        )}
                        {plan.requires_home_approval && (
                          <Label className="flex items-center gap-2 text-sm">
                            <Checkbox
                              checked={homeApproved}
                              disabled={isBusy}
                              onCheckedChange={setHomeApproved}
                            />
                            {tr("changes.homeApproval")}
                          </Label>
                        )}
                        {error !== undefined && (
                          <p role="alert" className="text-sm text-destructive">
                            {localizeMessage(error)}
                          </p>
                        )}
                        <DialogFooter>
                          <Button
                            variant="outline"
                            disabled={isBusy}
                            onClick={() => {
                              setPlan(undefined);
                              setHomeApproved(false);
                            }}
                          >
                            {tr("common.cancel")}
                          </Button>
                          {plan.changes.length > 0 && (
                            <Button
                              disabled={isBusy || (plan.requires_home_approval && !homeApproved)}
                              onClick={() => void apply()}
                            >
                              {tr(
                                operation === "apply"
                                  ? "mcp.connection.applying"
                                  : "mcp.connection.apply",
                              )}
                            </Button>
                          )}
                        </DialogFooter>
                      </>
                    )}
                  </DialogContent>
                </Dialog>
                {applied && (
                  <p role="status" className="flex items-center gap-2 text-sm text-emerald-600">
                    <Check size={15} />
                    {tr("mcp.connection.applied")}
                  </p>
                )}
                {verification && (
                  <div
                    role="status"
                    className="grid gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm"
                  >
                    <strong className="flex items-center gap-2">
                      <Check size={15} />
                      {tr("mcp.connection.verified")}
                    </strong>
                    <code className="break-all">{verification.url}</code>
                    <p>
                      {tr("mcp.connection.toolCounts", {
                        builtin: verification.builtin_tools,
                        external: verification.external_tools.length,
                      })}
                    </p>
                    {!verification.external_tools.length && (
                      <p className="text-muted-foreground">
                        {tr("mcp.connection.noExternalTools")}
                      </p>
                    )}
                    {verification.external_tools.length > 0 && (
                      <ul className="grid gap-1 text-xs">
                        {verification.external_tools.map((tool) => (
                          <li key={tool}>
                            <code className="break-all">{tool}</code>
                          </li>
                        ))}
                      </ul>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(verification.checked_at)}
                    </span>
                    <p className="text-muted-foreground">
                      {tr("mcp.connection.verificationScope")}
                    </p>
                  </div>
                )}
                {error !== undefined && (
                  <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
                    <CircleAlert size={15} className="mt-0.5 shrink-0" />
                    {localizeMessage(error)}
                  </p>
                )}
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {tr("mcp.connection.reloadGuide", { agent: agentName })}
                </p>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
