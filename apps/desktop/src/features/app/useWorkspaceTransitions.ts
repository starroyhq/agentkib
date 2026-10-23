import { useCallback } from "react";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { useI18n } from "@/core/useI18n";
import type { WorkspaceSummary } from "@/core/types";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import type { GitSubview } from "@/features/workspace/WorkspaceGitPage";
import type { AppSearch, Page, ParsedRoute } from "./app-route";

interface WorkspaceTransitionOptions {
  route: ParsedRoute;
  navigateWorkspacePageFor: (workspaceId: string, nextPage: Page, routeSearch?: AppSearch) => void;
  clearGitSubview: () => void;
  invalidatePendingLoad: () => void;
}

export function useWorkspaceTransitions({
  route,
  navigateWorkspacePageFor,
  clearGitSubview,
  invalidatePendingLoad,
}: WorkspaceTransitionOptions) {
  const { tr } = useI18n();
  const dialogs = useAppDialogs();

  const ensureWorkspaceChangeAllowed = useCallback(async () => {
    if (!useWorkspaceStore.getState().applyingChanges) return true;
    await dialogs.notify(tr("workspace.changesApplying"));
    return false;
  }, [dialogs, tr]);

  const persistWorkspaceDraft = useCallback(() => {
    const workspace = useWorkspaceStore.getState();
    const selectedWorkspace = workspace.selectedWorkspace;
    const manifest = workspace.manifest;
    if (!selectedWorkspace || !manifest || !workspace.baselineManifest) return;
    workspace.cacheWorkspaceDraft(selectedWorkspace.id, manifest, workspace.baselineManifest);
  }, []);

  const leaveWorkspace = useCallback(
    async (next: () => void, clearRouteSearch = true): Promise<boolean> => {
      if (useWorkspaceStore.getState().applyingChanges) {
        await dialogs.notify(tr("workspace.changesApplying"));
        return false;
      }
      const current = useWorkspaceStore.getState();
      const hasUnsavedDraft = Boolean(
        current.manifest &&
        current.baselineManifest &&
        JSON.stringify(current.manifest) !== current.baselineManifest,
      );
      if (
        hasUnsavedDraft &&
        !(await dialogs.confirm({
          description: tr("workspace.leaveDraftConfirm"),
          tone: "destructive",
        }))
      )
        return false;
      const latest = useWorkspaceStore.getState();
      if (latest.applyingChanges) {
        await dialogs.notify(tr("workspace.changesApplying"));
        return false;
      }

      invalidatePendingLoad();
      const selectedWorkspace = latest.selectedWorkspace;
      if (selectedWorkspace)
        latest.setWorkspaceDrafts((drafts) => {
          const nextDrafts = { ...drafts };
          delete nextDrafts[selectedWorkspace.id];
          return nextDrafts;
        });
      if (clearRouteSearch) clearGitSubview();
      latest.setSelectedWorkspace(undefined);
      latest.setProject("");
      latest.setScan(undefined);
      latest.setManifest(undefined);
      latest.setChangeSet(undefined);
      latest.setChangeSetOrigin("standard");
      latest.setHandoffLaunchRequest(undefined);
      latest.setBaselineManifest("");
      latest.setAppliedChanges(undefined);
      next();
      return true;
    },
    [clearGitSubview, dialogs, invalidatePendingLoad, tr],
  );

  const openWorkspace = useCallback(
    async (
      workspace: WorkspaceSummary,
      initialPage: Page = "overview",
      routeSearch?: AppSearch,
      beforeNavigate?: () => void,
    ) => {
      if (!(await ensureWorkspaceChangeAllowed())) return false;
      const current = useWorkspaceStore.getState();
      // The first guard yields; applying may start before navigation resumes.
      if (current.applyingChanges) return ensureWorkspaceChangeAllowed();
      const currentRouteWorkspaceId = route.kind === "workspace" ? route.workspaceId : undefined;
      const currentRoutePage = route.kind === "workspace" ? route.page : undefined;
      if (current.selectedWorkspace?.id === workspace.id && current.project === workspace.path) {
        beforeNavigate?.();
        if (
          route.kind !== "workspace" ||
          currentRouteWorkspaceId !== workspace.id ||
          currentRoutePage !== initialPage ||
          routeSearch
        )
          navigateWorkspacePageFor(workspace.id, initialPage, routeSearch);
        return true;
      }

      invalidatePendingLoad();
      persistWorkspaceDraft();
      const nextState = useWorkspaceStore.getState();
      nextState.setMessage("");
      nextState.setChangeSet(undefined);
      nextState.setAppliedChanges(undefined);
      nextState.setChangeSetOrigin("standard");
      nextState.setHandoffLaunchRequest(undefined);
      nextState.setProject(workspace.path);
      nextState.setScan(undefined);
      nextState.setManifest(undefined);
      nextState.setBaselineManifest("");
      nextState.setSelectedWorkspace(workspace);
      beforeNavigate?.();
      navigateWorkspacePageFor(workspace.id, initialPage, routeSearch);
      return true;
    },
    [
      ensureWorkspaceChangeAllowed,
      invalidatePendingLoad,
      navigateWorkspacePageFor,
      persistWorkspaceDraft,
      route,
    ],
  );

  return { ensureWorkspaceChangeAllowed, leaveWorkspace, openWorkspace };
}
