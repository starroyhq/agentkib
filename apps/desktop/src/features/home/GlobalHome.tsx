import { useI18n } from "@/core/useI18n";
import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { FolderGit2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import type {
  AgentInstallation,
  ContextDoctorSummary,
  MemoryRecord,
  RuntimeInfo,
  WorkspaceSummary,
} from "@/core/types";
import { cn } from "cn";
import { GettingStartedCard } from "./GettingStartedCard";
import { HomeSessions } from "./HomeSessions";
import { HomeSide, hasHomeSide, type HomeSideProps } from "./HomeSide";
import { useOnboardingDismissedLocally } from "./onboarding-preference";
import { WorkspaceAddActions } from "./WorkspaceAddActions";

export function GlobalHome({
  workspaces,
  doctorSummaries,
  installations,
  memories,
  installationsPending = false,
  sessions,
  newSession,
  interruptedWork,
  side,
  onOpenDoctor,
  onAddWorkspace,
  onAddRoot,
  onNewSession,
  onOpenProjectAgent,
  runtime,
  onRuntimeChanged,
}: {
  workspaces: WorkspaceSummary[];
  doctorSummaries: Record<string, ContextDoctorSummary>;
  installations: AgentInstallation[];
  memories: MemoryRecord[];
  installationsPending?: boolean;
  /** The session groups; the home shows them once a workspace exists. */
  sessions: Omit<ComponentProps<typeof HomeSessions>, "workspaces">;
  /** The new-session composer, above the sessions once a workspace exists. */
  newSession?: ReactNode;
  interruptedWork?: ReactNode;
  /** Quota, remote and upkeep beside the sessions; below them in a narrow window. */
  side?: HomeSideProps;
  onOpenDoctor?: (workspace: WorkspaceSummary) => Promise<void>;
  onAddWorkspace: () => Promise<void>;
  onAddRoot: () => Promise<void>;
  onNewSession?: () => void;
  onOpenProjectAgent?: () => void;
  runtime?: RuntimeInfo;
  onRuntimeChanged: (runtime: RuntimeInfo) => void;
}) {
  const { tr, localizeMessage } = useI18n();
  const addLock = useRef(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<{ reason: unknown }>();
  const runAdd = async (operation: () => Promise<void>) => {
    if (addLock.current) return;
    addLock.current = true;
    setAdding(true);
    setAddError(undefined);
    try {
      await operation();
    } catch (reason) {
      setAddError({ reason });
    } finally {
      addLock.current = false;
      setAdding(false);
    }
  };
  const addWorkspace = () => runAdd(onAddWorkspace);
  const addRoot = () => runAdd(onAddRoot);
  const onboarding = runtime?.onboarding;
  const dismissedLocally = useOnboardingDismissedLocally(onboarding?.version);
  const showOnboarding = Boolean(
    onboarding && onboarding.acknowledged_version < onboarding.version && !dismissedLocally,
  );

  return (
    <div className="grid gap-6">
      {showOnboarding && (
        <GettingStartedCard
          onboarding={runtime?.onboarding}
          workspaces={workspaces}
          sessions={sessions.sessions}
          doctorSummaries={doctorSummaries}
          memories={memories}
          installations={installations}
          installationsPending={installationsPending}
          remoteConnected={Boolean(side?.remote && side.remote.devices > 0)}
          onRuntimeChanged={onRuntimeChanged}
          additionsBusy={adding}
          onAddWorkspace={addWorkspace}
          onAddRoot={addRoot}
          onOpenDoctor={onOpenDoctor}
          onResumeSession={sessions.onOpen}
          onNewSession={onNewSession}
          onOpenRemote={side?.onOpenRemote}
          onOpenProjectAgent={onOpenProjectAgent ?? sessions.onShowAll}
        />
      )}

      {addError && (
        <p role="alert" className="text-sm text-destructive-text">
          {localizeMessage(addError.reason)}
        </p>
      )}

      {interruptedWork}

      {!workspaces.length && !showOnboarding && (
        <Card className="grid min-h-[260px] place-content-center justify-items-center gap-3 rounded-xl border-dashed border-border/80 bg-card p-8 text-center shadow-none">
          <span className="grid size-12 place-items-center rounded-xl border border-border/60 bg-[var(--surface-subtle,var(--muted))] text-primary">
            <FolderGit2 size={24} />
          </span>
          <h2 className="text-base font-semibold tracking-[-.02em]">{tr("home.emptyTitle")}</h2>
          <p className="max-w-md text-sm leading-6 text-muted-foreground">{tr("home.emptyText")}</p>
          <WorkspaceAddActions busy={adding} onAddWorkspace={addWorkspace} onAddRoot={addRoot} />
        </Card>
      )}

      {workspaces.length > 0 && !showOnboarding && (
        <div
          className={cn(
            "grid gap-6",
            side && hasHomeSide(side) && "lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start",
          )}
        >
          <div className="grid min-w-0 gap-6">
            {newSession}
            <HomeSessions {...sessions} workspaces={workspaces} />
          </div>
          {side && <HomeSide {...side} />}
        </div>
      )}
    </div>
  );
}
