import { scanSettingsActions } from "@/features/home/scan-settings-actions";
import { useEffect } from "react";
import { subscribeSessionForegroundRefresh } from "@agentkib/session-ui";
import { ConnectedAgents } from "@/features/agents/ConnectedAgents";
import type { AppSearch } from "@/features/app/app-route";
import { useI18n } from "@/core/useI18n";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/core/api";
import { GlobalSettings } from "@/features/settings/GlobalSettings";
import { SettingsContentSkeleton } from "@/features/settings/SettingsSkeleton";
import type { SettingsPageVariant } from "@/features/settings/components/SettingsLayout";
import { useSettingsTargetFocus } from "@/features/settings/useSettingsTargetFocus";
import { useAppStore } from "@/stores/app-store";
import {
  homeKeys,
  useHomeActivity,
  useHomeDiscovery,
  useHomeExcluded,
  useHomeInsightsStatus,
  useHomeRemoteGateways,
  useHomeScanRoots,
  useHomeWorkspaces,
} from "@/features/home/home-query";
import { clearOnboardingDismissal } from "@/features/home/onboarding-preference";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useQuotaStatus } from "@/features/quota/quota-query";
import type { CloseBehavior, RefreshKind, RuntimeInfo } from "@/core/types";

type SettingsSearch = Pick<
  AppSearch,
  "settingsSection" | "settingsTarget" | "settingsAgent" | "settingsAgentFilter"
>;

function SettingsRoute() {
  const { localizeMessage, tr } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as SettingsSearch;
  const section = search.settingsSection ?? "general";
  const layoutVariant: SettingsPageVariant =
    section === "tools" || section === "integrations"
      ? "workspace"
      : section === "general" ||
          section === "sessions" ||
          section === "appearance" ||
          section === "shortcuts" ||
          section === "privacy"
        ? "form"
        : "management";
  const runtime = useAppStore((state) => state.runtime);
  const setRuntime = useAppStore((state) => state.setRuntime);
  const { data: workspaces = [], isPending: workspacesPending } = useHomeWorkspaces();
  const { data: discovery, isError: discoveryFailed } = useHomeDiscovery();
  const { data: insightsStatus, isError: insightsFailed } = useHomeInsightsStatus();
  const { data: quotaStatus, isError: quotaFailed, refetch: refetchQuota } = useQuotaStatus();
  const { data: remoteGateways = [] } = useHomeRemoteGateways();
  const { data: scanRoots = [] } = useHomeScanRoots();
  const { data: excluded = [] } = useHomeExcluded();
  const { data: activity = [], isError: activityFailed } = useHomeActivity();
  const setMessage = useWorkspaceStore((state) => state.setMessage);
  // The diagnostics export is available even before the runtime connects.
  const contentPending = section !== "diagnostics" && !runtime && workspacesPending;

  useSettingsTargetFocus(search.settingsTarget, section, contentPending);
  useEffect(() => {
    if (section !== "diagnostics") return;
    const read = () => {
      void refetchQuota({ cancelRefetch: false });
      for (const queryKey of [homeKeys.discovery(), homeKeys.insightsStatus(), homeKeys.activity()])
        void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
    };
    read();
    return subscribeSessionForegroundRefresh(read);
  }, [queryClient, refetchQuota, section]);

  const run = async (operation: () => Promise<void>) => {
    setMessage("");
    try {
      await operation();
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };

  const scanSettings = scanSettingsActions(queryClient);
  const addRoot = () => run(scanSettings.addRoot);
  const removeRoot = (id: string) => run(() => scanSettings.removeRoot(id));
  const restoreExcluded = (path: string) => run(() => scanSettings.restoreExcluded(path));

  const changeCloseBehavior = (behavior?: CloseBehavior) =>
    run(async () => {
      await api.setCloseBehavior(behavior);
      setRuntime(await api.runtime());
    });

  const refreshRemoteGateways = () =>
    run(async () => {
      await queryClient.invalidateQueries({ queryKey: homeKeys.remoteGateways() });
    });

  const clearContinuationCache = () =>
    queryClient.removeQueries({ queryKey: homeKeys.continuationsRoot() });
  const changeRuntime = (nextRuntime: RuntimeInfo) => {
    if (nextRuntime.session_index_enabled === false) clearContinuationCache();
    setRuntime(nextRuntime);
  };
  const restartOnboarding = () =>
    run(async () => {
      clearOnboardingDismissal();
      setRuntime(await api.updateOnboarding({ event: "restarted" }));
    });

  const refreshDiagnostics = () =>
    run(async () => {
      await Promise.all(
        (["discovery", "insights", "gateways", "quota"] satisfies RefreshKind[]).map((kind) =>
          api.requestRefresh(kind, true),
        ),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: homeKeys.discovery() }),
        queryClient.invalidateQueries({ queryKey: homeKeys.insightsStatus() }),
        queryClient.invalidateQueries({ queryKey: homeKeys.remoteGateways() }),
        queryClient.invalidateQueries({ queryKey: homeKeys.activity() }),
        refetchQuota(),
      ]);
    });

  return (
    <>
      {contentPending ? (
        <SettingsContentSkeleton variant={layoutVariant} />
      ) : (
        <GlobalSettings
          section={section}
          settingsTarget={search.settingsTarget}
          onSettingsTargetChange={(target) =>
            void navigate({
              to: "/settings",
              search: (current) => ({ ...current, settingsTarget: target }),
            })
          }
          agentsContent={
            <ConnectedAgents
              selectedAgent={search.settingsAgent}
              filter={search.settingsAgentFilter}
              onSelectedAgentChange={(agent) =>
                void navigate({
                  to: "/settings",
                  replace: true,
                  search: (current) => ({ ...current, settingsAgent: agent }),
                })
              }
              onFilterChange={(filter) =>
                void navigate({
                  to: "/settings",
                  replace: true,
                  search: (current) => ({ ...current, settingsAgentFilter: filter }),
                })
              }
              onOpen={async (workspace) => {
                await navigate({
                  to: "/workspace/$workspaceId",
                  params: { workspaceId: workspace.id },
                });
              }}
            />
          }
          runtime={runtime}
          workspaces={workspaces}
          discovery={discovery}
          insightsStatus={insightsStatus}
          quotaStatus={quotaStatus}
          remoteGateways={remoteGateways}
          scanRoots={scanRoots}
          excluded={excluded}
          activity={activity}
          onAddRoot={addRoot}
          onRemoveRoot={removeRoot}
          onRestore={restoreExcluded}
          onCloseBehaviorChanged={changeCloseBehavior}
          onLocaleChanged={changeRuntime}
          onSessionIndexCleared={clearContinuationCache}
          onOnboardingRestarted={restartOnboarding}
          onRemoteGatewaysChanged={refreshRemoteGateways}
          onRefreshDiagnostics={refreshDiagnostics}
          diagnosticsFailed={discoveryFailed || insightsFailed || quotaFailed || activityFailed}
        />
      )}
    </>
  );
}

export const Route = createFileRoute("/(settings)/settings")({ component: SettingsRoute });
