import { useI18n } from "@/core/useI18n";
import { useEffect, useRef, useState } from "react";
import {
  createFileRoute,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { FolderGit2, GitCompareArrows, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  WorkspaceAssetsSkeleton,
  WorkspaceChangesSkeleton,
  WorkspaceContextSkeleton,
  WorkspaceDoctorSkeleton,
  WorkspaceGitSkeleton,
  WorkspaceLayoutSkeleton,
  WorkspaceOverviewSkeleton,
  WorkspaceSessionsSkeleton,
} from "@/features/workspace/WorkspaceSkeleton";
import { useAppStore } from "@/stores/app-store";
import {
  useHomeWorkspaces,
  useHomeDoctorReport,
  useHomeMemories,
} from "@/features/home/home-query";
import { getWorkspaceStatus } from "@/features/workspace/workspace-status";
import { usePathDisplay } from "@/lib/usePathDisplay";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { api } from "@/core/api";
import { cn } from "cn";
import { withAsyncCleanup } from "@/lib/utils";
import type { Manifest, WorkspaceScan, WorkspaceSummary } from "@/core/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkspaceOpenWith } from "@/features/workspace/WorkspaceOpenWith";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { appliedChangeCopy } from "@/features/workspace/applied-change-copy";
import { AppliedChangesNotice } from "@/features/workspace/AppliedChangesNotice";
import { draftSectionCount, resolveRefreshedManifest } from "@/features/workspace/manifest-draft";
import { Copy, MoreHorizontal, RefreshCw } from "lucide-react";
function WorkspaceActions({
  workspace,
  onError,
  onScan,
  busy,
  locked,
  onReview,
  reviewDisabled,
  reviewDisabledReason,
  showReview,
}: {
  workspace: WorkspaceSummary;
  onError: (message: string) => void;
  onScan: () => void | Promise<void>;
  busy: boolean;
  locked: boolean;
  onReview: () => void | Promise<void>;
  reviewDisabled: boolean;
  reviewDisabledReason?: string;
  showReview: boolean;
}) {
  const { tr } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5 md:gap-2">
      <WorkspaceOpenWith workspace={workspace} onError={onError} />
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={tr("common.moreActions")}
          aria-label={tr("common.moreActions")}
        >
          <MoreHorizontal size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => void navigator.clipboard?.writeText(workspace.path)}>
            <Copy size={13} />
            {tr("workspace.copyPath")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="outline"
        size="icon"
        className="size-9 rounded-lg"
        title={tr("common.scan")}
        aria-label={tr("common.scan")}
        onClick={() => void onScan()}
        disabled={busy || locked}
      >
        <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
      </Button>
      {showReview && (
        <span className="grid justify-items-end gap-1">
          <Button
            className="h-9 rounded-lg px-3"
            onClick={() => void onReview()}
            disabled={reviewDisabled || locked}
            aria-describedby={reviewDisabledReason ? "workspace-review-reason" : undefined}
          >
            <GitCompareArrows size={15} />
            {tr("workspace.reviewChanges")}
          </Button>
          {reviewDisabledReason && (
            <span id="workspace-review-reason" className="max-w-64 text-xs text-muted-foreground">
              {reviewDisabledReason}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

type Page = "overview" | "sessions" | "git" | "assets" | "context" | "doctor" | "changes";

function WorkspaceLayout() {
  const { localizeMessage, tr, locale } = useI18n();
  const navigate = useNavigate();
  const dialogs = useAppDialogs();
  const location = useLocation();
  const { workspaceId } = useParams({ from: "/(main)/workspace/$workspaceId" });
  const doctorReport = useHomeDoctorReport(workspaceId);
  const memories = useHomeMemories();
  const displayPath = usePathDisplay();
  const status = getWorkspaceStatus(
    workspaceId,
    doctorReport.isError ? undefined : doctorReport.data?.summary,
    memories.data ?? [],
  );
  const setRuntime = useAppStore((state) => state.setRuntime);
  const workspaceState = useWorkspaceStore();
  const { data: workspaces = [], isPending: workspacesPending } = useHomeWorkspaces();
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const {
    project,
    selectedWorkspace,
    scan,
    manifest,
    baselineManifest,
    busy,
    applyingChanges,
    planningChanges,
    setPlanningChanges,
    appliedChanges,
    setAppliedChanges,
    discardWorkspaceDraft,
    setScan,
    setManifest,
    setChangeSet,
    setChangeSetOrigin,
    setHandoffLaunchRequest,
    setBaselineManifest,
    workspaceDrafts,
    setBusy,
    setMessage,
  } = workspaceState;
  const currentPage = getPage(location.pathname);
  const e2ChangesPage =
    currentPage === "changes" &&
    (workspaceState.changeSetOrigin === "standard" || workspaceState.changeSetOrigin === "doctor");
  const activeWorkspace =
    workspace ?? (selectedWorkspace?.id === workspaceId ? selectedWorkspace : undefined);
  const matchesWorkspace =
    selectedWorkspace?.id === workspaceId && project === activeWorkspace?.path;
  const hasWorkspaceContent = Boolean(
    matchesWorkspace && scan && (manifest || currentPage === "doctor"),
  );
  const showPageSkeleton =
    !matchesWorkspace || ((busy || currentPage !== "doctor") && !hasWorkspaceContent);
  const hasUnsavedDraft = Boolean(
    manifest && baselineManifest && JSON.stringify(manifest) !== baselineManifest,
  );
  const operationRequest = useRef(0);
  const discardPending = useRef(false);
  const [discarding, setDiscarding] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planFeedback, setPlanFeedback] = useState<{
    workspaceId: string;
    project: string;
    message: string;
  }>();
  const [draftError, setDraftError] = useState<{
    workspaceId: string;
    project: string;
    key: string;
  }>();
  const dirtySections = draftSectionCount(manifest, baselineManifest);
  const loadStartedWorkspace = useRef<string | undefined>(undefined);
  const [loadFailure, setLoadFailure] = useState<{
    workspaceId: string;
    project: string;
    reason: unknown;
    scan?: WorkspaceScan;
  }>();
  // A scan loaded by another refresh entry point also supersedes this failure.
  const currentLoadFailure =
    loadFailure?.workspaceId === workspaceId &&
    loadFailure.project === project &&
    loadFailure.scan === scan
      ? loadFailure
      : undefined;

  useEffect(() => {
    operationRequest.current += 1;
    loadStartedWorkspace.current = undefined;
    setPlanning(false);
    useWorkspaceStore.getState().setPlanningChanges(false);
    setPlanFeedback(undefined);
    return () => {
      operationRequest.current += 1;
    };
  }, [workspaceId]);

  const loadWorkspace = async (draft?: Manifest) => {
    if (!project || useWorkspaceStore.getState().applyingChanges) return;
    const requestId = ++operationRequest.current;
    const targetProject = project;
    const initialState = useWorkspaceStore.getState();
    const initialBaseline =
      initialState.baselineManifest || initialState.workspaceDraftBaselines[workspaceId] || "";
    const scanAtStart = initialState.scan;
    const isCurrentRequest = () =>
      requestId === operationRequest.current &&
      useWorkspaceStore.getState().selectedWorkspace?.id === workspaceId &&
      useWorkspaceStore.getState().project === targetProject;
    const failLoad = (reason: unknown) => {
      setLoadFailure({
        workspaceId,
        project: targetProject,
        reason,
        scan: scanAtStart,
      });
    };
    setBusy(true);
    setMessage("");
    await withAsyncCleanup(
      async () => {
        try {
          const [scanResult, manifestResult, runtimeResult] = await Promise.allSettled([
            api.scan(targetProject),
            api.manifest(targetProject),
            api.runtime(),
          ]);
          if (!isCurrentRequest()) return;
          if (scanResult.status === "rejected") {
            failLoad(scanResult.reason);
            return;
          }
          if (runtimeResult.status === "rejected") {
            failLoad(runtimeResult.reason);
            return;
          }
          const nextScan = scanResult.value;
          const nextManifest =
            manifestResult.status === "fulfilled" ? manifestResult.value : undefined;
          const resolvedManifest = await resolveRefreshedManifest({
            initialManifest: initialState.manifest,
            initialBaseline,
            cachedDraft: draft,
            diskManifest: nextManifest,
            getCurrentManifest: () => useWorkspaceStore.getState().manifest,
            confirmDiskVersion: () =>
              dialogs.confirm({
                description: tr("workspace.refreshConflict"),
                tone: "warning",
              }),
          });
          if (!isCurrentRequest()) return;
          if (manifestResult.status === "rejected")
            setMessage(localizeMessage(manifestResult.reason));
          setScan(nextScan);
          setManifest(resolvedManifest);
          const nextBaseline = nextManifest ? JSON.stringify(nextManifest) : initialBaseline;
          setBaselineManifest(nextBaseline);
          useWorkspaceStore
            .getState()
            .cacheWorkspaceDraft(workspaceId, resolvedManifest, nextBaseline);
          setRuntime(runtimeResult.value);
          setLoadFailure(undefined);
          void doctorReport.refetch();
          if (!resolvedManifest && currentPage !== "doctor") {
            void navigate({
              to: "/workspace/$workspaceId/doctor",
              params: { workspaceId },
            });
          }
        } catch (error) {
          if (isCurrentRequest()) failLoad(error);
        }
      },
      () => {
        if (isCurrentRequest()) setBusy(false);
      },
    );
  };

  const refreshWorkspace = () => {
    const current = useWorkspaceStore.getState();
    if (current.busy || current.applyingChanges || current.planningChanges) return;
    return loadWorkspace(current.manifest ?? current.workspaceDrafts[workspaceId]);
  };

  useEffect(() => {
    if (
      !activeWorkspace ||
      !project ||
      project !== activeWorkspace.path ||
      (scan && manifest) ||
      loadStartedWorkspace.current === workspaceId
    )
      return;
    loadStartedWorkspace.current = workspaceId;
    void loadWorkspace(workspaceDrafts[workspaceId]);
  }, [activeWorkspace, manifest, project, scan, workspaceDrafts, workspaceId]);

  const plan = async (includeHome = false) => {
    if (
      !project ||
      !manifest ||
      useWorkspaceStore.getState().applyingChanges ||
      useWorkspaceStore.getState().busy ||
      useWorkspaceStore.getState().planningChanges
    )
      return;
    const requestId = ++operationRequest.current;
    const targetProject = project;
    const targetManifest = manifest;
    const isCurrentRequest = () =>
      requestId === operationRequest.current &&
      useWorkspaceStore.getState().selectedWorkspace?.id === workspaceId &&
      useWorkspaceStore.getState().project === targetProject;
    setBusy(true);
    setPlanning(true);
    const planningRevision = setPlanningChanges(true);
    setChangeSetOrigin("standard");
    setHandoffLaunchRequest(undefined);
    void navigate({ to: "/workspace/$workspaceId/changes", params: { workspaceId } });
    setPlanFeedback(undefined);
    setAppliedChanges(undefined);
    setMessage("");
    await withAsyncCleanup(
      async () => {
        try {
          const nextChangeSet = await api.plan(targetProject, targetManifest, includeHome);
          if (!isCurrentRequest()) return;
          if (
            JSON.stringify(useWorkspaceStore.getState().manifest) !== JSON.stringify(targetManifest)
          ) {
            setPlanFeedback({
              workspaceId,
              project: targetProject,
              message: tr("workspace.planSuperseded"),
            });
            return;
          }
          setChangeSet(nextChangeSet, targetManifest, includeHome);
          setChangeSetOrigin("standard");
          setHandoffLaunchRequest(undefined);
          void navigate({
            to: "/workspace/$workspaceId/changes",
            params: { workspaceId },
          });
        } catch (error) {
          if (isCurrentRequest()) {
            setPlanFeedback({
              workspaceId,
              project: targetProject,
              message: localizeMessage(error),
            });
            if (!useWorkspaceStore.getState().changeSet)
              void navigate({ to: "/workspace/$workspaceId/assets", params: { workspaceId } });
          }
        }
      },
      () => {
        if (isCurrentRequest()) {
          setBusy(false);
          setPlanning(false);
          useWorkspaceStore.getState().finishPlanningChanges(planningRevision);
        }
      },
    );
  };

  const discardDraft = async () => {
    if (discardPending.current || busy || applyingChanges || !manifest || !hasUnsavedDraft) return;
    discardPending.current = true;
    setDiscarding(true);
    setDraftError(undefined);
    const targetProject = project;
    const expectedManifest = JSON.stringify(manifest);
    try {
      if (
        !(await dialogs.confirm({
          description: tr("workspace.discardDraftConfirm"),
          tone: "destructive",
        }))
      )
        return;
      const current = useWorkspaceStore.getState();
      if (current.selectedWorkspace?.id !== workspaceId || current.project !== targetProject)
        return;
      if (!discardWorkspaceDraft(expectedManifest))
        setDraftError({
          workspaceId,
          project: targetProject,
          key:
            JSON.stringify(current.manifest) !== expectedManifest
              ? "workspace.discardDraftChanged"
              : "workspace.discardDraftUnavailable",
        });
    } catch {
      if (useWorkspaceStore.getState().selectedWorkspace?.id === workspaceId)
        setDraftError({
          workspaceId,
          project: targetProject,
          key: "workspace.discardDraftUnavailable",
        });
    } finally {
      discardPending.current = false;
      setDiscarding(false);
    }
  };

  if (!activeWorkspace) {
    return !workspacesPending ? (
      <div className="grid h-full min-h-[240px] place-items-center p-8 text-sm text-muted-foreground">
        {tr("common.notFound")}
      </div>
    ) : (
      <WorkspaceLayoutSkeleton />
    );
  }
  return (
    <div className="grid gap-5">
      <section className="flex min-h-[58px] flex-col gap-3 border-b border-border pb-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <FolderGit2 size={18} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
                {activeWorkspace.name}
              </h1>
              <Badge
                variant="outline"
                className={cn(
                  "border-transparent",
                  status.state === "attention"
                    ? "bg-warning/10 text-warning"
                    : status.state === "healthy"
                      ? "bg-emerald-500/10 text-emerald-700"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {status.state === "attention" && (
                  <TriangleAlert size={12} className="mr-1" aria-hidden="true" />
                )}
                {tr(`workspace.status.${status.state}`, { count: status.issueCount })}
              </Badge>
              {(hasUnsavedDraft ||
                (e2ChangesPage && Boolean(workspaceState.changeSet?.changes.length))) && (
                <Badge variant="outline">
                  {e2ChangesPage
                    ? appliedChangeCopy(locale).unapplied(dirtySections || 1)
                    : tr("workspace.draftSections", { count: dirtySections })}
                </Badge>
              )}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <code
                title={activeWorkspace.path}
                className="block truncate text-xs text-muted-foreground"
              >
                {displayPath(activeWorkspace.path)}
              </code>
              <Button
                variant="bare"
                size="content"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                title={tr("workspace.copyPath")}
                aria-label={tr("workspace.copyPath")}
                onClick={() => void navigator.clipboard?.writeText(activeWorkspace.path)}
              >
                <Copy size={13} />
              </Button>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {currentPage === "assets" && hasUnsavedDraft && (
            <Button
              variant="outline"
              onClick={() => void discardDraft()}
              disabled={busy || applyingChanges || discarding}
            >
              {tr("workspace.discardDraft")}
            </Button>
          )}
          <WorkspaceActions
            workspace={activeWorkspace}
            onError={setMessage}
            onScan={refreshWorkspace}
            busy={busy || planningChanges}
            locked={applyingChanges || discarding}
            onReview={() => plan(false)}
            reviewDisabled={busy || !hasUnsavedDraft}
            showReview={hasUnsavedDraft && !e2ChangesPage}
            reviewDisabledReason={
              applyingChanges
                ? tr("changes.applying")
                : busy || discarding
                  ? tr("common.loading")
                  : undefined
            }
          />
        </div>
      </section>

      {appliedChanges?.workspaceId === workspaceId &&
        appliedChanges.project === project &&
        (currentPage !== "changes" ||
          appliedChanges.origin === "handoff" ||
          appliedChanges.origin === "handoff-setup") &&
        !(currentPage === "doctor" && appliedChanges.origin === "doctor") && (
          <AppliedChangesNotice
            key={appliedChanges.changeSet.id}
            result={appliedChanges}
            onDismiss={() => setAppliedChanges(undefined)}
          />
        )}
      {draftError?.workspaceId === workspaceId && draftError.project === project && (
        <p role="alert" className="text-sm text-destructive-text">
          {tr(draftError.key)}
        </p>
      )}
      {planFeedback?.workspaceId === workspaceId && planFeedback.project === project && (
        <p role="alert" className="text-sm text-destructive-text">
          {planFeedback.message}
        </p>
      )}

      <section
        aria-busy={busy}
        className={cn("min-w-0", currentPage === "git" && "min-h-[calc(100vh-118px)]")}
      >
        {busy && hasWorkspaceContent && !(planningChanges && currentPage === "changes") && (
          <p role="status" className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
            <RefreshCw size={13} className="animate-spin" />
            {tr(planning ? "workspace.planning" : "workspace.updating")}
          </p>
        )}
        {currentLoadFailure && (
          <div
            role="alert"
            className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive-text"
          >
            <div className="grid gap-1">
              <strong>{tr("workspace.scanFailed")}</strong>
              <p>{localizeMessage(currentLoadFailure.reason)}</p>
            </div>
            <Button
              variant="outline"
              onClick={() => void refreshWorkspace()}
              disabled={busy || applyingChanges}
              aria-busy={busy}
            >
              <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
              {tr("workspace.retryScan")}
            </Button>
          </div>
        )}
        {showPageSkeleton ? (
          currentLoadFailure ? null : (
            <WorkspacePageSkeleton page={currentPage} />
          )
        ) : (
          <Outlet key={workspaceId} />
        )}
      </section>
    </div>
  );
}

function getPage(pathname: string): Page {
  const value = pathname.split("/").filter(Boolean).at(-1);
  return value === "sessions" ||
    value === "git" ||
    value === "assets" ||
    value === "context" ||
    value === "doctor" ||
    value === "changes"
    ? value
    : "overview";
}

function WorkspacePageSkeleton({ page }: { page: Page }) {
  switch (page) {
    case "assets":
      return <WorkspaceAssetsSkeleton />;
    case "changes":
      return <WorkspaceChangesSkeleton />;
    case "context":
      return <WorkspaceContextSkeleton />;
    case "doctor":
      return <WorkspaceDoctorSkeleton />;
    case "git":
      return <WorkspaceGitSkeleton />;
    case "sessions":
      return <WorkspaceSessionsSkeleton />;
    default:
      return <WorkspaceOverviewSkeleton />;
  }
}

export const Route = createFileRoute("/(main)/workspace/$workspaceId")({
  staticData: { appRoute: { kind: "workspace", page: "overview" } },
  component: WorkspaceLayout,
});
