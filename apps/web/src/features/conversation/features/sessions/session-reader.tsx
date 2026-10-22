import { catalogCopy } from "../catalog/catalog-copy";
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
import { ArrowDown, ArrowUp, ChevronRight, LoaderCircle, ShieldCheck, Square } from "lucide-react";
import { SessionTranscript } from "./session-transcript";
import { interactionCopy } from "../interactions/question-form";
import { MAX_MESSAGE_LENGTH } from "./session-model";
import { useSession } from "./session-context";
import { ArtifactBrowser } from "./artifact-browser";
import { ArtifactWorkspace } from "./artifact-panel";
import { useLayoutEffect, useRef, useState } from "react";
import { webLayoutCopy } from "./web-layout-copy";
import { approvalSummary } from "./approval-summary";
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
  } = session;
  const enterSends = useEnterSends();
  const composing = useRef(false);
  const submitPending = useRef(false);
  const banner = claudeSessionBanner(session, "web");
  const panels = useSessionPanels();
  const forkSource = current?.forked_from_session_id
    ? session.sessions?.find((item) => item.id === current.forked_from_session_id)
    : undefined;
  const hasNativeReply =
    !!live?.turnId &&
    page?.events.some((event) => event.kind === "agent-message" && event.turn_id === live.turnId);
  const liveStreamText = live?.status !== "idle" ? live?.streamText : undefined;
  const following = useRef(true);
  const previousSession = useRef(selected);
  const previousContent = useRef({ events: page?.events, streamText: live?.streamText });
  const previousLiveContentVersion = useRef(liveContentVersion);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  useLayoutEffect(() => {
    if (previousSession.current !== selected) {
      previousSession.current = selected;
      composing.current = false;
      submitPending.current = false;
      following.current = true;
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
    const viewport = scroll.current;
    if (following.current && viewport) viewport.scrollTop = viewport.scrollHeight;
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
          ref={(element) => {
            scroll.current = element;
          }}
          onScroll={() => {
            const viewport = scroll.current;
            if (viewport)
              following.current =
                viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 96;
            if (following.current) setHasNewMessages(false);
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
            <>
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
              {page?.warnings.length ? (
                <aside className="mx-auto mb-5 max-w-3xl rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-6 text-amber-600">
                  {t.warnings}: {page.warnings.join(" · ")}
                </aside>
              ) : null}
              <SessionTranscript
                key={selected}
                events={page.events}
                pendingMessage={
                  session.pendingSend?.sessionId === selected ? session.pendingSend : undefined
                }
                streamText={!hasNativeReply ? liveStreamText : undefined}
                streamTextTruncated={live?.streamTextTruncated}
                liveTurnId={live?.turnId}
                incomplete={page.warnings.length > 0}
                labels={t}
                locale={locale}
                onTool={setModal}
                hasEarlier={!!page.next_cursor}
                loadingEarlier={busy}
                earlierLabel={t.earlier}
                onLoadEarlier={async () => {
                  following.current = false;
                  await earlier();
                }}
              />
            </>
          )}
        </section>
        <div className="shrink-0 bg-background px-3 pb-3 pt-2 md:px-6" role="status">
          {hasNewMessages && (
            <Button
              type="button"
              variant="ghost"
              className="mb-2 flex min-h-9 w-fit mx-auto items-center gap-2 rounded-full border border-border bg-background px-3 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                following.current = true;
                const viewport = scroll.current;
                if (viewport) viewport.scrollTop = viewport.scrollHeight;
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
            <div className="max-h-[25dvh] shrink-0 overflow-y-auto">
              {live?.approvals.map((a) => (
                <Button
                  variant="ghost"
                  key={a.requestId}
                  aria-label={`${t.approval} · ${approvalSummary(a, locale, t.unknownTool)} #${a.requestId}`}
                  className="mx-5 my-2 h-auto min-h-8 min-w-0 shrink-0 justify-start whitespace-normal border border-amber-500/25 bg-amber-500/5 text-left text-xs text-amber-700 dark:text-amber-300 [&>svg:last-child]:ml-auto"
                  onClick={() => setModal(a)}
                >
                  <ShieldCheck size={19} />
                  <span className="grid min-w-0 gap-1">
                    <span className="break-all">
                      {t.approval} · {approvalSummary(a, locale, t.unknownTool)}
                    </span>
                    <span className="break-all text-xs text-muted-foreground">#{a.requestId}</span>
                  </span>
                  <ChevronRight size={18} />
                </Button>
              ))}
              {live?.questions?.map((q) => (
                <Button
                  variant="ghost"
                  key={q.requestId}
                  className="mx-5 my-2 shrink-0 justify-start whitespace-normal border border-amber-500/25 bg-amber-500/5 text-left text-xs text-amber-700 dark:text-amber-300 [&>svg:last-child]:ml-auto"
                  onClick={() => setModal(q)}
                >
                  {interactionCopy[locale].title}
                  <ChevronRight size={18} />
                </Button>
              ))}
            </div>
            {notice &&
              !(
                current?.agent === "codex" &&
                notice === "notDispatched" &&
                (noticeReason === "unsupported-model" || noticeReason === "unsupported-effort")
              ) &&
              !(current?.agent === "claude-code" && banner && notice === "uncertain") && (
                <p
                  role="status"
                  className="mx-auto w-full max-w-3xl px-5 py-2 text-xs leading-6 text-muted-foreground"
                >
                  {notice === "notDispatched" && session.actionUnavailableReason
                    ? codexReason(locale, session.actionUnavailableReason, "web").text
                    : current?.agent === "codex" && notice === "notDispatched" && noticeReason
                      ? codexReason(locale, noticeReason, "web").text
                      : t[notice]}
                </p>
              )}
            {(current?.agent === "codex" ||
              current?.agent === "claude-code" ||
              current?.agent === "antigravity") &&
            access.experimentalEnabled &&
            access.protocolVersion === 2 &&
            access.device?.send ? (
              current?.agent === "codex" || current?.agent === "claude-code" ? (
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
                {(current?.agent === "codex" ||
                  current?.agent === "claude-code" ||
                  current?.agent === "antigravity") &&
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
