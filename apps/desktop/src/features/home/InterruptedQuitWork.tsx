import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { agentName } from "@agentkib/agent-identity";
import {
  REMOTE_ERROR_CODES as codes,
  type InterruptedQuitWork as QuitWorkTask,
  type RemoteErrorCode,
} from "@agentkib/runtime-protocol";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/core/api";
import { useI18n } from "@/core/useI18n";
import { refreshConversationCatalog } from "@/features/sessions/conversation-catalog";

const queryKey = ["home", "interrupted-quit-work"] as const;

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
    case codes.claudeOwnerBusy:
    case codes.codexOwnerBusy:
    case codes.dshSessionInUse:
      return "home.quitWork.ownerBusy";
    case codes.dshRuntimeOffline:
      return "home.quitWork.runtimeOffline";
    default:
      return "home.quitWork.evidenceChanged";
  }
}

export function InterruptedQuitWork({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const { tr } = useI18n();
  const queryClient = useQueryClient();
  const [unconfirmed, setUnconfirmed] = useState(new Set<string>());
  const rememberUnconfirmed = (id: string) => setUnconfirmed((ids) => new Set(ids).add(id));
  const {
    data = [],
    error,
    isError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: api.interruptedQuitWork,
    retry: false,
  });
  const listReason =
    error instanceof Error && error.message.split(": ").at(-1) === codes.quitWorkJournalUnavailable
      ? codes.quitWorkJournalUnavailable
      : codes.quitWorkListUnavailable;
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
  const queueRestoreFailed =
    resume.data?.outcome === "continued" && !!resume.data.queueRestoreReason;
  const queueSession = queueRestoreFailed ? resume.variables?.sessionId : undefined;
  const refused =
    resume.data?.outcome === "skipped" || resume.data?.outcome === "manual-required"
      ? resume.data
      : undefined;
  if (!data.length && !isError && !queueRestoreFailed && !refused) return null;
  return (
    <Card className="gap-3 p-4">
      <h2 className="font-medium">{tr("home.quitWork.title")}</h2>
      <ul className="grid gap-2">
        {data.map((task) => {
          const openSession = task.status === "interrupted" && task.openSession === true;
          const unknown = task.status === "unknown" || unconfirmed.has(task.id);
          return (
            <li key={task.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{task.title.trim() || agentName(task.agent)}</span>
              {(unknown || task.reason) && (
                <span className="text-sm text-muted-foreground">
                  {tr(quitWorkStatus(unknown ? codes.controlOutcomeUnconfirmed : task.reason))}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={
                  !openSession && (isError || resume.isPending || !task.resumable || unknown)
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
          {tr(quitWorkStatus(refused.reason))}
        </p>
      )}
      {queueSession && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span role="status">{tr("home.quitWork.queueRestoreFailed")}</span>
          <Button variant="outline" size="sm" onClick={() => onOpenSession(queueSession)}>
            {tr("home.openSession")}
          </Button>
        </div>
      )}
    </Card>
  );
}
