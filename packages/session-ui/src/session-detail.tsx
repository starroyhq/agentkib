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
import {
  readResultAnchor,
  ReadStateNotice,
  readStateCopy,
  type useVisibleReadState,
} from "./read-state";
import { contextUsageCopyForSurface } from "./context-usage-copy";
import type { ComposerModelLocale } from "./composer-model-copy";
import { sessionContinuationCopy } from "./session-continuation";
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
    online?: boolean;
    externalTurn?: SessionExternalTurn | null;
    liveContentVersion?: number;
    pending?: SessionTranscriptProps["pendingMessage"];
    detailTurnId?: string;
    loadingEarlier?: boolean;
    loadEarlier: NonNullable<SessionTranscriptProps["onLoadEarlier"]>;
    onTool?: SessionTranscriptProps["onTool"];
    imageLoader?: SessionTranscriptProps["imageLoader"];
    readObservation?: ReturnType<typeof useVisibleReadState>;
  };
  operations?: ReactNode;
  beforeTranscript?: ReactNode;
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
  composer,
  Transcript = SessionTranscript,
}: SessionDetailProps) {
  const sticky = layout === "desktop";
  const { page, pending, liveContentVersion, readObservation } = history;
  const live = history.live?.sessionId === sessionId ? history.live : undefined;
  const turn =
    history.online === false ? undefined : sessionTurnStatus(sessionId, live, history.externalTurn);
  const activeLabel =
    turn?.kind === "running"
      ? runningTurnLabel(locale, sessionId, turn)
      : turn?.kind === "starting"
        ? sessionContinuationCopy(locale).starting
        : turn?.kind === "compacting"
          ? contextUsageCopyForSurface(locale, layout).compacting
          : undefined;
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  useLayoutEffect(() => {
    if (!sticky) return;
    const composer = composerRef.current;
    if (!composer) return;
    // Reserve the sticky composer's visible height and keep the backing below its card.
    function measure() {
      if (!composer) return;
      const bounds = composer.getBoundingClientRect();
      const card = composer.querySelector('[data-slot="session-composer"]');
      const cardTop = card
        ? card.getBoundingClientRect().top - bounds.top
        : parseFloat(getComputedStyle(composer).paddingTop) || 0;
      composer.style.setProperty("--reader-composer-card-top", `${Math.max(0, cardTop)}px`);
      setComposerHeight(Math.ceil(bounds.height));
    }
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(composer);
    return () => observer?.disconnect();
  }, [sticky, sessionId]);

  const liveStreamText = live?.status !== "idle" ? live?.streamText : undefined;
  const previous = useRef({
    sessionId,
    events: page?.events,
    stream: live?.streamText,
    liveContentVersion,
  });
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const { awayFromBottom, following, contentRef, pause, resume } = useTranscriptFollow({
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
    onFollowingChange: (value) => {
      if (value && !sticky) setHasNewMessages(false);
    },
  });
  useLayoutEffect(() => {
    if (sticky) return;
    const prior = previous.current;
    const events = page?.events;
    const stream = live?.streamText;
    if (prior.sessionId !== sessionId) setHasNewMessages(false);
    else if (!following.current && prior.liveContentVersion !== liveContentVersion) {
      // Prepending history leaves existing content intact. A live delta can update
      // an earlier message while a more recent tool row remains last.
      const last = prior.events?.at(-1);
      const previousItems = new Map(prior.events?.map((item) => [item.id, item]));
      const changedText = events?.some((item) => {
        const old = previousItems.get(item.id);
        return old && old.content !== item.content;
      });
      const appended =
        last && events?.at(-1)?.id !== last.id && events?.some((item) => item.id === last.id);
      if (changedText || appended || (stream && stream !== prior.stream)) setHasNewMessages(true);
    }
    previous.current = { sessionId, events, stream, liveContentVersion };
  }, [sticky, sessionId, page?.events, live?.streamText, liveContentVersion, following]);

  const composerArea = (
    <div
      ref={sticky ? composerRef : undefined}
      className={
        sticky
          ? "reader-composer sticky bottom-0 z-10 mt-auto shrink-0 px-3 pb-3 pt-2 md:px-6"
          : "shrink-0 bg-background px-3 pb-3 pt-2 md:px-6"
      }
      role={sticky ? undefined : "status"}
    >
      {(sticky ? awayFromBottom : hasNewMessages) && (
        <button
          type="button"
          aria-label={jumpLabel}
          className={`flex items-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            sticky
              ? "absolute -top-12 left-1/2 size-10 -translate-x-1/2 justify-center p-0"
              : "mx-auto mb-2 min-h-9 w-fit gap-2 px-3 text-xs"
          }`}
          onClick={() => {
            resume();
            if (!sticky) setHasNewMessages(false);
          }}
        >
          <ArrowDown size={sticky ? 20 : 16} aria-hidden="true" />
          {!sticky && jumpLabel}
        </button>
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
    readObservation.readState;
  const readCopy = readStateCopy(locale);
  const result = currentReadState ? currentReadState.latestResult : undefined;
  const resultAnchor = page && result && readResultAnchor(page.events, result, turn?.turnId);
  const threadStart =
    currentReadState && !result && currentReadState.firstUnread?.type === "threadStart";
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {operations}
      <section
        className={`reader-scroll relative min-h-0 flex flex-1 flex-col overflow-y-auto overscroll-contain pt-4 [scrollbar-gutter:stable] ${sticky ? "" : "px-4 pb-2 md:px-8"}`}
        style={sticky ? { scrollPaddingBottom: composerHeight } : undefined}
        tabIndex={0}
        ref={viewportRef}
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
            <p className="text-sm text-muted-foreground">{labels.loading}</p>
          </div>
        ) : (
          <div
            ref={contentRef}
            className={
              sticky ? "reader-content min-w-0 shrink-0 px-4 pb-2 md:px-8" : "min-w-0 shrink-0"
            }
          >
            {readObservation && <ReadStateNotice locale={locale} observation={readObservation} />}
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
              activeTurnId={turn?.turnId}
              incomplete={page.warnings.length > 0}
              labels={labels}
              locale={locale}
              onTool={history.onTool}
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
              hasEarlier={!!page.next_cursor}
              loadingEarlier={history.loadingEarlier}
              historyDetailTurnId={history.detailTurnId}
              earlierLabel={labels.earlier}
              onLoadEarlier={async (turnId) => {
                pause();
                await history.loadEarlier(turnId);
              }}
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
