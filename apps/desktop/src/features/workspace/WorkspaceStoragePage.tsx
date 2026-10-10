import { useQuery } from "@tanstack/react-query";
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
import { Card, CardContent } from "@/components/ui/card";
import { WorkspaceStorageSkeleton } from "./WorkspaceSkeleton";
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useEffect, useMemo, useState } from "react";
import { hierarchy, treemap, treemapResquarify } from "d3-hierarchy";
import {
  CircleAlert,
  ExternalLink,
  HardDrive,
  Pause,
  RefreshCw,
  ScanLine,
  Search,
  X,
} from "lucide-react";
import { api } from "@/core/api";
import { withAsyncCleanup } from "@/lib/utils";
import type {
  AgentKind,
  RefreshJobStatus,
  StorageNode,
  StorageOverview,
  WorkspaceStorage,
  WorkspaceSummary,
} from "@/core/types";
import { AGENT_LABELS as agentLabels } from "@/core/agents";
import {
  homeKeys,
  queryDefaults,
  useHomeStorageOverview,
  useOptionalQueryClient,
} from "@/features/home/home-query";

type StorageMetric = "allocated" | "regenerable" | "agent-assets";
interface StorageLocation {
  workspaceId: string;
  node: StorageNode;
}
interface StorageSelection extends StorageLocation {
  parentBytes: number;
  workspaceBytes: number;
}
interface StorageChartItem {
  id: string;
  name: string;
  size: number;
  storageNode: StorageNode;
  workspaceId: string;
}
interface StorageChartRoot {
  children: StorageChartItem[];
}
interface StorageHover extends StorageLocation {
  bytes: number;
  ratio: number;
  left: number;
  top: number;
  bottom: number;
}

export function WorkspaceStoragePage({
  workspaces,
  job,
}: {
  workspaces: WorkspaceSummary[];
  job?: RefreshJobStatus;
}) {
  const { formatDateTime, locale, localizeMessage, tr } = useI18n();
  const queryClient = useOptionalQueryClient();
  const overviewQuery = useHomeStorageOverview();
  const overview: StorageOverview | undefined = overviewQuery.data;
  const loaded = !overviewQuery.isPending;
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState<"all" | AgentKind>("all");
  const [metric, setMetric] = useState<StorageMetric>("allocated");
  const [trail, setTrail] = useState<StorageLocation[]>([]);
  const [selected, setSelected] = useState<StorageSelection>();
  const [expansion, setExpansion] = useState<{
    location: StorageLocation;
    relativePath: string;
    trail: StorageLocation[];
  }>();
  const childrenQuery = useQuery(
    {
      ...queryDefaults,
      queryKey: [
        "storage-children",
        expansion?.location.workspaceId,
        expansion?.relativePath,
        overviewQuery.dataUpdatedAt,
      ],
      queryFn: () =>
        api.workspaceStorageChildren(expansion!.location.workspaceId, expansion!.relativePath),
      enabled: !!expansion,
      staleTime: Infinity,
    },
    queryClient,
  );
  const expanding = !!expansion && childrenQuery.isPending;
  useEffect(() => {
    if (!expansion || !childrenQuery.data) return;
    const next = { workspaceId: expansion.location.workspaceId, node: childrenQuery.data };
    setTrail(
      expansion.location.node.kind === "aggregate" && expansion.trail.length
        ? [...expansion.trail.slice(0, -1), next]
        : [...expansion.trail, next],
    );
    setExpansion(undefined);
  }, [expansion, childrenQuery.data]);
  const [failure, setFailure] = useState<{ reason: unknown; expanding?: boolean }>();
  const error = failure
    ? `${failure.expanding ? `${tr("storage.expandFailed")}: ` : ""}${localizeMessage(failure.reason)}`
    : expansion && childrenQuery.error
      ? `${tr("storage.expandFailed")}: ${localizeMessage(childrenQuery.error)}`
      : overviewQuery.error
        ? localizeMessage(overviewQuery.error)
        : "";
  const [refreshPending, setRefreshPending] = useState(false);
  const active = refreshPending || job?.state === "queued" || job?.state === "running";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (selected) setSelected(undefined);
      else if (trail.length) {
        setExpansion(undefined);
        setTrail((value) => value.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, trail.length]);

  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  );
  const storageById = useMemo(
    () => new Map((overview?.workspaces ?? []).map((storage) => [storage.workspace_id, storage])),
    [overview],
  );
  const workspaceNodes = useMemo(
    () =>
      (overview?.workspaces ?? [])
        .filter((storage) => {
          const workspace = workspaceById.get(storage.workspace_id);
          const matchesAgent =
            agent === "all" || workspace?.sources.some((source) => source.agent === agent);
          return matchesAgent;
        })
        .map((storage) => ({
          workspaceId: storage.workspace_id,
          node: storage.root ?? legacyRoot(storage, tr),
        })),
    [agent, overview, workspaceById, tr],
  );
  const current = trail.at(-1);
  const displayed = current
    ? current.node.children.map((node) => ({ workspaceId: current.workspaceId, node }))
    : workspaceNodes;
  const chartData: StorageChartItem[] = displayed
    .map((item) => ({
      id: `${item.workspaceId}:${item.node.id}`,
      name: nodeLabel(item.node, tr),
      size: metricBytes(item.node, metric),
      storageNode: item.node,
      workspaceId: item.workspaceId,
    }))
    .filter((item) => item.size > 0);
  const parentBytes = current
    ? metricBytes(current.node, metric)
    : chartData.reduce((sum, item) => sum + item.size, 0);
  const stale = Boolean(
    overview?.last_scanned_at &&
    Date.now() - new Date(overview.last_scanned_at).getTime() > 86_400_000,
  );
  const legacy = Boolean(
    overview?.workspaces.some((storage) => storage.snapshot_version < 2 || !storage.root),
  );
  const hasCache = Boolean(overview?.scanned_workspace_count);
  const estimated =
    overview?.workspaces.some((item) => item.measurement === "logical-estimate") ?? false;
  const coverage = overview?.total_workspace_count
    ? Math.round((overview.scanned_workspace_count / overview.total_workspace_count) * 100)
    : 0;
  const progressTotal = job?.progress_total || workspaces.length || 1;
  const progressCurrent = Math.min(job?.progress_current ?? 0, progressTotal);
  const progressValue = Math.round((progressCurrent / progressTotal) * 100);

  const start = async () => {
    setFailure(undefined);
    setRefreshPending(true);
    await withAsyncCleanup(
      async () => {
        try {
          const receipt = await api.requestRefresh("storage", true);
          // 异步完成的扫描由 useHomeQueryEvents 在任务成功时刷新；这里只处理同步完成的情况。
          if (receipt.status.state === "succeeded")
            await queryClient.invalidateQueries({ queryKey: homeKeys.storageOverview() });
        } catch (reason) {
          setFailure({ reason });
        }
      },
      () => setRefreshPending(false),
    );
  };
  const stop = async () => {
    await api.cancelStorageScan();
  };

  const enter = async (location: StorageLocation) => {
    if (location.node.kind === "root-files") return;
    setSelected(undefined);
    if (location.node.children.length) {
      setTrail((value) => [...value, location]);
      return;
    }
    if (!location.node.expandable && location.node.kind !== "aggregate") return;
    const relativePath =
      location.node.kind === "aggregate"
        ? (current?.node.relative_path ?? "")
        : location.node.relative_path;
    setFailure(undefined);
    setExpansion({ location, relativePath, trail });
    if (
      childrenQuery.isError &&
      expansion?.location.workspaceId === location.workspaceId &&
      expansion.relativePath === relativePath
    )
      void childrenQuery.refetch({ cancelRefetch: false });
  };

  const select = (location: StorageLocation) => {
    const storage = storageById.get(location.workspaceId);
    setSelected({
      ...location,
      parentBytes,
      workspaceBytes: storage
        ? metricStorageBytes(storage, metric)
        : metricBytes(location.node, metric),
    });
  };

  if (!loaded) return <WorkspaceStorageSkeleton />;

  return (
    <div className="min-w-0 space-y-4">
      {hasCache && (
        <div className="flex min-h-12 flex-wrap items-center gap-2">
          <label className="flex max-w-[360px] flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3 text-muted-foreground">
            <Search size={16} />
            <Input
              className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr("storage.searchPlaceholder")}
            />
          </label>
          <Select
            value={agent}
            onValueChange={(value) => {
              if (value === null) return;
              setAgent(String(value) as typeof agent);
              setExpansion(undefined);
              setTrail([]);
              setSelected(undefined);
            }}
          >
            <SelectTrigger aria-label={tr("workspace.allAgents")} className="h-9 min-w-[150px]">
              <SelectValue>
                {agent === "all" ? tr("workspace.allAgents") : agentLabels[agent]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{tr("workspace.allAgents")}</SelectLabel>
                <SelectItem value="all">{tr("workspace.allAgents")}</SelectItem>
                {Object.entries(agentLabels).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <ToggleGroup
            spacing={0}
            variant="default"
            className="segmented-control shrink-0"
            value={[metric]}
            onValueChange={(values) => {
              const value = values[0];
              if (value) {
                setMetric(value as StorageMetric);
                setSelected(undefined);
              }
            }}
            aria-label={tr("storage.metricLabel")}
          >
            {(["allocated", "regenerable", "agent-assets"] as StorageMetric[]).map((value) => (
              <ToggleGroupItem
                key={value}
                value={value}
                className="segmented-control-item h-9 min-h-9 min-w-[84px] font-semibold"
              >
                {tr(`storage.metric.${value}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {active ? (
            <Button variant="outline" onClick={() => void stop()}>
              <Pause size={14} />
              {tr("storage.stopScan")}
            </Button>
          ) : (
            <Button onClick={() => void start()}>
              <RefreshCw size={14} />
              {tr("storage.scanAgain")}
            </Button>
          )}
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <CircleAlert size={16} />
          {error}
        </div>
      )}
      {hasCache && (
        <Card className="grid grid-cols-2 divide-x divide-border overflow-hidden p-0 lg:grid-cols-4">
          <Metric
            label={tr("storage.allocated")}
            value={formatBytes(overview?.allocated_bytes ?? 0, locale)}
            meta={estimated ? tr("storage.estimated") : undefined}
          />
          <Metric
            label={tr("storage.regenerable")}
            value={formatBytes(overview?.regenerable_bytes ?? 0, locale)}
          />
          <Metric
            label={tr("storage.agentAssets")}
            value={formatBytes(overview?.agent_asset_bytes ?? 0, locale)}
          />
          <Metric
            label={tr("storage.coverage")}
            value={`${overview?.scanned_workspace_count ?? 0} / ${overview?.total_workspace_count ?? workspaces.length}`}
            meta={`${coverage}%`}
          />
        </Card>
      )}
      {active && (
        <div
          className="flex min-h-[68px] items-center gap-3 rounded-xl border border-primary/20 bg-primary/[0.04] px-3.5 py-2.5 text-sm"
          role="status"
          aria-live="polite"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <ScanLine
              size={18}
              className={job?.state === "running" ? "animate-pulse" : undefined}
            />
          </span>
          <div className="min-w-0 shrink-0 sm:min-w-[150px]">
            <strong className="block truncate font-semibold text-foreground">
              {job?.state === "queued" ? tr("storage.waiting") : tr("storage.scanning")}
            </strong>
            <span className="text-xs text-muted-foreground">{progressValue}%</span>
          </div>
          <div className="min-w-0 flex-1">
            <Progress className="h-2 bg-primary/10" value={progressValue} />
          </div>
          <strong className="shrink-0 whitespace-nowrap font-mono text-sm tabular-nums text-foreground">
            {progressCurrent} / {progressTotal}
          </strong>
        </div>
      )}
      {hasCache && (stale || legacy) && (
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-amber-600">
          {stale && (
            <span className="inline-flex items-center gap-1.5">
              <CircleAlert size={14} />
              {tr("storage.stale")}
            </span>
          )}
          {legacy && (
            <span className="inline-flex items-center gap-1.5">
              <CircleAlert size={14} />
              {tr("storage.legacySnapshot")}
            </span>
          )}
        </div>
      )}
      {!hasCache ? (
        <EmptyState active={active} overview={overview} start={start} stop={stop} />
      ) : (
        <div
          className={`grid min-h-[510px] gap-3.5 ${selected ? "lg:grid-cols-[minmax(0,1fr)_320px]" : "grid-cols-1"}`}
        >
          <Card className="min-w-0 overflow-hidden">
            <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
              <nav
                className="flex min-w-0 items-center gap-1.5 overflow-hidden text-sm"
                aria-label={tr("storage.location")}
              >
                <Button
                  variant="bare"
                  size="content"
                  onClick={() => {
                    setExpansion(undefined);
                    setTrail([]);
                    setSelected(undefined);
                  }}
                >
                  {tr("storage.allWorkspaces")}
                </Button>
                {trail.map((item, index) => (
                  <span
                    className="flex min-w-0 items-center gap-1.5"
                    key={`${item.workspaceId}:${item.node.id}`}
                  >
                    <b className="text-muted-foreground">/</b>
                    <Button
                      variant="bare"
                      size="content"
                      className="min-w-0 truncate"
                      aria-current={index === trail.length - 1 ? "page" : undefined}
                      onClick={() => {
                        setExpansion(undefined);
                        setTrail((value) => value.slice(0, index + 1));
                        setSelected(undefined);
                      }}
                    >
                      {nodeLabel(item.node, tr)}
                    </Button>
                  </span>
                ))}
              </nav>
              <span className="shrink-0 text-xs text-muted-foreground">
                {expanding
                  ? tr("storage.loadingDirectory")
                  : overview?.last_scanned_at
                    ? tr("storage.scannedAt", { time: formatDateTime(overview.last_scanned_at) })
                    : ""}
              </span>
            </div>
            <StorageLegend />
            {chartData.length ? (
              <StorageTreemapChart
                data={chartData}
                metric={metric}
                parentBytes={parentBytes}
                query={query}
                selected={selected}
                onSelect={select}
                onEnter={enter}
              />
            ) : (
              <div className="m-2 grid min-h-[390px] place-content-center justify-items-center gap-2 rounded-lg bg-muted text-sm text-muted-foreground">
                <HardDrive size={26} />
                <span>{tr("storage.noItemsForMetric")}</span>
              </div>
            )}
          </Card>
          {selected && (
            <StorageInspector
              selection={selected}
              storage={storageById.get(selected.workspaceId)}
              workspace={workspaceById.get(selected.workspaceId)}
              metric={metric}
              onClose={() => setSelected(undefined)}
              onError={(reason) => setFailure({ reason })}
            />
          )}
        </div>
      )}
    </div>
  );
}

function StorageTreemapChart({
  data,
  metric,
  parentBytes,
  query,
  selected,
  onSelect,
  onEnter,
}: {
  data: StorageChartItem[];
  metric: StorageMetric;
  parentBytes: number;
  query: string;
  selected?: StorageSelection;
  onSelect: (location: StorageLocation) => void;
  onEnter: (location: StorageLocation) => Promise<void>;
}) {
  const { tr } = useI18n();
  const [width, setWidth] = useState(0);
  const [hovered, setHovered] = useState<StorageHover>();
  const [chartElement, setChartElement] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!chartElement) return;
    const updateWidth = () => setWidth(Math.floor(chartElement.clientWidth));
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(chartElement);
    return () => observer.disconnect();
  }, [chartElement]);

  const root = useMemo(() => {
    if (!width) return undefined;
    const hierarchyRoot = hierarchy<StorageChartRoot | StorageChartItem>(
      { children: data },
      (value) => ("children" in value ? value.children : undefined),
    )
      .sum((value) => ("size" in value ? value.size : 0))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return treemap<StorageChartRoot | StorageChartItem>()
      .size([width, 510])
      .paddingOuter(2)
      .paddingInner(4)
      .round(true)
      .tile(treemapResquarify)(hierarchyRoot);
  }, [data, width]);

  return (
    <div
      ref={setChartElement}
      className="relative min-h-[510px] overflow-hidden bg-background p-1"
      role="tree"
      onMouseLeave={() => setHovered(undefined)}
    >
      {root && (
        <svg
          aria-label={tr("storage.mapTitle")}
          className="block h-[510px] w-full"
          viewBox={`0 0 ${width} 510`}
          preserveAspectRatio="none"
          role="presentation"
        >
          {root.children?.map((node) => {
            const item = node.data;
            if (!("storageNode" in item)) return null;
            return (
              <StorageTreemapContent
                key={item.id}
                x={node.x0}
                y={node.y0}
                width={Math.max(0, node.x1 - node.x0)}
                height={Math.max(0, node.y1 - node.y0)}
                storageNode={item.storageNode}
                workspaceId={item.workspaceId}
                metric={metric}
                parentBytes={parentBytes}
                query={query}
                onSelect={onSelect}
                onEnter={onEnter}
                selected={selected}
                onHover={(location, bounds) =>
                  setHovered({
                    ...location,
                    bytes: metricBytes(location.node, metric),
                    ratio: parentBytes > 0 ? metricBytes(location.node, metric) / parentBytes : 0,
                    ...bounds,
                  })
                }
                onHoverEnd={() => setHovered(undefined)}
              />
            );
          })}
        </svg>
      )}
      {hovered && <StorageTreemapTooltip hover={hovered} chartWidth={width} />}
    </div>
  );
}

function StorageTreemapContent({
  x,
  y,
  width,
  height,
  storageNode: rawStorageNode,
  workspaceId: rawWorkspaceId,
  metric,
  parentBytes,
  query,
  onSelect,
  onEnter,
  selected,
  onHover,
  onHoverEnd,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  storageNode?: unknown;
  workspaceId?: unknown;
  metric: StorageMetric;
  parentBytes: number;
  query: string;
  onSelect: (location: StorageLocation) => void;
  onEnter: (location: StorageLocation) => Promise<void>;
  selected?: StorageSelection;
  onHover: (
    location: StorageLocation,
    bounds: { left: number; top: number; bottom: number },
  ) => void;
  onHoverEnd: () => void;
}) {
  const { locale, tr } = useI18n();
  const node = rawStorageNode as StorageNode | undefined;
  const workspaceId = typeof rawWorkspaceId === "string" ? rawWorkspaceId : undefined;
  if (!node || !workspaceId) return <g />;

  const bytes = metricBytes(node, metric);
  const ratio = parentBytes > 0 ? bytes / parentBytes : 0;
  const area = width * height;
  const match = matchesNode(node, query);
  const hasDescendantMatch = containsMatch(node, query);
  const detail =
    area >= 50000 && width >= 170 && height >= 110
      ? "rich"
      : area >= 16000 && width >= 115 && height >= 68
        ? "medium"
        : area >= 4200 && width >= 80 && height >= 34
          ? "name"
          : "tiny";
  const kind = semanticKind(node);
  const fill = storageFill(kind);
  const textFill = storageTextColor(kind);
  const opacity = query.trim() && !hasDescendantMatch ? 0.35 : 1;
  const location = { workspaceId, node };
  const labelSize = detail === "rich" ? 14 : detail === "medium" ? 12 : 11;
  const isSelected = selected?.workspaceId === workspaceId && selected.node.id === node.id;
  const label = fitTreemapLabel(nodeLabel(node, tr), Math.max(0, width - 18), labelSize);

  return (
    <g
      role="treeitem"
      tabIndex={0}
      aria-label={`${nodeLabel(node, tr)}, ${formatBytes(bytes, locale)}, ${formatPercent(ratio, locale)}`}
      aria-selected={isSelected}
      opacity={opacity}
      onClick={() => onSelect(location)}
      onDoubleClick={() => void onEnter(location)}
      onMouseEnter={() =>
        onHover(location, {
          left: x + width / 2,
          top: y,
          bottom: y + height,
        })
      }
      onMouseLeave={onHoverEnd}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void onEnter(location);
        }
      }}
    >
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={7}
        fill={fill}
        stroke={isSelected || (match && query.trim()) ? "var(--primary)" : "var(--border)"}
        strokeWidth={isSelected ? 3 : match && query.trim() ? 2 : 1}
        strokeDasharray={node.partial ? "5 3" : undefined}
        className="transition-[opacity,filter] duration-200 hover:brightness-95 dark:hover:brightness-125"
      />
      {detail !== "tiny" && (
        <text
          x={x + width / 2}
          y={y + height / 2 - (detail === "rich" ? 13 : 5)}
          fill={textFill}
          fontSize={labelSize}
          fontWeight={650}
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {label}
        </text>
      )}
      {(detail === "medium" || detail === "rich") && (
        <text
          x={x + width / 2}
          y={y + height / 2 + 8}
          fill={textFill}
          fontSize={labelSize - 1}
          opacity={0.85}
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {formatBytes(bytes, locale)}
        </text>
      )}
      {detail === "rich" && (
        <text
          x={x + width / 2}
          y={y + height / 2 + 27}
          fill={textFill}
          fontSize={11}
          opacity={0.75}
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {formatPercent(ratio, locale)} · {tr(`storage.type.${kind}`)}
        </text>
      )}
    </g>
  );
}

type StorageKind = "normal" | "regenerable" | "agent" | "git" | "aggregate";

function StorageLegend() {
  const { tr } = useI18n();
  const items: Array<{ kind: StorageKind; label: string }> = [
    { kind: "normal", label: tr("storage.type.normal") },
    { kind: "regenerable", label: tr("storage.type.regenerable") },
    { kind: "agent", label: tr("storage.type.agent") },
    { kind: "git", label: tr("storage.type.git") },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-subtle px-4 py-2 text-[11px] text-muted-foreground">
      {items.map((item) => (
        <span className="inline-flex items-center gap-1.5" key={item.kind}>
          <span
            aria-hidden="true"
            className="size-2.5 rounded-[3px] border border-border/60"
            style={{ backgroundColor: storageFill(item.kind) }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function StorageTreemapTooltip({ hover, chartWidth }: { hover: StorageHover; chartWidth: number }) {
  const { locale, tr } = useI18n();
  const nearLeft = hover.left < 170;
  const nearRight = chartWidth > 0 && hover.left > chartWidth - 170;
  const above = hover.top > 94;
  const horizontalStyle = nearLeft
    ? { left: 12 }
    : nearRight
      ? { right: 12 }
      : { left: hover.left, transform: "translateX(-50%)" };
  return (
    <div
      className="pointer-events-none absolute z-10 w-[min(240px,calc(100%-24px))] rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
      role="tooltip"
      style={{
        ...horizontalStyle,
        top: above ? Math.max(8, hover.top - 8) : hover.bottom + 8,
        ...(above ? { transform: `${horizontalStyle.transform ?? ""} translateY(-100%)` } : {}),
      }}
    >
      <div className="truncate font-semibold">{nodeLabel(hover.node, tr)}</div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
        <span>{formatBytes(hover.bytes, locale)}</span>
        <span className="text-right">{formatPercent(hover.ratio, locale)}</span>
        <span className="col-span-2 truncate">
          {tr(`storage.type.${semanticKind(hover.node)}`)}
        </span>
      </div>
    </div>
  );
}

function EmptyState({
  active,
  overview,
  start,
  stop,
}: {
  active: boolean;
  overview?: StorageOverview;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}) {
  const { tr } = useI18n();
  return (
    <Card className="grid min-h-[340px] place-content-center justify-items-center gap-2 p-6 text-center">
      <HardDrive size={32} />
      <h2 className="m-0 text-base font-semibold">
        {active ? tr("storage.scanning") : tr("storage.emptyTitle")}
      </h2>
      {!active && (
        <p className="m-0 max-w-[420px] text-sm text-muted-foreground">{tr("storage.emptyText")}</p>
      )}
      {overview?.workspaces.map((item) => (
        <span
          className="inline-flex items-center gap-1.5 text-xs text-amber-600"
          key={item.workspace_id}
        >
          <CircleAlert size={13} />
          {item.name} · {tr(item.error_key ?? "storage.scanUnavailable")}
        </span>
      ))}
      {active ? (
        <Button variant="outline" className="mt-2" onClick={() => void stop()}>
          <Pause size={14} />
          {tr("storage.stopScan")}
        </Button>
      ) : (
        <Button className="mt-2" onClick={() => void start()}>
          {tr("storage.startScan")}
        </Button>
      )}
    </Card>
  );
}

function Metric({ label, value, meta }: { label: string; value: string; meta?: string }) {
  return (
    <CardContent className="grid min-h-[72px] min-w-0 content-center gap-1 px-4 py-3">
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      <strong className="truncate text-lg text-foreground">{value}</strong>
      {meta && <small className="text-xs text-muted-foreground">{meta}</small>}
    </CardContent>
  );
}

function StorageInspector({
  selection,
  storage,
  workspace,
  metric,
  onClose,
  onError,
}: {
  selection: StorageSelection;
  storage?: WorkspaceStorage;
  workspace?: WorkspaceSummary;
  metric: StorageMetric;
  onClose: () => void;
  onError: (reason: unknown) => void;
}) {
  const { locale, tr } = useI18n();
  const { node } = selection;
  const agents =
    workspace?.sources
      .flatMap((source) => (source.agent ? [agentLabels[source.agent]] : []))
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(" · ") || "—";
  const fullPath = displayPath(storage?.path ?? "", node.relative_path);
  const open = async () => {
    try {
      await api.openWorkspaceStoragePath(
        selection.workspaceId,
        node.kind === "aggregate" ? "" : node.relative_path,
      );
    } catch (reason) {
      onError(reason);
    }
  };
  return (
    <Card className="min-w-0 overflow-hidden lg:max-h-full">
      <div className="flex min-h-12 items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-base font-semibold">{nodeLabel(node, tr)}</h2>
          {node.partial && <Badge variant="outline">{tr("storage.partialNode")}</Badge>}
        </div>
        <Button variant="ghost" size="icon" aria-label={tr("common.close")} onClick={onClose}>
          <X size={16} />
        </Button>
      </div>
      <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3 border-b border-border-subtle px-4 py-3">
        <Fact label={tr("storage.allocated")} value={formatBytes(node.allocated_bytes, locale)} />
        <Fact label={tr("storage.logical")} value={formatBytes(node.logical_bytes, locale)} />
        <Fact
          label={tr("storage.parentShare")}
          value={formatPercent(
            selection.parentBytes ? metricBytes(node, metric) / selection.parentBytes : 0,
            locale,
          )}
        />
        <Fact
          label={tr("storage.workspaceShare")}
          value={formatPercent(
            selection.workspaceBytes ? metricBytes(node, metric) / selection.workspaceBytes : 0,
            locale,
          )}
        />
        <Fact
          label={tr("storage.regenerable")}
          value={formatBytes(node.regenerable_bytes, locale)}
        />
        <Fact
          label={tr("storage.agentAssets")}
          value={formatBytes(node.agent_asset_bytes, locale)}
        />
        <Fact label={tr("storage.files")} value={node.file_count.toLocaleString(locale)} />
        <Fact
          label={tr("storage.directories")}
          value={node.directory_count.toLocaleString(locale)}
        />
        <Fact label={tr("storage.sourceAgents")} value={agents} />
        <Fact label={tr("storage.itemType")} value={tr(`storage.type.${semanticKind(node)}`)} />
      </dl>
      {fullPath && (
        <code
          className="mx-4 mb-3 block overflow-hidden rounded-md bg-muted px-2 py-2 text-xs text-muted-foreground [text-overflow:ellipsis] whitespace-nowrap"
          title={fullPath}
        >
          {fullPath}
        </code>
      )}
      {storage?.error_key && (
        <div className="mx-4 mb-3 flex gap-2 rounded-md border border-amber-600/25 bg-amber-500/10 p-2 text-xs text-amber-600">
          <CircleAlert size={14} />
          <span>
            {tr(storage.error_key)}
            {storage.error_detail && (
              <small className="mt-1 block text-muted-foreground">{storage.error_detail}</small>
            )}
          </span>
        </div>
      )}
      {node.kind !== "aggregate" && (
        <div className="px-4 pb-4">
          <Button variant="outline" className="w-full justify-center" onClick={() => void open()}>
            <ExternalLink size={14} />
            {tr("storage.openLocation")}
          </Button>
        </div>
      )}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="m-0 mt-1 truncate text-xs text-foreground">{value}</dd>
    </div>
  );
}

function legacyRoot(storage: WorkspaceStorage, tr: ReturnType<typeof useI18n>["tr"]): StorageNode {
  const children = storage.breakdown.map((item) => ({
    id: `legacy:${storage.workspace_id}:${item.relative_path || "root"}`,
    name: item.kind === "root-files" ? tr("storage.rootFiles") : item.name,
    relative_path: item.relative_path,
    kind: item.kind === "root-files" ? ("root-files" as const) : ("directory" as const),
    allocated_bytes: item.allocated_bytes,
    logical_bytes: item.logical_bytes,
    regenerable_bytes: item.regenerable_bytes,
    agent_asset_bytes: item.agent_asset_bytes,
    file_count: 0,
    directory_count: 0,
    child_count: 0,
    children: [],
    expandable: item.kind !== "root-files",
    partial: true,
  }));
  return {
    id: `workspace:${storage.workspace_id}`,
    name: storage.name,
    relative_path: "",
    kind: "workspace",
    allocated_bytes: storage.allocated_bytes,
    logical_bytes: storage.logical_bytes,
    regenerable_bytes: storage.regenerable_bytes,
    agent_asset_bytes: storage.agent_asset_bytes,
    file_count: storage.file_count,
    directory_count: storage.directory_count,
    child_count: children.length,
    children,
    expandable: true,
    partial: true,
  };
}

function nodeLabel(node: StorageNode, tr: ReturnType<typeof useI18n>["tr"]) {
  if (node.kind === "root-files") return tr("storage.rootFiles");
  if (node.kind === "aggregate") return tr("storage.otherCount", { count: node.child_count });
  return node.name;
}

function metricBytes(node: StorageNode, metric: StorageMetric) {
  if (metric === "regenerable") return node.regenerable_bytes;
  if (metric === "agent-assets") return node.agent_asset_bytes;
  return node.allocated_bytes;
}

function metricStorageBytes(storage: WorkspaceStorage, metric: StorageMetric) {
  if (metric === "regenerable") return storage.regenerable_bytes;
  if (metric === "agent-assets") return storage.agent_asset_bytes;
  return storage.allocated_bytes;
}

function semanticKind(node: StorageNode): StorageKind {
  if (node.kind === "aggregate") return "aggregate";
  if (node.relative_path.split(/[\\/]/).includes(".git")) return "git";
  if (node.allocated_bytes > 0 && node.agent_asset_bytes / node.allocated_bytes >= 0.5)
    return "agent";
  if (node.allocated_bytes > 0 && node.regenerable_bytes / node.allocated_bytes >= 0.8)
    return "regenerable";
  return "normal";
}

function storageFill(kind: StorageKind) {
  if (kind === "git") return "#18181b";
  if (kind === "agent") return "var(--primary)";
  if (kind === "regenerable") return "#fef3c7";
  if (kind === "aggregate") return "var(--muted)";
  return "color-mix(in srgb, var(--muted) 72%, var(--background))";
}

function storageTextColor(kind: StorageKind) {
  if (kind === "git" || kind === "agent") return "var(--primary-foreground)";
  if (kind === "regenerable") return "#713f12";
  return "var(--foreground)";
}

function fitTreemapLabel(value: string, maxWidth: number, fontSize: number) {
  const maxCharacters = Math.floor(maxWidth / Math.max(fontSize * 0.58, 1));
  if (maxCharacters >= value.length) return value;
  if (maxCharacters < 2) return "…";
  return `${value.slice(0, maxCharacters - 1)}…`;
}

function matchesNode(node: StorageNode, query: string) {
  const value = query.trim().toLowerCase();
  return !value || `${node.name} ${node.relative_path}`.toLowerCase().includes(value);
}

function containsMatch(node: StorageNode, query: string): boolean {
  return matchesNode(node, query) || node.children.some((child) => containsMatch(child, query));
}

function formatPercent(value: number, locale: ReturnType<typeof useI18n>["locale"]) {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: value < 0.01 ? 1 : 0,
  }).format(Math.max(0, value));
}

function displayPath(root: string, relativePath: string) {
  if (!relativePath) return root;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]$/, "")}${separator}${relativePath.replaceAll(/[\\/]/g, separator)}`;
}

function formatBytes(value: number, locale: ReturnType<typeof useI18n>["locale"]) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: amount >= 100 ? 0 : amount >= 10 ? 1 : 2 }).format(amount)} ${units[index]}`;
}
