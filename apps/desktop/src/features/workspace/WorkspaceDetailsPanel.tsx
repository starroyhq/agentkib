import { useI18n } from "@/core/useI18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { WorkspaceSummary } from "@/core/types";
import { ChevronRight, FolderGit2, RefreshCw, Trash2 } from "lucide-react";
import { AGENT_LABELS as agentLabels } from "@/core/agents";

export function WorkspaceDetailsPanel({
  workspace,
  assetCount,
  catalogPending,
  catalogError,
  refreshing,
  onOpen,
  onRefresh,
  onExclude,
}: {
  workspace: WorkspaceSummary;
  assetCount: number;
  catalogPending: boolean;
  catalogError: boolean;
  refreshing: boolean;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
  onRefresh: (id: string) => Promise<void>;
  onExclude: (id: string) => Promise<void>;
}) {
  const { tr, formatRelativeTime } = useI18n();
  const agents =
    workspace.sources
      .flatMap((source) => (source.agent ? [agentLabels[source.agent]] : []))
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(" · ") || tr("workspace.source.manual");

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex items-start justify-between gap-4 border-b border-border p-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-muted/50 text-foreground">
            <FolderGit2 size={18} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{workspace.name}</h2>
              <Badge
                variant={workspace.status === "attention" ? "destructive" : "secondary"}
                className={
                  workspace.status === "healthy"
                    ? "bg-emerald-500/10 text-emerald-700"
                    : "text-[10px]"
                }
              >
                {tr(`status.workspace.${workspace.status}`)}
              </Badge>
            </div>
            <code
              className="mt-1 block truncate text-xs text-muted-foreground"
              title={workspace.path}
            >
              {workspace.path}
            </code>
          </div>
        </div>
        <Button className="shrink-0 rounded-lg" onClick={() => void onOpen(workspace)}>
          {tr("common.details")}
          <ChevronRight size={15} />
        </Button>
      </header>
      <div className="grid grid-cols-3 divide-x divide-border border-b border-border">
        {[
          [tr("workspace.agentColumn"), workspace.sources.length],
          [tr("workspace.assetsColumn"), catalogPending ? "…" : catalogError ? "—" : assetCount],
          [
            tr("workspace.activityColumn"),
            workspace.last_active_at
              ? formatRelativeTime(workspace.last_active_at)
              : tr("common.never"),
          ],
        ].map(([label, value]) => (
          <div className="grid min-h-[84px] content-center gap-1 px-4" key={label}>
            <span className="text-xs text-muted-foreground">{label}</span>
            <strong className="truncate text-sm">{value}</strong>
          </div>
        ))}
      </div>
      <div className="grid gap-3 p-5">
        <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/60 px-4 py-3">
          <span className="text-sm text-muted-foreground">{tr("workspace.discoverySources")}</span>
          <strong className="text-right text-sm">{agents}</strong>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            aria-busy={refreshing}
            disabled={refreshing}
            onClick={() => void onRefresh(workspace.id)}
          >
            <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? tr("common.loading") : tr("common.scan")}
          </Button>
          <Button
            variant="outline"
            className="text-destructive"
            onClick={() => void onExclude(workspace.id)}
          >
            <Trash2 size={15} />
            {tr("workspace.ignore")}
          </Button>
        </div>
      </div>
    </section>
  );
}
