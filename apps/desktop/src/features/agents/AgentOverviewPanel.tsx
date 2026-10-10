import { useI18n } from "@/core/useI18n";
import { tr as i18nTr } from "@/core/i18n";
import { Badge } from "@/components/ui/badge";
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
import { Check, CircleAlert, FolderGit2, LockKeyhole, X } from "lucide-react";
import { cn } from "cn";
import { AgentSectionFeedback } from "./AgentSectionFeedback";
import { RemoteAgentGatewayDetails } from "./RemoteAgentGatewayDetails";

export function AgentOverviewPanel({
  agent,
  installation,
  support,
  provider,
  linkedWorkspaces,
  recentLinkedWorkspaces,
  homeAssets,
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
}) {
  const { tr, formatRelativeTime } = useI18n();
  const remoteWorkspaceCount = remoteGateways.reduce(
    (total, gateway) => total + gateway.workspaces.length,
    0,
  );
  const providerValue = insightsPending
    ? tr("common.loading")
    : insightsError
      ? "—"
      : provider?.available
        ? tr("quota.available")
        : provider?.error || provider?.error_key
          ? tr("insights.providerUnavailable")
          : tr("insights.noData");

  return (
    <div className="grid gap-5 p-5">
      {agent === "deepseek-harness" && (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          <CircleAlert size={16} />
          {tr("agents.deepseekReadOnly")}
        </div>
      )}

      <div
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        aria-busy={assetsPending || workspacesPending || insightsPending}
      >
        {[
          [
            tr("agents.linkedWorkspaces"),
            workspacesPending || gatewaysPending
              ? tr("common.loading")
              : workspacesError || gatewaysError
                ? "—"
                : linkedWorkspaces.length + remoteWorkspaceCount,
          ],
          [
            tr("agents.homeAssets"),
            assetsPending ? tr("common.loading") : assetsError ? "—" : homeAssets.length,
          ],
          [tr("agents.provider"), providerValue],
          [
            tr("agents.continuationCapability"),
            support === undefined
              ? tr("agents.capability.unknown")
              : support.continuation
                ? tr("agents.capability.supported")
                : tr("agents.capability.unavailable"),
          ],
        ].map(([label, value]) => (
          <div
            className="grid min-h-[92px] content-center gap-2 rounded-xl border border-border bg-muted/20 p-4"
            key={label}
          >
            <span className="text-xs text-muted-foreground">{label}</span>
            <strong className="text-lg tracking-tight">{value}</strong>
          </div>
        ))}
      </div>

      <section className="grid gap-3 rounded-xl border border-border bg-background p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">{tr("agents.capabilities")}</h3>
          <span className="text-xs text-muted-foreground">
            {tr("agents.capabilitiesDescription")}
          </span>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-2">
          {[
            ["workspace_discovery", tr("agents.capability.workspaceDiscovery")],
            ["session_list", tr("agents.capability.sessionList")],
            ["history_read", tr("agents.capability.historyRead")],
            ["continuation", tr("agents.capability.continuation")],
          ].map(([key, label]) => {
            const value = support?.[key as keyof typeof support];
            const known = typeof value === "boolean";
            const enabled = value === true;
            return (
              <div
                className="grid min-h-[68px] content-center gap-2 rounded-lg bg-muted/25 px-3 py-2 text-sm"
                key={key}
              >
                <span className="min-w-0 text-muted-foreground">{label}</span>
                <span
                  className={cn(
                    "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium",
                    !known
                      ? "text-muted-foreground"
                      : enabled
                        ? "text-emerald-600"
                        : "text-muted-foreground",
                  )}
                >
                  {!known ? null : enabled ? <Check size={14} /> : <X size={14} />}
                  {tr(
                    !known
                      ? "agents.capability.unknown"
                      : enabled
                        ? "agents.capability.supported"
                        : "agents.capability.unavailable",
                  )}
                </span>
              </div>
            );
          })}
          <div className="grid min-h-[68px] content-center gap-2 rounded-lg bg-muted/25 px-3 py-2 text-sm">
            <span className="min-w-0 text-muted-foreground">{tr("agents.capability.control")}</span>
            <span className="inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium text-muted-foreground">
              <LockKeyhole size={14} />
              {tr(
                support
                  ? `agents.capability.control.${support.control}`
                  : "agents.capability.unknown",
              )}
            </span>
          </div>
        </div>
      </section>

      {installation?.home && (
        <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-background px-4 py-3">
          <FolderGit2 size={16} className="shrink-0 text-muted-foreground" />
          <code className="block min-w-0 truncate text-xs text-muted-foreground">
            {installation.home}
          </code>
        </div>
      )}
      {installation?.warnings.map((warning) => (
        <div
          className="flex items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          key={warning}
        >
          <CircleAlert size={16} />
          {installationWarningLabel(warning, tr)}
        </div>
      ))}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-background p-4">
          <h3 className="mb-3 text-sm font-semibold">{tr("agents.recentWorkspaces")}</h3>
          {workspacesPending || workspacesError ? (
            <AgentSectionFeedback error={workspacesError} onRetry={onRetryWorkspaces} />
          ) : (
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
                      {workspace.path}
                    </small>
                  </span>
                  <small className="text-xs text-muted-foreground">
                    {workspace.last_active_at
                      ? formatRelativeTime(workspace.last_active_at)
                      : tr("common.never")}
                  </small>
                </Button>
              ))}
              {!recentLinkedWorkspaces.length && (
                <p className="px-2 py-4 text-sm text-muted-foreground">
                  {tr("agents.noRecentWorkspaces")}
                </p>
              )}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-border bg-background p-4">
          <h3 className="mb-3 text-sm font-semibold">{tr("agents.homeAssetTypes")}</h3>
          {assetsPending || assetsError ? (
            <AgentSectionFeedback error={assetsError} onRetry={onRetryAssets} />
          ) : (
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
              {!homeAssetKinds.length && (
                <div className="flex min-h-[42px] items-center justify-between rounded-lg bg-muted/20 px-2 text-sm">
                  <dt className="text-muted-foreground">{tr("agents.noHomeAssets")}</dt>
                  <dd className="font-medium">0</dd>
                </div>
              )}
            </dl>
          )}
        </section>
      </div>

      {gatewaysPending || gatewaysError ? (
        <section className="rounded-xl border border-border bg-background">
          <AgentSectionFeedback error={gatewaysError} onRetry={onRetryGateways} />
        </section>
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
