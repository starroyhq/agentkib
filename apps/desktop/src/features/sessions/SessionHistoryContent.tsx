import type { RefObject } from "react";
import { HistoryReadState } from "@/features/remote/remote-read-state";
import { ArrowUpRight, ChevronRight, Clock, FileText, GitBranch } from "lucide-react";
import { EmbeddedSessionLoading, useDelayedBusy } from "@agentkib/session-ui";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useI18n } from "@/core/useI18n";
import type { ConversationSessionSummary } from "@/core/types";
import { useSessionHub } from "./SessionHubContext";
import { useSessionViewStore } from "./session-view-store";
import {
  sessionAgentNames,
  sessionRecordLabel,
  sessionSourceDetails,
  worktreeChip,
  worktreeLabel,
} from "./session-labels";
import { WorktreeMark } from "./WorktreeMark";
import { ConversationTranscript } from "./ConversationTranscript";
import { HistoryError, HistoryWarning } from "./HistoryFeedback";
import type { useSessionHistory } from "./useSessionHistory";
import { useHistoryContinuation } from "./useHistoryContinuation";

export function SessionHistoryContent({
  selected,
  history,
  sessionKey,
  loadEarlier,
  viewportRef,
}: {
  selected: ConversationSessionSummary;
  history: ReturnType<typeof useSessionHistory>;
  sessionKey: string;
  loadEarlier: (turnId?: string) => void;
  viewportRef: RefObject<HTMLElement | null>;
}) {
  const { tr, formatDateTime } = useI18n();
  const hub = useSessionHub();
  const workspace = hub.selectedWorkspace;
  const continuation = useHistoryContinuation(selected, workspace, hub.historyRevision);
  const showContinuationSpinner = useDelayedBusy(continuation.checking);
  const selectedSources = sessionSourceDetails(selected, hub.sessions, tr, formatDateTime);
  return (
    <>
      <div className="session-reading-context mx-auto flex max-w-[900px] flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        <span>
          {selected.remote?.host_name ?? tr("sessions.local")} · {workspace?.name} ·{" "}
          {sessionAgentNames[selected.agent]}
        </span>
        <span>{tr("sessions.historyReadonly")}</span>
        {continuation.canContinue || continuation.checking ? (
          <Button
            variant="outline"
            size="sm"
            className="h-auto whitespace-normal px-2 py-1 text-xs"
            disabled={continuation.checking}
            aria-busy={continuation.checking}
            onClick={continuation.continueSession}
          >
            {showContinuationSpinner ? (
              <span
                className="size-[13px] animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none"
                aria-hidden
              />
            ) : (
              <ArrowUpRight size={13} aria-hidden />
            )}
            {tr("handoff.create")}
          </Button>
        ) : (
          <span>{tr(continuation.reasonKey!)}</span>
        )}
      </div>
      <Collapsible
        className="session-history-details mx-auto mt-2 max-w-[900px] text-xs text-muted-foreground"
        key={sessionKey}
      >
        <CollapsibleTrigger className="session-details-trigger flex w-fit cursor-pointer items-center gap-1 rounded focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-4 [&[data-panel-open]>svg]:rotate-90">
          <ChevronRight size={13} />
          {tr("sessions.historyDetails")}
        </CollapsibleTrigger>
        <CollapsibleContent
          className="session-history-details-content py-3 leading-[1.7]"
          keepMounted
        >
          {workspace?.path && (
            <p className="session-detail-path mb-2 select-text [overflow-wrap:anywhere]">
              {workspace.path}
            </p>
          )}
          <div className="session-history-meta mb-4 flex flex-wrap gap-x-5 gap-y-3 text-muted-foreground [&>span]:flex [&>span]:items-center [&>span]:gap-1.5 [&>span]:[overflow-wrap:anywhere]">
            <span>
              <FileText size={15} />
              {sessionRecordLabel(selected, tr)}
            </span>
            {selected?.origin === "auxiliary" && !selectedSources.length && (
              <span>{tr("conversations.auxiliary")}</span>
            )}
            {selectedSources.map((source) =>
              source.session ? (
                <Button
                  key={`${source.kind}:${source.id}`}
                  variant="link"
                  size="sm"
                  className="h-auto gap-1 p-0 text-xs"
                  title={source.label}
                  aria-label={source.label}
                  onClick={() => {
                    useSessionViewStore.getState().revealSession(source.session!);
                    hub.select(source.session!.id);
                  }}
                >
                  {source.kind === "forked" && <GitBranch size={13} />}
                  {source.label}
                </Button>
              ) : (
                <span key={`${source.kind}:${source.id}`} title={source.label}>
                  {source.label}
                </span>
              ),
            )}
            <span>
              <Clock size={15} />
              {selected.updated_at
                ? formatDateTime(selected.updated_at)
                : tr("conversations.unknownTime")}
            </span>
            {selected.worktree ? (
              <span
                className="inline-flex items-center gap-1"
                title={worktreeLabel(selected.worktree, tr)}
              >
                <WorktreeMark
                  label={worktreeLabel(selected.worktree, tr)}
                  deleted={selected.worktree.status === "deleted"}
                />
                {worktreeChip(selected.worktree, tr)}
              </span>
            ) : (
              selected.git_branch && <span>{selected.git_branch}</span>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
      {selected.remote && (
        <p className="session-remote-status mx-auto max-w-[900px] text-xs text-muted-foreground">
          {tr(selected.remote.online ? "remote.state.online" : "remote.state.offline")} ·{" "}
          {tr("remote.catalogSynced")} {formatDateTime(selected.remote.last_synced_at)}
        </p>
      )}
      {history.error && (
        <HistoryError error={history.rawError} onRetry={() => void history.retry()} />
      )}
      {history.warnings.map((warning) => (
        <HistoryWarning key={warning} warning={warning} />
      ))}
      {selected.availability === "metadata-only" ? (
        <div className="session-state session-state-inline flex min-w-0 flex-1 flex-col items-center justify-center gap-4 p-7 px-5 text-center">
          <FileText size={28} />
          <h2 className="text-xl font-semibold">{tr("conversations.filter.metadata")}</h2>
          <p className="max-w-[520px] leading-[1.7] text-muted-foreground">
            {tr("sessions.metadataDescription")}
          </p>
        </div>
      ) : history.loading ? (
        <EmbeddedSessionLoading label={tr("sessions.loadingHistory")} />
      ) : (
        <div className="session-transcript mx-auto mt-6 flex w-full max-w-3xl flex-col gap-5">
          {!history.events.length && !history.error && (
            <p className="session-state-inline p-7 px-5 text-center text-muted-foreground">
              {tr(history.nextCursor ? "history.emptyWindow" : "conversations.noReadableEvents")}
            </p>
          )}
          <ConversationTranscript
            events={history.events}
            sessionKey={sessionKey}
            incomplete={history.warnings.length > 0}
            hasEarlier={!!history.nextCursor}
            historyDetailTurnId={history.historyDetailTurnId}
            loadingEarlier={history.loadingEarlier}
            loadEarlier={loadEarlier}
          />
          <HistoryReadState
            session={selected}
            events={history.events}
            ready={!history.error && !history.loading && !history.warnings.length}
            viewportRef={viewportRef}
          />
        </div>
      )}
    </>
  );
}
