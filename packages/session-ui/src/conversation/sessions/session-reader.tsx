import { MAX_MESSAGE_LENGTH } from "@agentkib/conversation-state";
import {
  isLiveSessionAgent,
  sessionProviderCapabilities,
  sessionProviderDeclaration,
  type ConversationSessionSummary,
  type ResolvedHistoryReference,
  type SessionProviderCapabilities,
} from "@agentkib/web-client";
import type { ComponentProps, ComponentType, ReactNode } from "react";
import { ClaudeReturnToTerminal } from "../../agents/claude-code/session-return-to-terminal";
import { SessionArtifactBrowser, type SessionArtifactBrowserProps } from "../../artifact-browser";
import { ArtifactWorkspace } from "../../artifact-panel";
import { SessionActivities } from "../../session-activities";
import { sessionComposerSurface } from "../../session-composer-access";
import { SessionDetail, type SessionDetailProps } from "../../session-detail";
import {
  BasicSessionComposer,
  SessionDetailComposerNotices,
  SessionDetailReadOnlyFooter,
} from "../../session-detail-composer";
import { SessionDetailHeader } from "../../session-detail-header";
import { useSessionDetailReadState } from "../../session-detail-read-state";
import { SessionInteractionDock } from "../../session-interaction-dock";
import { sessionApprovalRuntime } from "../../agents/session-approvals";
import { ClaudeSessionReconcile } from "../../agents/claude-code/session-reconcile";
import { useSessionPlatform } from "../../session-platform";
import { resolveSessionProvider } from "../../session-provider";
import type { SessionTranscriptProps } from "../../session-transcript";
import { HistoryReferenceChips } from "../history/history-search-controls";
import { validHistoryMessage } from "../history/history-reference-model";
import { webLayoutCopy } from "./web-layout-copy";
import { SessionOutcomeAction, type SessionOutcomeControls } from "./session-outcome-action";

const codexTurnStartRejected = {
  "en-US": "Codex could not start the turn.",
  "zh-CN": "Codex 无法开始本轮。",
  "zh-Hant": "Codex 無法開始這一輪。",
  "ja-JP": "Codex がターンを開始できませんでした。",
};

type ReadState = Parameters<typeof useSessionDetailReadState>[0];
type InteractionState = ComponentProps<typeof SessionInteractionDock>["session"];
type History = SessionDetailProps["history"];
type ReaderSession = ReadState["session"] &
  InteractionState &
  SessionOutcomeControls &
  SessionArtifactBrowserProps["session"] & {
    t: SessionDetailProps["labels"] &
      Omit<ComponentProps<typeof BasicSessionComposer>["labels"], "addContext"> &
      Readonly<Record<string, string>>;
    historyReferences?: readonly ResolvedHistoryReference[];
    setHistoryReferences: (references: ResolvedHistoryReference[]) => void;
    sessions?: ConversationSessionSummary[];
    choose?: (sessionId: string) => Promise<void> | void;
    sourceTitle: (id: string) => string;
    earlier?: History["loadEarlier"];
    historyDetailTurnId?: string;
    loadingEarlier?: boolean;
    canSend: boolean;
    refresh: (manual?: boolean, preserveHistory?: boolean) => Promise<void>;
    message: string;
    setMessage: (value: string) => void;
    control: (action: "send" | "stop") => unknown;
    refresh: (manual?: boolean, preserveHistory?: boolean) => Promise<void>;
    liveContentVersion?: number;
    historySearchOpen: boolean;
    pendingSend?: NonNullable<History["pending"]> & { sessionId: string };
    actionUnavailableReason?: string | null;
  };

export type ReaderContextUsageProps = {
  source?: SessionProviderCapabilities["contextUsage"];
  capacity?: number;
};

type SessionReaderProps = {
  session: ReaderSession;
  agent: string;
  addContextLabel: string;
  explainReason: (reason: string) => string;
  panels?: {
    filesOpen: boolean;
    setFilesOpen: (open: boolean) => void;
    actionsOpen: boolean;
    setActionsOpen: (open: boolean) => void;
    terminalOpen?: boolean;
  } | null;
  banner?: { title: string; body: string; reconcileOutcome?: true } | null;
  composerBanner: boolean;
  connectionNoticeInToolbar?: boolean;
  displayLive?: History["turnLive"];
  localAuthority?: ReadState["localAuthority"];
  imageLoader?: History["imageLoader"];
  queue: { list?: ReactNode; action?: ReactNode };
  agentMark?: SessionTranscriptProps["agentMark"];
  Transcript?: ComponentType<SessionTranscriptProps>;
  Operations: ComponentType<{ open: boolean; onOpenChange: (open: boolean) => void }>;
  Composer: ComponentType<{
    connectionStatusInBanner: boolean;
    connectionNoticeInToolbar?: boolean;
  }>;
  ContextUsage: ComponentType<ReaderContextUsageProps>;
};

export function SessionReader({
  session,
  agent,
  addContextLabel,
  explainReason,
  panels,
  banner,
  composerBanner,
  connectionNoticeInToolbar,
  displayLive,
  localAuthority,
  imageLoader,
  queue,
  agentMark,
  Transcript,
  Operations,
  Composer,
  ContextUsage,
}: SessionReaderProps) {
  const { kind } = useSessionPlatform();
  const {
    historyReferences = [],
    t,
    access,
    selected,
    current,
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
  } = session;
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

  const inlineBanner =
    !connectionNoticeInToolbar && !composerBanner ? (banner ?? undefined) : undefined;
  const readObservation = useSessionDetailReadState({
    session,
    localAuthority,
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
  const turnStartError =
    !pendingMessage &&
    (!notice ||
      notice === "accepted" ||
      (notice === "notDispatched" && session.noticeSource === "send" && !noticeReason))
      ? selectedLive?.turnStartError
      : null;
  if (!access || !selected) return null;
  const composerSurface = sessionComposerSurface(current, access);
  return (
    <ArtifactWorkspace
      browser={
        <SessionArtifactBrowser
          session={session}
          key={selected}
          open={panels?.filesOpen ?? false}
          onOpenChange={(open) => panels?.setFilesOpen(open)}
          showTrigger={false}
        />
      }
    >
      <SessionDetail
        layout={kind}
        sessionId={selected}
        locale={locale}
        labels={t}
        jumpLabel={webLayoutCopy[locale].jumpToLatest}
        viewportRef={scroll}
        agentMark={agentMark}
        onOpenSession={session.choose}
        Transcript={Transcript}
        history={{
          page,
          live: selectedLive,
          observesTerminalQuestions:
            !!selectedLive &&
            sessionApprovalRuntime(
              selectedLive,
              resolveSessionProvider(current, session.capabilities)?.connection?.kind,
            )?.owner === "terminal",
          turnLive: displayLive,
          online,
          externalTurn: current?.id === selected ? current.externalTurn : undefined,
          liveContentVersion,
          pending: pendingMessage,
          detailTurnId: historyDetailTurnId,
          loadingEarlier: busy || loadingEarlier,
          loadEarlier: earlier,
          imageLoader,
          readObservation,
        }}
        operations={
          <Operations
            key={`operations-${selected}`}
            open={panels?.actionsOpen ?? false}
            onOpenChange={(open) => panels?.setActionsOpen(open)}
          />
        }
        activityPanel={
          <SessionActivities
            sessionId={selected}
            locale={locale}
            capabilities={
              sessionProviderDeclaration(current?.id === selected ? current.agent : undefined)
                ?.activities
            }
            live={selectedLive}
            client={client}
          />
        }
        beforeTranscript={
          <SessionDetailHeader
            locale={locale}
            session={current}
            forkTitle={forkSource ? session.sourceTitle(forkSource.id) : t.untitled}
            sourceTitle={session.sourceTitle}
            banner={inlineBanner}
            executionMode={selectedLive?.executionMode}
          />
        }
        composer={
          <>
            {kind === "desktop" && selectedLive?.executionMode === "claude-managed" && (
              <ClaudeReturnToTerminal
                key={JSON.stringify([selected, access.bootId, access.device?.id])}
                access={access}
                capabilities={session.capabilities}
                live={selectedLive}
                client={client}
                locale={locale}
                busy={busy || !online}
                explainReason={explainReason}
                refresh={() => session.refresh(true, true)}
              />
            )}
            <ClaudeSessionReconcile
              key={JSON.stringify([selected, access.bootId, access.device?.id])}
              visible={
                banner?.reconcileOutcome === true &&
                selectedLive?.executionMode === "claude-managed"
              }
              sessionId={selected}
              access={access}
              capabilities={session.capabilities}
              client={client}
              busy={busy}
              locale={locale}
              refresh={() => session.refresh(true, true)}
            />
            <SessionDetailComposerNotices
              agent={current?.agent}
              accessMode={access.device?.accessMode}
              banner={
                composerBanner && !banner?.reconcileOutcome && !session.pendingSend
                  ? banner?.body
                  : undefined
              }
              interactions={
                <SessionInteractionDock
                  session={session}
                  agent={agent}
                  explainReason={explainReason}
                  history={page?.events}
                  surface={kind}
                />
              }
              live={selectedLive}
              notice={
                turnStartError
                  ? "notDispatched"
                  : notice === "uncertain" && session.selectedOutcomes?.length
                    ? undefined
                    : notice
              }
              noticeSource={session.noticeSource}
              noticeReason={turnStartError?.reason ?? noticeReason}
              noticeText={
                turnStartError
                  ? [codexTurnStartRejected[locale], turnStartError.message]
                      .filter(Boolean)
                      .join(" ")
                  : notice === "notDispatched" && (session.actionUnavailableReason || noticeReason)
                    ? explainReason((session.actionUnavailableReason || noticeReason)!)
                    : notice
                      ? t[notice]
                      : undefined
              }
              hasSeparateBanner={!!banner}
            />
            {composerSurface === "managed" ? (
              <Composer
                connectionStatusInBanner={
                  !!banner && (!composerBanner || banner.reconcileOutcome === true)
                }
                connectionNoticeInToolbar={connectionNoticeInToolbar}
                key={selected}
              />
            ) : composerSurface === "basic" ? (
              <BasicSessionComposer
                key={selected}
                sessionId={selected}
                locale={locale}
                labels={{ ...t, addContext: addContextLabel }}
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
                primaryAction={(action) => (
                  <>
                    <SessionOutcomeAction
                      session={session}
                      actions={
                        canStop ? ["send", "approve", "answer"] : ["stop", "approve", "answer"]
                      }
                    />
                    {canStop ? (
                      action
                    ) : (
                      <SessionOutcomeAction
                        session={session}
                        actions={["send"]}
                        fallback={action}
                      />
                    )}
                  </>
                )}
                beforeComposer={queue.list}
                actions={queue.action}
                references={
                  <HistoryReferenceChips
                    access={access}
                    locale={locale}
                    references={historyReferences}
                    message={message}
                    disabled={busy}
                    onRemove={(item) =>
                      session.setHistoryReferences(
                        historyReferences.filter((entry) => entry !== item),
                      )
                    }
                  />
                }
                contextUsage={<ContextUsage />}
              />
            ) : (
              <SessionDetailReadOnlyFooter
                contextUsage={
                  access.protocolVersion === 2 &&
                  access.device?.accessMode === "full" &&
                  access.device.advancedControl &&
                  showReadOnlyUsage && (
                    <ContextUsage source={contextUsageSource} capacity={contextLimit} />
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
