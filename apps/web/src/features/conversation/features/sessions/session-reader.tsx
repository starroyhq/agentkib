import { catalogCopy } from "../catalog/catalog-copy";
import { isLiveSessionAgent, managedAgentOf } from "@agentkib/web-client";
import { WorktreeNote } from "../catalog/worktree-note";
import { codexReason } from "./codex-copy";
import { isSendEnter, useEnterSends } from "./composer-shortcuts";
import { claudeSessionBanner } from "./claude-session-banner";
import { HistoryReferenceChips } from "../history/history-search-controls";
import { validHistoryMessage } from "../history/history-reference-model";
import { SessionOperations } from "./session-operations";
import { useSessionPanels } from "./session-panels";
import { ContextUsageGauge } from "./context-usage";
import { contextUsageCopyForSurface } from "./context-usage-copy";
import { SessionComposer } from "./session-composer";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { ArrowDown, ArrowUp, LoaderCircle, Square } from "lucide-react";
import { SessionTranscript } from "./session-transcript";
import { SessionInteractionDock } from "../interactions/interaction-dock";
import { MAX_MESSAGE_LENGTH } from "./session-model";
import { useSession } from "./session-context";
import { ArtifactBrowser } from "./artifact-browser";
import { ArtifactWorkspace } from "./artifact-panel";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  createSessionImageLoader,
  sessionImageCacheScope,
  sessionImageRevision,
} from "./session-image-scope";
import {
  useTranscriptFollow,
  useVisibleReadState,
  ReadStateNotice,
  readStateCopy,
  transcriptRepresentsResult,
} from "@agentkib/session-ui";
import { publishSessionInvalidation, subscribeSessionInvalidation } from "./session-events";
import { webLayoutCopy } from "./web-layout-copy";
export function SessionReader() {
  const session = useSession();
  const {
    historyReferences = [],
    t,
    access,
    selected,
    current,
    setModal,
    online,
    scroll,
    page,
    busy,
    earlier,
    historyDetailTurnId,
    loadingEarlier,
    locale,
    live,
    notice,
    noticeReason,
    canSend,
    canStop,
    message,
    setMessage,
    control,
    liveContentVersion,
    client,
    indexEnabled,
    imageRequestVersion,
  } = session;
  const enterSends = useEnterSends();
  const imageCacheRevision = sessionImageRevision(client);
  const imageCacheScope = sessionImageCacheScope(client, access, selected, indexEnabled !== false);
  const imageLoader = useMemo(() => {
    const version = imageRequestVersion?.();
    return createSessionImageLoader(
      client,
      access,
      selected,
      indexEnabled !== false,
      () =>
        sessionImageRevision(client) === imageCacheRevision &&
        sessionImageCacheScope(client, access, selected, indexEnabled !== false) ===
          imageCacheScope &&
        imageRequestVersion?.() === version,
    );
  }, [
    client,
    access,
    selected,
    indexEnabled,
    imageRequestVersion,
    imageCacheRevision,
    imageCacheScope,
  ]);
  const composing = useRef(false);
  const submitPending = useRef(false);
  const banner = claudeSessionBanner(session, "web");
  const panels = useSessionPanels();
  const readSubscription = useCallback(
    (listener: (userAction?: boolean) => void) =>
      subscribeSessionInvalidation(session.client, (id, domains) => {
        if (
          (!id || id === selected) &&
          domains.some((domain) =>
            ["catalog", "history", "live", "read-state", "read-state-refresh"].includes(domain),
          )
        )
          listener(domains.includes("read-state-refresh"));
      }),
    [session.client, selected],
  );
  // Only Codex and Claude Code sessions keep a read state. For other Agents a missing read state
  // is expected, not a sign that the computer needs an update.
  const readStateAgent = ["codex", "claude-code"].includes(current?.agent ?? "");
  const readObservation = useVisibleReadState({
    client: session.client,
    sessionId: selected,
    scope: JSON.stringify([
      session.origin,
      access?.bootId,
      access?.device?.id,
      access?.historySearchScope,
      access?.accountLogin?.accountId,
    ]),
    source: current?.readState?.source,
    catalogVersion: current?.readState?.version,
    supported: access?.readStateVersion === 1 && readStateAgent,
    ready: !!page && online && access?.status === "approved",
    blocked:
      !!session.modal ||
      session.historySearchOpen ||
      !!panels?.filesOpen ||
      !!panels?.actionsOpen ||
      !!panels?.terminalOpen,
    events: page?.events ?? [],
    viewportRef: scroll,
    subscribe: readSubscription,
    onAcknowledged: () => publishSessionInvalidation(session.client, selected, ["catalog"]),
  });
  const readCopy = readStateCopy(locale);
  const forkSource = current?.forked_from_session_id
    ? session.sessions?.find((item) => item.id === current.forked_from_session_id)
    : undefined;
  const hasNativeReply =
    !!live?.turnId &&
    page?.events.some((event) => event.kind === "agent-message" && event.turn_id === live.turnId);
  const liveStreamText = live?.status !== "idle" ? live?.streamText : undefined;
  const pendingMessage =
    session.pendingSend?.sessionId === selected ? session.pendingSend : undefined;
  const previousSession = useRef(selected);
  const previousContent = useRef({ events: page?.events, streamText: live?.streamText });
  const previousLiveContentVersion = useRef(liveContentVersion);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const { following, contentRef, pause, resume } = useTranscriptFollow({
    viewportRef: scroll,
    sessionId: selected,
    enabled: !!access && !!selected,
    layoutVersion: [page?.events, liveStreamText, liveContentVersion, pendingMessage],
    onFollowingChange: (value) => {
      if (value) setHasNewMessages(false);
    },
  });
  useLayoutEffect(() => {
    if (previousSession.current !== selected) {
      previousSession.current = selected;
      composing.current = false;
      submitPending.current = false;
      setHasNewMessages(false);
    } else if (!following.current && previousLiveContentVersion.current !== liveContentVersion) {
      const previous = previousContent.current;
      const last = previous.events?.at(-1);
      const latest = page?.events.at(-1);
      // Prepending a history page leaves existing content unchanged. Also
      // observe deltas to a message followed by another active tool item.
      const previousItems = new Map(previous.events?.map((event) => [event.id, event]));
      const changedText = page?.events.some((event) => {
        const old = previousItems.get(event.id);
        return old && old.content !== event.content;
      });
      const appended =
        last && latest?.id !== last.id && page?.events.some((event) => event.id === last.id);
      const streamed = !!live?.streamText && live.streamText !== previous.streamText;
      if (changedText || appended || streamed) setHasNewMessages(true);
    }
    previousContent.current = { events: page?.events, streamText: live?.streamText };
    previousLiveContentVersion.current = liveContentVersion;
  }, [selected, page?.events, live?.streamText, liveContentVersion, scroll]);
  if (!access || !selected) return null;
  return (
    <ArtifactWorkspace
      browser={
        <ArtifactBrowser
          key={selected}
          open={panels?.filesOpen ?? false}
          onOpenChange={(open) => panels?.setFilesOpen(open)}
          showTrigger={false}
        />
      }
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SessionOperations
          key={`operations-${selected}`}
          open={panels?.actionsOpen ?? false}
          onOpenChange={(open) => panels?.setActionsOpen(open)}
        />
        <section
          className="reader-scroll relative min-h-0 flex flex-1 flex-col overflow-y-auto overscroll-contain px-4 pb-2 pt-4 [scrollbar-gutter:stable] md:px-8"
          tabIndex={0}
          ref={(element) => {
            scroll.current = element;
          }}
        >
          {!page ? (
            <div
              role="status"
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
            >
              <LoaderCircle
                aria-hidden="true"
                className="size-6 animate-spin text-muted-foreground motion-reduce:animate-none"
              />
              <p className="text-sm text-muted-foreground">{t.loading}</p>
            </div>
          ) : (
            <div ref={contentRef} className="min-w-0 shrink-0">
              {readStateAgent && <ReadStateNotice locale={locale} observation={readObservation} />}
              {current?.agent === "claude-code" &&
                banner &&
                banner.notice !== "background-ended" && (
                  <aside
                    className="info mx-auto mb-5 max-w-3xl"
                    data-execution-mode={live?.executionMode}
                  >
                    {banner.title && <strong className="block mb-1">{banner.title}</strong>}
                    {banner.body}
                  </aside>
                )}
              {["codex", "claude-code"].includes(current?.agent ?? "") &&
                current?.forked_from_session_id && (
                  <p className="mx-auto mb-4 w-full max-w-3xl text-xs text-muted-foreground">
                    {catalogCopy[locale].fork}{" "}
                    {forkSource ? session.sourceTitle(forkSource.id) : t.untitled}
                  </p>
                )}
              {current?.worktree && <WorktreeNote worktree={current.worktree} locale={locale} />}
              {page?.warnings.length ? (
                <aside className="mx-auto mb-5 max-w-3xl rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-6 text-amber-600">
                  {t.warnings}: {page.warnings.join(" · ")}
                </aside>
              ) : null}
              <SessionTranscript
                key={selected}
                events={page.events}
                pendingMessage={pendingMessage}
                streamText={!hasNativeReply ? liveStreamText : undefined}
                streamTextTruncated={live?.streamTextTruncated}
                liveTurnId={live?.turnId}
                incomplete={page.warnings.length > 0}
                labels={t}
                locale={locale}
                onTool={setModal}
                imageLoader={imageLoader}
                hasEarlier={!!page.next_cursor}
                loadingEarlier={busy || loadingEarlier}
                historyDetailTurnId={historyDetailTurnId}
                earlierLabel={t.earlier}
                onLoadEarlier={async (turnId) => {
                  pause();
                  await earlier(turnId);
                }}
              />
              {readObservation.status === "ready" &&
                readObservation.events &&
                readObservation.readState?.freshness === "current" &&
                !transcriptRepresentsResult(
                  page.events,
                  readObservation.readState.latestResult,
                ) && (
                  <p
                    data-read-result={readObservation.readState.latestResult?.id ?? "threadStart"}
                    className="mx-auto mt-4 w-full max-w-3xl text-xs text-muted-foreground"
                  >
                    {readObservation.readState.latestResult
                      ? readCopy[readObservation.readState.latestResult.outcome]
                      : !page.events.length
                        ? readCopy.empty
                        : readObservation.readState.firstUnread?.type === "threadStart"
                          ? readCopy.manualUnread
                          : null}
                  </p>
                )}
            </div>
          )}
        </section>
        <div className="shrink-0 bg-background px-3 pb-3 pt-2 md:px-6" role="status">
          {hasNewMessages && (
            <Button
              type="button"
              variant="ghost"
              className="mb-2 flex min-h-9 w-fit mx-auto items-center gap-2 rounded-full border border-border bg-background px-3 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                resume();
                setHasNewMessages(false);
              }}
            >
              <ArrowDown size={16} />
              {webLayoutCopy[locale].newMessages}
            </Button>
          )}
          <div className="flex flex-col gap-2">
            {current?.agent === "claude-code" &&
              banner?.notice === "background-ended" &&
              !session.pendingSend && (
                <p
                  role="status"
                  className="mx-auto w-full max-w-3xl px-3 text-xs leading-5 text-muted-foreground"
                >
                  {banner.body}
                </p>
              )}
            <SessionInteractionDock />
            {notice &&
              // An accepted message shows up in the conversation at once; saying so is noise.
              notice !== "accepted" &&
              // The card reports the outcome of its own decisions while it is still shown.
              !(
                (session.noticeSource === "approve" || session.noticeSource === "answer") &&
                !!(live?.approvals.length || live?.questions?.length)
              ) &&
              // The composer's controls explain these beside a way into next-turn settings.
              !(
                notice === "notDispatched" &&
                ((current?.agent === "codex" &&
                  (noticeReason === "unsupported-model" ||
                    noticeReason === "unsupported-effort")) ||
                  (current?.agent === "claude-code" &&
                    access?.device?.accessMode === "full" &&
                    (noticeReason === "claude-model-unsupported" ||
                      noticeReason === "claude-effort-unsupported")))
              ) &&
              !(current?.agent === "claude-code" && banner && notice === "uncertain") && (
                <p
                  role="status"
                  className="mx-auto w-full max-w-3xl px-5 py-2 text-xs leading-6 text-muted-foreground"
                >
                  {notice === "notDispatched" && session.actionUnavailableReason
                    ? codexReason(locale, session.actionUnavailableReason, "web").text
                    : // Only a reason with its own explanation is kept; see `NotDispatchedReason`.
                      notice === "notDispatched" && noticeReason
                      ? codexReason(locale, noticeReason, "web").text
                      : t[notice]}
                </p>
              )}
            {isLiveSessionAgent(current?.agent) &&
            access.experimentalEnabled &&
            access.protocolVersion === 2 &&
            access.device?.send ? (
              managedAgentOf(current?.agent) ? (
                <SessionComposer
                  connectionStatusInBanner={!!banner && banner.notice !== "background-ended"}
                  key={`composer-${selected}`}
                />
              ) : (
                <form
                  className="w-full max-w-3xl shrink-0 self-center space-y-2 rounded-3xl border bg-background p-2 shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring/20"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (
                      online &&
                      !busy &&
                      canSend &&
                      live?.activity !== "compacting" &&
                      validHistoryMessage(message, historyReferences)
                    ) {
                      if (submitPending.current) return;
                      submitPending.current = true;
                      const requestSession = selected;
                      void Promise.resolve(control("send")).finally(() => {
                        if (previousSession.current === requestSession)
                          submitPending.current = false;
                      });
                    }
                  }}
                >
                  <HistoryReferenceChips />
                  <label className="sr-only" htmlFor="message">
                    {t.message}
                  </label>
                  <Textarea
                    id="message"
                    className="min-h-10 max-h-40 resize-none overflow-y-auto border-0 bg-transparent px-3 pt-2.5 text-sm shadow-none focus-visible:ring-0"
                    value={message}
                    maxLength={MAX_MESSAGE_LENGTH}
                    rows={1}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder={t.message}
                    disabled={busy}
                    onCompositionStart={() => {
                      composing.current = true;
                    }}
                    onCompositionEnd={() => {
                      composing.current = false;
                    }}
                    onBlur={() => {
                      composing.current = false;
                    }}
                    onKeyDown={(event) => {
                      if (!enterSends || !isSendEnter(event, composing.current)) return;
                      event.preventDefault();
                      if (!event.repeat && !busy && !submitPending.current)
                        event.currentTarget.form?.requestSubmit();
                    }}
                  />
                  <div className="flex items-center justify-between gap-2 px-2 pb-1">
                    <small className="max-w-lg text-xs leading-5 text-muted-foreground">
                      {t.experimental} · {t.controlInfo}
                    </small>
                    <div className="flex min-w-0 items-center gap-1">
                      <ContextUsageGauge />
                      {canStop ? (
                        <Button
                          type="button"
                          variant="destructive"
                          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                          aria-label={t.stop}
                          onClick={() => void control("stop")}
                        >
                          <Square size={17} />
                        </Button>
                      ) : (
                        <Button
                          type="submit"
                          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-30"
                          aria-label={t.send}
                          disabled={
                            !online ||
                            !canSend ||
                            live?.activity === "compacting" ||
                            !validHistoryMessage(message, historyReferences)
                          }
                        >
                          <ArrowUp size={20} />
                        </Button>
                      )}
                    </div>
                  </div>
                  {live?.activity === "compacting" && (
                    <p role="status" className="mt-2 text-xs text-muted-foreground">
                      {contextUsageCopyForSurface(locale, "web").compactingDetail}
                    </p>
                  )}
                </form>
              )
            ) : (
              <footer className="shrink-0 border-t px-5 py-4 text-center text-xs text-muted-foreground">
                {access.protocolVersion === 2 &&
                  access.device?.accessMode === "full" &&
                  access.device.advancedControl &&
                  ["codex", "claude-code", "antigravity"].includes(current?.agent ?? "") && (
                    <div className="flex justify-center">
                      <ContextUsageGauge />
                    </div>
                  )}
                {isLiveSessionAgent(current?.agent) &&
                access.experimentalEnabled &&
                access.device?.approve
                  ? t.noSendPermission
                  : access.protocolVersion !== 2
                    ? t.lanIncompatible
                    : t.readOnly}
              </footer>
            )}
          </div>
        </div>
      </div>
    </ArtifactWorkspace>
  );
}
