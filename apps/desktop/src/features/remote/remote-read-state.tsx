import { useMemo, type RefObject } from "react";
import {
  readStateCopy,
  transcriptRepresentsResult,
  useVisibleReadState,
} from "@agentkib/session-ui";
import {
  ApiError,
  ReadStateReconciliationError,
  REMOTE_ERROR_CODES,
  serializeReadStateReads,
} from "@agentkib/web-client";
import { api } from "@/core/api";
import type { ConversationEvent, ConversationSessionSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { parseRemoteEvents, parseRemoteReadState } from "./remote-payload";
import { refreshRemoteCatalog } from "./remote-catalog-store";

function peerReadError(error: unknown): never {
  if (error instanceof Error) {
    // Electron preserves the peer's error code as the last part of the message.
    if (/(?:^|: )REMOTE_READ_STATE_UNSUPPORTED$/.test(error.message))
      throw new ApiError(404, REMOTE_ERROR_CODES.readStateUnsupported);
    if (/(?:^|: )REMOTE_(?:OFFLINE|DISCONNECTED|READ_STATE_UNAVAILABLE)$/.test(error.message))
      throw new ApiError(503, REMOTE_ERROR_CODES.readStateUnavailable);
  }
  throw error;
}

export function remoteReadStateClient(hostId: string, sessionId: string) {
  const readState = serializeReadStateReads(async (_id, signal) => {
    const result = parseRemoteReadState(
      await api
        .remoteRequest({ operation: "read-state", id: hostId, sessionId })
        .catch(peerReadError),
    );
    signal?.throwIfAborted();
    return result;
  });
  return {
    async events(_id: string, cursor?: string, signal?: AbortSignal) {
      const result = parseRemoteEvents(
        await api
          .remoteRequest({ operation: "events", id: hostId, sessionId, cursor })
          .catch(peerReadError),
      );
      signal?.throwIfAborted();
      return result;
    },
    readState,
    async acknowledgeReadState(_id: string, expectedVersion: string, seenResultId: string | null) {
      try {
        const result = parseRemoteReadState(
          await api.remoteRequest({
            operation: "read-state-update",
            id: hostId,
            sessionId,
            expectedVersion,
            seenResultId,
          }),
        );
        return { ...result, acknowledged: true };
      } catch (error) {
        // Electron preserves the peer's error code as the last part of the message.
        const conflict =
          error instanceof Error && /(?:^|: )REMOTE_READ_STATE_CONFLICT$/.test(error.message);
        // IPC/TLS loss may follow persistence. Only read back; never repeat this update.
        try {
          const result = await readState(_id);
          return {
            ...result,
            acknowledged: false,
            ...(conflict ? { conflict: true as const } : {}),
          };
        } catch (cause) {
          throw new ReadStateReconciliationError(cause, conflict);
        }
      }
    },
  };
}

export function HistoryReadState({
  session,
  events,
  ready,
  viewportRef,
}: {
  session: ConversationSessionSummary;
  events: ConversationEvent[];
  ready: boolean;
  viewportRef: RefObject<HTMLElement | null>;
}) {
  const { locale } = useI18n();
  const source = session.remote;
  const client = useMemo(
    () => remoteReadStateClient(source?.host_id ?? "", source?.original_id ?? ""),
    [source?.host_id, source?.original_id],
  );
  const observation = useVisibleReadState({
    client,
    sessionId: session.id,
    reviewContext: `remote:${source?.host_id}`,
    scope: `remote:${source?.host_id ?? "unsupported"}`,
    source: session.readState?.source,
    catalogVersion: session.readState?.version,
    supported: !!source && !!session.readState,
    ready: ready && !!source?.online,
    blocked: false,
    events,
    viewportRef,
    onAcknowledged: () => {
      if (source) void refreshRemoteCatalog(source.host_id, true);
    },
  });
  const copy = readStateCopy(locale);
  return (
    <>
      {observation.status === "ready" &&
        observation.events &&
        observation.readState?.freshness === "current" &&
        observation.readState.status !== "unknown" &&
        !transcriptRepresentsResult(events, observation.readState.latestResult) && (
          <p
            data-read-result={observation.readState.latestResult?.id ?? "threadStart"}
            className="text-xs text-muted-foreground"
          >
            {observation.readState.latestResult
              ? copy[observation.readState.latestResult.outcome]
              : !events.length
                ? copy.empty
                : observation.readState.firstUnread?.type === "threadStart"
                  ? copy.manualUnread
                  : null}
          </p>
        )}
    </>
  );
}
