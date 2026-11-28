import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import {
  DelayedSpinner,
  LoadingSkeleton,
  projectAgentCopy,
  sessionContinuationCopy,
} from "@agentkib/session-ui";
import { sessionProviderDeclaration } from "@agentkib/web-client";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { Button } from "@agentkib/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@agentkib/ui/dialog";
import { desktopApi } from "@/core/desktop";
import type { ConversationSessionSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { worktreeLabel } from "./session-labels";
import { workerAssignmentCopy } from "./worker-assignment-copy";

type Candidate = {
  sessionId: string;
  reason: string | null;
  assigned?: boolean;
};

type AssignmentOptions = {
  capable: boolean;
  remaining: number;
  reason?: string | null;
  candidates: Candidate[];
};

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
  const { capable, remaining, reason, candidates } = value as AssignmentOptions;
  return {
    capable,
    remaining,
    reason,
    candidates: candidates.map(({ sessionId, reason, assigned }) => ({
      sessionId,
      reason,
      assigned,
    })),
  };
}

function hasAssignmentRole(candidate: Candidate | undefined) {
  return (
    candidate?.reason === "session-is-a-worker" ||
    candidate?.reason === "session-is-a-project-agent"
  );
}

type WorkerAssignmentDialogProps = {
  session: ConversationSessionSummary;
  sessions: ConversationSessionSummary[];
  onClose: () => void;
  onChanged?: () => void;
  onConnectTerminal?: () => void;
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
}: WorkerAssignmentDialogProps & { scope: string }) {
  const { locale, tr } = useI18n();
  const copy = workerAssignmentCopy[locale];
  const management = projectAgentCopy(locale);
  const dialogs = useAppDialogs();
  const [bridge] = useState(desktopApi);
  const [previous, setPrevious] = useState(() => assignmentCache.get(bridge)?.get(scope));
  const [response, setResponse] = useState<{ key: string; value: AssignmentOptions | null }>();
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cancel = useRef<HTMLButtonElement>(null);
  const retries = useRef(0);
  const pending = useRef<{ key: string; promise: Promise<AssignmentOptions | null> } | undefined>(
    undefined,
  );
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
  const result = response?.key === requestKey ? response.value : undefined;
  const options = result ?? previous;
  const readFailed = result === null;
  const initialLoading = result === undefined && !options;

  useEffect(() => {
    if (busy) return;
    let active = true;
    const request =
      pending.current?.key === requestKey
        ? pending.current
        : {
            key: requestKey,
            promise: assignmentOptions(
              bridge,
              session.id,
              JSON.parse(candidateKey) as string[],
            ).catch(() => null),
          };
    pending.current = request;
    void request.promise.then((value) => {
      if (!active || pending.current !== request) return;
      pending.current = undefined;
      setResponse({ key: requestKey, value });
      if (!value) return;
      const cached = assignmentCache.get(bridge) ?? new Map<string, AssignmentOptions>();
      cached.delete(scope);
      cached.set(scope, value);
      if (cached.size > MAX_CACHED_LEADS) cached.delete(cached.keys().next().value!);
      assignmentCache.set(bridge, cached);
      setPrevious(value);
      retries.current = 0;
    });
    return () => {
      active = false;
    };
  }, [bridge, busy, candidateKey, requestKey, scope, session.id]);

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
    setError(undefined);
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
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : "";
      const reasons = { ...management.errors, ...copy.reasons };
      const reason = Object.keys(reasons).find((key) => code.includes(key));
      setError(reason ? reasons[reason] : management.failed);
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

  const active = options?.capable && options.remaining > 0;
  const terminalDisconnected =
    options?.capable === false && options.reason === "lead-claude-terminal-disconnected";
  const cannotLead = terminalDisconnected ? copy.terminalDisconnected : copy.cannotLead;
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
      .filter(({ candidate }) => candidate && !candidate.assigned && !candidate.reason)
      .map(({ row }) => row.id),
  );
  const workers =
    active && !options.reason
      ? selected.filter((id) => eligible.has(id)).slice(0, options.remaining)
      : [];
  const remaining = options ? options.remaining - workers.length : 0;
  const displayedCandidates = result ? candidates.filter(({ candidate }) => candidate) : candidates;
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
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive-text">
            {error}
          </p>
        )}
        {readFailed && (
          <div
            className={`flex flex-wrap items-start justify-between gap-2${options ? "" : " min-h-40"}`}
          >
            <p role="alert">{management.failed}</p>
            <Button variant="outline" size="sm" onClick={reload}>
              {tr("sessions.retry")}
            </Button>
          </div>
        )}
        {(!readFailed || options) && (
          <div className="min-h-40" aria-busy={initialLoading}>
            {initialLoading && displayedCandidates.length === 0 && (
              <LoadingSkeleton label={tr("common.loading")} />
            )}
            {options && !options.capable && displayedCandidates.length === 0 && (
              <p className="text-muted-foreground">{cannotLead}</p>
            )}
            {options?.capable && displayedCandidates.length === 0 && (
              <p className="text-muted-foreground">{copy.empty}</p>
            )}
            {displayedCandidates.length > 0 && (
              <div className="max-h-[50vh] space-y-1 overflow-y-auto">
                {displayedCandidates.map(({ row, candidate }) => {
                  const title = displaySessionTitle(row.title, tr);
                  const checked = candidate?.assigned === true || workers.includes(row.id);
                  const unavailable = candidate?.assigned
                    ? null
                    : (candidate?.reason ??
                      (options?.capable
                        ? (options.reason ??
                          (!checked && remaining === 0 ? "worker-limit-reached" : null))
                        : "lead-requires-managed-claude"));
                  const disabledReason =
                    candidate &&
                    unavailable &&
                    unavailable !== "antigravity-acp-disabled" &&
                    !(row.agent === "antigravity" && unavailable === "worker-agent-unsupported")
                      ? (copy.reasons[unavailable] ??
                        (options?.capable
                          ? copy.unavailable
                          : candidate.reason
                            ? copy.cannotLead
                            : cannotLead))
                      : null;
                  const detail = row.worktree ? worktreeLabel(row.worktree, tr) : null;
                  const rowButton = (
                    <Button
                      variant="ghost"
                      size="content"
                      className="min-w-0 flex-1 justify-start gap-2.5 rounded-md px-2 py-2 text-left font-normal aria-pressed:border-primary"
                      aria-label={title}
                      aria-description={
                        disabledReason ?? (candidate?.assigned ? copy.assigned : undefined)
                      }
                      aria-pressed={checked}
                      disabled={!candidate || busy || !!unavailable}
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
                      {checked && <Check className="size-4 text-primary-text" aria-hidden />}
                    </Button>
                  );
                  return (
                    <div key={row.id} className="flex items-center gap-2">
                      {rowButton}
                    </div>
                  );
                })}
              </div>
            )}
            {(initialLoading || active) && (
              <div className="mt-1 min-h-4 text-xs text-muted-foreground">
                {active && copy.remaining(remaining)}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          {terminalDisconnected && onConnectTerminal && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                onClose();
                onConnectTerminal();
              }}
            >
              {sessionContinuationCopy(locale).connectTerminal}
            </Button>
          )}
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
