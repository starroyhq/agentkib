import { agentName } from "@agentkib/agent-identity";
import {
  isLiveSessionAgent,
  sessionProviderCapabilities,
  sessionProviderDeclaration,
} from "@agentkib/web-client";
import {
  desktopReadScope as currentDesktopReadScope,
  useDesktopReadScope,
} from "../../../read-state-scope";
import { codexCopy, codexReason } from "./codex-copy";
import { claudeComposerNotice, claudeSessionBanner } from "./claude-session-banner";
import { HistoryReferenceChips } from "../history/history-search-controls";
import {
  validHistoryMessage,
  SessionTranscript,
  sessionComposerSurface,
  SessionActivities,
  SessionDetail,
  SessionDetailHeader,
  BasicSessionComposer,
  SessionDetailComposerNotices,
  SessionInteractionDock,
  SessionDetailReadOnlyFooter,
  useSessionDetailReadState,
} from "@agentkib/session-ui";
import { SessionOperations } from "./session-operations";
import { useSessionPanels } from "./session-panels";
import { ContextUsageGauge } from "./context-usage";
import { SessionComposer } from "./session-composer";
import { basicSendQueue } from "./dsh-queue";
import { MAX_MESSAGE_LENGTH } from "@agentkib/conversation-state";
import { useSession } from "./session-context";
import { ArtifactBrowser } from "./artifact-browser";
import { ArtifactWorkspace } from "./artifact-panel";
import { useMemo } from "react";
import {
  createSessionImageLoader,
  sessionImageCacheScope,
  sessionImageRevision,
} from "./session-image-scope";
import { webLayoutCopy } from "./web-layout-copy";
import { useConversationDisplayLive } from "../../../DesktopConversationWindow";
export function SessionReader() {
  const session = useSession();
  const explainReason = (reason: string) => codexReason(session.locale, reason).text;
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
  const displayLive = useConversationDisplayLive(selected);
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
  const banner = current?.agent === "claude-code" ? claudeSessionBanner(session) : null;
  const panels = useSessionPanels();
  const connectionNoticeInToolbar = !!(banner?.connection && panels?.statusInToolbar);
  const inlineBanner = connectionNoticeInToolbar ? null : banner;
  const readObservation = useSessionDetailReadState({
    session,
    localAuthority: {
      key: desktopReadScope.key,
      ready: desktopReadScope.ready,
      isCurrent: () => currentDesktopReadScope().key === desktopReadScope.key,
    },
    blocked:
      !!session.modal ||
      session.historySearchOpen ||
      !!panels?.filesOpen ||
      !!panels?.actionsOpen ||
      !!panels?.terminalOpen,
  });
  const forkSource = current?.forked_from_session_id
    ? session.sessions?.find((item) => item.id === current.forked_from_session_id)
    : undefined;
  const pendingMessage =
    session.pendingSend?.sessionId === selected ? session.pendingSend : undefined;
  if (!access || !selected) return null;
  const composerSurface = sessionComposerSurface(current, access);
  const queue = basicSendQueue(session);
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
      <SessionDetail
        layout="desktop"
        sessionId={selected}
        locale={locale}
        labels={t}
        jumpLabel={webLayoutCopy[locale].jumpToLatest}
        viewportRef={scroll}
        Transcript={SessionTranscript}
        history={{
          page,
          live: selectedLive,
          turnLive: displayLive,
          online,
          externalTurn: current?.id === selected ? current.externalTurn : undefined,
          liveContentVersion,
          pending: pendingMessage,
          detailTurnId: historyDetailTurnId,
          loadingEarlier: busy || loadingEarlier,
          loadEarlier: earlier,
          onTool: setModal,
          imageLoader,
          readObservation,
        }}
        operations={
          <SessionOperations
            key={`operations-${selected}`}
            open={panels?.actionsOpen ?? false}
            onOpenChange={(open) => panels?.setActionsOpen(open)}
          />
        }
        beforeTranscript={
          <SessionDetailHeader
            locale={locale}
            session={current}
            forkTitle={forkSource ? session.sourceTitle(forkSource.id) : t.untitled}
            sourceTitle={session.sourceTitle}
            banner={inlineBanner && !claudeComposerNotice(inlineBanner) ? inlineBanner : undefined}
            executionMode={selectedLive?.executionMode}
          />
        }
        composer={
          <>
            <SessionDetailComposerNotices
              agent={current?.agent}
              accessMode={access.device?.accessMode}
              banner={
                claudeComposerNotice(banner) && !session.pendingSend ? banner?.body : undefined
              }
              background={
                <SessionActivities
                  sessionId={selected}
                  locale={locale}
                  capabilities={sessionProviderDeclaration(current?.agent)?.activities}
                  live={selectedLive}
                  client={client}
                />
              }
              interactions={
                <SessionInteractionDock
                  session={session}
                  agent={agentName(current?.agent)}
                  explainReason={explainReason}
                />
              }
              live={selectedLive}
              notice={notice}
              noticeSource={session.noticeSource}
              noticeReason={noticeReason}
              noticeText={
                notice === "notDispatched" && (session.actionUnavailableReason || noticeReason)
                  ? explainReason((session.actionUnavailableReason || noticeReason)!)
                  : notice
                    ? t[notice]
                    : undefined
              }
              hasSeparateBanner={!!banner}
            />
            {composerSurface === "managed" ? (
              <SessionComposer
                connectionStatusInBanner={!!banner && !claudeComposerNotice(banner)}
                connectionNoticeInToolbar={connectionNoticeInToolbar}
                key={selected}
              />
            ) : composerSurface === "basic" ? (
              <BasicSessionComposer
                key={selected}
                sessionId={selected}
                locale={locale}
                labels={{ ...t, addContext: codexCopy[locale].addContext }}
                value={message}
                busy={busy}
                canSend={
                  online &&
                  !busy &&
                  canSend &&
                  selectedLive?.activity !== "compacting" &&
                  validHistoryMessage(message, historyReferences)
                }
                canStop={canStop}
                maxLength={MAX_MESSAGE_LENGTH}
                onChange={setMessage}
                onSend={async () => control("send")}
                onStop={() => void control("stop")}
                beforeComposer={queue.list}
                actions={queue.action}
                references={<HistoryReferenceChips />}
                contextUsage={<ContextUsageGauge />}
              />
            ) : (
              <SessionDetailReadOnlyFooter
                contextUsage={
                  access.protocolVersion === 2 &&
                  access.device?.accessMode === "full" &&
                  access.device.advancedControl &&
                  showReadOnlyUsage && (
                    <ContextUsageGauge source={contextUsageSource} limit={contextLimit} />
                  )
                }
                message={
                  isLiveSessionAgent(current?.agent) &&
                  access.experimentalEnabled &&
                  access.device?.approve
                    ? t.noSendPermission
                    : access.protocolVersion !== 2
                      ? t.lanIncompatible
                      : t.readOnly
                }
              />
            )}
          </>
        }
      />
    </ArtifactWorkspace>
  );
}
