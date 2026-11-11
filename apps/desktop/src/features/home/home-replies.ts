import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  replyToInteraction,
  settledReceipt,
  stopSessionTurn,
  type Access,
  type InteractionReply,
  type InteractionReplyPending,
  type InteractionReplyResult,
  type WebClient,
} from "@agentkib/web-client";
import { createDesktopConversationClient } from "@/core/conversation-bridge";
import {
  forgetPending,
  pendingScope,
  readPending,
  rememberPending,
  subscribePending,
  type PendingControl,
} from "@/features/sessions/conversation/features/sessions/pending-controls";

/** How long an answered request stays off the home while the catalog catches up. */
const ANSWERED_GRACE = 15_000;
const WAITING = new Set(["awaiting-approval", "waiting-input"]);

export interface HomeReplies {
  client: WebClient;
  access?: Omit<Access, "bearerToken">;
  /** Sessions whose last control may or may not have run; the home lists them as to verify. */
  unconfirmed: ReadonlySet<string>;
  /** Sessions answered from the home that the catalog still reports as waiting. */
  answered: ReadonlySet<string>;
  reply: (
    session: { id: string; agent: string },
    reply: InteractionReply,
  ) => Promise<InteractionReplyResult>;
  /** Stops the session's running turn, with the same checks and kept identity as a decision. */
  stop: (session: { id: string; agent: string }) => Promise<InteractionReplyResult>;
  /** The session no longer waits for anything this home showed. */
  markAnswered: (sessionId: string) => void;
}

/**
 * Answering approvals and questions from the home or the menu bar, and stopping a turn from the
 * menu bar: the same checks and kept identities as the session view, through
 * `replyToInteraction` and `stopSessionTurn`. A control whose outcome is unknown is never sent
 * again; its session is listed as to verify until the host's receipt settles it.
 */
export function useHomeReplies(
  sessions: readonly { id: string; continuation?: { status: string } }[],
): HomeReplies {
  const [client] = useState(createDesktopConversationClient);
  const [access, setAccess] = useState<Omit<Access, "bearerToken">>();
  useEffect(() => {
    let cancelled = false;
    // Without access the cards only show their requests.
    client.access().then(
      (value) => {
        if (!cancelled) setAccess(value);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client]);
  const scope =
    access?.status === "approved" && access.device?.id
      ? pendingScope(client.origin, access.device.id)
      : undefined;
  const [kept, setKept] = useState<PendingControl[]>([]);
  useEffect(() => {
    if (!scope) return;
    const read = () => {
      try {
        setKept(readPending(scope));
      } catch {
        setKept([]);
      }
    };
    read();
    return subscribePending(read);
  }, [scope]);

  // While a decision is on its way its identity is kept, but its outcome is not unknown yet.
  const [replying, setReplying] = useState<ReadonlySet<string>>(() => new Set());
  const replyingRef = useRef(replying);
  useEffect(() => {
    replyingRef.current = replying;
  });
  const [lost, setLost] = useState<ReadonlySet<string>>(() => new Set());
  const [answeredAt, setAnsweredAt] = useState<ReadonlyMap<string, number>>(() => new Map());

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    // A kept approval or answer settles once the host's receipt says whether it ran.
    const settle = async () => {
      let entries: PendingControl[];
      try {
        entries = readPending(scope).filter(
          (entry) =>
            (entry.kind === "approve" || entry.kind === "answer" || entry.kind === "stop") &&
            !!entry.sessionId &&
            !replyingRef.current.has(entry.sessionId),
        );
      } catch {
        return;
      }
      for (const entry of entries) {
        try {
          const outcome = settledReceipt(await client.receipt(entry.requestId), entry);
          if (cancelled) return;
          if (outcome) forgetPending(scope, entry.requestId);
        } catch {
          // The identity stays until a receipt settles it.
        }
      }
    };
    void settle();
    const stop = window.desktopConversation?.onControlChanged(() => void settle());
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [scope, client]);

  // An answered session leaves this set once the catalog no longer reports it waiting, or when
  // the grace period ends. The pruning runs from a timer: at once when something is already over.
  useEffect(() => {
    if (!answeredAt.size) return;
    const still = (id: string, at: number) =>
      Date.now() - at < ANSWERED_GRACE &&
      WAITING.has(sessions.find((session) => session.id === id)?.continuation?.status ?? "");
    const over = [...answeredAt].some(([id, at]) => !still(id, at));
    const ends = Math.min(...answeredAt.values()) + ANSWERED_GRACE;
    const timer = setTimeout(
      () => setAnsweredAt((current) => new Map([...current].filter(([id, at]) => still(id, at)))),
      over ? 0 : Math.max(0, ends - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [answeredAt, sessions]);

  const send = useCallback(
    async (
      session: { id: string; agent: string },
      control: (pending: InteractionReplyPending | undefined) => Promise<InteractionReplyResult>,
    ) => {
      setReplying((current) => new Set(current).add(session.id));
      try {
        const result = await control(
          scope
            ? {
                remember: (entry) => rememberPending(scope, entry),
                forget: (requestId) => forgetPending(scope, requestId),
              }
            : undefined,
        );
        // Without a kept identity only this page remembers that the outcome is unknown.
        if (result.status === "unknown" && !result.durable)
          setLost((current) => new Set(current).add(session.id));
        return result;
      } finally {
        setReplying((current) => {
          const next = new Set(current);
          next.delete(session.id);
          return next;
        });
      }
    },
    [scope],
  );
  const reply = useCallback(
    (session: { id: string; agent: string }, value: InteractionReply) =>
      send(session, (pending) => replyToInteraction(client, session, value, pending)),
    [client, send],
  );
  const stop = useCallback(
    (session: { id: string; agent: string }) =>
      send(session, (pending) => stopSessionTurn(client, session, pending)),
    [client, send],
  );
  const markAnswered = useCallback(
    (sessionId: string) => setAnsweredAt((current) => new Map(current).set(sessionId, Date.now())),
    [],
  );

  const unconfirmed = useMemo(
    () =>
      new Set([
        ...kept.flatMap((entry) =>
          entry.sessionId && !replying.has(entry.sessionId) ? [entry.sessionId] : [],
        ),
        ...lost,
      ]),
    [kept, replying, lost],
  );
  const answered = useMemo(() => new Set(answeredAt.keys()), [answeredAt]);
  return { client, access, unconfirmed, answered, reply, stop, markAnswered };
}
