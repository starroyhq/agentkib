import { useEffect, type Dispatch, type SetStateAction, type RefObject } from "react";
import {
  ApiError,
  type Access,
  type ConversationSessionSummary,
  type ConversationEventPage,
  type Live,
  type WebClient,
} from "@agentkib/web-client";
type Setter<T> = Dispatch<SetStateAction<T>>;
interface LiveSyncOptions {
  sessions: ConversationSessionSummary[];
  setPendingSessions: Setter<Record<string, boolean>>;
  watchedSessions: RefObject<Set<string>>;
  watchEpoch: RefObject<number>;
  access: Access | undefined;
  selected: string;
  selection: RefObject<string>;
  generation: RefObject<number>;
  client: WebClient;
  fail: (error: unknown, generation?: number) => void;
  clear: () => void;
  origin: string;
  accessRef: RefObject<Access | undefined>;
  syncAccess: () => Promise<Access | undefined>;
  setLive: Setter<Live | undefined>;
  setOnline: Setter<boolean>;
  setError: Setter<boolean>;
  refresh: (manual?: boolean) => Promise<void>;
  readinessEpoch: RefObject<number>;
  refreshRequired: RefObject<boolean>;
  setControlReady: Setter<boolean>;
  setAccess: Setter<Access | undefined>;
  online: boolean;
  live: Live | undefined;
  setPage: Setter<ConversationEventPage | undefined>;
}
export function useSessionLive({
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
}: LiveSyncOptions) {
  useEffect(() => {
    const readable = new Set(
      sessions.filter((s) => s.availability === "readable").map((s) => s.id),
    );
    for (const id of watchedSessions.current) {
      if (!readable.has(id)) watchedSessions.current.delete(id);
    }
    setPendingSessions((previous) => {
      const entries = Object.entries(previous).filter(([id]) => readable.has(id));
      return entries.length === Object.keys(previous).length
        ? previous
        : Object.fromEntries(entries);
    });
  }, [sessions, watchedSessions, setPendingSessions]);
  useEffect(() => {
    if (access?.status !== "approved") return;
    let closed = false;
    let polling = false;
    let cursor = 0;
    let inFlight: AbortController | undefined;
    // Monitor previously opened sessions without opening a stream/probe for the
    // entire catalog. Rotate at most two reads per tick, below the device limit.
    const timer = setInterval(() => {
      if (closed || polling) return;
      const epoch = watchEpoch.current;
      polling = true;
      void (async () => {
        try {
          const ids = [...watchedSessions.current].filter((id) => id !== selection.current);
          for (let i = 0; i < Math.min(2, ids.length); i++) {
            const id = ids[cursor++ % ids.length];
            const g = generation.current;
            const controller = new AbortController();
            inFlight = controller;
            const timeout = setTimeout(() => controller.abort(), 15000);
            try {
              const state = await client.live(id, controller.signal);
              if (closed || epoch !== watchEpoch.current) return;
              if (g !== generation.current) continue;
              if (!watchedSessions.current.has(id)) continue;
              if (id !== selection.current)
                setPendingSessions((previous) => ({
                  ...previous,
                  [id]:
                    state.sessionId === id &&
                    (state.approvals.length > 0 || !!state.questions?.length),
                }));
            } catch (e) {
              if (closed || epoch !== watchEpoch.current) return;
              if (g !== generation.current) continue;
              // An unavailable snapshot is not evidence of a pending request.
              setPendingSessions((previous) => ({ ...previous, [id]: false }));
              if (e instanceof ApiError && e.code === "access_ended") {
                fail(e);
                return;
              }
            } finally {
              clearTimeout(timeout);
              inFlight = undefined;
            }
          }
        } finally {
          polling = false;
        }
      })();
    }, 4000);
    return () => {
      closed = true;
      inFlight?.abort();
      clearInterval(timer);
    };
  }, [
    access?.status,
    client,
    fail,
    watchedSessions,
    selection,
    watchEpoch,
    generation,
    setPendingSessions,
  ]);
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
  }, [
    selected,
    access?.status,
    syncAccess,
    clear,
    fail,
    client,
    origin,
    refresh,
    setControlReady,
    selection,
    setOnline,
    setLive,
    readinessEpoch,
    refreshRequired,
    generation,
    accessRef,
    setError,
    setAccess,
  ]);
  useEffect(() => {
    if (!selected || !online || live?.revision === undefined) return;
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
  }, [selected, live?.revision, online, fail, client, generation, selection, setPage]);
}
