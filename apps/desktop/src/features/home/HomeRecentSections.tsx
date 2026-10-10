import { useI18n } from "@/core/useI18n";
import { Check, CircleAlert, FileText, FolderGit2, History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { ActivityRecord, AgentKind, WorkspaceSummary } from "@/core/types";
import { activityPresentation } from "@/features/activity/activity-presentation";
import { AGENT_LABELS as agentLabels } from "@/core/agents";

export function RecentActivitySection({
  activity,
  pending,
  onShowInsights,
}: {
  activity: ActivityRecord[];
  pending: boolean;
  onShowInsights: () => void;
}) {
  const { tr } = useI18n();
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold">{tr("home.recentActivity")}</h2>
        <Button variant="link" className="h-auto p-0 text-xs text-primary" onClick={onShowInsights}>
          {tr("home.viewAll")}
        </Button>
      </div>
      {pending ? (
        <p role="status" aria-live="polite" className="py-4 text-sm text-muted-foreground">
          {tr("common.loading")}
        </p>
      ) : activity.length > 0 ? (
        <div className="grid divide-y divide-border">
          {activity.slice(0, 3).map((item) => (
            <ActivityRow key={item.id} record={item} />
          ))}
        </div>
      ) : (
        <div className="flex items-start gap-3 py-4">
          <History size={16} className="mt-0.5 text-muted-foreground" />
          <span>
            <strong className="block text-sm">{tr("home.noImportantActivity")}</strong>
            <p className="mt-1 text-xs text-muted-foreground">
              {tr("home.noImportantActivityText")}
            </p>
          </span>
        </div>
      )}
    </section>
  );
}

export function RecentWorkspacesCard({
  workspaces,
  assetCounts,
  onOpen,
  onShowWorkspaces,
  onAddRoot,
}: {
  workspaces: WorkspaceSummary[];
  assetCounts: Map<string, number>;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
  onShowWorkspaces: () => void;
  onAddRoot: () => Promise<void>;
}) {
  const { tr } = useI18n();
  return (
    <Card className="overflow-hidden rounded-xl border-border bg-card shadow-none">
      <CardHeader className="flex flex-row items-center justify-between border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold">{tr("home.recentWorkspaces")}</h2>
        <Button
          variant="link"
          className="h-auto p-0 text-xs text-primary"
          onClick={onShowWorkspaces}
        >
          {tr("home.viewAll")}
        </Button>
      </CardHeader>
      <CardContent className="divide-y divide-border p-0">
        {workspaces.slice(0, 3).map((workspace) => (
          <WorkspaceRow
            key={workspace.id}
            workspace={workspace}
            assetCount={assetCounts.get(workspace.id)}
            onOpen={onOpen}
          />
        ))}
        <div className="px-5 py-4">
          <Button className="gap-1.5" onClick={() => void onAddRoot()}>
            <FolderGit2 size={14} />
            {tr("home.createWorkspace")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function WorkspaceRow({
  workspace,
  assetCount,
  onOpen,
}: {
  workspace: WorkspaceSummary;
  assetCount?: number;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
}) {
  const { tr } = useI18n();
  const sourceAgents = workspace.sources
    .map((source) => source.agent)
    .filter((value): value is AgentKind => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
  const agents =
    sourceAgents.map((value) => agentLabels[value]).join(" · ") ||
    (workspace.sources.length ? tr("workspace.source.scan") : tr("workspace.source.manual"));
  const count = assetCount ?? workspace.asset_count;
  return (
    <Button
      variant="bare"
      size="content"
      className="group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-5 py-4 text-left hover:bg-muted/40"
      onClick={() => void onOpen(workspace)}
    >
      <div className="grid size-9 place-items-center rounded-lg text-emerald-700">
        <FolderGit2 size={19} />
      </div>
      <div className="min-w-0">
        <strong className="block truncate text-sm font-semibold">{workspace.name}</strong>
        <small className="mt-1 block truncate text-xs text-muted-foreground" title={workspace.path}>
          {workspace.path}
        </small>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {agents} · {tr("workspace.assetCount", { count })}
        </span>
      </div>
      {workspace.status === "attention" ? (
        <Badge variant="secondary" className="gap-1 bg-primary/10 text-primary">
          <CircleAlert size={13} />
          {tr("status.workspace.attention")}
        </Badge>
      ) : (
        <Badge variant="secondary" className="gap-1 bg-emerald-500/10 text-emerald-700">
          <Check size={13} />
          {tr("status.workspace.healthy")}
        </Badge>
      )}
    </Button>
  );
}

function ActivityRow({ record }: { record: ActivityRecord }) {
  const { tr, formatDateTime } = useI18n();
  const presentation = activityPresentation(record, tr);
  return (
    <div className="grid min-h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2 text-sm">
      <FileText size={16} className="text-muted-foreground" />
      <div className="min-w-0">
        <strong className="block truncate text-sm font-medium">{presentation.title}</strong>
        <small
          className="mt-0.5 block truncate text-xs text-muted-foreground"
          title={presentation.detail}
        >
          {presentation.detail}
        </small>
      </div>
      <time className="whitespace-nowrap text-xs text-muted-foreground">
        {formatDateTime(record.created_at)}
      </time>
    </div>
  );
}
