import { mergeOrderedPersistedHistory } from "@agentkib/conversation-state";
import { ApiError, type ConversationEventPage, type WebClient } from "@agentkib/web-client";
import { Button } from "@base-ui/react/button";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InteractionLocale } from "./interaction-model";
import { LoadingSkeleton } from "./loading-feedback";
import { SessionTranscript } from "./session-transcript";

const historyCopy = {
  "zh-CN": {
    back: "返回活动列表",
    loading: "正在加载记录…",
    empty: "暂无记录",
    unavailable: "无法读取记录",
    earlierError: "无法加载更早记录",
    earlier: "加载更早记录",
    retry: "重试",
    process: "执行过程",
    tools: "次工具调用",
    failed: "失败",
    attachments: "附件数量",
    truncated: "内容已截断",
    unknownTool: "工具",
  },
  "zh-Hant": {
    back: "返回活動列表",
    loading: "正在載入記錄…",
    empty: "暫無記錄",
    unavailable: "無法讀取記錄",
    earlierError: "無法載入較早記錄",
    earlier: "載入較早記錄",
    retry: "重試",
    process: "執行過程",
    tools: "次工具呼叫",
    failed: "失敗",
    attachments: "附件數量",
    truncated: "內容已截斷",
    unknownTool: "工具",
  },
  "ja-JP": {
    back: "アクティビティ一覧に戻る",
    loading: "記録を読み込み中…",
    empty: "記録はありません",
    unavailable: "記録を読み込めませんでした",
    earlierError: "以前の記録を読み込めませんでした",
    earlier: "以前の記録を読み込む",
    retry: "再試行",
    process: "実行過程",
    tools: "回のツール呼び出し",
    failed: "失敗",
    attachments: "添付数",
    truncated: "内容が切り詰められています",
    unknownTool: "ツール",
  },
  "en-US": {
    back: "Back to activities",
    loading: "Loading history…",
    empty: "No records yet",
    unavailable: "History could not be loaded",
    earlierError: "Earlier records could not be loaded",
    earlier: "Load earlier records",
    retry: "Retry",
    process: "Execution process",
    tools: "tool calls",
    failed: "Failed",
    attachments: "Attachments",
    truncated: "Content truncated",
    unknownTool: "Tool",
  },
} satisfies Record<InteractionLocale, Record<string, string>>;

type ActivityPage = Omit<ConversationEventPage, "next_cursor"> & {
  version: 1;
  sessionId: string;
  subagentId: string;
  epoch: string;
  next_cursor?: string | null;
};

type HistoryScope = { client: WebClient; sessionId: string; childId: string };
type HistoryView = HistoryScope & { page?: ActivityPage; loading?: boolean; error?: boolean };

export function SessionActivityHistory({
  client,
  sessionId,
  childId,
  title,
  locale,
  onClose,
}: HistoryScope & { title: string; locale: InteractionLocale; onClose: () => void }) {
  const copy = historyCopy[locale];
  const back = useRef<HTMLButtonElement>(null);
  const pending = useRef<AbortController | undefined>(undefined);
  const [view, setView] = useState<HistoryView>();
  const current =
    view?.client === client && view.sessionId === sessionId && view.childId === childId
      ? view
      : undefined;
  const page = current?.page;
  const loading = !current || current.loading === true;

  const read = useCallback(
    async (previous?: ActivityPage) => {
      if (pending.current) return;
      const request = new AbortController();
      pending.current = request;
      const scope = { client, sessionId, childId };
      const query = new URLSearchParams({ sessionId, subagentId: childId });
      const cursor = previous?.next_cursor;
      if (cursor) query.set("cursor", cursor);
      setView({ ...scope, page: previous, loading: true });
      try {
        const signal = AbortSignal.any([
          request.signal,
          AbortSignal.timeout(client.connection.type === "lan-http" ? 15_000 : 25_000),
        ]);
        const result = await client.request<ActivityPage>(
          `subagent/events?${query}`,
          undefined,
          signal,
        );
        if (request.signal.aborted) return;
        if (
          result?.version !== 1 ||
          result.sessionId !== sessionId ||
          result.subagentId !== childId ||
          typeof result.epoch !== "string" ||
          !Array.isArray(result.events)
        ) {
          setView({ ...scope, error: true });
          return;
        }
        if (previous && result.epoch !== previous.epoch) {
          setView({ ...scope, error: true });
          return;
        }
        setView({
          ...scope,
          page: {
            ...result,
            events: previous
              ? mergeOrderedPersistedHistory(previous.events, result.events, "older")
              : result.events,
            next_cursor: result.next_cursor === cursor ? null : result.next_cursor,
          },
        });
      } catch (error) {
        if (request.signal.aborted) return;
        // Drop records if access ended or the loaded window can no longer be paged safely.
        const discard =
          error instanceof ApiError &&
          ([401, 403, 404].includes(error.status) ||
            ["invalid_cursor", "stale_cursor", "stale_boot"].includes(error.code));
        setView({ ...scope, page: discard ? undefined : previous, error: true });
      } finally {
        if (pending.current === request) pending.current = undefined;
      }
    },
    [client, childId, sessionId],
  );

  useEffect(() => {
    back.current?.focus();
    void read();
    return () => {
      pending.current?.abort();
      pending.current = undefined;
    };
  }, [read]);

  return (
    <section aria-label={title} className="min-w-0">
      <header className="sticky top-0 z-10 flex min-w-0 items-center gap-2 border-b border-border/60 bg-background px-2 py-1">
        <Button
          ref={back}
          type="button"
          aria-label={copy.back}
          title={copy.back}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"
          onClick={onClose}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </Button>
        <h3 title={title} className="truncate text-sm font-medium">
          {title}
        </h3>
      </header>
      <div className="min-w-0 space-y-3 px-3 py-3">
        {loading && !page && <LoadingSkeleton label={copy.loading} />}
        {current?.error && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-xs text-destructive-text">
              {page ? copy.earlierError : copy.unavailable}
            </p>
            {!page && (
              <Button
                type="button"
                className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => void read()}
              >
                {copy.retry}
              </Button>
            )}
          </div>
        )}
        {page && (
          <SessionTranscript
            events={page.events}
            labels={copy}
            locale={locale}
            incomplete={!!page.next_cursor || page.warnings?.includes("SUBAGENT_LIVE_WINDOW")}
            hasEarlier={!!page.next_cursor}
            loadingEarlier={loading}
            earlierLabel={copy.earlier}
            onLoadEarlier={() => read(page)}
          />
        )}
        {page && !page.events.length && !page.next_cursor && (
          <p className="text-xs text-muted-foreground">{copy.empty}</p>
        )}
      </div>
    </section>
  );
}
