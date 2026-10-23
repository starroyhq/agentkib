import { useI18n } from "@/core/useI18n";
import { useRef, useState } from "react";
import { Check, ChevronRight, Circle, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/core/api";
import { AGENT_LABELS } from "@/core/agents";
import type {
  AgentInstallation,
  ContextDoctorSummary,
  MemoryRecord,
  OnboardingState,
  WorkspaceSummary,
} from "@/core/types";
import { getWorkspaceStatus } from "@/features/workspace/workspace-status";
import { withAsyncCleanup } from "@/lib/utils";
import { cn } from "cn";

export function GettingStartedCard({
  onboarding,
  workspaces,
  doctorSummaries,
  memories = [],
  installations = [],
  installationsPending = false,
  onRuntimeChanged,
  additionsBusy = false,
  onAddWorkspace,
  onAddRoot,
  onOpenDoctor,
}: {
  onboarding?: OnboardingState;
  workspaces: WorkspaceSummary[];
  doctorSummaries: Record<string, ContextDoctorSummary>;
  memories?: MemoryRecord[];
  installations?: AgentInstallation[];
  installationsPending?: boolean;
  onRuntimeChanged: (runtime: Awaited<ReturnType<typeof api.updateOnboarding>>) => void;
  additionsBusy?: boolean;
  onAddWorkspace: () => Promise<void>;
  onAddRoot: () => Promise<void>;
  onOpenDoctor: (workspace: WorkspaceSummary) => Promise<void>;
}) {
  const { tr, localizeMessage } = useI18n();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<{ reason: unknown }>();
  const errorMessage = error === undefined ? "" : localizeMessage(error.reason);
  if (!onboarding || onboarding.acknowledged_version >= onboarding.version) return null;

  const workspaceDone = workspaces.length > 0;
  const doctorDone = onboarding.doctor_completed;
  const repairDone = doctorDone && onboarding.repairable_count === 0;
  const attention = workspaces.filter(
    (workspace) =>
      getWorkspaceStatus(workspace.id, doctorSummaries[workspace.id], memories).state ===
      "attention",
  );
  const checkedCount = workspaces.filter((workspace) => doctorSummaries[workspace.id]).length;
  const selectedWorkspace = doctorDone
    ? (workspaces.find((workspace) => workspace.id === onboarding.workspace_id) ??
      attention[0] ??
      workspaces[0])
    : (attention[0] ?? workspaces[0]);
  const historyAgents = [
    ...new Set(
      workspaces
        .flatMap((workspace) => workspace.sources ?? [])
        .filter((source) => source.evidence === "session-cwd" && source.agent)
        .map((source) => AGENT_LABELS[source.agent!]),
    ),
  ];
  const discoveryResult = historyAgents.length
    ? tr("onboarding.discoveryHistoryResult", {
        count: workspaces.length,
        agents: historyAgents.join(" · "),
      })
    : tr("onboarding.discoveryResult", { count: workspaces.length });
  const actionLabel = !workspaceDone
    ? tr("onboarding.addWorkspace")
    : doctorDone && onboarding.repairable_count > 0
      ? tr("onboarding.reviewRepair")
      : attention.length > 0
        ? tr("onboarding.viewIssues")
        : tr("onboarding.viewResults");
  const currentStep = !workspaceDone ? 0 : !doctorDone ? 1 : !repairDone ? 2 : -1;

  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current || additionsBusy) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    await withAsyncCleanup(
      async () => {
        try {
          await operation();
        } catch (reason) {
          setError({ reason });
        }
      },
      () => {
        busyRef.current = false;
        setBusy(false);
      },
    );
  };

  const dismiss = () =>
    run(async () => onRuntimeChanged(await api.updateOnboarding({ event: "dismissed" })));
  const continueOnboarding = () =>
    run(async () => {
      if (!workspaceDone) await onAddWorkspace();
      else if (selectedWorkspace) await onOpenDoctor(selectedWorkspace);
    });

  return (
    <Card className="overflow-hidden rounded-2xl border-border bg-card shadow-sm">
      <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
        <div className="flex min-w-0 gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/8 text-primary">
            <ShieldCheck size={18} />
          </span>
          <div>
            <h2 className="text-base font-semibold tracking-[-.02em]">{tr("onboarding.title")}</h2>
            {!workspaceDone && (
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {tr("onboarding.readScope")}
              </p>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={tr("onboarding.dismiss")}
          disabled={busy || additionsBusy}
          onClick={() => void dismiss()}
        >
          <X size={15} />
        </Button>
      </div>
      <div className="grid items-center gap-4 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <ol className="grid gap-2 text-sm">
          <OnboardingStep
            done={workspaceDone}
            current={currentStep === 0}
            label={tr("onboarding.workspaceStep")}
            detail={workspaceDone ? discoveryResult : undefined}
          />
          <OnboardingStep
            done={doctorDone}
            current={currentStep === 1}
            label={tr("onboarding.checkResultsStep")}
            detail={
              workspaceDone
                ? attention.length > 0
                  ? tr("onboarding.checkedAttention", {
                      count: checkedCount,
                      attention: attention.length,
                    })
                  : checkedCount === workspaces.length
                    ? tr("onboarding.checkedHealthy", { count: checkedCount })
                    : tr("onboarding.checking", { count: checkedCount })
                : undefined
            }
          />
          <OnboardingStep
            done={repairDone}
            current={currentStep === 2}
            label={tr("onboarding.repairStep")}
          />
        </ol>
        <div className="grid gap-2 md:max-w-64">
          <Button
            disabled={busy || additionsBusy}
            aria-busy={busy || additionsBusy}
            onClick={() => void continueOnboarding()}
          >
            {actionLabel}
            <ChevronRight size={15} />
          </Button>
          {!workspaceDone && (
            <>
              <p className="text-xs leading-5 text-muted-foreground">
                {tr("home.addWorkspaceHint")}
              </p>
              <Button
                variant="outline"
                disabled={busy || additionsBusy}
                onClick={() => void run(onAddRoot)}
              >
                {tr("home.addScanRoot")}
              </Button>
              <p className="text-xs leading-5 text-muted-foreground">
                {tr("home.addScanRootHint")}
              </p>
            </>
          )}
        </div>
      </div>
      {!workspaceDone && (
        <div className="border-t border-border-subtle px-5 py-3 text-xs text-muted-foreground">
          {tr("onboarding.detectedAgents")}{" "}
          {installationsPending
            ? tr("common.loading")
            : installations
                .filter((installation) => installation.installed)
                .map((installation) => AGENT_LABELS[installation.agent])
                .join(" · ") || tr("common.none")}
        </div>
      )}
      {errorMessage && (
        <div
          role="alert"
          className="border-t border-destructive/20 bg-destructive/5 px-5 py-2.5 text-xs text-destructive-text"
        >
          {errorMessage}
        </div>
      )}
    </Card>
  );
}

function OnboardingStep({
  done,
  current,
  label,
  detail,
}: {
  done: boolean;
  current: boolean;
  label: string;
  detail?: string;
}) {
  const { tr } = useI18n();
  return (
    <li
      aria-current={current ? "step" : undefined}
      className={cn("flex items-start gap-2.5 rounded-lg px-3 py-2", current && "bg-primary/8")}
    >
      {done ? (
        <span className="grid size-5 place-items-center rounded-full bg-emerald-500/12 text-emerald-700">
          <Check size={13} />
        </span>
      ) : (
        <Circle
          size={18}
          className={cn(
            "mt-0.5 shrink-0",
            current ? "fill-primary/15 text-primary" : "text-muted-foreground/60",
          )}
        />
      )}
      <span className="min-w-0">
        <span className={done ? "text-muted-foreground" : "text-foreground"}>{label}</span>
        {current && (
          <span className="ml-3 text-xs font-medium text-primary-text">
            {tr("onboarding.currentStep")}
          </span>
        )}
        {detail && (
          <small
            className={cn(
              "mt-1 block text-xs leading-5",
              done ? "text-emerald-700" : "text-muted-foreground",
            )}
          >
            {detail}
          </small>
        )}
      </span>
    </li>
  );
}
