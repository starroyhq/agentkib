import { useId, useRef, useState } from "react";
import { loadEarlierHistoryBatch, oldestIncompleteHistoryTurn } from "@agentkib/conversation-state";
import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import { useI18n } from "@/core/useI18n";
import { api } from "@/core/api";
import { readRemoteHistory } from "@/features/remote/remote-catalog-store";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";
import type {
  ConversationEvent,
  ConversationEventPage,
  ConversationSessionSummary,
} from "@/core/types";
import { sessionKeys } from "./session-query";

export function useSessionHistory(
  session: ConversationSessionSummary | undefined,
  enabled: boolean,
  revision = 0,
) {
  const { localizeMessage } = useI18n();
  const client = useOptionalQueryClient();
  const observerId = useId();
  const sessionId = enabled && session?.availability === "readable" ? session.id : "";
  const queryKey = [
    ...sessionKeys.history(
      session?.workspace_id ?? "",
      sessionId,
      session?.remote ? [session.remote.host_id, session.remote.original_id] : null,
      revision,
    ),
    observerId,
  ];
  const scope = JSON.stringify(queryKey);
  const earlierFlight = useRef<{ scope: string }>(undefined);
  const [earlierScope, setEarlierScope] = useState<string>();
  const query = useInfiniteQuery(
    {
      ...queryDefaults,
      queryKey,
      queryFn: async ({ pageParam, signal }) => {
        const page = session?.remote
          ? await (pageParam ? readRemoteHistory(session, pageParam) : readRemoteHistory(session))
          : await (pageParam
              ? api.sessionEvents(sessionId, pageParam)
              : api.sessionEvents(sessionId));
        signal.throwIfAborted();
        return page;
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.next_cursor ?? undefined,
      enabled: !!sessionId,
      staleTime: Infinity,
      gcTime: 0,
    },
    client,
  );
  const pages = sessionId ? (query.data?.pages ?? []) : [];
  const seen = new Set<string>();
  const events: ConversationEvent[] = [...pages]
    .reverse()
    .flatMap((page) => page.events)
    .filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });
  const warnings = [
    ...new Set(
      pages.flatMap((page, index) =>
        page.warnings.filter(
          (warning) => warning !== "TRANSCRIPT_SCAN_BUDGET" || index === pages.length - 1,
        ),
      ),
    ),
  ];
  const rawError = sessionId && !query.isFetching ? query.error : null;
  const oldestPage = pages.at(-1);
  const nextCursor = oldestPage?.next_cursor;
  const historyDetailTurnId = oldestIncompleteHistoryTurn(oldestPage && { ...oldestPage, events });
  return {
    key: sessionId ? JSON.stringify([session?.workspace_id, sessionId, revision]) : "",
    events,
    warnings,
    loading: !!sessionId && query.isPending,
    loadingEarlier: !!sessionId && (earlierScope === scope || query.isFetchingNextPage),
    nextCursor,
    historyDetailTurnId,
    rawError: rawError ?? "",
    error: rawError ? localizeMessage(rawError) : "",
    loadEarlier: async (turnId?: string) => {
      const entry = client.getQueryCache().find({ queryKey, exact: true });
      if (
        !sessionId ||
        !nextCursor ||
        !entry?.getObserversCount() ||
        entry.state.fetchStatus !== "idle" ||
        earlierFlight.current?.scope === scope ||
        (turnId && turnId !== historyDetailTurnId)
      )
        return;
      const flight = { scope };
      earlierFlight.current = flight;
      setEarlierScope(scope);
      try {
        await loadEarlierHistoryBatch(
          nextCursor,
          events,
          async (cursor) => {
            if (
              earlierFlight.current !== flight ||
              !entry.getObserversCount() ||
              entry.state.fetchStatus !== "idle"
            )
              return;
            const before = client.getQueryData<InfiniteData<ConversationEventPage>>(queryKey);
            if (before?.pages.at(-1)?.next_cursor !== cursor) return;
            const result = await query.fetchNextPage({ cancelRefetch: false });
            if (
              earlierFlight.current !== flight ||
              !entry.getObserversCount() ||
              result.isFetchNextPageError ||
              !result.data ||
              result.data.pages.length <= before.pages.length
            )
              return;
            return result.data.pages.at(-1);
          },
          turnId,
        );
      } finally {
        if (earlierFlight.current === flight) {
          earlierFlight.current = undefined;
          setEarlierScope(undefined);
        }
      }
    },
    retry: async () => {
      if (
        !sessionId ||
        client.getQueryState(queryKey)?.fetchStatus !== "idle" ||
        client.getQueryCache().find({ queryKey, exact: true })?.getObserversCount() === 0
      )
        return;
      await client.resetQueries({ queryKey, exact: true });
    },
  };
}
