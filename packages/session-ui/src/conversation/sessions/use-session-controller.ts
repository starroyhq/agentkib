import {
  createSessionControl,
  codexSettingsRecoveryReason,
  type ControlKind,
  type ControlNotice,
  type NotDispatchedReason,
} from "../../session-control";
import { warmSessionAuthority } from "../../warm-session-stream";
import {
  createEarlierSessionHistory,
  useSessionHistoryRead,
  type EarlierHistoryFlight,
} from "../../session-controller-history";
import {
  completedForkReceipt,
  dispatchSessionAction,
  readPendingControlReceipt,
  verifySettingsWrite,
  settingsNoticeGroup,
} from "../../session-control-receipts";
import { dshNativeStatusDisplay } from "../../session-continuation";
import { type ContinuationComposerDraft, type ContinuationDraft } from "./continuation-draft";
import { claudeConnectionReason } from "../../agents/claude-code/connection-copy";
import {
  historyMessageText,
  historyReferenceKey,
  referencesWithinBudget,
} from "../history/history-reference-model";
import {
  forgetPending,
  pendingScope,
  readPending,
  rememberPending,
  type PendingControl,
} from "./pending-controls";
import { blockedWhileCompacting } from "./session-activity";
import { contextUsageCopyForSurface } from "../../context-usage-copy";
import { checkLiveSession, retryBusyRead } from "../../session-read-retry";
import { capabilityAccessBinding, useSessionCapabilities } from "../../use-session-capabilities";
import { interactionCopy } from "../interactions/interaction-copy";
import { catalogCopy } from "../../catalog-copy";
import { unavailableReasonText } from "../live-status";
import { useAppearance } from "../preferences/use-appearance";
import type { ResolvedHistoryReference } from "@agentkib/web-client";
import {
  createConversationStore,
  createTranscriptPageCache,
  mergeConversationItems,
  oldestIncompleteHistoryTurn,
  type SessionStreamEvent,
  mergeLatestPage,
  mergeOrderedPersistedHistory,
  removePersistedOverlays,
  mergeNativeCoverage,
  completeHistoryRead,
  hasAppliedNewerHistory,
  type NativeCoverage,
  createHistoryPagination,
  historyPaginationCursor,
  recordLatestHistoryPage,
  publishSessionInvalidation,
  subscribeSessionInvalidation,
} from "@agentkib/conversation-state";
import { useSessionLive, type WarmSessionNavigation } from "./use-session-live";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type SetStateAction,
} from "react";
import {
  ApiError,
  isLegacyPreparedReceipt,
  matchesSettingsAck,
  isSessionSettingsAction,
  WebClient,
  mergeCatalogSessions,
  isStaleCatalogRead,
  retryStaleCatalogRead,
  type ConversationCatalog,
  type Access,
  type WebConnection,
  type SessionAction,
  type SessionActionBody,
  type Approval,
  type ConversationEvent,
  type ConversationEventPage,
  type ConversationSessionSummary,
  type ConversationWorkspaceSummary,
  type Live,
  type UserQuestionRequest,
} from "@agentkib/web-client";
import type { InteractionLocale as Locale } from "../../interaction-model";
import type { SessionPlatform } from "../../session-platform";
import type { createSessionImageScope } from "./session-image-scope";

type ForkNavigation = {
  sourceId: string;
  generation: number;
  accessBinding: string;
  runtimeBootId?: string;
  requestId?: string;
  childId?: string;
  resolve: (id: string | undefined) => void;
  completion?: Promise<string | undefined>;
};
type SettingsTarget = ReturnType<typeof settingsNoticeGroup>;
export type SettingsNotice = {
  group?: SettingsTarget;
  target?: SettingsTarget;
  sessionId?: string;
  scope?: string;
  status: "writing" | "uncertain" | "notDispatched";
  reason?: string;
};
type SettingsFeedback = {
  scope: string;
  sessionId: string;
  requestId?: string;
  target: SettingsTarget;
  status: SettingsNotice["status"];
  reason?: string;
};

type CatalogStatus = "loading" | "ready" | "error";
type ControllerWords = Readonly<Record<string, string>> &
  Parameters<typeof unavailableReasonText>[1];

type ControllerBindings<Words extends ControllerWords> = {
  usePlatform(client: WebClient): SessionPlatform;
  words(locale: Locale): Words;
  sessionImages: ReturnType<typeof createSessionImageScope>;
  displaySessionTitle(title: string | null | undefined, untitled: string): string;
  isSessionListed(session: ConversationSessionSummary, visibility: { execution: boolean }): boolean;
};

export type SessionOptions = {
  origin?: string;
  connection?: WebConnection;
  disconnect?: () => void;
  initialLocale?: Locale;
  initialTheme?: string;
  initialSessionId?: string;
  readInitialCatalog?: (sessionId: string) => ConversationCatalog | undefined;
  client?: WebClient;
  embedded?: boolean;
  /** Also list and open program-started sessions (the directory option). */
  showExecution?: boolean;
};

export function useSessionController<Words extends ControllerWords>(
  {
    origin: legacyOrigin = "",
    connection,
    disconnect,
    initialLocale = "zh-CN",
    initialTheme = "system",
    initialSessionId,
    readInitialCatalog,
    client: providedClient,
    embedded = false,
    showExecution: controlledShowExecution,
  }: SessionOptions,
  {
    usePlatform,
    words,
    sessionImages,
    displaySessionTitle,
    isSessionListed,
  }: ControllerBindings<Words>,
) {
  const [historySearchOpen, setHistorySearchOpen] = useState(false);
  const [historyReferences, publishHistoryReferences] = useState<ResolvedHistoryReference[]>([]);
  const historyReferencesValue = useRef<ResolvedHistoryReference[]>([]);
  const setHistoryReferences = useCallback((references: ResolvedHistoryReference[]) => {
    historyReferencesValue.current = references;
    publishHistoryReferences(references);
  }, []);
  const [capabilitiesEpoch, setCapabilitiesEpoch] = useState(0);
  const [client] = useState(
    () => providedClient ?? new WebClient(undefined, connection ?? legacyOrigin),
  );
  const { kind: surface, retention: platformRetention } = usePlatform(client);
  const desktop = surface === "desktop";
  const { warmStreams, window: retention } = platformRetention.useSessionRetention(client);
  const verifiedWindowRevision = useRef<number | undefined>(undefined);
  const selectedWindowRevision = useRef<number | undefined>(undefined);
  const canRetainPage = useCallback(
    () => !retention || selectedWindowRevision.current === retention.revision,
    [retention],
  );
  const warmNavigation = useRef<WarmSessionNavigation>({});
  const [selectionVisit, setSelectionVisit] = useState(0);
  const initialCatalog = useRef(() =>
    initialSessionId ? readInitialCatalog?.(initialSessionId) : undefined,
  );
  const [streamEpoch, setStreamEpoch] = useState(() => retention?.streamEpoch ?? 0);
  const renewStream = useCallback(() => {
    if (retention) {
      warmStreams.discardParked();
      setStreamEpoch(++retention.streamEpoch);
    } else setStreamEpoch((value) => value + 1);
  }, [retention, warmStreams]);
  const [usageEpoch, setUsageEpoch] = useState("");
  const [liveContentVersion, setLiveContentVersion] = useState(0);
  const [catalogObservationFailed, setCatalogObservationFailed] = useState(false);
  const retryCatalogObservation = useRef<(() => void) | undefined>(undefined);
  const catalogInvalidationRead = useRef<(() => Promise<void>) | undefined>(undefined);
  const liveDelivery = useRef(0);
  const streamReady = useRef(false);
  const activeReceipts = useRef(
    new Map<string, { scope: string; generation: number; bootId?: string }>(),
  );
  const settingsInFlight = useRef<
    | {
        sessionId: string;
        generation: number;
        requestId: string;
        runtimeBootId: string | undefined;
        expectedRevision: number;
        controlChanged?: boolean;
      }
    | undefined
  >(undefined);
  const readSettingsControls = useRef<
    ((sessionId: string, accept?: (live: Live) => boolean) => Promise<void>) | undefined
  >(undefined);
  const controlReconciliationPending = useRef(false);
  const nativeCoverage = useRef<NativeCoverage>({
    items: [],
    authoritativeTurnIds: [],
    removedTurnIds: [],
  });
  const origin = client.origin;
  const isLan = client.connection.type === "lan-http";
  const [locale, setLocale] = useState<Locale>(initialLocale),
    [theme, setTheme] = useState(initialTheme),
    [accent, setAccent] = useState("blue");
  const t = words(locale);
  const c = catalogCopy[locale];
  const [access, setAccess] = useState<Access>(),
    [sessions, setSessions] = useState<ConversationSessionSummary[]>([]),
    [excludedSessionIds, setExcludedSessionIds] = useState<ReadonlySet<string>>(new Set()),
    [catalogNotice, setCatalogNotice] = useState(false),
    [catalogStatus, setCatalogStatus] = useState<CatalogStatus>("loading"),
    [workspaces, setWorkspaces] = useState<ConversationWorkspaceSummary[]>(),
    [selected, setSelected] = useState(""),
    [{ page, historyDetailTurnId }, publishPage] = useState<{
      page?: ConversationEventPage;
      historyDetailTurnId?: string;
    }>({}),
    [loadingEarlier, setLoadingEarlier] = useState(false),
    [live, publishLive] = useState<Live>(),
    [controlReady, publishControlReady] = useState(false),
    [indexEnabled, setIndexEnabled] = useState(true),
    [busy, setBusy] = useState(false),
    [savingSettingsFor, setSavingSettingsFor] = useState<string>(),
    [error, setError] = useState(false),
    [pairingError, setPairingError] = useState<string>(),
    [incompatible, setIncompatible] = useState(false),
    [connectionNotice, setConnectionNotice] = useState<{
      online: boolean;
      notice?: ControlNotice;
      reason?: NotDispatchedReason;
      source?: ControlKind;
    }>({ online: false }),
    [code, setCode] = useState(""),
    [name, setName] = useState(""),
    [message, publishMessage] = useState(""),
    [modal, setModal] = useState<
      "preferences" | "metadata" | ConversationEvent | Approval | UserQuestionRequest
    >();
  const controlReadyRef = useRef(false);
  const setMessage = useCallback(
    (text: string) => {
      const id = selection.current;
      if (id && canRetainPage()) retention?.setDraft(id, text);
      publishMessage(text);
    },
    [canRetainPage, retention],
  );
  const setControlReady = useCallback((next: SetStateAction<boolean>) => {
    controlReadyRef.current = typeof next === "function" ? next(controlReadyRef.current) : next;
    publishControlReady(controlReadyRef.current);
  }, []);
  const warmScope = warmSessionAuthority(access, streamEpoch);
  useEffect(
    () => (retention ? undefined : () => warmStreams.clear()),
    [retention, warmStreams, warmScope],
  );
  const selectedAgent = sessions.find((item) => item.id === selected)?.agent;
  const { capabilities, capabilityScope, verifyCapabilities, clearCapabilities } =
    useSessionCapabilities({
      client,
      selected,
      agent: selectedAgent,
      access,
      live,
      epoch: capabilitiesEpoch,
    });
  const [settingsIntentBinding, setSettingsIntentBinding] = useState("");
  const settingsBinding = capabilityScope;
  const settingsChangedHere = !!settingsBinding && settingsIntentBinding === settingsBinding;
  const [settingsFeedback, setSettingsFeedback] = useState<SettingsFeedback>();
  const [actionUnavailable, setActionUnavailable] = useState<{ binding: string; reason: string }>();
  const actionUnavailableReason =
    actionUnavailable?.binding === settingsBinding ? actionUnavailable.reason : undefined;
  const entryNotice = useRef<{ sessionId: string; ignoredId?: string } | undefined>(undefined);
  const liveValue = useRef<Live | undefined>(undefined);
  const setLive = useCallback(
    (value: SetStateAction<Live | undefined>, display?: Live) => {
      let next = typeof value === "function" ? value(liveValue.current) : value;
      sessionImages.noteSessionImageBoot(client, next?.runtimeBootId);
      if (!next) entryNotice.current = undefined;
      else {
        if (entryNotice.current?.sessionId !== next.sessionId)
          entryNotice.current = {
            sessionId: next.sessionId,
            ...(next.continuationNotice === "background-ended"
              ? { ignoredId: next.continuationNoticeId ?? "legacy" }
              : {}),
          };
        // Another client may still observe this session. Its earlier retirement notice is
        // not an event in this visit; a later retirement has a different identity and shows.
        if (
          next.continuationNotice === "background-ended" &&
          entryNotice.current.ignoredId === (next.continuationNoticeId ?? "legacy")
        )
          next = { ...next, continuationNotice: null };
      }
      liveValue.current = next;
      publishLive(next);
      retention?.publishLive(canRetainPage() ? (display ?? next) : undefined);
    },
    [client, canRetainPage, retention, sessionImages],
  );
  const { online, notice, reason: noticeReason, source: noticeSource } = connectionNotice;
  const setNotice = useCallback(
    (notice?: ControlNotice, reason?: NotDispatchedReason, source?: ControlKind) => {
      setConnectionNotice((value) => ({
        ...value,
        notice,
        reason: notice === "notDispatched" ? reason : undefined,
        source: notice ? source : undefined,
      }));
    },
    [],
  );
  const setOnline = useCallback(
    (next: SetStateAction<boolean>) => {
      if (next === false) retention?.publishLive(undefined);
      setConnectionNotice((value) => {
        const online = typeof next === "function" ? next(value.online) : next;
        return { ...value, online, reason: online ? value.reason : undefined };
      });
    },
    [retention],
  );
  const generation = useRef(0);
  const earlierFlight = useRef<EarlierHistoryFlight>(undefined);
  const pageValue = useRef<ConversationEventPage | undefined>(undefined);
  const setPage = useCallback((update: SetStateAction<ConversationEventPage | undefined>) => {
    // History and pagination are one accepted projection. Resolve updates once
    // against the latest page, before publishing React state; React may replay
    // state updaters, which must not consume pagination tickets or reset coverage.
    const next = typeof update === "function" ? update(pageValue.current) : update;
    pageValue.current = next;
    const coverage = nativeCoverage.current;
    const pagination = coverage.historyPagination;
    const pending = earlierFlight.current;
    if (
      pending &&
      (pending.generation !== generation.current ||
        pending.pagination !== pagination ||
        pending.cacheEpoch !== coverage.historyCacheEpoch)
    ) {
      earlierFlight.current = undefined;
      setLoadingEarlier(false);
    }

    const detailTurnId = pagination && oldestIncompleteHistoryTurn(next, pagination);
    publishPage((state) =>
      state.page === next && state.historyDetailTurnId === detailTurnId
        ? state
        : { page: next, historyDetailTurnId: detailTurnId },
    );
  }, []);
  // Reopening a recent session shows cached history while its fresh read runs. Retention is
  // bounded by bytes as well as count; the current reader still owns its complete history.
  const [pageCache] = useState(
    () => retention?.pageCache ?? createTranscriptPageCache<ConversationEventPage>(),
  );
  useEffect(() => {
    if (!selected || !page || !canRetainPage()) return;
    pageCache.set(selected, page);
  }, [selected, page, pageCache, canRetainPage]);
  const parkSelectedSession = useCallback(() => {
    const id = selection.current;
    const page = pageValue.current;
    if (!id || !page || !controlReadyRef.current || earlierFlight.current || !canRetainPage())
      return;
    pageCache.set(id, page);
    warmNavigation.current.park?.();
  }, [pageCache, canRetainPage]);
  // Route teardown must park the stream before its passive subscription cleanup.
  useLayoutEffect(() => {
    if (!retention) return;
    return () => {
      parkSelectedSession();
      retention.publishLive(undefined);
    };
  }, [retention, parkSelectedSession]);
  const catalogSessions = useRef<ConversationSessionSummary[]>([]);
  // The last accepted catalog, so the program-started sessions option can re-filter it.
  const catalogRecords = useRef<ConversationSessionSummary[] | undefined>(undefined);
  const [ownShowExecution, setShowExecution] = useState(false);
  // A host that owns the directory option passes it in; the Web catalog keeps its own.
  const showExecution = controlledShowExecution ?? ownShowExecution;
  const showExecutionValue = useRef(showExecution);
  const excludedIds = useRef<ReadonlySet<string>>(new Set());
  // Manual refresh and catalog notifications share this order. An older
  // response cannot undo a newer directory classification or dispatch guard.
  const catalogReadOrder = useRef(0);
  const readableSessionIds = useRef(new Set<string>());
  useEffect(() => {
    const readable = sessions.filter((session) => session.availability === "readable");
    readableSessionIds.current = new Set(readable.map((session) => session.id));
    setPendingSessions((previous) => {
      // These are derived interaction badges, separate from durable unknown
      // command receipts. Missing summaries retain only still-readable entries.
      const next: Record<string, boolean> = {};
      for (const session of readable) {
        const pending = session.pendingInteraction ?? previous[session.id];
        if (typeof pending === "boolean") next[session.id] = pending;
      }
      return next;
    });
  }, [sessions]);
  const receipt = useRef<
    { sessionId: string; requestId: string; turnId?: string; observedActive: boolean } | undefined
  >(undefined);
  const [pendingSessions, setPendingSessions] = useState<Record<string, boolean>>({});
  const [pendingSend, setPendingSend] = useState<{
    sessionId: string;
    text: string;
    afterEventId?: string;
  }>();
  const continuationDraft = useRef<
    | {
        sessionId: string;
        generation: number;
        draft: ContinuationDraft;
      }
    | undefined
  >(undefined);
  const takeContinuationDraft = useCallback((sessionId: string) => {
    const pending = continuationDraft.current;
    if (
      !pending ||
      pending.sessionId !== sessionId ||
      selection.current !== sessionId ||
      pending.generation !== generation.current
    )
      return;
    continuationDraft.current = undefined;
    return pending.draft;
  }, []);
  const continuationCheck = useRef({
    sessionId: "",
    generation: -1,
    at: 0,
    pending: false,
    promise: undefined as Promise<void> | undefined,
  });
  const selection = useRef(""),
    accessRef = useRef<Access | undefined>(undefined),
    scroll = useRef<HTMLElement>(null),
    mutating = useRef(false);
  const earlierAnchor = useRef<{ scope: EarlierHistoryFlight; restore: () => void }>(undefined);
  useLayoutEffect(() => {
    const anchor = earlierAnchor.current;
    earlierAnchor.current = undefined;
    anchor?.restore();
  }, [page, selected]);
  const imageRequestVersion = useCallback(() => generation.current, []);
  const forkNavigation = useRef<ForkNavigation | undefined>(undefined);
  const cancelForkNavigation = useCallback(() => {
    forkNavigation.current?.resolve(undefined);
    forkNavigation.current = undefined;
  }, []);
  const observeForkNavigation = useCallback(() => {
    const intent = forkNavigation.current;
    if (!intent) return;
    if (
      intent.sourceId !== selection.current ||
      intent.generation !== generation.current ||
      intent.accessBinding !== capabilityAccessBinding(accessRef.current) ||
      (intent.runtimeBootId !== undefined &&
        intent.runtimeBootId !== liveValue.current?.runtimeBootId)
    ) {
      cancelForkNavigation();
      return;
    }
    if (intent.childId && excludedIds.current.has(intent.childId)) intent.resolve(undefined);
    else if (
      intent.childId &&
      catalogSessions.current.some(
        (session) => session.id === intent.childId && session.availability === "readable",
      )
    )
      intent.resolve(intent.childId);
  }, [cancelForkNavigation]);
  useEffect(observeForkNavigation, [live?.runtimeBootId, observeForkNavigation]);
  useEffect(() => cancelForkNavigation, [cancelForkNavigation]);
  const durableScope = useRef<string | undefined>(undefined);
  const durablePending = useRef<PendingControl[]>([]);
  const selectedSettingsFeedback =
    settingsFeedback?.scope === durableScope.current &&
    settingsFeedback?.sessionId === selected &&
    (desktop || (!!selected && access?.status === "approved"))
      ? settingsFeedback
      : undefined;
  const selectedSettingsNotice = useMemo<SettingsNotice | undefined>(() => {
    if (!selectedSettingsFeedback) return undefined;
    const { target, status, reason, sessionId, scope } = selectedSettingsFeedback;
    return desktop
      ? { group: target, status, reason }
      : { target, status, reason, sessionId, scope };
  }, [desktop, selectedSettingsFeedback]);
  const awaitsReceiptResponse = useCallback((requestId: string) => {
    const active = activeReceipts.current.get(requestId);
    return (
      !!active &&
      active.scope === durableScope.current &&
      active.generation === generation.current &&
      active.bootId === accessRef.current?.bootId
    );
  }, []);
  const isSettingsWriteActive = useCallback(
    (id: string) => {
      const active = settingsInFlight.current;
      return !!active && active.sessionId === id && awaitsReceiptResponse(active.requestId);
    },
    [awaitsReceiptResponse],
  );
  const pendingForLive = useCallback(
    (id: string) =>
      durablePending.current.some(
        (pending) =>
          pending.sessionId === id &&
          (!isSessionSettingsAction(pending.kind) || !awaitsReceiptResponse(pending.requestId)),
      ),
    [awaitsReceiptResponse],
  );
  const hasDurablePending = useCallback(
    (id: string) =>
      desktop
        ? pendingForLive(id)
        : durablePending.current.some((pending) => pending.sessionId === id),
    [desktop, pendingForLive],
  );
  const refreshRequired = useRef(false);
  const manualRefreshRequired = useRef(false);
  const readinessEpoch = useRef(0);
  const refreshWake = useRef(0);
  const readContention = useRef({ version: 0, wake: 0 });
  const refreshFlight = useRef<{ generation: number; readiness: number } | undefined>(undefined);
  const deferredRefresh = useRef<
    | {
        generation: number;
        readiness: number;
        sessionId: string;
        resume: () => void;
      }
    | undefined
  >(undefined);
  const resumeDeferredRefresh = useCallback(() => {
    const pending = deferredRefresh.current;
    if (!pending) return;
    deferredRefresh.current = undefined;
    if (
      pending.generation === generation.current &&
      pending.readiness === readinessEpoch.current &&
      pending.sessionId === selection.current &&
      accessRef.current?.status === "approved" &&
      accessRef.current.protocolVersion === 2
    )
      pending.resume();
  }, []);
  const wakeDeferredRefresh = useCallback(() => {
    refreshWake.current++;
    resumeDeferredRefresh();
  }, [resumeDeferredRefresh]);
  const uncertainOutcomes = useRef(new Set<string>());
  const accessEpoch = useRef(0);
  const accessFlight = useRef<Promise<Access | undefined> | undefined>(undefined);
  useAppearance(locale, theme, accent, !embedded);
  const clear = useCallback(() => {
    warmStreams.clear();
    retention?.clearPresentation();
    warmNavigation.current.resume = undefined;
    cancelForkNavigation();
    generation.current++;
    readinessEpoch.current++;
    selection.current = "";
    setSelected("");
    setSessions([]);
    catalogSessions.current = [];
    catalogRecords.current = undefined;
    excludedIds.current = new Set();
    setExcludedSessionIds(excludedIds.current);
    setCatalogNotice(false);
    if (!desktop) setCatalogStatus("loading");
    setWorkspaces(undefined);
    setPage(undefined);
    setLive(undefined);
    clearCapabilities();
    setModal(undefined);
    setMessage("");
    continuationDraft.current = undefined;
    setPendingSend(undefined);
    setHistoryReferences([]);
    setHistorySearchOpen(false);
    setNotice(undefined);
    setSettingsFeedback(undefined);
    receipt.current = undefined;
    setPendingSessions({});
    setCode("");
    setName("");
    setOnline(false);
    setControlReady(false);
    setCatalogObservationFailed(false);
    pageCache.clear();
    streamReady.current = false;
    nativeCoverage.current = { items: [], authoritativeTurnIds: [], removedTurnIds: [] };
    refreshRequired.current = false;
    manualRefreshRequired.current = false;
    deferredRefresh.current = undefined;
    uncertainOutcomes.current.clear();
    durableScope.current = undefined;
    durablePending.current = [];
  }, [
    setLive,
    setPage,
    setHistoryReferences,
    setMessage,
    setNotice,
    setOnline,
    clearCapabilities,
    cancelForkNavigation,
    warmStreams,
    pageCache,
    retention,
    desktop,
    setControlReady,
  ]);
  const clearEndedImageAccess = useCallback(() => {
    sessionImages.invalidateSessionImages(client);
    clear();
  }, [client, clear, sessionImages]);
  const disconnectImages = useCallback(() => {
    sessionImages.invalidateSessionImages(client);
    disconnect?.();
  }, [client, disconnect, sessionImages]);
  const leaveSession = useCallback(() => {
    parkSelectedSession();
    warmNavigation.current.resume = undefined;
    cancelForkNavigation();
    // On Web, an empty directory can mount before its initial catalog resolves.
    if (desktop || selection.current) {
      generation.current++;
      readinessEpoch.current++;
    }
    if (desktop) continuationDraft.current = undefined;
    selection.current = "";
    deferredRefresh.current = undefined;
    streamReady.current = false;
    setSelected("");
    setNotice(undefined);
    if (!desktop) setSettingsFeedback(undefined);
    setHistoryReferences([]);
    setHistorySearchOpen(false);
    setPage(undefined);
    setLive(undefined);
    clearCapabilities();
    setModal(undefined);
    setControlReady(false);
    setOnline(false);
  }, [
    setLive,
    setPage,
    setHistoryReferences,
    setNotice,
    setOnline,
    clearCapabilities,
    cancelForkNavigation,
    parkSelectedSession,
    desktop,
    setControlReady,
  ]);
  const acceptCatalog = useCallback(
    (
      records: ConversationSessionSummary[],
      snapshot?: Pick<ConversationCatalog, "complete" | "incompleteSources">,
    ) => {
      const previous = catalogRecords.current;
      const readableEvidence = snapshot
        ? records.filter((record) => record.availability === "readable")
        : [];
      records = mergeCatalogSessions(
        previous ?? [],
        records,
        snapshot?.incompleteSources,
        snapshot?.complete === false && !snapshot.incompleteSources?.length,
      );
      // Web distinguishes an incomplete first snapshot from a usable directory.
      const usable =
        desktop || snapshot?.complete !== false || previous !== undefined || records.length > 0;
      const readable = new Set(
        records.filter((record) => record.availability === "readable").map((record) => record.id),
      );
      for (const record of previous ?? [])
        if (!readable.has(record.id)) {
          warmStreams.discardParked(record.id);
          sessionImages.forgetSessionImages(client, record.id);
        }
      for (const record of readableEvidence) sessionImages.restoreSessionImages(client, record.id);
      catalogRecords.current = usable ? records : undefined;
      const listed = (record: ConversationSessionSummary) =>
        isSessionListed(record, { execution: showExecutionValue.current });
      const excluded = new Set(records.filter((record) => !listed(record)).map((s) => s.id));
      const visible = records.filter(listed);
      // Update the dispatch guard before publishing React state. A callback from
      // the previous render must not reopen a record the new catalog excludes.
      excludedIds.current = excluded;
      catalogSessions.current = visible;
      observeForkNavigation();
      setExcludedSessionIds(excluded);
      setSessions(visible);
      if (!desktop) setCatalogStatus(usable ? "ready" : "loading");
      if (excluded.has(selection.current)) {
        leaveSession();
        setCatalogNotice(true);
      }
    },
    [
      client,
      leaveSession,
      observeForkNavigation,
      warmStreams,
      desktop,
      isSessionListed,
      sessionImages,
    ],
  );
  useEffect(() => {
    if (showExecutionValue.current === showExecution) return;
    showExecutionValue.current = showExecution;
    if (catalogRecords.current) acceptCatalog(catalogRecords.current);
  }, [showExecution, acceptCatalog]);
  const fail = useCallback(
    (e: unknown, g = generation.current) => {
      if (g !== generation.current) return;
      readinessEpoch.current++;
      if (
        e instanceof ApiError &&
        (e.status === 401 || e.status === 403 || e.code === "access_ended")
      )
        sessionImages.invalidateSessionImages(client);
      if (e instanceof ApiError && e.code === "access_ended") {
        if (isLan) client.reset();
        clear();
        const ended: Access = {
          status: "ended",
          csrfToken: "",
          bootId: "",
          experimentalEnabled: false,
        };
        accessRef.current = ended;
        setAccess(ended);
      } else if (e instanceof ApiError && e.code === "operation_busy") {
        // Reservation contention says nothing about connectivity. Keep readable
        // history, but require fresh access and live state before another control.
        refreshRequired.current = true;
        setControlReady(false);
      } else if (!(e instanceof DOMException && e.name === "AbortError")) {
        if (e instanceof ApiError && e.code === "incompatible_protocol") setIncompatible(true);
        setControlReady(false);
        setError(true);
        setOnline(false);
      }
    },
    [clear, client, isLan, setOnline, setControlReady, sessionImages],
  );
  const readHistory = useSessionHistoryRead({
    client,
    excludedIds,
    generation,
    selection,
    nativeCoverage,
    setError,
    fail,
  });
  const syncAccess = useCallback(
    (stillCurrent?: () => boolean) => {
      const g = generation.current;
      const epoch = ++accessEpoch.current;
      let imageRevision = sessionImages.sessionImageRevision(client);
      const flight = (async () => {
        for (let imageAttempt = 0; ; imageAttempt++) {
          const revision = retention?.revision;
          let next: Access;
          try {
            next = await sessionImages.readSessionImageAccess(client);
          } catch (error) {
            if (g !== generation.current) return;
            if (epoch !== accessEpoch.current) return accessFlight.current;
            if (stillCurrent && !stillCurrent()) return;
            throw error;
          }
          if (g !== generation.current) return;
          // A notification may require a newer access read while a full refresh is
          // pending. Its callers must finish using that accepted read, not abandon
          // the refresh and leave its control fence set indefinitely.
          if (epoch !== accessEpoch.current) return accessFlight.current;
          if (stillCurrent && !stillCurrent()) return;
          const imageScopeChanged = imageRevision !== sessionImages.sessionImageRevision(client);
          if (imageScopeChanged || revision !== retention?.revision) {
            if (imageAttempt >= 2) throw new DOMException("Access scope changed", "AbortError");
            imageRevision = sessionImages.sessionImageRevision(client);
            continue;
          }
          const old = accessRef.current;
          if (
            old &&
            (old.historySearchScope !== next.historySearchScope ||
              !next.device?.send ||
              !next.historySearch)
          ) {
            setHistoryReferences([]);
            setHistorySearchOpen(false);
          }
          if (
            old?.status === "approved" &&
            (next.status !== "approved" ||
              old.bootId !== next.bootId ||
              old.device?.id !== next.device?.id)
          )
            clear();
          if (next.status === "approved" && next.device?.id) {
            const scope = pendingScope(origin, next.device.id);
            if (durableScope.current !== scope) {
              const pending = readPending(scope);
              durableScope.current = scope;
              durablePending.current = pending;
            }
          }
          retention?.acceptAccess(next);
          verifiedWindowRevision.current =
            next.status === "approved" ? retention?.revision : undefined;
          sessionImages.acceptSessionImageAccess(client, next);
          accessRef.current = next;
          observeForkNavigation();
          if (isLan && next.status === "ended") client.reset();
          setAccess(next);
          return next;
        }
      })();
      accessFlight.current = flight;
      return flight;
    },
    [
      clear,
      client,
      origin,
      isLan,
      setHistoryReferences,
      observeForkNavigation,
      retention,
      sessionImages,
    ],
  );
  const reconcilePending = useCallback(
    async (sessionId?: string) => {
      const scope = durableScope.current;
      if (!scope) return;
      const epoch = readinessEpoch.current;
      const visit = generation.current;
      const currentReadiness = () =>
        scope === durableScope.current &&
        epoch === readinessEpoch.current &&
        visit === generation.current;
      const refreshOwnsReadiness = () =>
        refreshFlight.current?.generation === visit && refreshFlight.current.readiness === epoch;
      // Read again so other components sharing this tab's scope see the same fence.
      durablePending.current = readPending(scope);
      const pending = durablePending.current.filter(
        (entry) =>
          !["create", "adopt", "release", "reconcile"].includes(entry.kind) &&
          (!sessionId || entry.sessionId === sessionId),
      );
      let resolvedSelected: string | undefined;
      let resolvedSettings: string | undefined;
      let settingsRefusal: string | undefined;
      let resolvedSettingsRequest: string | undefined;
      for (const entry of pending) {
        // An awaited write is still in progress. Reconcile it after its response is lost,
        // or after its visit/runtime changes, rather than blocking on its own receipt.
        if (awaitsReceiptResponse(entry.requestId)) continue;
        const result = await readPendingControlReceipt(client, entry);
        if (scope !== durableScope.current) return;
        if (!result) continue;
        if (result.status !== "accepted" && result.status !== "not-dispatched") continue;
        const settingsWrite = settingsInFlight.current;
        const settings = isSessionSettingsAction(entry.kind);
        if (
          settings &&
          settingsWrite?.requestId === entry.requestId &&
          !isLegacyPreparedReceipt(result, entry.requestId) &&
          ((result.runtimeBootId &&
            settingsWrite.runtimeBootId &&
            result.runtimeBootId !== settingsWrite.runtimeBootId) ||
            (result.expectedRevision != null &&
              result.expectedRevision !== settingsWrite.expectedRevision))
        )
          continue;
        if (
          settings &&
          result.status === "accepted" &&
          (!entry.sessionId || !matchesSettingsAck(result.ack, entry.requestId, entry.sessionId))
        )
          continue;
        const intent = forkNavigation.current;
        if (entry.kind === "fork" && result.status === "accepted") {
          const childId = completedForkReceipt(
            result,
            entry,
            intent?.requestId === entry.requestId ? intent.runtimeBootId : undefined,
          );
          if (!childId) continue;
          if (intent?.requestId === entry.requestId) {
            intent.childId = childId;
            observeForkNavigation();
          }
        } else if (entry.kind === "fork" && intent?.requestId === entry.requestId)
          intent.resolve(undefined);
        forgetPending(scope, entry.requestId);
        durablePending.current = readPending(scope);
        if (!settings) uncertainOutcomes.current.delete(entry.sessionId ?? "");
        if (entry.sessionId === selection.current) {
          resolvedSelected = entry.sessionId;
          const reason =
            result.status === "not-dispatched" && !isLegacyPreparedReceipt(result, entry.requestId)
              ? codexSettingsRecoveryReason(
                  catalogSessions.current.find((session) => session.id === entry.sessionId)?.agent,
                  result.ack?.reason,
                  result.ack?.error,
                )
              : undefined;
          if (settings) {
            const id = entry.sessionId;
            resolvedSettings = id;
            resolvedSettingsRequest = entry.requestId;
            if (desktop) {
              const ack = "ack" in result ? result.ack : undefined;
              settingsRefusal =
                result.status === "not-dispatched"
                  ? (reason ?? ack?.reason ?? ack?.error ?? "request_failed")
                  : undefined;
            } else {
              setSettingsFeedback((previous) => {
                if (previous?.requestId && previous.requestId !== entry.requestId) return previous;
                return result.status === "accepted"
                  ? undefined
                  : {
                      sessionId: id,
                      scope,
                      requestId: entry.requestId,
                      target: previous?.sessionId === id ? previous.target : "settings",
                      status: "notDispatched",
                      reason,
                    };
              });
            }
            continue;
          }
          setNotice(result.status === "accepted" ? "accepted" : "notDispatched", reason);
          // A receipt confirms admission, never resolves or removes native approvals.
          if (result.status === "accepted")
            receipt.current = {
              sessionId: result.sessionId,
              requestId: entry.requestId,
              turnId: result.turnId ?? undefined,
              observedActive: entry.kind !== "send",
            };
        }
      }
      let readSettings = false;
      if (resolvedSettings && resolvedSettings === selection.current && currentReadiness()) {
        publishSessionInvalidation(client, resolvedSettings, ["settings"]);
        const write = settingsInFlight.current;
        if (
          !refreshOwnsReadiness() &&
          readSettingsControls.current &&
          (!write ||
            (write.requestId === resolvedSettingsRequest &&
              !awaitsReceiptResponse(write.requestId)))
        ) {
          refreshRequired.current = uncertainOutcomes.current.has(resolvedSettings);
          readSettings = true;
          await readSettingsControls.current(resolvedSettings);
        }
      }
      if (
        (desktop && (scope !== durableScope.current || epoch !== readinessEpoch.current)) ||
        (readSettings && !currentReadiness())
      )
        return;
      const id = selection.current;
      const selectedPending = durablePending.current.filter(
        (entry) => entry.sessionId === id && !awaitsReceiptResponse(entry.requestId),
      );
      const pendingSettings = selectedPending.find((entry) => isSessionSettingsAction(entry.kind));
      const pendingOther = selectedPending.some((entry) => !isSessionSettingsAction(entry.kind));
      if ((pendingSettings && (desktop || !pendingOther)) || (desktop && resolvedSettings === id)) {
        setSettingsFeedback((previous) => {
          const scoped = previous?.scope === scope && previous.sessionId === id;
          if (pendingSettings) {
            if (scoped && previous.status === "uncertain") return previous;
            return {
              scope,
              sessionId: id,
              requestId: pendingSettings.requestId,
              target: desktop && scoped ? previous.target : "settings",
              status: "uncertain",
            };
          }
          if (scoped && previous.requestId && previous.requestId !== resolvedSettingsRequest)
            return previous;
          return settingsRefusal
            ? {
                scope,
                sessionId: id,
                requestId: resolvedSettingsRequest,
                target: scoped ? previous.target : "settings",
                status: "notDispatched",
                reason: settingsRefusal,
              }
            : undefined;
        });
      }
      if (pendingOther) setNotice("uncertain");
      else if (!desktop && pendingSettings) setControlReady(false);
      else if (
        !readSettings &&
        (!resolvedSettings || !refreshOwnsReadiness()) &&
        resolvedSelected === id &&
        epoch === readinessEpoch.current &&
        accessRef.current?.protocolVersion === 2
      ) {
        refreshRequired.current = uncertainOutcomes.current.has(id);
        setControlReady(
          streamReady.current &&
            !controlReconciliationPending.current &&
            !refreshRequired.current &&
            (desktop ? !hasDurablePending(id) : liveValue.current?.status !== "outcome-unknown"),
        );
      }
    },
    [
      client,
      desktop,
      hasDurablePending,
      setNotice,
      observeForkNavigation,
      awaitsReceiptResponse,
      setControlReady,
    ],
  );
  const refresh = useCallback(
    async function refreshCurrent(
      manual = false,
      preserveHistory = false,
      initial = false,
    ): Promise<void> {
      if (!desktop) setCatalogStatus((previous) => (previous === "ready" ? previous : "loading"));
      if (manual) {
        setPairingError(undefined);
        retryCatalogObservation.current?.();
        setCapabilitiesEpoch((value) => value + 1);
      }
      let g = generation.current;
      const epoch = ++readinessEpoch.current;
      const wake = refreshWake.current;
      const contention = readContention.current.version;
      const flight = { generation: g, readiness: epoch };
      refreshFlight.current = flight;
      deferredRefresh.current = undefined;
      // Concurrent access notifications share their latest accepted read with
      // this refresh; the full refresh still owns clearing this control fence.
      refreshRequired.current = true;
      if (manual) manualRefreshRequired.current = true;
      setError(!!nativeCoverage.current.historyRecoveryFailed);
      setControlReady(false);
      let historyScope: { epoch?: string } | undefined;
      let catalogOrder: number | undefined;
      try {
        const next = await syncAccess();
        if (
          !next &&
          g === generation.current &&
          epoch === readinessEpoch.current &&
          accessRef.current?.status === "approved"
        ) {
          // A newer catalog access read may have been discarded with its stream.
          // This refresh still owns its fence: complete it with a fresh read.
          await refreshCurrent(manual, preserveHistory);
          return;
        }
        if (next?.status !== "approved") return;
        g = generation.current;
        flight.generation = g;
        const cached =
          desktop && initial && next.protocolVersion === 2 ? initialCatalog.current() : undefined;
        // The selected session reconciles its own receipts. The catalog observer
        // reconciles the rest after refreshing the shared directory.
        if (!cached) await reconcilePending(selection.current || undefined);
        if (g !== generation.current) return;
        catalogOrder = ++catalogReadOrder.current;
        const catalog =
          cached ?? (await retryStaleCatalogRead(() => retryBusyRead(() => client.catalog())));
        if (g !== generation.current) return;
        if (contention !== readContention.current.version)
          throw new ApiError(409, "operation_busy");
        if (catalogOrder === catalogReadOrder.current) {
          if (!catalog.indexEnabled) {
            sessionImages.setSessionImageIndexEnabled(client, false);
            clear();
            setIndexEnabled(false);
            return;
          }
          sessionImages.setSessionImageIndexEnabled(client, true);
          setIndexEnabled(true);
          acceptCatalog(catalog.sessions, catalog);
          setWorkspaces(catalog.workspaces);
        }
        // The full refresh still owns calibrating selected history and control
        // readiness when a notification superseded only its catalog response.
        const id = selection.current;
        if (id) {
          const viewport = scroll.current;
          const anchor =
            viewport &&
            Array.from(viewport.querySelectorAll<HTMLElement>("[data-event-id]")).find(
              (node) => node.getBoundingClientRect().bottom >= viewport.getBoundingClientRect().top,
            );
          const anchorId = anchor?.dataset.eventId;
          const anchorTop = anchor?.getBoundingClientRect().top;
          const delivered = liveDelivery.current;
          const historyCacheEpoch = nativeCoverage.current.historyCacheEpoch;
          historyScope = { epoch: historyCacheEpoch };
          // Render persisted history as soon as it arrives. Ownership and live
          // reconciliation still fence controls, but cannot delay readable rows.
          const historyPromise = readHistory(id, g, historyCacheEpoch).then((historyRead) => {
            if (
              g !== generation.current ||
              selection.current !== id ||
              historyCacheEpoch !== nativeCoverage.current.historyCacheEpoch ||
              contention !== readContention.current.version ||
              historyRead?.type !== "page"
            )
              return historyRead;
            const { page: history, attempt } = historyRead;
            const coverage = nativeCoverage.current;
            completeHistoryRead(nativeCoverage.current, attempt);
            if (epoch === readinessEpoch.current)
              setError(!!nativeCoverage.current.historyRecoveryFailed);
            setPage((previous) => {
              // A newer latest read owns its whole projection, not only its
              // cursor. A newer earlier-page read does not supersede this latest.
              if ((coverage.historyPagination?.latestReadOrder ?? 0) > attempt.id) return previous;
              // Admission contention does not invalidate loaded history. A
              // bounded latest page can begin with a history-only tool result,
              // so a missing overlap cannot justify dropping earlier pages.
              const merged = preserveHistory
                ? {
                    ...history,
                    events: mergeOrderedPersistedHistory(
                      previous?.events ?? [],
                      history.events,
                      coverage.historyPagination?.persisted.size ? "latest" : "older",
                      nativeCoverage.current.preserveItemsOutsideCoverage,
                    ),
                    warnings: [...new Set([...(previous?.warnings ?? []), ...history.warnings])],
                  }
                : mergeLatestPage(previous, history);
              // A read started before a native update must not replace its newer
              // item content or drop a reply appended while that read was pending.
              const result =
                delivered !== liveDelivery.current && previous
                  ? {
                      ...merged,
                      events: mergeConversationItems(
                        merged.events,
                        removePersistedOverlays(
                          previous.events,
                          history.events,
                          nativeCoverage.current.preserveItemsOutsideCoverage,
                        ),
                      ),
                    }
                  : {
                      ...merged,
                      events: mergeConversationItems(
                        merged.events,
                        removePersistedOverlays(
                          previous?.events.filter((item) => item.ephemeral) ?? [],
                          history.events,
                          nativeCoverage.current.preserveItemsOutsideCoverage,
                        ),
                      ),
                    };
              const retainedIds = new Set(result.events.map((item) => item.id));
              // Keep the old continuation when its displayed raw rows survive.
              // A disjoint/empty refresh can still replace static history, but
              // it must discard coverage for rows it removed at the same time.
              if (
                previous?.events.some(
                  (item) =>
                    coverage.historyPagination?.persisted.has(item.id) && !retainedIds.has(item.id),
                )
              )
                coverage.historyPagination = createHistoryPagination();
              const pagination = (coverage.historyPagination ??= createHistoryPagination());
              const nextCursor = recordLatestHistoryPage(pagination, history, attempt.id);
              return {
                ...result,
                next_cursor: nextCursor,
                events: mergeNativeCoverage(result.events, nativeCoverage.current),
              };
            });
            if (isLan && viewport && anchorId && anchorTop !== undefined)
              requestAnimationFrame(() => {
                if (g !== generation.current || selection.current !== id) return;
                const node = Array.from(
                  viewport.querySelectorAll<HTMLElement>("[data-event-id]"),
                ).find((node) => node.dataset.eventId === anchorId);
                if (node) viewport.scrollTop += node.getBoundingClientRect().top - anchorTop;
              });
            return historyRead;
          });
          const [historyRead, state] = await Promise.all([historyPromise, client.live(id)]);
          if (g !== generation.current || selection.current !== id) return;
          if (historyCacheEpoch !== nativeCoverage.current.historyCacheEpoch) {
            // A replaced cache requires a new calibration, never completion
            // using the old scope's live response or history. Only the refresh
            // still owning this fence may restart; newer controls remain fenced.
            if (epoch === readinessEpoch.current)
              await refreshCurrent(
                manual,
                preserveHistory || contention !== readContention.current.version,
              );
            return;
          }
          // A sibling read saw newer admission contention. Its busy response
          // cannot cancel recovery, but this older idle projection is not proof
          // that the command has settled either.
          if (contention !== readContention.current.version)
            throw new ApiError(409, "operation_busy");
          if (!historyRead) return;
          if (historyRead.type === "busy") throw historyRead.error;
          if (
            historyRead.type === "superseded" &&
            (epoch !== readinessEpoch.current ||
              !hasAppliedNewerHistory(nativeCoverage.current, historyRead.attempt))
          )
            return;
          if (delivered === liveDelivery.current) {
            checkLiveSession(state, id);
            setLive(state);
          }
          if (manual && next.protocolVersion === 2) renewStream();
        }
        setOnline(true);
        if (epoch === readinessEpoch.current) {
          if (manualRefreshRequired.current && !hasDurablePending(selection.current))
            uncertainOutcomes.current.delete(selection.current);
          setControlReady(
            streamReady.current &&
              !controlReconciliationPending.current &&
              next.protocolVersion === 2 &&
              !uncertainOutcomes.current.has(selection.current) &&
              !hasDurablePending(selection.current),
          );
          refreshRequired.current = uncertainOutcomes.current.has(selection.current);
          manualRefreshRequired.current = false;
        }
      } catch (e) {
        if (!historyScope || historyScope.epoch === nativeCoverage.current.historyCacheEpoch) {
          if ((e instanceof ApiError && e.code === "operation_busy") || isStaleCatalogRead(e)) {
            if (g !== generation.current || epoch !== readinessEpoch.current) return;
            // Only retry this read, under the fence it originally acquired. A
            // newer selection, refresh or uncertain control cancels its recovery.
            deferredRefresh.current = {
              generation: g,
              readiness: epoch,
              sessionId: selection.current,
              resume: () => void refreshCurrent(manual, true),
            };
            // Settlement may already have arrived while the busy response was
            // in transit. Consume that wakeup once; a repeated busy waits again.
            if (
              wake !== refreshWake.current ||
              (contention !== readContention.current.version &&
                readContention.current.wake !== refreshWake.current)
            )
              resumeDeferredRefresh();
          } else {
            if (
              !desktop &&
              !historyScope &&
              g === generation.current &&
              (catalogOrder === undefined || catalogOrder === catalogReadOrder.current) &&
              !(e instanceof DOMException && e.name === "AbortError")
            )
              setCatalogStatus((previous) => (previous === "ready" ? previous : "error"));
            fail(e, g);
          }
        } else if (g === generation.current && epoch === readinessEpoch.current)
          await refreshCurrent(
            manual,
            preserveHistory ||
              contention !== readContention.current.version ||
              (e instanceof ApiError && e.code === "operation_busy"),
          );
      } finally {
        if (refreshFlight.current === flight) refreshFlight.current = undefined;
      }
    },
    [
      syncAccess,
      fail,
      clear,
      client,
      isLan,
      reconcilePending,
      hasDurablePending,
      readHistory,
      resumeDeferredRefresh,
      setLive,
      setPage,
      setOnline,
      acceptCatalog,
      renewStream,
      desktop,
      sessionImages,
      setControlReady,
    ],
  );
  const readBusy = useCallback(
    (wake: number, g = generation.current) => {
      if (g !== generation.current || accessRef.current?.status !== "approved") return;
      readContention.current = { version: readContention.current.version + 1, wake };
      refreshRequired.current = true;
      setControlReady(false);
      const pending = deferredRefresh.current;
      if (pending?.generation === g && pending.readiness === readinessEpoch.current) {
        if (wake !== refreshWake.current) resumeDeferredRefresh();
        return;
      }
      const flight = refreshFlight.current;
      if (flight?.generation === g && flight.readiness === readinessEpoch.current) return;
      // A late busy response may arrive after settlement and a newer complete
      // read. Recover with a fresh read; repeated contention waits for an event.
      void refresh(false, true);
    },
    [refresh, resumeDeferredRefresh, setControlReady],
  );
  useEffect(
    () =>
      sessionImages.mountSessionImages(client, () => {
        void syncAccess().catch((error) => fail(error));
      }),
    [client, syncAccess, fail, sessionImages],
  );
  useEffect(() => {
    void refresh(false, false, true);
    return () => {
      generation.current++;
      deferredRefresh.current = undefined;
    };
  }, [refresh]);
  useEffect(() => {
    if (access?.status !== "pending") return;
    // Pending pairing precedes authenticated subscriptions. This checks only
    // the grant transition; conversation state always arrives as native events.
    const timer = setInterval(
      () =>
        void syncAccess()
          .then((next) => {
            if (next?.status === "approved") void refresh();
          })
          .catch((error) => fail(error)),
      4000,
    );
    return () => clearInterval(timer);
  }, [access?.status, syncAccess, refresh, fail]);
  useEffect(() => {
    if (access?.status !== "approved" || access.protocolVersion !== 2) return;
    const store = createConversationStore<Live>("");
    let closed = false;
    let resetPending = false;
    let exhausted = false;
    let resets = 0;
    let connectionEpoch = 0;
    let closeStream: (() => void) | undefined;
    const current = () =>
      !closed &&
      accessRef.current?.status === "approved" &&
      accessRef.current.protocolVersion === 2 &&
      accessRef.current.bootId === access.bootId &&
      accessRef.current.device?.id === access.device?.id;
    const resync = () => {
      if (!current() || resetPending || exhausted) return;
      resetPending = true;
      // Invalidate callbacks and pending reads before the adapter can deliver
      // more bootstrap events or readiness for this rejected stream.
      connectionEpoch++;
      queueMicrotask(() => {
        if (!current()) return;
        closeStream?.();
        closeStream = undefined;
        if (++resets > 3) {
          exhausted = true;
          setCatalogObservationFailed(true);
          if (!desktop) setCatalogStatus((previous) => (previous === "ready" ? previous : "error"));
          return;
        }
        store.reset();
        resetPending = false;
        connect();
      });
    };
    const connect = () => {
      const connection = ++connectionEpoch;
      const active = () =>
        current() && connection === connectionEpoch && !resetPending && !exhausted;
      // A replacement subscription owns its read queue, so a stalled old read
      // cannot delay the new baseline or overwrite its catalog when it resolves.
      let flight = false;
      let dirty = false;
      let retryAfterControl = false;
      const retryInvalidated = (g: number) => {
        if (
          !active() ||
          g === generation.current ||
          accessRef.current?.status !== "approved" ||
          accessRef.current.protocolVersion !== 2
        )
          return false;
        // Navigation invalidates reads, but does not consume a global catalog
        // notification. Re-read under the current generation and authorization.
        dirty = true;
        return true;
      };
      const update = async () => {
        if (!active()) return;
        if (flight) {
          dirty = true;
          return;
        }
        flight = true;
        do {
          dirty = false;
          let g = generation.current;
          let catalogOrder: number | undefined;
          try {
            const next = await syncAccess(active);
            if (!active()) break;
            if (!next) {
              if (retryInvalidated(g)) continue;
              break;
            }
            if (
              next.status !== "approved" ||
              accessRef.current?.status !== "approved" ||
              accessRef.current.protocolVersion !== 2
            )
              break;
            if (next !== accessRef.current) {
              dirty = true;
              continue;
            }
            // An accepted access response may clear the old runtime boot itself.
            // syncAccess rejects superseded reads; protect subsequent reads using
            // the generation belonging to this newly accepted access instead.
            g = generation.current;
            catalogOrder = ++catalogReadOrder.current;
            if (!desktop)
              setCatalogStatus((previous) => (previous === "ready" ? previous : "loading"));
            const catalog = await retryStaleCatalogRead(() =>
              retryBusyRead(() => client.catalog()),
            );
            if (!active()) break;
            if (g !== generation.current) {
              if (retryInvalidated(g)) continue;
              break;
            }
            if (catalogOrder !== catalogReadOrder.current) {
              dirty = true;
              continue;
            }
            if (!catalog.indexEnabled) {
              sessionImages.setSessionImageIndexEnabled(client, false);
              clear();
              setIndexEnabled(false);
              break;
            }
            sessionImages.setSessionImageIndexEnabled(client, true);
            setIndexEnabled(true);
            acceptCatalog(catalog.sessions, catalog);
            setWorkspaces(catalog.workspaces);
            await reconcilePending();
            retryAfterControl = false;
            if (active() && g === generation.current)
              // Management receipts have their own consumer, including creation
              // without a selected session. Reconnects must reconcile those too.
              publishSessionInvalidation(client, "", ["receipts"]);
          } catch (error) {
            if (active() && !retryInvalidated(g)) {
              // Read contention is not an uncertain command outcome. Wait for a
              // settlement/catalog event without fencing the selected conversation.
              if (
                (error instanceof ApiError && error.code === "operation_busy") ||
                isStaleCatalogRead(error)
              )
                retryAfterControl = true;
              else {
                if (
                  !desktop &&
                  g === generation.current &&
                  (catalogOrder === undefined || catalogOrder === catalogReadOrder.current) &&
                  !(error instanceof DOMException && error.name === "AbortError")
                )
                  setCatalogStatus((previous) => (previous === "ready" ? previous : "error"));
                fail(error, g);
              }
            }
          }
        } while (dirty && active());
        flight = false;
      };
      catalogInvalidationRead.current = update;
      closeStream = client.stream("", {
        open: () => {
          if (!active()) return;
          wakeDeferredRefresh();
          void update();
        },
        error: (error) => {
          if (!active()) return;
          if (error instanceof ApiError && error.code === "incompatible_protocol")
            setIncompatible(true);
          // Native EventSource does not expose HTTP 401/403. Recheck access on
          // failed reconnect so an expired grant clears the retained private view.
          else void update();
        },
        event: (type, data) => {
          if (!active()) return false;
          if (type === "access-ended") {
            fail(new ApiError(401, "access_ended"));
            return;
          }
          if (type === "control-changed") {
            try {
              const changed = JSON.parse(data) as { sessionId?: string };
              wakeDeferredRefresh();
              // Settlement can arrive before the busy response. Mark an in-flight
              // read dirty as well so that notification is not consumed too early.
              if (retryAfterControl || flight) void update();
              if (!selection.current || changed.sessionId !== selection.current)
                publishSessionInvalidation(client, "", ["receipts"]);
            } catch {
              setError(true);
            }
            return;
          }
          if (type === "session-ready") {
            try {
              const ready = JSON.parse(data) as { cursor?: string };
              const state = store.getSnapshot();
              if (state.cursor && state.cursor === ready.cursor && !state.resyncRequired) {
                // A baseline alone cannot reset the failure limit: replay may
                // still contain a gap before the adapter announces readiness.
                resets = 0;
                setCatalogObservationFailed(false);
              }
            } catch {
              // Malformed readiness never proves observation has recovered.
            }
            return false;
          }
          if (["catalog-invalidated", "access-changed"].includes(type)) {
            if (type === "access-changed") warmStreams.discardParked();
            wakeDeferredRefresh();
            void update();
            return false;
          }
          if (type !== "session-event") return false;
          try {
            const event = JSON.parse(data) as SessionStreamEvent<Live>;
            if (event.sessionId !== "") return false;
            const previous = store.getSnapshot();
            const state = store.dispatch(event);
            if (state.resyncRequired) {
              resync();
              return false;
            }
            const advanced =
              state.cursor !== previous.cursor ||
              state.seq !== previous.seq ||
              state.epoch !== previous.epoch ||
              state.runtimeBootId !== previous.runtimeBootId;
            if (advanced) {
              sessionImages.noteSessionImageBoot(client, state.runtimeBootId);
              wakeDeferredRefresh();
              if (
                event.type === "snapshot" ||
                (event.type === "invalidate" && event.payload.domains.includes("catalog"))
              )
                void update();
              if (event.type === "invalidate")
                publishSessionInvalidation(client, "", event.payload.domains);
            }
            // IPC ACKs are cumulative and may safely repeat the accepted cursor.
            // Rejected gaps and resync markers never acknowledge received data.
            return state.cursor ?? false;
          } catch {
            resync();
            return false;
          }
        },
      });
    };
    const retry = () => {
      if (!current() || !exhausted) return;
      exhausted = false;
      resetPending = false;
      resets = 0;
      store.reset();
      connect();
    };
    retryCatalogObservation.current = retry;
    connect();
    return () => {
      closed = true;
      catalogInvalidationRead.current = undefined;
      if (retryCatalogObservation.current === retry) retryCatalogObservation.current = undefined;
      closeStream?.();
    };
  }, [
    access?.status,
    access?.protocolVersion,
    access?.bootId,
    access?.device?.id,
    client,
    syncAccess,
    reconcilePending,
    clear,
    fail,
    wakeDeferredRefresh,
    acceptCatalog,
    warmStreams,
    desktop,
    sessionImages,
  ]);
  useEffect(
    () =>
      subscribeSessionInvalidation(client, (id, domains) => {
        // A native update can name an unselected row. Refresh its catalog
        // metadata without reloading history, rescanning or replaying a control.
        if (id && domains.includes("catalog")) void catalogInvalidationRead.current?.();
        if (id && id !== selection.current) return;
        if (domains.some((domain) => ["capabilities", "settings", "ownership"].includes(domain)))
          setCapabilitiesEpoch((value) => value + 1);
        if (domains.includes("receipts"))
          void reconcilePending(id || undefined).catch((error) => fail(error));
      }),
    [client, reconcilePending, fail],
  );
  useSessionLive({
    surface,
    settingsInFlight,
    isSettingsWriteActive,
    warmStreams,
    warmScope,
    warmNavigation,
    selectionVisit,
    liveValue,
    setLiveContentVersion,
    setUsageEpoch,
    streamReady,
    controlReconciliationPending,
    nativeCoverage,
    streamEpoch,
    liveDelivery,
    access,
    selected,
    selection,
    generation,
    client,
    fail,
    readBusy,
    refreshWake,
    clear: clearEndedImageAccess,
    accessRef,
    setLive,
    setOnline,
    setError,
    hasDurablePending: pendingForLive,
    readinessEpoch,
    refreshRequired,
    setControlReady,
    setAccess,
    setPage,
    readSettingsControls,
  });
  const choose = useCallback(
    async (id: string, initialDraft?: string) => {
      if (excludedIds.current.has(id)) {
        if (selection.current) leaveSession();
        setCatalogNotice(true);
        return;
      }
      if (selection.current === id) return;
      if (catalogSessions.current.find((session) => session.id === id)?.availability !== "readable")
        return;
      parkSelectedSession();
      warmNavigation.current.resume = undefined;
      cancelForkNavigation();
      generation.current++;
      continuationDraft.current = undefined;
      readinessEpoch.current++;
      // The new selection owns its baseline read. An obsolete refresh cannot
      // keep it fenced, while unknown outcomes remain attached to their session.
      refreshRequired.current = uncertainOutcomes.current.has(id);
      manualRefreshRequired.current = false;
      selection.current = id;
      setSelectionVisit(generation.current);
      setSelected(id);
      // Stamp the selection's authority. A later access check cannot give old
      // history permission to repopulate the cache after a boundary change.
      selectedWindowRevision.current = verifiedWindowRevision.current;
      nativeCoverage.current = { items: [], authoritativeTurnIds: [], removedTurnIds: [] };
      const cachedPage = canRetainPage() ? pageCache.get(id) : undefined;
      const scope = warmSessionAuthority(accessRef.current, streamEpoch);
      const pendingScope = durableScope.current;
      if (pendingScope) durablePending.current = readPending(pendingScope);
      const warm =
        cachedPage && scope && !refreshRequired.current && !hasDurablePending(id)
          ? warmStreams.peek(scope, id)
          : undefined;
      setPage(cachedPage);
      setLive(warm?.state.live, warm ? warmStreams.peekParkedLive(id) : undefined);
      setModal(undefined);
      setMessage(initialDraft ?? (canRetainPage() ? retention?.getDraft(id) : undefined) ?? "");
      setPendingSend(undefined);
      setHistoryReferences([]);
      setHistorySearchOpen(false);
      setNotice(undefined);
      setSettingsFeedback(undefined);
      setCatalogNotice(false);
      setOnline(!!warm);
      setControlReady(false);
      streamReady.current = false;
      setError(false);
      const g = generation.current;
      const readSelection = async () => {
        if (g !== generation.current || selection.current !== id) return;
        const wake = refreshWake.current;
        let historyScope: { epoch?: string } | undefined;
        try {
          const delivered = liveDelivery.current;
          const historyCacheEpoch = nativeCoverage.current.historyCacheEpoch;
          historyScope = { epoch: historyCacheEpoch };
          const epoch = readinessEpoch.current;
          const historyPromise = readHistory(id, g, historyCacheEpoch).then((historyRead) => {
            if (
              g !== generation.current ||
              selection.current !== id ||
              historyRead?.type !== "page"
            )
              return historyRead;
            const { page: history, attempt } = historyRead;
            if (historyCacheEpoch === nativeCoverage.current.historyCacheEpoch) {
              const pagination = (nativeCoverage.current.historyPagination ??=
                createHistoryPagination());
              // An older baseline can fill disjoint history, while a newer read
              // keeps its cursor, warnings and overlapping item contents.
              const newerHistory = (pagination.latestReadOrder ?? 0) > attempt.id;
              const nextCursor = recordLatestHistoryPage(pagination, history, attempt.id);
              completeHistoryRead(nativeCoverage.current, attempt);
              if (epoch === readinessEpoch.current)
                setError(!!nativeCoverage.current.historyRecoveryFailed);
              setPage((previous) => ({
                ...(newerHistory && previous ? previous : history),
                next_cursor: nextCursor,
                events: mergeNativeCoverage(
                  mergeConversationItems(
                    mergeOrderedPersistedHistory(
                      previous?.events ?? [],
                      history.events,
                      "older",
                      nativeCoverage.current.preserveItemsOutsideCoverage,
                    ),
                    removePersistedOverlays(
                      previous?.events ?? [],
                      history.events,
                      nativeCoverage.current.preserveItemsOutsideCoverage,
                    ),
                  ),
                  nativeCoverage.current,
                ),
              }));
            }
            return historyRead;
          });
          // History is available independently of native writes and their receipts.
          // Readiness still waits for reconciliation before enabling controls.
          const [historyRead, state] = await Promise.all([
            historyPromise,
            client.live(id),
            reconcilePending(id),
          ]);
          if (historyRead?.type === "busy") {
            readBusy(wake, g);
            return;
          }
          if (
            !historyRead ||
            historyRead.type !== "page" ||
            g !== generation.current ||
            historyCacheEpoch !== nativeCoverage.current.historyCacheEpoch ||
            epoch !== readinessEpoch.current
          )
            return;
          if (delivered === liveDelivery.current) {
            checkLiveSession(state, id);
            setLive(state);
          }
          setOnline(true);
          setControlReady(
            streamReady.current &&
              !controlReconciliationPending.current &&
              accessRef.current?.protocolVersion === 2 &&
              !refreshRequired.current &&
              !uncertainOutcomes.current.has(id) &&
              !hasDurablePending(id),
          );
        } catch (e) {
          if (!historyScope || historyScope.epoch === nativeCoverage.current.historyCacheEpoch) {
            if (e instanceof ApiError && e.code === "operation_busy") readBusy(wake, g);
            else fail(e, g);
          }
        }
      };
      if (warm) {
        warmNavigation.current.resume = {
          generation: g,
          onCold() {
            setLive(undefined);
            setOnline(false);
            void readSelection();
          },
        };
      } else await readSelection();
    },
    [
      client,
      fail,
      reconcilePending,
      hasDurablePending,
      readHistory,
      readBusy,
      setLive,
      setPage,
      setHistoryReferences,
      setMessage,
      setNotice,
      setOnline,
      leaveSession,
      cancelForkNavigation,
      parkSelectedSession,
      pageCache,
      canRetainPage,
      retention,
      streamEpoch,
      warmStreams,
      setControlReady,
    ],
  );
  async function post(path: string, body: unknown) {
    if (mutating.current) return;
    if (path.replace(/^\//, "") === "logout") sessionImages.invalidateSessionImages(client);
    mutating.current = true;
    setBusy(true);
    setError(!!nativeCoverage.current.historyRecoveryFailed);
    const g = generation.current;
    try {
      await client.request(path, body);
      if (g !== generation.current) return;
      await refresh();
    } catch (e) {
      fail(e, g);
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  async function pair(e: FormEvent) {
    e.preventDefault();
    if (mutating.current) return;
    mutating.current = true;
    setBusy(true);
    setError(!!nativeCoverage.current.historyRecoveryFailed);
    setPairingError(undefined);
    const g = generation.current;
    try {
      await client.request("pair", { code, name: name.trim() || "Web" });
      if (g !== generation.current) return;
      // The host consumed the code. A later status-refresh failure must not
      // invite resubmitting that one-time code as though pairing was rejected.
      setCode("");
      await refresh();
    } catch (e) {
      if (g !== generation.current) return;
      if (
        e instanceof ApiError &&
        (e.code === "access_ended" || e.code === "incompatible_protocol")
      )
        fail(e, g);
      else if (!(e instanceof DOMException && e.name === "AbortError"))
        setPairingError(e instanceof ApiError ? e.code : "request_failed");
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  const earlier = createEarlierSessionHistory({
    selected,
    busy,
    generation,
    selection,
    nativeCoverage,
    pageValue,
    earlierFlight,
    earlierAnchor,
    excludedIds,
    refreshWake,
    liveDelivery,
    scroll,
    readHistory,
    readBusy,
    setPage,
    setError,
    setLoadingEarlier,
    fail,
  });
  useEffect(() => {
    if (!live || live.sessionId !== selected) return;
    // A retained stream may still deliver after its catalog entry disappears.
    // It cannot recreate a badge outside the current readable directory.
    if (readableSessionIds.current.has(selected))
      setPendingSessions((previous) => ({
        ...previous,
        [selected]: live.approvals.length > 0 || !!live.questions?.length,
      }));
    const pendingReceipt = receipt.current;
    if (notice !== "accepted" || !pendingReceipt || pendingReceipt.sessionId !== selected) return;
    if (
      [
        "running",
        "awaiting-approval",
        "waiting-approval",
        "awaiting-input",
        "waiting-input",
      ].includes(live.status) &&
      live.turnId
    ) {
      if (!pendingReceipt.turnId || pendingReceipt.turnId === live.turnId) {
        pendingReceipt.turnId = live.turnId;
        pendingReceipt.observedActive = true;
      }
    } else if (
      live.status === "idle" &&
      pendingReceipt.observedActive &&
      (!live.turnId || live.turnId === pendingReceipt.turnId)
    ) {
      receipt.current = undefined;
      setNotice(undefined);
    }
  }, [live, selected, notice, setNotice]);
  const terminalBinding = useRef<
    { sessionId: string; mode?: string; generation?: string } | undefined
  >(undefined);
  const terminalPresent = !!live;
  const terminalMode = live?.executionMode;
  const terminalGeneration = live?.connectionGeneration;
  useEffect(() => {
    const previous = terminalBinding.current;
    terminalBinding.current = terminalPresent
      ? { sessionId: selected, mode: terminalMode, generation: terminalGeneration }
      : undefined;
    const changed =
      previous?.sessionId === selected &&
      (previous.mode === "claude-follower" || terminalMode === "claude-follower") &&
      (previous.mode !== terminalMode || previous.generation !== terminalGeneration);
    if (!changed && !(terminalMode === "claude-follower" && !online)) return;
    // A replaced executor invalidates its open forms. Draft quotes are revalidated on send.
    setModal(undefined);
    setHistorySearchOpen(false);
  }, [selected, terminalPresent, terminalMode, terminalGeneration, online]);
  useEffect(() => {
    if (!historyReferences.length) return;
    const abort = new AbortController();
    const expectedScope = access?.historySearchScope;
    let checking = false;
    const verify = async () => {
      if (checking) return;
      checking = true;
      try {
        const next = await client.access(abort.signal);
        if (abort.signal.aborted) return;
        if (
          next.status !== "approved" ||
          !next.historySearch ||
          !next.device?.send ||
          next.historySearchScope !== expectedScope
        ) {
          setHistoryReferences([]);
          setHistorySearchOpen(false);
          return;
        }
        await client.historyReferences(
          historyReferences.map((item) => item.reference),
          abort.signal,
        );
      } catch (error) {
        // A connection failure does not authorize another send, but it also does
        // not erase a user's draft. Definitive revocation/staleness removes quotes.
        if (
          !abort.signal.aborted &&
          error instanceof ApiError &&
          [400, 401, 403, 404, 409, 410].includes(error.status)
        ) {
          setHistoryReferences([]);
          setHistorySearchOpen(false);
        }
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void verify(), 5000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [historyReferences, access?.historySearchScope, client, selected, setHistoryReferences]);
  /**
   * Nothing of a deleted conversation can be read again. Fence it and drop its row until the
   * catalog, which the host invalidates, arrives without it. An open view leaves it.
   */
  function dropDeletedSession(id: string) {
    catalogReadOrder.current++;
    sessionImages.forgetSessionImages(client, id);
    excludedIds.current = new Set([...excludedIds.current, id]);
    catalogSessions.current = catalogSessions.current.filter((session) => session.id !== id);
    catalogRecords.current = catalogRecords.current?.filter((session) => session.id !== id);
    setExcludedSessionIds(excludedIds.current);
    setSessions(catalogSessions.current);
  }
  async function codexAction(
    action: SessionAction,
    fields: Omit<
      Partial<SessionActionBody>,
      "requestId" | "bootId" | "sessionId" | "expectedRevision"
    > = {},
  ) {
    const settingsAction = isSessionSettingsAction(action);
    if (
      mutating.current ||
      excludedIds.current.has(selected) ||
      selection.current !== selected ||
      !access ||
      !live ||
      (action !== "inspect" &&
        (live.status === "outcome-unknown" ||
          live.reason === "control-outcome-unconfirmed" ||
          capabilities?.reason === "control-outcome-unconfirmed")) ||
      (action !== "inspect" &&
        action !== "resume" &&
        (!online || (!controlReady && action !== "fork"))) ||
      capabilities?.sessionId !== selected ||
      !capabilities?.features[action]?.available ||
      (live.activity === "compacting" && blockedWhileCompacting(action)) ||
      (action !== "inspect" &&
        (uncertainOutcomes.current.has(selected) || hasDurablePending(selected)))
    )
      return;
    const scope = durableScope.current;
    if (!scope) return;
    mutating.current = true;
    const requestId = crypto.randomUUID();
    const id = selected;
    const g = generation.current;
    const accessBinding = capabilityAccessBinding(access);
    const settingsContext = settingsAction
      ? {
          sessionId: id,
          scope,
          requestId,
          target: action === "open-model-picker" ? ("model" as const) : settingsNoticeGroup(fields),
        }
      : undefined;
    const reportSettings = (status: SettingsNotice["status"], reason?: string) => {
      if (settingsContext) setSettingsFeedback({ ...settingsContext, status, reason });
    };
    const closeSettingsWrite = () => {
      if (desktop) setSavingSettingsFor(undefined);
      setSettingsFeedback((previous) =>
        previous?.scope === scope &&
        previous.sessionId === id &&
        previous.requestId === requestId &&
        previous.status === "writing"
          ? undefined
          : previous,
      );
    };
    if (settingsContext) {
      // A desktop window can revisit this session before its settings readback settles.
      if (desktop) setSavingSettingsFor(id);
      reportSettings("writing");
    } else {
      setBusy(true);
      setNotice(undefined);
      setActionUnavailable(undefined);
    }
    const forkIntent = action === "fork" ? forkNavigation.current : undefined;
    if (forkIntent?.sourceId === id && forkIntent.generation === g)
      forkIntent.requestId = requestId;
    if (action === "fork" && refreshRequired.current) {
      const occupancyRead = continuationCheck.current;
      await (occupancyRead.pending &&
      occupancyRead.sessionId === id &&
      occupancyRead.generation === g
        ? occupancyRead.promise
        : refresh(false, true));
    }
    const checked = await verifyCapabilities();
    if (
      g !== generation.current ||
      selection.current !== id ||
      capabilityAccessBinding(accessRef.current) !== accessBinding ||
      liveValue.current?.sessionId !== id ||
      liveValue.current?.status !== live.status ||
      (action !== "inspect" &&
        (liveValue.current?.status === "outcome-unknown" ||
          liveValue.current?.reason === "control-outcome-unconfirmed" ||
          checked?.reason === "control-outcome-unconfirmed")) ||
      (liveValue.current?.activity === "compacting" && blockedWhileCompacting(action)) ||
      !checked?.features[action]?.available ||
      (action === "fork" && !accessRef.current?.device?.manage) ||
      (action !== "inspect" &&
        (refreshRequired.current ||
          !streamReady.current ||
          uncertainOutcomes.current.has(id) ||
          hasDurablePending(id)))
    ) {
      if (g === generation.current && selection.current === id) {
        const outcomeUnknown =
          uncertainOutcomes.current.has(id) ||
          hasDurablePending(id) ||
          liveValue.current?.status === "outcome-unknown" ||
          liveValue.current?.reason === "control-outcome-unconfirmed" ||
          checked?.reason === "control-outcome-unconfirmed";
        // This fork never dispatched, but a concurrent receipt can still fence
        // the conversation. Do not replace that outcome with this local refusal.
        const reason =
          checked?.features[action]?.reason ?? checked?.reason ?? "session-state-unavailable";
        if (settingsContext && (!desktop || !outcomeUnknown))
          reportSettings("notDispatched", reason);
        else if (!settingsContext)
          setActionUnavailable(outcomeUnknown ? undefined : { binding: settingsBinding, reason });
        if (outcomeUnknown) {
          refreshRequired.current = true;
          setControlReady(false);
        }
        if (!settingsContext || outcomeUnknown)
          setNotice(outcomeUnknown ? "uncertain" : "notDispatched");
      }
      mutating.current = false;
      if (settingsContext) closeSettingsWrite();
      else setBusy(false);
      return;
    }
    if (action === "settings" && Object.keys(fields).length)
      setSettingsIntentBinding(settingsBinding);
    const sessionAgent = sessions.find((session) => session.id === id)?.agent;
    const perform = (body: SessionActionBody) =>
      dispatchSessionAction(client, sessionAgent, action, body);
    if (settingsContext) {
      const expectedRevision = live.revision ?? 0;
      const runtimeBootId = live.runtimeBootId;
      const entry = { requestId, sessionId: id, kind: action };
      const stillCurrent = () =>
        generation.current === g &&
        selection.current === id &&
        (desktop || !excludedIds.current.has(id)) &&
        durableScope.current === scope &&
        capabilityAccessBinding(accessRef.current) === accessBinding &&
        (runtimeBootId === undefined || liveValue.current?.runtimeBootId === runtimeBootId);
      const readBack = () =>
        readSettingsControls.current?.(
          id,
          (state) =>
            stillCurrent() &&
            (runtimeBootId === undefined || state.runtimeBootId === runtimeBootId) &&
            (state.status === "outcome-unknown" ||
              (typeof state.revision === "number" &&
                state.revision >=
                  (desktop
                    ? (liveValue.current?.revision ?? 0)
                    : Math.max(expectedRevision, liveValue.current?.revision ?? 0)))),
        );
      const finishPending = () => {
        forgetPending(scope, requestId);
        if (durableScope.current === scope) durablePending.current = readPending(scope);
      };
      const reconcileAfterEarlyChange = async () => {
        if (!settingsInFlight.current?.controlChanged || !stillCurrent()) return;
        activeReceipts.current.delete(requestId);
        await reconcilePending(id).catch((error) => fail(error, g));
      };
      settingsInFlight.current = { ...entry, generation: g, expectedRevision, runtimeBootId };
      activeReceipts.current.set(requestId, { scope, generation: g, bootId: access.bootId });
      try {
        try {
          rememberPending(scope, entry);
          durablePending.current = readPending(scope);
        } catch {
          if (desktop) throw new ApiError(409, "pending_storage_unavailable", "not-dispatched");
          if (stillCurrent()) reportSettings("notDispatched");
          return;
        }
        const outcome = await verifySettingsWrite({
          client,
          action,
          body: { ...fields, sessionId: id, bootId: access.bootId, expectedRevision, requestId },
          runtimeBootId,
          perform,
          stillCurrent,
          allowReceiptWithoutRuntime: desktop,
        });
        if (desktop && outcome.status !== "accepted") throw outcome.error;
        if (outcome.status === "unknown") {
          if (stillCurrent()) {
            setControlReady(false);
            reportSettings("uncertain");
            await reconcileAfterEarlyChange();
          }
          return;
        }
        finishPending();
        if (!stillCurrent()) return;
        if (outcome.status === "not-dispatched")
          reportSettings(
            "notDispatched",
            codexSettingsRecoveryReason(sessionAgent, ...outcome.reasons),
          );
        await readBack();
        if (!stillCurrent()) return;
        if (!desktop) setCapabilitiesEpoch((value) => value + 1);
        return outcome.status === "accepted" ? outcome.result : undefined;
      } catch (error) {
        if (!desktop) throw error;
        // The local host may report a settings change before the HTTP response is lost.
        // Keep the request identity until the extra receipt read has finished.
        activeReceipts.current.delete(requestId);
        const refusal =
          error instanceof ApiError && error.controlOutcome === "not-dispatched"
            ? error
            : undefined;
        if (refusal) finishPending();
        if (!stillCurrent()) return;
        const reason =
          refusal &&
          codexSettingsRecoveryReason(
            catalogSessions.current.find((session) => session.id === id)?.agent,
            refusal.code,
          );
        reportSettings(refusal ? "notDispatched" : "uncertain", reason ?? refusal?.code);
        if (!refusal) {
          setControlReady(false);
          refreshRequired.current = true;
        }
        await readBack();
        if (!refusal) await reconcileAfterEarlyChange();
        return;
      } finally {
        activeReceipts.current.delete(requestId);
        settingsInFlight.current = undefined;
        closeSettingsWrite();
        mutating.current = false;
      }
    }
    if (action === "inspect") {
      try {
        const result = await perform({
          sessionId: id,
          bootId: access.bootId,
          expectedRevision: live.revision ?? 0,
          requestId,
        });
        if (generation.current !== g) return;
        await refresh(true);
        return result;
      } catch {
        if (generation.current === g) setError(true);
        return;
      } finally {
        mutating.current = false;
        setBusy(false);
      }
    }
    try {
      try {
        rememberPending(scope, { requestId, sessionId: id, kind: action });
        durablePending.current = readPending(scope);
      } catch {
        throw new ApiError(409, "pending_storage_unavailable", "not-dispatched");
      }
      const result = await perform({
        ...fields,
        sessionId: id,
        bootId: access.bootId,
        expectedRevision: live.revision ?? 0,
        requestId,
      });
      forgetPending(scope, requestId);
      if (durableScope.current === scope) durablePending.current = readPending(scope);
      if (generation.current !== g) return;
      setNotice("accepted");
      if (["steer", "queue-add"].includes(action)) setHistoryReferences([]);
      if (action === "delete") dropDeletedSession(id);
      else if (action === "fork") void refresh(true);
      else await refresh(true);
      return result;
    } catch (error) {
      const refusal =
        error instanceof ApiError && error.controlOutcome === "not-dispatched" ? error : undefined;
      if (refusal) {
        forgetPending(scope, requestId);
        if (durableScope.current === scope) durablePending.current = readPending(scope);
      }
      if (generation.current === g) {
        const reason =
          refusal &&
          codexSettingsRecoveryReason(
            catalogSessions.current.find((session) => session.id === id)?.agent,
            refusal.code,
          );
        setNotice(refusal ? "notDispatched" : "uncertain", reason);
        setControlReady(false);
        refreshRequired.current = true;
        if (!refusal) uncertainOutcomes.current.add(id);
        if (action === "fork") void refresh(true);
        else await refresh(true);
      }
      return undefined;
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  const control = createSessionControl({
    client,
    access,
    live,
    online,
    controlReady,
    selected,
    capabilities,
    message,
    sessions,
    page,
    accessRef,
    liveValue,
    historyReferencesValue,
    generation,
    selection,
    readinessEpoch,
    refreshRequired,
    manualRefreshRequired,
    streamReady,
    catalogSessions,
    excludedIds,
    uncertainOutcomes,
    mutating,
    activeReceipts,
    durableScope,
    durablePending,
    receipt,
    verifyCapabilities,
    hasDurablePending,
    setBusy,
    setNotice,
    setControlReady,
    setPendingSend,
    setMessage,
    setHistoryReferences,
    setModal,
    setOnline,
    refresh,
    fail,
    historyMessageText,
    forgetPending,
    rememberPending,
    readPending,
  });
  const checkContinuation = useCallback(async () => {
    const id = selection.current;
    const prior = continuationCheck.current;
    if (
      !id ||
      (prior.pending && prior.sessionId === id && prior.generation === generation.current) ||
      mutating.current ||
      excludedIds.current.has(id) ||
      uncertainOutcomes.current.has(id) ||
      hasDurablePending(id) ||
      accessRef.current?.status !== "approved" ||
      accessRef.current.protocolVersion !== 2 ||
      !["codex", "claude-code"].includes(
        catalogSessions.current.find((item) => item.id === id)?.agent ?? "",
      ) ||
      (prior.sessionId === id &&
        prior.generation === generation.current &&
        Date.now() - prior.at < 4000)
    )
      return;
    const check = {
      sessionId: id,
      generation: generation.current,
      at: Date.now(),
      pending: true,
      promise: undefined as Promise<void> | undefined,
    };
    continuationCheck.current = check;
    try {
      check.promise = refresh(false, true);
      await check.promise;
    } finally {
      check.pending = false;
    }
  }, [refresh, hasDurablePending]);
  useEffect(() => {
    if (
      !online ||
      live?.sessionId !== selected ||
      ![
        "codex-owner-busy",
        "claude-owner-busy",
        "claude-background-session-running",
        "owner-opened-elsewhere",
      ].includes(live.ownershipReason || live.reason || "")
    )
      return;
    const timer = setInterval(() => void checkContinuation(), 4000);
    return () => clearInterval(timer);
  }, [online, selected, live?.sessionId, live?.ownershipReason, live?.reason, checkContinuation]);
  async function forkContinuation(composerDraft?: ContinuationComposerDraft) {
    const id = selected,
      g = generation.current,
      draft = message;
    const accessBinding = capabilityAccessBinding(accessRef.current);
    const prior = forkNavigation.current;
    if (prior?.sourceId === id && prior.generation === g && prior.accessBinding === accessBinding)
      return prior.completion;
    cancelForkNavigation();
    const historyDraft = [...historyReferencesValue.current];
    const files = [...(composerDraft?.files ?? [])];
    const resources = (composerDraft?.resources ?? []).map((item) => ({ ...item }));
    if (
      !["codex", "claude-code"].includes(
        catalogSessions.current.find((item) => item.id === id)?.agent ?? "",
      )
    )
      return;
    let resolve!: ForkNavigation["resolve"];
    const ready = new Promise<string | undefined>((done) => {
      resolve = done;
    });
    const intent: ForkNavigation = {
      sourceId: id,
      generation: g,
      accessBinding,
      runtimeBootId: liveValue.current?.runtimeBootId,
      resolve,
    };
    forkNavigation.current = intent;
    intent.completion = (async () => {
      const result = await codexAction("fork");
      if (result?.sessionId && result.sessionId !== id) {
        intent.childId = result.sessionId;
        observeForkNavigation();
      } else if (
        !intent.requestId ||
        !durablePending.current.some((entry) => entry.requestId === intent.requestId)
      )
        intent.resolve(undefined);
      // A late receipt settles this invocation without replaying its fork. Only
      // a confirmed child in the readable catalog can complete the navigation.
      const childId = await ready;
      if (
        !childId ||
        g !== generation.current ||
        selection.current !== id ||
        capabilityAccessBinding(accessRef.current) !== accessBinding ||
        (intent.runtimeBootId !== undefined &&
          intent.runtimeBootId !== liveValue.current?.runtimeBootId)
      )
        return;
      // Selection starts bounded reads; navigation need not wait for them. Their
      // selected generation still protects eventual history/live completion.
      void choose(childId, draft);
      const targetGeneration = generation.current;
      if (selection.current !== childId || targetGeneration === g) return;
      continuationDraft.current = {
        sessionId: childId,
        generation: targetGeneration,
        draft: { files, resources, historyReferences: historyDraft },
      };
      setHistoryReferences(historyDraft);
      return childId;
    })();
    try {
      return await intent.completion;
    } finally {
      if (forkNavigation.current === intent) forkNavigation.current = undefined;
    }
  }
  const current = sessions.find((s) => s.id === selected);
  const currentWorkspace = workspaces?.find((w) => w.id === current?.workspace_id);
  const currentTitle = displaySessionTitle(current?.title, t.untitled);
  const formatCatalogTime = (value?: string | null) =>
    value && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString(locale)
      : c.unknown;
  const sourceTitle = (id: string) => {
    const source = sessions.find((s) => s.id === id);
    return source ? displaySessionTitle(source.title, t.untitled) : id;
  };
  const dshStatus =
    current?.agent === "deepseek-harness" && live?.sessionId === selected
      ? dshNativeStatusDisplay(live, locale)
      : undefined;
  const settingsWriteActive = desktop
    ? savingSettingsFor === selected
    : selectedSettingsNotice?.status === "writing";
  const canSend =
    controlReady &&
    online &&
    !busy &&
    !settingsWriteActive &&
    access?.protocolVersion === 2 &&
    !!access?.experimentalEnabled &&
    !!access.device?.send &&
    !!live?.sendEnabled &&
    (live.status === "idle" ||
      (current?.agent === "claude-code" && live.status === "released") ||
      (dshStatus?.continuation === "status-unknown" && live.status === "unsupported")) &&
    live.activity !== "compacting";
  const canStop =
    controlReady &&
    online &&
    !busy &&
    !settingsWriteActive &&
    access?.protocolVersion === 2 &&
    !!access?.experimentalEnabled &&
    !!access.device?.send &&
    live?.stopEnabled === true &&
    (live.executionMode !== "claude-follower" ||
      (capabilities?.sessionId === selected && capabilities.features.stop?.available === true)) &&
    !!live.turnId;
  const terminalReasonText =
    live?.executionMode === "claude-follower"
      ? claudeConnectionReason(locale, live.reason, surface)
      : undefined;
  const liveText = dshStatus
    ? dshStatus.label
    : live?.reason === "control-outcome-unconfirmed"
      ? t.controlUnconfirmed
      : (terminalReasonText ??
        (live?.activity === "compacting"
          ? contextUsageCopyForSurface(locale, surface).compacting
          : live?.status === "idle" && (desktop || live.reason !== "handoff-required")
            ? t.idle
            : live?.questions?.length
              ? interactionCopy[locale].title
              : live?.status === "running"
                ? t.running
                : live?.status === "awaiting-approval" || live?.status === "waiting-approval"
                  ? t.approval
                  : live?.reason
                    ? unavailableReasonText(live.reason, t)
                    : t.unknown));
  function addHistoryReference(reference: ResolvedHistoryReference, targetId: string) {
    if (
      mutating.current ||
      targetId !== selection.current ||
      !targetId ||
      !accessRef.current?.device?.send ||
      !accessRef.current?.historySearch
    )
      throw new Error("history_reference_unavailable");
    const prior = historyReferencesValue.current;
    if (
      prior.some(
        (item) => historyReferenceKey(item.reference) === historyReferenceKey(reference.reference),
      )
    )
      return;
    const next = [...prior, reference];
    if (!referencesWithinBudget(next)) throw new Error("history_reference_limit");
    setHistoryReferences(next);
  }
  return {
    historySearchOpen,
    setHistorySearchOpen,
    historyReferences,
    setHistoryReferences,
    addHistoryReference,
    usageEpoch,
    liveContentVersion,
    client,
    embedded,
    capabilities,
    forkCheckAvailable: !!(
      online &&
      access?.status === "approved" &&
      access.experimentalEnabled &&
      access.device?.manage &&
      live?.sessionId === selected &&
      live.status !== "outcome-unknown" &&
      live.reason !== "control-outcome-unconfirmed" &&
      capabilities?.reason !== "control-outcome-unconfirmed" &&
      capabilities?.sessionId === selected &&
      capabilities.features.fork?.available &&
      notice !== "uncertain" &&
      !excludedSessionIds.has(selected)
    ),
    settingsChangedHere,
    settingsNotice: selectedSettingsNotice,
    settingsOnlyBlocked: !!(
      (settingsWriteActive || selectedSettingsNotice?.status === "uncertain") &&
      online &&
      streamReady.current &&
      !refreshRequired.current &&
      !manualRefreshRequired.current &&
      !uncertainOutcomes.current.has(selected) &&
      !durablePending.current.some(
        (entry) => entry.sessionId === selected && !isSessionSettingsAction(entry.kind),
      )
    ),
    actionUnavailableReason,
    codexAction,
    dropDeletedSession,
    checkContinuation,
    forkContinuation,
    takeContinuationDraft,
    pendingSend,
    origin,
    connection: client.connection,
    disconnect: disconnect ? disconnectImages : undefined,
    imageRequestVersion,
    locale,
    setLocale,
    theme,
    setTheme,
    accent,
    setAccent,
    t,
    c,
    access,
    sessions,
    excludedSessionIds,
    showExecution,
    setShowExecution,
    catalogNotice,
    catalogStatus,
    workspaces,
    selected,
    page,
    live,
    online,
    controlReady,
    indexEnabled,
    busy,
    pairingError,
    error: error || catalogObservationFailed,
    incompatible,
    setIncompatible,
    notice,
    noticeReason,
    noticeSource,
    code,
    setCode,
    name,
    setName,
    message,
    setMessage,
    modal,
    setModal,
    pendingSessions,
    scroll,
    refresh,
    choose,
    post,
    pair,
    earlier,
    historyDetailTurnId,
    loadingEarlier,
    control,
    current,
    currentWorkspace,
    currentTitle,
    formatCatalogTime,
    sourceTitle,
    canSend,
    canStop,
    liveText,
    leaveSession,
  };
}
export type SessionController<Words extends ControllerWords = ControllerWords> = ReturnType<
  typeof useSessionController<Words>
>;
