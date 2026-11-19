import { useEffect, useMemo, useRef, useState } from "react";
import { projectAgentCopy } from "@agentkib/session-ui";
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
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { desktopApi } from "@/core/desktop";
import type { ConversationSessionSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { sessionAgentNames, worktreeLabel } from "./session-labels";
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

async function assignmentOptions(sessionId: string): Promise<AssignmentOptions> {
  const value = (await desktopApi().claude.request({
    operation: "lead-assignment-options",
    sessionId,
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

export function SessionWorkerAssignmentDialog({
  session,
  sessions,
  onClose,
  onChanged,
}: {
  session: ConversationSessionSummary;
  sessions: ConversationSessionSummary[];
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { locale, tr } = useI18n();
  const copy = workerAssignmentCopy[locale];
  const management = projectAgentCopy(locale);
  const dialogs = useAppDialogs();
  const [options, setOptions] = useState<AssignmentOptions>();
  const [readFailed, setReadFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cancel = useRef<HTMLButtonElement>(null);
  const catalog = useMemo(() => {
    const rows = new Map<string, ConversationSessionSummary>();
    for (const row of sessions) {
      if (row.remote) continue;
      rows.set(row.id, row);
      for (const id of row.indexedSessionIds ?? []) {
        if (!rows.has(id)) rows.set(id, row);
      }
    }
    return rows;
  }, [sessions]);

  useEffect(() => {
    let active = true;
    void assignmentOptions(session.id).then(
      (state) => {
        if (active) setOptions(state);
      },
      () => {
        if (active) setReadFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [session.id, revision]);

  function reload() {
    setReadFailed(false);
    setOptions(undefined);
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
  const candidates = options?.candidates ?? [];
  const remaining = options ? Math.max(0, options.remaining - selected.length) : 0;
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
              <p className="text-muted-foreground">{copy.cannotLead}</p>
            )}
            {options.capable && candidates.length === 0 && (
              <p className="text-muted-foreground">{copy.empty}</p>
            )}
            {candidates.length > 0 && (
              <div className="max-h-[50vh] space-y-1 overflow-y-auto">
                {candidates.map((candidate) => {
                  const row = catalog.get(candidate.sessionId);
                  const title = displaySessionTitle(row?.title, tr);
                  const checked = selected.includes(candidate.sessionId);
                  const unavailable =
                    candidate.reason ??
                    (options.capable
                      ? (options.reason ??
                        (!checked && remaining === 0 ? "worker-limit-reached" : null))
                      : "lead-requires-managed-claude");
                  const disabledReason = candidate.assigned
                    ? copy.assigned
                    : unavailable
                      ? (copy.reasons[unavailable] ??
                        (options.capable ? copy.unavailable : copy.cannotLead))
                      : null;
                  const detail = row
                    ? [
                        sessionAgentNames[row.agent],
                        row.worktree ? worktreeLabel(row.worktree, tr) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : null;
                  const label = (
                    <label
                      className={`flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 ${disabledReason ? "opacity-50" : "cursor-pointer hover:bg-muted"}`}
                    >
                      <NativeCheckbox
                        aria-label={title}
                        checked={checked}
                        disabled={busy || !!disabledReason}
                        onChange={(event) => {
                          const enabled = event.target.checked;
                          setSelected((ids) =>
                            enabled
                              ? [...ids, candidate.sessionId]
                              : ids.filter((id) => id !== candidate.sessionId),
                          );
                        }}
                      />
                      {row && <AgentIcon agent={row.agent} compact />}
                      <span className="min-w-0">
                        <span className="block truncate">{title}</span>
                        {detail && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {detail}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                  return (
                    <div key={candidate.sessionId} className="flex items-center gap-2">
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
                                className="min-w-0 flex-1 rounded-md focus-visible:ring-2 focus-visible:ring-ring"
                              />
                            }
                            delay={300}
                          >
                            {label}
                          </TooltipTrigger>
                          <TooltipContent role="tooltip">{disabledReason}</TooltipContent>
                        </Tooltip>
                      ) : (
                        label
                      )}
                      {candidate.assigned && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void remove(candidate, title)}
                        >
                          {management.removeWorker}
                        </Button>
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
          <Button ref={cancel} variant="outline" onClick={onClose} disabled={busy}>
            {tr("common.cancel")}
          </Button>
          <Button
            disabled={!active || !selected.length || busy}
            onClick={() => void change({ operation: "lead-assign-workers", workers: selected })}
          >
            {copy.assign}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
