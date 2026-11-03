import { useEffect, useRef, useState, type RefObject } from "react";

/** Structural wire type keeps this presentation package independent of host implementations. */
export interface SessionReadState {
  source: "codex-native" | "agentkib";
  status: "read" | "unread" | "unknown";
  freshness: "current" | "stale";
  version: string | null;
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
  turn_id?: string | null;
  ephemeral?: boolean;
  kind: string;
  content?: string;
  message_phase?: string | null;
  cli_output?: boolean;
  attachment_count?: number;
};
export interface ReadStateClient {
  readState(id: string, signal?: AbortSignal): Promise<{ readState: SessionReadState }>;
  acknowledgeReadState(
    id: string,
    version: string,
    resultId: string | null,
    signal?: AbortSignal,
  ): Promise<{ readState: SessionReadState; acknowledged: boolean }>;
  events(
    id: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{ events: ReadEvent[]; warnings: string[] }>;
}
export function readStateCopy(locale: string) {
  const values =
    locale === "zh-TW"
      ? [
          "待查看",
          "未讀",
          "已完成",
          "失敗",
          "已取消",
          "已結束",
          "更新電腦端以同步已讀狀態",
          "已讀狀態暫不可用",
          "已讀狀態可能已過期",
          "僅在 AgentKib 中同步已讀狀態",
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
            "更新电脑端以同步已读状态",
            "已读状态暂不可用",
            "已读状态可能已过期",
            "仅在 AgentKib 中同步已读状态",
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
              "既読状態を同期するにはホストを更新してください",
              "既読状態を取得できません",
              "既読状態が古い可能性があります",
              "既読状態は AgentKib 内でのみ同期されます",
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
              "Update the host to sync read state",
              "Read state unavailable",
              "Read state may be out of date",
              "Read state syncs within AgentKib only",
              "Empty session",
              "Unread conversation",
            ];
  const [
    pending,
    unread,
    completed,
    failed,
    cancelled,
    ended,
    unsupported,
    unavailable,
    stale,
    fallback,
    empty,
    manualUnread,
  ] = values;
  return {
    pending,
    unread,
    completed,
    failed,
    cancelled,
    ended,
    unsupported,
    unavailable,
    stale,
    fallback,
    empty,
    manualUnread,
  };
}

/** Navigation intent is transient and never marks a session read. */
let reviewIntent:
  | {
      id: string;
      source: string;
      version: string | null;
      context?: object | string;
      expiresAt: number;
    }
  | undefined;
export function requestReadReview(id: string, state: SessionReadState, context?: object | string) {
  reviewIntent = {
    id,
    source: state.source,
    version: state.version,
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

/** Requires actual geometry and a hit test; mounted, off-screen and covered rows do not count. */
export function visibleReadTarget(viewport: HTMLElement, target: HTMLElement): boolean {
  if (document.visibilityState !== "visible" || !document.hasFocus() || !target.isConnected)
    return false;
  if (document.querySelector('[aria-modal="true"], dialog[open]')) return false;
  const box = target.getBoundingClientRect(),
    clip = viewport.getBoundingClientRect();
  const left = Math.max(box.left, clip.left, 0),
    right = Math.min(box.right, clip.right, window.innerWidth);
  const top = Math.max(box.top, clip.top, 0),
    bottom = Math.min(box.bottom, clip.bottom, window.innerHeight);
  if (right <= left || bottom <= top || getComputedStyle(target).visibility === "hidden")
    return false;
  if (typeof document.elementFromPoint !== "function") return false;
  const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
  return !!hit && (target === hit || target.contains(hit));
}

type Observation = {
  readState?: SessionReadState;
  events?: ReadEvent[];
  status: "loading" | "ready" | "unsupported" | "unavailable";
  revision: number;
};
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
  events: readonly ReadEvent[];
  viewportRef: RefObject<HTMLElement | null>;
  subscribe?: (listener: (userAction?: boolean) => void) => () => void;
  onAcknowledged?: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [observation, setObservation] = useState<Observation>({ status: "loading", revision: 0 });
  const [wake, setWake] = useState(0);
  const lifetime = useRef(0);
  const acknowledgementEpoch = useRef(0);
  const proofScope = useRef<string | undefined>(undefined);
  const inhibited = useRef(false);
  const attempted = useRef(new Set<string>());
  const flight = useRef(false);
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
    inhibited.current = false;
    attempted.current.clear();
    flight.current = false;
    setObservation({ status: options.supported ? "loading" : "unsupported", revision: 0 });
  }, [scope, options.client, options.supported]);
  useEffect(
    () =>
      options.supported
        ? options.subscribe?.((userAction) => {
            if (userAction) {
              inhibited.current = false;
              attempted.current.clear();
            }
            setWake((n) => n + 1);
          })
        : undefined,
    [options.subscribe, options.supported],
  );
  useEffect(() => {
    const userAction = () => {
      inhibited.current = false;
      attempted.current.clear();
      setWake((n) => n + 1);
    };
    const foreground = () => {
      // Resume observation only. A lost ACK still needs an explicit reading action.
      if (document.visibilityState === "visible" && document.hasFocus()) setWake((n) => n + 1);
    };
    const review = () => {
      const intent = reviewIntent,
        current = latest.current;
      if (
        intent?.id === current.sessionId &&
        intent.context === (current.reviewContext ?? current.client) &&
        intent.expiresAt > Date.now()
      )
        userAction();
    };
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ context: object | string; sessionId?: string }>)
          .detail,
        current = latest.current;
      if (
        detail?.context === (current.reviewContext ?? current.client) &&
        (!detail.sessionId || detail.sessionId === current.sessionId)
      )
        userAction();
    };
    const viewport = options.viewportRef.current;
    const formTarget = (event: Event) =>
      event.target instanceof Element &&
      !!event.target.closest(
        "input,textarea,select,button,[role=button],[contenteditable]:not([contenteditable=false])",
      );
    const bodyClick = (event: Event) => {
      if (!formTarget(event)) userAction();
    };
    const readKey = (event: KeyboardEvent) => {
      if (
        !formTarget(event) &&
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
      )
        userAction();
    };
    viewport?.addEventListener("pointerdown", bodyClick);
    viewport?.addEventListener("wheel", bodyClick, { passive: true });
    viewport?.addEventListener("touchmove", bodyClick, { passive: true });
    viewport?.addEventListener("keydown", readKey);
    window.addEventListener("focus", foreground);
    window.addEventListener("agentkib-read-review", review);
    window.addEventListener("agentkib-read-refresh", refresh);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      viewport?.removeEventListener("pointerdown", bodyClick);
      viewport?.removeEventListener("wheel", bodyClick);
      viewport?.removeEventListener("touchmove", bodyClick);
      viewport?.removeEventListener("keydown", readKey);
      window.removeEventListener("focus", foreground);
      window.removeEventListener("agentkib-read-review", review);
      window.removeEventListener("agentkib-read-refresh", refresh);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [scope, options.viewportRef, options.ready]);
  useEffect(() => {
    if (
      !options.supported ||
      !options.ready ||
      !options.sessionId ||
      document.visibilityState !== "visible"
    )
      return;
    const abort = new AbortController(),
      generation = lifetime.current,
      beforeAcknowledgement = acknowledgementEpoch.current;
    let active = true;
    // Coalesce native item batches, without polling or involving command admission.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (beforeAcknowledgement !== acknowledgementEpoch.current) return;
          proofScope.current = undefined;
          const before = (await options.client.readState(options.sessionId, abort.signal))
            .readState;
          const page = await options.client.events(options.sessionId, undefined, abort.signal);
          const { readState } = await options.client.readState(options.sessionId, abort.signal);
          const stable =
            before.source === readState.source &&
            before.version === readState.version &&
            before.freshness === "current";
          if (
            !active ||
            generation !== lifetime.current ||
            beforeAcknowledgement !== acknowledgementEpoch.current ||
            renderedScope.current !== scope ||
            latest.current.isCurrent?.() === false
          )
            return;
          proofScope.current = scope;
          setObservation((old) => ({
            readState,
            events: !stable || page.warnings.length ? undefined : page.events,
            status: "ready",
            revision: old.revision + 1,
          }));
        } catch (error) {
          if (
            !active ||
            generation !== lifetime.current ||
            beforeAcknowledgement !== acknowledgementEpoch.current ||
            abort.signal.aborted
          )
            return;
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
        }
      })();
    }, 100);
    return () => {
      active = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [
    scope,
    options.client,
    options.supported,
    options.ready,
    options.events,
    options.catalogVersion,
    wake,
  ]);
  useEffect(() => {
    const generation = lifetime.current;
    const state = observation.readState;
    if (
      observation.status !== "ready" ||
      !state ||
      !state.version ||
      state.status !== "unread" ||
      state.freshness !== "current" ||
      !observation.events
    )
      return;
    // Native manual-unread changes the CAS version without producing another result.
    // A view/action may acknowledge each result once; only a new reading action
    // clears this local barrier. The fresh opaque version still goes over the wire.
    const resultIdentity = JSON.stringify([state.source, state.latestResult?.id ?? null]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    const findTarget = () => {
      const current = latest.current,
        viewport = current.viewportRef.current;
      if (
        current.isCurrent?.() === false ||
        proofScope.current !== scope ||
        !viewport ||
        current.blocked ||
        !current.ready ||
        !readSnapshotMatches(current.events, observation.events!)
      )
        return;
      const result = state.latestResult;
      const resultBody = (event: ReadEvent) =>
        event.kind === "agent-message" &&
        event.message_phase !== "commentary" &&
        (!!event.content?.trim() || !!event.attachment_count || event.cli_output === true);
      const exactItem = result?.itemId
        ? observation.events!.find((event) => event.id === result.itemId)
        : undefined;
      const resultEvent =
        exactItem && resultBody(exactItem)
          ? exactItem
          : result?.turnId
            ? [...observation.events!]
                .reverse()
                .find((event) => event.turn_id === result.turnId && resultBody(event))
            : undefined;
      const nodes = [...viewport.querySelectorAll<HTMLElement>("[data-event-id]")];
      const marker = [...viewport.querySelectorAll<HTMLElement>("[data-read-result]")].find(
        (node) => node.dataset.readResult === (result?.id ?? "threadStart"),
      );
      const target = resultEvent
        ? nodes.find((node) => node.dataset.eventId === resultEvent.id)
        : marker;
      // Known but unloaded items cannot be replaced with metadata. Tool/thinking-only
      // turns instead require their actual terminal marker to enter the viewport.
      if (result?.itemId && !exactItem) return;
      if (!result && state.firstUnread?.type !== "threadStart") return;
      if (!target) return;
      const intent = reviewIntent;
      if (
        intent?.id === current.sessionId &&
        intent.source === state.source &&
        intent.version === state.version &&
        intent.context === (current.reviewContext ?? current.client) &&
        intent.expiresAt > Date.now()
      ) {
        reviewIntent = undefined;
        target.scrollIntoView?.({ block: "center", behavior: "auto" });
      }
      return visibleReadTarget(viewport, target) ? target : undefined;
    };
    const check = () => {
      clearTimeout(timer);
      if (
        generation !== lifetime.current ||
        renderedScope.current !== scope ||
        inhibited.current ||
        flight.current ||
        attempted.current.has(resultIdentity)
      )
        return;
      if (!findTarget()) return;
      timer = setTimeout(() => {
        void (async () => {
          if (
            generation !== lifetime.current ||
            inhibited.current ||
            flight.current ||
            attempted.current.has(resultIdentity) ||
            !findTarget()
          )
            return;
          attempted.current.add(resultIdentity);
          flight.current = true;
          try {
            const result = await options.client.acknowledgeReadState(
              options.sessionId,
              state.version!,
              state.latestResult?.id ?? null,
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
            if (!result.acknowledged) inhibited.current = true;
            setObservation((old) => ({
              ...old,
              readState: result.readState,
              events: result.acknowledged ? old.events : undefined,
              revision: old.revision + 1,
            }));
            if (result.acknowledged) latest.current.onAcknowledged?.();
          } catch {
            if (
              generation !== lifetime.current ||
              renderedScope.current !== scope ||
              latest.current.isCurrent?.() === false
            )
              return;
            acknowledgementEpoch.current++;
            inhibited.current = true;
            setObservation((old) => ({
              ...old,
              events: undefined,
              status: "unavailable",
              revision: old.revision + 1,
            }));
          } finally {
            if (generation === lifetime.current) flight.current = false;
          }
        })();
      }, 200);
    };
    const schedule = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    };
    const viewport = options.viewportRef.current;
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule);
    const mutation = new MutationObserver(schedule);
    if (viewport)
      mutation.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-modal", "open", "hidden"],
      });
    schedule();
    return () => {
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      mutation.disconnect();
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [
    scope,
    observation,
    options.blocked,
    options.events,
    options.ready,
    options.client,
    options.sessionId,
    options.viewportRef,
  ]);
  return observation;
}

export function ReadStateNotice({
  locale,
  observation,
}: {
  locale: string;
  observation: { status: Observation["status"]; readState?: SessionReadState };
}) {
  const copy = readStateCopy(locale),
    state = observation.readState;
  const label = [
    observation.status === "unsupported"
      ? copy.unsupported
      : observation.status === "unavailable"
        ? copy.unavailable
        : state?.freshness === "stale" || state?.status === "unknown"
          ? copy.stale
          : null,
    state?.source === "agentkib" ? copy.fallback : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return label ? (
    <p role="status" className="mx-auto mb-3 w-full max-w-3xl text-xs text-muted-foreground">
      {label}
    </p>
  ) : null;
}
