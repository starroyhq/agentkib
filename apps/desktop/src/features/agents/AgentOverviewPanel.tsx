import { useI18n } from "@/core/useI18n";
import { tr as i18nTr } from "@/core/i18n";
import { AGENT_LABELS } from "@/core/agents";
import { usePathDisplay } from "@/lib/usePathDisplay";
import { Button } from "@/components/ui/button";
import type {
  AgentInstallation,
  AgentKind,
  AgentSupport,
  CatalogAsset,
  ProviderStatus,
  RemoteGatewaySummary,
  WorkspaceSummary,
} from "@/core/types";
import { Check, CircleAlert, CircleHelp, FlaskConical, FolderGit2, X } from "lucide-react";
import { cn } from "cn";
import { AgentSectionFeedback } from "./AgentSectionFeedback";
import { RemoteAgentGatewayDetails } from "./RemoteAgentGatewayDetails";
import { AgentUsagePanel } from "./AgentUsagePanel";

export function AgentOverviewPanel({
  agent,
  installation,
  support,
  provider,
  linkedWorkspaces,
  recentLinkedWorkspaces,
  homeAssetKinds,
  remoteGateways,
  workspacesPending,
  workspacesError,
  assetsPending,
  assetsError,
  gatewaysPending,
  gatewaysError,
  insightsPending,
  insightsError,
  onOpenWorkspace,
  onRetryWorkspaces,
  onRetryAssets,
  onRetryGateways,
  onRetryInsights,
}: {
  agent: AgentKind;
  installation?: AgentInstallation;
  support?: AgentSupport;
  provider?: ProviderStatus;
  linkedWorkspaces: WorkspaceSummary[];
  recentLinkedWorkspaces: WorkspaceSummary[];
  homeAssets: CatalogAsset[];
  homeAssetKinds: [string, number][];
  remoteGateways: RemoteGatewaySummary[];
  workspacesPending: boolean;
  workspacesError: boolean;
  assetsPending: boolean;
  assetsError: boolean;
  gatewaysPending: boolean;
  gatewaysError: boolean;
  insightsPending: boolean;
  insightsError: boolean;
  onOpenWorkspace: (workspace: WorkspaceSummary) => Promise<void>;
  onRetryWorkspaces: () => void;
  onRetryAssets: () => void;
  onRetryGateways: () => void;
  onRetryInsights: () => void;
}) {
  const { tr, formatRelativeTime } = useI18n();
  const displayPath = usePathDisplay();
  const hasRemoteWorkspaces = remoteGateways.some((gateway) => gateway.workspaces.length > 0);
  return (
    <div className="grid gap-5 p-5">
      {agent === "deepseek-harness" && (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          <CircleAlert size={16} />
          {tr("agents.deepseekReadOnly")}
        </div>
      )}
      <section className="grid gap-2" aria-label={tr("agents.capabilities")}>
        <div className="flex flex-wrap gap-2">
          {(["workspace_discovery", "session_list", "history_read", "continuation"] as const).map(
            (key) => {
              const value = support?.[key];
              const label = {
                workspace_discovery: "workspaceDiscovery",
                session_list: "sessionList",
                history_read: "historyRead",
                continuation: "continuation",
              }[key];
              return (
                <span
                  key={key}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/25 px-2.5 py-1 text-xs",
                    value === false && "text-muted-foreground",
                  )}
                >
                  {value === undefined ? null : value ? (
                    <Check size={13} aria-hidden="true" />
                  ) : (
                    <X size={13} aria-hidden="true" />
                  )}
                  {tr(`agents.capability.${label}`)}
                  {value !== true && (
                    <span className="text-muted-foreground">
                      {tr(
                        value === undefined
                          ? "agents.capability.unknown"
                          : "agents.capability.unavailable",
                      )}
                    </span>
                  )}
                </span>
              );
            },
          )}
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/25 px-2.5 py-1 text-xs",
              support?.control === "none" && "text-muted-foreground",
            )}
          >
            {support?.control === "experimental" ? (
              <FlaskConical size={13} aria-hidden="true" />
            ) : support?.control === "none" ? (
              <X size={13} aria-hidden="true" />
            ) : (
              <CircleHelp size={13} aria-hidden="true" />
            )}
            {tr("agents.capability.control")}
            {support?.control === "experimental" && " · "}
            <span className="text-muted-foreground">
              {tr(
                support
                  ? `agents.capability.control.${support.control}`
                  : "agents.capability.unknown",
              )}
            </span>
          </span>
        </div>
      </section>
      {installation?.warnings.map((warning) => (
        <div
          className="flex items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive-text"
          key={warning}
        >
          <CircleAlert size={16} />
          {installationWarningLabel(warning, tr)}
        </div>
      ))}
      {workspacesPending || workspacesError ? (
        <AgentSectionFeedback error={workspacesError} onRetry={onRetryWorkspaces} />
      ) : linkedWorkspaces.length > 0 ? (
        <section className="rounded-xl border border-border bg-background p-4">
          <h3 className="mb-3 text-sm font-semibold">{tr("agents.linkedWorkspaces")}</h3>
          <div className="grid gap-1">
            {recentLinkedWorkspaces.map((workspace) => (
              <Button
                variant="bare"
                size="content"
                className="grid min-h-[58px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted/40"
                key={workspace.id}
                onClick={() => void onOpenWorkspace(workspace)}
              >
                <FolderGit2 size={15} className="text-muted-foreground" />
                <span className="min-w-0 truncate">
                  {workspace.name}
                  <small
                    className="mt-1 block truncate text-xs text-muted-foreground"
                    title={workspace.path}
                  >
                    {workspace.remote ? workspace.path : displayPath(workspace.path)}
                  </small>
                </span>
                <small className="text-xs text-muted-foreground">
                  {workspace.last_active_at
                    ? formatRelativeTime(workspace.last_active_at)
                    : tr("common.never")}
                </small>
              </Button>
            ))}
          </div>
        </section>
      ) : !gatewaysPending && !gatewaysError && !hasRemoteWorkspaces ? (
        <p className="px-1 py-4 text-sm leading-relaxed text-muted-foreground">
          {tr("agents.workspaceNextStep", { agent: AGENT_LABELS[agent] })}
        </p>
      ) : null}
      {assetsPending || assetsError ? (
        <AgentSectionFeedback error={assetsError} onRetry={onRetryAssets} />
      ) : homeAssetKinds.length > 0 ? (
        <section className="rounded-xl border border-border bg-background p-4">
          <h3 className="mb-3 text-sm font-semibold">{tr("agents.homeAssetTypes")}</h3>
          <dl className="grid gap-1">
            {homeAssetKinds.map(([kind, count]) => (
              <div
                className="flex min-h-[42px] items-center justify-between rounded-lg px-2 text-sm odd:bg-muted/20"
                key={kind}
              >
                <dt className="text-muted-foreground">{tr(`status.asset.${kind}`)}</dt>
                <dd className="font-medium">{count}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      {!insightsPending &&
        !insightsError &&
        provider?.available &&
        provider.imported_events > 0 &&
        !provider.error &&
        !provider.error_key && (
          <AgentUsagePanel
            agent={agent}
            provider={provider}
            loading={false}
            error={false}
            embedded
            onRetry={onRetryInsights}
          />
        )}
      {gatewaysPending || gatewaysError ? (
        <AgentSectionFeedback error={gatewaysError} onRetry={onRetryGateways} />
      ) : remoteGateways.length > 0 ? (
        <RemoteAgentGatewayDetails gateways={remoteGateways} />
      ) : null}
    </div>
  );
}

function installationWarningLabel(warning: string, translate: typeof i18nTr) {
  if (warning === "DeepSeek Harness workspace storage version is not supported")
    return translate("errors.deepseekWorkspaceVersion");
  return warning;
}
