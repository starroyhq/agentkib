import {
  isLiveSessionAgent,
  sessionProviderCapabilities,
  sessionProviderDeclaration,
} from "@agentkib/web-client";
import { codexCopyForSurface, codexReason } from "./codex-copy";
import { claudeComposerNotice, claudeSessionBanner } from "./claude-session-banner";
import { HistoryReferenceChips } from "../history/history-search-controls";
import { validHistoryMessage } from "../history/history-reference-model";
import { SessionOperations } from "./session-operations";
import { useSessionPanels } from "./session-panels";
import { ContextUsageGauge } from "./context-usage";
import { SessionComposer } from "./session-composer";
import { basicSendQueue } from "./dsh-queue";
import { SessionTranscript } from "./session-transcript";
import { SessionInteractionDock } from "../interactions/interaction-dock";
import { MAX_MESSAGE_LENGTH } from "./session-model";
import { useSession } from "./session-context";
import { ArtifactBrowser } from "./artifact-browser";
import { ArtifactWorkspace } from "./artifact-panel";
import { useMemo } from "react";
import {
  createSessionImageLoader,
  sessionImageCacheScope,
  sessionImageRevision,
} from "./session-image-scope";
import {
  sessionComposerSurface,
  SessionActivities,
  SessionDetail,
  SessionDetailHeader,
  BasicSessionComposer,
  SessionDetailComposerNotices,
  SessionDetailReadOnlyFooter,
  useSessionDetailReadState,
} from "@agentkib/session-ui";
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
  const composerCopy = codexCopyForSurface(locale, "web");
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
  const banner = current?.agent === "claude-code" ? claudeSessionBanner(session, "web") : null;
  const scopedLive = live?.sessionId === selected ? live : undefined;
  const scopedSettings =
    scopedLive?.settings?.sessionId === selected ? scopedLive.settings : undefined;
  const contextUsageSource =
    scopedSettings?.provider?.contextUsage ??
    sessionProviderCapabilities(current?.agent)?.contextUsage;
  const readOnlyCapacity =
    contextUsageSource === "last-request" &&
    scopedSettings?.applicationStatus !== "pending" &&
    scopedSettings?.applicationStatus !== "unknown"
      ? scopedSettings?.current.maxContextTokens
      : undefined;
  const showReadOnlyContext =
    contextUsageSource === "last-request"
      ? (scopedLive?.usage ?? scopedSettings?.usage)?.historical === true ||
        (readOnlyCapacity !== undefined &&
          Number.isSafeInteger(readOnlyCapacity) &&
          readOnlyCapacity > 0)
      : contextUsageSource === "live" || current?.agent === "antigravity";
  const panels = useSessionPanels();
  const readObservation = useSessionDetailReadState({
    session,
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
        layout="web"
        sessionId={selected}
        locale={locale}
        labels={t}
        jumpLabel={webLayoutCopy[locale].newMessages}
        viewportRef={scroll}
        Transcript={SessionTranscript}
        history={{
          page,
          live: scopedLive,
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
            banner={banner && !claudeComposerNotice(banner) ? banner : undefined}
            executionMode={scopedLive?.executionMode}
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
                  live={scopedLive}
                  client={client}
                />
              }
              interactions={<SessionInteractionDock />}
              live={scopedLive}
              notice={notice}
              noticeSource={session.noticeSource}
              noticeReason={noticeReason}
              noticeText={
                notice === "notDispatched" && (session.actionUnavailableReason || noticeReason)
                  ? codexReason(locale, (session.actionUnavailableReason || noticeReason)!, "web")
                      .text
                  : notice
                    ? t[notice]
                    : undefined
              }
              hasSeparateBanner={!!banner}
            />
            {composerSurface === "managed" ? (
              <SessionComposer
                connectionStatusInBanner={!!banner && !claudeComposerNotice(banner)}
                key={selected}
              />
            ) : composerSurface === "basic" ? (
              <BasicSessionComposer
                key={selected}
                sessionId={selected}
                locale={locale}
                labels={{ ...t, addContext: composerCopy.addContext }}
                value={message}
                busy={busy}
                canSend={
                  online &&
                  !busy &&
                  canSend &&
                  scopedLive?.activity !== "compacting" &&
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
                  showReadOnlyContext && (
                    <ContextUsageGauge source={contextUsageSource} capacity={readOnlyCapacity} />
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
