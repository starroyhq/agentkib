import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { projectAgentCopy, sessionContinuationCopy } from "@agentkib/session-ui";
import { sessionProviderDeclaration } from "@agentkib/web-client";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

async function assignmentOptions(
  sessionId: string,
  candidateIds: string[],
): Promise<AssignmentOptions> {
  const value = (await desktopApi().claude.request({
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
  return value as AssignmentOptions;
}

function hasAssignmentRole(candidate: Candidate | undefined) {
  return (
    candidate?.reason === "session-is-a-worker" ||
    candidate?.reason === "session-is-a-project-agent"
  );
}

export function SessionWorkerAssignmentDialog({
  session,
  sessions,
  onClose,
  onChanged,
  onConnectTerminal,
}: {
  session: ConversationSessionSummary;
  sessions: ConversationSessionSummary[];
  onClose: () => void;
  onChanged?: () => void;
  onConnectTerminal?: () => void;
}) {
  const { locale, tr } = useI18n();
  const copy = workerAssignmentCopy[locale];
  const management = projectAgentCopy(locale);
  const dialogs = useAppDialogs();
  const [response, setResponse] = useState<{ key: string; value: AssignmentOptions | null }>();
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cancel = useRef<HTMLButtonElement>(null);
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
  const options = result ?? undefined;
  const readFailed = result === null;

  useEffect(() => {
    let active = true;
    const request =
      pending.current?.key === requestKey
        ? pending.current
        : {
            key: requestKey,
            promise: assignmentOptions(session.id, JSON.parse(candidateKey) as string[]).catch(
              () => null,
            ),
          };
    pending.current = request;
    void request.promise.then((value) => {
      if (pending.current === request) pending.current = undefined;
      if (active) setResponse({ key: requestKey, value });
    });
    return () => {
      active = false;
    };
  }, [session.id, candidateKey, requestKey]);

  function reload() {
    setSelected([]);
    setRevision((version) => version + 1);
  }

  async function change(params: Record<string, unknown>) {
    setError(undefined);
    setBusy(true);
    try {
      await desktopApi().claude.request({ ...params, sessionId: session.id });
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
  const candidates = candidateRows.flatMap(({ row, aliases }) => {
    const canonical = statuses.get(row.id);
    // An older assignment can reference an indexed ID. Keep it for removing that assignment.
    const linked = aliases.map((id) => statuses.get(id)).find(hasAssignmentRole);
    const candidate = hasAssignmentRole(canonical) ? canonical : (linked ?? canonical);
    return candidate ? [{ row, candidate }] : [];
  });
  const eligible = new Set(
    candidates
      .filter(({ candidate }) => !candidate.assigned && !candidate.reason)
      .map(({ row }) => row.id),
  );
  const workers =
    active && !options.reason
      ? selected.filter((id) => eligible.has(id)).slice(0, options.remaining)
      : [];
  const remaining = options ? options.remaining - workers.length : 0;
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg" initialFocus={cancel}>
        <DialogHeader className="pr-6">
          <DialogTitle>{copy.title(displaySessionTitle(session.title, tr))}</DialogTitle>
          {active && session.orchestration?.role !== "lead" && (
            <DialogDescription>{copy.firstAssignment}</DialogDescription>
          )}
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive-text">
            {error}
          </p>
        )}
        {readFailed ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p role="alert">{management.failed}</p>
            <Button variant="outline" size="sm" onClick={reload}>
              {tr("sessions.retry")}
            </Button>
          </div>
        ) : !options ? (
          <p role="status" className="text-muted-foreground">
            {tr("common.loading")}
          </p>
        ) : (
          <>
            {!options.capable && candidates.length === 0 && (
              <p className="text-muted-foreground">{cannotLead}</p>
            )}
            {options.capable && candidates.length === 0 && (
              <p className="text-muted-foreground">{copy.empty}</p>
            )}
            {candidates.length > 0 && (
              <div className="max-h-[50vh] space-y-1 overflow-y-auto">
                {candidates.map(({ row, candidate }) => {
                  const title = displaySessionTitle(row.title, tr);
                  const checked = candidate.assigned === true || workers.includes(row.id);
                  const unavailable = candidate.assigned
                    ? null
                    : (candidate.reason ??
                      (options.capable
                        ? (options.reason ??
                          (!checked && remaining === 0 ? "worker-limit-reached" : null))
                        : "lead-requires-managed-claude"));
                  const disabledReason =
                    unavailable &&
                    unavailable !== "antigravity-acp-disabled" &&
                    !(row.agent === "antigravity" && unavailable === "worker-agent-unsupported")
                      ? (copy.reasons[unavailable] ??
                        (options.capable
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
                      aria-description={candidate.assigned ? copy.assigned : undefined}
                      aria-pressed={checked}
                      disabled={busy || !!unavailable}
                      onClick={() => {
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
                      {disabledReason ? (
                        <Tooltip
                          onOpenChange={(open, details) => {
                            if (open && details.reason !== "trigger-hover") details.cancel();
                          }}
                        >
                          <TooltipTrigger
                            render={
                              <div
                                role="group"
                                aria-label={title}
                                aria-description={disabledReason}
                                tabIndex={0}
                                className="flex min-w-0 flex-1 rounded-md focus-visible:ring-2 focus-visible:ring-ring"
                              />
                            }
                            delay={300}
                          >
                            {rowButton}
                          </TooltipTrigger>
                          <TooltipContent role="tooltip">{disabledReason}</TooltipContent>
                        </Tooltip>
                      ) : (
                        rowButton
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {active && <p className="text-xs text-muted-foreground">{copy.remaining(remaining)}</p>}
          </>
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
