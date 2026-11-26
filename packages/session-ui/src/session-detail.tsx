import { ArrowDown, LoaderCircle } from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";
import type { ConversationEventPage, Live } from "@agentkib/web-client";
import { readResultAnchor, readStateCopy, type useVisibleReadState } from "./read-state";
import { LoadingSkeleton } from "./loading-feedback";
import { contextUsageCopyForSurface } from "./context-usage-copy";
import type { ComposerModelLocale } from "./composer-model-copy";
import { dshNativeStatusDisplay, sessionContinuationCopy } from "./session-continuation";
import {
  runningTurnLabel,
  sessionTurnStatus,
  type SessionExternalTurn,
  type SessionTurnLive,
} from "./session-turn-status";
import { SessionTranscript, type SessionTranscriptProps } from "./session-transcript";
import { useTranscriptFollow } from "./use-transcript-follow";

type SessionDetailLabels = SessionTranscriptProps["labels"] & {
  loading: string;
  warnings: string;
  earlier: string;
};

export interface SessionDetailProps {
  layout: "desktop" | "web";
  sessionId: string;
  locale: ComposerModelLocale;
  labels: SessionDetailLabels;
  jumpLabel: string;
  viewportRef: RefObject<HTMLElement | null>;
  history: {
    page?: ConversationEventPage | null;
    live?: (SessionTurnLive & Pick<Live, "streamText" | "streamTextTruncated">) | null;
    observesTerminalQuestions?: boolean;
    turnLive?: SessionTurnLive;
    online?: boolean;
    externalTurn?: SessionExternalTurn | null;
    liveContentVersion?: number;
    pending?: SessionTranscriptProps["pendingMessage"];
    detailTurnId?: string;
    loadingEarlier?: boolean;
    loadEarlier?: SessionTranscriptProps["onLoadEarlier"];
    imageLoader?: SessionTranscriptProps["imageLoader"];
    readObservation?: ReturnType<typeof useVisibleReadState>;
  };
  operations?: ReactNode;
  beforeTranscript?: ReactNode;
  activityPanel?: ReactNode;
  composer: ReactNode;
  Transcript?: ComponentType<SessionTranscriptProps>;
}

export function SessionDetail({
  layout,
  sessionId,
  locale,
  labels,
  jumpLabel,
  viewportRef,
  history,
  operations,
  beforeTranscript,
  activityPanel,
  composer,
  Transcript = SessionTranscript,
}: SessionDetailProps) {
  const sticky = layout === "desktop";
  const { page, pending, liveContentVersion, readObservation, loadEarlier } = history;
  const live = history.live?.sessionId === sessionId ? history.live : undefined;
  const turnLive = history.turnLive ?? live;
  const turn =
    history.online === false
      ? undefined
      : sessionTurnStatus(sessionId, turnLive, history.externalTurn);
  const nativeStatus =
    turnLive?.sessionId === sessionId ? dshNativeStatusDisplay(turnLive, locale) : undefined;
  const activeLabel =
    turn?.kind === "running"
      ? nativeStatus?.continuation === "dsh-observed"
        ? nativeStatus.label
        : runningTurnLabel(locale, sessionId, turn)
      : turn?.kind === "starting"
        ? sessionContinuationCopy(locale).starting
        : turn?.kind === "compacting"
          ? contextUsageCopyForSurface(locale, layout).compacting
          : undefined;
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  const measureComposer = sticky || !!activityPanel;
  useLayoutEffect(() => {
    if (!measureComposer) return;
    const composer = composerRef.current;
    if (!composer) return;
    // Reserve the sticky composer's visible height and keep the backing below its card.
    function measure() {
      if (!composer) return;
      const bounds = composer.getBoundingClientRect();
      if (sticky) {
        const card = composer.querySelector('[data-slot="session-composer"]');
        const cardTop = card
          ? card.getBoundingClientRect().top - bounds.top
          : parseFloat(getComputedStyle(composer).paddingTop) || 0;
        composer.style.setProperty("--reader-composer-card-top", `${Math.max(0, cardTop)}px`);
      }
      setComposerHeight(Math.ceil(bounds.height));
    }
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(composer);
    return () => observer?.disconnect();
  }, [measureComposer, sticky, sessionId]);

  const liveStreamText = live?.status !== "idle" ? live?.streamText : undefined;
  const { awayFromBottom, contentRef, pause, resume } = useTranscriptFollow({
    viewportRef,
    sessionId,
    enabled: true,
    layoutVersion: [
      page?.events,
      liveStreamText,
      liveContentVersion,
      pending,
      activeLabel,
      composerHeight,
    ],
  });

  const composerArea = (
    <div
      ref={measureComposer ? composerRef : undefined}
      className={
        sticky
          ? "reader-composer sticky bottom-0 z-10 mt-auto shrink-0 px-3 pb-3 pt-2 md:px-6"
          : "relative shrink-0 bg-background px-3 pb-3 pt-2 md:px-6"
      }
    >
      {awayFromBottom && (
        <div
          role={sticky ? undefined : "status"}
          className="pointer-events-none absolute -top-12 inset-x-0 flex justify-center"
        >
          <button
            type="button"
            aria-label={jumpLabel}
            title={jumpLabel}
            className="pointer-events-auto flex size-10 items-center justify-center rounded-full border border-border bg-background p-0 text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={resume}
          >
            <ArrowDown size={20} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="flex flex-col gap-2">{composer}</div>
    </div>
  );

  const nativeReply =
    !!live?.turnId &&
    page?.events.some((event) => event.kind === "agent-message" && event.turn_id === live.turnId);
  const currentReadState =
    readObservation?.status === "ready" &&
    readObservation.events &&
    readObservation.readState?.freshness === "current" &&
    readObservation.readState.status !== "unknown" &&
    readObservation.readState;
  const readCopy = readStateCopy(locale);
  const result = currentReadState ? currentReadState.latestResult : undefined;
  const resultAnchor = page && result && readResultAnchor(page.events, result, turn?.turnId);
  const threadStart =
    currentReadState && !result && currentReadState.firstUnread?.type === "threadStart";
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {operations}
      {activityPanel && (
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-end overflow-hidden pb-1 pt-2 ${sticky ? "px-3" : "px-2 md:px-5"}`}
          style={{ bottom: composerHeight }}
        >
          {activityPanel}
        </div>
      )}
      <section
        className={`reader-scroll relative min-h-0 flex flex-1 flex-col overflow-y-auto overscroll-contain pt-4 [scrollbar-gutter:stable] ${sticky ? "" : "px-4 pb-2 md:px-8"}`}
        style={sticky ? { scrollPaddingBottom: composerHeight } : undefined}
        tabIndex={0}
        ref={viewportRef}
      >
        {!page ? (
          <LoadingSkeleton
            key={sessionId}
            label={labels.loading}
            layout="conversation"
            className="mx-auto w-full max-w-3xl px-4"
          />
        ) : (
          <div
            ref={contentRef}
            className={
              sticky ? "reader-content min-w-0 shrink-0 px-4 pb-2 md:px-8" : "min-w-0 shrink-0"
            }
          >
            {beforeTranscript}
            {page.warnings.length > 0 && (
              <aside className="mx-auto mb-5 max-w-3xl rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-6 text-amber-600">
                {labels.warnings}: {page.warnings.join(" · ")}
              </aside>
            )}
            <Transcript
              key={sessionId}
              events={page.events}
              pendingMessage={pending}
              streamText={!nativeReply ? liveStreamText : undefined}
              streamTextTruncated={live?.streamTextTruncated}
              liveTurnId={live?.turnId}
              liveQuestions={live?.questions}
              observesTerminalQuestions={history.observesTerminalQuestions}
              activeTurnId={turn?.turnId}
              incomplete={page.warnings.length > 0}
              labels={labels}
              locale={locale}
              imageLoader={history.imageLoader}
              resultMarker={
                result && resultAnchor && !resultAnchor.terminal
                  ? {
                      eventId: resultAnchor.eventId,
                      turnId: resultAnchor.turnId,
                      id: result.id,
                      label: readCopy[result.outcome],
                    }
                  : undefined
              }
              hasEarlier={!!page.next_cursor && !!loadEarlier}
              loadingEarlier={history.loadingEarlier}
              historyDetailTurnId={history.detailTurnId}
              earlierLabel={labels.earlier}
              onLoadEarlier={
                loadEarlier &&
                (async (turnId) => {
                  pause();
                  await loadEarlier(turnId);
                })
              }
            />
            {currentReadState && !result && (threadStart || (!page.events.length && !turn)) && (
              <p
                data-read-result="threadStart"
                className="mx-auto mt-4 w-full max-w-3xl text-xs text-muted-foreground"
              >
                {!page.events.length ? readCopy.empty : readCopy.manualUnread}
              </p>
            )}
            {activeLabel && (
              <p
                role="status"
                data-session-turn-status={turn?.kind}
                className="mx-auto mt-4 flex w-full max-w-3xl items-center gap-2 text-sm text-muted-foreground"
              >
                <LoaderCircle
                  aria-hidden="true"
                  className="size-4 shrink-0 motion-safe:animate-spin"
                />
                {activeLabel}
              </p>
            )}
          </div>
        )}
        {sticky && composerArea}
      </section>
      {!sticky && composerArea}
    </div>
  );
}
