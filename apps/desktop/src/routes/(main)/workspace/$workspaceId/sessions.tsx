import { createFileRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useHomeInstallations } from "@/features/home/home-query";
import { WorkspaceSessionsSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { WorkspaceSessionsPage } from "@/features/workspace/WorkspaceSessionsPage";
import { useSessionViewStore } from "@/features/sessions/session-view-store";
import { api } from "@/core/api";
import { useAppStore } from "@/stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";

function WorkspaceSessionsRoute() {
  const navigate = useNavigate();
  const { workspaceId } = useParams({ from: "/(main)/workspace/$workspaceId/sessions" });
  const search = useSearch({ strict: false });
  const { runtime, setRuntime } = useAppStore();
  const { data: installations = [] } = useHomeInstallations();
  const { selectedWorkspace, scan, setChangeSet, setChangeSetOrigin, setHandoffLaunchRequest } =
    useWorkspaceStore();
  if (!selectedWorkspace || !scan) return <WorkspaceSessionsSkeleton />;
  const targetAgents = Array.from(
    new Set([
      ...scan.agents.filter((agent) => agent.detected).map((agent) => agent.agent),
      ...installations.filter((agent) => agent.installed).map((agent) => agent.agent),
    ]),
  );
  return (
    <WorkspaceSessionsPage
      workspace={selectedWorkspace}
      enabled={runtime?.session_index_enabled === true}
      targetAgents={targetAgents}
      installedAgents={installations.filter((agent) => agent.installed).map((agent) => agent.agent)}
      onOpenSession={
        search.handoffSession || search.handoffResume
          ? undefined
          : (sessionId) => {
              void navigate({ to: "/sessions", search: { sessionId } });
            }
      }
      onOpenClaudeSession={(sessionId, panel) => {
        const view = useSessionViewStore.getState();
        view.resetFilters();
        view.setFilter("all");
        view.setCreatingConversation(false);
        if (panel) view.requestPanel(sessionId, panel);
        void navigate({ to: "/sessions", search: (current) => ({ ...current, sessionId }) });
      }}
      onRuntimeChanged={async (enabled) => {
        setRuntime(await api.setSessionIndexEnabled(enabled));
      }}
      onHandoffPlanned={(planned) => {
        setChangeSet(planned.change_set);
        setHandoffLaunchRequest(planned.launch_request);
        setChangeSetOrigin("handoff");
        void navigate({ to: "/workspace/$workspaceId/changes", params: { workspaceId } });
      }}
      initialSessionId={
        search.sessionId ?? (!search.handoffTarget ? search.handoffSession : undefined)
      }
      openHandoffOnInitialSession={!!search.handoffSession && !search.handoffTarget}
      onInitialSessionConsumed={() => {
        void navigate({
          to: "/workspace/$workspaceId/sessions",
          params: { workspaceId },
          replace: true,
          search: (current) => ({
            ...current,
            sessionId: undefined,
            ...(!search.handoffTarget ? { handoffSession: undefined } : {}),
          }),
        });
      }}
      resumeContinuation={
        search.handoffSession &&
        search.handoffTarget &&
        search.handoffBudget &&
        search.handoffFormat
          ? {
              sessionId: search.handoffSession,
              targetAgent: search.handoffTarget,
              historyBudgetTokens: search.handoffBudget,
              format: search.handoffFormat,
              targetSurface: search.handoffSurface,
              bindingId: search.handoffBinding,
              ...(search.handoffPreCompaction ? { includePreCompactionHistory: true } : {}),
              autoPrepare: search.handoffResume === "recheck",
            }
          : undefined
      }
      onResumeConsumed={() => {
        void navigate({
          to: "/workspace/$workspaceId/sessions",
          params: { workspaceId },
          replace: true,
          search: (current) => ({
            ...current,
            handoffSession: undefined,
            handoffTarget: undefined,
            handoffBudget: undefined,
            handoffFormat: undefined,
            handoffSurface: undefined,
            handoffBinding: undefined,
            handoffPreCompaction: undefined,
            handoffResume: undefined,
          }),
        });
      }}
      onMcpConnectionPlanned={(changeSet, request) => {
        setChangeSet(changeSet);
        setHandoffLaunchRequest(undefined);
        setChangeSetOrigin("handoff-setup");
        void navigate({
          to: "/workspace/$workspaceId/changes",
          params: { workspaceId },
          search: (current) => ({
            ...current,
            handoffSession: request.sessionId,
            handoffTarget: request.targetAgent,
            handoffBudget: request.historyBudgetTokens as 64_000 | 120_000 | 180_000,
            handoffFormat: request.format,
            handoffSurface: request.targetSurface,
            handoffBinding: request.bindingId,
            handoffPreCompaction: request.includePreCompactionHistory ? (true as const) : undefined,
            handoffResume: "return" as const,
          }),
        });
      }}
    />
  );
}

export const Route = createFileRoute("/(main)/workspace/$workspaceId/sessions")({
  staticData: { appRoute: { kind: "workspace", page: "sessions" } },
  component: WorkspaceSessionsRoute,
});
