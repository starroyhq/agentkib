import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { WorkspaceSummary } from "@/core/types";
import { ChevronLeft, ChevronRight, FolderGit2, Star } from "lucide-react";
import { cn } from "cn";
import { AGENT_LABELS as agentLabels } from "@/core/agents";

export function WorkspaceListPanel({
  workspaces,
  selectedId,
  pageStart,
  pageEnd,
  filteredCount,
  activePage,
  totalPages,
  favoriteWorkspaceIds,
  onSelect,
  onOpen,
  onToggleFavorite,
  onPageChange,
}: {
  workspaces: WorkspaceSummary[];
  selectedId: string;
  pageStart: number;
  pageEnd: number;
  filteredCount: number;
  activePage: number;
  totalPages: number;
  favoriteWorkspaceIds: string[];
  onSelect: (id: string) => void;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
  onToggleFavorite: (workspaceId: string) => void;
  onPageChange: (page: number) => void;
}) {
  const { tr } = useI18n();
  return (
    <section className="flex max-h-[680px] min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex min-h-[58px] items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{tr("nav.workspaces")}</h2>
        <span className="grid size-8 place-items-center rounded-lg bg-muted/70 text-muted-foreground">
          <FolderGit2 size={15} />
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {workspaces.map((workspace) => {
          const sourceAgents = workspace.sources
            .flatMap((source) => (source.agent ? [source.agent] : []))
            .filter((value, index, values) => values.indexOf(value) === index);
          const sourceLabel = sourceAgents.length
            ? sourceAgents.map((value) => agentLabels[value]).join(" · ")
            : tr("workspace.source.manual");
          const selected = selectedId === workspace.id;
          const favorite = favoriteWorkspaceIds.includes(workspace.id);
          return (
            <div
              key={workspace.id}
              className={cn(
                "group/workspace flex min-h-[72px] items-center rounded-xl",
                selected
                  ? "bg-muted text-foreground shadow-xs"
                  : "text-muted-foreground hover:bg-muted/55 hover:text-foreground",
              )}
            >
              <Button
                variant="bare"
                size="content"
                className="grid min-h-[72px] min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-3 py-2.5 text-left"
                aria-pressed={selected}
                aria-label={`${workspace.name}, ${sourceLabel}, ${tr(`status.workspace.${workspace.status}`)}`}
                onClick={() => onSelect(workspace.id)}
                onDoubleClick={() => void onOpen(workspace)}
              >
                <span className="grid size-9 place-items-center rounded-xl border border-border bg-background text-foreground transition-colors group-hover/workspace:border-primary/30">
                  <FolderGit2 size={16} aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <strong
                    className="block truncate text-sm font-semibold text-foreground"
                    title={workspace.name}
                  >
                    {workspace.name}
                  </strong>
                  <small className="mt-1 block truncate text-xs" title={workspace.path}>
                    {workspace.path}
                  </small>
                </span>
                <span className="grid justify-items-end gap-1.5">
                  {workspace.status === "attention" ? (
                    <Badge variant="destructive" className="text-[10px]">
                      {tr("status.workspace.attention")}
                    </Badge>
                  ) : (
                    <span
                      className="size-1.5 rounded-full bg-[var(--green)]"
                      title={tr("status.workspace.healthy")}
                      aria-label={tr("status.workspace.healthy")}
                    />
                  )}
                  <span
                    className="flex items-center gap-0.5"
                    aria-label={sourceLabel}
                    title={sourceLabel}
                  >
                    {sourceAgents.length ? (
                      sourceAgents.slice(0, 3).map((value) => (
                        <span
                          className="grid size-5 place-items-center rounded-md border border-border bg-background"
                          key={value}
                        >
                          <AgentIcon agent={value} compact />
                        </span>
                      ))
                    ) : (
                      <small className="text-[11px]">{tr("workspace.source.manual")}</small>
                    )}
                    {sourceAgents.length > 3 && (
                      <span className="grid size-5 place-items-center rounded-md bg-muted text-[9px] font-semibold">
                        +{sourceAgents.length - 3}
                      </span>
                    )}
                  </span>
                </span>
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="mr-2 shrink-0 opacity-60 transition-opacity hover:opacity-100 group-hover/workspace:opacity-100 focus-visible:opacity-100"
                aria-label={tr(favorite ? "workspace.removeFavorite" : "workspace.addFavorite", {
                  name: workspace.name,
                })}
                aria-pressed={favorite}
                title={tr(favorite ? "workspace.removeFavorite" : "workspace.addFavorite", {
                  name: workspace.name,
                })}
                onClick={() => onToggleFavorite(workspace.id)}
              >
                <Star size={15} className={favorite ? "fill-current" : ""} />
              </Button>
            </div>
          );
        })}
        {!workspaces.length && (
          <WorkspaceEmptyState title={tr("workspace.noMatch")} text={tr("workspace.noMatchText")} />
        )}
      </div>
      {filteredCount > 0 && (
        <footer className="flex min-h-[58px] items-center justify-between gap-3 border-t border-border px-4 py-3">
          <span className="text-xs tabular-nums text-muted-foreground">
            {pageStart}–{pageEnd} / {filteredCount}
          </span>
          {totalPages > 1 && (
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
          )}
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
