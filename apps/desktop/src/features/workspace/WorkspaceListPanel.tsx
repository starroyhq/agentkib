import { currentAppPlatform } from "@/core/keyboard-shortcuts";
import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { WorkspaceSummary } from "@/core/types";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  FolderGit2,
  FolderOpen,
  MoreHorizontal,
  RefreshCw,
  Split,
  Star,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { AGENT_LABELS as agentLabels } from "@/core/agents";
import { tr as defaultTranslate } from "@/core/i18n";
import { usePathDisplay } from "@/lib/usePathDisplay";
import { getWorkspaceStatus } from "./workspace-status";
import { primaryName, type WorkspaceTreeRow } from "./workspace-tree";

/** Says which repository a worktree belongs to; deleted and unknown states are spelled out. */
function worktreeLabel(
  workspace: WorkspaceSummary,
  primary: WorkspaceSummary | undefined,
  tr = defaultTranslate,
) {
  const checkout = workspace.checkout!;
  const name = checkout.name ?? workspace.name;
  if (checkout.status === "deleted") return tr("workspace.worktree.deleted", { name });
  if (checkout.status === "unknown") return tr("workspace.worktree.unknown", { name });
  const values = { name, primary: primaryName(workspace, primary) };
  return checkout.branch
    ? tr("workspace.worktree.present", { ...values, branch: checkout.branch })
    : tr("workspace.worktree.presentNoBranch", values);
}

export function WorkspaceListPanel({
  rows,
  totalCount,
  statuses,
  pageStart,
  pageEnd,
  filteredCount,
  rowCount = rows.length,
  activePage,
  totalPages,
  favoriteWorkspaceIds,
  refreshingWorkspaceIds,
  onOpen,
  onToggleFavorite,
  onPageChange,
  onRefresh,
  onReveal,
  onExclude,
}: {
  /** Main checkouts carry their worktrees, which are listed indented below them. */
  rows: WorkspaceTreeRow[];
  totalCount: number;
  statuses: Map<string, ReturnType<typeof getWorkspaceStatus>>;
  pageStart: number;
  pageEnd: number;
  filteredCount: number;
  /** Top-level rows the pages divide; worktrees ride along with their main checkout. */
  rowCount?: number;
  activePage: number;
  totalPages: number;
  favoriteWorkspaceIds: string[];
  refreshingWorkspaceIds?: string[];
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
  onToggleFavorite: (workspaceId: string) => void;
  onPageChange: (page: number) => void;
  onRefresh: (id: string) => Promise<void>;
  onReveal: (id: string) => Promise<void>;
  onExclude: (id: string) => Promise<void>;
}) {
  const { tr, formatRelativeTime } = useI18n();
  const displayPath = usePathDisplay();
  const platform = currentAppPlatform();
  const revealLabel = tr(
    platform === "macos"
      ? "storage.revealInFinder"
      : platform === "windows"
        ? "storage.revealInExplorer"
        : "storage.openLocation",
  );
  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex min-h-[58px] items-center gap-2 border-b border-border px-5 py-3">
        <h2 className="text-base font-semibold text-foreground">{tr("nav.workspaces")}</h2>
        <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {tr("workspace.listCount", { count: filteredCount })}
        </span>
      </header>
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] table-fixed border-collapse text-left">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th scope="col" className="w-[44%] px-5 py-2.5 font-normal">
                  {tr("workspace.nameColumn")}
                </th>
                <th scope="col" className="w-[17%] px-3 py-2.5 font-normal">
                  {tr("workspace.sourceColumn")}
                </th>
                <th scope="col" className="w-[17%] px-3 py-2.5 font-normal">
                  {tr("workspace.statusColumn")}
                </th>
                <th scope="col" className="px-3 py-2.5 font-normal">
                  {tr("workspace.activityColumn")}
                </th>
                <th scope="col" className="w-[88px]">
                  <span className="sr-only">{tr("common.moreActions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows
                .flatMap((row) => [
                  { workspace: row.workspace, primary: undefined },
                  ...row.worktrees.map((workspace) => ({ workspace, primary: row.workspace })),
                ])
                .map(({ workspace, primary }) => {
                  const worktree =
                    workspace.checkout?.kind === "worktree" ? workspace.checkout : null;
                  const worktreeText = worktree && worktreeLabel(workspace, primary, tr);
                  const sourceAgents = workspace.sources
                    .flatMap((source) => (source.agent ? [source.agent] : []))
                    .filter((value, index, values) => values.indexOf(value) === index);
                  const sourceLabel = sourceAgents.length
                    ? sourceAgents.map((value) => agentLabels[value]).join(" · ")
                    : tr(
                        workspace.sources.length
                          ? "workspace.source.scan"
                          : "workspace.source.manual",
                      );
                  const favorite = favoriteWorkspaceIds.includes(workspace.id);
                  const refreshing = refreshingWorkspaceIds?.includes(workspace.id) ?? false;
                  const status = statuses.get(workspace.id)!;
                  const statusLabel = tr(`workspace.status.${status.state}`, {
                    count: status.issueCount,
                  });
                  const StatusIcon =
                    status.state === "healthy"
                      ? Check
                      : status.state === "attention"
                        ? TriangleAlert
                        : CircleHelp;
                  return (
                    <tr
                      key={workspace.id}
                      data-worktree-of={primary?.id}
                      className="group/workspace cursor-pointer border-b border-border last:border-0 hover:bg-muted/40"
                      onClick={() => void onOpen(workspace)}
                    >
                      <td className={primary ? "py-1 pr-5 pl-12" : "px-5 py-1"}>
                        <Button
                          variant="bare"
                          size="content"
                          className={`flex w-full min-w-0 items-center justify-start gap-3 rounded-lg text-left ${primary ? "min-h-[52px]" : "min-h-[70px]"}`}
                          aria-label={[workspace.name, worktreeText, sourceLabel, statusLabel]
                            .filter(Boolean)
                            .join(", ")}
                          onClick={(event) => {
                            event.stopPropagation();
                            void onOpen(workspace);
                          }}
                        >
                          <span
                            className={`grid shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground ${primary ? "size-7" : "size-9"} ${worktree?.status === "deleted" ? "opacity-45" : ""}`}
                            title={worktreeText || undefined}
                          >
                            {worktree ? (
                              <Split size={primary ? 14 : 17} aria-hidden="true" />
                            ) : (
                              <FolderGit2 size={17} aria-hidden="true" />
                            )}
                          </span>
                          <span className="min-w-0">
                            <strong
                              className="block truncate text-sm font-semibold text-foreground"
                              title={
                                worktreeText ? `${workspace.name}\n${worktreeText}` : workspace.name
                              }
                            >
                              {workspace.name}
                            </strong>
                            <small
                              className="mt-1 block truncate text-xs text-muted-foreground"
                              title={workspace.path}
                            >
                              {displayPath(workspace.path)}
                            </small>
                          </span>
                        </Button>
                      </td>
                      <td className="px-3 py-3 text-sm">
                        <span className="flex min-w-0 items-center gap-1.5" title={sourceLabel}>
                          {sourceAgents[0] && <AgentIcon agent={sourceAgents[0]} compact />}
                          <span className="truncate">{sourceLabel}</span>
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <Badge
                          variant="secondary"
                          className={
                            status.state === "attention"
                              ? "border-transparent bg-[var(--amber)]/10 text-[var(--amber)]"
                              : status.state === "healthy"
                                ? "border-transparent bg-[var(--green)]/10 text-[var(--green)]"
                                : "text-muted-foreground"
                          }
                        >
                          <StatusIcon size={12} className="mr-1" aria-hidden="true" />
                          {statusLabel}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 text-xs text-muted-foreground">
                        {workspace.last_active_at
                          ? formatRelativeTime(workspace.last_active_at)
                          : tr("common.never")}
                      </td>
                      <td className="pr-3" onClick={(event) => event.stopPropagation()}>
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground"
                            aria-label={tr(
                              favorite ? "workspace.removeFavorite" : "workspace.addFavorite",
                              { name: workspace.name },
                            )}
                            aria-pressed={favorite}
                            title={tr(
                              favorite ? "workspace.removeFavorite" : "workspace.addFavorite",
                              { name: workspace.name },
                            )}
                            onClick={() => onToggleFavorite(workspace.id)}
                          >
                            <Star size={15} className={favorite ? "fill-current" : ""} />
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  className="text-muted-foreground"
                                  aria-label={tr("workspace.moreActions", { name: workspace.name })}
                                />
                              }
                            >
                              <MoreHorizontal size={16} />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-auto min-w-44">
                              <DropdownMenuItem
                                disabled={refreshing}
                                onClick={() => void onRefresh(workspace.id)}
                              >
                                <RefreshCw className={refreshing ? "animate-spin" : ""} />
                                {tr(refreshing ? "common.loading" : "workspace.rescan")}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void onReveal(workspace.id)}>
                                <FolderOpen />
                                {revealLabel}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => void onExclude(workspace.id)}
                              >
                                <Trash2 />
                                {tr("workspace.ignore")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      ) : (
        <WorkspaceEmptyState
          title={tr(totalCount ? "workspace.noMatch" : "workspace.emptyTitle")}
          text={
            totalCount
              ? tr("workspace.noMatchText")
              : tr("workspace.emptyText", { action: tr("workspace.addWorkspace") })
          }
        />
      )}
      {totalPages > 1 && (
        <footer className="flex min-h-[58px] items-center justify-between gap-3 border-t border-border px-5 py-3">
          <span className="text-xs tabular-nums text-muted-foreground">
            {pageStart}–{pageEnd} / {rowCount}
          </span>
          <div
            className="flex items-center gap-1"
            role="group"
            aria-label={tr("workspace.pagination")}
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tr("workspace.previousPage")}
              disabled={activePage === 1}
              onClick={() => onPageChange(Math.max(1, activePage - 1))}
            >
              <ChevronLeft size={15} />
            </Button>
            <span
              className="min-w-[52px] text-center text-xs tabular-nums text-muted-foreground"
              aria-live="polite"
            >
              {activePage} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tr("workspace.nextPage")}
              disabled={activePage === totalPages}
              onClick={() => onPageChange(Math.min(totalPages, activePage + 1))}
            >
              <ChevronRight size={15} />
            </Button>
          </div>
        </footer>
      )}
    </section>
  );
}

function WorkspaceEmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="grid min-h-[260px] place-content-center justify-items-center gap-1.5 p-[30px] text-center text-muted-foreground">
      <FolderGit2 size={28} className="mb-1.5" />
      <h3 className="m-0 text-[13px] font-semibold text-foreground">{title}</h3>
      <p className="m-0 max-w-[380px] leading-relaxed">{text}</p>
    </div>
  );
}
