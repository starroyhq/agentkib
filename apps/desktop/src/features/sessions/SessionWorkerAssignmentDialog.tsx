import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import {
  DelayedSpinner,
  LoadingSkeleton,
  extractProjectAgentFailure,
  projectAgentCopy,
  projectAgentReasonPhrase,
  projectAgentReasonRetry,
  projectAgentRecoveryKind,
  type ProjectAgentFailure,
  type ProjectAgentRecoveryKind,
} from "@agentkib/session-ui";
import {
  sessionProviderDeclaration,
  type ProjectAgentLeadEligibility,
  type ProjectAgentWorkerEligibility,
} from "@agentkib/web-client";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createDesktopConversationClient } from "@/core/conversation-bridge";
import { desktopApi } from "@/core/desktop";
import type { ConversationSessionSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { refreshConversationCatalog } from "./conversation-catalog";
import { worktreeLabel } from "./session-labels";
import { workerAssignmentCopy } from "./worker-assignment-copy";

type Candidate = {
  sessionId: string;
  reason: string | null;
  assigned?: boolean;
  eligibility?: ProjectAgentWorkerEligibility;
};

type AssignmentOptions = {
  capable: boolean;
  remaining: number;
  reason?: string | null;
  eligibility?: ProjectAgentLeadEligibility;
  candidates: Candidate[];
};

const READ_BACKOFF_DELAYS_MS = [400, 800] as const;
const MAX_CACHED_LEADS = 8;
const REFRESH_RETRY_DELAY_MS = 5_000;
const MAX_REFRESH_RETRIES = 2;
const assignmentCache = new WeakMap<
  ReturnType<typeof desktopApi>,
  Map<string, AssignmentOptions>
>();

async function assignmentOptions(
  bridge: ReturnType<typeof desktopApi>,
  sessionId: string,
  candidateIds: string[],
): Promise<AssignmentOptions> {
  const value = (await bridge.claude.request({
    operation: "lead-assignment-options",
    sessionId,
    candidateIds,
  })) as Partial<AssignmentOptions> | null;
  if (
    !value ||
    typeof value.capable !== "boolean" ||
    typeof value.remaining !== "number" ||
    !Number.isSafeInteger(value.remaining) ||
    value.remaining < 0 ||
    !Array.isArray(value.candidates)
  )
    throw new Error("invalid-lead-assignment-options");
  const { capable, remaining, reason, eligibility, candidates } = value as AssignmentOptions;
  return {
    capable,
    remaining,
    reason,
    eligibility,
    candidates: candidates.map(({ sessionId, reason, assigned, eligibility }) => ({
      sessionId,
      reason,
      assigned,
      eligibility,
    })),
  };
}

function candidateReasonOf(candidate: Candidate | undefined): string | null {
  if (!candidate || candidate.assigned) return null;
  if (candidate.eligibility) {
    return candidate.eligibility.availability.available
      ? null
      : candidate.eligibility.availability.reason;
  }
  return candidate.reason ?? null;
}

function hasAssignmentRole(candidate: Candidate | undefined) {
  const reason = candidate?.assigned
    ? "session-is-a-worker"
    : candidate?.eligibility && !candidate.eligibility.availability.available
      ? candidate.eligibility.availability.reason
      : candidate?.reason;
  return reason === "session-is-a-worker" || reason === "session-is-a-project-agent";
}

function matchesSessionId(row: ConversationSessionSummary, id: string): boolean {
  return row.id === id || row.indexedSessionIds?.includes(id) === true;
}

function canonicalSessionId(
  catalog: readonly ConversationSessionSummary[],
  sessionId: string,
): string {
  return catalog.find((row) => matchesSessionId(row, sessionId))?.id ?? sessionId;
}

function findOwnerLeadId(
  catalog: readonly ConversationSessionSummary[],
  callerSession: ConversationSessionSummary,
  reason: string | undefined,
  attemptedWorkers: readonly string[],
): string | undefined {
  const callerIds = new Set([callerSession.id, ...(callerSession.indexedSessionIds ?? [])]);
  const lookup = (id: string) => catalog.find((row) => matchesSessionId(row, id));

  if (reason === "session-is-a-worker") {
    for (const workerId of attemptedWorkers) {
      const workerRow = lookup(workerId);
      if (workerRow?.orchestration?.role === "worker" && workerRow.orchestration.leadId) {
        return canonicalSessionId(catalog, workerRow.orchestration.leadId);
      }
    }
    const callerRow = lookup(callerSession.id) ?? callerSession;
    if (callerRow.orchestration?.role === "worker" && callerRow.orchestration.leadId) {
      return canonicalSessionId(catalog, callerRow.orchestration.leadId);
    }
    return undefined;
  }

  if (reason === "session-is-a-project-agent") {
    for (const workerId of attemptedWorkers) {
      const workerRow = lookup(workerId);
      if (workerRow?.orchestration?.role === "lead") {
        return workerRow.id;
      }
    }
    if (attemptedWorkers.length === 1 && !callerIds.has(attemptedWorkers[0]!)) {
      return canonicalSessionId(catalog, attemptedWorkers[0]!);
    }
    return undefined;
  }

  return undefined;
}

async function readFreshCatalogSessions(): Promise<ConversationSessionSummary[]> {
  try {
    const refreshed = await refreshConversationCatalog();
    if (refreshed.length > 0) return refreshed;
  } catch {
    // Continue to direct client read if the shared catalog refresh is unavailable.
  }
  try {
    const catalog = await createDesktopConversationClient().catalog();
    return (catalog?.sessions ?? []) as ConversationSessionSummary[];
  } catch {
    return [];
  }
}

type WorkerAssignmentDialogProps = {
  session: ConversationSessionSummary;
  sessions: ConversationSessionSummary[];
  onClose: () => void;
  onChanged?: () => void;
  onConnectTerminal?: () => void;
  onOpenIntegrations?: () => void;
  onOpenWorkspaces?: () => void;
  onOpenLeadPanel?: (targetSessionId: string) => void;
};

export function SessionWorkerAssignmentDialog(props: WorkerAssignmentDialogProps) {
  const { id, agent, workspace_id } = props.session;
  const scope = JSON.stringify([id, agent, workspace_id]);
  return <WorkerAssignmentDialog key={scope} scope={scope} {...props} />;
}

function WorkerAssignmentDialog({
  session,
  sessions,
  scope,
  onClose,
  onChanged,
  onConnectTerminal,
  onOpenIntegrations,
  onOpenWorkspaces,
  onOpenLeadPanel,
}: WorkerAssignmentDialogProps & { scope: string }) {
  const { locale, tr } = useI18n();
  const copy = workerAssignmentCopy[locale];
  const management = projectAgentCopy(locale);
  const dialogs = useAppDialogs();
  const [bridge] = useState(desktopApi);
  const [previous, setPrevious] = useState(() => assignmentCache.get(bridge)?.get(scope));
  const [response, setResponse] = useState<{
    key: string;
    value: AssignmentOptions | null;
    failure?: ProjectAgentFailure;
  }>();
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionFailure, setActionFailure] = useState<{
    failure: ProjectAgentFailure;
    attemptedWorkers: string[];
    ownerLeadId?: string;
  } | null>(null);
  const [resolvedLeadOwnerId, setResolvedLeadOwnerId] = useState<string>();
  const cancel = useRef<HTMLButtonElement>(null);
  const retries = useRef(0);
  const pending = useRef<
    | {
        key: string;
        promise: Promise<{ value: AssignmentOptions | null; failure?: ProjectAgentFailure }>;
      }
    | undefined
  >(undefined);
  const candidateRows = useMemo(() => {
    const leadIds = new Set([session.id, ...(session.indexedSessionIds ?? [])]);
    const usedIds = new Set([...leadIds, ...sessions.map((row) => row.id)]);
    const rows: { row: ConversationSessionSummary; aliases: string[] }[] = [];
    for (const row of sessions) {
      if (row.remote || row.sidechain || leadIds.has(row.id)) continue;
      const assigned =
        row.orchestration?.role === "worker" && leadIds.has(row.orchestration.leadId);
      if (
        !assigned &&
        (row.archived ||
          row.availability !== "readable" ||
          sessionProviderDeclaration(row.agent)?.projectAgent?.worker !== true)
      )
        continue;
      const aliases = (row.indexedSessionIds ?? []).filter((id) => {
        if (usedIds.has(id)) return false;
        usedIds.add(id);
        return true;
      });
      rows.push({ row, aliases });
    }
    return rows;
  }, [session.id, session.indexedSessionIds, sessions]);
  // The same set of IDs can be republished with updated titles or in a different order.
  const candidateKey = JSON.stringify(
    candidateRows.flatMap(({ row, aliases }) => [row.id, ...aliases]).sort(),
  );
  const requestKey = JSON.stringify([session.id, candidateKey, revision]);
  const currentResponse = response?.key === requestKey ? response : undefined;
  const result = currentResponse?.value;
  const options = result ?? previous;
  const readFailure = result === null ? currentResponse?.failure : undefined;
  const readFailed = result === null;
  const initialLoading = result === undefined && !options;

  useEffect(() => {
    if (busy) return;
    let active = true;
    const candidateIds = JSON.parse(candidateKey) as string[];
    const loadWithBackoff = async (
      isCurrent: () => boolean,
    ): Promise<{
      value: AssignmentOptions | null;
      failure?: ProjectAgentFailure;
    }> => {
      let attempt = 0;
      while (true) {
        try {
          return { value: await assignmentOptions(bridge, session.id, candidateIds) };
        } catch (error) {
          const parsed = extractProjectAgentFailure(error, locale);
          if (
            parsed.retry !== "after-backoff" ||
            attempt >= READ_BACKOFF_DELAYS_MS.length ||
            !isCurrent()
          ) {
            return { value: null, failure: parsed };
          }
          await new Promise<void>((resolve) =>
            window.setTimeout(resolve, READ_BACKOFF_DELAYS_MS[attempt]),
          );
          if (!isCurrent()) return { value: null, failure: parsed };
          attempt += 1;
        }
      }
    };
    const request: {
      key: string;
      promise: Promise<{ value: AssignmentOptions | null; failure?: ProjectAgentFailure }>;
    } =
      pending.current?.key === requestKey
        ? pending.current
        : (() => {
            const entry = {
              key: requestKey,
              promise: undefined as unknown as Promise<{
                value: AssignmentOptions | null;
                failure?: ProjectAgentFailure;
              }>,
            };
            entry.promise = loadWithBackoff(() => pending.current === entry);
            return entry;
          })();
    pending.current = request;
    void request.promise.then((outcome) => {
      if (!active || pending.current !== request) return;
      pending.current = undefined;
      setResponse({ key: requestKey, ...outcome });
      if (!outcome.value) return;
      const cached = assignmentCache.get(bridge) ?? new Map<string, AssignmentOptions>();
      cached.delete(scope);
      cached.set(scope, outcome.value);
      if (cached.size > MAX_CACHED_LEADS) cached.delete(cached.keys().next().value!);
      assignmentCache.set(bridge, cached);
      setPrevious(outcome.value);
      retries.current = 0;
    });
    return () => {
      active = false;
    };
  }, [bridge, busy, candidateKey, locale, requestKey, scope, session.id]);

  useEffect(() => {
    if (!readFailed || !previous || busy || retries.current >= MAX_REFRESH_RETRIES) return;
    const retry = setTimeout(() => {
      retries.current++;
      setRevision((version) => version + 1);
    }, REFRESH_RETRY_DELAY_MS);
    return () => clearTimeout(retry);
  }, [busy, previous, readFailed]);

  function reload() {
    retries.current = 0;
    setSelected([]);
    setRevision((version) => version + 1);
  }

  async function change(params: Record<string, unknown>) {
    const attemptedWorkers = Array.isArray(params.workers)
      ? params.workers.filter((id): id is string => typeof id === "string")
      : [];
    setActionFailure(null);
    setBusy(true);
    // Qualification shown while revalidating is advisory. Mutations still go through runtime checks.
    pending.current = undefined;
    assignmentCache.get(bridge)?.delete(scope);
    setPrevious(undefined);
    try {
      await bridge.claude.request({ ...params, sessionId: session.id });
      onChanged?.();
      if (params.operation === "lead-assign-workers") onClose();
      else reload();
    } catch (error) {
      const parsed = extractProjectAgentFailure(error, locale);
      let ownerLeadId: string | undefined;
      if (parsed.recovery === "lead-panel") {
        onChanged?.();
        const freshSessions = await readFreshCatalogSessions();
        ownerLeadId =
          findOwnerLeadId(freshSessions, session, parsed.code, attemptedWorkers) ??
          findOwnerLeadId(sessions, session, parsed.code, attemptedWorkers);
      }
      setActionFailure({ failure: parsed, attemptedWorkers, ownerLeadId });
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function remove(candidate: Candidate, title: string) {
    const confirmed = await dialogs.confirm({
      title: management.removeWorker,
      description: management.removeConfirm(title),
      confirmLabel: management.removeWorker,
      cancelLabel: management.cancel,
    });
    if (confirmed) await change({ operation: "lead-worker-remove", worker: candidate.sessionId });
  }

  async function openDevinLogin() {
    try {
      await createDesktopConversationClient().devinTerminal({
        action: "login",
        sessionId: session.id,
      });
    } catch {
      // Leave recovery action available without replacing the primary failure phrase.
    }
  }

  const leadEligibility = options?.eligibility;
  const leadAvailable = leadEligibility ? leadEligibility.availability.available : options?.capable;
  const leadUnavailableReason =
    leadEligibility && !leadEligibility.availability.available
      ? leadEligibility.availability.reason
      : options && !options.capable
        ? (options.reason ?? "lead-not-controllable")
        : undefined;
  const paused = options?.reason === "delegation-paused";
  const active = leadAvailable === true && !paused && (options?.remaining ?? 0) > 0;
  const leadBlockingReason = leadUnavailableReason ?? (paused ? "delegation-paused" : undefined);
  const leadRecovery: ProjectAgentRecoveryKind = leadBlockingReason
    ? projectAgentRecoveryKind(leadBlockingReason, projectAgentReasonRetry(leadBlockingReason))
    : "none";
  const directLeadOwnerId =
    leadRecovery === "lead-panel"
      ? findOwnerLeadId(sessions, session, leadBlockingReason, [])
      : undefined;
  const leadOwnerLeadId = directLeadOwnerId ?? resolvedLeadOwnerId;
  const actionOwnerLeadId = actionFailure
    ? (actionFailure.ownerLeadId ??
      findOwnerLeadId(
        sessions,
        session,
        actionFailure.failure.code,
        actionFailure.attemptedWorkers,
      ))
    : undefined;

  useEffect(() => {
    if (leadRecovery !== "lead-panel" || directLeadOwnerId) return;
    let active = true;
    void readFreshCatalogSessions().then((freshSessions) => {
      if (!active) return;
      const owner = findOwnerLeadId(freshSessions, session, leadBlockingReason, []);
      if (owner) setResolvedLeadOwnerId(owner);
    });
    return () => {
      active = false;
    };
  }, [leadRecovery, directLeadOwnerId, leadBlockingReason, session]);

  const statuses = new Map(
    options?.candidates.map((candidate) => [candidate.sessionId, candidate]),
  );
  const candidates = candidateRows.map(({ row, aliases }) => {
    const canonical = statuses.get(row.id);
    // An older assignment can reference an indexed ID. Keep it for removing that assignment.
    const linked = aliases.map((id) => statuses.get(id)).find(hasAssignmentRole);
    const candidate = hasAssignmentRole(canonical) ? canonical : (linked ?? canonical);
    return { row, candidate };
  });
  const eligible = new Set(
    candidates
      .filter(({ candidate }) => candidate && !candidate.assigned && !candidateReasonOf(candidate))
      .map(({ row }) => row.id),
  );
  const workers =
    active && !paused
      ? selected.filter((id) => eligible.has(id)).slice(0, options?.remaining ?? 0)
      : [];
  const remaining = options ? Math.max(0, options.remaining - workers.length) : 0;
  const displayedCandidates = result ? candidates.filter(({ candidate }) => candidate) : candidates;

  const renderRecovery = (
    recovery: ProjectAgentRecoveryKind,
    allowManualRetry = false,
    targetLeadId?: string,
  ) => {
    if (recovery === "connect-terminal" && onConnectTerminal) {
      return (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            onClose();
            onConnectTerminal();
          }}
        >
          {management.connectTerminal}
        </Button>
      );
    }
    if (recovery === "integrations" && onOpenIntegrations) {
      return (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            onClose();
            onOpenIntegrations();
          }}
        >
          {management.openIntegrations}
        </Button>
      );
    }
    if (recovery === "workspaces" && onOpenWorkspaces) {
      return (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            onClose();
            onOpenWorkspaces();
          }}
        >
          {management.openWorkspaces}
        </Button>
      );
    }
    if (recovery === "lead-panel" && onOpenLeadPanel && targetLeadId) {
      return (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            onClose();
            onOpenLeadPanel(targetLeadId);
          }}
        >
          {management.openLeadPanel}
        </Button>
      );
    }
    if (recovery === "resume-delegation") {
      return (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void change({ operation: "lead-resume" })}
        >
          {management.resume}
        </Button>
      );
    }
    if (recovery === "devin-login") {
      return (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void openDevinLogin()}>
          {management.devinLogin}
        </Button>
      );
    }
    if (recovery === "refresh") {
      return (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            setActionFailure(null);
            reload();
          }}
        >
          {management.refresh}
        </Button>
      );
    }
    if (recovery === "retry" && allowManualRetry) {
      return (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            setActionFailure(null);
            reload();
          }}
        >
          {management.retry}
        </Button>
      );
    }
    return null;
  };

  const toolsBadge = leadEligibility
    ? leadEligibility.toolsReady === true
      ? {
          attr: "ready",
          label: management.toolsReady,
          tone: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        }
      : leadEligibility.toolsReady === false
        ? {
            attr: "not-ready",
            label: management.toolsNotReady,
            tone: "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300",
          }
        : {
            attr: "unknown",
            label: management.toolsUnknown,
            tone: "border-border/70 bg-muted/60 text-muted-foreground",
          }
    : null;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg" initialFocus={cancel}>
        <DialogHeader className="pr-6">
          <DialogTitle className="flex items-center gap-2">
            {copy.title(displaySessionTitle(session.title, tr))}
            <DelayedSpinner
              active={initialLoading}
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          </DialogTitle>
          {(initialLoading || active) && session.orchestration?.role !== "lead" && (
            <DialogDescription>{copy.firstAssignment}</DialogDescription>
          )}
          {(leadBlockingReason || toolsBadge) && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {leadBlockingReason && (
                <span
                  data-lead-status-reason={leadBlockingReason}
                  className="inline-flex items-center rounded-full border border-amber-500/35 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium leading-4 text-amber-800 dark:text-amber-300"
                >
                  {projectAgentReasonPhrase(locale, leadBlockingReason)}
                </span>
              )}
              {toolsBadge && (
                <span
                  data-lead-tools-ready={toolsBadge.attr}
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${toolsBadge.tone}`}
                >
                  {toolsBadge.label}
                </span>
              )}
            </div>
          )}
        </DialogHeader>
        {actionFailure && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive-text"
          >
            <span>{actionFailure.failure.phrase}</span>
            {renderRecovery(actionFailure.failure.recovery, false, actionOwnerLeadId)}
          </div>
        )}
        {readFailed && (
          <div
            className={`flex flex-wrap items-start justify-between gap-2${options ? "" : " min-h-40"}`}
          >
            <p role="alert">{readFailure?.phrase ?? management.failed}</p>
            {renderRecovery(readFailure?.recovery ?? "retry", true) ?? (
              <Button variant="outline" size="sm" onClick={reload}>
                {management.retry}
              </Button>
            )}
          </div>
        )}
        {(!readFailed || options) && (
          <div className="min-h-40" aria-busy={initialLoading}>
            {initialLoading && displayedCandidates.length === 0 && (
              <LoadingSkeleton label={tr("common.loading")} />
            )}
            {options && !leadAvailable && displayedCandidates.length === 0 && (
              <p className="text-muted-foreground">
                {projectAgentReasonPhrase(locale, leadBlockingReason)}
              </p>
            )}
            {leadAvailable && displayedCandidates.length === 0 && (
              <p className="text-muted-foreground">{copy.empty}</p>
            )}
            {displayedCandidates.length > 0 && (
              <div className="max-h-[50vh] space-y-1 overflow-y-auto">
                {displayedCandidates.map(({ row, candidate }) => {
                  const title = displaySessionTitle(row.title, tr);
                  const checked = candidate?.assigned === true || workers.includes(row.id);
                  const candidateReason = candidateReasonOf(candidate);
                  const rowBlocked =
                    !candidate?.assigned &&
                    (!!candidateReason ||
                      !leadAvailable ||
                      paused ||
                      (!checked && remaining === 0));
                  const statusWord = candidateReason
                    ? projectAgentReasonPhrase(locale, candidateReason)
                    : null;
                  const detail = row.worktree ? worktreeLabel(row.worktree, tr) : null;
                  return (
                    <div key={row.id} className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="content"
                        className="min-w-0 flex-1 justify-start gap-2.5 rounded-md px-2 py-2 text-left font-normal aria-pressed:border-primary"
                        aria-label={title}
                        aria-pressed={checked}
                        disabled={!candidate || busy || rowBlocked}
                        onClick={() => {
                          if (!candidate) return;
                          if (candidate.assigned) {
                            void remove(candidate, title);
                            return;
                          }
                          setSelected(
                            checked ? workers.filter((id) => id !== row.id) : [...workers, row.id],
                          );
                        }}
                      >
                        <AgentIcon agent={row.agent} compact />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{title}</span>
                          {detail && (
                            <span className="block truncate text-xs text-muted-foreground">
                              {detail}
                            </span>
                          )}
                        </span>
                        {statusWord && (
                          <span
                            data-candidate-status={candidateReason ?? undefined}
                            className="shrink-0 rounded-full border border-border/70 bg-muted/60 px-2 py-0.5 text-[11px] font-medium leading-4 text-muted-foreground"
                          >
                            {statusWord}
                          </span>
                        )}
                        {checked && <Check className="size-4 text-primary-text" aria-hidden />}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
            {(initialLoading || (leadAvailable && !paused)) && (
              <div className="mt-1 min-h-4 text-xs text-muted-foreground">
                {options &&
                  leadAvailable &&
                  !paused &&
                  (options.remaining === 0
                    ? projectAgentReasonPhrase(locale, "worker-limit-reached")
                    : copy.remaining(remaining))}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          {leadRecovery !== "none" && renderRecovery(leadRecovery, false, leadOwnerLeadId)}
          <Button ref={cancel} variant="outline" onClick={onClose} disabled={busy}>
            {tr("common.cancel")}
          </Button>
          <Button
            disabled={!workers.length || busy}
            onClick={() => void change({ operation: "lead-assign-workers", workers })}
          >
            {copy.assign}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
