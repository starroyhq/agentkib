import { useTranslation } from "react-i18next";
import { useI18n } from "@/core/useI18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  CircleHelp,
  CircleMinus,
  Copy,
  Download,
  ExternalLink,
  Github,
  Info,
  LoaderCircle,
  PackageCheck,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  TerminalSquare,
} from "lucide-react";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { api } from "@/core/api";
import { localizeMessage, tr } from "@/core/i18n";
import type {
  AgentKind,
  AgentToolAction,
  AgentToolChannel,
  AgentToolEnvironment,
  AgentToolExecutionResult,
  AgentToolInstallation,
  AgentToolState,
  AgentToolStatus,
  AppUpdateInfo,
} from "@/core/types";
import { cn } from "cn";
import { withAsyncCleanup } from "@/lib/utils";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { acquireAgentToolsExecution, refreshAgentTools, useAgentTools } from "./agent-tools-query";
import {
  SettingsAnchor,
  SettingsNotice,
  SettingsPanel,
  settingsTargetId,
} from "./components/SettingsLayout";
import { AGENT_LABELS as agentLabels } from "@/core/agents";

type Translate = typeof tr;

const PROJECT_URL = "https://github.com/starroyhq/agentkib";
const RELEASES_URL = `${PROJECT_URL}/releases`;
const MANAGED_AGENTS = new Set<AgentKind>([
  "codex",
  "claude-code",
  "antigravity",
  "cursor",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
]);

const stateIcons: Record<AgentToolState, typeof Check> = {
  current: Check,
  "update-available": Download,
  uninstalled: CircleMinus,
  conflict: CircleAlert,
  unknown: CircleHelp,
};

export function AgentToolsSettings({
  currentVersion,
  updatesEnabled = true,
}: {
  currentVersion?: string;
  updatesEnabled?: boolean;
}) {
  const { tr, formatDateTime, localizeMessage } = useI18n();
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const toolsQuery = useAgentTools();
  const setGlobalMessage = useWorkspaceStore((state) => state.setMessage);
  const [refreshing, setRefreshing] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<AgentKind | "">("");
  const [copyNotice, setCopyNotice] = useState("");
  const [executingAgent, setExecutingAgent] = useState<AgentKind>();
  const executionLock = useRef(false);
  const lifecycleGeneration = useRef(0);
  useEffect(
    () => () => {
      lifecycleGeneration.current += 1;
    },
    [],
  );
  const tools = (toolsQuery.data?.tools ?? []).filter((tool) => MANAGED_AGENTS.has(tool.agent));
  const diagnostics = tools.filter(
    (tool) =>
      tool.state === "conflict" ||
      tool.state === "unknown" ||
      tool.warnings.includes("multiple-executables") ||
      tool.installations.some((installation) => !installation.runnable),
  );
  const upgrades = tools.flatMap((tool) =>
    tool.actions
      .filter((action) => action.kind === "update" && action.mode === "execute")
      .map((action) => ({ tool, action })),
  );
  const selectedTool = tools.find((tool) => tool.agent === selectedAgent);
  const selectedCommandAction = selectedTool?.actions.find((action) => action.command);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setGlobalMessage("");
    await withAsyncCleanup(
      async () => {
        try {
          await refreshAgentTools(queryClient);
        } catch (error) {
          setGlobalMessage(localizeMessage(error));
        }
      },
      () => setRefreshing(false),
    );
  };

  const copyCommand = async (command: string, message = tr("settings.tools.commandCopied")) => {
    if (!navigator.clipboard) {
      setCopyNotice(tr("settings.tools.clipboardUnavailable"));
      return;
    }
    try {
      await navigator.clipboard.writeText(command);
      setCopyNotice(message);
    } catch (error) {
      setCopyNotice(localizeMessage(error));
    }
  };

  const executeAction = async (
    tool: AgentToolStatus,
    action: AgentToolAction,
    confirm = true,
  ): Promise<AgentToolExecutionResult | undefined> => {
    if (executionLock.current) return undefined;
    const generation = lifecycleGeneration.current;
    const isCurrent = () => generation === lifecycleGeneration.current;
    executionLock.current = true;
    setExecutingAgent(tool.agent);
    const releaseExecution = await acquireAgentToolsExecution();
    if (!releaseExecution || !isCurrent()) {
      releaseExecution?.();
      executionLock.current = false;
      if (isCurrent()) setExecutingAgent(undefined);
      return undefined;
    }
    return withAsyncCleanup(
      async () => {
        try {
          const installation =
            tool.installations.find((candidate) => candidate.id === action.installation_id) ??
            primaryInstallation(tool);
          if (confirm) {
            const confirmed = await dialogs.confirm({
              title: tr("settings.tools.executeTitle"),
              description: tr("settings.tools.executeConfirm", {
                agent: agentLabels[tool.agent],
                channel: channelLabel(action.channel, tr),
                current: tool.current_version ?? tr("common.unknown"),
                target: action.target_version ?? tr("common.unknown"),
                path: installation?.path ?? tr("settings.tools.executableMissing"),
                manager: action.manager_path ?? tr("settings.tools.managerMissing"),
                command: action.command ?? "—",
              }),
            });
            if (!confirmed || !isCurrent()) return undefined;
          }
          if (!isCurrent()) return undefined;
          setGlobalMessage("");
          const result = await api.executeAgentTool(tool.agent, action.id);
          releaseExecution();
          if (!isCurrent()) return result;
          try {
            await refreshAgentTools(queryClient);
          } catch (error) {
            if (isCurrent()) setGlobalMessage(localizeMessage(error));
          }
          if (!isCurrent()) return result;
          if (confirm) {
            await dialogs.notify({
              title: tr(`settings.tools.result.${result.status}`),
              description: executionResultDescription(result),
              tone: result.status === "succeeded" ? "default" : "warning",
            });
          }
          return result;
        } catch (error) {
          if (confirm && isCurrent()) {
            await dialogs.notify({
              title: tr("settings.tools.result.failed"),
              description: localizeMessage(error),
              tone: "warning",
            });
          }
          return undefined;
        }
      },
      () => {
        releaseExecution();
        executionLock.current = false;
        if (isCurrent()) setExecutingAgent(undefined);
      },
    );
  };

  const executeBatch = async () => {
    if (!upgrades.length || executionLock.current) return;
    const generation = lifecycleGeneration.current;
    const isCurrent = () => generation === lifecycleGeneration.current;
    executionLock.current = true;
    const releaseExecution = await acquireAgentToolsExecution();
    if (!releaseExecution || !isCurrent()) {
      releaseExecution?.();
      executionLock.current = false;
      return;
    }
    await withAsyncCleanup(
      async () => {
        const confirmed = await dialogs.confirm({
          title: tr("settings.tools.batchExecuteTitle"),
          description: tr("settings.tools.batchExecuteConfirm", { count: upgrades.length }),
        });
        if (!confirmed || !isCurrent()) return;
        setGlobalMessage("");
        setBatchOpen(false);
        const results: AgentToolExecutionResult[] = [];
        let requestFailures = 0;
        for (const { tool, action } of upgrades) {
          if (!isCurrent()) return;
          setExecutingAgent(tool.agent);
          try {
            results.push(await api.executeAgentTool(tool.agent, action.id));
          } catch {
            requestFailures += 1;
          }
        }
        releaseExecution();
        if (!isCurrent()) return;
        try {
          await refreshAgentTools(queryClient);
        } catch (error) {
          if (isCurrent()) setGlobalMessage(localizeMessage(error));
        }
        if (!isCurrent()) return;
        const succeeded = results.filter((result) => result.status === "succeeded").length;
        await dialogs.notify({
          title: tr("settings.tools.batchResultTitle"),
          description: tr("settings.tools.batchResult", {
            succeeded,
            failed: results.length - succeeded + requestFailures,
          }),
          tone: succeeded === upgrades.length ? "default" : "warning",
        });
      },
      () => {
        releaseExecution();
        executionLock.current = false;
        if (isCurrent()) setExecutingAgent(undefined);
      },
    );
  };

  return (
    <div className="grid gap-5">
      <SettingsAnchor target="tools-app">
        <AppUpdateSetting currentVersion={currentVersion} updatesEnabled={updatesEnabled} />
      </SettingsAnchor>

      <section
        id={settingsTargetId("tools-environment")}
        tabIndex={-1}
        className="grid scroll-mt-6 gap-3 outline-none"
        aria-labelledby="agent-tools-heading"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 id="agent-tools-heading" className="font-heading text-lg font-semibold">
                {tr("settings.tools.localEnvironment")}
              </h2>
              {toolsQuery.data?.latest_checked_at && (
                <span
                  className="whitespace-nowrap text-xs text-muted-foreground"
                  aria-live="polite"
                >
                  {tr("settings.tools.lastChecked", {
                    time: formatDateTime(toolsQuery.data.latest_checked_at),
                  })}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                onClick={() =>
                  void api.openExternal(`${PROJECT_URL}/blob/main/docs/DEVELOPMENT.md`)
                }
              >
                <Info size={14} />
                {tr("settings.tools.environmentHelp")}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!diagnostics.length || Boolean(executingAgent)}
              onClick={() => setConflictsOpen(true)}
            >
              <ShieldAlert size={15} />
              {tr("settings.tools.diagnoseInstallations", { count: diagnostics.length })}
            </Button>
            <Button
              variant="outline"
              disabled={refreshing || Boolean(executingAgent)}
              onClick={() => void refresh()}
            >
              <RefreshCw className={refreshing ? "animate-spin" : undefined} size={15} />
              {tr("settings.tools.detectAgain")}
            </Button>
          </div>
        </div>

        {toolsQuery.error && (
          <SettingsNotice tone="error" inset={false} className="text-sm" role="alert">
            <CircleAlert size={16} className="mt-0.5" />
            {localizeMessage(toolsQuery.error)}
          </SettingsNotice>
        )}
        {toolsQuery.data?.cache_status === "cached" && (
          <SettingsNotice tone="warning" inset={false} className="text-sm" role="status">
            <Info size={16} className="mt-0.5" />
            <span>
              {tr("settings.tools.usingCachedVersions")}
              {toolsQuery.data.errors.length > 0 && (
                <>
                  {" "}
                  {tr("settings.tools.partialSourceFailure", {
                    count: toolsQuery.data.errors.length,
                  })}
                </>
              )}
            </span>
          </SettingsNotice>
        )}
        {toolsQuery.data?.cache_status !== "cached" && Boolean(toolsQuery.data?.errors.length) && (
          <SettingsNotice tone="warning" inset={false} className="text-sm" role="status">
            <CircleAlert size={16} className="mt-0.5" />
            {tr("settings.tools.partialSourceFailure", {
              count: toolsQuery.data?.errors.length ?? 0,
            })}
          </SettingsNotice>
        )}

        {toolsQuery.isPending ? (
          <AgentToolsLoading />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
            {tools.map((tool) => (
              <AgentToolCard
                key={tool.agent}
                tool={tool}
                onCopy={(command) => void copyCommand(command)}
                onExecute={(tool, action) => void executeAction(tool, action)}
                executing={Boolean(executingAgent)}
              />
            ))}
          </div>
        )}
      </section>

      <SettingsAnchor target="tools-actions">
        <SettingsPanel title={tr("settings.search.updateActions")}>
          <div className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-6 border-b border-border/60 px-5 py-3 max-[640px]:grid-cols-1 max-[640px]:gap-3">
            <div className="flex items-start gap-3">
              <PackageCheck size={19} className="mt-0.5" />
              <div>
                <h3 className="font-heading font-semibold">
                  {tr("settings.tools.upgradeCount", { count: upgrades.length })}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {tr("settings.tools.batchDescription")}
                </p>
              </div>
            </div>
            <Button
              disabled={!upgrades.length || Boolean(executingAgent)}
              onClick={() => setBatchOpen(true)}
            >
              <ScrollText size={15} />
              {tr("settings.tools.reviewUpdates", { count: upgrades.length })}
            </Button>
          </div>
          <div className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-start gap-6 px-5 py-3 max-[640px]:grid-cols-1 max-[640px]:gap-3">
            <div>
              <h3 className="flex items-center gap-2 font-heading font-semibold">
                <TerminalSquare size={18} />
                {tr("settings.tools.manualCommand")}
              </h3>
              <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                <ShieldAlert size={14} />
                {tr("settings.tools.safeExecutionOnly")}
              </p>
            </div>
            <div className="grid min-w-[320px] gap-2 max-[640px]:min-w-0">
              <Select
                value={selectedAgent || "none"}
                onValueChange={(value) =>
                  setSelectedAgent(
                    value === "none" || value === null ? "" : (String(value) as AgentKind),
                  )
                }
              >
                <SelectTrigger className="h-9 w-full" aria-label={tr("settings.tools.selectAgent")}>
                  <SelectValue>
                    {selectedAgent ? agentLabels[selectedAgent] : tr("settings.tools.selectAgent")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>{tr("settings.tools.selectAgent")}</SelectLabel>
                    <SelectItem value="none">{tr("settings.tools.selectAgent")}</SelectItem>
                    {tools.map((tool) => (
                      <SelectItem key={tool.agent} value={tool.agent}>
                        {agentLabels[tool.agent]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <div className="flex min-h-12 items-center justify-between gap-3 rounded-lg bg-muted/35 px-3 py-2">
                {selectedCommandAction?.command ? (
                  <>
                    <code className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs">
                      {selectedCommandAction.command}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void copyCommand(selectedCommandAction.command ?? "")}
                    >
                      <Copy size={14} />
                      {tr("common.copy")}
                    </Button>
                  </>
                ) : selectedTool ? (
                  <Button
                    variant="link"
                    onClick={() => void api.openExternal(selectedTool.official_url)}
                  >
                    {tr("settings.tools.openDocumentation")}
                    <ExternalLink size={14} />
                  </Button>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    {tr("settings.tools.selectAgentHint")}
                  </span>
                )}
              </div>
              {copyNotice && <p className="text-xs text-muted-foreground">{copyNotice}</p>}
            </div>
          </div>
        </SettingsPanel>
      </SettingsAnchor>

      <InstallationDiagnosticsDialog
        open={conflictsOpen}
        onOpenChange={setConflictsOpen}
        tools={diagnostics}
      />
      <BatchCommandsDialog
        open={batchOpen}
        onOpenChange={setBatchOpen}
        upgrades={upgrades}
        executing={Boolean(executingAgent)}
        onExecute={() => void executeBatch()}
      />
    </div>
  );
}

function AgentToolCard({
  tool,
  onCopy,
  onExecute,
  executing,
}: {
  tool: AgentToolStatus;
  onCopy: (command: string) => void;
  onExecute: (tool: AgentToolStatus, action: AgentToolAction) => void;
  executing: boolean;
}) {
  const { t: tr } = useTranslation();
  const [selectedActionId, setSelectedActionId] = useState(tool.actions[0]?.id ?? "");
  useEffect(() => {
    if (!tool.actions.some((action) => action.id === selectedActionId)) {
      setSelectedActionId(tool.actions[0]?.id ?? "");
    }
  }, [selectedActionId, tool.actions]);
  const action =
    tool.actions.find((candidate) => candidate.id === selectedActionId) ?? tool.actions[0];
  const StateIcon = stateIcons[tool.state];
  const hasMultipleInstallations = tool.warnings.includes("multiple-executables");
  const DetailIcon = hasMultipleInstallations ? CircleAlert : StateIcon;
  const warningDetails =
    tool.state === "conflict" || tool.state === "unknown" || hasMultipleInstallations
      ? toolWarnings(tool, tr)
      : [];
  const stateClass = {
    current: "border-emerald-500/35 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300",
    "update-available": "border-amber-500/35 bg-amber-500/8 text-amber-700 dark:text-amber-300",
    uninstalled: "border-border bg-muted/50 text-muted-foreground",
    conflict: "border-destructive/35 bg-destructive/8 text-destructive",
    unknown: "border-border bg-muted/50 text-muted-foreground",
  }[tool.state];
  const installation = primaryInstallation(tool);
  const path = installation?.path;
  const actionLabel = !action
    ? tr("settings.tools.openDocumentation")
    : action.mode === "execute"
      ? tr(action.kind === "install" ? "settings.tools.installNow" : "settings.tools.updateNow")
      : action.mode === "copy-command"
        ? tr(
            action.kind === "install"
              ? "settings.tools.copyInstallCommand"
              : "settings.tools.copyUpdateCommand",
          )
        : tr("settings.tools.openDocumentation");

  return (
    <div
      className={cn(
        "grid min-h-16 grid-cols-[minmax(180px,1.3fr)_minmax(150px,0.8fr)_auto_auto] items-center gap-4 border-b border-border/60 px-5 py-3 last:border-b-0 max-[760px]:grid-cols-[minmax(0,1fr)_auto]",
        tool.state === "conflict" && "bg-destructive/5",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="shrink-0 [&>div]:size-7 [&>div]:rounded-md [&>div]:p-0.5">
          <AgentIcon agent={tool.agent} />
        </span>
        <span className="min-w-0">
          <h3 className="truncate font-heading text-sm font-semibold">{agentLabels[tool.agent]}</h3>
          <p className="truncate font-mono text-[11px] text-muted-foreground" title={path}>
            {path ?? tr("settings.tools.executableMissing")}
          </p>
        </span>
      </div>
      <div className="min-w-0 text-xs max-[760px]:col-span-2 max-[760px]:pl-9">
        <p className="truncate font-medium">
          {tool.current_version ?? "—"}
          {tool.recommended_version && tool.recommended_version !== tool.current_version
            ? ` → ${tool.recommended_version}`
            : ""}
        </p>
        <p className="truncate text-muted-foreground">
          {channelLabel(action?.channel ?? tool.channel, tr)}
          {installation && ` · ${environmentLabel(installation.environment, tr)}`}
        </p>
      </div>
      <Badge className={cn("gap-1 border px-1.5", stateClass)} variant="outline">
        <StateIcon size={12} />
        {tr(`settings.tools.state.${tool.state}`)}
      </Badge>
      <div className="flex items-center justify-end gap-2 max-[760px]:col-span-2">
        {tool.actions.length > 1 && (
          <Select
            value={action?.id ?? ""}
            onValueChange={(value) => {
              if (value !== null) setSelectedActionId(String(value));
            }}
          >
            <SelectTrigger
              size="sm"
              className="h-8 w-32 text-xs"
              aria-label={tr("settings.tools.selectChannel")}
            >
              <SelectValue>{channelLabel(action?.channel ?? tool.channel, tr)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{tr("settings.tools.selectChannel")}</SelectLabel>
                {tool.actions.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {channelLabel(candidate.channel, tr)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        <Button
          size="sm"
          className="h-8 px-2.5 text-xs"
          variant={tool.state === "current" ? "outline" : "default"}
          disabled={executing}
          onClick={() => {
            if (!action) return void api.openExternal(tool.official_url);
            if (action.mode === "execute") onExecute(tool, action);
            else if (action.mode === "copy-command" && action.command) onCopy(action.command);
            else void api.openExternal(action.url ?? tool.official_url);
          }}
        >
          {executing ? (
            <LoaderCircle className="animate-spin" size={13} />
          ) : action?.mode === "execute" ? (
            <Download size={13} />
          ) : action?.mode === "copy-command" ? (
            <Copy size={13} />
          ) : (
            <ExternalLink size={13} />
          )}
          {actionLabel}
        </Button>
      </div>
      {warningDetails.length > 0 && (
        <div
          className={cn(
            "col-span-full flex items-start gap-1 pl-9 text-[11px]",
            tool.state === "conflict" ? "text-destructive" : "text-amber-700 dark:text-amber-300",
          )}
        >
          <DetailIcon size={12} className="mt-0.5" />
          <ul className="space-y-0.5">
            {warningDetails.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function AppUpdateSetting({
  currentVersion,
  updatesEnabled = true,
}: {
  currentVersion?: string;
  updatesEnabled?: boolean;
}) {
  const { t: tr } = useTranslation();
  const dialogs = useAppDialogs();
  const [status, setStatus] = useState<
    "idle" | "checking" | "up-to-date" | "available" | "downloading" | "installing" | "failed"
  >("idle");
  const [update, setUpdate] = useState<AppUpdateInfo>();
  const [error, setError] = useState("");
  const [downloaded, setDownloaded] = useState(0);
  const [contentLength, setContentLength] = useState<number>();
  const busy = status === "checking" || status === "downloading" || status === "installing";
  const progress = contentLength
    ? Math.min(100, Math.round((downloaded / contentLength) * 100))
    : 0;

  const check = async () => {
    if (busy || !updatesEnabled) return;
    setStatus("checking");
    setError("");
    setUpdate(undefined);
    try {
      const available = await api.checkAppUpdate();
      setUpdate(available);
      setStatus(available ? "available" : "up-to-date");
    } catch (reason) {
      setError(localizeMessage(reason));
      setStatus("failed");
    }
  };

  const install = async () => {
    if (!update || busy) return;
    if (update.install_mode === "manual") {
      try {
        await api.openExternal(update.release_url);
      } catch (reason) {
        setError(localizeMessage(reason));
        setStatus("failed");
      }
      return;
    }
    if (
      !(await dialogs.confirm({
        title: tr("settings.updateInstallTitle"),
        description: tr("settings.updateInstallConfirm", { version: update.version }),
      }))
    )
      return;
    setStatus("downloading");
    setError("");
    setDownloaded(0);
    setContentLength(undefined);
    try {
      await api.installAppUpdate(update.version, (event) => {
        if (event.event === "started") setContentLength(event.data.content_length);
        if (event.event === "progress") {
          setDownloaded(event.data.downloaded);
          setContentLength(event.data.content_length);
        }
        if (event.event === "finished") setStatus("installing");
      });
      // quitAndInstall returns after handing off to the native updater. The old
      // process cannot claim success until the updated application starts.
      setStatus("installing");
    } catch (reason) {
      setError(localizeMessage(reason));
      setStatus("failed");
    }
  };

  const description = useMemo(() => {
    if (!updatesEnabled) return tr("settings.updateUnavailableInDevelopment");
    if (status === "checking") return tr("settings.updateChecking");
    if (status === "up-to-date")
      return tr("settings.updateUpToDate", { version: currentVersion ?? "—" });
    if (status === "available" && update)
      return tr("settings.updateAvailable", {
        current: update.current_version,
        version: update.version,
      });
    if (status === "downloading")
      return contentLength
        ? tr("settings.updateDownloadingProgress", { progress })
        : tr("settings.updateDownloading");
    if (status === "installing") return tr("settings.updateInstalling");
    if (status === "failed") return error;
    return tr("settings.updateCurrentVersion", { version: currentVersion ?? "—" });
  }, [contentLength, currentVersion, error, progress, status, update, updatesEnabled, tr]);

  return (
    <SettingsPanel title={tr("settings.updates")}>
      <div className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl border bg-background">
              <PackageCheck size={22} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-heading text-lg font-semibold">
                  AgentKib {currentVersion ? `v${currentVersion}` : ""}
                </h2>
                <Badge
                  variant="outline"
                  className={cn(
                    "gap-1",
                    status === "failed"
                      ? "border-destructive/30 text-destructive"
                      : "border-emerald-500/30 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300",
                  )}
                >
                  {status === "failed" ? (
                    <CircleAlert size={12} />
                  ) : busy ? (
                    <RefreshCw className="animate-spin" size={12} />
                  ) : (
                    <Check size={12} />
                  )}
                  {tr(`settings.tools.appState.${status}`)}
                </Badge>
              </div>
              <p
                className={cn(
                  "mt-1 text-sm text-muted-foreground",
                  status === "failed" && "text-destructive",
                )}
              >
                {description}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void api.openExternal(PROJECT_URL)}>
              <Github size={15} /> GitHub
            </Button>
            <Button variant="outline" onClick={() => void api.openExternal(RELEASES_URL)}>
              <ScrollText size={15} />
              {tr("settings.tools.releaseNotes")}
            </Button>
            {status === "available" && update ? (
              <Button disabled={busy} onClick={() => void install()}>
                {update.install_mode === "manual" ? (
                  <ExternalLink size={15} />
                ) : (
                  <Download size={15} />
                )}
                {tr(
                  update.install_mode === "manual"
                    ? "settings.updateOpenRelease"
                    : "settings.updateDownloadInstall",
                )}
              </Button>
            ) : (
              <Button disabled={busy || !updatesEnabled} onClick={() => void check()}>
                <RefreshCw className={busy ? "animate-spin" : undefined} size={15} />
                {tr(status === "failed" ? "settings.updateRetry" : "settings.checkForUpdates")}
              </Button>
            )}
          </div>
        </div>
        {status === "downloading" && (
          <div
            className="mt-4 h-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
        {update?.notes && status !== "failed" && (
          <div className="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <strong className="mb-1 block text-foreground">{tr("settings.updateNotes")}</strong>
            <span className="whitespace-pre-wrap break-words">{update.notes}</span>
          </div>
        )}
      </div>
    </SettingsPanel>
  );
}

function InstallationDiagnosticsDialog({
  open,
  onOpenChange,
  tools,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tools: AgentToolStatus[];
}) {
  const { t: tr } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{tr("settings.tools.diagnosticsTitle")}</DialogTitle>
          <DialogDescription>{tr("settings.tools.diagnosticsDescription")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-3 overflow-auto">
          {tools.length ? (
            tools.map((tool) => (
              <div key={tool.agent} className="rounded-xl border p-3">
                <strong>{agentLabels[tool.agent]}</strong>
                <ul className="mt-2 space-y-2 text-xs text-muted-foreground">
                  {tool.installations.map((installation) => (
                    <li key={installation.id} className="rounded-lg bg-muted/45 p-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline">
                          {installation.runnable
                            ? tr("settings.tools.runnable")
                            : tr("settings.tools.notRunnable")}
                        </Badge>
                        {installation.is_path_default && (
                          <Badge variant="outline">{tr("settings.tools.pathDefault")}</Badge>
                        )}
                        <span>
                          {channelLabel(installation.channel, tr)} ·{" "}
                          {environmentLabel(installation.environment, tr)}
                        </span>
                        <span>{installation.version ?? tr("common.unknown")}</span>
                      </div>
                      <p className="mt-1 break-all font-mono">{installation.path}</p>
                      {installation.resolved_path !== installation.path && (
                        <p className="mt-1 break-all font-mono">
                          {tr("settings.tools.resolvedPath", {
                            path: installation.resolved_path,
                          })}
                        </p>
                      )}
                      {installation.manager_path && (
                        <p className="mt-1 break-all font-mono">
                          {tr("settings.tools.managerPath", {
                            path: installation.manager_path,
                          })}
                        </p>
                      )}
                      {installation.error && (
                        <p className="mt-1 break-words text-destructive">{installation.error}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">{tr("settings.tools.noDiagnostics")}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BatchCommandsDialog({
  open,
  onOpenChange,
  upgrades,
  executing,
  onExecute,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  upgrades: Array<{ tool: AgentToolStatus; action: AgentToolAction }>;
  executing: boolean;
  onExecute: () => void;
}) {
  const { t: tr } = useTranslation();
  const commands = upgrades
    .map(
      ({ tool, action }) =>
        `# ${agentLabels[tool.agent]} · ${channelLabel(action.channel, tr)}\n${action.command}`,
    )
    .join("\n\n");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{tr("settings.tools.batchExecuteTitle")}</DialogTitle>
          <DialogDescription>{tr("settings.tools.batchExecuteDescription")}</DialogDescription>
        </DialogHeader>
        <pre className="max-h-[55vh] overflow-auto rounded-xl border bg-muted/50 p-3 text-xs whitespace-pre-wrap">
          {commands}
        </pre>
        <DialogFooter>
          <Button disabled={!commands || executing} onClick={onExecute}>
            {executing ? (
              <LoaderCircle className="animate-spin" size={15} />
            ) : (
              <Download size={15} />
            )}
            {tr("settings.tools.executeAllUpdates")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentToolsLoading() {
  const { t: tr } = useTranslation();
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label={tr("common.loading")}>
      {Array.from({ length: 7 }, (_, index) => (
        <div key={index} className="h-[178px] animate-pulse rounded-xl border bg-muted/35" />
      ))}
    </div>
  );
}

function channelLabel(channel: AgentToolChannel, tr: Translate) {
  return tr(`settings.tools.channel.${channel}`);
}

function environmentLabel(environment: AgentToolEnvironment, tr: Translate) {
  return tr(`settings.tools.environment.${environment}`);
}

function primaryInstallation(tool: AgentToolStatus): AgentToolInstallation | undefined {
  return (
    tool.installations.find((installation) => installation.is_path_default) ??
    (tool.installations.length === 1 ? tool.installations[0] : undefined)
  );
}

function executionResultDescription(result: AgentToolExecutionResult) {
  const versionChange =
    result.before_version || result.after_version
      ? tr("settings.tools.versionChange", {
          before: result.before_version ?? tr("common.unknown"),
          after: result.after_version ?? tr("common.unknown"),
        })
      : "";
  return [versionChange, result.output || tr("settings.tools.noCommandOutput")]
    .filter(Boolean)
    .join("\n");
}

function toolWarnings(tool: AgentToolStatus, tr: Translate) {
  const warnings: string[] = [];
  if (tool.state === "conflict") {
    warnings.push(tr("settings.tools.multipleExecutables", { count: tool.installations.length }));
  } else if (tool.warnings.includes("multiple-executables")) {
    warnings.push(
      tr("settings.tools.multipleInstallationsNotice", { count: tool.installations.length }),
    );
  }

  for (const warning of tool.warnings) {
    const message = toolWarningMessage(warning, tr);
    if (message) warnings.push(message);
  }

  if (warnings.length > 0) return [...new Set(warnings)];
  if (tool.state === "current") return [tr("settings.tools.noIssues")];
  if (tool.state === "update-available") return [tr("settings.tools.updateSuggested")];
  if (tool.state === "uninstalled") return [tr("settings.tools.executableMissing")];
  return [tr("settings.tools.latestUnavailable")];
}

function toolWarningMessage(warning: string, tr: Translate) {
  switch (warning) {
    case "channel-unverified":
      return tr("settings.tools.channelUnverified");
    case "installation-not-runnable":
      return tr("settings.tools.installationNotRunnable");
    case "version-unavailable":
      return tr("settings.tools.versionUnavailable");
    case "version-uncomparable":
      return tr("settings.tools.versionUncomparable");
    case "latest-unavailable":
      return tr("settings.tools.latestUnavailable");
    default:
      return undefined;
  }
}

export { AppUpdateSetting };
