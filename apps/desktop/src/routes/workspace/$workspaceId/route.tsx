import { useI18n } from "@/core/useI18n";
import { useEffect, useRef } from "react";
import {
  createFileRoute,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import {
  Boxes,
  Code2,
  FolderGit2,
  GitCommitHorizontal,
  GitCompareArrows,
  LayoutDashboard,
  MessageSquareText,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
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
import { useAppStore } from "../../../stores/app-store";
import { useHomeWorkspaces } from "@/features/home/home-query";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { api } from "../../../core/api";
import { tr } from "../../../core/i18n";
import { cn, withAsyncCleanup } from "@/lib/utils";
import type { Manifest, WorkspaceSummary } from "../../../core/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkspaceOpenWith } from "@/features/workspace/WorkspaceOpenWith";
import { Copy, MoreHorizontal, RefreshCw } from "lucide-react";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { workspaceSearchForPage, type AppSearch } from "@/features/app/app-route";
function WorkspaceActions({
  workspace,
  onError,
  onScan,
  busy,
  onReview,
  reviewDisabled,
}: {
  workspace: WorkspaceSummary;
  onError: (message: string) => void;
  onScan: () => void | Promise<void>;
  busy: boolean;
  onReview: () => void | Promise<void>;
  reviewDisabled: boolean;
}) {
  const { tr } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5 md:gap-2">
      {workspace.status === "attention" && (
        <Badge variant="outline" className="mr-1 border-amber-500/30 bg-amber-500/5 text-amber-700">
          {workspaceStatusLabel("attention")}
        </Badge>
      )}
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
        disabled={busy}
      >
        <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
      </Button>
      <Button
        className="h-9 rounded-lg px-3"
        onClick={() => void onReview()}
        disabled={reviewDisabled}
      >
        <GitCompareArrows size={15} />
        {tr("workspace.reviewChanges")}
      </Button>
    </div>
  );
}

function workspaceStatusLabel(status: WorkspaceSummary["status"]) {
  return tr(`status.workspace.${status}`);
}

type Page = "overview" | "sessions" | "git" | "assets" | "context" | "doctor" | "changes";
const workspaceTaskEntries = [
  { page: "overview", label: "nav.overview", icon: LayoutDashboard },
  { page: "sessions", label: "nav.sessions", icon: MessageSquareText },
  { page: "assets", label: "nav.assets", icon: Boxes },
] as const;
const workspaceDevelopmentEntries = [
  { page: "git", label: "nav.git", icon: GitCommitHorizontal },
  { page: "context", label: "nav.context", icon: Code2 },
  { page: "doctor", label: "nav.doctor", icon: ShieldCheck },
] as const;

function WorkspaceLayout() {
  const { localizeMessage, tr } = useI18n();
  const navigate = useNavigate();
  const dialogs = useAppDialogs();
  const location = useLocation();
  const { workspaceId } = useParams({ from: "/workspace/$workspaceId" });
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
  const activeWorkspace =
    workspace ?? (selectedWorkspace?.id === workspaceId ? selectedWorkspace : undefined);
  const hasUnsavedDraft = Boolean(
    manifest && baselineManifest && JSON.stringify(manifest) !== baselineManifest,
  );
  const operationRequest = useRef(0);
  const loadStartedWorkspace = useRef<string | undefined>(undefined);

  const navigateWorkspace = (page: Page) => {
    if (useWorkspaceStore.getState().applyingChanges) {
      void dialogs.notify(tr("dialog.quit.changesApplying"));
      return;
    }
    const path =
      page === "overview" ? "/workspace/$workspaceId" : `/workspace/$workspaceId/${page}`;
    void navigate({
      to: path as never,
      params: { workspaceId } as never,
      search: (current) => workspaceSearchForPage(current as AppSearch, page) as never,
    });
  };
  const renderWorkspaceNavEntries = (
    entries: readonly { page: Page; label: string; icon: LucideIcon }[],
  ) =>
    entries.map(({ page, label, icon: Icon }) => (
      <Button
        key={page}
        variant="bare"
        size="content"
        className={cn(
          "h-9 gap-2 rounded-lg border border-transparent px-3 text-sm transition-colors",
          currentPage === page
            ? "border-primary/40 font-semibold text-primary shadow-sm"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        style={
          currentPage === page
            ? { backgroundColor: "color-mix(in srgb, var(--primary) 22%, var(--background))" }
            : undefined
        }
        aria-current={currentPage === page ? "page" : undefined}
        onClick={() => navigateWorkspace(page)}
      >
        <Icon size={15} />
        {tr(label)}
      </Button>
    ));
  const changeCount =
    workspaceState.changeSet?.changes.length ?? (workspaceState.handoffLaunchRequest ? 1 : 0);

  useEffect(() => {
    operationRequest.current += 1;
    loadStartedWorkspace.current = undefined;
    return () => {
      operationRequest.current += 1;
    };
  }, [workspaceId]);

  const loadWorkspace = async (draft?: Manifest) => {
    if (!project) return;
    const requestId = ++operationRequest.current;
    const targetProject = project;
    const isCurrentRequest = () =>
      requestId === operationRequest.current &&
      useWorkspaceStore.getState().selectedWorkspace?.id === workspaceId &&
      useWorkspaceStore.getState().project === targetProject;
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
            setMessage(localizeMessage(scanResult.reason));
            return;
          }
          if (runtimeResult.status === "rejected") {
            setMessage(localizeMessage(runtimeResult.reason));
            return;
          }
          const nextScan = scanResult.value;
          const nextManifest =
            manifestResult.status === "fulfilled" ? manifestResult.value : undefined;
          const resolvedManifest = draft ?? nextManifest;
          if (manifestResult.status === "rejected")
            setMessage(localizeMessage(manifestResult.reason));
          setScan(nextScan);
          setManifest(resolvedManifest);
          setBaselineManifest(nextManifest ? JSON.stringify(nextManifest) : "");
          setRuntime(runtimeResult.value);
          if (!resolvedManifest && currentPage !== "doctor") {
            void navigate({
              to: "/workspace/$workspaceId/doctor",
              params: { workspaceId },
            });
          }
        } catch (error) {
          if (isCurrentRequest()) setMessage(localizeMessage(error));
        }
      },
      () => {
        if (isCurrentRequest()) setBusy(false);
      },
    );
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
    if (!project || !manifest) return;
    const requestId = ++operationRequest.current;
    const targetProject = project;
    const targetManifest = manifest;
    const isCurrentRequest = () =>
      requestId === operationRequest.current &&
      useWorkspaceStore.getState().selectedWorkspace?.id === workspaceId &&
      useWorkspaceStore.getState().project === targetProject;
    setBusy(true);
    setMessage("");
    await withAsyncCleanup(
      async () => {
        try {
          const nextChangeSet = await api.plan(targetProject, targetManifest, includeHome);
          if (!isCurrentRequest()) return;
          setChangeSet(nextChangeSet);
          setChangeSetOrigin("standard");
          setHandoffLaunchRequest(undefined);
          void navigate({
            to: "/workspace/$workspaceId/changes",
            params: { workspaceId },
          });
        } catch (error) {
          if (isCurrentRequest()) setMessage(localizeMessage(error));
        }
      },
      () => {
        if (isCurrentRequest()) setBusy(false);
      },
    );
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
                variant={activeWorkspace.status === "attention" ? "destructive" : "outline"}
                className={
                  activeWorkspace.status === "healthy"
                    ? "border-transparent bg-muted text-muted-foreground"
                    : undefined
                }
              >
                {workspaceStatusLabel(activeWorkspace.status)}
              </Badge>
            </div>
            <code className="mt-1 block truncate text-xs text-muted-foreground">
              {activeWorkspace.path}
            </code>
          </div>
        </div>
        <WorkspaceActions
          workspace={activeWorkspace}
          onError={setMessage}
          onScan={() => loadWorkspace(manifest)}
          busy={busy}
          onReview={() => plan(false)}
          reviewDisabled={busy || !hasUnsavedDraft}
        />
      </section>
      <nav
        aria-label={tr("workspace.navigation")}
        className="flex flex-wrap items-start gap-x-6 gap-y-3 border-b border-border pb-4"
      >
        <div role="group" aria-label={tr("sidebar.tasks")} className="grid gap-1.5">
          <span className="px-3 text-sm font-semibold leading-5 text-foreground">
            {tr("sidebar.tasks")}
          </span>
          <div className="flex flex-wrap items-center gap-1">
            {renderWorkspaceNavEntries(workspaceTaskEntries)}
          </div>
        </div>
        <div
          role="group"
          aria-label={tr("sidebar.development")}
          className="grid gap-1.5 border-l border-border pl-5"
        >
          <span className="px-3 text-sm font-semibold leading-5 text-foreground">
            {tr("sidebar.development")}
          </span>
          <div className="flex flex-wrap items-center gap-1">
            {renderWorkspaceNavEntries(workspaceDevelopmentEntries)}
            {changeCount > 0 && (
              <Button
                variant="bare"
                size="content"
                className={cn(
                  "h-9 gap-2 rounded-lg border border-transparent px-3 text-sm transition-colors",
                  currentPage === "changes"
                    ? "border-primary/40 font-semibold text-primary shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                style={
                  currentPage === "changes"
                    ? {
                        backgroundColor:
                          "color-mix(in srgb, var(--primary) 22%, var(--background))",
                      }
                    : undefined
                }
                aria-current={currentPage === "changes" ? "page" : undefined}
                onClick={() => navigateWorkspace("changes")}
              >
                <GitCompareArrows size={15} />
                {tr("nav.changes")}
                <Badge variant="secondary" className="h-5 min-w-5 px-1 text-[10px]">
                  {changeCount}
                </Badge>
              </Button>
            )}
          </div>
        </div>
      </nav>
      <section className={cn("min-w-0", currentPage === "git" && "min-h-[calc(100vh-118px)]")}>
        {busy || (currentPage !== "doctor" && (!scan || !manifest)) ? (
          <WorkspacePageSkeleton page={currentPage} />
        ) : (
          <Outlet />
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

export const Route = createFileRoute("/workspace/$workspaceId")({ component: WorkspaceLayout });
