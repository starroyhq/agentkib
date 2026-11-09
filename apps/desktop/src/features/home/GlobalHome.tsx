import { useI18n } from "@/core/useI18n";
import { useRef, useState, type ComponentProps } from "react";
import { FolderGit2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import type {
  AgentInstallation,
  ContextDoctorSummary,
  MemoryRecord,
  RuntimeInfo,
  WorkspaceSummary,
} from "@/core/types";
import { GettingStartedCard } from "./GettingStartedCard";
import { HomeSessions } from "./HomeSessions";
import { WorkspaceAddActions } from "./WorkspaceAddActions";

export function GlobalHome({
  workspaces,
  doctorSummaries,
  installations,
  memories,
  installationsPending = false,
  sessions,
  onOpenDoctor,
  onAddWorkspace,
  onAddRoot,
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
  onOpenDoctor: (workspace: WorkspaceSummary) => Promise<void>;
  onAddWorkspace: () => Promise<void>;
  onAddRoot: () => Promise<void>;
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
  const showOnboarding = Boolean(
    onboarding && onboarding.acknowledged_version < onboarding.version,
  );

  return (
    <div className="grid gap-6">
      {showOnboarding && (
        <GettingStartedCard
          onboarding={runtime?.onboarding}
          workspaces={workspaces}
          doctorSummaries={doctorSummaries}
          memories={memories}
          installations={installations}
          installationsPending={installationsPending}
          onRuntimeChanged={onRuntimeChanged}
          additionsBusy={adding}
          onAddWorkspace={addWorkspace}
          onAddRoot={addRoot}
          onOpenDoctor={onOpenDoctor}
        />
      )}

      {addError && (
        <p role="alert" className="text-sm text-destructive-text">
          {localizeMessage(addError.reason)}
        </p>
      )}

      {!workspaces.length ? (
        showOnboarding ? (
          <p className="text-sm leading-6 text-muted-foreground">{tr("home.emptySummary")}</p>
        ) : (
          <Card className="grid min-h-[260px] place-content-center justify-items-center gap-3 rounded-xl border-dashed bg-card p-8 text-center shadow-none">
            <span className="grid size-12 place-items-center rounded-xl bg-primary/8 text-primary">
              <FolderGit2 size={24} />
            </span>
            <h2 className="text-lg font-semibold tracking-[-.02em]">{tr("home.emptyTitle")}</h2>
            <p className="max-w-md text-sm leading-6 text-muted-foreground">
              {tr("home.emptyText")}
            </p>
            <WorkspaceAddActions busy={adding} onAddWorkspace={addWorkspace} onAddRoot={addRoot} />
          </Card>
        )
      ) : (
        <HomeSessions {...sessions} workspaces={workspaces} />
      )}
    </div>
  );
}
