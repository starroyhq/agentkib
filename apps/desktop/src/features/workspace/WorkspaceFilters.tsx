import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
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
import { FolderGit2, Search } from "lucide-react";
import type { AgentKind } from "@/core/types";
import { AGENT_LABELS as agentLabels } from "@/core/agents";
import type { WorkspaceView } from "./workspace-page-types";
import type { WorkspaceDisplayState } from "./workspace-status";

export function WorkspacePageHeader({
  view,
  onAddWorkspace,
  onViewChange,
}: {
  view: WorkspaceView;
  onAddWorkspace: () => void;
  onViewChange: (view: WorkspaceView) => void;
}) {
  const { tr } = useI18n();
  return (
    <section className="flex flex-wrap items-center justify-between gap-3">
      <div>
        {view === "list" && (
          <Button className="h-9 rounded-lg px-3.5" onClick={onAddWorkspace}>
            <FolderGit2 size={15} />
            {tr("workspace.addWorkspace")}
          </Button>
        )}
      </div>
      <div
        role="group"
        aria-label={tr("workspace.viewLabel")}
        className="flex items-center rounded-lg border border-border bg-muted/50 p-1"
      >
        <Button
          variant={view === "list" ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={view === "list"}
          onClick={() => onViewChange("list")}
        >
          {tr("workspace.view.list")}
        </Button>
        <Button
          variant={view === "storage" ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={view === "storage"}
          onClick={() => onViewChange("storage")}
        >
          {tr("workspace.view.storage")}
        </Button>
      </div>
    </section>
  );
}

export function WorkspaceFilters({
  query,
  status,
  agent,
  onQueryChange,
  onStatusChange,
  onAgentChange,
}: {
  query: string;
  status: "all" | WorkspaceDisplayState;
  agent: "all" | AgentKind;
  onQueryChange: (value: string) => void;
  onStatusChange: (value: "all" | WorkspaceDisplayState) => void;
  onAgentChange: (value: "all" | AgentKind) => void;
}) {
  const { tr } = useI18n();
  return (
    <div className="rounded-2xl border border-border/70 bg-card shadow-sm">
      <div className="grid gap-3 p-4 sm:p-5 lg:grid-cols-[minmax(260px,1fr)_auto] lg:items-center">
        <div className="flex h-10 min-w-0 items-center gap-2 rounded-xl border border-input bg-background px-3 text-muted-foreground transition-[border-color,box-shadow] focus-within:border-primary/45 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_10%,transparent)]">
          <Search size={16} aria-hidden="true" />
          <Input
            className="!h-8 !border-0 !bg-transparent !px-0 !text-foreground !shadow-none placeholder:!text-muted-foreground focus-visible:!ring-0"
            aria-label={tr("workspace.searchPlaceholder")}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={tr("workspace.searchPlaceholder")}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={agent}
            onValueChange={(value) => {
              if (value !== null) onAgentChange(String(value) as "all" | AgentKind);
            }}
          >
            <SelectTrigger
              aria-label={tr("workspace.allAgents")}
              className="h-10 min-w-[146px] max-[520px]:min-w-0 max-[520px]:flex-1"
            >
              <SelectValue>
                {agent === "all" ? tr("workspace.allAgents") : agentLabels[agent]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{tr("workspace.allAgents")}</SelectLabel>
                <SelectItem value="all">{tr("workspace.allAgents")}</SelectItem>
                {Object.entries(agentLabels).map(([value, label]) => (
                  <SelectItem value={value} key={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            value={status}
            onValueChange={(value) => {
              if (value !== null) onStatusChange(String(value) as "all" | WorkspaceDisplayState);
            }}
          >
            <SelectTrigger
              aria-label={tr("workspace.allStatuses")}
              className="h-10 min-w-[146px] max-[520px]:min-w-0 max-[520px]:flex-1"
            >
              <SelectValue>
                {status === "all"
                  ? tr("workspace.allStatuses")
                  : tr(
                      status === "attention"
                        ? "workspace.status.attentionFilter"
                        : `workspace.status.${status}`,
                    )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{tr("workspace.allStatuses")}</SelectLabel>
                <SelectItem value="all">{tr("workspace.allStatuses")}</SelectItem>
                <SelectItem value="healthy">{tr("workspace.status.healthy")}</SelectItem>
                <SelectItem value="attention">{tr("workspace.status.attentionFilter")}</SelectItem>
                <SelectItem value="undiagnosed">{tr("workspace.status.undiagnosed")}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
