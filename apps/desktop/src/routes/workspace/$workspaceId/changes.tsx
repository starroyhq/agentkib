import { createFileRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { WorkspaceChangesSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { api } from "../../../core/api";
import { useWorkspaceStore, type ChangeSetOrigin } from "@/features/workspace/workspace-store";
import {
  changesReturnPage,
  hasActiveChangesFlow,
  type WorkspaceFlowPage,
} from "@/features/workspace/workspace-flow";
import { homeKeys } from "@/features/home/home-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { localizeMessage, tr } from "../../../core/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Brain,
  Check,
  CircleAlert,
  ExternalLink,
  FileCode2,
  GitCompareArrows,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { diffLines } from "@/features/workspace/diff";
import type { AgentKind, ChangeSet, SessionHandoffLaunchRequest } from "../../../core/types";
const agentLabels: Record<AgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  "open-claw": "OpenClaw",
  hermes: "Hermes",
  "grok-build": "Grok Build",
  "deepseek-harness": "DeepSeek Harness",
};
function Empty({
  icon: Icon,
  title,
  text,
  compact = false,
}: {
  icon: typeof Brain;
  title: string;
  text: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid min-h-[260px] place-content-center justify-items-center gap-1.5 p-[30px] text-center text-muted-foreground",
        compact &&
          "min-h-[92px] grid-cols-[auto_minmax(0,auto)] items-center gap-x-2.5 gap-y-1 p-4 text-left",
      )}
    >
      <Icon className={compact ? "row-span-2" : "mb-1.5"} size={28} />
      <h3 className="m-0 text-[13px] font-semibold text-foreground">{title}</h3>
      {text && <p className="m-0 max-w-[380px] leading-relaxed">{text}</p>}
    </div>
  );
}
function Diff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="overflow-auto rounded-lg border border-border bg-muted/30">
      {diffLines(before, after).map((line, index) => (
        <div
          className={cn(
            "grid grid-cols-[1.5rem_minmax(0,1fr)] px-3 py-0.5",
            line.type === "added" && "bg-emerald-50 text-emerald-800",
            line.type === "removed" && "bg-red-50 text-red-800",
          )}
          key={`${index}-${line.content}`}
        >
          <span>{line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}</span>
          {line.content || " "}
        </div>
      ))}
    </pre>
  );
}
function shortPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}
export function Changes({
  changeSet,
  origin,
  launchRequest,
  onPlanHome,
  onApplied,
  onLaunchCompleted,
  onRejected,
  onApplyingChange,
}: {
  changeSet?: ChangeSet;
  origin: ChangeSetOrigin;
  launchRequest?: SessionHandoffLaunchRequest;
  onPlanHome: () => void | Promise<void>;
  onApplied: (keepLaunchRequest?: boolean) => void | Promise<void>;
  onLaunchCompleted: () => void;
  onRejected: () => void;
  onApplyingChange: (applying: boolean) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [planningHome, setPlanningHome] = useState(false);
  const [error, setError] = useState("");
  const [homeApproved, setHomeApproved] = useState(false);
  const [appliedLaunchFailure, setAppliedLaunchFailure] = useState("");
  const applying = useRef(false);
  const active = useRef(true);
  const change = changeSet?.changes[selected];
  const launchSupported = launchRequest?.capabilities?.interactive_launch.status === "supported";
  const targetAgentName = launchRequest ? agentLabels[launchRequest.target_agent] : "";
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (changeSet) setAppliedLaunchFailure("");
  }, [changeSet?.id]);
  const runLocked = async (operation: () => Promise<void>) => {
    if (applying.current) return;
    applying.current = true;
    setBusy(true);
    setError("");
    onApplyingChange(true);
    try {
      await operation();
    } catch (value) {
      if (active.current) setError(localizeMessage(value));
    } finally {
      applying.current = false;
      onApplyingChange(false);
      if (active.current) setBusy(false);
    }
  };
  if (!changeSet && launchRequest && appliedLaunchFailure)
    return (
      <Card className="rounded-xl border border-border bg-card shadow-sm grid items-center gap-4 p-5 md:grid-cols-[auto_minmax(0,1fr)_auto]">
        <CircleAlert size={24} />
        <div>
          <h2>{tr("handoff.savedLaunchFailed")}</h2>
          <p>{error || appliedLaunchFailure}</p>
          <code>
            {launchRequest.mode === "native-session"
              ? shortPath(launchRequest.target_path)
              : `.agentkib/handoffs/${launchRequest.filename}`}
          </code>
        </div>
        <Button
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          disabled={busy}
          onClick={() =>
            void runLocked(async () => {
              await api.launchSessionHandoff(launchRequest);
              if (!active.current) return;
              setAppliedLaunchFailure("");
              onLaunchCompleted();
            })
          }
        >
          <ExternalLink size={15} />
          {tr(busy ? "handoff.opening" : "handoff.retryOpen", { agent: targetAgentName })}
        </Button>
      </Card>
    );
  if (!changeSet)
    return (
      <Empty
        compact
        icon={GitCompareArrows}
        title={tr("changes.empty")}
        text={tr("changes.emptyText")}
      />
    );
  const apply = async () => {
    await runLocked(async () => {
      await api.apply(changeSet, homeApproved);
      if (active.current) await onApplied(false);
    });
  };
  const applyAndContinue = async () => {
    if (!launchRequest || !launchSupported) return;
    await runLocked(async () => {
      const result = await api.continueSessionHandoff(changeSet, launchRequest, homeApproved);
      if (!active.current) return;
      if (result.status === "launched") {
        await onApplied(false);
      } else {
        setAppliedLaunchFailure(localizeMessage(result.error));
        await onApplied(true);
      }
    });
  };
  const planHome = async () => {
    if (busy || planningHome) return;
    setPlanningHome(true);
    try {
      await onPlanHome();
    } finally {
      if (active.current) setPlanningHome(false);
    }
  };
  const disabled =
    busy ||
    planningHome ||
    !changeSet.changes.length ||
    (changeSet.requires_home_approval && !homeApproved);
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(240px,.35fr)_minmax(0,1fr)]">
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4">
          <div>
            <h2>ChangeSet</h2>
            <p>
              {changeSet.id.slice(0, 8)} · {changeSet.changes.length} {tr("common.files")}
            </p>
          </div>
        </div>
        {origin === "handoff" && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700">
            <CircleAlert size={14} />
            {tr("handoff.changeSetWarning")}
          </div>
        )}
        {changeSet.changes.map((file, index) => (
          <Button
            variant="bare"
            size="content"
            key={file.target}
            className={index === selected ? "bg-muted text-foreground" : ""}
            onClick={() => setSelected(index)}
          >
            <FileCode2 size={16} />
            <div>
              <strong>{file.target.split("/").pop()}</strong>
              <span>{shortPath(file.target)}</span>
            </div>
            <span
              className={cn(
                "inline-flex items-center rounded-md px-2 py-1 text-xs font-medium",
                file.risk === "high"
                  ? "text-destructive"
                  : file.risk === "medium"
                    ? "text-amber-700"
                    : "text-muted-foreground",
              )}
            >
              {tr(`status.risk.${file.risk}`)}
            </span>
          </Button>
        ))}
        {origin === "standard" && (
          <div className="grid gap-2 border-t border-border p-4">
            <p>{tr("changes.homeQuestion")}</p>
            <Button
              className="border border-transparent bg-transparent text-foreground hover:bg-muted"
              onClick={() => void planHome()}
              disabled={busy || planningHome}
            >
              {tr("changes.includeHome")}
            </Button>
          </div>
        )}
        {changeSet.requires_home_approval && (
          <Label className="flex items-center gap-2 border-t border-border p-4 text-xs text-muted-foreground">
            <Checkbox checked={homeApproved} onCheckedChange={setHomeApproved} />
            {tr("changes.homeApproval")}
          </Label>
        )}
      </div>
      <div className="rounded-xl border border-border bg-card shadow-sm min-w-0">
        {change ? (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4">
              <div>
                <h2>{change.target.split("/").pop()}</h2>
                <p>
                  {change.target} · {tr(`status.scope.${change.scope}`)}
                </p>
              </div>
              <span
                className={cn(
                  "inline-flex items-center rounded-md px-2 py-1 text-xs font-medium",
                  change.risk === "high"
                    ? "text-destructive"
                    : change.risk === "medium"
                      ? "text-amber-700"
                      : "text-muted-foreground",
                )}
              >
                {tr(`status.risk.${change.risk}`)}
              </span>
            </div>
            <Diff before={change.before} after={change.after} />
          </>
        ) : (
          <Empty icon={Check} title={tr("changes.synced")} text={tr("changes.syncedText")} />
        )}
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4">
          <div>
            <ShieldCheck size={17} />
            <span>{tr("changes.hashValidation")}</span>
          </div>
          <div className="">
            <Button
              className="border border-transparent bg-transparent text-foreground hover:bg-muted"
              onClick={onRejected}
              disabled={busy}
            >
              {tr("changes.reject")}
            </Button>
            {origin === "handoff" && launchSupported && (
              <Button
                className="border border-transparent bg-transparent text-foreground hover:bg-muted"
                onClick={() => void apply()}
                disabled={disabled}
              >
                {tr("handoff.applyOnly")}
              </Button>
            )}
            <Button
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={() =>
                void (origin === "handoff" && launchSupported ? applyAndContinue() : apply())
              }
              disabled={disabled}
            >
              {origin === "handoff" && launchSupported ? (
                <>
                  <ExternalLink size={15} />
                  {tr(busy ? "changes.applying" : "handoff.applyAndContinue", {
                    agent: targetAgentName,
                  })}
                </>
              ) : (
                tr(busy ? "changes.applying" : "changes.apply", { count: changeSet.changes.length })
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkspaceChangesRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { workspaceId } = useParams({ from: "/workspace/$workspaceId/changes" });
  const search = useSearch({ strict: false });
  const {
    project,
    changeSet,
    changeSetOrigin,
    handoffLaunchRequest,
    manifest,
    setChangeSet,
    setHandoffLaunchRequest,
    setApplyingChanges,
    setScan,
    setManifest,
    setBaselineManifest,
    setProject,
    setMessage,
  } = useWorkspaceStore();
  const homePlanRequest = useRef(0);
  const reloadRequest = useRef(0);
  const activeFlow = hasActiveChangesFlow(changeSet, handoffLaunchRequest);
  const [enteredWithActiveFlow] = useState(activeFlow);
  const navigateTo = useCallback(
    (page: WorkspaceFlowPage, verification = false) => {
      const to =
        page === "overview" ? "/workspace/$workspaceId" : `/workspace/$workspaceId/${page}`;
      void navigate({
        to: to as never,
        params: { workspaceId } as never,
        replace: true,
        search:
          page === "doctor" && verification
            ? (current) => ({ ...current, doctorVerification: "applied" }) as never
            : undefined,
      });
    },
    [navigate, workspaceId],
  );
  const navigateToContinuation = useCallback(
    (autoPrepare: boolean) => {
      void navigate({
        to: "/workspace/$workspaceId/sessions",
        params: { workspaceId },
        replace: true,
        search: (current) => ({
          ...current,
          handoffSession: search.handoffSession,
          handoffTarget: search.handoffTarget,
          handoffBudget: search.handoffBudget,
          handoffFormat: search.handoffFormat,
          handoffResume: autoPrepare ? ("recheck" as const) : ("return" as const),
        }),
      });
    },
    [
      navigate,
      search.handoffBudget,
      search.handoffFormat,
      search.handoffSession,
      search.handoffTarget,
      workspaceId,
    ],
  );
  useEffect(
    () => () => {
      homePlanRequest.current += 1;
      reloadRequest.current += 1;
    },
    [workspaceId],
  );
  useEffect(() => {
    if (project && !enteredWithActiveFlow) navigateTo("overview");
  }, [enteredWithActiveFlow, navigateTo, project]);
  if (!project) return <WorkspaceChangesSkeleton />;
  if (!enteredWithActiveFlow) return <WorkspaceChangesSkeleton />;
  const planHome = async () => {
    if (!manifest) return;
    const requestId = ++homePlanRequest.current;
    const targetProject = project;
    const targetManifest = manifest;
    const isCurrentRequest = () =>
      requestId === homePlanRequest.current &&
      useWorkspaceStore.getState().selectedWorkspace?.id === workspaceId &&
      useWorkspaceStore.getState().project === targetProject;
    try {
      const nextChangeSet = await api.plan(targetProject, targetManifest, true);
      if (isCurrentRequest()) setChangeSet(nextChangeSet);
    } catch (error) {
      if (isCurrentRequest()) setMessage(localizeMessage(error));
    }
  };
  const reload = async () => {
    const requestId = ++reloadRequest.current;
    const targetProject = project;
    const isCurrentRequest = () =>
      requestId === reloadRequest.current &&
      useWorkspaceStore.getState().selectedWorkspace?.id === workspaceId &&
      useWorkspaceStore.getState().project === targetProject;
    const [scan, manifest, runtime] = await Promise.all([
      api.scan(targetProject),
      api.manifest(targetProject),
      api.runtime(),
    ]);
    if (!isCurrentRequest()) return undefined;
    setProject(targetProject);
    setScan(scan);
    setManifest(manifest);
    setBaselineManifest(JSON.stringify(manifest));
    return runtime;
  };
  return (
    <Changes
      changeSet={changeSet}
      origin={changeSetOrigin}
      launchRequest={handoffLaunchRequest}
      onPlanHome={() => void planHome()}
      onApplied={async (keepLaunchRequest) => {
        const targetProject = project;
        const appliedDoctorRepair = changeSetOrigin === "doctor";
        const appliedHandoffSetup = changeSetOrigin === "handoff-setup";
        const returnPage = changesReturnPage(changeSetOrigin);
        setChangeSet(undefined);
        if (!keepLaunchRequest) setHandoffLaunchRequest(undefined);
        if (appliedDoctorRepair) {
          try {
            await api.updateOnboarding({ event: "repair-applied", workspace_id: workspaceId });
          } catch (error) {
            setMessage(localizeMessage(error));
          }
        }
        try {
          const runtime = await reload();
          if (runtime) await queryClient.invalidateQueries({ queryKey: homeKeys.all });
        } catch (error) {
          if (
            useWorkspaceStore.getState().selectedWorkspace?.id === workspaceId &&
            useWorkspaceStore.getState().project === targetProject
          )
            setMessage(localizeMessage(error));
        } finally {
          if (!keepLaunchRequest) {
            if (appliedHandoffSetup) navigateToContinuation(true);
            else navigateTo(returnPage, appliedDoctorRepair);
          }
        }
      }}
      onLaunchCompleted={() => {
        setHandoffLaunchRequest(undefined);
        navigateTo("sessions");
      }}
      onRejected={() => {
        const returnPage = changesReturnPage(changeSetOrigin);
        setChangeSet(undefined);
        setHandoffLaunchRequest(undefined);
        if (changeSetOrigin === "handoff-setup") navigateToContinuation(false);
        else navigateTo(returnPage);
      }}
      onApplyingChange={setApplyingChanges}
    />
  );
}

export const Route = createFileRoute("/workspace/$workspaceId/changes")({
  component: WorkspaceChangesRoute,
});
