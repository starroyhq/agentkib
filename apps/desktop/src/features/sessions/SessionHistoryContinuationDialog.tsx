import { useEffect, useRef } from "react";
import { useHomeInstallations } from "@/features/home/home-query";
import { useAppNavigationContext } from "@/features/app/AppNavigationContext";
import { SessionHandoffDialog } from "@/features/workspace/SessionHandoffDialog";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useSessionViewStore, type HistoryContinuationRequest } from "./session-view-store";
import type { AppSearch } from "@/features/app/app-route";

export function SessionHistoryContinuationDialog({
  request,
}: {
  request: HistoryContinuationRequest;
}) {
  const { app } = useAppNavigationContext();
  const installations = useHomeInstallations();
  const { workspace, session } = request;
  const close = () => useSessionViewStore.getState().closeHistoryContinuation(request);
  // The request is view state: leaving the session page must not reopen it on return.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current) useSessionViewStore.getState().closeHistoryContinuation(request);
      });
    };
  }, [request]);
  const current = useWorkspaceStore.getState();
  const detected =
    current.selectedWorkspace?.id === workspace.id
      ? (current.scan?.agents.filter((agent) => agent.detected).map((agent) => agent.agent) ??
        workspace.sources.flatMap((source) => (source.agent ? [source.agent] : [])))
      : workspace.sources.flatMap((source) => (source.agent ? [source.agent] : []));
  const targetAgents = [
    ...new Set([
      ...detected,
      ...(installations.data ?? []).filter((agent) => agent.installed).map((agent) => agent.agent),
    ]),
  ];
  const openPlan = (apply: () => void, search?: AppSearch) => {
    // Initialize the workspace first, then install the plan before the destination reads it.
    void app.openWorkspace(workspace, "changes", search, () => {
      apply();
      close();
    });
  };
  return (
    <SessionHandoffDialog
      workspace={workspace}
      session={session}
      targetAgents={targetAgents}
      onClose={close}
      onPlanned={(planned) =>
        openPlan(() => {
          const store = useWorkspaceStore.getState();
          store.setChangeSet(planned.change_set);
          store.setHandoffLaunchRequest(planned.launch_request);
          store.setChangeSetOrigin("handoff");
        })
      }
      onMcpConnectionPlanned={(changeSet, resume) =>
        openPlan(
          () => {
            const store = useWorkspaceStore.getState();
            store.setChangeSet(changeSet);
            store.setHandoffLaunchRequest(undefined);
            store.setChangeSetOrigin("handoff-setup");
          },
          {
            handoffSession: resume.sessionId,
            handoffTarget: resume.targetAgent,
            handoffBudget: resume.historyBudgetTokens as 64_000 | 120_000 | 180_000,
            handoffFormat: resume.format,
            handoffSurface: resume.targetSurface,
            handoffBinding: resume.bindingId,
            handoffPreCompaction: resume.includePreCompactionHistory ? true : undefined,
            handoffResume: "return",
          },
        )
      }
    />
  );
}
