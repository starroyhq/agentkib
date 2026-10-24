import { shortPath } from "@/lib/path-display";
import { useI18n } from "@/core/useI18n";
import { createFileRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { WorkspaceContextSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/core/api";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";
import { tr } from "@/core/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Bot,
  ChevronDown,
  CircleAlert,
  FileCode2,
  FolderOpen,
  Info,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import type { AgentDetection, AgentKind, ContextPreview } from "@/core/types";
import { AGENT_LABELS as agentLabels } from "@/core/agents";
// 与后端 CONTEXT_NOTE_PREFIX 同值（渲染进程不能引用 backend 包，后端测试断言该常量不变）。
// 以它开头的条目只是提示，不是问题：用中性样式渲染并去掉前缀。
const NOTE_PREFIX = "Note: ";
function Pills({ values, empty }: { values: string[]; empty: string }) {
  return values.length ? (
    <div className="flex flex-wrap gap-2">
      {values.map((value) => (
        <Badge key={value} variant="outline" className="bg-background text-xs">
          {value}
        </Badge>
      ))}
    </div>
  ) : (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
      <CircleAlert size={14} />
      <span>{empty}</span>
    </div>
  );
}
function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [value, delayMs]);
  return debounced;
}
// 后端 Claude Code 来源的 scope 哨兵（context-files.ts 的保留名）：不是项目目录，徽章显示来源类别。
// 其余取值是项目内的相对目录，原样显示；空串表示项目根。
const SCOPE_LABEL_KEYS: Record<string, string> = {
  managed: "context.scope.managed",
  user: "context.scope.user",
  ancestor: "context.scope.ancestor",
  "auto-memory": "context.scope.auto-memory",
  conditional: "context.scope.conditional",
  settings: "context.scope.settings",
  assets: "context.scope.assets",
};
// 其他 Agent 的 scope 是项目内的目录（例如 Codex 在 user/AGENTS.md 下的 "user"），不能套用上面的保留名，
// 所以只对 Claude Code 的结果查表。
function scopeLabel(scope: string, agent: AgentKind) {
  const key =
    agent === "claude-code" && Object.hasOwn(SCOPE_LABEL_KEYS, scope)
      ? SCOPE_LABEL_KEYS[scope]
      : undefined;
  return key ? tr(key) : scope || tr("status.scope.project");
}
function supportedAgent(value: unknown): AgentKind | undefined {
  return typeof value === "string" && Object.hasOwn(agentLabels, value)
    ? (value as AgentKind)
    : undefined;
}
interface ContextPageProps {
  project: string;
  agents?: AgentDetection[];
  selectedAgent?: AgentKind;
  onAgentChange?: (agent: AgentKind) => void;
  onOpenInstructions: () => void;
}
export function ContextPage(props: ContextPageProps) {
  // A new project must not inherit a directory edit or a debounced request from the old one.
  return <ContextPageContent key={props.project} {...props} />;
}
function ContextPageContent({
  project,
  agents,
  selectedAgent,
  onAgentChange,
  onOpenInstructions,
}: ContextPageProps) {
  const { localizeMessage, tr } = useI18n();
  const hasDraft = useWorkspaceStore((state) =>
    Boolean(
      state.project === project &&
      state.manifest &&
      state.baselineManifest &&
      JSON.stringify(state.manifest) !== state.baselineManifest,
    ),
  );
  const [manualAgent, setManualAgent] = useState<AgentKind>();
  const detectedAgent = agents?.find((item) => item.detected && supportedAgent(item.agent))?.agent;
  const agent = selectedAgent ?? manualAgent ?? detectedAgent ?? "codex";
  const [cwd, setCwd] = useState(project);
  // 输入工作目录时防抖，避免每敲一个字符都解析一次上下文。
  const debouncedCwd = useDebouncedValue(cwd, 350);
  const queryClient = useOptionalQueryClient();
  const contextQuery = useQuery(
    {
      ...queryDefaults,
      queryKey: ["workspace", "context", project, debouncedCwd, agent] as const,
      queryFn: () => api.context(project, debouncedCwd, agent),
      staleTime: 0,
      // Directory edits can retain the same Agent's preview, but a different Agent must not
      // display the old Agent's resources under its newly selected label.
      placeholderData: (previous, previousQuery) =>
        previousQuery?.queryKey[2] === project && previousQuery.queryKey[4] === agent
          ? previous
          : undefined,
    },
    queryClient,
  );
  const preview: ContextPreview | undefined = contextQuery.data;
  const resolving = contextQuery.isFetching;
  const error = contextQuery.error ? localizeMessage(contextQuery.error) : "";
  const run = () => void contextQuery.refetch();
  const empty = preview && !preview.sections.length;
  const previewScope = (
    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
      {tr(hasDraft ? "context.previewScope" : "context.previewScopeSaved")}
    </p>
  );
  if (resolving && !preview)
    return (
      <div className="grid gap-4">
        {previewScope}
        <WorkspaceContextSkeleton />
      </div>
    );
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(280px,.38fr)_minmax(0,1fr)]">
      <Card className="grid content-start overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="border-b border-border bg-muted/20 px-4 py-4">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <SlidersHorizontal size={18} />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold">{tr("context.environment")}</h2>
            </div>
          </div>
        </div>
        <div className="grid gap-4 p-4">
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">{tr("context.agent")}</Label>
            <Select
              value={agent}
              onValueChange={(value) => {
                const next = supportedAgent(value);
                if (!next) return;
                if (onAgentChange) onAgentChange(next);
                else setManualAgent(next);
              }}
            >
              <SelectTrigger className="h-10 w-full" aria-label={tr("context.agent")}>
                <SelectValue>{agentLabels[agent]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{tr("context.agent")}</SelectLabel>
                  {Object.entries(agentLabels).map(([value, label]) => (
                    <SelectItem value={value} key={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="context-working-directory" className="text-xs text-muted-foreground">
              {tr("context.workingDirectory")}
            </Label>
            <div className="relative">
              <FolderOpen
                size={15}
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="context-working-directory"
                className="h-10 pl-9"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
              />
            </div>
          </div>
          <Button className="h-10 w-full" onClick={run} disabled={resolving}>
            <RefreshCw size={15} className={resolving ? "animate-spin" : ""} />
            {tr("context.resolve")}
          </Button>
          <div className="grid gap-3 border-t border-border pt-4">
            <div className="flex items-center gap-2">
              <Bot size={16} className="text-muted-foreground" />
              <h3 className="text-sm font-semibold">{tr("context.capabilities")}</h3>
            </div>
            <div className="grid gap-2">
              <Pills values={preview?.visible_skills ?? []} empty={tr("context.noSkill")} />
              {!!preview?.legacy_declared_skills?.length && (
                <div className="grid gap-1 text-xs text-muted-foreground">
                  <span>{tr("skills.sync.legacy")}</span>
                  <Pills values={preview.legacy_declared_skills} empty="" />
                </div>
              )}
              <Pills
                values={preview?.visible_connections ?? []}
                empty={tr("context.noConnection")}
              />
            </div>
          </div>
        </div>
      </Card>
      <Card className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex items-start justify-between gap-3 border-b border-border bg-muted/20 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <FileCode2 size={18} />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold">{tr("context.effective")}</h2>
              {previewScope}
            </div>
          </div>
          {preview && (
            <Badge variant="outline" className="mt-0.5 bg-background">
              {preview.sections.length} {tr("common.sections")}
            </Badge>
          )}
        </div>
        {error && (
          <div className="mx-4 mt-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-text">
            {error}
          </div>
        )}
        {preview?.warnings.map((warning) =>
          warning.startsWith(NOTE_PREFIX) ? (
            <div
              role="note"
              className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm break-words text-muted-foreground"
              key={warning}
            >
              <Info size={15} className="mt-0.5 shrink-0" />
              {contextWarningLabel(warning.slice(NOTE_PREFIX.length), true)}
            </div>
          ) : (
            <div
              className="mx-4 mt-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700"
              key={warning}
            >
              <CircleAlert size={15} />
              {contextWarningLabel(warning)}
            </div>
          ),
        )}
        {empty && (
          <div className="mx-4 mt-4 flex items-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
            <FileCode2 size={18} />
            <span className="flex-1">{tr("context.noInstructions")}</span>
            <Button variant="outline" onClick={onOpenInstructions}>
              {tr("context.openInstructions")}
            </Button>
          </div>
        )}
        <div className="grid gap-3 p-4">
          {preview?.sections.map((contextSection, index) => (
            <article
              className="rounded-xl border border-border bg-muted/15 p-3 transition-colors hover:bg-muted/30"
              key={`${contextSection.source}-${index}`}
            >
              <div className="flex items-start gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <strong className="min-w-0 truncate text-sm">
                      {shortPath(contextSection.source)}
                    </strong>
                    <Badge variant="outline" className="bg-background text-[11px]">
                      {scopeLabel(contextSection.scope, preview.agent)}
                    </Badge>
                  </header>
                  <Collapsible>
                    <CollapsibleTrigger className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary-text hover:underline">
                      {tr("context.showContent")}
                      <ChevronDown size={14} />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <pre className="mt-3 max-h-72 overflow-auto rounded-lg border border-border bg-background p-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
                        {contextSection.content}
                      </pre>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              </div>
            </article>
          ))}
        </div>
        {preview?.approved_memories.length ? (
          <div className="grid gap-2 border-t border-border bg-muted/10 p-4 text-sm">
            <h3>{tr("context.approvedMemory")}</h3>
            {preview.approved_memories.map((item) => (
              <p
                className="rounded-lg border border-border bg-card px-3 py-2 text-muted-foreground"
                key={item}
              >
                {item}
              </p>
            ))}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

const CLAUDE_MESSAGE_KEYS: Record<string, string> = {
  "AGENTS.md may not be loaded: the Claude Code version could not be detected, and Claude Code reads AGENTS.md only from v2.1.277.":
    "context.claudeAgentsVersionUnknown",
  "Settings given on the command line (--settings, --setting-sources), policy delivered by MDM, a configuration profile or the Windows registry, and server-managed settings are not visible to AgentKib, so this list can differ from what Claude Code loads.":
    "context.claudeSettingsNotRead",
  "CLAUDE_CONFIG_DIR is set but is not a usable absolute path, so AgentKib reads Claude Code's default configuration folder. User-level instructions shown here may belong to a different setup than the one Claude Code uses.":
    "context.claudeConfigDirInvalid",
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 is set in AgentKib's environment, so auto memory is not shown. Claude Code started in another environment may still load it.":
    "context.claudeAutoMemoryOff",
  "An environment variable that turns off CLAUDE.md loading (CLAUDE_CODE_DISABLE_CLAUDE_MDS, CLAUDE_CODE_SAFE_MODE or CLAUDE_CODE_SIMPLE) is set in AgentKib's environment. Claude Code started with it loads fewer instruction files than listed here; AgentKib does not model this.":
    "context.claudeLoadSwitches",
};

function contextWarningLabel(warning: string, informational = false) {
  if (
    warning ===
    "DeepSeek Harness custom instruction or Skill loading rules were detected; this preview uses the public default rules"
  )
    return tr("context.deepseekCustomRules");
  if (
    warning ===
    "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import"
  )
    return tr(informational ? "context.deepseekClaudeImportNote" : "context.deepseekClaudeImport");
  // 后端静态文案（context-claude.ts）：带 Note: 前缀的在去掉前缀之后匹配，其余本身是警告。
  // 带路径或数量的动态文案保持英文原文。
  const claudeMessage = Object.hasOwn(CLAUDE_MESSAGE_KEYS, warning)
    ? CLAUDE_MESSAGE_KEYS[warning]
    : undefined;
  return claudeMessage ? tr(claudeMessage) : warning;
}

function WorkspaceContextRoute() {
  const navigate = useNavigate();
  const { workspaceId } = useParams({ from: "/(main)/workspace/$workspaceId/context" });
  const search = useSearch({ strict: false });
  const { project, selectedWorkspace, scan } = useWorkspaceStore();
  if (
    !project ||
    selectedWorkspace?.id !== workspaceId ||
    selectedWorkspace.path !== project ||
    scan?.root !== project
  )
    return <WorkspaceContextSkeleton />;
  return (
    <ContextPage
      key={`${workspaceId}:${project}`}
      project={project}
      agents={scan.agents}
      selectedAgent={supportedAgent(search.agent)}
      onAgentChange={(agent) =>
        void navigate({
          to: "/workspace/$workspaceId/context",
          params: { workspaceId },
          search: (current) => ({ ...current, agent }),
        })
      }
      onOpenInstructions={() =>
        void navigate({
          to: "/workspace/$workspaceId/assets",
          params: { workspaceId },
          search: { workspaceAssetSection: "instructions" } as never,
        })
      }
    />
  );
}

export const Route = createFileRoute("/(main)/workspace/$workspaceId/context")({
  staticData: { appRoute: { kind: "workspace", page: "context" } },
  component: WorkspaceContextRoute,
});
