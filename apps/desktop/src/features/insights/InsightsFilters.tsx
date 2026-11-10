import type { Dispatch, SetStateAction } from "react";
import { useI18n } from "@/core/useI18n";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { validCustomDates, type InsightsDates } from "./insights-range";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { insightsAgentKinds } from "@/features/insights/insights";
import { AGENT_LABELS as agentLabels } from "@/core/agents";
import type { AgentKind, WorkspaceSummary } from "@/core/types";
import type {
  HeatmapMetric,
  InsightsAgentFilter,
  InsightsSection,
  InsightsRange,
} from "./InsightsTypes";

export function InsightsFilters({
  section,
  workspaces,
  metric,
  onMetricChange,
  agent,
  onAgentChange,
  workspaceId,
  onWorkspaceChange,
  repository,
  onRepositoryChange,
  range,
  onRangeChange,
  custom,
  onCustomChange,
  onApplyCustom,
  today,
}: {
  section: InsightsSection;
  workspaces: WorkspaceSummary[];
  metric: HeatmapMetric;
  onMetricChange: Dispatch<SetStateAction<HeatmapMetric>>;
  agent: InsightsAgentFilter;
  onAgentChange: Dispatch<SetStateAction<InsightsAgentFilter>>;
  workspaceId: string;
  onWorkspaceChange: Dispatch<SetStateAction<string>>;
  repository: string;
  onRepositoryChange: Dispatch<SetStateAction<string>>;
  range: InsightsRange;
  onRangeChange: (value: InsightsRange) => void;
  custom: InsightsDates;
  onCustomChange: (value: InsightsDates) => void;
  onApplyCustom: () => void;
  today: string;
}) {
  const { tr } = useI18n();
  const metricLabels: Record<HeatmapMetric, string> = {
    tokens: tr("insights.tokens"),
    my_commits: tr("insights.myCommits"),
    all_commits: tr("insights.allCommits"),
    attributed_commits: tr("insights.attributedCommits"),
    sessions: tr("common.sessions"),
  };
  const rangeLabels = {
    "7d": tr("insights.range7d"),
    "30d": tr("insights.range30d"),
    "90d": tr("insights.range90d"),
    "52w": tr("insights.range52w"),
    year: tr("insights.rangeYear"),
    custom: tr("insights.rangeCustom"),
  };
  const repositoryOptions = [
    ...new Map(
      workspaces
        .filter((value) => value.repository_group_id)
        .map((value) => [value.repository_group_id!, value.name]),
    ).entries(),
  ];
  const agentItems = [
    { label: tr("workspace.allAgents"), value: "all" },
    ...insightsAgentKinds.map((value) => ({ label: agentLabels[value], value })),
  ];
  const workspaceItems = [
    { label: tr("workspace.all"), value: "all" },
    ...workspaces.map((value) => ({ label: value.name, value: value.id })),
  ];
  const repositoryItems = [
    { label: tr("insights.allRepositories"), value: "all" },
    ...repositoryOptions.map(([value, label]) => ({ label, value })),
  ];
  const rangeItems = Object.entries(rangeLabels).map(([value, label]) => ({ value, label }));
  const showTokenFilters = section === "overview" || section === "tokens";
  const showCommitFilters = section === "overview" || section === "commits";
  const showRange = !["milestones", "sources"].includes(section);
  const showMetricTabs = section === "overview";

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      {showMetricTabs && (
        <Tabs
          value={metric}
          onValueChange={(value) => onMetricChange(value as HeatmapMetric)}
          className="min-w-0 max-w-full"
        >
          <TabsList
            className="segmented-control !h-auto w-fit max-w-full justify-start overflow-x-auto"
            variant="default"
            aria-label={tr("insights.heatmap")}
          >
            {(Object.keys(metricLabels) as HeatmapMetric[]).map((value) => (
              <TabsTrigger
                className="segmented-control-item h-9 min-h-9 flex-none px-3"
                key={value}
                value={value}
              >
                {metricLabels[value]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      <div className="flex min-w-0 flex-[1_1_420px] flex-wrap items-center justify-start gap-2">
        {showTokenFilters && (
          <Select
            items={agentItems}
            value={agent}
            onValueChange={(value) => {
              if (value !== null) onAgentChange(String(value) as AgentKind | "all");
            }}
          >
            <SelectTrigger className="max-w-48" aria-label={tr("insights.agentFilter")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{tr("insights.agentFilter")}</SelectLabel>
                {agentItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        {showTokenFilters && (
          <Select
            items={workspaceItems}
            value={workspaceId}
            onValueChange={(value) => {
              if (value !== null) onWorkspaceChange(String(value));
            }}
          >
            <SelectTrigger className="max-w-48" aria-label={tr("insights.workspaceFilter")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{tr("insights.workspaceFilter")}</SelectLabel>
                {workspaceItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        {showCommitFilters && (
          <Select
            items={repositoryItems}
            value={repository}
            onValueChange={(value) => {
              if (value !== null) onRepositoryChange(String(value));
            }}
          >
            <SelectTrigger className="max-w-48" aria-label={tr("insights.repositoryFilter")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{tr("insights.repositoryFilter")}</SelectLabel>
                {repositoryItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        {showRange && (
          <Select
            items={rangeItems}
            value={range}
            onValueChange={(value) => {
              if (value !== null) onRangeChange(String(value) as InsightsRange);
            }}
          >
            <SelectTrigger className="max-w-48" aria-label={tr("insights.range")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{tr("insights.range")}</SelectLabel>
                {rangeItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        {showRange && range === "custom" && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Input
              className="w-36"
              type="date"
              aria-label={tr("insights.fromDate")}
              max={today}
              value={custom.from}
              onChange={(event) => onCustomChange({ ...custom, from: event.target.value })}
            />
            <span aria-hidden="true">—</span>
            <Input
              className="w-36"
              type="date"
              aria-label={tr("insights.toDate")}
              min={custom.from}
              max={today}
              value={custom.to}
              onChange={(event) => onCustomChange({ ...custom, to: event.target.value })}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!validCustomDates(custom, today)}
              onClick={onApplyCustom}
            >
              {tr("insights.applyRange")}
            </Button>
            {!validCustomDates(custom, today) && (
              <p role="status" className="text-xs text-destructive-text">
                {tr("insights.invalidRange")}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
