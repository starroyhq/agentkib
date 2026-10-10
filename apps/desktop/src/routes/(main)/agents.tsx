import { lazy, Suspense, useMemo } from "react";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { AgentsSkeleton } from "@/features/agents/AgentsSkeleton";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/core/useI18n";
import {
  useHomeCatalog,
  useHomeInsightsStatus,
  useHomeInstallations,
  useHomeRemoteGateways,
  useHomeWorkspaces,
} from "@/features/home/home-query";
import type { WorkspaceSummary } from "@/core/types";
import type { AgentFilter } from "@/components/AppSidebar";
import type { AgentKind } from "@/core/types";

const AgentsPageLazy = lazy(() =>
  import("@/features/agents/AgentsPage").then(({ AgentsPage }) => ({ default: AgentsPage })),
);

function AgentsRoute() {
  const { tr } = useI18n();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { agent?: AgentKind; agentFilter?: AgentFilter };
  const installationsQuery = useHomeInstallations();
  const catalogQuery = useHomeCatalog();
  const assets = useMemo(
    () => (catalogQuery.data ?? []).filter((asset) => asset.scope === "agent-home"),
    [catalogQuery.data],
  );
  const workspacesQuery = useHomeWorkspaces();
  const gatewaysQuery = useHomeRemoteGateways();
  const insightsQuery = useHomeInsightsStatus();
  const installations = installationsQuery.data ?? [];
  const workspaces = workspacesQuery.data ?? [];
  const remoteGateways = gatewaysQuery.data ?? [];
  const openWorkspace = async (workspace: WorkspaceSummary) => {
    await navigate({ to: "/workspace/$workspaceId", params: { workspaceId: workspace.id } });
  };

  if (installationsQuery.isPending) return <AgentsSkeleton />;
  if (installationsQuery.isError && installationsQuery.data === undefined) {
    return (
      <section
        role="alert"
        className="grid min-h-[420px] place-content-center justify-items-center gap-3 rounded-2xl border border-border bg-card p-8 text-center"
      >
        <h2 className="text-base font-semibold">{tr("nav.agents")}</h2>
        <p className="text-sm text-muted-foreground">{tr("errors.generic")}</p>
        <Button onClick={() => void installationsQuery.refetch()}>{tr("runtime.retry")}</Button>
      </section>
    );
  }

  return (
    <Suspense fallback={<AgentsSkeleton />}>
      <AgentsPageLazy
        installations={installations}
        assets={assets}
        workspaces={workspaces}
        remoteGateways={remoteGateways}
        insightsStatus={insightsQuery.data}
        loading={{
          assets: catalogQuery.isPending,
          workspaces: workspacesQuery.isPending,
          gateways: gatewaysQuery.isPending,
          insights: insightsQuery.isPending,
        }}
        errors={{
          assets: catalogQuery.isError && catalogQuery.data === undefined,
          workspaces: workspacesQuery.isError && workspacesQuery.data === undefined,
          gateways: gatewaysQuery.isError && gatewaysQuery.data === undefined,
          insights: insightsQuery.isError && insightsQuery.data === undefined,
        }}
        onRetry={{
          assets: () => void catalogQuery.refetch(),
          workspaces: () => void workspacesQuery.refetch(),
          gateways: () => void gatewaysQuery.refetch(),
          insights: () => void insightsQuery.refetch(),
        }}
        onOpen={openWorkspace}
        filter={search.agentFilter ?? "all"}
        selectedAgent={search.agent}
        onSelectedAgentChange={(agent) =>
          void navigate({
            to: "/agents",
            search: (current) => ({ ...current, agent }) as never,
          })
        }
        onClearFilters={() =>
          void navigate({
            to: "/agents",
            search: (current) => ({ ...current, agentFilter: "all" }) as never,
          })
        }
      />
    </Suspense>
  );
}

export const Route = createFileRoute("/(main)/agents")({
  staticData: { appRoute: { kind: "global", page: "agents" } },
  component: AgentsRoute,
});
