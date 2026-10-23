import { useI18n } from "@/core/useI18n";
import { Check, CircleAlert, FolderGit2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { AgentKind, ContextDoctorSummary, MemoryRecord, WorkspaceSummary } from "@/core/types";
import { AGENT_LABELS as agentLabels } from "@/core/agents";
import { getWorkspaceStatus } from "@/features/workspace/workspace-status";
import { usePathDisplay } from "@/lib/usePathDisplay";

export function RecentWorkspacesCard({
  workspaces,
  assetCounts,
  doctorSummaries,
  memories,
  onOpen,
  onShowWorkspaces,
  additionsBusy = false,
  onAddWorkspace,
  onAddRoot,
}: {
  workspaces: WorkspaceSummary[];
  assetCounts: Map<string, number>;
  doctorSummaries: Record<string, ContextDoctorSummary>;
  memories: MemoryRecord[];
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
  onShowWorkspaces: () => void;
  additionsBusy?: boolean;
  onAddWorkspace: () => Promise<void>;
  onAddRoot: () => Promise<void>;
}) {
  const { tr } = useI18n();
  const sortedWorkspaces = [...workspaces].sort((left, right) => {
    const leftAttention =
      getWorkspaceStatus(left.id, doctorSummaries[left.id], memories).state === "attention";
    const rightAttention =
      getWorkspaceStatus(right.id, doctorSummaries[right.id], memories).state === "attention";
    return (
      Number(rightAttention) - Number(leftAttention) ||
      (right.last_active_at ?? "").localeCompare(left.last_active_at ?? "")
    );
  });
  return (
    <Card className="overflow-hidden rounded-xl border-border bg-card shadow-none">
      <CardHeader className="flex flex-row items-center justify-between border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold">{tr("home.recentWorkspaces")}</h2>
        <Button
          variant="link"
          className="h-auto p-0 text-xs text-primary-text"
          onClick={onShowWorkspaces}
        >
          {tr("home.viewAll")}
        </Button>
      </CardHeader>
      <CardContent className="divide-y divide-border p-0">
        {sortedWorkspaces.slice(0, 4).map((workspace) => (
          <WorkspaceRow
            key={workspace.id}
            workspace={workspace}
            assetCount={assetCounts.get(workspace.id)}
            doctorSummary={doctorSummaries[workspace.id]}
            memories={memories}
            onOpen={onOpen}
          />
        ))}
        <div className="px-5 py-4">
          <WorkspaceAddActions
            busy={additionsBusy}
            primary={false}
            showHints={false}
            onAddWorkspace={onAddWorkspace}
            onAddRoot={onAddRoot}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export function WorkspaceAddActions({
  busy,
  primary = true,
  showHints = true,
  onAddWorkspace,
  onAddRoot,
}: {
  busy: boolean;
  primary?: boolean;
  showHints?: boolean;
  onAddWorkspace: () => Promise<void>;
  onAddRoot: () => Promise<void>;
}) {
  const { tr } = useI18n();
  return (
    <div className="grid gap-3 text-left">
      <div className="grid gap-1.5">
        <Button
          variant={primary ? "default" : "outline"}
          disabled={busy}
          aria-busy={busy}
          onClick={() => void onAddWorkspace()}
        >
          <FolderGit2 size={14} />
          {tr("home.addWorkspace")}
        </Button>
        {showHints && (
          <p className="text-xs leading-5 text-muted-foreground">{tr("home.addWorkspaceHint")}</p>
        )}
      </div>
      <div className="grid gap-1.5">
        <Button variant="outline" disabled={busy} onClick={() => void onAddRoot()}>
          {tr("home.addScanRoot")}
        </Button>
        {showHints && (
          <p className="text-xs leading-5 text-muted-foreground">{tr("home.addScanRootHint")}</p>
        )}
      </div>
    </div>
  );
}

function WorkspaceRow({
  workspace,
  assetCount,
  doctorSummary,
  memories,
  onOpen,
}: {
  workspace: WorkspaceSummary;
  assetCount?: number;
  doctorSummary?: ContextDoctorSummary;
  memories: MemoryRecord[];
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
}) {
  const { tr } = useI18n();
  const displayPath = usePathDisplay();
  const status = getWorkspaceStatus(workspace.id, doctorSummary, memories);
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
      <div className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground">
        <FolderGit2 size={19} />
      </div>
      <div className="min-w-0">
        <strong className="block truncate text-sm font-semibold">{workspace.name}</strong>
        <small className="mt-1 block truncate text-xs text-muted-foreground" title={workspace.path}>
          {displayPath(workspace.path)}
        </small>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {agents} · {tr("workspace.assetCount", { count })}
        </span>
      </div>
      {status.state === "attention" ? (
        <Badge variant="secondary" className="gap-1 bg-warning/10 text-warning">
          <CircleAlert size={13} />
          {tr("workspace.status.attention", { count: status.issueCount })}
        </Badge>
      ) : status.state === "healthy" ? (
        <Badge variant="secondary" className="gap-1 bg-emerald-500/10 text-emerald-700">
          <Check size={13} />
          {tr("workspace.status.healthy")}
        </Badge>
      ) : (
        <Badge variant="secondary" className="bg-muted text-muted-foreground">
          {tr("workspace.status.undiagnosed")}
        </Badge>
      )}
    </Button>
  );
}
