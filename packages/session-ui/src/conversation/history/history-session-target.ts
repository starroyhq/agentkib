import type {
  ConversationSessionSummary,
  HistoryLocatedRecord,
  HistoryLocation,
} from "@agentkib/web-client";

export const historyLocationKey = (location: HistoryLocation) =>
  JSON.stringify([
    location.sessionId,
    location.recordId,
    location.chunkId,
    location.sourceRevision,
  ]);

/** An aborted reader may never settle; its cleanup must not release a newer attempt. */
export function createHistoryOpenLock() {
  let current: { generation: number; signal: AbortSignal } | undefined;
  return {
    isPending: (generation: number) =>
      current?.generation === generation && !current.signal.aborted,
    start: (generation: number, signal: AbortSignal) => {
      const operation = { generation, signal };
      current = operation;
      return () => {
        if (current === operation) current = undefined;
      };
    },
  };
}

/** Only the current host catalog can turn an indexed identity into a readable session route. */
export function historySessionTarget(
  record: HistoryLocatedRecord,
  sessions: ConversationSessionSummary[],
  isSessionVisible: (session: ConversationSessionSummary) => boolean,
): ConversationSessionSummary | undefined {
  const visible = sessions.filter(
    (session) =>
      isSessionVisible(session) &&
      session.availability === "readable" &&
      session.workspace_id === record.workspaceId &&
      session.agent === record.agent,
  );
  const exact = visible.filter((session) => session.id === record.location.sessionId);
  if (exact.length === 1) return exact[0];
  if (exact.length) return undefined;
  const aliases = visible.filter(
    (session) =>
      session.origin === "interactive" &&
      (session.indexedSessionId === record.location.sessionId ||
        session.indexedSessionIds?.includes(record.location.sessionId)),
  );
  return aliases.length === 1 ? aliases[0] : undefined;
}
