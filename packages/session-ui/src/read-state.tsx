import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  isRetryableReadStateUpdateError,
  isTemporaryReadStateError,
  ReadStateReconciliationError,
} from "@agentkib/web-client";
import { createReadStateProbe } from "./read-state-probe";

/** Structural wire type keeps this presentation package independent of host implementations. */
export interface SessionReadState {
  source: "codex-native" | "agentkib";
  status: "read" | "unread" | "unknown";
  freshness: "current" | "stale";
  version: string | null;
  manualVersion?: string;
  canAcknowledge?: boolean;
  firstUnread:
    | { type: "threadStart" }
    | { type: "result"; resultId: string; turnId: string | null }
    | null;
  latestResult: {
    id: string;
    turnId: string | null;
    itemId: string | null;
    outcome: "completed" | "failed" | "cancelled" | "ended";
    completedAt: string | null;
  } | null;
}
type ReadEvent = {
  id: string;
  timestamp?: string | null;
  turn_id?: string | null;
  ephemeral?: boolean;
  kind: string;
  content?: string;
  message_phase?: string | null;
  cli_output?: boolean;
  attachment_count?: number;
  turn_meta?: { outcome?: "completed" | "aborted" | "failed" };
};
export interface ReadStateClient {
  readState(id: string, signal?: AbortSignal): Promise<{ readState: SessionReadState }>;
  acknowledgeReadState(
    id: string,
    version: string,
    resultId: string | null,
    signal?: AbortSignal,
  ): Promise<{ readState: SessionReadState; acknowledged: boolean; conflict?: true }>;
  events(
    id: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{ events: ReadEvent[]; warnings: string[] }>;
}
export function readStateCopy(locale: string) {
  const values =
    locale === "zh-Hant"
      ? [
          "待查看",
          "未讀",
          "已完成",
          "失敗",
          "已取消",
          "已結束",
          "已讀狀態可能已過期",
          "空對話",
          "未讀對話",
        ]
      : locale.startsWith("zh")
        ? [
            "待查看",
            "未读",
            "已完成",
            "失败",
            "已取消",
            "已结束",
            "已读状态可能已过期",
            "空会话",
            "未读会话",
          ]
        : locale.startsWith("ja")
          ? [
              "確認待ち",
              "未読",
              "完了",
              "失敗",
              "キャンセル済み",
              "終了",
              "既読状態が古い可能性があります",
              "空の会話",
              "未読の会話",
            ]
          : [
              "To review",
              "Unread",
              "Completed",
              "Failed",
              "Cancelled",
              "Ended",
              "Read state may be out of date",
              "Empty session",
              "Unread conversation",
            ];
  const [pending, unread, completed, failed, cancelled, ended, stale, empty, manualUnread] = values;
  return {
    pending,
    unread,
    completed,
    failed,
    cancelled,
    ended,
    stale,
    empty,
    manualUnread,
  };
}

/** Navigation intent is transient and never marks a session read. */
let reviewIntent:
  | {
      id: string;
      source: string;
      catalogVersion: string | null;
      resultId: string | null;
      context?: object | string;
      expiresAt: number;
    }
  | undefined;
export function requestReadReview(id: string, state: SessionReadState, context?: object | string) {
  reviewIntent = {
    id,
    source: state.source,
    catalogVersion: state.version,
    resultId: state.latestResult?.id ?? null,
    context,
    expiresAt: Date.now() + 10000,
  };
  if (typeof window !== "undefined") window.dispatchEvent(new Event("agentkib-read-review"));
}
/** Call only from an explicit reading refresh, never a control reconciliation. */
export function requestReadStateRefresh(context: object | string, sessionId?: string) {
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent("agentkib-read-refresh", { detail: { context, sessionId } }),
    );
}
export function pendingReviewSessions<
  T extends {
    id: string;
    readState?: SessionReadState;
    remote?: unknown;
    continuation?: { status: string };
    externalTurn?: { status: string } | null;
  },
>(sessions: readonly T[]): T[] {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    if (seen.has(session.id) || session.readState?.status !== "unread") return false;
    seen.add(session.id);
    // Running/waiting rows carry their unread mark in place, without a second review entry.
    return (
      !["running", "starting", "awaiting-approval", "waiting-input"].includes(
        session.continuation?.status ?? "",
      ) && session.externalTurn?.status !== "running"
    );
  });
}
export function PendingReviewLane<
  T extends {
    id: string;
    title?: string;
    readState?: SessionReadState;
    continuation?: { status: string };
    externalTurn?: { status: string } | null;
  },
>({
  sessions,
  locale,
  onSelect,
  context,
}: {
  sessions: readonly T[];
  locale: string;
  onSelect: (id: string) => void;
  context?: object | string | ((session: T) => object | string);
}) {
  const rows = pendingReviewSessions(sessions);
  const copy = readStateCopy(locale);
  if (!rows.length) return null;
  return (
    <section aria-label={copy.pending} className="mx-3 mb-3 rounded-lg border border-border p-2">
      <h2 className="px-2 py-1 text-xs font-medium text-muted-foreground">
        {copy.pending} · {rows.length}
      </h2>
      {rows.map((row) => (
        <button
          type="button"
          key={row.id}
          className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => {
            requestReadReview(
              row.id,
              row.readState!,
              typeof context === "function" ? context(row) : context,
            );
            onSelect(row.id);
          }}
        >
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />
          <span className="min-w-0 flex-1 truncate">{row.title || copy.unread}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {row.readState?.freshness === "stale"
              ? copy.stale
              : row.readState?.latestResult
                ? copy[row.readState.latestResult.outcome]
                : copy.manualUnread}
          </span>
        </button>
      ))}
    </section>
  );
}

function eventFingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(eventFingerprint).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${eventFingerprint(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function persisted(events: readonly ReadEvent[]) {
  return events.filter((event) => !event.ephemeral);
}

function terminalOutcome(result: NonNullable<SessionReadState["latestResult"]>) {
  return result.outcome === "cancelled" ? "aborted" : result.outcome;
}

/** Match a real transcript outcome before using its folded status as reading proof. */
export function transcriptRepresentsResult(
  events: readonly ReadEvent[],
  result: SessionReadState["latestResult"] | undefined,
): boolean {
  if (!result?.turnId || result.outcome === "ended") return false;
  const expected = terminalOutcome(result);
  const outcomes = persisted(events)
    .filter((event) => event.turn_id === result.turnId && event.turn_meta?.outcome)
    .map((event) => event.turn_meta!.outcome);
  return outcomes.length > 0 && outcomes.every((outcome) => outcome === expected);
}

export function readResultAnchor(
  events: readonly ReadEvent[],
  result: SessionReadState["latestResult"] | undefined,
  activeTurnId?: string | null,
) {
  if (!result) return;
  const rows = persisted(events);
  // Managed Claude can call its own turn something different from the native log. Its exact
  // message ID still identifies the right history row and must not be replaced by a guess.
  const exactItem = result.itemId ? rows.find((event) => event.id === result.itemId) : undefined;
  if (result.itemId && !exactItem) return;
  const turnId = exactItem ? exactItem.turn_id : result.turnId;
  if (activeTurnId && (activeTurnId === result.turnId || activeTurnId === turnId)) return;
  const turnEvents = turnId
    ? rows.filter((event) => event.turn_id === turnId)
    : exactItem
      ? [exactItem]
      : [];
  const last = turnEvents.at(-1);
  if (!last) return;
  const outcomes = turnEvents.flatMap((event) => event.turn_meta?.outcome ?? []);
  const terminal = outcomes[0];
  if (
    terminal &&
    (outcomes.some((outcome) => outcome !== terminal) ||
      (result.outcome !== "ended" && terminal !== terminalOutcome(result)))
  )
    return;
  if (result.outcome === "completed" && !terminal && !turnEvents.some(resultBody)) return;
  // A second Codex process can describe a currently running turn as interrupted with no end
  // time. A cancelled result needs an ended timestamp or an independently persisted terminal.
  if (
    result.outcome === "cancelled" &&
    !terminal &&
    !(result.completedAt && Number.isFinite(Date.parse(result.completedAt)))
  )
    return;
  return { eventId: last.id, turnId, exactItem, turnEvents, terminal };
}

function resultBody(event: ReadEvent): boolean {
  return (
    event.kind === "agent-message" &&
    event.message_phase !== "commentary" &&
    (!!event.content?.trim() || !!event.attachment_count || event.cli_output === true)
  );
}

function displayedResultEvent(
  result: SessionReadState["latestResult"],
  turnEvents: readonly ReadEvent[],
  exactItem: ReadEvent | undefined,
  hasTerminal: boolean,
): ReadEvent | undefined {
  const newestFirst = [...turnEvents].reverse();
  if (result?.outcome === "cancelled") return undefined;
  if (hasTerminal && result?.outcome === "failed")
    return newestFirst.find(
      (event) =>
        resultBody(event) &&
        event.cli_output === true &&
        (event.turn_meta?.outcome === "failed" || event.id === `codex-turn-error:${result.turnId}`),
    );
  if (hasTerminal) {
    const final = newestFirst.find(
      (event) => resultBody(event) && event.message_phase === "final_answer",
    );
    if (final) return final;
  }
  return exactItem && resultBody(exactItem) ? exactItem : newestFirst.find(resultBody);
}
/** Cache rows alone are never proof: compare them with a newly loaded persisted snapshot. */
export function readSnapshotMatches(
  displayed: readonly ReadEvent[],
  fresh: readonly ReadEvent[],
): boolean {
  const current = persisted(displayed),
    probe = persisted(fresh);
  if (!probe.length) return !current.length;
  if (current.at(-1)?.id !== probe.at(-1)?.id) return false;
  const byId = new Map(current.map((event) => [event.id, eventFingerprint(event)]));
  return probe.every((event) => byId.get(event.id) === eventFingerprint(event));
}

function readingAtEnd(viewport: HTMLElement) {
  return (
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    viewport.isConnected &&
    viewport.clientHeight > 0 &&
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2 &&
    ![
      ...document.querySelectorAll<HTMLElement>(
        '[aria-modal="true"], dialog[open], [data-slot="dialog-content"][data-open]',
      ),
    ].some(
      (modal) =>
        modal.getClientRects().length > 0 && getComputedStyle(modal).visibility === "visible",
    )
  );
}

function historyContinuesAfterResult(
  events: readonly ReadEvent[],
  result: NonNullable<SessionReadState["latestResult"]>,
  activeTurnId?: string | null,
) {
  if (!result.completedAt || (activeTurnId && activeTurnId === result.turnId)) return false;
  const endedAt = Date.parse(result.completedAt);
  // Reaching the rendered bottom covers older completed results above the loaded page.
  // An unseen newer result cannot use this path: its completion must precede the visible tail.
  return persisted(events).some(
    (event) =>
      event.kind === "user-message" &&
      event.turn_id &&
      event.turn_id !== result.turnId &&
      event.timestamp &&
      Date.parse(event.timestamp) > endedAt,
  );
}

type Observation = {
  readState?: SessionReadState;
  events?: ReadEvent[];
  status: "loading" | "ready" | "unsupported" | "unavailable";
  revision: number;
};
const resultIdentityOf = (state: SessionReadState) =>
  JSON.stringify([state.source, state.latestResult?.id ?? null]);

function canAutomaticallyAcknowledge(state: SessionReadState): boolean {
  return (
    state.status === "unread" &&
    state.freshness === "current" &&
    !!state.version &&
    state.canAcknowledge !== false
  );
}

function sameReadResult(before: SessionReadState, after: SessionReadState): boolean {
  const left = before.latestResult;
  const right = after.latestResult;
  return (
    before.source === after.source &&
    before.firstUnread?.type === after.firstUnread?.type &&
    left?.id === right?.id &&
    left?.turnId === right?.turnId &&
    left?.itemId === right?.itemId &&
    left?.outcome === right?.outcome &&
    left?.completedAt === right?.completedAt
  );
}

function canRetryReadConflict(before: SessionReadState, after: SessionReadState): boolean {
  return (
    before.source === after.source &&
    after.status === "unread" &&
    after.freshness === "current" &&
    after.firstUnread?.type !== "threadStart"
  );
}

function catalogReadSuperseded(
  before: string | null | undefined,
  current: string | null | undefined,
  readState: SessionReadState,
): boolean {
  return current !== before && current !== readState.version;
}

export function useVisibleReadState(options: {
  client: ReadStateClient;
  sessionId: string;
  /** Host + account + reader grant + source generation, never a display name. */
  scope: string;
  reviewContext?: object | string;
  supported?: boolean;
  ready: boolean;
  blocked: boolean;
  isCurrent?: () => boolean;
  source?: SessionReadState["source"];
  catalogVersion?: string | null;
  activeTurnId?: string | null;
  events: readonly ReadEvent[];
  viewportRef: RefObject<HTMLElement | null>;
  subscribe?: (listener: (userAction?: boolean) => void) => () => void;
  onAcknowledged?: (
    state: SessionReadState,
    catalogVersionAtDispatch: string | null | undefined,
  ) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [observation, setObservation] = useState<Observation>({ status: "loading", revision: 0 });
  const lastState = useRef<SessionReadState | undefined>(undefined);
  const probe = useRef<ReturnType<typeof createReadStateProbe> | undefined>(undefined);
  const renderedTail = useRef<string | undefined>(undefined);
  const lifetime = useRef(0);
  const acknowledgementEpoch = useRef(0);
  const proofScope = useRef<string | undefined>(undefined);
  const manualUnread = useRef<string | undefined>(undefined);
  const uncertainResult = useRef<{ id: string; reconcile: boolean } | undefined>(undefined);
  const unresolvedConflict = useRef<SessionReadState | undefined>(undefined);
  const attempted = useRef(new Set<string>());
  const flight = useRef<AbortController | undefined>(undefined);
  const updateIdentity = useRef<string | undefined>(undefined);
  const deferredUpdate = useRef<string | undefined>(undefined);
  const retryAtEnd = useCallback(() => {
    const current = latest.current;
    const viewport = current.viewportRef.current;
    return current.ready && !current.blocked && !!viewport && readingAtEnd(viewport);
  }, []);
  const scope = `${options.scope}\n${options.sessionId}\n${options.source ?? ""}\n${options.supported ? "supported" : "unsupported"}`;
  const renderedScope = useRef(scope);
  const renderedClient = useRef(options.client);
  // Fence promises during render, before passive cleanup on an account/host switch.
  if (renderedScope.current !== scope || renderedClient.current !== options.client) {
    renderedScope.current = scope;
    renderedClient.current = options.client;
    proofScope.current = undefined;
    lifetime.current++;
  }
  useEffect(() => {
    manualUnread.current = undefined;
    uncertainResult.current = undefined;
    unresolvedConflict.current = undefined;
    attempted.current.clear();
    lastState.current = undefined;
    flight.current = undefined;
    updateIdentity.current = undefined;
    deferredUpdate.current = undefined;
    setObservation({ status: options.supported ? "loading" : "unsupported", revision: 0 });
  }, [scope, options.client, options.supported]);
  useEffect(
    () => () => {
      lifetime.current++;
    },
    [],
  );

  const userReadingAction = useRef<(refresh: boolean) => void>(() => {});
  userReadingAction.current = (refresh) => {
    const markedUnread = manualUnread.current;
    if (markedUnread) attempted.current.delete(markedUnread);
    manualUnread.current = undefined;
    if (!refresh && !(markedUnread && !proofScope.current)) return;
    if (refresh) {
      if (uncertainResult.current) attempted.current.delete(uncertainResult.current.id);
      uncertainResult.current = undefined;
      unresolvedConflict.current = undefined;
      if (deferredUpdate.current) attempted.current.delete(deferredUpdate.current);
      deferredUpdate.current = undefined;
      probe.current?.resetRetryBudget();
    }
    proofScope.current = undefined;
    probe.current?.refresh();
  };
  useEffect(
    () =>
      options.supported
        ? options.subscribe?.((userAction) => {
            if (userAction) userReadingAction.current(true);
            else probe.current?.refresh();
          })
        : undefined,
    [options.subscribe, options.supported],
  );
  useEffect(() => {
    const foreground = () => {
      // Resume observation only. A lost ACK still needs an explicit reading action.
      if (document.visibilityState === "visible" && document.hasFocus()) probe.current?.refresh();
      else {
        flight.current?.abort();
        probe.current?.schedule();
      }
    };
    const review = () => {
      const intent = reviewIntent,
        current = latest.current;
      if (
        intent?.id === current.sessionId &&
        intent.context === (current.reviewContext ?? current.client) &&
        intent.expiresAt > Date.now()
      )
        userReadingAction.current(true);
    };
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ context: object | string; sessionId?: string }>)
          .detail,
        current = latest.current;
      if (
        detail?.context === (current.reviewContext ?? current.client) &&
        (!detail.sessionId || detail.sessionId === current.sessionId)
      )
        userReadingAction.current(true);
    };
    const viewport = options.viewportRef.current;
    const formTarget = (event: Event) =>
      event.target instanceof Element &&
      !!event.target.closest(
        "input,textarea,select,button,[role=button],[contenteditable]:not([contenteditable=false])",
      );
    const bodyClick = (event: Event) => {
      if (!formTarget(event)) {
        userReadingAction.current(
          event.type === "pointerdown" && !!(uncertainResult.current || deferredUpdate.current),
        );
      }
    };
    const readKey = (event: KeyboardEvent) => {
      if (
        !formTarget(event) &&
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
      )
        userReadingAction.current(false);
    };
    viewport?.addEventListener("pointerdown", bodyClick);
    viewport?.addEventListener("wheel", bodyClick, { passive: true });
    viewport?.addEventListener("touchmove", bodyClick, { passive: true });
    viewport?.addEventListener("keydown", readKey);
    window.addEventListener("focus", foreground);
    window.addEventListener("blur", foreground);
    window.addEventListener("agentkib-read-review", review);
    window.addEventListener("agentkib-read-refresh", refresh);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      viewport?.removeEventListener("pointerdown", bodyClick);
      viewport?.removeEventListener("wheel", bodyClick);
      viewport?.removeEventListener("touchmove", bodyClick);
      viewport?.removeEventListener("keydown", readKey);
      window.removeEventListener("focus", foreground);
      window.removeEventListener("blur", foreground);
      window.removeEventListener("agentkib-read-review", review);
      window.removeEventListener("agentkib-read-refresh", refresh);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [scope, options.viewportRef, options.ready]);
  useEffect(() => {
    if (!options.supported || !options.sessionId) return;
    const generation = lifetime.current;
    const viewIsCurrent = () =>
      generation === lifetime.current &&
      renderedScope.current === scope &&
      latest.current.isCurrent?.() !== false;
    const reader: ReturnType<typeof createReadStateProbe> = createReadStateProbe({
      canRead: () =>
        viewIsCurrent() && latest.current.ready && document.visibilityState === "visible",
      canRetry: retryAtEnd,
      async read(signal, retryKind) {
        const beforeAcknowledgement = acknowledgementEpoch.current;
        const catalogVersionAtDispatch = latest.current.catalogVersion;
        const pendingReceipt = uncertainResult.current;
        const reconciling = retryKind === "reconcile" && pendingReceipt?.reconcile === true;
        if (retryKind === "reconcile" && !reconciling) return "discarded";
        const isCurrent = () =>
          !signal.aborted &&
          viewIsCurrent() &&
          (!retryKind || retryAtEnd()) &&
          beforeAcknowledgement === acknowledgementEpoch.current;
        const superseded = (state: SessionReadState) =>
          catalogReadSuperseded(catalogVersionAtDispatch, latest.current.catalogVersion, state);
        const handOffNewResult = (state: SessionReadState) => {
          if (state.freshness !== "current" || !state.latestResult) return false;
          const identity = resultIdentityOf(state);
          reader.observeReadResult(identity);
          if (pendingReceipt && pendingReceipt.id !== identity) {
            reader.reconciliationCompleted();
            uncertainResult.current = undefined;
          }
          const supersedesUpdate = updateIdentity.current && updateIdentity.current !== identity;
          if (supersedesUpdate) reader.updateCompleted();
          if (
            (reconciling && pendingReceipt?.id !== identity) ||
            (retryKind === "update" && supersedesUpdate)
          ) {
            // Proof for the new result must outlive the old result's deadline.
            reader.refresh();
            return true;
          }
          return false;
        };
        const readSignal = () => AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
        const readStateAtHost = async () =>
          (await options.client.readState(options.sessionId, readSignal())).readState;
        proofScope.current = undefined;
        try {
          const before = await readStateAtHost();
          if (!isCurrent() || superseded(before)) return "discarded";
          if (handOffNewResult(before)) return "discarded";
          const beforeIdentity = resultIdentityOf(before);
          const waitingForUpdate =
            retryKind !== "update" &&
            updateIdentity.current === beforeIdentity &&
            reader.updatePending();
          const fenced = pendingReceipt?.id === beforeIdentity || waitingForUpdate;
          const page =
            !reconciling && !fenced && canAutomaticallyAcknowledge(before)
              ? await options.client.events(options.sessionId, undefined, readSignal())
              : undefined;
          if (!isCurrent()) return "discarded";
          const readState = page ? await readStateAtHost() : before;
          if (!isCurrent() || superseded(readState)) return "discarded";
          if (page && handOffNewResult(readState)) return "discarded";
          // A replaced history can reuse a result ID without reusing its proof version.
          const verifiedEvents =
            page &&
            canAutomaticallyAcknowledge(readState) &&
            before.version === readState.version &&
            sameReadResult(before, readState)
              ? page.events
              : undefined;
          proofScope.current = verifiedEvents ? scope : undefined;
          const previous = lastState.current;
          const resultIdentity = resultIdentityOf(readState);
          const rejected = unresolvedConflict.current;
          if (
            readState.firstUnread?.type === "threadStart" &&
            ((previous?.status === "read" && resultIdentityOf(previous) === resultIdentity) ||
              attempted.current.has(resultIdentity))
          ) {
            manualUnread.current = resultIdentity;
            attempted.current.add(resultIdentity);
          }
          if (rejected && verifiedEvents) {
            if (
              canRetryReadConflict(rejected, readState) &&
              resultIdentityOf(rejected) !== deferredUpdate.current
            )
              attempted.current.delete(resultIdentityOf(rejected));
            unresolvedConflict.current = undefined;
          }
          lastState.current = readState;
          setObservation((old) => ({
            readState,
            events: verifiedEvents,
            status: "ready",
            revision: old.revision + 1,
          }));
          if (reconciling && uncertainResult.current === pendingReceipt) {
            if (
              pendingReceipt.id !== resultIdentity ||
              readState.freshness !== "current" ||
              readState.status === "unknown"
            )
              return "reconcile";
            reader.reconciliationCompleted();
            if (readState.status === "read") {
              uncertainResult.current = undefined;
              reader.updateCompleted();
              latest.current.onAcknowledged?.(readState, catalogVersionAtDispatch);
            } else pendingReceipt.reconcile = false;
            return "ready";
          }
          if (fenced) return "ready";
          return readState.freshness === "stale" ||
            (readState.status === "unread" && !verifiedEvents)
            ? "retry"
            : "ready";
        } catch (error) {
          if (!isCurrent() || latest.current.catalogVersion !== catalogVersionAtDispatch)
            return "discarded";
          const unsupported =
            typeof error === "object" &&
            error !== null &&
            "status" in error &&
            error.status === 404;
          setObservation((old) => ({
            ...old,
            events: undefined,
            status: unsupported ? "unsupported" : "unavailable",
            revision: old.revision + 1,
          }));
          if (isTemporaryReadStateError(error))
            return reconciling ? "reconcile" : uncertainResult.current ? "discarded" : "retry";
          if (reconciling) {
            pendingReceipt.reconcile = false;
            reader.reconciliationCompleted();
          }
          return "ready";
        }
      },
    });
    probe.current = reader;
    reader.refresh();
    return () => {
      if (probe.current === reader) probe.current = undefined;
      flight.current?.abort();
      reader.close();
    };
  }, [scope, options.client, options.sessionId, options.supported, retryAtEnd]);
  useEffect(() => {
    let index = options.events.length - 1;
    while (index >= 0 && options.events[index].ephemeral) index--;
    const tail = options.events[index];
    const next = tail ? eventFingerprint(tail) : undefined;
    if (renderedTail.current === next) return;
    renderedTail.current = next;
    probe.current?.refresh();
  }, [options.events]);
  useEffect(() => {
    proofScope.current = undefined;
    if (options.ready) probe.current?.refresh();
    else {
      flight.current?.abort();
      probe.current?.schedule();
    }
  }, [options.ready, options.catalogVersion]);
  useEffect(() => {
    if (!options.supported || !options.ready) return;
    const generation = lifetime.current;
    const state = observation.readState;
    const transcript = observation.events;
    // Native manual-unread changes the CAS version without producing another result.
    // A view/action may acknowledge each result once; only a new reading action
    // clears this local barrier. The fresh opaque version still goes over the wire.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    const readableAtEnd = () => {
      const current = latest.current,
        viewport = current.viewportRef.current;
      if (
        !state ||
        !transcript ||
        observation.status !== "ready" ||
        !canAutomaticallyAcknowledge(state) ||
        current.isCurrent?.() === false ||
        proofScope.current !== scope ||
        !viewport ||
        current.blocked ||
        !current.ready ||
        !readSnapshotMatches(current.events, transcript)
      )
        return;
      const result = state.latestResult;
      const anchor = readResultAnchor(transcript, result, current.activeTurnId);
      if (
        result &&
        !anchor &&
        !historyContinuesAfterResult(transcript, result, current.activeTurnId)
      )
        return;
      const resultEvent = anchor
        ? displayedResultEvent(result, anchor.turnEvents, anchor.exactItem, !!anchor.terminal)
        : undefined;
      const nodes = [...viewport.querySelectorAll<HTMLElement>("[data-event-id]")];
      const marker = [...viewport.querySelectorAll<HTMLElement>("[data-read-result]")].find(
        (node) => node.dataset.readResult === (result?.id ?? "threadStart"),
      );
      const terminalMarker = anchor?.terminal
        ? [...viewport.querySelectorAll<HTMLElement>("[data-terminal-turn-id]")]
            .reverse()
            .find(
              (node) =>
                node.dataset.terminalTurnId === anchor.turnId &&
                node.dataset.terminalOutcome === anchor.terminal,
            )
        : undefined;
      const target = resultEvent
        ? nodes.find((node) => node.dataset.eventId === resultEvent.id)
        : (terminalMarker ?? marker);
      if (!result && state.firstUnread?.type !== "threadStart") return;
      if (target?.querySelector('[data-message-image-pending="true"]')) return;
      if (!result) {
        // Manual-unread threads use a separate terminal marker. Their latest
        // displayed message still needs to show its images before that marker
        // can prove reading; older off-screen attachments do not block it.
        const latestMessage = [...transcript]
          .reverse()
          .filter((event) => event.kind === "user-message" || resultBody(event))
          .map((event) => nodes.find((node) => node.dataset.eventId === event.id))
          .find((node) => node !== undefined);
        if (latestMessage?.querySelector('[data-message-image-pending="true"]')) return;
      }
      const intent = reviewIntent;
      const catalogVersion =
        current.catalogVersion === undefined ? state.version : current.catalogVersion;
      if (
        target &&
        intent?.id === current.sessionId &&
        intent.source === state.source &&
        intent.catalogVersion === catalogVersion &&
        intent.resultId === (result?.id ?? null) &&
        intent.context === (current.reviewContext ?? current.client) &&
        intent.expiresAt > Date.now()
      ) {
        reviewIntent = undefined;
        target.scrollIntoView?.({ block: "center", behavior: "auto" });
      }
      return readingAtEnd(viewport);
    };
    const check = () => {
      probe.current?.schedule();
      const resultIdentity = state && resultIdentityOf(state);
      if (
        !state ||
        !resultIdentity ||
        generation !== lifetime.current ||
        renderedScope.current !== scope ||
        flight.current ||
        attempted.current.has(resultIdentity) ||
        !readableAtEnd()
      ) {
        clearTimeout(timer);
        timer = undefined;
        return;
      }
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void (async () => {
          if (
            generation !== lifetime.current ||
            flight.current ||
            attempted.current.has(resultIdentity) ||
            !readableAtEnd()
          )
            return;
          if (updateIdentity.current !== resultIdentity) {
            updateIdentity.current = resultIdentity;
            probe.current?.updateCompleted();
          } else if (probe.current?.canFinishUpdate() === false) {
            deferredUpdate.current = resultIdentity;
            attempted.current.add(resultIdentity);
            return;
          }
          attempted.current.add(resultIdentity);
          const controller = new AbortController();
          flight.current = controller;
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]);
          const catalogVersionAtDispatch = latest.current.catalogVersion;
          const retryUpdate = () => {
            if (probe.current?.retryUpdate()) return true;
            deferredUpdate.current = resultIdentity;
            return false;
          };
          try {
            const result = await options.client.acknowledgeReadState(
              options.sessionId,
              state.version!,
              state.latestResult?.id ?? null,
              signal,
            );
            if (
              generation !== lifetime.current ||
              renderedScope.current !== scope ||
              latest.current.isCurrent?.() === false
            )
              return;
            // A probe begun before this write settled cannot replace its newer result.
            // This includes GET reconciliation after an unknown write response.
            acknowledgementEpoch.current++;
            if (!result.acknowledged) proofScope.current = undefined;
            const catalogAdvanced = catalogReadSuperseded(
              catalogVersionAtDispatch,
              latest.current.catalogVersion,
              result.readState,
            );
            const settled =
              result.acknowledged ||
              (result.readState.status === "read" && result.readState.freshness === "current");
            if (result.conflict && !settled) {
              if (catalogAdvanced) unresolvedConflict.current = state;
              else if (result.readState.firstUnread?.type === "threadStart") {
                if (resultIdentityOf(result.readState) === resultIdentity)
                  manualUnread.current = resultIdentity;
              } else if (retryUpdate()) {
                if (canRetryReadConflict(state, result.readState))
                  attempted.current.delete(resultIdentity);
                else unresolvedConflict.current = state;
              }
            } else if (!settled) {
              const reconcile =
                !controller.signal.aborted &&
                (catalogAdvanced ||
                  result.readState.freshness !== "current" ||
                  result.readState.status === "unknown");
              uncertainResult.current = { id: resultIdentity, reconcile };
              if (reconcile) probe.current?.retryReconcile();
            }
            if (!catalogAdvanced) {
              lastState.current = result.readState;
              setObservation((old) => ({
                ...old,
                readState: result.readState,
                events: result.acknowledged ? old.events : undefined,
                revision: old.revision + 1,
              }));
            }
            if (catalogAdvanced) probe.current?.refresh();
            if (settled) {
              probe.current?.updateCompleted();
              if (!catalogAdvanced)
                latest.current.onAcknowledged?.(result.readState, catalogVersionAtDispatch);
            }
          } catch (error) {
            if (
              generation !== lifetime.current ||
              renderedScope.current !== scope ||
              latest.current.isCurrent?.() === false
            )
              return;
            acknowledgementEpoch.current++;
            proofScope.current = undefined;
            if (isRetryableReadStateUpdateError(error)) {
              if (retryUpdate()) attempted.current.delete(resultIdentity);
            } else if (error instanceof ReadStateReconciliationError && error.conflict) {
              unresolvedConflict.current = state;
              if (isTemporaryReadStateError(error.cause)) retryUpdate();
            } else {
              const reconcile =
                !controller.signal.aborted &&
                ((error instanceof ReadStateReconciliationError &&
                  isTemporaryReadStateError(error.cause)) ||
                  (signal.aborted && isTemporaryReadStateError(error)));
              uncertainResult.current = { id: resultIdentity, reconcile };
              if (reconcile) probe.current?.retryReconcile();
            }
            if (
              !controller.signal.aborted &&
              latest.current.catalogVersion === catalogVersionAtDispatch
            )
              setObservation((old) => ({
                ...old,
                events: undefined,
                status: "unavailable",
                revision: old.revision + 1,
              }));
          } finally {
            if (flight.current === controller) flight.current = undefined;
          }
        })();
      }, 200);
    };
    const schedule = () => {
      if (!retryAtEnd()) flight.current?.abort();
      probe.current?.schedule();
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    };
    const viewport = options.viewportRef.current;
    viewport?.addEventListener("scroll", schedule);
    viewport?.addEventListener("wheel", schedule, { passive: true });
    viewport?.addEventListener("touchmove", schedule, { passive: true });
    viewport?.addEventListener("pointerdown", schedule);
    viewport?.addEventListener("keydown", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("focus", schedule);
    window.addEventListener("blur", schedule);
    document.addEventListener("visibilitychange", schedule);
    const mutation = new MutationObserver(schedule);
    if (viewport)
      mutation.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "aria-modal",
          "open",
          "data-open",
          "hidden",
          "data-message-image-pending",
        ],
      });
    schedule();
    return () => {
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      mutation.disconnect();
      viewport?.removeEventListener("scroll", schedule);
      viewport?.removeEventListener("wheel", schedule);
      viewport?.removeEventListener("touchmove", schedule);
      viewport?.removeEventListener("pointerdown", schedule);
      viewport?.removeEventListener("keydown", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("focus", schedule);
      window.removeEventListener("blur", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [
    scope,
    observation,
    options.blocked,
    options.supported,
    options.events,
    options.ready,
    options.client,
    options.sessionId,
    options.activeTurnId,
    options.viewportRef,
    retryAtEnd,
  ]);
  return observation;
}
