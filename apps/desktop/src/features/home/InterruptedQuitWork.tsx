import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { agentName } from "@agentkib/agent-identity";
import {
  REMOTE_ERROR_CODES as codes,
  type InterruptedQuitWork as QuitWorkTask,
  type RemoteErrorCode,
} from "@agentkib/runtime-protocol";
import { Button } from "@agentkib/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";
import { useI18n } from "@/core/useI18n";
import { refreshConversationCatalog } from "@/features/sessions/conversation-catalog";

const queryKey = ["home", "interrupted-quit-work"] as const;

function quitWorkListReason(error: unknown) {
  return error instanceof Error &&
    error.message.split(": ").at(-1) === codes.quitWorkJournalUnavailable
    ? codes.quitWorkJournalUnavailable
    : codes.quitWorkListUnavailable;
}

function quitWorkStatus(reason: RemoteErrorCode | undefined) {
  switch (reason) {
    case codes.controlOutcomeUnconfirmed:
      return "home.quitWork.unknown";
    case codes.quitWorkJournalUnavailable:
      return "home.quitWork.journalUnavailable";
    case codes.quitWorkListUnavailable:
      return "home.quitWork.listUnavailable";
    case codes.quitWorkManualRequired:
      return "dialog.quit.candidateUnavailable";
    case codes.quitWorkQueueUnconfirmed:
      return "home.quitWork.queueUnconfirmed";
    case codes.quitWorkQueueRestoreFailed:
      return "home.quitWork.queueRestoreFailed";
    case codes.quitWorkCandidateUnavailable:
    case codes.quitWorkPlanUnavailable:
      return "home.quitWork.verificationUnavailable";
    case codes.quitWorkEvidenceChanged:
      return "home.quitWork.evidenceChanged";
    case codes.claudeOwnerBusy:
    case codes.codexOwnerBusy:
    case codes.dshSessionInUse:
      return "home.quitWork.ownerBusy";
    case codes.dshRuntimeOffline:
      return "home.quitWork.runtimeOffline";
    default:
      return "home.quitWork.continuationUnavailable";
  }
}

export function InterruptedQuitWork({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const { tr } = useI18n();
  const queryClient = useQueryClient();
  const [unconfirmed, setUnconfirmed] = useState(new Set<string>());
  useEffect(
    () =>
      desktopApi().events.onQuitWorkResultsChanged(() => {
        const query = { queryKey, exact: true };
        // A receipt can arrive during the first read, before React Query has data.
        void queryClient.cancelQueries(query).then(() => queryClient.invalidateQueries(query));
      }),
    [queryClient],
  );
  const rememberUnconfirmed = (id: string) => setUnconfirmed((ids) => new Set(ids).add(id));
  const {
    data = [],
    error,
    isError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: api.interruptedQuitWorkResults,
    refetchOnMount: "always",
    retry: (failureCount, error) =>
      failureCount < 2 && quitWorkListReason(error) === codes.quitWorkListUnavailable,
    retryDelay: (attempt) => 500 * 2 ** attempt,
  });
  const listReason = quitWorkListReason(error);
  const resume = useMutation({
    mutationFn: ({ id }: QuitWorkTask) => api.resumeInterruptedQuitWork(id),
    retry: false,
    onError: (_, { id }) => rememberUnconfirmed(id),
    onSuccess(result, { id }) {
      if (result.outcome === "unknown") rememberUnconfirmed(id);
      if (result.outcome === "continued") void refreshConversationCatalog().catch(() => undefined);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  const resultListed = data.some(
    (task) =>
      task.id === resume.variables?.id &&
      (task.status === "skipped" || task.status === "continued"),
  );
  const result = resultListed ? undefined : resume.data;
  const queueReason =
    result?.outcome === "continued"
      ? (result.queueRestoreReason ?? result.bookkeepingReason)
      : undefined;
  const queueSession = queueReason ? resume.variables?.sessionId : undefined;
  const refused =
    result?.outcome === "skipped" || result?.outcome === "manual-required" ? result : undefined;
  if (!data.length && !isError && !queueSession && !refused) return null;
  return (
    <Card className="gap-3 p-4">
      <h2 className="font-medium">{tr("home.quitWork.title")}</h2>
      <ul className="grid gap-2">
        {data.map((task) => {
          const openSession = task.openSession === true || task.status === "skipped";
          const unknown =
            task.status === "unknown" ||
            (task.status === "interrupted" && unconfirmed.has(task.id));
          const reason = unknown
            ? codes.controlOutcomeUnconfirmed
            : (task.queueRestoreReason ?? task.reason ?? task.bookkeepingReason);
          const settled =
            resume.variables?.id === task.id &&
            (resume.data?.outcome === "continued" || resume.data?.outcome === "skipped");
          return (
            <li key={task.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{task.title.trim() || agentName(task.agent)}</span>
              {(reason || task.status === "skipped") && (
                <span className="text-sm text-muted-foreground">{tr(quitWorkStatus(reason))}</span>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={
                  !openSession &&
                  (isError ||
                    resume.isPending ||
                    task.status !== "interrupted" ||
                    !task.resumable ||
                    unknown ||
                    settled)
                }
                onClick={() => {
                  if (openSession) onOpenSession(task.sessionId);
                  else resume.mutate(task);
                }}
              >
                {tr(openSession ? "home.openSession" : "home.quitWork.continue")}
              </Button>
            </li>
          );
        })}
      </ul>
      {isError && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span role="status">{tr(quitWorkStatus(listReason))}</span>
          {listReason === codes.quitWorkListUnavailable && (
            <Button
              variant="outline"
              size="sm"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              {tr("home.quitWork.refresh")}
            </Button>
          )}
        </div>
      )}
      {refused && (
        <p role="status" className="text-sm text-muted-foreground">
          {tr(quitWorkStatus(refused.reason ?? refused.bookkeepingReason))}
        </p>
      )}
      {queueSession && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span role="status">{tr(quitWorkStatus(queueReason))}</span>
          <Button variant="outline" size="sm" onClick={() => onOpenSession(queueSession)}>
            {tr("home.openSession")}
          </Button>
        </div>
      )}
    </Card>
  );
}
