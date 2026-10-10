import { useI18n } from "@/core/useI18n";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Binary,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileCode2,
  FileQuestion,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  GitMerge,
  History,
  RefreshCw,
  Search,
  Tags,
} from "lucide-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "@/core/api";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";
import { workspaceKeys } from "./workspace-query";
import { WorkspaceGitSkeleton } from "./WorkspaceSkeleton";
import type {
  GitCommitSummary,
  GitDiff,
  GitDiffKind,
  GitDiffRequest,
  GitFileChange,
  GitHistoryQuery,
  GitWorkingTreeChange,
  GitWorkspaceSummary,
  WorkspaceSummary,
} from "@/core/types";
import { cn } from "cn";

type GitSection = "history" | "worktree";

export type GitSubview =
  | { kind: "commit"; oid: string }
  | { kind: "worktree"; path: string; diffKind: GitDiffKind };

interface WorkspaceGitPageProps {
  workspace: WorkspaceSummary;
  subview?: GitSubview;
  onSubviewChange?: (subview?: GitSubview) => void;
}

type DiffState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; value: GitDiff }
  | { status: "empty" }
  | { status: "error"; message: string };

interface GraphEdge {
  from: number;
  to: number;
  color: number;
}

interface HistoryPage {
  commits: GitCommitSummary[];
  nextCursor?: string;
}

const historyPageSize = 50;
const emptyCommitHistory: GitCommitSummary[] = [];
const emptyFileChanges: GitFileChange[] = [];

export interface CommitGraphRow {
  lane: number;
  lanes: number;
  edges: GraphEdge[];
  continuation: boolean;
}

const graphColors = ["#7668e8", "#35a8d4", "#db8b3d", "#3da36f", "#c35f86", "#8d69c7"];

export function layoutCommitGraph(commits: GitCommitSummary[]): CommitGraphRow[] {
  let lanes: string[] = [];
  return commits.map((commit) => {
    let lane = lanes.indexOf(commit.oid);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(commit.oid);
    }
    const before = [...lanes];
    const after = before.filter((oid) => oid !== commit.oid);
    commit.parents.forEach((parent, parentIndex) => {
      if (!after.includes(parent))
        after.splice(Math.min(lane + parentIndex, after.length), 0, parent);
    });
    const edges: GraphEdge[] = [];
    before.forEach((oid, from) => {
      if (oid === commit.oid) return;
      const to = after.indexOf(oid);
      if (to >= 0) edges.push({ from, to, color: stableColor(oid) });
    });
    commit.parents.forEach((parent) => {
      const to = after.indexOf(parent);
      if (to >= 0) edges.push({ from: lane, to, color: stableColor(parent) });
    });
    const row = {
      lane,
      lanes: Math.max(before.length, after.length, 1),
      edges,
      continuation: commit.parents.some(
        (parent) => !commits.some((candidate) => candidate.oid === parent),
      ),
    };
    lanes = after;
    return row;
  });
}

function stableColor(value: string) {
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % graphColors.length;
}

export function WorkspaceGitPage({ workspace, subview, onSubviewChange }: WorkspaceGitPageProps) {
  const { formatDateTime, localizeMessage, tr } = useI18n();
  const [section, setSection] = useState<GitSection>("history");
  const [internalSubview, setInternalSubview] = useState<GitSubview | undefined>(subview);
  // 父组件改变 subview 时在渲染阶段同步，而不是用 effect 再触发一轮渲染。
  const [previousSubview, setPreviousSubview] = useState(subview);
  if (subview !== previousSubview) {
    setPreviousSubview(subview);
    setInternalSubview(subview);
  }
  const [requestedPageIndex, setHistoryPageIndex] = useState(0);
  const [preferredOid, setSelectedOid] = useState<string>();
  const [selectedFile, setSelectedFile] = useState<string>();
  const [selectedWorktree, setSelectedWorktree] = useState<{ path: string; kind: GitDiffKind }>();
  const [search, setSearch] = useState("");
  const [reference, setReference] = useState("");
  const [author, setAuthor] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [path, setPath] = useState("");
  const [mergesOnly, setMergesOnly] = useState(false);
  const [mobileDetailPane, setMobileDetailPane] = useState<"files" | "diff">("files");
  const queryClient = useOptionalQueryClient();
  const historyListRef = useRef<HTMLDivElement>(null);
  const worktreeListRef = useRef<HTMLElement>(null);
  const historyScrollTop = useRef(0);
  const worktreeScrollTop = useRef(0);
  const [appliedFilters, setAppliedFilters] = useState({
    reference: "",
    author: "",
    since: "",
    until: "",
    path: "",
    mergesOnly: false,
  });
  const activeSubview = internalSubview;
  const setSubview = (next?: GitSubview) => {
    setInternalSubview(next);
    onSubviewChange?.(next);
  };

  const historyParams = (): GitHistoryQuery => ({
    limit: historyPageSize,
    reference: appliedFilters.reference || undefined,
    author: appliedFilters.author.trim() || undefined,
    since: appliedFilters.since || undefined,
    until: appliedFilters.until || undefined,
    path: appliedFilters.path.trim() || undefined,
    merges_only: appliedFilters.mergesOnly,
  });

  const summaryQuery = useQuery(
    {
      ...queryDefaults,
      queryKey: workspaceKeys.gitSummary(workspace.id),
      queryFn: () => api.workspaceGitSummary(workspace.id),
      staleTime: 0,
    },
    queryClient,
  );
  const summary: GitWorkspaceSummary | undefined = summaryQuery.data ?? undefined;
  // 历史按页缓存（向前翻页直接复用），筛选条件是 key 的一部分；不是 Git 仓库时不请求。
  const historyQuery = useInfiniteQuery(
    {
      ...queryDefaults,
      queryKey: workspaceKeys.gitHistory(workspace.id, appliedFilters),
      queryFn: ({ pageParam }) =>
        api.workspaceGitHistory(workspace.id, {
          ...historyParams(),
          ...(pageParam ? { cursor: pageParam } : {}),
        }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page?.next_cursor ?? undefined,
      enabled: !!summary,
      staleTime: 0,
    },
    queryClient,
  );
  const historyPages: HistoryPage[] = useMemo(
    () =>
      (historyQuery.data?.pages ?? []).map((page) => ({
        commits: page?.commits ?? [],
        nextCursor: page?.next_cursor,
      })),
    [historyQuery.data],
  );
  const loading = summaryQuery.isPending || (!!summary && historyQuery.isPending);
  const loadingPage = historyQuery.isFetchingNextPage;
  const refreshing = summaryQuery.isFetching || (historyQuery.isFetching && !loadingPage);
  const loadError = summaryQuery.error ?? historyQuery.error;
  const error = loadError ? localizeMessage(loadError) : "";

  // 换工作区或筛选条件时回到第一页，并清掉上一次选中的文件。
  const historyGeneration = useRef(0);
  useEffect(() => {
    historyGeneration.current += 1;
    setHistoryPageIndex(0);
    setSelectedFile(undefined);
  }, [workspace.id, appliedFilters]);

  useEffect(() => {
    if (
      reference === appliedFilters.reference &&
      author === appliedFilters.author &&
      since === appliedFilters.since &&
      until === appliedFilters.until &&
      path === appliedFilters.path &&
      mergesOnly === appliedFilters.mergesOnly
    )
      return;
    const timeout = window.setTimeout(
      () => setAppliedFilters({ reference, author, since, until, path, mergesOnly }),
      300,
    );
    return () => window.clearTimeout(timeout);
  }, [reference, author, since, until, path, mergesOnly, appliedFilters]);

  // 刷新或外部失效后页数可能变少（force-push、切分支），页码不能指向不存在的页。
  const historyPageIndex = Math.min(requestedPageIndex, Math.max(0, historyPages.length - 1));
  const commits = historyPages[historyPageIndex]?.commits ?? emptyCommitHistory;
  const nextCursor = historyPages[historyPageIndex]?.nextCursor;
  // 选中的提交不在当前页时（首次加载、换页、换筛选）默认选第一条。
  const selectedOid = commits.some((commit) => commit.oid === preferredOid)
    ? preferredOid
    : commits[0]?.oid;
  const filteredCommits = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return commits;
    return commits.filter(
      (commit) =>
        commit.subject.toLocaleLowerCase().includes(needle) ||
        commit.oid.toLocaleLowerCase().startsWith(needle) ||
        commit.refs.some((ref) => ref.name.toLocaleLowerCase().includes(needle)),
    );
  }, [commits, search]);
  const graph = useMemo(() => layoutCommitGraph(filteredCommits), [filteredCommits]);
  const detailOid = activeSubview?.kind === "commit" ? activeSubview.oid : undefined;
  const selectedCommit = commits.find((commit) => commit.oid === detailOid);
  const selectedWorktreeChange = summary?.changes.find(
    (change) => change.path === selectedWorktree?.path,
  );
  const selectedWorktreeIsUntracked =
    selectedWorktree?.kind === "worktree" && selectedWorktreeChange?.kind === "untracked";

  const filesQuery = useQuery(
    {
      ...queryDefaults,
      queryKey: workspaceKeys.gitCommitFiles(workspace.id, detailOid ?? ""),
      queryFn: () => api.gitCommitFiles(workspace.id, detailOid!),
      enabled: !!detailOid,
      // 同一个提交的文件列表不会变。
      staleTime: Infinity,
    },
    queryClient,
  );
  const files: GitFileChange[] = (detailOid && filesQuery.data) || emptyFileChanges;
  const filesLoading = !!detailOid && filesQuery.isPending;
  const filesError = detailOid && filesQuery.error ? localizeMessage(filesQuery.error) : "";

  useEffect(() => {
    setSelectedFile(undefined);
  }, [workspace.id, detailOid]);

  useEffect(() => {
    if (activeSubview?.kind === "commit") {
      setSection("history");
      setSelectedOid(activeSubview.oid);
      setSelectedFile(undefined);
    } else if (activeSubview?.kind === "worktree") {
      setSection("worktree");
      setSelectedWorktree({ path: activeSubview.path, kind: activeSubview.diffKind });
    }
  }, [
    workspace.id,
    activeSubview?.kind,
    activeSubview?.kind === "commit" ? activeSubview.oid : activeSubview?.path,
  ]);

  useEffect(() => {
    if (!activeSubview) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSubview(undefined);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [activeSubview, onSubviewChange]);

  useLayoutEffect(() => {
    if (activeSubview) return;
    const frame = window.requestAnimationFrame(() => {
      if (section === "history" && historyListRef.current)
        historyListRef.current.scrollTop = historyScrollTop.current;
      if (section === "worktree" && worktreeListRef.current)
        worktreeListRef.current.scrollTop = worktreeScrollTop.current;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSubview, section]);

  const diffRequest = useMemo<GitDiffRequest | undefined>(() => {
    if (activeSubview?.kind === "commit")
      return { kind: "commit", oid: activeSubview.oid, path: selectedFile };
    if (activeSubview?.kind === "worktree" && !selectedWorktreeIsUntracked) {
      return selectedWorktree ?? { kind: activeSubview.diffKind };
    }
    return undefined;
  }, [activeSubview, selectedFile, selectedWorktree, selectedWorktreeIsUntracked]);

  const diffQuery = useQuery(
    {
      ...queryDefaults,
      queryKey: workspaceKeys.gitDiff(workspace.id, diffRequest),
      queryFn: () => api.gitDiff(workspace.id, diffRequest!),
      enabled: !!diffRequest,
      // 工作区 diff 随文件改动变化，每次打开都重新读取，但先显示缓存。
      staleTime: 0,
    },
    queryClient,
  );
  const diffState: DiffState = !diffRequest
    ? { status: "idle" }
    : // 失败后重试期间显示加载中，而不是继续显示上一次的错误。
      diffQuery.isPending || (diffQuery.isFetching && diffQuery.isError)
      ? { status: "loading" }
      : diffQuery.error
        ? { status: "error", message: localizeMessage(diffQuery.error) }
        : !diffQuery.data ||
            (!diffQuery.data.patch.trim() && !diffQuery.data.binary && !diffQuery.data.submodule)
          ? { status: "empty" }
          : { status: "ready", value: diffQuery.data };

  // 刷新回到第一页并只重取第一页；否则会按旧游标依次重取所有已加载的页。
  const refreshGit = () => {
    historyGeneration.current += 1;
    setHistoryPageIndex(0);
    void queryClient.resetQueries({
      queryKey: workspaceKeys.gitHistory(workspace.id, appliedFilters),
    });
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.git(workspace.id),
      predicate: (query) => query.queryKey[3] !== "history",
    });
  };

  const showPreviousPage = () => {
    if (historyPageIndex === 0 || loadingPage) return;
    const previousPageIndex = historyPageIndex - 1;
    setHistoryPageIndex(previousPageIndex);
    setSelectedOid(historyPages[previousPageIndex]?.commits[0]?.oid);
    historyListRef.current?.scrollTo({ top: 0 });
  };

  const showNextPage = async () => {
    if (loadingPage) return;
    const cachedPage = historyPages[historyPageIndex + 1];
    if (cachedPage) {
      setHistoryPageIndex(historyPageIndex + 1);
      setSelectedOid(cachedPage.commits[0]?.oid);
      historyListRef.current?.scrollTo({ top: 0 });
      return;
    }
    // 只有当前页是已加载的最后一页时才会走到这里，fetchNextPage 追加的正是下一页。
    if (!nextCursor || historyPageIndex !== historyPages.length - 1) return;
    const generation = historyGeneration.current;
    const result = await historyQuery.fetchNextPage();
    // 失败时错误已在 historyQuery.error 中显示；请求期间换了工作区或筛选条件则丢弃结果。
    if (result.isError || generation !== historyGeneration.current) return;
    const page = result.data?.pages[historyPageIndex + 1];
    if (!page) return;
    setHistoryPageIndex(historyPageIndex + 1);
    setSelectedOid(page.commits[0]?.oid);
    historyListRef.current?.scrollTo({ top: 0 });
  };

  const worktreeEntries = useMemo(() => worktreeRows(summary?.changes ?? []), [summary?.changes]);
  const worktreeDetailFiles = useMemo(() => {
    if (activeSubview?.kind !== "worktree") return [];
    return (summary?.changes ?? []).flatMap((change): GitFileChange[] => {
      if (activeSubview.diffKind === "staged") {
        return change.index_status
          ? [{ status: change.index_status, path: change.path, old_path: change.old_path }]
          : [];
      }
      if (change.kind === "untracked")
        return [{ status: "?", path: change.path, old_path: change.old_path }];
      return change.worktree_status || change.conflicted
        ? [{ status: change.worktree_status || "U", path: change.path, old_path: change.old_path }]
        : [];
    });
  }, [activeSubview, summary?.changes]);

  const enterCommit = (oid: string) => {
    historyScrollTop.current = historyListRef.current?.scrollTop ?? 0;
    setSelectedOid(oid);
    setSelectedFile(undefined);
    setMobileDetailPane("files");
    setSubview({ kind: "commit", oid });
  };

  const enterWorktree = (path: string, diffKind: GitDiffKind) => {
    worktreeScrollTop.current = worktreeListRef.current?.scrollTop ?? 0;
    setSelectedWorktree({ path, kind: diffKind });
    setMobileDetailPane("files");
    setSubview({ kind: "worktree", path, diffKind });
  };

  const showHistory = () => {
    setSection("history");
    setSubview(undefined);
  };
  const showWorktree = () => {
    setSection("worktree");
    setSubview(undefined);
  };

  if (loading && !summary) return <WorkspaceGitSkeleton />;

  if (summary && activeSubview) {
    const commitDetail = activeSubview.kind === "commit";
    const detailTitle = commitDetail ? selectedCommit?.subject : tr("git.worktreeDetail");
    return (
      <div className="flex h-full min-h-0 flex-col gap-2">
        <Card className="flex min-h-[50px] items-center gap-2.5 rounded-xl p-1.5">
          <Button variant="ghost" className="shrink-0" onClick={() => setSubview(undefined)}>
            <ArrowLeft size={14} />
            {tr("git.backToGit")}
          </Button>
          <div className="flex min-w-0 items-baseline gap-3 overflow-hidden">
            <strong className="min-w-0 truncate text-base">
              {detailTitle || tr("git.untitledCommit")}
            </strong>
            {commitDetail && selectedCommit && (
              <span className="flex min-w-0 items-center gap-2 whitespace-nowrap text-xs text-muted-foreground max-[760px]:hidden">
                <code className="font-inherit text-foreground">
                  {selectedCommit.oid.slice(0, 7)}
                </code>
                <em className="not-italic">{selectedCommit.author_name}</em>
                <time>{formatDateTime(selectedCommit.authored_at)}</time>
                <span className="flex min-w-0 gap-1 overflow-hidden">
                  {selectedCommit.refs.map((ref) => (
                    <Badge
                      key={ref.full_name}
                      variant="outline"
                      className={cn(
                        "max-w-32 truncate px-1.5 py-0 text-[10px]",
                        ref.kind === "remote-branch" && "text-sky-600",
                        ref.kind === "tag" && "text-amber-600",
                      )}
                    >
                      {ref.name}
                    </Badge>
                  ))}
                </span>
              </span>
            )}
          </div>
        </Card>
        <div className="relative grid min-h-0 flex-1 grid-cols-[clamp(280px,26%,340px)_minmax(0,1fr)] overflow-hidden rounded-xl border bg-card max-[760px]:block">
          <aside
            className={cn(
              "min-w-0 min-h-0 overflow-auto border-r border-border p-1.5 max-[760px]:absolute max-[760px]:inset-0 max-[760px]:z-10 max-[760px]:border-r-0",
              mobileDetailPane === "diff" && "max-[760px]:hidden",
            )}
          >
            {commitDetail ? (
              <>
                <Button
                  variant="ghost"
                  className={cn(
                    "sticky top-0 z-10 grid min-h-8 w-full grid-cols-[16px_minmax(0,1fr)_auto] justify-start gap-1.5 rounded-md border-b border-border bg-card px-2 text-left text-xs",
                    !selectedFile && "bg-muted text-foreground",
                  )}
                  onClick={() => {
                    setSelectedFile(undefined);
                    setMobileDetailPane("diff");
                  }}
                >
                  <GitCompareArrows size={13} />
                  <span>{tr("git.allChanges")}</span>
                  <em className="not-italic">{filesLoading ? "…" : files.length}</em>
                </Button>
                {filesLoading && (
                  <div className="flex min-h-9 items-center gap-2 px-2 text-xs text-muted-foreground">
                    <RefreshCw size={14} className="animate-spin" />
                    {tr("common.loading")}
                  </div>
                )}
                {!filesLoading && filesError && (
                  <div className="flex min-h-9 items-center gap-2 px-2 text-xs text-destructive">
                    <CircleAlert size={14} />
                    <span className="min-w-0 flex-1">{tr("git.filesFailed")}</span>
                    <Button variant="ghost" onClick={() => void filesQuery.refetch()}>
                      {tr("git.retry")}
                    </Button>
                  </div>
                )}
                {!filesLoading && !filesError && files.length > 0 && (
                  <FileTree
                    files={files}
                    selectedPath={selectedFile}
                    onSelect={(path) => {
                      setSelectedFile(path);
                      setMobileDetailPane("diff");
                    }}
                  />
                )}
                {!filesLoading && !filesError && files.length === 0 && (
                  <div className="flex min-h-9 items-center gap-2 px-2 text-xs text-muted-foreground">
                    <FileQuestion size={14} />
                    {tr("git.noFiles")}
                  </div>
                )}
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  className={cn(
                    "sticky top-0 z-10 grid min-h-8 w-full grid-cols-[16px_minmax(0,1fr)_auto] justify-start gap-1.5 rounded-md border-b border-border bg-card px-2 text-left text-xs",
                    !selectedWorktree && "bg-muted text-foreground",
                  )}
                  onClick={() => {
                    setSelectedWorktree(undefined);
                    setMobileDetailPane("diff");
                  }}
                >
                  <GitCompareArrows size={13} />
                  <span>
                    {tr(
                      activeSubview.diffKind === "staged"
                        ? "git.allStagedChanges"
                        : "git.allWorktreeChanges",
                    )}
                  </span>
                  <em className="not-italic">{worktreeDetailFiles.length}</em>
                </Button>
                <FileTree
                  files={worktreeDetailFiles}
                  selectedPath={selectedWorktree?.path}
                  onSelect={(path) => {
                    setSelectedWorktree({ path, kind: activeSubview.diffKind });
                    setSubview({ kind: "worktree", path, diffKind: activeSubview.diffKind });
                    setMobileDetailPane("diff");
                  }}
                />
              </>
            )}
          </aside>
          <GitDiffPane
            title={
              commitDetail
                ? selectedFile || tr("git.allChanges")
                : selectedWorktree?.path ||
                  tr(
                    activeSubview.diffKind === "staged"
                      ? "git.allStagedChanges"
                      : "git.allWorktreeChanges",
                  )
            }
            fileCount={commitDetail && !selectedFile ? files.length : undefined}
            diffState={diffState}
            untracked={!commitDetail && selectedWorktreeIsUntracked}
            onRetry={() => void diffQuery.refetch()}
            onBackToFiles={() => setMobileDetailPane("files")}
            mobileVisible={mobileDetailPane === "diff"}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex min-h-11 items-center gap-2.5 border-b border-border pb-1">
        <Tabs
          className="min-w-0 max-w-full shrink-0"
          value={section}
          onValueChange={(value) => (value === "history" ? showHistory() : showWorktree())}
        >
          <TabsList
            className="segmented-control w-fit max-w-full justify-start"
            variant="default"
            aria-label={tr("git.sectionLabel")}
          >
            <TabsTrigger
              className="segmented-control-item h-9 min-h-9 flex-none px-3 text-xs sm:text-sm"
              value="history"
            >
              <History size={15} />
              {tr("git.history")}
            </TabsTrigger>
            <TabsTrigger
              className="segmented-control-item h-9 min-h-9 flex-none px-3 text-xs sm:text-sm"
              value="worktree"
            >
              <FileCode2 size={15} />
              {tr("git.worktree")}{" "}
              {summary?.changes.length ? <em>{summary.changes.length}</em> : null}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {summary && (
          <div className="ml-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <GitBranch size={14} />
            <strong className="max-w-44 truncate text-foreground">
              {summary.head ?? tr("git.detached")}
            </strong>
            {summary.upstream && (
              <span className="max-w-48 truncate max-[760px]:hidden">{summary.upstream}</span>
            )}
            {(summary.ahead > 0 || summary.behind > 0) && (
              <span className="max-[760px]:hidden">
                ↑{summary.ahead} ↓{summary.behind}
              </span>
            )}
            {summary.stash_count > 0 && (
              <span className="max-[760px]:hidden">
                {tr("git.stashes", { count: summary.stash_count })}
              </span>
            )}
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={refreshGit}
          disabled={refreshing}
          aria-label={tr("common.refresh")}
          title={tr("common.refresh")}
        >
          <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
        </Button>
      </div>
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <CircleAlert size={15} />
          {error}
        </div>
      )}
      {!loading && !summary && (
        <div className="flex min-h-16 items-center gap-2 rounded-xl border bg-card px-4 text-sm text-muted-foreground">
          <GitBranch size={19} />
          <span>{tr("git.notRepository")}</span>
        </div>
      )}
      {summary && section === "history" && (
        <>
          <Card className="grid min-h-[45px] grid-cols-[minmax(180px,1.6fr)_minmax(115px,.8fr)_minmax(110px,.7fr)_minmax(100px,.7fr)_126px_126px_minmax(110px,.8fr)] gap-1.5 rounded-xl p-1.5 max-[1120px]:grid-cols-[minmax(180px,1fr)_minmax(120px,.7fr)_minmax(100px,.7fr)] max-[760px]:grid-cols-[minmax(160px,1fr)_minmax(110px,.7fr)]">
            <div className="relative flex min-w-0 items-center">
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 text-muted-foreground"
              />
              <Input
                className="h-8 min-w-0 pl-8"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={tr("git.searchPlaceholder")}
              />
            </div>
            <Select
              value={reference || "__all_refs__"}
              onValueChange={(value) => {
                if (value !== null) {
                  const nextReference = String(value);
                  setReference(nextReference === "__all_refs__" ? "" : nextReference);
                }
              }}
            >
              <SelectTrigger className="h-8 min-w-0" aria-label={tr("git.reference")}>
                <SelectValue>
                  {summary.refs.find((ref) => ref.full_name === reference)?.name ??
                    tr("git.allRefs")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{tr("git.reference")}</SelectLabel>
                  <SelectItem value="__all_refs__">{tr("git.allRefs")}</SelectItem>
                  {summary.refs
                    .filter(
                      (ref) =>
                        ref.kind === "local-branch" ||
                        ref.kind === "remote-branch" ||
                        ref.kind === "tag",
                    )
                    .map((ref) => (
                      <SelectItem key={ref.full_name} value={ref.full_name}>
                        {ref.name}
                      </SelectItem>
                    ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              value={mergesOnly ? "merges" : "all"}
              onValueChange={(value) => setMergesOnly(value === "merges")}
            >
              <SelectTrigger className="h-8 min-w-0" aria-label={tr("git.commitKind")}>
                <SelectValue>
                  {mergesOnly ? tr("git.mergesOnly") : tr("git.allCommits")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{tr("git.commitKind")}</SelectLabel>
                  <SelectItem value="all">{tr("git.allCommits")}</SelectItem>
                  <SelectItem value="merges">{tr("git.mergesOnly")}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Input
              className="h-8 min-w-0 max-[760px]:hidden"
              value={author}
              onChange={(event) => setAuthor(event.target.value)}
              placeholder={tr("git.author")}
              aria-label={tr("git.author")}
            />
            <Input
              className="h-8 min-w-0 max-[1120px]:hidden"
              type="date"
              value={since}
              onChange={(event) => setSince(event.target.value)}
              aria-label={tr("git.since")}
            />
            <Input
              className="h-8 min-w-0 max-[1120px]:hidden"
              type="date"
              value={until}
              onChange={(event) => setUntil(event.target.value)}
              aria-label={tr("git.until")}
            />
            <Input
              className="h-8 min-w-0 max-[760px]:hidden"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={tr("git.path")}
              aria-label={tr("git.path")}
            />
          </Card>
          <Card className="flex min-h-0 flex-1 overflow-hidden rounded-xl p-0">
            <section className="flex min-w-0 min-h-0 w-full flex-col">
              <div
                ref={historyListRef}
                className="min-h-0 flex-1 overflow-auto"
                role="listbox"
                aria-label={tr("git.history")}
              >
                {filteredCommits.map((commit, index) => (
                  <Button
                    variant="bare"
                    size="content"
                    key={commit.oid}
                    role="option"
                    aria-selected={selectedOid === commit.oid}
                    className={cn(
                      "grid min-h-11 w-full grid-cols-[auto_minmax(190px,1fr)_minmax(90px,.3fr)_136px_16px] items-center gap-2 border-b border-border px-2 text-left text-foreground hover:bg-muted max-[1120px]:grid-cols-[auto_minmax(170px,1fr)_100px_16px] max-[1120px]:[&_.commit-author]:hidden max-[760px]:grid-cols-[auto_minmax(150px,1fr)_16px] max-[760px]:[&_.commit-author]:hidden max-[760px]:[&>time]:hidden",
                      selectedOid === commit.oid && "bg-primary/10",
                    )}
                    onClick={() => enterCommit(commit.oid)}
                  >
                    <CommitGraph row={graph[index]} commit={commit} />
                    <span className="flex min-w-0 items-center gap-2">
                      <strong className="min-w-0 truncate text-sm">
                        {commit.subject || tr("git.untitledCommit")}
                      </strong>
                      <span className="flex min-w-0 gap-1 overflow-hidden">
                        {commit.refs.map((ref) => (
                          <Badge
                            key={ref.full_name}
                            variant="outline"
                            className={cn(
                              "max-w-32 gap-1 truncate px-1.5 py-0 text-[10px]",
                              ref.kind === "remote-branch" && "text-sky-600",
                              ref.kind === "tag" && "text-amber-600",
                            )}
                          >
                            {ref.kind === "tag" && <Tags size={10} />}
                            {ref.name}
                          </Badge>
                        ))}
                      </span>
                    </span>
                    <span className="commit-author truncate text-xs text-muted-foreground max-[1120px]:hidden">
                      {commit.author_name}
                    </span>
                    <time className="truncate text-xs text-muted-foreground">
                      {formatDateTime(commit.authored_at)}
                    </time>
                    <ChevronRight size={14} />
                  </Button>
                ))}
                {!filteredCommits.length && !loading && (
                  <div className="grid min-h-32 place-content-center justify-items-center gap-2 text-sm text-muted-foreground">
                    <GitCommitHorizontal size={18} />
                    <span>{tr("git.noCommits")}</span>
                  </div>
                )}
              </div>
              {(historyPageIndex > 0 || nextCursor) && (
                <div className="flex min-h-12 items-center justify-center gap-2 border-t border-border px-3">
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={historyPageIndex === 0 || loadingPage}
                    onClick={showPreviousPage}
                    aria-label={tr("git.previousPage")}
                    title={tr("git.previousPage")}
                  >
                    <ChevronLeft size={14} />
                  </Button>
                  <span className="min-w-16 text-center text-xs tabular-nums text-muted-foreground">
                    {tr("git.pageNumber", { page: historyPageIndex + 1 })}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={!nextCursor || loadingPage}
                    onClick={() => void showNextPage()}
                    aria-label={tr("git.nextPage")}
                    title={tr("git.nextPage")}
                  >
                    {loadingPage ? (
                      <RefreshCw size={14} className="animate-spin" />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                  </Button>
                </div>
              )}
            </section>
          </Card>
        </>
      )}
      {summary && section === "worktree" && (
        <Card className="min-h-0 flex-1 overflow-auto rounded-xl p-0">
          <section ref={worktreeListRef} className="min-h-0 overflow-auto">
            {worktreeEntries.map(
              ([group, entries]) =>
                entries.length > 0 && (
                  <div key={group}>
                    <h3 className="flex min-h-9 items-center gap-1.5 border-b border-border bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground">
                      {tr(`git.group.${group}`)}
                      <Badge
                        variant="secondary"
                        className="size-[18px] justify-center rounded-full px-0 py-0 text-[10px]"
                      >
                        {entries.length}
                      </Badge>
                    </h3>
                    {entries.map((entry) => (
                      <Button
                        variant="bare"
                        size="content"
                        key={`${entry.kind}:${entry.change.path}`}
                        className={cn(
                          "grid min-h-12 w-full grid-cols-[18px_minmax(0,1fr)_24px_16px] items-center gap-2 border-b border-border px-3 py-2 text-left text-muted-foreground hover:bg-muted",
                          selectedWorktree?.path === entry.change.path &&
                            selectedWorktree.kind === entry.kind &&
                            "bg-muted",
                        )}
                        onClick={() => enterWorktree(entry.change.path, entry.kind)}
                      >
                        <ChangeIcon change={entry.change} />
                        <span className="min-w-0">
                          <strong className="block truncate text-sm text-foreground">
                            {fileName(entry.change.path)}
                          </strong>
                          <small className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {entry.change.old_path
                              ? `${entry.change.old_path} → ${entry.change.path}`
                              : entry.change.path}
                          </small>
                        </span>
                        <em className="text-xs not-italic text-primary">
                          {changeCode(entry.change, entry.kind)}
                        </em>
                        <ChevronRight size={14} />
                      </Button>
                    ))}
                  </div>
                ),
            )}
            {!summary.changes.length && (
              <div className="grid min-h-32 place-content-center justify-items-center gap-2 text-sm text-muted-foreground">
                <GitCommitHorizontal size={18} />
                <span>{tr("git.clean")}</span>
              </div>
            )}
          </section>
        </Card>
      )}
    </div>
  );
}

function CommitGraph({ row, commit }: { row: CommitGraphRow; commit: GitCommitSummary }) {
  const width = Math.max(30, row.lanes * 16 + 12);
  const x = (lane: number) => lane * 16 + 10;
  return (
    <svg
      className="self-center overflow-visible"
      width={width}
      height="44"
      viewBox={`0 0 ${width} 44`}
      aria-hidden="true"
    >
      {row.edges.map((edge, index) => (
        <path
          key={`${edge.from}:${edge.to}:${index}`}
          d={`M ${x(edge.from)} 0 C ${x(edge.from)} 15, ${x(edge.to)} 28, ${x(edge.to)} 44`}
          stroke={graphColors[edge.color]}
          fill="none"
          strokeWidth="2"
        />
      ))}
      <circle
        cx={x(row.lane)}
        cy="22"
        r={commit.parents.length > 1 ? 5 : 4}
        fill="var(--surface)"
        stroke={graphColors[stableColor(commit.oid)]}
        strokeWidth="2.5"
      />
      {commit.parents.length > 1 && (
        <GitMerge
          x={x(row.lane) - 4}
          y={18}
          width="8"
          height="8"
          color={graphColors[stableColor(commit.oid)]}
        />
      )}
    </svg>
  );
}

function GitDiffPane({
  title,
  fileCount,
  diffState,
  onRetry,
  untracked,
  onBackToFiles,
  mobileVisible,
}: {
  title: string;
  fileCount?: number;
  diffState: DiffState;
  onRetry: () => void;
  untracked?: boolean;
  onBackToFiles: () => void;
  mobileVisible: boolean;
}) {
  const { tr } = useI18n();
  const diff = diffState.status === "ready" ? diffState.value : undefined;
  return (
    <div
      className={cn(
        "relative min-w-0 min-h-0 overflow-auto bg-muted/40 max-[760px]:absolute max-[760px]:inset-0",
        !mobileVisible && "max-[760px]:hidden",
      )}
    >
      <div className="sticky top-0 z-10 flex min-h-9 items-center gap-2 border-b border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground">
        <Button variant="ghost" className="hidden max-[760px]:inline-flex" onClick={onBackToFiles}>
          <ArrowLeft size={14} />
          {tr("git.backToFiles")}
        </Button>
        <strong className="min-w-0 flex-1 truncate text-foreground">{title}</strong>
        {fileCount !== undefined && (
          <span className="whitespace-nowrap">{tr("git.fileCount", { count: fileCount })}</span>
        )}
        {diff?.truncated && (
          <Badge
            variant="outline"
            className="border-amber-500/30 px-1.5 py-0 text-[10px] text-amber-600"
          >
            {tr("git.truncated")}
          </Badge>
        )}
      </div>
      {untracked && (
        <div className="grid min-h-32 place-content-center justify-items-center gap-2 text-sm text-muted-foreground">
          <FileQuestion size={20} />
          <span>{tr("git.untrackedNoDiff")}</span>
        </div>
      )}
      {!untracked && diffState.status === "idle" && (
        <div className="grid min-h-32 place-content-center justify-items-center gap-2 text-sm text-muted-foreground">
          <FileQuestion size={20} />
          <span>{tr("git.diffEmpty")}</span>
        </div>
      )}
      {!untracked && diffState.status === "loading" && (
        <div className="grid min-h-32 place-content-center justify-items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw size={16} className="animate-spin" />
          <span>{tr("git.loadingDiff")}</span>
        </div>
      )}
      {!untracked && diffState.status === "empty" && (
        <div className="grid min-h-32 place-content-center justify-items-center gap-2 text-sm text-muted-foreground">
          <FileQuestion size={20} />
          <span>{tr("git.diffEmpty")}</span>
        </div>
      )}
      {!untracked && diffState.status === "error" && (
        <div className="flex min-h-32 flex-col items-center justify-center gap-1.5 text-center text-destructive">
          <CircleAlert size={18} />
          <span>{tr("git.diffFailed")}</span>
          <small className="max-w-[460px] text-xs text-muted-foreground">{diffState.message}</small>
          <Button variant="ghost" onClick={onRetry}>
            {tr("git.retry")}
          </Button>
        </div>
      )}
      {diff?.binary && (
        <div className="grid min-h-32 place-content-center justify-items-center gap-2 text-sm text-muted-foreground">
          <Binary size={18} />
          <span>{tr("git.binaryDiff")}</span>
        </div>
      )}
      {diff?.submodule && (
        <div className="flex min-h-8 items-center gap-2 border-b border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground">
          <GitBranch size={14} />
          {tr("git.submoduleDiff")}
        </div>
      )}
      {diff?.encoding_lossy && (
        <div className="flex min-h-8 items-center gap-2 border-b border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground">
          <AlertTriangle size={14} />
          {tr("git.encodingLossy")}
        </div>
      )}
      {diff && !diff.binary && diff.patch && (
        <pre className="select-text m-0 min-w-max px-0 py-2.5 pb-6 font-mono text-xs leading-relaxed text-muted-foreground">
          {diff.patch.split("\n").map((line, index) => (
            <span
              key={index}
              className={cn(
                "block min-h-[19px] whitespace-pre px-3",
                line.startsWith("+") && !line.startsWith("+++") && "bg-green-500/10 text-green-700",
                line.startsWith("-") && !line.startsWith("---") && "bg-red-500/10 text-red-700",
                line.startsWith("@@") && "bg-primary/10 text-primary",
              )}
            >
              {line || " "}
            </span>
          ))}
        </pre>
      )}
      {diff?.truncated && (
        <div className="sticky bottom-0 flex min-h-8 items-center gap-2 border-t border-border bg-card px-2.5 py-1.5 text-xs text-amber-600">
          <AlertTriangle size={14} />
          {tr("git.diffTruncated")}
        </div>
      )}
    </div>
  );
}

interface FileNode {
  name: string;
  path: string;
  children: Map<string, FileNode>;
  file?: GitFileChange;
}
function FileTree({
  files,
  selectedPath,
  onSelect,
}: {
  files: GitFileChange[];
  selectedPath?: string;
  onSelect: (path: string) => void;
}) {
  const root: FileNode = { name: "", path: "", children: new Map() };
  files.forEach((file) => {
    let current = root;
    file.path.split("/").forEach((name, index, parts) => {
      const path = parts.slice(0, index + 1).join("/");
      if (!current.children.has(name))
        current.children.set(name, { name, path, children: new Map() });
      current = current.children.get(name)!;
    });
    current.file = file;
  });
  return (
    <div className="space-y-0.5">
      {[...root.children.values()].map((node) => (
        <FileNodeRow key={node.path} node={node} selectedPath={selectedPath} onSelect={onSelect} />
      ))}
    </div>
  );
}

function FileNodeRow({
  node,
  selectedPath,
  onSelect,
}: {
  node: FileNode;
  selectedPath?: string;
  onSelect: (path: string) => void;
}) {
  if (node.file)
    return (
      <Button
        variant="ghost"
        size="content"
        className={cn(
          "grid min-h-7 w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-1.5 justify-start rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground",
          selectedPath === node.file.path && "bg-muted text-foreground",
        )}
        onClick={() => onSelect(node.file!.path)}
      >
        <FileCode2 size={13} />
        <span className="truncate">{node.name}</span>
        <em className="text-[10px] not-italic">{node.file.status}</em>
      </Button>
    );
  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger className="flex min-h-7 w-full items-center rounded-md bg-transparent px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
        {node.name}
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-3">
        {[...node.children.values()].map((child) => (
          <FileNodeRow
            key={child.path}
            node={child}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function worktreeRows(changes: GitWorkingTreeChange[]) {
  const groups: Record<
    "conflicted" | "staged" | "unstaged" | "untracked",
    Array<{ change: GitWorkingTreeChange; kind: GitDiffKind }>
  > = { conflicted: [], staged: [], unstaged: [], untracked: [] };
  changes.forEach((change) => {
    if (change.conflicted) groups.conflicted.push({ change, kind: "worktree" });
    else if (change.kind === "untracked") groups.untracked.push({ change, kind: "worktree" });
    else {
      if (change.index_status) groups.staged.push({ change, kind: "staged" });
      if (change.worktree_status) groups.unstaged.push({ change, kind: "worktree" });
    }
  });
  return Object.entries(groups) as Array<
    [keyof typeof groups, Array<{ change: GitWorkingTreeChange; kind: GitDiffKind }>]
  >;
}

function ChangeIcon({ change }: { change: GitWorkingTreeChange }) {
  return change.conflicted ? <AlertTriangle size={14} /> : <FileCode2 size={14} />;
}
function changeCode(change: GitWorkingTreeChange, kind: GitDiffKind) {
  return kind === "staged" ? change.index_status : change.worktree_status;
}
function fileName(path: string) {
  return path.split("/").pop() ?? path;
}
