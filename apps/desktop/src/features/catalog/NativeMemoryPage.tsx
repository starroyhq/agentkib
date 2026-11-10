import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Copy, HelpCircle, RefreshCw, X } from "lucide-react";
import { Markdown } from "@tanstack/markdown/react";
import type { NativeMemoryDetail, NativeMemoryQuery } from "@agentkib/runtime-protocol";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";
import type { MemoryRecord, WorkspaceSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { MemoryCard } from "./MemoryCard";
import { NativeMemoryBrowser } from "./NativeMemoryBrowser";

const nativeKeys = ["native-memory"] as const;
const queryDefaults = {
  retry: false,
  staleTime: 15_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

function unsupported(error: unknown) {
  return (
    error instanceof Error &&
    /preload bridge is unavailable|unsupported|not supported|not a function|unknown (?:method|rpc)|no handler registered/i.test(
      error.message,
    )
  );
}

function unavailableFile(error: unknown) {
  // Electron's invoke bridge preserves messages but drops custom error fields.
  return (
    error instanceof Error &&
    /native-memory-file-unavailable|Native memory source changed/u.test(error.message)
  );
}

export function NativeMemoryPage({
  records,
  workspaces,
  onReload,
}: {
  records: MemoryRecord[];
  workspaces: WorkspaceSummary[];
  onReload: () => Promise<void>;
}) {
  const { tr, formatDateTime } = useI18n();
  const client = useQueryClient();
  const [source, setSource] = useState("all");
  const [workspaceId, setWorkspaceId] = useState("");
  const [search, setSearch] = useState("");
  const [keyword, setKeyword] = useState("");
  const [selection, setSelection] = useState<{
    kind: "native" | "platform";
    id: string;
    sourceId: string;
    scope: string;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [copyResult, setCopyResult] = useState<{
    id: string | null;
    state: "copied" | "error";
  } | null>(null);
  const showNative = source !== "platform";
  const showPlatform = source !== "claude";
  const scope = JSON.stringify([workspaceId, keyword, source]);
  const available =
    typeof api.nativeMemoryList === "function" && typeof api.nativeMemorySearch === "function";

  useEffect(() => {
    const timer = window.setTimeout(() => setKeyword(search.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [search]);

  const query = useInfiniteQuery({
    ...queryDefaults,
    queryKey: [...nativeKeys, "list", workspaceId, keyword],
    enabled: showNative && available,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const request: NativeMemoryQuery = {
        workspaceId: workspaceId || undefined,
        offset: pageParam,
      };
      return keyword
        ? api.nativeMemorySearch({ ...request, query: keyword })
        : api.nativeMemoryList(request);
    },
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  });
  const snapshot = query.data?.pages[0];
  const files = useMemo(() => {
    const seen = new Set<string>();
    return (query.data?.pages.flatMap((page) => page.files) ?? []).filter((file) => {
      if (seen.has(file.id)) return false;
      seen.add(file.id);
      return true;
    });
  }, [query.data]);
  const selectedSource = snapshot?.sources.find((item) => item.id === selection?.sourceId);
  const sourceReadable =
    selectedSource && !["disabled", "unavailable"].includes(selectedSource.status);
  const detailId =
    selection?.kind === "native" && selection.scope === scope && showNative && sourceReadable
      ? selection.id
      : null;
  const detail = useQuery({
    ...queryDefaults,
    queryKey: [...nativeKeys, "detail", selection?.sourceId, workspaceId, keyword, detailId],
    enabled: Boolean(detailId) && available,
    queryFn: async () => {
      try {
        return await api.nativeMemoryRead(detailId!);
      } catch (error) {
        // A confirmed removal must replace cached text, unlike a transient IO
        // failure, for which React Query retains the previous successful value.
        if (unavailableFile(error)) return null;
        throw error;
      }
    },
  });

  useEffect(() => {
    if (detailId && detail.data === null) {
      void client.invalidateQueries({ queryKey: [...nativeKeys, "list"] });
    }
  }, [client, detail.data, detailId]);

  useEffect(() => {
    // A withdrawn source is different from a transient read error. Never keep
    // its cached text on screen or allow a late RPC to restore it.
    if (selection?.kind === "native" && selection.scope === scope && snapshot && !sourceReadable) {
      client.removeQueries({ queryKey: [...nativeKeys, "detail", selection.sourceId] });
    }
  }, [client, scope, selection, snapshot, sourceReadable]);

  useEffect(() => {
    if (!available || !showNative) return;
    let live = true;
    let observing = false;
    const reportObservation = (active: boolean) => {
      if (active === observing) return;
      observing = active;
      // Old preload bridges and interrupted RPCs must not block platform review.
      void Promise.resolve()
        .then(() => api.nativeMemoryObserve(active))
        .catch(() => undefined);
    };
    const update = () => {
      const active = document.visibilityState !== "hidden" && document.hasFocus();
      reportObservation(active);
      if (active && live) void client.invalidateQueries({ queryKey: nativeKeys });
    };
    let stop: (() => void) | undefined;
    try {
      stop = desktopApi().events.onNativeMemoryChanged(() => {
        if (live && observing) void client.invalidateQueries({ queryKey: nativeKeys });
      });
    } catch {
      /* An older bridge can still show and review AgentKib records. */
    }
    update();
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      live = false;
      stop?.();
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
      reportObservation(false);
    };
  }, [available, client, showNative]);

  const filteredRecords = records.filter((record) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (
      workspaceId &&
      record.project_id !== workspaceId &&
      record.project_id !== workspace?.manifest_workspace_id
    )
      return false;
    return keyword
      .toLocaleLowerCase()
      .split(/\s+/u)
      .every((term) => record.content.toLocaleLowerCase().includes(term));
  });
  const review = async (
    id: string,
    status: "approved" | "rejected" | "invalidated",
    content?: string,
  ) => {
    await api.reviewMemory(id, status, content);
    await onReload();
  };
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshFailed(false);
    const result = await Promise.allSettled([
      Promise.resolve().then(onReload),
      ...(available && showNative ? [Promise.resolve().then(() => api.nativeMemoryRefresh())] : []),
    ]);
    setRefreshFailed(result.some((item) => item.status === "rejected"));
    await client.invalidateQueries({ queryKey: nativeKeys });
    setRefreshing(false);
  };
  const openDetail = (id: string, sourceId: string) =>
    setSelection({ kind: "native", id, sourceId, scope });
  const nativeUnsupported = !available || unsupported(query.error);

  const selectedRecord =
    selection?.kind === "platform" && selection.scope === scope && showPlatform
      ? filteredRecords.find((record) => record.id === selection.id)
      : undefined;
  const selectedKey = detailId
    ? `native:${detailId}`
    : selectedRecord
      ? `platform:${selectedRecord.id}`
      : null;
  const selectedFile = files.find((file) => file.id === detailId) ?? detail.data?.file;
  const sources = snapshot?.sources ?? [];
  const attention = sources.filter(
    (item) =>
      item.status === "error" || item.status === "unavailable" || item.stale || item.incomplete,
  );
  const readerScroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (readerScroll.current) readerScroll.current.scrollTop = 0;
  }, [selectedKey]);

  const reader = (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4">
        <div className="grid min-w-0 flex-1 gap-1">
          <h3 className="break-words text-sm font-semibold">
            {selectedRecord
              ? tr("memory.native.platformRecord")
              : selectedFile?.kind === "index"
                ? tr("memory.native.projectIndex")
                : selectedFile?.title ||
                  selectedFile?.relativePath ||
                  tr("memory.native.readOnlyShort")}
          </h3>
          {selectedFile && (
            <span className="truncate text-xs text-muted-foreground">
              {selectedFile.relativePath}
            </span>
          )}
        </div>
        {detailId && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {tr("memory.native.readOnlyShort")}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={tr("common.close")}
          onClick={() => setSelection(null)}
        >
          <X size={16} />
        </Button>
      </header>
      <div ref={readerScroll} className="native-memory-reader-scroll min-h-0 flex-1 px-5 py-5">
        {detailId && (
          <section aria-label={tr("memory.native.readOnly")} className="grid min-w-0 gap-4">
            {detail.isPending && <p role="status">{tr("common.loading")}</p>}
            {detail.data === null && (
              <p role="status" className="text-sm text-muted-foreground">
                {tr("memory.native.fileUnavailable")}
              </p>
            )}
            {detail.error && (
              <div role="alert">
                <p className="text-sm text-destructive-text">{tr("memory.native.detailError")}</p>
                <Button variant="outline" onClick={() => void detail.refetch()}>
                  {tr("common.retry")}
                </Button>
              </div>
            )}
            {detail.data && (
              <NativeDetail
                detail={detail.data}
                stale={Boolean(detail.error)}
                onOpen={openDetail}
                copyState={copyResult?.id === detailId ? copyResult.state : "idle"}
                onCopy={async (path) => {
                  try {
                    await navigator.clipboard.writeText(path);
                    setCopyResult({ id: detailId, state: "copied" });
                  } catch {
                    setCopyResult({ id: detailId, state: "error" });
                  }
                }}
              />
            )}
          </section>
        )}
        {selectedRecord && (
          <section
            aria-label={tr("memory.native.platform")}
            className="grid min-w-0 gap-4 [&_article>div]:flex [&_article>div]:flex-wrap [&_article>div]:items-center [&_article>div]:gap-2 [&_article>p]:my-5 [&_article>p]:whitespace-pre-wrap [&_article>p]:break-words [&_footer]:mt-5 [&_footer]:flex [&_footer]:flex-wrap [&_footer]:gap-2"
          >
            <MemoryCard key={selectedRecord.id} record={selectedRecord} onReview={review} />
          </section>
        )}
      </div>
    </>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Brain size={19} />
            {tr("memory.title")}
          </h2>
          <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            {showNative && (
              <span>{tr("memory.native.filesCount", { count: snapshot?.total ?? "—" })}</span>
            )}
            {showPlatform && (
              <span>
                {tr("memory.native.pendingCount", {
                  count: filteredRecords.filter((record) => record.status === "pending").length,
                })}
              </span>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          disabled={refreshing}
          onClick={() => void refresh()}
          aria-label={tr("common.refresh")}
        >
          <RefreshCw size={16} className={refreshing ? "animate-spin" : undefined} />
        </Button>
      </header>
      <div className="flex shrink-0 flex-wrap items-end gap-2">
        <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          {tr("memory.native.sourceFilter")}
          <Select
            value={source}
            onValueChange={(value) => {
              if (value !== null) setSource(String(value));
            }}
          >
            <SelectTrigger
              aria-label={tr("memory.native.sourceFilter")}
              className="h-9 max-w-48 text-foreground"
            >
              <SelectValue>
                {tr(
                  source === "all"
                    ? "memory.native.allSources"
                    : source === "claude"
                      ? "memory.native.claude"
                      : "memory.native.platform",
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tr("memory.native.allSources")}</SelectItem>
              <SelectItem value="claude">{tr("memory.native.claude")}</SelectItem>
              <SelectItem value="platform">{tr("memory.native.platform")}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          {tr("memory.native.workspaceFilter")}
          <Select
            value={workspaceId}
            onValueChange={(value) => {
              if (value !== null) setWorkspaceId(String(value));
            }}
          >
            <SelectTrigger
              aria-label={tr("memory.native.workspaceFilter")}
              className="h-9 min-w-0 max-w-60 text-foreground"
            >
              <SelectValue>
                {workspaces.find((workspace) => workspace.id === workspaceId)?.name ??
                  tr("memory.native.allWorkspaces")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{tr("memory.native.allWorkspaces")}</SelectItem>
              {workspaces.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="grid min-w-48 flex-1 gap-1 text-xs text-muted-foreground">
          {tr("memory.native.search")}
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            type="search"
            className="h-9 text-sm"
          />
        </label>
        <span
          title={tr("memory.native.searchHint")}
          aria-label={tr("memory.native.searchHelp")}
          tabIndex={0}
          className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <HelpCircle size={15} />
        </span>
      </div>
      {refreshFailed && (
        <p role="alert" className="shrink-0 text-sm text-destructive-text">
          {tr("memory.native.refreshError")}
        </p>
      )}
      {showNative && (
        <section aria-label={tr("memory.native.diagnostics")} className="shrink-0">
          <Collapsible className="rounded-lg border border-border text-xs">
            <CollapsibleTrigger
              render={
                <Button
                  variant="bare"
                  size="content"
                  className="flex w-full flex-wrap items-center justify-start gap-x-3 gap-y-1 px-3 py-2 text-muted-foreground"
                />
              }
            >
              <span className="font-medium">{tr("memory.native.diagnostics")}</span>
              <span className={attention.length ? "text-amber-700 dark:text-amber-400" : undefined}>
                {tr("memory.native.diagnosticsCount", {
                  count: sources.length,
                  issues: attention.length,
                })}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent
              keepMounted
              className="max-h-48 overflow-y-auto border-t border-border px-3 py-3"
            >
              {sources.map((item) => (
                <div
                  key={item.id}
                  className="mb-2 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1"
                >
                  <span className="min-w-0 break-all font-medium">
                    {[...new Set(item.workspaces.map((workspace) => workspace.name))].join(", ") ||
                      item.directory ||
                      tr("memory.native.claude")}
                  </span>
                  <span>{tr(`memory.native.status.${item.status}`)}</span>
                  {item.reason &&
                    ["disabled", "path-unresolved", "read-failed", "limited"].includes(
                      item.reason,
                    ) && <span>{tr(`memory.native.reason.${item.reason}`)}</span>}
                  {item.stale && <span>{tr("memory.native.stale")}</span>}
                  {item.incomplete && <span>{tr("memory.native.incomplete")}</span>}
                  {item.lastSuccessAt && <time>{formatDateTime(item.lastSuccessAt)}</time>}
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>
        </section>
      )}
      {showNative && query.error && !nativeUnsupported && (
        <p role="alert" className="shrink-0 text-sm text-destructive-text">
          {tr("memory.native.loadError")}
        </p>
      )}
      {showNative && nativeUnsupported && (
        <p role="status" className="shrink-0 text-xs text-muted-foreground">
          {tr("memory.native.unsupported")}
        </p>
      )}
      <NativeMemoryBrowser
        files={showNative ? files : []}
        sources={showNative ? sources : []}
        records={showPlatform ? filteredRecords : []}
        workspaces={workspaces}
        selectedKey={selectedKey}
        onOpenFile={openDetail}
        onOpenRecord={(id) => setSelection({ kind: "platform", id, sourceId: "platform", scope })}
        onClose={() => setSelection(null)}
        reader={reader}
        empty={
          showNative && !nativeUnsupported && query.isPending ? (
            <span role="status">{tr("common.loading")}</span>
          ) : keyword ? (
            tr("memory.native.noMatches")
          ) : (
            tr("memory.native.empty")
          )
        }
        more={
          showNative && query.hasNextPage ? (
            <Button
              className="mt-2 w-full"
              variant="outline"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage().catch(() => undefined)}
            >
              {tr(query.isFetchingNextPage ? "common.loading" : "memory.native.more")}
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

function NativeDetail({
  detail,
  stale,
  onOpen,
  copyState,
  onCopy,
}: {
  detail: NativeMemoryDetail;
  stale: boolean;
  onOpen: (id: string, sourceId: string) => void;
  copyState: "idle" | "copied" | "error";
  onCopy: (path: string) => Promise<void>;
}) {
  const { tr } = useI18n();
  const [raw, setRaw] = useState(false);
  const location = detail.source.directory
    ? `${detail.source.directory.replace(/[\\/]$/u, "")}/${detail.file.relativePath}`
    : null;
  const visibleText = detail.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
  return (
    <>
      {(stale || detail.file.stale || detail.source.stale) && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{tr("memory.native.stale")}</p>
      )}
      <Collapsible className="text-xs text-muted-foreground">
        <CollapsibleTrigger render={<Button variant="bare" size="content" className="py-1" />}>
          {tr("memory.native.location")}
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted className="grid min-w-0 gap-2 py-3">
          <p>{tr(`memory.native.${detail.file.kind}Hint`)}</p>
          {location && (
            <>
              <code className="break-all">{location}</code>
              <Button
                className="w-fit max-w-full"
                size="sm"
                variant="outline"
                onClick={() => void onCopy(location)}
              >
                <Copy size={14} />
                {tr(copyState === "copied" ? "memory.native.copied" : "memory.native.copyPath")}
              </Button>
            </>
          )}
          {copyState === "error" && <p role="alert">{tr("memory.native.copyError")}</p>}
        </CollapsibleContent>
      </Collapsible>
      {!!detail.links.length && (
        <nav aria-label={tr("memory.native.links")} className="flex flex-wrap gap-2">
          {detail.links.map((link) => (
            <Button
              key={`${link.targetId}:${link.fragment ?? ""}:${link.label}`}
              size="sm"
              variant="outline"
              className="max-w-full whitespace-normal break-words"
              onClick={() => onOpen(link.targetId, detail.source.id)}
            >
              {link.label}
            </Button>
          ))}
        </nav>
      )}
      <div className="flex items-center gap-1 border-b border-border pb-2">
        <Button
          variant={raw ? "ghost" : "secondary"}
          size="sm"
          aria-pressed={!raw}
          onClick={() => setRaw(false)}
        >
          {tr("memory.native.preview")}
        </Button>
        <Button
          variant={raw ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={raw}
          onClick={() => setRaw(true)}
        >
          {tr("memory.native.raw")}
        </Button>
      </div>
      {raw ? (
        <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
          {detail.content}
        </pre>
      ) : (
        <div className="markdown-content min-w-0 break-words [overflow-wrap:anywhere]">
          <Markdown allowHtml={false} components={{ a: MemoryLink, img: MemoryImage }}>
            {visibleText}
          </Markdown>
        </div>
      )}
      {detail.file.truncated && (
        <p className="text-xs text-muted-foreground">{tr("memory.native.truncated")}</p>
      )}
    </>
  );
}

// Native prose must not load remote resources or turn filesystem references into arbitrary reads.
// Navigation is restricted to the backend-issued linked-file buttons above the document.
function MemoryLink({ children }: ComponentProps<"a">) {
  return <span>{children}</span>;
}
function MemoryImage({ alt }: ComponentProps<"img">) {
  return <span className="text-muted-foreground">{alt ? `[${alt}]` : ""}</span>;
}
