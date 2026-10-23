import { ClaudeSessionPanel } from "./ClaudeSessionPanel";
import { useI18n } from "@/core/useI18n";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ConversationEventRow } from "@/features/sessions/ConversationEventRow";
import { HistoryError, HistoryWarning } from "@/features/sessions/HistoryFeedback";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  FileOutput,
  GitBranch,
  ListFilter,
  ListChecks,
  MessageSquareText,
  PlugZap,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/core/api";
import { DEFAULT_SESSION_PAGE_SIZE } from "@/core/session-history";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { useSessionSourceCapability } from "@/features/sessions/useSessionSourceCapability";
import { NativeImportRecoveryPanel } from "./NativeImportRecoveryPanel";
import { CursorBridgePanel } from "./CursorBridgePanel";
import { canContinueFromHistory } from "@/features/agents/agent-capabilities";
import { useSessionCatalog } from "@/features/sessions/useSessionCatalog";

import type {
  AgentKind,
  ChangeSet,
  ConversationEventPage,
  ConversationSessionSummary,
  CursorBridgeStatus,
  NativeImportOperation,
  PlannedSessionHandoff,
  WorkspaceSummary,
} from "@/core/types";
import { SessionHandoffDialog } from "./SessionHandoffDialog";
import { displaySessionTitle } from "./session-title";
import {
  isInteractiveFork,
  sessionSourceLabel,
  sessionSourceDetails,
  sessionAgentNames,
} from "@/features/sessions/session-labels";
import { isSessionVisible, workspaceSessionEntries } from "@/features/sessions/session-catalog";
import { useConversationCatalog } from "@/features/sessions/conversation-catalog";
import {
  prepareSessionNavigation,
  useSessionViewStore,
} from "@/features/sessions/session-view-store";
import { withAsyncCleanup } from "@/lib/utils";
import { SessionDirectoryEntry } from "@/features/sessions/SessionDirectoryEntry";
import { sessionSourceNeedsAttention } from "@/features/sessions/session-source-status";

type SessionFilter = "current" | "archived" | "metadata" | "all";
type AgentFilter = "all" | ConversationSessionSummary["agent"];

const sessionTranscriptKey = (sessionId: string) => ["sessions", "transcript", sessionId] as const;

/**
 * 把按时间倒序加载的分页合并为正序记录：更早的页面在前，同一事件只保留一次。
 * 预算提示只对最早加载的那一页有意义，继续向前加载后丢弃旧的提示。
 */
export function mergeTranscriptPages(pages: ConversationEventPage[]) {
  const seen = new Set<string>();
  const ordered = [...pages].reverse();
  const events = ordered
    .flatMap((page) => page.events)
    .filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });
  const warnings = [
    ...new Set(
      ordered.flatMap((page, index) =>
        index === 0
          ? page.warnings
          : page.warnings.filter((warning) => warning !== "TRANSCRIPT_SCAN_BUDGET"),
      ),
    ),
  ];
  return { events, warnings, nextCursor: pages.at(-1)?.next_cursor };
}

function matchesSessionFilter(session: ConversationSessionSummary, filter: SessionFilter) {
  if (filter === "current") return !session.archived && session.availability === "readable";
  if (filter === "archived") return session.archived;
  if (filter === "metadata") return session.availability === "metadata-only";
  return true;
}

function resolveLinkedSessionVisibility(
  session: ConversationSessionSummary,
  remote: WorkspaceSummary["remote"],
  catalogReady: boolean,
  catalogError: unknown,
): "visible" | "pending" | "hidden" {
  if (isSessionVisible(session)) return "visible";
  if (session.origin === "execution" && !remote && (!catalogReady || catalogError)) {
    return "pending";
  }
  return "hidden";
}

export function WorkspaceSessionsPage({
  workspace,
  enabled,
  onRuntimeChanged,
  onHandoffPlanned,
  onMcpConnectionPlanned,
  initialSessionId,
  onInitialSessionConsumed,
  resumeContinuation,
  onResumeConsumed,
  onOpenClaudeSession,
  targetAgents,
  installedAgents,
  onOpenSession,
  openHandoffOnInitialSession = false,
}: {
  workspace: WorkspaceSummary;
  enabled: boolean;
  onRuntimeChanged: (enabled: boolean) => Promise<void>;
  onHandoffPlanned: (handoff: PlannedSessionHandoff) => void;
  onMcpConnectionPlanned: (changeSet: ChangeSet, request: SessionContinuationResume) => void;
  initialSessionId?: string;
  onInitialSessionConsumed?: () => void;
  resumeContinuation?: SessionContinuationResume & { autoPrepare: boolean };
  onResumeConsumed?: () => void;
  onOpenClaudeSession?: (sessionId: string, panel?: "terminal") => void;
  targetAgents: AgentKind[];
  installedAgents?: AgentKind[];
  onOpenSession?: (sessionId: string) => void;
  openHandoffOnInitialSession?: boolean;
}) {
  const { formatDateTime, formatRelativeTime, localizeMessage, tr } = useI18n();
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState("");
  const enableLock = useRef(false);
  const [showClaude, setShowClaude] = useState(false);
  const [cursorBridgeWorkspaceId, setCursorBridgeWorkspaceId] = useState<string>();
  const [cursorBindingId, setCursorBindingId] = useState("");
  const showCursorBridge = cursorBridgeWorkspaceId === workspace.id && !workspace.remote;
  const cursorConnections = useRef<{ workspaceId: string; connected: Set<string> } | undefined>(
    undefined,
  );
  const catalog = useSessionCatalog([workspace], enabled);
  const sessions = catalog.sessions;
  const [selectedId, setSelectedId] = useState<string>();
  const managedCatalog = useConversationCatalog(enabled && !workspace.remote);
  const indexedSessions = useMemo(
    () =>
      workspaceSessionEntries(
        workspace.id,
        sessions,
        managedCatalog.sessions,
        initialSessionId ?? resumeContinuation?.sessionId ?? selectedId,
      ),
    [
      sessions,
      workspace.id,
      managedCatalog.sessions,
      initialSessionId,
      resumeContinuation?.sessionId,
      selectedId,
    ],
  );
  const statuses = catalog.statuses;
  const [readRevision, setReadRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [agent, setAgent] = useState<AgentFilter>("all");
  const [filter, setFilter] = useState<SessionFilter>("current");
  const refreshing = catalog.loading || catalog.refreshing;
  const [slowLoading, setSlowLoading] = useState(false);
  const [dismissedListErrorAt, setDismissedListErrorAt] = useState(0);
  const listReason = catalog.errors[workspace.id];
  const listError =
    listReason && catalog.errorUpdatedAt > dismissedListErrorAt
      ? { reason: listReason, at: catalog.errorUpdatedAt }
      : undefined;
  const queryClient = useOptionalQueryClient();
  const [showDetail, setShowDetail] = useState(false);
  const [hiddenSessionNotice, setHiddenSessionNotice] = useState(false);
  // A continuation belongs to its requested source, not the list's transient selection.
  // Consuming route parameters or refreshing the index must not dismiss the review.
  const [handoffSource, setHandoffSource] = useState<{
    workspaceId: string;
    session: ConversationSessionSummary;
  }>();
  const handoffSession =
    handoffSource?.workspaceId === workspace.id ? handoffSource.session : undefined;
  const [resumedRequest, setResumedRequest] = useState<
    (SessionContinuationResume & { autoPrepare: boolean }) | undefined
  >();
  const consumedInitialSession = useRef<string | undefined>(undefined);
  const revealSession = useSessionViewStore((state) => state.revealSession);

  const enableIndex = async () => {
    if (enableLock.current) return;
    enableLock.current = true;
    setEnabling(true);
    setEnableError("");
    await withAsyncCleanup(
      async () => {
        try {
          await onRuntimeChanged(true);
        } catch (error) {
          setEnableError(localizeMessage(error));
        }
      },
      () => {
        enableLock.current = false;
        setEnabling(false);
      },
    );
  };

  useEffect(() => {
    if (enabled) setEnableError("");
  }, [enabled]);

  const onCursorStatusChange = (status: CursorBridgeStatus | undefined) => {
    if (!status || workspace.remote) return;
    const connected = new Set(
      status.bindings.filter((binding) => binding.connected).map((binding) => binding.id),
    );
    const previous = cursorConnections.current;
    cursorConnections.current = { workspaceId: workspace.id, connected };
    if (
      previous?.workspaceId === workspace.id &&
      [...connected].some((id) => !previous.connected.has(id))
    )
      void catalog.refresh();
  };

  useEffect(() => {
    setCursorBridgeWorkspaceId(undefined);
    setCursorBindingId("");
    cursorConnections.current = undefined;
    setSelectedId(undefined);
    setHandoffSource(undefined);
    setResumedRequest(undefined);
    consumedInitialSession.current = undefined;
    setHiddenSessionNotice(false);
    setSlowLoading(false);
    setDismissedListErrorAt(0);
  }, [workspace.id, enabled]);

  useEffect(() => {
    if (!refreshing || sessions.length > 0) {
      setSlowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowLoading(true), 3000);
    return () => window.clearTimeout(timer);
  }, [refreshing, sessions.length]);

  const visibleSessions = useMemo(
    () => indexedSessions.filter(isSessionVisible),
    [indexedSessions],
  );
  const scopedSessions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return visibleSessions.filter((session) => {
      if (agent !== "all" && session.agent !== agent) return false;
      if (needle && !(session.title ?? "").toLocaleLowerCase().includes(needle)) return false;
      return true;
    });
  }, [agent, query, visibleSessions]);
  const filterCounts = useMemo(
    () =>
      Object.fromEntries(
        (["current", "archived", "metadata", "all"] as SessionFilter[]).map((value) => [
          value,
          scopedSessions.filter((session) => matchesSessionFilter(session, value)).length,
        ]),
      ) as Record<SessionFilter, number>,
    [scopedSessions],
  );
  const filtered = useMemo(
    () => scopedSessions.filter((session) => matchesSessionFilter(session, filter)),
    [filter, scopedSessions],
  );

  const selected = visibleSessions.find((session) => session.id === selectedId);
  const sourceCapability = useSessionSourceCapability(
    enabled && selected?.availability === "readable" ? selected.id : undefined,
    readRevision,
  );
  const selectedSources = selected
    ? sessionSourceDetails(selected, visibleSessions, tr, formatDateTime)
    : [];
  useEffect(() => {
    if (initialSessionId && consumedInitialSession.current !== initialSessionId) return;
    if (selectedId && filtered.some((session) => session.id === selectedId)) return;
    setSelectedId(filtered[0]?.id);
    setShowDetail(false);
  }, [filtered, selectedId, initialSessionId]);

  useEffect(() => {
    if (!initialSessionId || consumedInitialSession.current === initialSessionId) return;
    const target = indexedSessions.find(({ id }) => id === initialSessionId);
    if (!target) return;
    const visibility = resolveLinkedSessionVisibility(
      target,
      workspace.remote,
      managedCatalog.ready,
      managedCatalog.error,
    );
    if (visibility === "pending") return;
    if (visibility === "hidden") {
      consumedInitialSession.current = initialSessionId;
      setHiddenSessionNotice(true);
      setShowDetail(false);
      onInitialSessionConsumed?.();
      return;
    }
    consumedInitialSession.current = initialSessionId;
    setHiddenSessionNotice(false);
    revealSession(target);
    if (onOpenSession && !openHandoffOnInitialSession) {
      prepareSessionNavigation(target);
      onOpenSession(target.id);
      return;
    }
    setFilter("all");
    setSelectedId(initialSessionId);
    setShowDetail(true);
    if (openHandoffOnInitialSession)
      setHandoffSource({ workspaceId: workspace.id, session: target });
    onInitialSessionConsumed?.();
  }, [
    initialSessionId,
    onInitialSessionConsumed,
    revealSession,
    indexedSessions,
    managedCatalog.ready,
    managedCatalog.error,
    workspace.remote,
    onOpenSession,
    openHandoffOnInitialSession,
  ]);

  useEffect(() => {
    if (
      !resumeContinuation ||
      !indexedSessions.some(({ id }) => id === resumeContinuation.sessionId)
    ) {
      return;
    }
    const target = indexedSessions.find(({ id }) => id === resumeContinuation.sessionId);
    if (!target) return;
    const visibility = resolveLinkedSessionVisibility(
      target,
      workspace.remote,
      managedCatalog.ready,
      managedCatalog.error,
    );
    if (visibility === "pending") return;
    if (visibility === "hidden") {
      setHiddenSessionNotice(true);
      setShowDetail(false);
      onResumeConsumed?.();
      return;
    }
    setHiddenSessionNotice(false);
    revealSession(target);
    setFilter("all");
    setSelectedId(resumeContinuation.sessionId);
    setResumedRequest(resumeContinuation);
    setShowDetail(true);
    setHandoffSource({ workspaceId: workspace.id, session: target });
    onResumeConsumed?.();
  }, [
    onResumeConsumed,
    resumeContinuation,
    revealSession,
    sessions,
    indexedSessions,
    managedCatalog.ready,
    managedCatalog.error,
    workspace.remote,
  ]);

  // 切换会话时清掉列表错误，与之前"换会话即清空错误"的行为一致。
  const [errorSessionId, setErrorSessionId] = useState(selected?.id);
  if (selected?.id !== errorSessionId) {
    setErrorSessionId(selected?.id);
    setDismissedListErrorAt(catalog.errorUpdatedAt);
  }
  const readableSessionId =
    !onOpenSession && selected?.availability === "readable" ? selected.id : undefined;
  const transcriptObserverId = useId();
  const transcriptKey = [...sessionTranscriptKey(readableSessionId ?? ""), transcriptObserverId];
  // 第一页是最新的记录窗口，之后每一页都更早。staleTime 无限 + gcTime 0：
  // 选中时读取一次、取消选中即丢弃，与之前"每次选中重新读取"的行为一致，
  // 也避免后台按旧游标重取已失效的分页。
  const transcriptQuery = useInfiniteQuery(
    {
      ...queryDefaults,
      queryKey: transcriptKey,
      queryFn: ({ pageParam }) =>
        pageParam
          ? api.sessionEvents(readableSessionId!, pageParam)
          : api.sessionEvents(readableSessionId!),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.next_cursor ?? undefined,
      enabled: !!readableSessionId,
      staleTime: Infinity,
      gcTime: 0,
    },
    queryClient,
  );
  const transcriptPages = readableSessionId ? transcriptQuery.data?.pages : undefined;
  const { events, warnings, nextCursor } = useMemo(
    () => mergeTranscriptPages(transcriptPages ?? []),
    [transcriptPages],
  );
  const reading = transcriptQuery.isLoading;
  const loadingEarlier = transcriptQuery.isFetchingNextPage;
  const transcriptError = readableSessionId ? transcriptQuery.error : null;
  // 两种错误同时存在时显示较新的那个。
  const historyError =
    !!transcriptError && (!listError || transcriptQuery.errorUpdatedAt >= listError.at);
  const rawError: unknown = historyError ? transcriptError : (listError?.reason ?? "");
  const error = rawError === "" || rawError == null ? "" : localizeMessage(rawError);
  // 旧游标失效时从最新窗口重新读取，丢弃已加载的更早页面。
  const reloadTranscript = () => {
    setReadRevision((value) => value + 1);
    void queryClient.resetQueries({ queryKey: transcriptKey });
  };

  const loadEarlier = async () => {
    if (!nextCursor || reading || loadingEarlier) return;
    await transcriptQuery.fetchNextPage();
  };
  const reviewRecovery = (operation: NativeImportOperation) => {
    const source = visibleSessions.find(
      (session) =>
        session.id === operation.source_session_id && session.availability === "readable",
    );
    if (!source) return;
    revealSession(source);
    setFilter("all");
    setSelectedId(source.id);
    setResumedRequest({
      sessionId: source.id,
      targetAgent: operation.launch_request.target_agent,
      historyBudgetTokens: 120_000,
      format: "markdown",
      autoPrepare: false,
      ...(operation.binding_id && operation.launch_request.target_agent === "cursor"
        ? { targetSurface: "cursor-ide" as const, bindingId: operation.binding_id }
        : {}),
    });
    setShowDetail(true);
    setHandoffSource({ workspaceId: workspace.id, session: source });
  };

  if (!enabled) {
    return (
      <div className="grid min-h-[calc(100vh-220px)] place-content-center justify-items-center p-6 text-center">
        <div className="grid max-w-sm justify-items-center gap-4 rounded-2xl border border-border/70 bg-card p-8 shadow-sm">
          <div className="grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
            <MessageSquareText size={22} />
          </div>
          <div className="grid gap-1.5">
            <strong className="text-base text-foreground">
              {tr("conversations.indexDisabled")}
            </strong>
            <span className="text-sm text-muted-foreground">
              {tr("conversations.settingsTitle")}
            </span>
          </div>
          {enableError && (
            <p role="alert" className="text-sm text-destructive-text break-words">
              {enableError}
            </p>
          )}
          <Button disabled={enabling} aria-busy={enabling} onClick={() => void enableIndex()}>
            {enabling && <RefreshCw className="animate-spin" size={16} />}
            {tr(enabling ? "sessions.enabling" : "conversations.enable")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      {!catalog.ready && !error && (
        <div role="status" className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="animate-spin" size={16} />
          <span>{tr(slowLoading ? "conversations.scanningSlow" : "conversations.scanning")}</span>
        </div>
      )}
      {hiddenSessionNotice && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          {tr("sessions.hiddenRecord")}
        </p>
      )}
      {onOpenSession && error && (
        <div
          role="alert"
          className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive-text"
        >
          <span>{error}</span>
          <Button variant="outline" disabled={refreshing} onClick={() => void catalog.refresh()}>
            {tr("sessions.retry")}
          </Button>
        </div>
      )}
      {onOpenSession && (
        <NativeImportRecoveryPanel
          workspaceId={workspace.id}
          workspace={workspace}
          readableSourceIds={visibleSessions
            .filter((session) => session.availability === "readable")
            .map((session) => session.id)}
          onReview={reviewRecovery}
        />
      )}
      <div
        className={`grid h-[calc(100vh-150px)] max-h-[calc(100vh-150px)] min-h-0 items-stretch gap-4 max-[760px]:relative max-[760px]:h-full max-[760px]:max-h-none max-[760px]:block ${onOpenSession ? "grid-cols-1" : "grid-cols-[minmax(340px,380px)_minmax(0,1fr)]"}`}
      >
        <Card
          className={`flex min-h-0 min-w-0 flex-col self-start overflow-hidden rounded-2xl border-border/70 bg-card shadow-sm max-h-[calc(100vh-150px)] max-[760px]:h-full max-[760px]:max-h-none ${!onOpenSession && showDetail ? "max-[760px]:hidden" : ""}`}
        >
          <div className="border-b border-border/70 bg-muted/15 px-3 py-2.5">
            <div className="flex min-h-9 items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <MessageSquareText size={15} aria-hidden="true" />
                </span>
                <p className="min-w-0 truncate text-sm font-semibold text-foreground">
                  {tr("conversations.listTitle")}
                </p>
                <Badge
                  variant="outline"
                  className="shrink-0 border-transparent bg-muted text-muted-foreground !rounded-full !px-2 !py-0.5 !text-xs tabular-nums"
                  aria-label={`${filtered.length} ${tr("conversations.listTitle")}`}
                >
                  {filtered.length}
                </Badge>
              </div>
            </div>
            <div className="mt-2 flex min-w-0 flex-wrap items-center justify-end gap-1 max-[520px]:justify-start">
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2.5"
                onClick={() => setShowClaude(true)}
              >
                <MessageSquareText size={14} aria-hidden="true" />
                <span>Claude Code</span>
              </Button>
              {!workspace.remote && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 px-2.5"
                  onClick={() => setCursorBridgeWorkspaceId(workspace.id)}
                >
                  <PlugZap size={14} aria-hidden="true" />
                  {tr("handoff.cursor.connect")}
                </Button>
              )}
              <span className="mx-1 h-5 w-px bg-border max-[520px]:hidden" aria-hidden="true" />
              <DropdownMenu>
                <DropdownMenuTrigger
                  className={`inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${agent !== "all" ? "bg-accent text-accent-foreground" : ""}`}
                  aria-label={tr("conversations.agentFilter")}
                  title={tr("conversations.agentFilter")}
                >
                  <ListFilter size={16} aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{tr("conversations.agentFilter")}</DropdownMenuLabel>
                    {[
                      ["all", tr("conversations.allAgents")],
                      ...Object.entries(sessionAgentNames).filter(
                        ([value]) =>
                          visibleSessions.some((session) => session.agent === value) ||
                          agent === value,
                      ),
                    ].map(([value, label]) => (
                      <DropdownMenuItem
                        key={value}
                        onClick={() => setAgent(value as AgentFilter)}
                        className="pr-2"
                      >
                        <span className="grid size-4 place-items-center">
                          {agent === value && <Check size={14} />}
                        </span>
                        {label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger
                  className={`inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${filter !== "current" ? "bg-accent text-accent-foreground" : ""}`}
                  aria-label={tr("conversations.filterLabel")}
                  title={tr(`conversations.filter.${filter}`)}
                >
                  <ListChecks size={16} aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{tr("conversations.filterLabel")}</DropdownMenuLabel>
                    {(["current", "archived", "metadata", "all"] as SessionFilter[]).map(
                      (value) => (
                        <DropdownMenuItem
                          key={value}
                          onClick={() => setFilter(value)}
                          className="pr-2"
                        >
                          <span className="grid size-4 place-items-center">
                            {filter === value && <Check size={14} />}
                          </span>
                          <span>{tr(`conversations.filter.${value}`)}</span>
                          <Badge
                            variant="outline"
                            className="ml-auto border-transparent bg-muted text-muted-foreground !rounded-full !px-1.5 !py-0 !text-[10px] tabular-nums"
                          >
                            {filterCounts[value]}
                          </Badge>
                        </DropdownMenuItem>
                      ),
                    )}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="icon-sm"
                className={`text-muted-foreground hover:bg-muted hover:text-foreground ${searchOpen ? "bg-muted text-foreground" : ""}`}
                onClick={() => setSearchOpen((open) => !open)}
                aria-label={tr("conversations.searchPlaceholder")}
                aria-expanded={searchOpen}
                title={tr("conversations.searchPlaceholder")}
              >
                <Search size={16} aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => void catalog.refresh()}
                disabled={refreshing}
                aria-label={tr("conversations.refresh")}
                title={tr("conversations.refresh")}
              >
                <RefreshCw
                  size={16}
                  aria-hidden="true"
                  className={refreshing ? "animate-spin" : ""}
                />
              </Button>
            </div>
            {searchOpen && (
              <label className="mt-3 flex h-9 min-w-0 items-center gap-2 rounded-lg border border-input bg-background px-3 text-muted-foreground transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
                <Search size={15} />
                <Input
                  autoFocus
                  className="h-auto min-w-0 border-0 bg-transparent px-0 py-0 text-sm text-foreground shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={tr("conversations.searchPlaceholder")}
                />
                {query && (
                  <Button
                    variant="bare"
                    size="icon-xs"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setQuery("")}
                    aria-label={tr("common.clear")}
                    title={tr("common.clear")}
                  >
                    <X size={14} />
                  </Button>
                )}
              </label>
            )}
          </div>
          {statuses.some((status) => sessionSourceNeedsAttention(status, installedAgents)) && (
            <div className="flex min-h-[38px] items-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2.5 text-xs text-warning">
              <CircleAlert size={14} />
              <span>{tr("conversations.partialIndex")}</span>
            </div>
          )}
          <div role="list" className="min-h-0 flex-1 overflow-auto p-2">
            {filtered.map((session) => {
              const sourceLabel = sessionSourceLabel(session, indexedSessions, tr, formatDateTime);
              return (
                <Button
                  variant="bare"
                  size="content"
                  key={session.id}
                  role="listitem"
                  title={sourceLabel || undefined}
                  className={
                    onOpenSession
                      ? "session-directory-item mb-1 flex min-h-10 w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-sidebar-accent/70 [&>div]:shrink-0"
                      : `group mb-1 grid min-h-[82px] w-full grid-cols-[36px_minmax(0,1fr)_16px] items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors duration-200 ${selected?.id === session.id ? "border-primary/20 bg-accent-soft ring-1 ring-primary/5" : "border-transparent hover:border-border/70 hover:bg-muted/60"}`
                  }
                  onClick={() => {
                    if (onOpenSession) {
                      prepareSessionNavigation(session);
                      onOpenSession(session.id);
                      return;
                    }
                    setHiddenSessionNotice(false);
                    setSelectedId(session.id);
                    setShowDetail(true);
                  }}
                >
                  {onOpenSession ? (
                    <SessionDirectoryEntry session={session} sessions={indexedSessions} />
                  ) : (
                    <>
                      <AgentIcon agent={session.agent} />
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-2">
                          <strong className="truncate text-sm">
                            {displaySessionTitle(session.title, tr)}
                          </strong>
                          {isInteractiveFork(session) && (
                            <GitBranch
                              size={12}
                              aria-label={`${tr("conversations.forked")}: ${sourceLabel}`}
                            />
                          )}
                          {session.availability === "metadata-only" && (
                            <Badge
                              variant="secondary"
                              className="shrink-0 !rounded-full !px-1.5 !py-0 !text-[10px]"
                            >
                              {tr("conversations.metadataOnly")}
                            </Badge>
                          )}
                        </span>
                        <small className="mt-1 block truncate text-xs text-muted-foreground">
                          {session.updated_at
                            ? formatRelativeTime(session.updated_at)
                            : tr("conversations.unknownTime")}
                          {session.message_count != null
                            ? ` · ${tr("conversations.messageCount", { count: session.message_count })}`
                            : ""}
                        </small>
                        <em className="mt-1.5 flex min-h-4 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground not-italic">
                          {session.git_branch && (
                            <span className="inline-flex min-w-0 max-w-full items-center gap-1 truncate">
                              <GitBranch size={11} className="shrink-0" />
                              {session.git_branch}
                            </span>
                          )}
                          {session.archived && (
                            <span className="inline-flex items-center gap-1">
                              <Archive size={11} />
                              {tr("conversations.archived")}
                            </span>
                          )}
                          {session.sidechain && <span>{tr("conversations.sidechain")}</span>}
                        </em>
                      </span>
                      <ChevronRight
                        size={15}
                        className={`mt-1 transition-transform duration-200 ${selected?.id === session.id ? "text-foreground" : "text-muted-foreground/60 group-hover:translate-x-0.5 group-hover:text-foreground"}`}
                      />
                    </>
                  )}
                </Button>
              );
            })}
            {!filtered.length && (
              <div className="grid min-h-[220px] place-content-center justify-items-center gap-3 p-6 text-center text-muted-foreground">
                <span className="grid size-10 place-items-center rounded-xl bg-muted">
                  <MessageSquareText size={19} />
                </span>
                <strong className="max-w-[250px] text-sm text-foreground">
                  {tr(
                    filter === "current" && filterCounts.metadata > 0
                      ? "conversations.metadataAvailable"
                      : "conversations.empty",
                    { count: filterCounts.metadata },
                  )}
                </strong>
                {filter === "current" && filterCounts.metadata > 0 && (
                  <Button variant="outline" onClick={() => setFilter("metadata")}>
                    {tr("conversations.viewMetadata")}
                  </Button>
                )}
              </div>
            )}
          </div>
        </Card>
        {!onOpenSession && (
          <Card
            className={`grid min-w-0 min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-2xl border-border/70 bg-card shadow-sm max-[760px]:absolute max-[760px]:inset-0 ${showDetail ? "max-[760px]:grid" : "max-[760px]:hidden"}`}
          >
            <header className="flex min-h-[88px] items-center gap-3 border-b border-border/70 px-5 py-4">
              <Button
                variant="ghost"
                size="icon-sm"
                className="-ml-1 hidden shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground max-[760px]:inline-flex"
                onClick={() => setShowDetail(false)}
                aria-label={tr("conversations.back")}
              >
                <ArrowLeft size={16} />
              </Button>
              {selected ? (
                <>
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <AgentIcon agent={selected.agent} />
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <h2 className="truncate text-base font-semibold tracking-tight text-foreground">
                          {displaySessionTitle(selected.title, tr)}
                        </h2>
                        {selected.availability === "metadata-only" && (
                          <Badge
                            variant="secondary"
                            className="shrink-0 !rounded-full !px-1.5 !py-0 !text-[10px]"
                          >
                            {tr("conversations.metadataOnly")}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {selected.updated_at
                          ? formatDateTime(selected.updated_at)
                          : tr("conversations.unknownTime")}
                        {selected.git_branch ? ` · ${selected.git_branch}` : ""}
                      </p>
                      {sourceCapability?.source_surface && (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {tr(`handoff.cursor.source.${sourceCapability.source_surface}`)}
                        </span>
                      )}
                      {selected?.origin === "auxiliary" && !selectedSources.length && (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {tr("conversations.auxiliary")}
                        </span>
                      )}
                      {selectedSources.map((source) =>
                        source.session ? (
                          <Button
                            key={`${source.kind}:${source.id}`}
                            variant="link"
                            size="sm"
                            className="mt-1 h-auto max-w-full justify-start truncate p-0 text-xs"
                            title={source.label}
                            aria-label={source.label}
                            onClick={() => {
                              revealSession(source.session!);
                              setQuery("");
                              setAgent("all");
                              setFilter("all");
                              setSelectedId(source.session!.id);
                              setShowDetail(true);
                            }}
                          >
                            {source.kind === "forked" && <GitBranch size={12} />}
                            {source.label}
                          </Button>
                        ) : (
                          <span
                            key={`${source.kind}:${source.id}`}
                            className="mt-1 block truncate text-xs text-muted-foreground"
                            title={source.label}
                          >
                            {source.label}
                          </span>
                        ),
                      )}
                    </div>
                  </div>
                  {selected.availability === "readable" && events.length > 0 && (
                    <Button
                      variant="outline"
                      className="shrink-0"
                      disabled={!canContinueFromHistory(sourceCapability)}
                      title={
                        sourceCapability?.reason ||
                        (!sourceCapability ? tr("handoff.checkingSource") : undefined)
                      }
                      onClick={() =>
                        setHandoffSource({ workspaceId: workspace.id, session: selected })
                      }
                    >
                      <FileOutput size={14} />
                      {tr("handoff.create")}
                    </Button>
                  )}
                </>
              ) : (
                <div className="flex items-center gap-3 text-muted-foreground">
                  <span className="grid size-9 place-items-center rounded-xl bg-muted">
                    <MessageSquareText size={17} />
                  </span>
                  <strong className="text-sm text-foreground">
                    {tr("conversations.selectSession")}
                  </strong>
                </div>
              )}
            </header>
            <div className="min-h-0 overflow-auto bg-muted/15">
              {enabled && (
                <NativeImportRecoveryPanel
                  workspaceId={workspace.id}
                  workspace={workspace}
                  readableSourceIds={visibleSessions
                    .filter((session) => session.availability === "readable")
                    .map((session) => session.id)}
                  onReview={reviewRecovery}
                />
              )}
              {error && (
                <div className="mx-5 mt-5">
                  {historyError ? (
                    <HistoryError error={rawError} onRetry={reloadTranscript} />
                  ) : (
                    <div
                      role="alert"
                      className="rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive-text"
                    >
                      {error}
                    </div>
                  )}
                </div>
              )}
              {warnings.length > 0 && (
                <div className="mx-5 mt-4 grid gap-2">
                  {warnings.map((warning) => (
                    <HistoryWarning key={warning} warning={warning} />
                  ))}
                </div>
              )}
              {!selected && (
                <div className="grid min-h-[420px] place-content-center justify-items-center gap-3 p-8 text-center text-muted-foreground">
                  <span className="grid size-12 place-items-center rounded-2xl bg-background shadow-sm ring-1 ring-border/70">
                    <MessageSquareText size={22} />
                  </span>
                  <strong className="text-sm text-foreground">
                    {tr("conversations.selectSession")}
                  </strong>
                </div>
              )}
              {selected?.availability === "metadata-only" && (
                <div className="grid min-h-[420px] place-content-center justify-items-center gap-3 p-8 text-center text-muted-foreground">
                  <span className="grid size-12 place-items-center rounded-2xl bg-background shadow-sm ring-1 ring-border/70">
                    <Archive size={21} />
                  </span>
                  <strong className="text-sm text-foreground">
                    {tr("conversations.metadataOnly")}
                  </strong>
                  <span className="max-w-xs text-xs leading-relaxed">
                    {tr("conversations.metadataOnlyDetail")}
                  </span>
                </div>
              )}
              {selected?.availability === "readable" && (
                <div className="flex min-h-full flex-col gap-3 p-5">
                  <p className="text-sm text-muted-foreground">
                    {tr("history.latestWindow", { count: DEFAULT_SESSION_PAGE_SIZE })}
                  </p>
                  {nextCursor && (
                    <Button
                      variant="outline"
                      className="self-center"
                      disabled={loadingEarlier}
                      onClick={() => void loadEarlier()}
                    >
                      {tr(loadingEarlier ? "common.loading" : "conversations.loadEarlier")}
                    </Button>
                  )}
                  {reading && (
                    <div className="grid min-h-[180px] place-content-center justify-items-center gap-2 text-sm text-muted-foreground">
                      <RefreshCw className="animate-spin" size={18} />
                      <span>{tr("conversations.reading")}</span>
                    </div>
                  )}
                  {!reading && !events.length && !error && (
                    <div className="grid min-h-[220px] place-content-center justify-items-center gap-3 text-center text-muted-foreground">
                      <span className="grid size-10 place-items-center rounded-xl bg-background ring-1 ring-border/70">
                        <MessageSquareText size={19} />
                      </span>
                      <strong className="text-sm text-foreground">
                        {tr(nextCursor ? "history.emptyWindow" : "conversations.noReadableEvents")}
                      </strong>
                    </div>
                  )}
                  {events.map((event) => (
                    <ConversationEventRow key={event.id} event={event} />
                  ))}
                </div>
              )}
            </div>
          </Card>
        )}
      </div>
      {showCursorBridge && !workspace.remote && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setCursorBridgeWorkspaceId(undefined);
          }}
        >
          <DialogContent className="max-h-[calc(100vh-2rem)] overflow-auto sm:max-w-2xl">
            <DialogTitle>{tr("handoff.cursor.surface.ide")}</DialogTitle>
            <CursorBridgePanel
              key={workspace.id}
              workspace={workspace}
              bindingId={cursorBindingId}
              disabled={false}
              onBindingChange={setCursorBindingId}
              onStatusChange={onCursorStatusChange}
            />
          </DialogContent>
        </Dialog>
      )}
      {showClaude && (
        <ClaudeSessionPanel
          key={workspace.id}
          workspaceId={workspace.id}
          initialSessionId={selected?.agent === "claude-code" ? selected.id : undefined}
          onClose={() => setShowClaude(false)}
          onConnectTerminal={
            window.agentkibDesktop?.platform === "darwin" && onOpenClaudeSession
              ? (sessionId) => {
                  setShowClaude(false);
                  onOpenClaudeSession(sessionId, "terminal");
                }
              : undefined
          }
        />
      )}
      {handoffSession && (
        <SessionHandoffDialog
          key={`${workspace.id}:${handoffSession.id}`}
          workspace={workspace}
          session={handoffSession}
          targetAgents={targetAgents}
          onClose={() => {
            setHandoffSource(undefined);
            setResumedRequest(undefined);
          }}
          onPlanned={(changeSet) => {
            setHandoffSource(undefined);
            setResumedRequest(undefined);
            onHandoffPlanned(changeSet);
          }}
          onMcpConnectionPlanned={onMcpConnectionPlanned}
          initialRequest={
            resumedRequest?.sessionId === handoffSession.id ? resumedRequest : undefined
          }
        />
      )}
    </>
  );
}

export interface SessionContinuationResume {
  sessionId: string;
  targetAgent: AgentKind;
  historyBudgetTokens: number;
  format: import("@/core/types").HandoffFormat;
  targetSurface?: "cursor-ide";
  bindingId?: string;
  /** Claude Code sources: keep the choice to hand over history that a compaction replaced. */
  includePreCompactionHistory?: boolean;
}
