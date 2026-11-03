import {
  HistorySearchPanel,
  historyAccessScope,
} from "@/features/sessions/conversation/features/history/history-search";
import { historyCopy } from "@/features/sessions/conversation/features/history/history-copy";
import {
  createDesktopConversationClient,
  hasDesktopConversation,
} from "@/core/conversation-bridge";
import { useI18n } from "@/core/useI18n";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ArrowLeft, FileCode2, FolderGit2, GitBranch, Search, X } from "lucide-react";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import type { GlobalPage } from "./app-route";
import type { SidebarEntry } from "@/components/AppSidebar";
import { useAppStore } from "@/stores/app-store";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { filterSessions, projectManagedSessionAliases } from "@/features/sessions/session-catalog";
import { useConversationCatalog } from "@/features/sessions/conversation-catalog";
import { displaySessionTitle } from "@/features/workspace/session-title";
import {
  isInteractiveFork,
  sessionAgentNames,
  sessionRecordLabel,
  sessionSourceLabel,
} from "@/features/sessions/session-labels";
import { AssetDetails } from "@/features/catalog/AssetDetails";
import type { CatalogAssetGroup } from "@/features/catalog/catalog";
import { useSearchSessions } from "./useSearchSessions";
import { useRemoteCatalogEntries } from "@/features/remote/remote-catalog-store";
import { SEARCH_ASSET_LIMIT, useSearchAssets } from "./useSearchAssets";

type Result = {
  id: string;
  label: string;
  description?: string;
  title?: string;
  icon: ReactNode;
  select: () => void;
};
const PAGE_SIZE = 20;

function visibleFocusTarget(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0")
      return false;
  }
  return [...element.getClientRects()].some(
    (rect) =>
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight,
  );
}

export function GlobalSearchDialog({
  open,
  onOpenChange,
  entries,
  workspaces,
  onNavigate,
  onOpenWorkspace,
  onOpenSession,
  onSessionSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: SidebarEntry<GlobalPage>[];
  workspaces: WorkspaceSummary[];
  onNavigate: (page: GlobalPage) => void;
  onOpenWorkspace: (workspace: WorkspaceSummary) => void;
  onOpenSession: (session: ConversationSessionSummary) => void;
  onSessionSettings: () => void;
}) {
  const { formatDateTime, tr, locale } = useI18n();
  const [historyClient] = useState(createDesktopConversationClient);
  const [historyScope, setHistoryScope] = useState("");
  const [historyMode, setHistoryMode] = useState(false);
  useEffect(() => {
    setHistoryMode(false);
    if (!open || !hasDesktopConversation()) return;
    const abort = new AbortController();
    void historyClient
      .access(abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setHistoryScope(historyAccessScope(value));
      })
      .catch(() => setHistoryScope(""));
    return () => abort.abort();
  }, [open, historyClient]);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string>();
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [asset, setAsset] = useState<CatalogAssetGroup>();
  const input = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const listId = useId();
  const runtime = useAppStore((state) => state.runtime);
  const enabled = runtime?.session_index_enabled === true;
  const sessions = useSearchSessions(workspaces, open && enabled);
  const managedCatalog = useConversationCatalog(open && enabled, enabled);
  const remote = useRemoteCatalogEntries();
  const sessionWorkspaces = useMemo(
    () => [...workspaces, ...remote.workspaces],
    [workspaces, remote.workspaces],
  );
  const assets = useSearchAssets(query, open);
  const term = query.trim().toLocaleLowerCase();
  const matchingSessions = useMemo(
    () =>
      filterSessions(
        [
          ...projectManagedSessionAliases(sessions.sessions, managedCatalog.sessions),
          ...remote.sessions,
        ],
        sessionWorkspaces,
        {
          query: term,
          agent: "all",
          filter: "all",
        },
        tr,
      ),
    [sessions.sessions, managedCatalog.sessions, remote.sessions, sessionWorkspaces, term, tr],
  );
  const close = () => onOpenChange(false);
  useEffect(() => {
    if (open && !wasOpen.current)
      returnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!open && wasOpen.current) {
      setQuery("");
      setAsset(undefined);
      setActiveId(undefined);
      setLimits({});
    }
    wasOpen.current = open;
  }, [open]);
  const openResult = (action: () => void) => {
    close();
    action();
  };
  const workspaceName = (id?: string) =>
    sessionWorkspaces.find((workspace) => workspace.id === id)?.name ?? "—";
  const groups: { id: string; title: string; results: Result[] }[] = [
    {
      id: "sessions",
      title: tr("sessions.nav"),
      results: matchingSessions.map((session) => ({
        id: "session:" + session.workspace_id + ":" + session.id,
        label: displaySessionTitle(session.title, tr),
        title: [
          sessionWorkspaces.find((workspace) => workspace.id === session.workspace_id)?.path,
          sessionSourceLabel(
            session,
            [...sessions.sessions, ...remote.sessions],
            tr,
            formatDateTime,
          ),
        ]
          .filter(Boolean)
          .join("\n"),
        description: [
          ...(session.remote ? [session.remote.host_name] : []),
          workspaceName(session.workspace_id),
          sessionAgentNames[session.agent],
          sessionRecordLabel(session, tr),
        ].join(" · "),
        icon: (
          <span className="inline-flex items-center gap-1">
            <AgentIcon agent={session.agent} compact />
            {isInteractiveFork(session) && (
              <GitBranch
                size={12}
                aria-label={`${tr("conversations.forked")}: ${sessionSourceLabel(session, [...sessions.sessions, ...remote.sessions], tr, formatDateTime)}`}
              />
            )}
          </span>
        ),
        select: () => openResult(() => onOpenSession(session)),
      })),
    },
    {
      id: "workspaces",
      title: tr("nav.workspaces"),
      results: [...workspaces]
        .sort((a, b) => (b.last_active_at ?? "").localeCompare(a.last_active_at ?? ""))
        .filter((workspace) =>
          (workspace.name + " " + workspace.path).toLocaleLowerCase().includes(term),
        )
        .map((workspace) => ({
          id: "workspace:" + workspace.id,
          label: workspace.name,
          description: workspace.path,
          icon: <FolderGit2 size={18} />,
          select: () => openResult(() => onOpenWorkspace(workspace)),
        })),
    },
    {
      id: "assets",
      title: tr("nav.assets"),
      results: assets.assets.map((item) => ({
        id: "asset:" + item.id,
        label: item.name,
        description: item.path,
        icon: <FileCode2 size={18} />,
        select: () => setAsset(item),
      })),
    },
    {
      id: "pages",
      title: tr("search.pages"),
      results: entries
        .filter((entry) => tr(entry.label).toLocaleLowerCase().includes(term))
        .map(({ id, label, icon: Icon }) => ({
          id: "page:" + id,
          label: tr(label),
          icon: <Icon size={18} />,
          select: () => openResult(() => onNavigate(id)),
        })),
    },
  ];
  const visible = groups.flatMap((group) => group.results.slice(0, limits[group.id] ?? PAGE_SIZE));
  const active = visible.find((result) => result.id === activeId) ?? visible[0];
  const activeIndex = visible.findIndex((result) => result.id === active?.id);
  const optionId = (index: number) => listId + "-" + index;
  useEffect(() => {
    resultsRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active?.id]);
  const back = () => {
    setAsset(undefined);
    requestAnimationFrame(() => input.current?.focus());
  };
  const selectedWorkspace = asset
    ? workspaces.find((workspace) => workspace.id === asset.workspace_id)
    : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[12%] z-[101] w-[min(680px,calc(100vw-2rem))] sm:max-w-[680px] max-h-[80dvh] -translate-y-0 gap-0 overflow-hidden p-0"
        overlayClassName="z-[100]"
        showCloseButton={false}
        finalFocus={() => {
          const previous = returnFocus.current;
          if (visibleFocusTarget(previous)) return previous;
          return (
            [...document.querySelectorAll<HTMLElement>("[data-global-search-trigger]")].find(
              visibleFocusTarget,
            ) ??
            [
              ...document.querySelectorAll<HTMLElement>(
                ".app-sidebar-collapse-button, .sidebar-mobile-trigger",
              ),
            ].find(visibleFocusTarget) ??
            false
          );
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{tr("search.title")}</DialogTitle>
          <DialogDescription>{tr("search.description")}</DialogDescription>
        </DialogHeader>
        {historyMode && historyScope ? (
          <div className="min-h-0 overflow-y-auto p-4">
            <Button variant="ghost" onClick={() => setHistoryMode(false)}>
              <ArrowLeft size={16} />
              {tr("search.backResults")}
            </Button>
            <HistorySearchPanel
              client={historyClient}
              locale={locale}
              scope={historyScope}
              initialQuery={query}
              onSettingsOpened={() => onOpenChange(false)}
              onScopeEnded={() => {
                setHistoryMode(false);
                setHistoryScope("");
              }}
            />
          </div>
        ) : asset ? (
          <>
            <div className="flex items-center gap-3 border-b border-border p-3">
              <Button
                variant="ghost"
                size="icon"
                autoFocus
                onClick={back}
                aria-label={tr("search.backResults")}
              >
                <ArrowLeft size={18} />
              </Button>
              <h2 className="min-w-0 flex-1 truncate font-semibold">{asset.name}</h2>
              <Button variant="ghost" size="icon" onClick={close} aria-label={tr("common.close")}>
                <X size={18} />
              </Button>
            </div>
            <div className="max-h-[60dvh] overflow-y-auto p-5">
              <AssetDetails asset={asset} workspaceName={workspaceName(asset.workspace_id)} />
            </div>
            {selectedWorkspace && (
              <Button
                className="m-4 mt-0"
                onClick={() => openResult(() => onOpenWorkspace(selectedWorkspace))}
              >
                {tr("catalog.openWorkspace")}
              </Button>
            )}
          </>
        ) : (
          <>
            <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
              <Search size={18} className="shrink-0 text-muted-foreground" />
              <Input
                ref={input}
                autoFocus
                role="combobox"
                aria-label={tr("search.title")}
                aria-autocomplete="list"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={active ? optionId(activeIndex) : undefined}
                className="h-full min-w-0 border-0 px-0 text-[15px] shadow-none focus-visible:ring-0"
                value={query}
                placeholder={tr("search.placeholder")}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveId(undefined);
                  setLimits({});
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && visible.length) {
                    event.preventDefault();
                    setActiveId(
                      visible[
                        (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + visible.length) %
                          visible.length
                      ].id,
                    );
                  } else if (event.key === "Enter" && active) {
                    event.preventDefault();
                    active.select();
                  }
                }}
              />
              <Button variant="ghost" size="icon" onClick={close} aria-label={tr("common.close")}>
                <X size={16} />
              </Button>
            </div>
            <div
              ref={resultsRef}
              className="min-h-0 overflow-y-auto p-2"
              style={{ maxHeight: "min(520px, calc(80dvh - 56px))" }}
            >
              {!!historyScope && (
                <Button variant="ghost" onClick={() => setHistoryMode(true)}>
                  <Search size={16} />
                  {historyCopy[locale].title}
                </Button>
              )}
              {runtime && !enabled && (
                <div className="flex items-center justify-between gap-3 p-3 text-sm text-muted-foreground">
                  <span>{tr("search.indexDisabled")}</span>
                  <Button variant="outline" size="sm" onClick={() => openResult(onSessionSettings)}>
                    {tr("search.openSettings")}
                  </Button>
                </div>
              )}
              <div id={listId} role="listbox" aria-label={tr("search.title")}>
                {groups.map(
                  (group) =>
                    group.results.length > 0 && (
                      <div role="group" aria-label={group.title} key={group.id}>
                        <h3 className="px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground">
                          {group.title}
                        </h3>
                        {group.results.slice(0, limits[group.id] ?? PAGE_SIZE).map((result) => (
                          <Button
                            key={result.id}
                            id={optionId(visible.indexOf(result))}
                            role="option"
                            tabIndex={-1}
                            title={result.title}
                            aria-label={[result.label, result.description]
                              .filter(Boolean)
                              .join(" ")}
                            aria-selected={active?.id === result.id}
                            variant="bare"
                            size="content"
                            className="flex min-h-12 w-full justify-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted aria-selected:bg-muted"
                            onFocus={() => setActiveId(result.id)}
                            onClick={result.select}
                          >
                            <span className="shrink-0 text-muted-foreground">{result.icon}</span>
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium">
                                {result.label}
                              </span>
                              {result.description && (
                                <span
                                  className="block truncate text-sm text-muted-foreground"
                                  title={result.description}
                                >
                                  {result.description}
                                </span>
                              )}
                            </span>
                          </Button>
                        ))}
                      </div>
                    ),
                )}
              </div>
              {groups
                .filter((group) => group.results.length > (limits[group.id] ?? PAGE_SIZE))
                .map((group) => (
                  <Button
                    key={group.id}
                    variant="ghost"
                    size="sm"
                    className="m-1"
                    onClick={() =>
                      setLimits((previous) => ({
                        ...previous,
                        [group.id]: (previous[group.id] ?? PAGE_SIZE) + PAGE_SIZE,
                      }))
                    }
                  >
                    {tr("search.showMore", {
                      group: group.title,
                      shown: limits[group.id] ?? PAGE_SIZE,
                      total: group.results.length,
                    })}
                  </Button>
                ))}
              {sessions.loading && (
                <p role="status" className="p-3 text-sm text-muted-foreground">
                  {tr("search.sessionsLoading")}
                </p>
              )}
              {Object.entries(sessions.errors).map(([id, error]) => (
                <div role="status" key={id} className="p-3 text-sm text-destructive-text">
                  <span>
                    {workspaceName(id)}: {error}
                  </span>
                  <Button variant="ghost" size="sm" onClick={sessions.retry}>
                    {tr("sessions.retry")}
                  </Button>
                </div>
              ))}
              {assets.loading && (
                <p role="status" className="p-3 text-sm text-muted-foreground">
                  {tr("search.assetsLoading")}
                </p>
              )}
              {assets.error && (
                <div role="status" className="p-3 text-sm text-destructive-text">
                  {assets.error}
                  <Button variant="ghost" size="sm" onClick={assets.retry}>
                    {tr("sessions.retry")}
                  </Button>
                </div>
              )}
              {assets.limited && (
                <p role="status" className="p-3 text-sm text-muted-foreground">
                  {tr("search.assetLimit", { count: SEARCH_ASSET_LIMIT })}
                </p>
              )}
              {!visible.length && !sessions.loading && !assets.loading && (
                <p className="grid min-h-28 place-items-center text-sm text-muted-foreground">
                  {tr("search.empty")}
                </p>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
