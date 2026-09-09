import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  Languages,
  MonitorSmartphone,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Unlink,
  X,
} from "lucide-react";
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
import { SafeMarkdown, Transcript, toolStatusLabel } from "@agentkib/session-ui";
import { QuestionForm, interactionCopy } from "./QuestionForm";
import { AgentMark, agentName } from "@agentkib/agent-identity";
import { displaySessionTitle } from "@agentkib/session-catalog";
import { SessionCatalog, type CatalogWorkspace } from "./SessionCatalog";
import { catalogCopy } from "./catalog-copy";
import { dictionaries, type Locale } from "./i18n";
import { HostedConnection } from "./HostedConnection";
import { PairingLayout } from "./PairingLayout";
const MAX_MESSAGE_LENGTH = 16_000;
const MAX_MESSAGE_BYTES = 16_384;
const messageEncoder = new TextEncoder();
function isValidMessage(message: string) {
  const text = message.trim();
  return (
    !!text &&
    message.length <= MAX_MESSAGE_LENGTH &&
    messageEncoder.encode(message).byteLength <= MAX_MESSAGE_BYTES
  );
}
export function Dialog({
  title,
  closeLabel,
  onClose,
  children,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
        <button onClick={onClose} aria-label={closeLabel}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function App() {
  if (import.meta.env.MODE === "hosted") return <HostedConnection />;
  return <SessionApp />;
}
export function mergeLatestPage(
  previous: ConversationEventPage | undefined,
  latest: ConversationEventPage,
): ConversationEventPage {
  if (!previous || latest.events.length === 0) return latest;
  const first = previous.events.findIndex((event) => event.id === latest.events[0].id);
  return first < 0
    ? latest
    : {
        events: [...previous.events.slice(0, first), ...latest.events],
        next_cursor: previous.next_cursor,
        warnings: [...new Set([...previous.warnings, ...latest.warnings])],
      };
}
export function SessionApp({
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
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = accent;
  }, [locale, theme, accent]);
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
  useEffect(() => {
    if (!selected || access?.status !== "approved") return;
    const id = selected,
      g = generation.current;
    let closed = false;
    const onSnapshot = (data: string) => {
      if (closed || g !== generation.current || selection.current !== id) return;
      try {
        const state = JSON.parse(data) as Live;
        if (state.sessionId !== id) return;
        setLive(state);
        setOnline(true);
      } catch {
        setOnline(false);
      }
    };
    const onUnavailable = () => {
      if (!closed && g === generation.current) {
        clear();
        setError(true);
      }
    };
    const onEnded = () => {
      if (closed || g !== generation.current) return;
      if (origin) client.reset();
      clear();
      accessRef.current = {
        status: "ended",
        csrfToken: "",
        bootId: "",
        experimentalEnabled: false,
      };
      setAccess(accessRef.current);
    };
    const onOpen = () => {
      void (async () => {
        try {
          const next = await syncAccess();
          if (closed || g !== generation.current || next?.status !== "approved") return;
          const state = await client.live(id);
          if (!closed && g === generation.current && selection.current === id) {
            setLive(state);
            setOnline(true);
            if (origin) await refresh();
          }
        } catch (e) {
          if (!closed) fail(e, g);
        }
      })();
    };
    const onError = () => {
      if (!closed && g === generation.current) {
        setOnline(false);
        if (origin) {
          readinessEpoch.current++;
          refreshRequired.current = true;
          setControlReady(false);
        }
      }
    };
    const closeStream = client.stream(id, {
      open: onOpen,
      error: onError,
      event: (type, data) => {
        if (type === "snapshot") onSnapshot(data);
        else if (type === "unavailable") onUnavailable();
        else if (type === "access-ended") onEnded();
      },
    });
    return () => {
      closed = true;
      closeStream();
    };
  }, [selected, access?.status, syncAccess, clear, fail, client, origin, refresh]);
  useEffect(() => {
    if (!selected || !online || !live) return;
    const id = selected,
      g = generation.current;
    const timer = setTimeout(() => {
      void client
        .events(id)
        .then((latest) => {
          if (g !== generation.current || selection.current !== id) return;
          setPage((previous) => {
            if (!previous) return latest;
            const first = previous.events.findIndex((e) => e.id === latest.events[0]?.id);
            return first >= 0
              ? {
                  events: [...previous.events.slice(0, first), ...latest.events],
                  next_cursor: previous.next_cursor,
                  warnings: [...new Set([...previous.warnings, ...latest.warnings])],
                }
              : latest;
          });
        })
        .catch((e) => fail(e, g));
    }, 500);
    return () => clearTimeout(timer);
  }, [selected, live?.revision, online, fail]);
  async function choose(id: string) {
    if (selection.current === id) return;
    if (sessions.find((session) => session.id === id)?.availability !== "readable") return;
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
  }
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
            : { turnId: question!.turnId, questionId: question!.requestId, answers }),
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
  const icon = <span className="brand-mark">K</span>;
  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          {icon}
          <div>
            <strong>AgentKib</strong>
            <small>{t.remote}</small>
          </div>
          <span className="badge">Web</span>
        </div>
        <button aria-label={t.preferences} onClick={() => setModal("preferences")}>
          <Settings2 size={19} />
        </button>
      </header>
      {origin && (
        <div className="banner lan-connection-banner">
          <span>
            {origin} · {t.lanPlaintextShort}
          </span>
          <button onClick={disconnect}>{t.changeBackend}</button>
        </div>
      )}
      {error && (
        <div role="alert" className="banner danger">
          {origin ? (incompatible ? t.lanIncompatible : t.lanFailure) : t.error}{" "}
          <button
            onClick={() => {
              setIncompatible(false);
              void refresh(true);
            }}
          >
            {t.retry}
          </button>
        </div>
      )}
      {!access ? (
        <main className="center">
          <p role="status">{t.loading}</p>
        </main>
      ) : access.status === "unpaired" ? (
        <PairingLayout words={t}>
          <div className="hero-icon">
            <MonitorSmartphone size={30} />
          </div>
          <h1>{t.pairTitle}</h1>
          <p>{t.pairInfo}</p>
          <form onSubmit={pair}>
            <label>
              {t.code}
              <input
                className="code"
                value={code}
                inputMode="numeric"
                pattern="[0-9]{8}"
                minLength={8}
                maxLength={8}
                autoComplete="one-time-code"
                required
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
            </label>
            <label>
              {t.name}
              <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </label>
            <aside className="info">
              <ShieldCheck size={19} />
              <span>{t.scope}</span>
            </aside>
            <button className="primary" disabled={busy || code.length !== 8}>
              {t.pair}
              <ChevronRight size={17} />
            </button>
          </form>
          <small className="muted">{t.safety}</small>
        </PairingLayout>
      ) : access.status === "pending" ? (
        <PairingLayout words={t} pending>
          <div className="hero-icon amber">
            <ShieldCheck size={30} />
          </div>
          <h1>{t.pending}</h1>
          <p>{t.verify}</p>
          <strong className="verification">{access.pending?.verification}</strong>
          {access.pending?.expiresAt && (
            <small>
              {t.expires} {new Date(access.pending.expiresAt).toLocaleString(locale)}
            </small>
          )}
          <aside className="info">{t.scope}</aside>
          <button onClick={() => void post("pair/cancel", {})} disabled={busy}>
            {t.cancel}
          </button>
        </PairingLayout>
      ) : access.status === "ended" ? (
        <main className="pair-page">
          <div className="hero-icon red">
            <Unlink size={30} />
          </div>
          <h1>{t.ended}</h1>
          <p>{t.endedInfo}</p>
          <button
            className="primary"
            onClick={() => (origin ? disconnect?.() : void post("logout", {}))}
          >
            {t.again}
          </button>
        </main>
      ) : (
        <div className={`workspace ${selected ? "has-selection" : ""}`}>
          <aside className="catalog">
            <header>
              <h1>{t.sessions}</h1>
              <button aria-label={t.refresh} onClick={() => void refresh(true)}>
                <RefreshCw size={18} />
              </button>
            </header>
            <SessionCatalog
              pendingSessions={pendingSessions}
              sessions={sessions}
              workspaces={workspaces}
              selected={selected}
              onSelect={(id) => void choose(id)}
              locale={locale}
              indexEnabled={indexEnabled}
            />
            <footer>
              <small>
                {t.device}: {access.device?.name}
              </small>
              <button onClick={() => void post("logout", {})}>{t.logout}</button>
            </footer>
          </aside>
          <main className="reader">
            {!selected ? (
              <div className="center">
                <MonitorSmartphone size={34} />
                <h2>{t.select}</h2>
                <p>{t.selectInfo}</p>
              </div>
            ) : (
              <>
                <header className="reader-header">
                  <button
                    aria-label={t.back}
                    onClick={() => {
                      generation.current++;
                      selection.current = "";
                      setSelected("");
                      setPage(undefined);
                      setLive(undefined);
                      setModal(undefined);
                    }}
                  >
                    <ArrowLeft size={18} />
                  </button>
                  <AgentMark agent={current?.agent} size={20} />
                  <div className="reader-heading">
                    <h1
                      aria-label={`${agentName(current?.agent)} · ${currentTitle}`}
                      title={currentTitle}
                    >
                      {currentTitle}
                    </h1>
                    <small title={currentWorkspace?.path}>
                      {currentWorkspace?.name || c.missing}
                    </small>
                  </div>
                  <button aria-label={t.details} onClick={() => setModal("metadata")}>
                    <Settings2 size={18} />
                  </button>
                  <button aria-label={t.refresh} onClick={() => void refresh(true)}>
                    <RefreshCw size={18} />
                  </button>
                </header>
                <div className="reader-state">
                  <span>{t.history}</span>
                  <span className={online ? "" : "warning"}>
                    {online ? `${t.live} · ${liveText}` : t.offline}
                  </span>
                </div>
                <section className="reader-scroll" ref={scroll}>
                  {current?.agent === "claude-code" && (
                    <aside className="banner info">{t.managedResumeInfo}</aside>
                  )}
                  {page?.warnings.length ? (
                    <aside className="banner warning">
                      {t.warnings}: {page.warnings.join(" · ")}
                    </aside>
                  ) : null}
                  {page?.next_cursor && (
                    <button className="earlier" disabled={busy} onClick={() => void earlier()}>
                      {t.earlier}
                    </button>
                  )}
                  {!page ? (
                    <p role="status">{t.loading}</p>
                  ) : (
                    <Transcript
                      key={selected}
                      events={page.events}
                      incomplete={page.warnings.length > 0}
                      labels={t}
                      onTool={setModal}
                      locale={locale}
                    />
                  )}
                  {live?.streamText && live.status !== "idle" && (
                    <article aria-label={t.streamingReply}>
                      <small>{t.streamingReply}</small>
                      <SafeMarkdown text={live.streamText} />
                    </article>
                  )}
                </section>
                {live?.approvals.map((a) => (
                  <button key={a.requestId} className="approval-banner" onClick={() => setModal(a)}>
                    <ShieldCheck size={19} />
                    {t.approval}
                    <ChevronRight size={18} />
                  </button>
                ))}
                {live?.questions?.map((q) => (
                  <button key={q.requestId} className="approval-banner" onClick={() => setModal(q)}>
                    {interactionCopy[locale].title}
                    <ChevronRight size={18} />
                  </button>
                ))}
                {notice && (
                  <p role="status" className="notice">
                    {t[notice]}
                  </p>
                )}
                {(current?.agent === "codex" || current?.agent === "claude-code") &&
                access.experimentalEnabled &&
                access.device?.send ? (
                  <form
                    className="composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (canSend && isValidMessage(message)) void control("send");
                    }}
                  >
                    <label className="sr-only" htmlFor="message">
                      {t.message}
                    </label>
                    <textarea
                      id="message"
                      value={message}
                      maxLength={MAX_MESSAGE_LENGTH}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder={t.message}
                      disabled={!online || busy}
                    />
                    <div>
                      <small>
                        {t.experimental} · {t.controlInfo}
                      </small>
                      <button
                        className="send"
                        aria-label={t.send}
                        disabled={!canSend || !isValidMessage(message)}
                      >
                        <ArrowUp size={20} />
                      </button>
                    </div>
                  </form>
                ) : (
                  <footer className="readonly">
                    {(current?.agent === "codex" || current?.agent === "claude-code") &&
                    access.experimentalEnabled &&
                    access.device?.approve
                      ? t.noSendPermission
                      : t.readOnly}
                  </footer>
                )}
              </>
            )}
          </main>
        </div>
      )}
      {modal === "preferences" && (
        <Dialog closeLabel={t.close} title={t.preferences} onClose={() => setModal(undefined)}>
          <div className="preferences">
            <label>
              <Languages size={16} />
              {t.language}
              <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
                <option value="zh-CN">简体中文</option>
                <option value="zh-TW">繁體中文</option>
                <option value="en-US">English</option>
                <option value="ja-JP">日本語</option>
              </select>
            </label>
            <label>
              {t.theme}
              <select value={theme} onChange={(e) => setTheme(e.target.value)}>
                <option value="system">{t.system}</option>
                <option value="light">{t.light}</option>
                <option value="dark">{t.dark}</option>
              </select>
            </label>
            <label>
              {t.accent}
              <select value={accent} onChange={(e) => setAccent(e.target.value)}>
                <option value="blue">{t.blue}</option>
                <option value="violet">{t.violet}</option>
                <option value="green">{t.green}</option>
              </select>
            </label>
          </div>
        </Dialog>
      )}
      {modal === "metadata" && (
        <Dialog closeLabel={t.close} title={t.metadata} onClose={() => setModal(undefined)}>
          <dl>
            <dt>{t.agent}</dt>
            <dd>{agentName(current?.agent)}</dd>
            <dt>{c.project}</dt>
            <dd>{currentWorkspace?.name || c.missing}</dd>
            <dt>{c.path}</dt>
            <dd>{currentWorkspace?.path || c.unknown}</dd>
            <dt>{c.updated}</dt>
            <dd>{formatCatalogTime(current?.updated_at)}</dd>
            <dt>{c.created}</dt>
            <dd>{formatCatalogTime(current?.created_at)}</dd>
            <dt>{c.branch}</dt>
            <dd>{current?.git_branch || c.unknown}</dd>
            <dt>{c.source}</dt>
            <dd>
              {current?.origin === "auxiliary"
                ? c.auxiliarySource
                : current?.origin === "interactive"
                  ? c.interactive
                  : c.unknown}
            </dd>
            {current?.forked_from_session_id && (
              <>
                <dt>{c.fork}</dt>
                <dd>{sourceTitle(current.forked_from_session_id)}</dd>
              </>
            )}
            {current?.spawned_by_session_id && (
              <>
                <dt>{c.spawned}</dt>
                <dd>{sourceTitle(current.spawned_by_session_id)}</dd>
              </>
            )}
            <dt>{t.workspaceId}</dt>
            <dd>{current?.workspace_id}</dd>
            <dt>{t.sessionId}</dt>
            <dd>{current?.id}</dd>
            <dt>{t.status}</dt>
            <dd>{online ? liveText : t.unknown}</dd>
          </dl>
          <p>{t.scope}</p>
        </Dialog>
      )}
      {typeof modal === "object" && "kind" in modal && (
        <Dialog closeLabel={t.close} title={t.tool} onClose={() => setModal(undefined)}>
          <h3>{modal.tool_name || t.unknownTool}</h3>
          <p>{toolStatusLabel(modal.tool_status, locale)}</p>
          {modal.timestamp && <time>{new Date(modal.timestamp).toLocaleString(locale)}</time>}
          <pre>{modal.content || t.history}</pre>
          {modal.truncated && <p>{t.truncated}</p>}
        </Dialog>
      )}
      {typeof modal === "object" && "questions" in modal && (
        <Dialog
          closeLabel={t.close}
          title={interactionCopy[locale].title}
          onClose={() => setModal(undefined)}
        >
          <QuestionForm
            key={`${selected}:${modal.turnId}:${modal.requestId}`}
            request={modal}
            locale={locale}
            busy={busy}
            enabled={
              !!(
                modal.supported &&
                access?.experimentalEnabled &&
                access.device?.send &&
                online &&
                controlReady &&
                live?.questions?.some((q) => JSON.stringify(q) === JSON.stringify(modal))
              )
            }
            onSubmit={(answers) => void control("answer", undefined, undefined, modal, answers)}
          />
        </Dialog>
      )}
      {typeof modal === "object" && "requestId" in modal && !("questions" in modal) && (
        <Dialog closeLabel={t.close} title={t.approval} onClose={() => setModal(undefined)}>
          <p>{modal.method === "claude/can_use_tool" ? t.claudeDecisionInfo : t.decisionInfo}</p>
          {modal.method === "claude/can_use_tool" && <h3>{modal.toolName || t.unknownTool}</h3>}
          {modal.environmentId === "local" && <p>{t.localExecution}</p>}
          {modal.cwd && (
            <dl>
              <dt>{t.cwd}</dt>
              <dd>{modal.cwd}</dd>
            </dl>
          )}
          <pre>
            {JSON.stringify(
              modal.method === "claude/can_use_tool"
                ? (modal.input ?? null)
                : (modal.command ?? modal.changes ?? null),
              null,
              2,
            )}
          </pre>
          {modal.method === "claude/can_use_tool" && modal.context && (
            <aside className="info">
              <p>{t.claudeContextInfo}</p>
              <pre>{JSON.stringify(modal.context, null, 2)}</pre>
            </aside>
          )}
          {modal.method !== "claude/can_use_tool" && modal.proposedExecpolicyAmendment && (
            <aside className="info policy-proposal">
              <p>{t.policyProposal}</p>
              <pre>{JSON.stringify(modal.proposedExecpolicyAmendment, null, 2)}</pre>
            </aside>
          )}
          {modal.supported &&
          access?.experimentalEnabled &&
          access.device?.approve &&
          controlReady &&
          online &&
          live?.approvals.some((a) => JSON.stringify(a) === JSON.stringify(modal)) ? (
            <div className="decision-actions">
              {modal.availableDecisions
                .filter((d) =>
                  (modal.method === "claude/can_use_tool"
                    ? ["allow", "deny"]
                    : ["accept", "decline", "cancel"]
                  ).includes(d),
                )
                .map((d) => (
                  <button
                    key={d}
                    className={d === "accept" || d === "allow" ? "primary" : ""}
                    disabled={busy}
                    onClick={() => void control("approve", modal, d)}
                  >
                    {(d === "accept" || d === "allow") && <Check size={16} />}{" "}
                    {d === "cancel" ? t.cancelTurn : t[d]}
                  </button>
                ))}
            </div>
          ) : (
            <aside className="info">{t.approvalFallback}</aside>
          )}
        </Dialog>
      )}
    </div>
  );
}
