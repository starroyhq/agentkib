import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, Copy, FileOutput, PlugZap, ShieldCheck, X } from "lucide-react";
import { api } from "@/core/api";
import { localizeMessage, tr } from "@/core/i18n";
import type {
  AgentKind,
  ContinuationCapabilityStatus,
  ConversationSessionSummary,
  HandoffFormat,
  PlannedSessionHandoff,
  SessionHandoffDraft,
  SessionHandoffRequest,
  WorkspaceSummary,
} from "@/core/types";
import { sessionHandoffTargets } from "./session-handoff-targets";

export function SessionHandoffDialog({
  workspace,
  session,
  targetAgents,
  onClose,
  onPlanned,
  onMcpConnectionPlanned,
  initialRequest,
}: {
  workspace: WorkspaceSummary;
  session: ConversationSessionSummary;
  targetAgents: AgentKind[];
  onClose: () => void;
  onPlanned: (handoff: PlannedSessionHandoff) => void;
  onMcpConnectionPlanned: (
    changeSet: import("@/core/types").ChangeSet,
    request: import("./WorkspaceSessionsPage").SessionContinuationResume,
  ) => void;
  initialRequest?: import("./WorkspaceSessionsPage").SessionContinuationResume & {
    autoPrepare: boolean;
  };
}) {
  const availableTargets = useMemo(
    () =>
      sessionHandoffTargets.filter(
        ([agent]) => agent === session.agent || targetAgents.includes(agent),
      ),
    [session.agent, targetAgents],
  );
  const defaultTarget =
    availableTargets.find(([agent]) => agent !== session.agent)?.[0] ??
    availableTargets[0]?.[0] ??
    session.agent;
  const [targetAgent, setTargetAgent] = useState<AgentKind>(
    initialRequest?.targetAgent ?? defaultTarget,
  );
  const [format, setFormat] = useState<HandoffFormat>(initialRequest?.format ?? "markdown");
  const [historyBudget, setHistoryBudget] = useState(
    initialRequest?.historyBudgetTokens ?? 120_000,
  );
  const [draft, setDraft] = useState<SessionHandoffDraft>();
  const [content, setContent] = useState("");
  const [acceptLosses, setAcceptLosses] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const activeRef = useRef(true);
  const requestGenerationRef = useRef(0);
  const identityRef = useRef({ workspaceId: workspace.id, sessionId: session.id });
  const autoPreparedRef = useRef(false);

  useEffect(() => {
    identityRef.current = { workspaceId: workspace.id, sessionId: session.id };
  }, [session.id, workspace.id]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      requestGenerationRef.current += 1;
    };
  }, []);

  const captureIdentity = () => ({
    workspaceId: workspace.id,
    sessionId: session.id,
    generation: ++requestGenerationRef.current,
  });
  const isLatest = (identity: { generation: number }) =>
    activeRef.current && requestGenerationRef.current === identity.generation;
  const isCurrent = (identity: { workspaceId: string; sessionId: string; generation: number }) =>
    isLatest(identity) &&
    identityRef.current.workspaceId === identity.workspaceId &&
    identityRef.current.sessionId === identity.sessionId;

  const request = (): SessionHandoffRequest => ({
    session_id: session.id,
    target_agent: targetAgent,
    format,
    history_budget_tokens: historyBudget,
  });

  const acknowledgementLosses = useMemo(
    () => draft?.losses.filter((loss) => loss.code !== "reasoning-excluded") ?? [],
    [draft?.losses],
  );
  const reasoningExcluded = draft?.losses.find((loss) => loss.code === "reasoning-excluded");
  const mcpSetupStatus = draft?.capabilities?.mcp_setup.status;
  const nativeCapabilityReason =
    draft?.capabilities?.native_resume.reason ?? draft?.native_capability.reason;

  const showDraft = (nextDraft: SessionHandoffDraft) => {
    setDraft(nextDraft);
    setContent(nextDraft.content);
    setAcceptLosses(nextDraft.losses.every((loss) => loss.code === "reasoning-excluded"));
  };

  const prepare = async () => {
    const identity = captureIdentity();
    setBusy(true);
    setError("");
    try {
      const preparation = await api.prepareSessionHandoff(request());
      if (!isCurrent(identity)) return;
      showDraft(preparation.draft);
    } catch (reason) {
      if (isCurrent(identity)) setError(localizeMessage(reason));
    } finally {
      if (isLatest(identity)) setBusy(false);
    }
  };

  useEffect(() => {
    if (!initialRequest?.autoPrepare || autoPreparedRef.current) return;
    autoPreparedRef.current = true;
    void prepare();
  });

  const plan = async () => {
    if (!draft) return;
    const identity = captureIdentity();
    setBusy(true);
    setError("");
    try {
      const planned = await api.planSessionHandoff(
        session.id,
        workspace.id,
        draft.filename,
        draft.format,
        draft.mode === "handoff-file" && draft.window_strategy === "full" ? content : undefined,
        targetAgent,
        draft.mode,
        draft.source_fingerprint,
        acceptLosses,
        draft.history_budget_tokens,
        draft.archive_id,
      );
      if (isCurrent(identity)) onPlanned(planned);
    } catch (reason) {
      if (isCurrent(identity)) setError(localizeMessage(reason));
    } finally {
      if (isLatest(identity)) setBusy(false);
    }
  };

  const planMcpConnection = async () => {
    if (mcpSetupStatus !== "supported") return;
    const identity = captureIdentity();
    setBusy(true);
    setError("");
    try {
      const changeSet = await api.planSessionMcpConnection(workspace.id, targetAgent);
      if (!isCurrent(identity)) return;
      if (changeSet.changes.length === 0) {
        const preparation = await api.prepareSessionHandoff(request());
        if (isCurrent(identity)) showDraft(preparation.draft);
        return;
      }
      onMcpConnectionPlanned(changeSet, {
        sessionId: session.id,
        targetAgent,
        historyBudgetTokens: historyBudget,
        format,
      });
    } catch (reason) {
      if (isCurrent(identity)) setError(localizeMessage(reason));
    } finally {
      if (isLatest(identity)) setBusy(false);
    }
  };

  const copy = async () => {
    const identity = captureIdentity();
    setBusy(true);
    setError("");
    try {
      const sanitized = await api.sanitizeSessionHandoff(format, content);
      if (!isCurrent(identity)) return;
      await navigator.clipboard?.writeText(sanitized);
      if (!isCurrent(identity)) return;
      setCopied(true);
      window.setTimeout(() => {
        if (activeRef.current) setCopied(false);
      }, 1200);
    } catch (reason) {
      if (isCurrent(identity)) setError(localizeMessage(reason));
    } finally {
      if (isLatest(identity)) setBusy(false);
    }
  };

  const reset = () => {
    requestGenerationRef.current += 1;
    setDraft(undefined);
    setAcceptLosses(false);
    setError("");
  };

  const close = () => {
    activeRef.current = false;
    requestGenerationRef.current += 1;
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="w-[min(840px,calc(100vw-2rem))] max-h-[min(820px,calc(100vh-2rem))] gap-0 overflow-hidden p-0 shadow-2xl sm:max-w-[840px]"
        showCloseButton={false}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-[18px]">
          <div>
            <span className="mb-2 block text-xs font-semibold uppercase tracking-[.12em] text-muted-foreground">
              Session Continuation
            </span>
            <DialogTitle className="mt-0 text-xl">{tr("handoff.title")}</DialogTitle>
          </div>
          <Button variant="ghost" size="icon" onClick={close} aria-label={tr("common.close")}>
            <X size={17} />
          </Button>
        </header>
        {error && (
          <div className="mx-5 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <CircleAlert size={15} />
            {error}
          </div>
        )}
        {busy && !draft ? (
          <div className="grid min-h-[360px] place-content-center gap-4 px-6 py-8 text-center">
            <div className="mx-auto size-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
            <strong className="text-sm text-foreground">{tr("handoff.preparingLocal")}</strong>
            <div className="grid gap-2 text-left text-xs text-muted-foreground">
              {(["read", "sanitize", "window"] as const).map((step) => (
                <span className="flex items-center gap-2" key={step}>
                  <span className="size-1.5 rounded-full bg-muted-foreground/50" />
                  {tr(`handoff.prepareStep.${step}`)}
                </span>
              ))}
            </div>
          </div>
        ) : draft ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto px-5 py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="shrink-0 text-green-600" size={16} />
              <span>{tr("handoff.redacted", { count: draft.redaction_count })}</span>
              <code className="ml-auto max-w-[55%] truncate font-mono">{draft.filename}</code>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{tr(`handoff.mode.${draft.mode}`)}</span>
              <span>
                {tr("handoff.fullEstimate", {
                  tokens: formatEstimatedTokens(draft.window_stats.estimated_total_tokens),
                })}
              </span>
              <span>
                {tr("handoff.stats", {
                  turns: draft.stats.turn_count,
                  tools: draft.stats.tool_call_count,
                  attachments: draft.stats.attachment_count,
                })}
              </span>
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              <DecisionCard
                title={tr("handoff.section.direct")}
                value={formatEstimatedTokens(draft.window_stats.estimated_active_tokens)}
                detail={tr("handoff.section.directDetail", {
                  turns: draft.window_stats.active.turn_count,
                  tools: draft.window_stats.active.tool_call_count,
                })}
              />
              <DecisionCard
                title={tr("handoff.section.deferred")}
                value={formatEstimatedTokens(draft.window_stats.estimated_deferred_tokens)}
                detail={tr("handoff.section.deferredDetail", {
                  turns: draft.window_stats.deferred_turn_count,
                  blocks: draft.window_stats.deferred_block_count,
                })}
              />
              <DecisionCard
                title={tr("handoff.section.excluded")}
                value={tr("handoff.section.excludedValue", {
                  count: acknowledgementLosses.reduce((sum, loss) => sum + loss.count, 0),
                })}
                detail={tr("handoff.section.excludedDetail")}
              />
            </div>
            <p className="m-0 text-xs leading-relaxed text-muted-foreground">
              {tr("handoff.historyBudgetOutcome", {
                budget: formatEstimatedTokens(draft.history_budget_tokens),
                active: formatEstimatedTokens(draft.window_stats.estimated_active_tokens),
              })}
            </p>
            {draft.capabilities && (
              <div className="grid gap-2 rounded-lg border border-border/70 bg-muted/20 p-3">
                <strong className="text-xs uppercase tracking-[.08em] text-muted-foreground">
                  {tr("handoff.capabilities.title")}
                </strong>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(Object.keys(capabilityLabels) as Array<keyof typeof capabilityLabels>).map(
                    (capability) => (
                      <div
                        className="flex items-center justify-between gap-3 rounded-md bg-background px-2.5 py-2 text-xs"
                        key={capability}
                      >
                        <span>{tr(capabilityLabels[capability])}</span>
                        <CapabilityStatus status={draft.capabilities[capability].status} />
                      </div>
                    ),
                  )}
                </div>
              </div>
            )}
            {draft.window_strategy === "windowed" && (
              <div
                className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                  draft.mcp_available
                    ? "border-blue-500/25 bg-blue-500/5 text-foreground"
                    : "border-destructive/30 bg-destructive/5 text-destructive"
                }`}
              >
                <CircleAlert className="mt-0.5 shrink-0" size={14} />
                <span>
                  {draft.mcp_available
                    ? tr("handoff.window.archiveReady", {
                        turns: draft.window_stats.deferred_turn_count,
                        blocks: draft.window_stats.deferred_block_count,
                      })
                    : mcpSetupStatus === "supported"
                      ? tr("handoff.window.mcpRequired", {
                          turns: draft.window_stats.deferred_turn_count,
                          blocks: draft.window_stats.deferred_block_count,
                        })
                      : mcpSetupStatus === "unavailable"
                        ? tr("handoff.window.mcpUnavailable")
                        : tr("handoff.window.mcpUnsupported", {
                            agent: agentName(targetAgent),
                          })}
                </span>
                {!draft.mcp_available && mcpSetupStatus === "supported" && (
                  <Button
                    size="sm"
                    className="shrink-0"
                    disabled={busy}
                    onClick={() => void planMcpConnection()}
                  >
                    <PlugZap size={14} />
                    {tr("handoff.connectMcp", { agent: agentName(targetAgent) })}
                  </Button>
                )}
              </div>
            )}
            {nativeCapabilityReason && (
              <p className="m-0 text-xs text-muted-foreground">
                {tr(`handoff.capabilityReason.${nativeCapabilityReason}`)}
              </p>
            )}
            {reasoningExcluded && (
              <div className="flex items-start gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-sm text-foreground">
                <ShieldCheck className="mt-0.5 shrink-0 text-blue-600" size={14} />
                {tr("handoff.reasoningPrivacy", { count: reasoningExcluded.count })}
              </div>
            )}
            {acknowledgementLosses.map((loss) => (
              <div
                className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700"
                key={loss.code}
              >
                <CircleAlert size={14} />
                {tr(`handoff.loss.${loss.code}`, { count: loss.count })}
              </div>
            ))}
            {acknowledgementLosses.length > 0 && (
              <Label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                <Checkbox
                  checked={acceptLosses}
                  onCheckedChange={(checked) => setAcceptLosses(checked === true)}
                />
                {tr("handoff.acceptLosses")}
              </Label>
            )}
            <Collapsible>
              <CollapsibleTrigger className="w-fit cursor-pointer bg-transparent text-xs font-medium text-muted-foreground hover:text-foreground">
                {tr("handoff.technicalPreview")}
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2.5">
                <Textarea
                  className="min-h-[280px] resize-y font-mono text-xs leading-relaxed"
                  aria-label={tr("handoff.preview")}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  readOnly={draft.mode === "native-session" || draft.window_strategy === "windowed"}
                  spellCheck={false}
                />
              </CollapsibleContent>
            </Collapsible>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
            <div className="grid grid-cols-2 gap-3 max-[820px]:grid-cols-1">
              <Label className="col-span-full grid gap-1.5 text-xs text-muted-foreground">
                {tr("handoff.target")}
                <Select
                  value={targetAgent}
                  disabled={busy}
                  onValueChange={(value) => {
                    if (value !== null) setTargetAgent(String(value) as AgentKind);
                  }}
                >
                  <SelectTrigger aria-label={tr("handoff.target")}>
                    <SelectValue>
                      {availableTargets.find(([value]) => value === targetAgent)?.[1]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {availableTargets.map(([value, label]) => (
                      <SelectItem value={value} key={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Label>
              <Label className="col-span-full grid gap-1.5 text-xs text-muted-foreground">
                {tr("handoff.historyBudget")}
                <Select
                  value={String(historyBudget)}
                  disabled={busy}
                  onValueChange={(value) => {
                    if (value !== null) setHistoryBudget(Number(value));
                  }}
                >
                  <SelectTrigger aria-label={tr("handoff.historyBudget")}>
                    <SelectValue>
                      {historyBudget === 64000
                        ? "64k"
                        : historyBudget === 120000
                          ? `120k · ${tr("handoff.recommended")}`
                          : "180k"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="64000">64k</SelectItem>
                    <SelectItem value="120000">120k · {tr("handoff.recommended")}</SelectItem>
                    <SelectItem value="180000">180k</SelectItem>
                  </SelectContent>
                </Select>
                <span>{tr("handoff.historyBudgetDetail")}</span>
              </Label>
              <div className="col-span-full flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 p-3">
                <ShieldCheck className="mt-0.5 shrink-0 text-green-600" size={16} />
                <div className="grid gap-1">
                  <strong className="text-sm">{tr("handoff.localParser")}</strong>
                  <span className="text-xs text-muted-foreground">
                    {tr("handoff.localParserDetail")}
                  </span>
                </div>
              </div>
              <Collapsible className="col-span-full">
                <CollapsibleTrigger className="w-fit cursor-pointer bg-transparent text-xs text-muted-foreground">
                  {tr("handoff.advanced")}
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2.5">
                  <Label className="grid max-w-[280px] gap-1.5 text-xs text-muted-foreground">
                    {tr("handoff.format")}
                    <Select
                      value={format}
                      disabled={busy}
                      onValueChange={(value) => {
                        if (value === "markdown" || value === "json") setFormat(value);
                      }}
                    >
                      <SelectTrigger aria-label={tr("handoff.format")}>
                        <SelectValue>{format === "markdown" ? "Markdown" : "JSON"}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="markdown">Markdown</SelectItem>
                        <SelectItem value="json">JSON</SelectItem>
                      </SelectContent>
                    </Select>
                  </Label>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </div>
        )}
        <footer className="flex min-h-16 items-center justify-end gap-2 border-t border-border px-5 py-3">
          {draft ? (
            <>
              <Button variant="outline" disabled={busy} onClick={reset}>
                {tr("common.back")}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => void copy()}>
                <Copy size={14} />
                {tr(copied ? "handoff.copied" : "handoff.copy")}
              </Button>
              <Button
                disabled={
                  busy ||
                  !acceptLosses ||
                  (draft.window_strategy === "windowed" && !draft.mcp_available)
                }
                onClick={() => void plan()}
              >
                <FileOutput size={14} />
                {tr("handoff.reviewSave")}
              </Button>
            </>
          ) : (
            <Button disabled={busy} onClick={() => void prepare()}>
              <FileOutput size={14} />
              {tr(busy ? "common.loading" : "handoff.prepare")}
            </Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function DecisionCard({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <div className="grid content-start gap-1 rounded-lg border border-border bg-muted/25 p-3 text-xs">
      <span className="text-muted-foreground">{title}</span>
      <strong className="text-sm text-foreground">{value}</strong>
      <span className="leading-relaxed text-muted-foreground">{detail}</span>
    </div>
  );
}

function formatEstimatedTokens(value: number) {
  if (value === 0) return "0 Token";
  if (value < 1000) return "<1k Token";
  return `≈${Math.round(value / 1000)}k Token`;
}

function agentName(agent: AgentKind) {
  return sessionHandoffTargets.find(([value]) => value === agent)?.[1] ?? agent;
}

const capabilityLabels = {
  source_read: "handoff.capabilities.sourceRead",
  source_parse: "handoff.capabilities.sourceParse",
  native_resume: "handoff.capabilities.nativeResume",
  file_handoff: "handoff.capabilities.fileHandoff",
  windowed_context: "handoff.capabilities.windowedContext",
  mcp_setup: "handoff.capabilities.mcpSetup",
  interactive_launch: "handoff.capabilities.interactiveLaunch",
} as const;

function CapabilityStatus({ status }: { status: ContinuationCapabilityStatus }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
        status === "supported"
          ? "bg-emerald-500/10 text-emerald-700"
          : status === "unavailable"
            ? "bg-amber-500/10 text-amber-700"
            : status === "unsupported"
              ? "bg-muted text-muted-foreground"
              : "bg-blue-500/10 text-blue-700"
      }`}
    >
      {tr(`handoff.capabilities.status.${status}`)}
    </span>
  );
}
