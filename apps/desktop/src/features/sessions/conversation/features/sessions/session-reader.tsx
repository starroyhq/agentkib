import {
  isLiveSessionAgent,
  managedAgentOf,
  sessionProviderCapabilities,
} from "@agentkib/web-client";
import {
  desktopReadScope as currentDesktopReadScope,
  useDesktopReadScope,
} from "../../../read-state-scope";
import { catalogCopy } from "../catalog/catalog-copy";
import { OrchestrationNote } from "../catalog/orchestration-note";
import { WorktreeNote } from "../catalog/worktree-note";
import { codexCopy, codexReason } from "./codex-copy";
import {
  claudeBackgroundStatus,
  claudeComposerNotice,
  claudeSessionBanner,
} from "./claude-session-banner";
import { HistoryReferenceChips } from "../history/history-search-controls";
import { validHistoryMessage } from "../history/history-reference-model";
import { SessionOperations } from "./session-operations";
import { useSessionPanels } from "./session-panels";
import { ContextUsageGauge } from "./context-usage";
import { contextUsageCopy } from "./context-usage-copy";
import { SessionComposer } from "./session-composer";
import { Button } from "@/components/ui/button";
import { ArrowDown, LoaderCircle } from "lucide-react";
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
  composerAddCopy,
  ComposerPrimaryAction,
  ComposerToolbar,
  SessionComposerAddMenu,
  SessionComposerInput,
  useTranscriptFollow,
  useVisibleReadState,
  ReadStateNotice,
  readStateCopy,
  transcriptRepresentsResult,
  DEVIN_TURN_REASONS,
} from "@agentkib/session-ui";
import { publishSessionInvalidation, subscribeSessionInvalidation } from "./session-events";
import { webLayoutCopy } from "./web-layout-copy";
export function SessionReader() {
  const session = useSession();
  const desktopReadScope = useDesktopReadScope();
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
        currentDesktopReadScope().key === desktopReadScope.key &&
        imageRequestVersion?.() === version,
    );
  }, [
    client,
    access,
    selected,
    indexEnabled,
    imageRequestVersion,
    desktopReadScope.key,
    imageCacheRevision,
    imageCacheScope,
  ]);
  const readerReady = !!access && !!selected;
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  // The sticky composer shares the full-height scrollport. Reserve its visible
  // height for result navigation and keep following when the input grows.
  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) {
      setComposerHeight(0);
      return;
    }
    const measure = () => {
      const bounds = composer.getBoundingClientRect();
      const card = composer.querySelector('[data-slot="session-composer"]');
      // Prompts can move the card down. Align the solid backing with the card
      // so only its upper gap stays transparent, including after a resize.
      const cardTop = card
        ? card.getBoundingClientRect().top - bounds.top
        : parseFloat(getComputedStyle(composer).paddingTop) || 0;
      composer.style.setProperty("--reader-composer-card-top", `${Math.max(0, cardTop)}px`);
      setComposerHeight(Math.ceil(bounds.height));
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(composer);
    return () => observer?.disconnect();
  }, [readerReady, selected]);
  const submitPending = useRef(false);
  const selectedLive = live?.sessionId === selected ? live : undefined;
  const selectedSettings =
    selectedLive?.settings?.sessionId === selected ? selectedLive.settings : undefined;
  const contextUsageSource =
    selectedSettings?.provider?.contextUsage ??
    sessionProviderCapabilities(current?.agent)?.contextUsage;
  const contextLimit =
    contextUsageSource === "last-request" &&
    selectedSettings?.applicationStatus !== "pending" &&
    selectedSettings?.applicationStatus !== "unknown"
      ? selectedSettings?.current.maxContextTokens
      : undefined;
  const showReadOnlyUsage =
    contextUsageSource === "last-request"
      ? (selectedLive?.usage ?? selectedSettings?.usage)?.historical === true ||
        (contextLimit !== undefined && Number.isSafeInteger(contextLimit) && contextLimit > 0)
      : contextUsageSource === "live" || current?.agent === "antigravity";
  const banner = claudeSessionBanner(session);
  const backgroundStatus = claudeBackgroundStatus(session);
  const panels = useSessionPanels();
  const connectionNoticeInToolbar = !!(banner?.connection && panels?.statusInToolbar);
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
  // Codex, Claude Code and Devin sessions keep a read state (Devin's has the turns AgentKib ran).
  // For other Agents a missing read state is expected, not a sign that the computer needs an
  // update.
  const readStateAgent = ["codex", "claude-code", "devin"].includes(current?.agent ?? "");
  const readObservation = useVisibleReadState({
    client: session.client,
    sessionId: selected,
    reviewContext: "desktop-local",
    isCurrent: () => currentDesktopReadScope().key === desktopReadScope.key,
    scope: JSON.stringify([
      desktopReadScope.key,
      session.origin,
      access?.bootId,
      access?.device?.id,
      access?.historySearchScope,
      access?.accountLogin?.accountId,
    ]),
    source: current?.readState?.source,
    catalogVersion: current?.readState?.version,
    supported: access?.readStateVersion === 1 && readStateAgent,
    ready: desktopReadScope.ready && !!page && online && access?.status === "approved",
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
  const { awayFromBottom, contentRef, pause, resume } = useTranscriptFollow({
    viewportRef: scroll,
    sessionId: selected,
    enabled: readerReady,
    layoutVersion: [
      page?.events,
      liveStreamText,
      liveContentVersion,
      pendingMessage,
      live?.activity,
      composerHeight,
    ],
  });
  useLayoutEffect(() => {
    if (previousSession.current !== selected) {
      previousSession.current = selected;
      submitPending.current = false;
    }
  }, [selected]);
  if (!access || !selected) return null;
  const basicComposerReady =
    online &&
    !busy &&
    canSend &&
    live?.activity !== "compacting" &&
    validHistoryMessage(message, historyReferences);
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
          className="reader-scroll relative min-h-0 flex flex-1 flex-col overflow-y-auto overscroll-contain pt-4 [scrollbar-gutter:stable]"
          style={{ scrollPaddingBottom: composerHeight }}
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
            <div ref={contentRef} className="reader-content min-w-0 shrink-0 px-4 pb-2 md:px-8">
              {readStateAgent && <ReadStateNotice locale={locale} observation={readObservation} />}
              {current?.agent === "claude-code" &&
                banner &&
                !connectionNoticeInToolbar &&
                !claudeComposerNotice(banner) && (
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
              {current?.orchestration && (
                <OrchestrationNote
                  orchestration={current.orchestration}
                  leadTitle={
                    current.orchestration.role === "worker" &&
                    session.sourceTitle(current.orchestration.leadId) !==
                      current.orchestration.leadId
                      ? session.sourceTitle(current.orchestration.leadId)
                      : null
                  }
                  locale={locale}
                />
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
              {live?.sessionId === selected && live.activity === "compacting" && (
                <p
                  role="status"
                  className="mx-auto mt-4 flex w-full max-w-3xl items-center gap-2 text-sm text-muted-foreground"
                >
                  <LoaderCircle
                    aria-hidden="true"
                    className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
                  />
                  {contextUsageCopy[locale].compacting}
                </p>
              )}
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
          <div
            ref={composerRef}
            className="reader-composer sticky bottom-0 z-10 mt-auto shrink-0 px-3 pb-3 pt-2 md:px-6"
          >
            {awayFromBottom && (
              <Button
                type="button"
                variant="ghost"
                aria-label={webLayoutCopy[locale].jumpToLatest}
                className="absolute -top-12 left-1/2 flex size-10 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background p-0 text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={resume}
              >
                <ArrowDown size={20} aria-hidden="true" />
              </Button>
            )}
            <div className="flex flex-col gap-2">
              {current?.agent === "claude-code" &&
                claudeComposerNotice(banner) &&
                !session.pendingSend && (
                  <p
                    role="status"
                    className="mx-auto w-full max-w-3xl px-3 text-xs leading-5 text-muted-foreground"
                  >
                    {banner?.body}
                  </p>
                )}
              {current?.agent === "claude-code" && backgroundStatus && (
                <p
                  role="status"
                  className="mx-auto w-full max-w-3xl px-3 text-xs leading-5 text-muted-foreground"
                >
                  {backgroundStatus}
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
                        noticeReason === "claude-effort-unsupported")) ||
                    // Devin's own refusals are explained under its composer, with a way to fix them.
                    (current?.agent === "devin" && DEVIN_TURN_REASONS.includes(noticeReason ?? "")))
                ) &&
                !(current?.agent === "claude-code" && banner && notice === "uncertain") && (
                  <p
                    role="status"
                    className="mx-auto w-full max-w-3xl px-5 py-2 text-xs leading-6 text-muted-foreground"
                  >
                    {notice === "notDispatched" && session.actionUnavailableReason
                      ? codexReason(locale, session.actionUnavailableReason).text
                      : // Only a reason with its own explanation is kept; see `NotDispatchedReason`.
                        notice === "notDispatched" && noticeReason
                        ? codexReason(locale, noticeReason).text
                        : t[notice]}
                  </p>
                )}
              {isLiveSessionAgent(current?.agent) &&
              access.experimentalEnabled &&
              access.protocolVersion === 2 &&
              access.device?.send ? (
                managedAgentOf(current?.agent) ? (
                  <SessionComposer
                    connectionStatusInBanner={!!banner && !claudeComposerNotice(banner)}
                    connectionNoticeInToolbar={connectionNoticeInToolbar}
                    key={`composer-${selected}`}
                  />
                ) : (
                  <div className="w-full max-w-3xl shrink-0 self-center">
                    <SessionComposerInput
                      editorContextKey={selected}
                      editor={{
                        id: "message",
                        "aria-label": t.message,
                        value: message,
                        maxLength: MAX_MESSAGE_LENGTH,
                        onChange: (event) => setMessage(event.target.value),
                        placeholder: t.message,
                        disabled: busy,
                      }}
                      onSubmit={() => {
                        if (!basicComposerReady || submitPending.current) return;
                        submitPending.current = true;
                        const requestSession = selected;
                        void Promise.resolve(control("send")).finally(() => {
                          if (previousSession.current === requestSession)
                            submitPending.current = false;
                        });
                      }}
                      canSubmitFromKeyboard={() => !!basicComposerReady && !submitPending.current}
                      beforeEditor={<HistoryReferenceChips />}
                      toolbar={
                        <ComposerToolbar
                          leading={
                            <>
                              <SessionComposerAddMenu
                                locale={locale}
                                label={codexCopy[locale].addContext}
                                disabled
                                disabledReason={composerAddCopy(locale).unavailable}
                              />
                              <small className="max-w-lg text-xs leading-5 text-muted-foreground">
                                {t.experimental} · {t.controlInfo}
                              </small>
                            </>
                          }
                          trailing={
                            <>
                              <ContextUsageGauge />
                              {canStop ? (
                                <ComposerPrimaryAction
                                  label={t.stop}
                                  kind="stop"
                                  onStop={() => void control("stop")}
                                />
                              ) : (
                                <ComposerPrimaryAction
                                  label={t.send}
                                  disabled={!basicComposerReady}
                                />
                              )}
                            </>
                          }
                        />
                      }
                    />
                  </div>
                )
              ) : (
                <footer className="shrink-0 border-t px-5 py-4 text-center text-xs text-muted-foreground">
                  {access.protocolVersion === 2 &&
                    access.device?.accessMode === "full" &&
                    access.device.advancedControl &&
                    showReadOnlyUsage && (
                      <div className="flex justify-center">
                        <ContextUsageGauge source={contextUsageSource} limit={contextLimit} />
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
        </section>
      </div>
    </ArtifactWorkspace>
  );
}
