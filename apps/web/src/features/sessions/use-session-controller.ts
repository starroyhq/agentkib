import { useSessionLive } from "./use-session-live";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  WebClient,
  type Access,
  type Approval,
  type ConversationEvent,
  type ConversationEventPage,
  type ConversationSessionSummary,
  type Decision,
  type Live,
  type UserQuestionRequest,
} from "@agentkib/web-client";
import { displaySessionTitle } from "@agentkib/session-catalog";
import { answerRequestBody, interactionCopy } from "@/features/interactions/question-form";
import type { CatalogWorkspace } from "@/features/catalog/session-catalog";
import { catalogCopy } from "@/features/catalog/catalog-copy";
import { dictionaries, type Locale } from "@/i18n";
import { isValidMessage, mergeLatestPage } from "./session-model";
import { useAppearance } from "@/features/preferences/use-appearance";
export function useSessionController({
  origin = "",
  disconnect,
  initialLocale = "zh-CN",
  initialTheme = "system",
}: {
  origin?: string;
  disconnect?: () => void;
  initialLocale?: Locale;
  initialTheme?: string;
}) {
  const [client] = useState(() => new WebClient(undefined, origin));
  const [locale, setLocale] = useState<Locale>(initialLocale),
    [theme, setTheme] = useState(initialTheme),
    [accent, setAccent] = useState("blue");
  const t = dictionaries[locale];
  const c = catalogCopy[locale];
  const [access, setAccess] = useState<Access>(),
    [sessions, setSessions] = useState<ConversationSessionSummary[]>([]),
    [workspaces, setWorkspaces] = useState<CatalogWorkspace[]>(),
    [selected, setSelected] = useState(""),
    [page, setPage] = useState<ConversationEventPage>(),
    [live, setLive] = useState<Live>(),
    [online, setOnline] = useState(false),
    [controlReady, setControlReady] = useState(false),
    [indexEnabled, setIndexEnabled] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [incompatible, setIncompatible] = useState(false),
    [notice, setNotice] = useState<"accepted" | "uncertain" | "notDispatched">(),
    [code, setCode] = useState(""),
    [name, setName] = useState(""),
    [message, setMessage] = useState(""),
    [modal, setModal] = useState<
      "preferences" | "metadata" | ConversationEvent | Approval | UserQuestionRequest
    >();
  const shownInteractions = useRef(new Set<string>());
  const receipt = useRef<
    { sessionId: string; requestId: string; turnId?: string; observedActive: boolean } | undefined
  >(undefined);
  const [pendingSessions, setPendingSessions] = useState<Record<string, boolean>>({});
  const watchedSessions = useRef(new Set<string>());
  const watchEpoch = useRef(0);
  const generation = useRef(0),
    selection = useRef(""),
    accessRef = useRef<Access | undefined>(undefined),
    scroll = useRef<HTMLElement>(null),
    mutating = useRef(false);
  const refreshRequired = useRef(false);
  const manualRefreshRequired = useRef(false);
  const readinessEpoch = useRef(0);
  const uncertainOutcome = useRef(false);
  const accessEpoch = useRef(0);
  useAppearance(locale, theme, accent);
  const clear = useCallback(() => {
    generation.current++;
    readinessEpoch.current++;
    selection.current = "";
    setSelected("");
    setSessions([]);
    setWorkspaces(undefined);
    setPage(undefined);
    setLive(undefined);
    setModal(undefined);
    setMessage("");
    setNotice(undefined);
    shownInteractions.current.clear();
    receipt.current = undefined;
    setPendingSessions({});
    watchedSessions.current.clear();
    watchEpoch.current++;
    setCode("");
    setName("");
    setOnline(false);
    setControlReady(false);
    refreshRequired.current = false;
    manualRefreshRequired.current = false;
    uncertainOutcome.current = false;
  }, []);
  const fail = useCallback(
    (e: unknown, g = generation.current) => {
      if (g !== generation.current) return;
      readinessEpoch.current++;
      if (e instanceof ApiError && e.code === "access_ended") {
        if (origin) client.reset();
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
    [clear, origin, client],
  );
  const syncAccess = useCallback(async () => {
    const g = generation.current;
    const epoch = ++accessEpoch.current;
    const next = await client.access();
    if (g !== generation.current || epoch !== accessEpoch.current) return;
    const old = accessRef.current;
    if (
      old?.status === "approved" &&
      (next.status !== "approved" ||
        old.bootId !== next.bootId ||
        old.device?.id !== next.device?.id)
    )
      clear();
    accessRef.current = next;
    if (origin && next.status === "ended") client.reset();
    setAccess(next);
    return next;
  }, [clear, client, origin]);
  const refresh = useCallback(
    async (manual = false) => {
      let g = generation.current;
      const epoch = ++readinessEpoch.current;
      // A newer access request can supersede this one. Keep the full refresh
      // pending so polling can finish it, including an explicit manual retry.
      refreshRequired.current = true;
      if (manual) manualRefreshRequired.current = true;
      setError(false);
      setControlReady(false);
      try {
        const next = await syncAccess();
        if (next?.status !== "approved") return;
        g = generation.current;
        const catalog = await client.catalog();
        if (g !== generation.current) return;
        if (!catalog.indexEnabled) {
          clear();
          setIndexEnabled(false);
          return;
        }
        setIndexEnabled(true);
        setSessions(catalog.sessions);
        setWorkspaces(catalog.workspaces);
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
          const [history, state] = await Promise.all([client.events(id), client.live(id)]);
          if (g !== generation.current || selection.current !== id) return;
          setPage((previous) => (origin ? mergeLatestPage(previous, history) : history));
          if (origin && viewport && anchorId && anchorTop !== undefined)
            requestAnimationFrame(() => {
              if (g !== generation.current || selection.current !== id) return;
              const node = Array.from(
                viewport.querySelectorAll<HTMLElement>("[data-event-id]"),
              ).find((node) => node.dataset.eventId === anchorId);
              if (node) viewport.scrollTop += node.getBoundingClientRect().top - anchorTop;
            });
          setLive(state);
        }
        setOnline(true);
        if (epoch === readinessEpoch.current) {
          if (manualRefreshRequired.current) uncertainOutcome.current = false;
          setControlReady(!uncertainOutcome.current);
          refreshRequired.current = false;
          manualRefreshRequired.current = false;
        }
      } catch (e) {
        fail(e, g);
      }
    },
    [syncAccess, fail, clear, client, origin],
  );
  useEffect(() => {
    void refresh();
    let polling = false;
    const timer = setInterval(() => void refreshAccessOnly(), 4000);
    async function refreshAccessOnly() {
      if (origin && accessRef.current?.status === "ended") return;
      if (polling) return;
      polling = true;
      let g = generation.current;
      try {
        const before = accessRef.current?.status;
        const next = await syncAccess();
        g = generation.current;
        if (next?.status === "approved" && refreshRequired.current) {
          await refresh();
          return;
        }
        if (next?.status === "approved" && before !== "approved") void refresh();
        else if (next?.status === "approved") {
          const g = generation.current;
          const catalog = await client.catalog();
          if (g !== generation.current) return;
          if (!catalog.indexEnabled) {
            clear();
            setIndexEnabled(false);
          } else {
            setIndexEnabled(true);
            setSessions(catalog.sessions);
            setWorkspaces(catalog.workspaces);
          }
        }
      } catch (e) {
        fail(e, g);
      } finally {
        polling = false;
      }
    }
    return () => {
      clearInterval(timer);
      generation.current++;
    };
  }, [refresh, syncAccess, fail, clear, client, origin]);
  useSessionLive({
    sessions,
    setPendingSessions,
    watchedSessions,
    watchEpoch,
    access,
    selected,
    selection,
    generation,
    client,
    fail,
    clear,
    origin,
    accessRef,
    syncAccess,
    setLive,
    setOnline,
    setError,
    refresh,
    readinessEpoch,
    refreshRequired,
    setControlReady,
    setAccess,
    online,
    live,
    setPage,
  });
  const choose = useCallback(
    async (id: string) => {
      if (selection.current === id) return;
      if (sessions.find((session) => session.id === id)?.availability !== "readable") return;
      watchedSessions.current.add(id);
      generation.current++;
      selection.current = id;
      setSelected(id);
      setPage(undefined);
      setLive(undefined);
      setModal(undefined);
      setMessage("");
      setNotice(undefined);
      setOnline(false);
      setControlReady(false);
      setError(false);
      const g = generation.current;
      try {
        const [history, state] = await Promise.all([client.events(id), client.live(id)]);
        if (g !== generation.current) return;
        setPage(history);
        setLive(state);
        setOnline(true);
        setControlReady(!refreshRequired.current && !uncertainOutcome.current);
        scroll.current?.scrollTo?.({ top: 0 });
      } catch (e) {
        fail(e, g);
      }
    },
    [sessions, client, fail],
  );
  async function post(path: string, body: unknown) {
    if (mutating.current) return;
    mutating.current = true;
    setBusy(true);
    setError(false);
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
    await post("pair", { code, name: name.trim() || "Web" });
    setCode("");
  }
  async function earlier() {
    if (!page?.next_cursor || busy) return;
    setBusy(true);
    const id = selected,
      g = generation.current;
    const viewport = scroll.current;
    const anchor = viewport?.querySelector<HTMLElement>("[data-event-id]");
    const top = anchor?.getBoundingClientRect().top;
    const anchorId = anchor?.dataset.eventId;
    try {
      const older = await client.events(id, page.next_cursor);
      if (g !== generation.current || selection.current !== id) return;
      setPage((current) =>
        current
          ? {
              events: [...older.events, ...current.events].filter(
                (e, i, a) => a.findIndex((x) => x.id === e.id) === i,
              ),
              next_cursor: older.next_cursor,
              warnings: [...new Set([...older.warnings, ...current.warnings])],
            }
          : older,
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
      live.turnId === pendingReceipt.turnId
    ) {
      receipt.current = undefined;
      setNotice(undefined);
    }
  }, [live, selected, notice]);
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
  async function control(
    kind: "send" | "approve" | "answer",
    approval?: Approval,
    decision?: Decision,
    question?: UserQuestionRequest,
    answers?: Record<string, string[]>,
  ) {
    if (mutating.current || !access || !live || !online || !controlReady) return;
    const text = message.trim();
    if (kind === "send" && !isValidMessage(message)) return;
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
    try {
      await client.request(kind, {
        sessionId: id,
        requestId,
        bootId: access.bootId,
        expectedRevision: live.revision,
        ...(kind === "send"
          ? { text }
          : kind === "approve"
            ? { turnId: approval!.turnId, approvalId: approval!.requestId, decision }
            : answerRequestBody(
                question!,
                answers!,
                { sessionId: id, bootId: access.bootId, expectedRevision: live.revision },
                requestId,
              )),
      });
      if (g !== generation.current) return;
      receipt.current = {
        sessionId: id,
        requestId,
        turnId:
          kind === "send" ? undefined : kind === "answer" ? question!.turnId : approval!.turnId,
        // A current native interaction already establishes an active turn,
        // even if the owner uses an unfamiliar waiting-status label.
        observedActive: kind !== "send",
      };
      setNotice("accepted");
      if (kind === "send") setMessage("");
      setModal(undefined);
      await refresh();
    } catch (e) {
      if (g === generation.current) {
        if (e instanceof ApiError && e.code === "access_ended") {
          fail(e, g);
        } else {
          setControlReady(false);
          refreshRequired.current = true;
          if (e instanceof ApiError && e.controlOutcome === "not-dispatched") {
            setNotice("notDispatched");
            await refresh();
          } else {
            // A refresh clicked while this request was pending cannot acknowledge
            // an uncertain outcome that has only just arrived.
            manualRefreshRequired.current = false;
            uncertainOutcome.current = true;
            setNotice("uncertain");
            setOnline(false);
            fail(e, g);
          }
        }
      }
    } finally {
      mutating.current = false;
      setBusy(false);
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
    !!access?.experimentalEnabled &&
    !!access.device?.send &&
    !!live?.sendEnabled &&
    live.status === "idle";
  const liveText =
    live?.reason === "control-outcome-unconfirmed"
      ? t.controlUnconfirmed
      : live?.status === "idle"
        ? t.idle
        : live?.questions?.length
          ? interactionCopy[locale].title
          : live?.status === "running"
            ? t.running
            : live?.status === "awaiting-approval" || live?.status === "waiting-approval"
              ? t.approval
              : live?.reason
                ? t.unavailable
                : t.unknown;
  const leaveSession = useCallback(() => {
    generation.current++;
    selection.current = "";
    setSelected("");
    setPage(undefined);
    setLive(undefined);
    setModal(undefined);
  }, []);
  return {
    origin,
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
    workspaces,
    selected,
    page,
    live,
    online,
    controlReady,
    indexEnabled,
    busy,
    error,
    incompatible,
    setIncompatible,
    notice,
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
    liveText,
    leaveSession,
  };
}
export type SessionController = ReturnType<typeof useSessionController>;
export type SessionOptions = Parameters<typeof useSessionController>[0];
