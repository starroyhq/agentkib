import type { ContinuationComposerDraft, ContinuationDraft } from "./continuation-draft";
import { claudeConnectionReason } from "./claude-connection-copy";
import {
  historyMessageText,
  historyReferenceKey,
  referencesWithinBudget,
} from "../history/history-reference-model";
import type { ResolvedHistoryReference } from "@agentkib/web-client";
import {
  createConversationStore,
  mergeConversationItems,
  type SessionStreamEvent,
} from "@agentkib/conversation-state";
import {
  forgetPending,
  pendingScope,
  readPending,
  rememberPending,
  type PendingControl,
} from "./pending-controls";
import { blockedWhileCompacting } from "./session-activity";
import { contextUsageCopyForSurface } from "./context-usage-copy";
import { retryBusyRead } from "./session-read-retry";
import { useSessionLive } from "./use-session-live";
import { capabilityAccessBinding, useSessionCapabilities } from "./use-session-capabilities";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type SetStateAction,
} from "react";
import {
  ApiError,
  isClaudeCommandRefusal,
  isLegacyPreparedReceipt,
  WebClient,
  type Access,
  type ClaudeCommandRefusal,
  type WebConnection,
  type SessionAction,
  type SessionActionBody,
  type Approval,
  type ConversationEvent,
  type ConversationEventPage,
  type ConversationSessionSummary,
  type Decision,
  type Live,
  type UserQuestionRequest,
} from "@agentkib/web-client";
import { displaySessionTitle, isSessionVisible } from "@agentkib/session-catalog";
import { answerRequestBody, interactionCopy } from "../interactions/question-form";
import type { CatalogStatus, CatalogWorkspace } from "../catalog/session-catalog";
import { catalogCopy } from "../catalog/catalog-copy";
import { dictionaries, type Locale } from "../../i18n";
import { unavailableReasonText } from "../../live-status";
import {
  isValidMessage,
  mergeLatestPage,
  mergeOrderedPersistedHistory,
  removePersistedOverlays,
  mergeNativeCoverage,
  beginHistoryRead,
  failHistoryRead,
  completeHistoryRead,
  hasAppliedNewerHistory,
  type NativeCoverage,
} from "./session-model";
import {
  applyHistoryPagination,
  beginHistoryPagination,
  createHistoryPagination,
  historyPaginationCursor,
  recordLatestHistoryPage,
} from "./history-pagination";
import { useAppearance } from "../preferences/use-appearance";
import { publishSessionInvalidation, subscribeSessionInvalidation } from "./session-events";
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
type ControlNotice = "accepted" | "uncertain" | "notDispatched";
type CodexSettingsRecoveryReason =
  | "unsupported-model"
  | "unsupported-effort"
  | "native-model-unconfirmed"
  | "native-effort-unconfirmed";
/** A model or effort Claude Code does not offer; worded apart from Codex's unsent message. */
type ClaudeSettingsReason = "claude-model-unsupported" | "claude-effort-unsupported";
/** A reason a rejected request is explained with instead of the generic notice. */
type NotDispatchedReason =
  | CodexSettingsRecoveryReason
  | ClaudeCommandRefusal
  | ClaudeSettingsReason;
function codexSettingsRecoveryReason(
  agent: string | undefined,
  ...reasons: (string | undefined)[]
): NotDispatchedReason | undefined {
  if (agent === "claude-code") {
    // A slash command Claude Code was not sent; the host names which rule refused it.
    const refusal = reasons.find(isClaudeCommandRefusal);
    if (refusal) return refusal;
    // The Service checks a settings request first and answers `unsupported_model`; the backend
    // checks again and names the same rejection `unsupported-model`.
    if (reasons.some((reason) => reason === "unsupported-model" || reason === "unsupported_model"))
      return "claude-model-unsupported";
    if (
      reasons.some((reason) => reason === "unsupported-effort" || reason === "unsupported_effort")
    )
      return "claude-effort-unsupported";
    return;
  }
  if (agent !== "codex") return;
  return reasons.find(
    (reason): reason is CodexSettingsRecoveryReason =>
      reason === "unsupported-model" ||
      reason === "unsupported-effort" ||
      reason === "native-model-unconfirmed" ||
      reason === "native-effort-unconfirmed",
  );
}
export function useSessionController({
  origin: legacyOrigin = "",
  connection,
  disconnect,
  initialLocale = "zh-CN",
  initialTheme = "system",
  client: providedClient,
  embedded = false,
}: {
  origin?: string;
  connection?: WebConnection;
  disconnect?: () => void;
  initialLocale?: Locale;
  initialTheme?: string;
  client?: WebClient;
  embedded?: boolean;
}) {
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
  const [streamEpoch, setStreamEpoch] = useState(0);
  const [usageEpoch, setUsageEpoch] = useState("");
  const [liveContentVersion, setLiveContentVersion] = useState(0);
  const [catalogObservationFailed, setCatalogObservationFailed] = useState(false);
  const retryCatalogObservation = useRef<(() => void) | undefined>(undefined);
  const catalogInvalidationRead = useRef<(() => Promise<void>) | undefined>(undefined);
  const liveDelivery = useRef(0);
  const streamReady = useRef(false);
  const activeSends = useRef(
    new Map<string, { scope: string; generation: number; bootId?: string }>(),
  );
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
  const t = dictionaries[locale];
  const c = catalogCopy[locale];
  const [access, setAccess] = useState<Access>(),
    [sessions, setSessions] = useState<ConversationSessionSummary[]>([]),
    [excludedSessionIds, setExcludedSessionIds] = useState<ReadonlySet<string>>(new Set()),
    [catalogNotice, setCatalogNotice] = useState(false),
    [catalogStatus, setCatalogStatus] = useState<CatalogStatus>("loading"),
    [workspaces, setWorkspaces] = useState<CatalogWorkspace[]>(),
    [selected, setSelected] = useState(""),
    [page, publishPage] = useState<ConversationEventPage>(),
    [live, publishLive] = useState<Live>(),
    [controlReady, setControlReady] = useState(false),
    [indexEnabled, setIndexEnabled] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [pairingError, setPairingError] = useState<string>(),
    [incompatible, setIncompatible] = useState(false),
    [connectionNotice, setConnectionNotice] = useState<{
      online: boolean;
      notice?: ControlNotice;
      reason?: NotDispatchedReason;
    }>({ online: false }),
    [code, setCode] = useState(""),
    [name, setName] = useState(""),
    [message, setMessage] = useState(""),
    [modal, setModal] = useState<
      "preferences" | "metadata" | ConversationEvent | Approval | UserQuestionRequest
    >();
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
  const [actionUnavailable, setActionUnavailable] = useState<{ binding: string; reason: string }>();
  const actionUnavailableReason =
    actionUnavailable?.binding === settingsBinding ? actionUnavailable.reason : undefined;
  const entryNotice = useRef<{ sessionId: string; ignoredId?: string } | undefined>(undefined);
  const liveValue = useRef<Live | undefined>(undefined);
  const setLive = useCallback((value: SetStateAction<Live | undefined>) => {
    let next = typeof value === "function" ? value(liveValue.current) : value;
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
  }, []);
  const { online, notice, reason: noticeReason } = connectionNotice;
  const setNotice = useCallback((notice?: ControlNotice, reason?: NotDispatchedReason) => {
    setConnectionNotice((value) => ({
      ...value,
      notice,
      reason: notice === "notDispatched" ? reason : undefined,
    }));
  }, []);
  const setOnline = useCallback((next: SetStateAction<boolean>) => {
    setConnectionNotice((value) => {
      const online = typeof next === "function" ? next(value.online) : next;
      return { ...value, online, reason: online ? value.reason : undefined };
    });
  }, []);
  const pageValue = useRef<ConversationEventPage | undefined>(undefined);
  const setPage = useCallback((update: SetStateAction<ConversationEventPage | undefined>) => {
    // History and pagination are one accepted projection. Resolve updates once
    // against the latest page, before publishing React state; React may replay
    // state updaters, which must not consume pagination tickets or reset coverage.
    const next = typeof update === "function" ? update(pageValue.current) : update;
    pageValue.current = next;
    publishPage(next);
  }, []);
  const shownInteractions = useRef(new Set<string>());
  const catalogSessions = useRef<ConversationSessionSummary[]>([]);
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
  const generation = useRef(0),
    selection = useRef(""),
    accessRef = useRef<Access | undefined>(undefined),
    scroll = useRef<HTMLElement>(null),
    mutating = useRef(false);
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
  const hasDurablePending = useCallback(
    (id: string) => durablePending.current.some((pending) => pending.sessionId === id),
    [],
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
    cancelForkNavigation();
    generation.current++;
    readinessEpoch.current++;
    selection.current = "";
    setSelected("");
    setSessions([]);
    catalogSessions.current = [];
    excludedIds.current = new Set();
    setExcludedSessionIds(excludedIds.current);
    setCatalogNotice(false);
    setCatalogStatus("loading");
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
    shownInteractions.current.clear();
    receipt.current = undefined;
    setPendingSessions({});
    setCode("");
    setName("");
    setOnline(false);
    setControlReady(false);
    setCatalogObservationFailed(false);
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
    setNotice,
    setOnline,
    clearCapabilities,
    cancelForkNavigation,
  ]);
  const leaveSession = useCallback(() => {
    cancelForkNavigation();
    // Mounting the directory with no selected conversation must not invalidate
    // its initial catalog read, which may still be waiting on the host.
    if (selection.current) {
      generation.current++;
      readinessEpoch.current++;
    }
    selection.current = "";
    deferredRefresh.current = undefined;
    streamReady.current = false;
    setSelected("");
    setNotice(undefined);
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
  ]);
  const acceptCatalog = useCallback(
    (records: ConversationSessionSummary[]) => {
      const excluded = new Set(
        records.filter((record) => !isSessionVisible(record)).map((s) => s.id),
      );
      const visible = records.filter(isSessionVisible);
      // Update the dispatch guard before publishing React state. A callback from
      // the previous render must not reopen a record the new catalog excludes.
      excludedIds.current = excluded;
      catalogSessions.current = visible;
      observeForkNavigation();
      setExcludedSessionIds(excluded);
      setSessions(visible);
      setCatalogStatus("ready");
      if (excluded.has(selection.current)) {
        leaveSession();
        setCatalogNotice(true);
      }
    },
    [leaveSession, observeForkNavigation],
  );
  const fail = useCallback(
    (e: unknown, g = generation.current) => {
      if (g !== generation.current) return;
      readinessEpoch.current++;
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
    [clear, client, isLan, setOnline],
  );
  const readHistory = useCallback(
    async (id: string, g: number, historyCacheEpoch: string | undefined, cursor?: string) => {
      if (excludedIds.current.has(id)) return undefined;
      const attempt = beginHistoryRead(nativeCoverage.current);
      try {
        return { type: "page" as const, page: await client.events(id, cursor), attempt };
      } catch (error) {
        if (
          g === generation.current &&
          selection.current === id &&
          historyCacheEpoch === nativeCoverage.current.historyCacheEpoch
        ) {
          // Handle history separately from the concurrent live read, including
          // a late history failure after Promise.all has already rejected.
          if (error instanceof DOMException && error.name === "AbortError") return undefined;
          // Return contention separately so a concurrent real live-read failure
          // is still observed before the caller schedules read recovery.
          if (error instanceof ApiError && error.code === "operation_busy")
            return { type: "busy" as const, error };
          if (failHistoryRead(nativeCoverage.current, attempt)) {
            setError(true);
            fail(error, g);
          } else if (hasAppliedNewerHistory(nativeCoverage.current, attempt)) {
            // A newer applied history read already satisfied this refresh. Keep
            // its completion distinct from an unresolved or out-of-scope failure.
            return { type: "superseded" as const, attempt };
          }
        }
        return undefined;
      }
    },
    [client, fail],
  );
  const syncAccess = useCallback(
    (stillCurrent?: () => boolean) => {
      const g = generation.current;
      const epoch = ++accessEpoch.current;
      const flight = (async () => {
        let next: Access;
        try {
          next = await client.access();
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
        accessRef.current = next;
        observeForkNavigation();
        if (isLan && next.status === "ended") client.reset();
        setAccess(next);
        return next;
      })();
      accessFlight.current = flight;
      return flight;
    },
    [clear, client, origin, isLan, setHistoryReferences, observeForkNavigation],
  );
  const reconcilePending = useCallback(
    async (sessionId?: string) => {
      const scope = durableScope.current;
      if (!scope) return;
      const epoch = readinessEpoch.current;
      // Read again so other components sharing this tab's scope see the same fence.
      durablePending.current = readPending(scope);
      const pending = durablePending.current.filter(
        (entry) =>
          !["create", "adopt", "release", "reconcile"].includes(entry.kind) &&
          (!sessionId || entry.sessionId === sessionId),
      );
      let resolvedSelected: string | undefined;
      const inFlight = (requestId: string) => {
        const active = activeSends.current.get(requestId);
        return (
          active?.scope === scope &&
          active.generation === generation.current &&
          active.bootId === accessRef.current?.bootId
        );
      };
      for (const entry of pending) {
        // An awaited send is still in progress. Reconcile it after its response is lost,
        // or after its visit/runtime changes, rather than blocking on its own receipt.
        if (inFlight(entry.requestId)) continue;
        const result = await client.receipt(entry.requestId);
        if (scope !== durableScope.current) return;
        if (
          !result.found ||
          result.requestId !== entry.requestId ||
          (!isLegacyPreparedReceipt(result, entry.requestId) &&
            (result.recovery !== undefined ||
              (entry.sessionId && result.sessionId !== entry.sessionId) ||
              result.operation !== entry.kind ||
              result.status === "unknown"))
        )
          continue;
        if (result.status !== "accepted" && result.status !== "not-dispatched") continue;
        const intent = forkNavigation.current;
        if (entry.kind === "fork" && result.status === "accepted") {
          if (
            isLegacyPreparedReceipt(result, entry.requestId) ||
            result.ack?.accepted !== true ||
            result.ack.completed !== true ||
            result.ack.requestId !== entry.requestId ||
            typeof result.ack.sessionId !== "string" ||
            !result.ack.sessionId ||
            result.ack.sessionId === entry.sessionId ||
            (intent?.requestId === entry.requestId &&
              intent.runtimeBootId !== undefined &&
              result.runtimeBootId !== intent.runtimeBootId)
          )
            continue;
          if (intent?.requestId === entry.requestId) {
            intent.childId = result.ack.sessionId;
            observeForkNavigation();
          }
        } else if (entry.kind === "fork" && intent?.requestId === entry.requestId)
          intent.resolve(undefined);
        forgetPending(scope, entry.requestId);
        durablePending.current = readPending(scope);
        uncertainOutcomes.current.delete(entry.sessionId ?? "");
        if (entry.sessionId === selection.current) {
          resolvedSelected = entry.sessionId;
          setNotice(
            result.status === "accepted" ? "accepted" : "notDispatched",
            result.status === "not-dispatched" && !isLegacyPreparedReceipt(result, entry.requestId)
              ? codexSettingsRecoveryReason(
                  catalogSessions.current.find((session) => session.id === entry.sessionId)?.agent,
                  result.ack?.reason,
                  result.ack?.error,
                )
              : undefined,
          );
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
      if (
        durablePending.current.some(
          (entry) => entry.sessionId === selection.current && !inFlight(entry.requestId),
        )
      )
        setNotice("uncertain");
      else if (
        resolvedSelected === selection.current &&
        epoch === readinessEpoch.current &&
        accessRef.current?.protocolVersion === 2
      ) {
        refreshRequired.current = uncertainOutcomes.current.has(selection.current);
        setControlReady(
          streamReady.current && !controlReconciliationPending.current && !refreshRequired.current,
        );
      }
    },
    [client, hasDurablePending, setNotice, observeForkNavigation],
  );
  const refresh = useCallback(
    async function refreshCurrent(manual = false, preserveHistory = false): Promise<void> {
      // A retained successful catalog stays usable while refreshing. Before
      // the first accepted snapshot, pending and failure are not empty data.
      setCatalogStatus((previous) => (previous === "ready" ? previous : "loading"));
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
        await reconcilePending(selection.current || undefined);
        if (g !== generation.current) return;
        catalogOrder = ++catalogReadOrder.current;
        const catalog = await retryBusyRead(() => client.catalog());
        if (g !== generation.current) return;
        if (contention !== readContention.current.version)
          throw new ApiError(409, "operation_busy");
        if (catalogOrder === catalogReadOrder.current) {
          if (!catalog.indexEnabled) {
            clear();
            setIndexEnabled(false);
            return;
          }
          setIndexEnabled(true);
          acceptCatalog(catalog.sessions);
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
          if (delivered === liveDelivery.current) setLive(state);
          if (manual && next.protocolVersion === 2) setStreamEpoch((value) => value + 1);
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
          if (e instanceof ApiError && e.code === "operation_busy") {
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
    [refresh, resumeDeferredRefresh],
  );
  useEffect(() => {
    void refresh();
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
          setCatalogStatus((previous) => (previous === "ready" ? previous : "error"));
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
            setCatalogStatus((previous) => (previous === "ready" ? previous : "loading"));
            const catalog = await retryBusyRead(() => client.catalog());
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
              clear();
              setIndexEnabled(false);
              break;
            }
            setIndexEnabled(true);
            acceptCatalog(catalog.sessions);
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
              if (error instanceof ApiError && error.code === "operation_busy")
                retryAfterControl = true;
              else {
                if (
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
    clear,
    accessRef,
    setLive,
    setOnline,
    setError,
    hasDurablePending,
    readinessEpoch,
    refreshRequired,
    setControlReady,
    setAccess,
    setPage,
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
      cancelForkNavigation();
      generation.current++;
      continuationDraft.current = undefined;
      readinessEpoch.current++;
      // The new selection owns its baseline read. An obsolete refresh cannot
      // keep it fenced, while unknown outcomes remain attached to their session.
      refreshRequired.current = uncertainOutcomes.current.has(id);
      manualRefreshRequired.current = false;
      selection.current = id;
      setSelected(id);
      setPage(undefined);
      setLive(undefined);
      setModal(undefined);
      setMessage(initialDraft ?? "");
      setPendingSend(undefined);
      setHistoryReferences([]);
      setHistorySearchOpen(false);
      setNotice(undefined);
      setCatalogNotice(false);
      setOnline(false);
      setControlReady(false);
      streamReady.current = false;
      nativeCoverage.current = { items: [], authoritativeTurnIds: [], removedTurnIds: [] };
      setError(false);
      const g = generation.current;
      const wake = refreshWake.current;
      let historyScope: { epoch?: string } | undefined;
      try {
        await reconcilePending(id);
        if (g !== generation.current) return;
        const delivered = liveDelivery.current;
        const historyCacheEpoch = nativeCoverage.current.historyCacheEpoch;
        historyScope = { epoch: historyCacheEpoch };
        const epoch = readinessEpoch.current;
        const historyPromise = readHistory(id, g, historyCacheEpoch).then((historyRead) => {
          if (g !== generation.current || selection.current !== id || historyRead?.type !== "page")
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
        const [historyRead, state] = await Promise.all([historyPromise, client.live(id)]);
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
        if (delivered === liveDelivery.current) setLive(state);
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
      setNotice,
      setOnline,
      leaveSession,
      cancelForkNavigation,
    ],
  );
  async function post(path: string, body: unknown) {
    if (mutating.current) return;
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
  async function earlier() {
    if (!page?.next_cursor || busy) return;
    const pagination = nativeCoverage.current.historyPagination;
    const ticket = pagination && beginHistoryPagination(pagination, page.next_cursor);
    if (!ticket) return;
    setBusy(true);
    const id = selected,
      g = generation.current;
    const viewport = scroll.current;
    const anchor = viewport?.querySelector<HTMLElement>("[data-event-id]");
    const top = anchor?.getBoundingClientRect().top;
    const anchorId = anchor?.dataset.eventId;
    const historyCacheEpoch = nativeCoverage.current.historyCacheEpoch;
    const wake = refreshWake.current;
    try {
      const historyRead = await readHistory(id, g, historyCacheEpoch, page.next_cursor);
      if (historyRead?.type === "busy") {
        readBusy(wake, g);
        return;
      }
      if (
        !historyRead ||
        historyRead.type !== "page" ||
        g !== generation.current ||
        selection.current !== id ||
        historyCacheEpoch !== nativeCoverage.current.historyCacheEpoch
      )
        return;
      const { page: older, attempt } = historyRead;
      if (
        nativeCoverage.current.historyPagination !== pagination ||
        !applyHistoryPagination(pagination, ticket, older)
      )
        return;
      const nextCursor = historyPaginationCursor(pagination);
      const hadHistoryError = nativeCoverage.current.historyRecoveryFailed;
      completeHistoryRead(nativeCoverage.current, attempt);
      if (hadHistoryError) setError(!!nativeCoverage.current.historyRecoveryFailed);
      setPage((current) =>
        current
          ? {
              events: mergeNativeCoverage(
                mergeConversationItems(
                  mergeOrderedPersistedHistory(
                    current.events,
                    older.events,
                    "older",
                    nativeCoverage.current.preserveItemsOutsideCoverage,
                    ticket.beforeItemIds,
                    ticket.afterItemIds,
                  ),
                  removePersistedOverlays(
                    current.events,
                    older.events,
                    nativeCoverage.current.preserveItemsOutsideCoverage,
                  ),
                ),
                nativeCoverage.current,
              ),
              next_cursor: nextCursor,
              warnings: [...new Set([...older.warnings, ...current.warnings])],
            }
          : {
              ...older,
              next_cursor: nextCursor,
              events: mergeNativeCoverage(older.events, nativeCoverage.current),
            },
      );
      requestAnimationFrame(() => {
        if (anchorId && top !== undefined && viewport) {
          const node = Array.from(viewport.querySelectorAll<HTMLElement>("[data-event-id]")).find(
            (n) => n.dataset.eventId === anchorId,
          );
          if (node) viewport.scrollTop += node.getBoundingClientRect().top - top;
        }
      });
    } catch (e) {
      fail(e, g);
    } finally {
      setBusy(false);
    }
  }
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
  useEffect(() => {
    if (!online || !controlReady || !live || modal) return;
    const pending = [...live.approvals, ...(live.questions ?? [])].find((request) => {
      const key = `${selected}:${request.turnId}:${request.requestId}:${"questions" in request ? "question" : "approval"}`;
      const permitted =
        access?.experimentalEnabled &&
        ("questions" in request ? access.device?.send : access.device?.approve);
      return request.supported && permitted && !shownInteractions.current.has(key);
    });
    if (pending) {
      shownInteractions.current.add(
        `${selected}:${pending.turnId}:${pending.requestId}:${"questions" in pending ? "question" : "approval"}`,
      );
      setModal(pending);
    }
  }, [live, selected, online, controlReady, modal, access]);
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
    // A replaced binding invalidates reviewed forms and source references, not the draft.
    setModal(undefined);
    shownInteractions.current.clear();
    setHistoryReferences([]);
    setHistorySearchOpen(false);
  }, [selected, terminalPresent, terminalMode, terminalGeneration, online, setHistoryReferences]);
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
    excludedIds.current = new Set([...excludedIds.current, id]);
    catalogSessions.current = catalogSessions.current.filter((session) => session.id !== id);
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
    setBusy(true);
    setNotice(undefined);
    setActionUnavailable(undefined);
    const requestId = crypto.randomUUID();
    const id = selected;
    const g = generation.current;
    const accessBinding = capabilityAccessBinding(access);
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
        setActionUnavailable(
          outcomeUnknown
            ? undefined
            : {
                binding: settingsBinding,
                reason:
                  checked?.features[action]?.reason ??
                  checked?.reason ??
                  "session-state-unavailable",
              },
        );
        if (outcomeUnknown) {
          refreshRequired.current = true;
          setControlReady(false);
        }
        setNotice(outcomeUnknown ? "uncertain" : "notDispatched");
      }
      mutating.current = false;
      setBusy(false);
      return;
    }
    if (action === "settings" && Object.keys(fields).length)
      setSettingsIntentBinding(settingsBinding);
    const perform = (body: SessionActionBody) =>
      sessions.find((session) => session.id === id)?.agent === "claude-code"
        ? client.sessionAction(action, body, "claude-code")
        : action === "queue-pause" || action === "queue-resume"
          ? Promise.reject(new ApiError(409, "operation_unavailable", "not-dispatched"))
          : client.codexAction(action, body);
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
      if (error instanceof ApiError && error.controlOutcome === "not-dispatched") {
        forgetPending(scope, requestId);
        if (durableScope.current === scope) durablePending.current = readPending(scope);
      }
      if (generation.current === g) {
        setNotice(
          error instanceof ApiError && error.controlOutcome === "not-dispatched"
            ? "notDispatched"
            : "uncertain",
          error instanceof ApiError && error.controlOutcome === "not-dispatched"
            ? codexSettingsRecoveryReason(
                catalogSessions.current.find((session) => session.id === id)?.agent,
                error.code,
              )
            : undefined,
        );
        setControlReady(false);
        refreshRequired.current = true;
        if (!(error instanceof ApiError) || error.controlOutcome !== "not-dispatched")
          uncertainOutcomes.current.add(id);
        if (action === "fork") void refresh(true);
        else await refresh(true);
      }
      return undefined;
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  async function control(
    kind: "send" | "stop" | "approve" | "answer",
    approval?: Approval,
    decision?: Decision,
    question?: UserQuestionRequest,
    answers?: Record<string, string[]>,
    extra?: {
      attachmentIds?: string[];
      resourceIds?: string[];
      nativeDecision?: unknown;
      /**
       * A slash command sent as a message of its own (the compact button). The draft, its
       * attachments and history quotes stay as they are.
       */
      command?: string;
      /**
       * A message AgentKib wrote in place of the draft (Codex `/review`, `/init`). It is sent
       * without attachments or history quotes, and clears the draft like any send.
       */
      prompt?: string;
    },
  ) {
    if (
      mutating.current ||
      !access ||
      !live ||
      !online ||
      !controlReady ||
      excludedIds.current.has(selected) ||
      selection.current !== selected ||
      hasDurablePending(selected)
    )
      return;
    const command = kind === "send" ? extra?.command : undefined;
    const prompt = kind === "send" && command === undefined ? extra?.prompt : undefined;
    const text = command ?? prompt ?? message.trim();
    if (
      kind === "send" &&
      (live.activity === "compacting" ||
        (command !== undefined
          ? !command.startsWith("/") ||
            !isValidMessage(command, false) ||
            !!extra?.attachmentIds?.length ||
            !!extra?.resourceIds?.length
          : prompt !== undefined
            ? !isValidMessage(prompt, false) ||
              !!extra?.attachmentIds?.length ||
              !!extra?.resourceIds?.length
            : !isValidMessage(
                historyMessageText(message, historyReferencesValue.current),
                !!extra?.attachmentIds?.length,
              )))
    )
      return;
    if (
      extra?.attachmentIds?.length &&
      (!access.device?.attachments || !capabilities?.features.attachments?.available)
    )
      return;
    if (
      extra?.resourceIds?.length &&
      (access.device?.accessMode !== "full" ||
        !(capabilities?.features as Record<string, { available?: boolean } | undefined> | undefined)
          ?.context?.available)
    )
      return;
    if (
      extra?.nativeDecision !== undefined &&
      (!access.device?.extendedApproval ||
        !approval?.decisionOptions?.some(
          (option) => JSON.stringify(option.decision) === JSON.stringify(extra.nativeDecision),
        ))
    )
      return;
    if (
      kind === "stop" &&
      (!access.experimentalEnabled ||
        !access.device?.send ||
        live.stopEnabled !== true ||
        !live.turnId)
    )
      return;
    if (
      kind === "answer" &&
      (!question ||
        !access.experimentalEnabled ||
        !access.device?.send ||
        !question.supported ||
        !live.questions?.some((current) => JSON.stringify(current) === JSON.stringify(question)))
    )
      return;
    // A stable request ID does not mean the command/scope shown in an open
    // dialog is still current. Require the exact reviewed projection.
    if (
      kind === "approve" &&
      (!approval ||
        !live.approvals.some((current) => JSON.stringify(current) === JSON.stringify(approval)))
    )
      return;
    mutating.current = true;
    setBusy(true);
    setNotice(undefined);
    readinessEpoch.current++;
    manualRefreshRequired.current = false;
    const g = generation.current,
      id = selected;
    const requestId = crypto.randomUUID();
    if (
      kind === "send" &&
      ["codex", "claude-code"].includes(
        catalogSessions.current.find((item) => item.id === id)?.agent ?? "",
      )
    )
      setPendingSend({ sessionId: id, text, afterEventId: page?.events.at(-1)?.id });
    const needsDurableReceipt =
      ["codex", "claude-code"].includes(
        sessions.find((session) => session.id === id)?.agent ?? "",
      ) ||
      live.executionMode === "claude-managed" ||
      live.executionMode?.startsWith("codex-");
    const scope = needsDurableReceipt ? durableScope.current : undefined;
    try {
      if (extra?.attachmentIds?.length || extra?.resourceIds?.length) {
        const accessBinding = capabilityAccessBinding(access);
        const checked = await verifyCapabilities();
        if (
          g !== generation.current ||
          selection.current !== id ||
          capabilityAccessBinding(accessRef.current) !== accessBinding ||
          refreshRequired.current ||
          !streamReady.current ||
          hasDurablePending(id) ||
          uncertainOutcomes.current.has(id) ||
          (extra.attachmentIds?.length && !checked?.features.attachments?.available) ||
          (extra.resourceIds?.length && !checked?.features.context?.available)
        ) {
          if (
            hasDurablePending(id) ||
            uncertainOutcomes.current.has(id) ||
            liveValue.current?.status === "outcome-unknown" ||
            liveValue.current?.reason === "control-outcome-unconfirmed" ||
            checked?.reason === "control-outcome-unconfirmed"
          ) {
            if (g === generation.current && selection.current === id) {
              refreshRequired.current = true;
              setControlReady(false);
              setNotice("uncertain");
            }
            return;
          }
          throw new ApiError(409, "session-state-unavailable", "not-dispatched");
        }
      }
      if (needsDurableReceipt) {
        try {
          if (!scope) throw new Error("missing_device_scope");
          if (kind === "send")
            activeSends.current.set(requestId, { scope, generation: g, bootId: access.bootId });
          rememberPending(scope, { requestId, sessionId: id, kind });
          durablePending.current = readPending(scope);
        } catch {
          throw new ApiError(409, "pending_storage_unavailable", "not-dispatched");
        }
      }
      await client.request(kind, {
        sessionId: id,
        requestId,
        bootId: access.bootId,
        expectedRevision: live.revision,
        ...(kind === "send"
          ? {
              text,
              ...(command === undefined &&
              prompt === undefined &&
              historyReferencesValue.current.length
                ? {
                    historyReferences: historyReferencesValue.current.map((item) => item.reference),
                  }
                : {}),
              ...(extra?.attachmentIds?.length ? { attachmentIds: extra.attachmentIds } : {}),
              ...(extra?.resourceIds?.length ? { resourceIds: extra.resourceIds } : {}),
            }
          : kind === "stop"
            ? { turnId: live.turnId }
            : kind === "approve"
              ? {
                  turnId: approval!.turnId,
                  approvalId: approval!.requestId,
                  ...(extra?.nativeDecision !== undefined
                    ? { nativeDecision: extra.nativeDecision }
                    : { decision }),
                }
              : answerRequestBody(
                  question!,
                  answers!,
                  { sessionId: id, bootId: access.bootId, expectedRevision: live.revision },
                  requestId,
                )),
      });
      if (scope) {
        forgetPending(scope, requestId);
        if (durableScope.current === scope) durablePending.current = readPending(scope);
      }
      if (g !== generation.current) return;
      receipt.current = {
        sessionId: id,
        requestId,
        turnId:
          kind === "send"
            ? undefined
            : kind === "stop"
              ? live.turnId
              : kind === "answer"
                ? question!.turnId
                : approval!.turnId,
        // A current native interaction already establishes an active turn,
        // even if the owner uses an unfamiliar waiting-status label.
        observedActive: kind !== "send",
      };
      setNotice("accepted");
      if (kind === "send" && command === undefined) {
        setMessage("");
        setHistoryReferences([]);
      }
      setModal(undefined);
      await refresh();
      return true;
    } catch (e) {
      if (scope && e instanceof ApiError && e.controlOutcome === "not-dispatched") {
        try {
          forgetPending(scope, requestId);
          if (durableScope.current === scope) durablePending.current = readPending(scope);
        } catch {
          /* Keep the durable fence if browser storage could not be updated. */
        }
      }
      if (g === generation.current) {
        if (e instanceof ApiError && e.code === "access_ended") {
          fail(e, g);
        } else {
          setControlReady(false);
          refreshRequired.current = true;
          if (e instanceof ApiError && e.controlOutcome === "not-dispatched") {
            setNotice(
              "notDispatched",
              codexSettingsRecoveryReason(
                catalogSessions.current.find((session) => session.id === id)?.agent,
                e.code,
              ),
            );
            await refresh();
          } else {
            // A refresh clicked while this request was pending cannot acknowledge
            // an uncertain outcome that has only just arrived.
            manualRefreshRequired.current = false;
            uncertainOutcomes.current.add(id);
            setNotice("uncertain");
            setOnline(false);
            fail(e, g);
          }
        }
      }
    } finally {
      activeSends.current.delete(requestId);
      if (g === generation.current) setPendingSend(undefined);
      mutating.current = false;
      setBusy(false);
    }
  }
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
  const canSend =
    controlReady &&
    online &&
    !busy &&
    access?.protocolVersion === 2 &&
    !!access?.experimentalEnabled &&
    !!access.device?.send &&
    !!live?.sendEnabled &&
    (live.status === "idle" || (current?.agent === "claude-code" && live.status === "released")) &&
    live.activity !== "compacting";
  const canStop =
    controlReady &&
    online &&
    !busy &&
    access?.protocolVersion === 2 &&
    !!access?.experimentalEnabled &&
    !!access.device?.send &&
    live?.stopEnabled === true &&
    live.executionMode !== "claude-follower" &&
    !!live.turnId;
  const terminalReasonText =
    live?.executionMode === "claude-follower"
      ? claudeConnectionReason(locale, live.reason, "web")
      : undefined;
  const liveText =
    live?.reason === "control-outcome-unconfirmed"
      ? t.controlUnconfirmed
      : (terminalReasonText ??
        (live?.activity === "compacting"
          ? contextUsageCopyForSurface(locale, "web").compacting
          : live?.status === "idle" && live.reason !== "handoff-required"
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
    actionUnavailableReason,
    codexAction,
    dropDeletedSession,
    checkContinuation,
    forkContinuation,
    takeContinuationDraft,
    pendingSend,
    origin,
    connection: client.connection,
    disconnect,
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
export type SessionController = ReturnType<typeof useSessionController>;
export type SessionOptions = Parameters<typeof useSessionController>[0];
