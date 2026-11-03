import { useMemo, type RefObject } from "react";
import { ReadStateNotice, readStateCopy, useVisibleReadState } from "@agentkib/session-ui";
import { api } from "@/core/api";
import type { ConversationEvent, ConversationSessionSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { parseRemoteEvents, parseRemoteReadState } from "./remote-payload";
import { refreshRemoteCatalog } from "./remote-catalog-store";

export function remoteReadStateClient(hostId: string, sessionId: string) {
  return {
    async events(_id: string, cursor?: string, signal?: AbortSignal) {
      const result = parseRemoteEvents(
        await api.remoteRequest({ operation: "events", id: hostId, sessionId, cursor }),
      );
      signal?.throwIfAborted();
      return result;
    },
    async readState(_id: string, signal?: AbortSignal) {
      const result = parseRemoteReadState(
        await api.remoteRequest({ operation: "read-state", id: hostId, sessionId }),
      );
      signal?.throwIfAborted();
      return result;
    },
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
      } catch {
        // IPC/TLS loss may follow persistence. Only read back; never repeat this update.
        const result = parseRemoteReadState(
          await api.remoteRequest({ operation: "read-state", id: hostId, sessionId }),
        );
        return { ...result, acknowledged: false };
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
      <ReadStateNotice locale={locale} observation={observation} />
      {observation.status === "ready" &&
        observation.events &&
        observation.readState?.freshness === "current" && (
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
