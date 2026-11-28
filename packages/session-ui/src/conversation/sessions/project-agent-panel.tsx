import {
  REMOTE_WORKER_ROLE_CONTRACT,
  type Access,
  type ProjectAgentLeadEligibility,
  type ProjectAgentState as ProjectAgent,
  type WebClient,
  type WorkerModelSettings,
  type WorkerRoleInput,
} from "@agentkib/web-client";
import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useDelayedBusy } from "../../delayed-busy";
import {
  projectAgentCopy,
  workerModelSummary,
  type ProjectAgentCopy,
} from "../../project-agent-copy";
import {
  extractProjectAgentFailure,
  projectAgentReasonPhrase,
  projectAgentReasonRetry,
  projectAgentRecoveryKind,
  type ProjectAgentFailure,
  type ProjectAgentRecoveryKind,
} from "../../project-agent-reasons";
import { useSessionPlatform } from "../../session-platform";
import { OperationCopy, OperationGroup, OperationRow, TOUCH_TARGET } from "./operation-layout";
import { WorkerRoleEditor } from "./worker-role-editor";

type ProjectAgentCommand = Parameters<WebClient["manageProjectAgent"]>[0];

export type ProjectAgentPanelClient = {
  projectAgent(sessionId: string): Promise<unknown>;
  manageProjectAgent(command: ProjectAgentCommand): Promise<unknown>;
};

function projectAgentOf(value: unknown): ProjectAgent | null | undefined {
  if (!value || typeof value !== "object" || !("lead" in value)) return undefined;
  const lead = value.lead as Partial<ProjectAgent> | null;
  if (lead === null) return null;
  if (!lead || typeof lead.paused !== "boolean" || !Array.isArray(lead.workers) || !lead.scope)
    return undefined;
  return lead as ProjectAgent;
}

function leadEligibilityOf(value: unknown): ProjectAgentLeadEligibility | undefined {
  if (!value || typeof value !== "object" || !("eligibility" in value)) return undefined;
  const candidate = (value as { eligibility?: unknown }).eligibility;
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Partial<ProjectAgentLeadEligibility>;
  if (!record.availability || typeof record.availability.available !== "boolean") return undefined;
  return record as ProjectAgentLeadEligibility;
}

const DEFAULT_STALL_MINUTES = 10;
const MIN_STALL_MINUTES = 3;
const MAX_STALL_MINUTES = 120;

function clampStallMinutes(value: string | number): number {
  const minutes = Math.trunc(Number(value)) || MIN_STALL_MINUTES;
  return Math.min(MAX_STALL_MINUTES, Math.max(MIN_STALL_MINUTES, minutes));
}

function StallThreshold({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | number;
  onChange?: (value: string) => void;
}) {
  const { Input } = useSessionPlatform().components;
  return (
    <OperationRow>
      <label className="grid gap-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Input
          type="number"
          min={MIN_STALL_MINUTES}
          max={MAX_STALL_MINUTES}
          step={1}
          value={value}
          disabled={!onChange}
          // A first digit below the minimum may start a valid value such as 10.
          onChange={(event) => onChange?.(event.target.value)}
          onBlur={() => onChange?.(String(clampStallMinutes(value)))}
        />
      </label>
    </OperationRow>
  );
}

function WorkerSettingsChip({
  locale,
  settings,
}: {
  locale: string;
  settings?: WorkerModelSettings;
}) {
  const summary = settings && workerModelSummary(locale, settings);
  return summary ? (
    <span className="mt-1 inline-flex max-w-full items-center rounded-md border border-border/65 bg-[var(--surface-subtle,var(--muted))] px-1.5 py-0.5 font-mono text-[11px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
      {summary}
    </span>
  ) : null;
}

function WorkerStatusIndicator({ status }: { status: string }) {
  const mark =
    status === "awaiting-approval" || status === "waiting-input" ? (
      <span
        data-worker-status-tone="waiting"
        className="inline-block size-2 rounded-full bg-amber-500"
      />
    ) : status === "running" || status === "starting" ? (
      <span
        data-worker-status-tone="running"
        className="inline-block size-2 animate-spin rounded-full border-[1.5px] border-primary border-t-transparent motion-reduce:animate-none"
      />
    ) : status === "unavailable" ? (
      <span
        data-worker-status-tone="unavailable"
        className="inline-block size-2 rounded-full bg-muted-foreground/70"
      />
    ) : null;
  return (
    <span
      aria-hidden="true"
      data-worker-status-slot=""
      className="mt-1.5 inline-grid size-2 shrink-0 place-items-center"
    >
      {mark}
    </span>
  );
}

function LeadStatusBadges({
  locale,
  copy,
  eligibility,
}: {
  locale: string;
  copy: ProjectAgentCopy;
  eligibility?: ProjectAgentLeadEligibility;
}) {
  if (!eligibility) return null;
  const toolsState =
    eligibility.toolsReady === true
      ? {
          attr: "ready",
          label: copy.toolsReady,
          tone: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        }
      : eligibility.toolsReady === false
        ? {
            attr: "not-ready",
            label: copy.toolsNotReady,
            tone: "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300",
          }
        : {
            attr: "unknown",
            label: copy.toolsUnknown,
            tone: "border-border/70 bg-muted/60 text-muted-foreground",
          };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {!eligibility.availability.available && (
        <span
          data-lead-availability-reason={eligibility.availability.reason}
          className="inline-flex items-center rounded-full border border-amber-500/35 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium leading-4 text-amber-800 dark:text-amber-300"
        >
          {projectAgentReasonPhrase(locale, eligibility.availability.reason)}
        </span>
      )}
      <span
        data-lead-tools-ready={toolsState.attr}
        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${toolsState.tone}`}
      >
        {toolsState.label}
      </span>
    </div>
  );
}

function RecoveryActionButton({
  recovery,
  copy,
  busy,
  touchTarget,
  onRefresh,
  onResume,
  onConnectTerminal,
  onOpenIntegrations,
  onOpenWorkspaces,
}: {
  recovery: ProjectAgentRecoveryKind;
  copy: ProjectAgentCopy;
  busy: boolean;
  touchTarget?: string;
  onRefresh: () => void;
  onResume?: () => void;
  onConnectTerminal?: () => void;
  onOpenIntegrations?: () => void;
  onOpenWorkspaces?: () => void;
}) {
  const { Button } = useSessionPlatform().components;
  if (recovery === "refresh") {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={touchTarget}
        disabled={busy}
        onClick={onRefresh}
      >
        {copy.refresh}
      </Button>
    );
  }
  if (recovery === "connect-terminal" && onConnectTerminal) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={touchTarget}
        disabled={busy}
        onClick={onConnectTerminal}
      >
        {copy.connectTerminal}
      </Button>
    );
  }
  if (recovery === "integrations" && onOpenIntegrations) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={touchTarget}
        disabled={busy}
        onClick={onOpenIntegrations}
      >
        {copy.openIntegrations}
      </Button>
    );
  }
  if (recovery === "workspaces" && onOpenWorkspaces) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={touchTarget}
        disabled={busy}
        onClick={onOpenWorkspaces}
      >
        {copy.openWorkspaces}
      </Button>
    );
  }
  if (recovery === "resume-delegation" && onResume) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={touchTarget}
        disabled={busy}
        onClick={onResume}
      >
        {copy.resume}
      </Button>
    );
  }
  return null;
}

/** Shows a Project Agent and its workers, with the controls offered on this platform. */
export function ProjectAgentPanel({
  locale,
  selected,
  choose,
  formatCatalogTime,
  client,
  device,
  providerDisabled = false,
  onConnectTerminal,
  onOpenIntegrations,
  onOpenWorkspaces,
}: {
  locale: string;
  selected: string;
  choose(sessionId: string): Promise<void> | void;
  formatCatalogTime(value: string): string;
  client: ProjectAgentPanelClient;
  device?: Access["device"];
  providerDisabled?: boolean;
  onConnectTerminal?: () => void;
  onOpenIntegrations?: () => void;
  onOpenWorkspaces?: () => void;
}) {
  const {
    kind,
    components: { Button, Input, NativeCheckbox },
  } = useSessionPlatform();
  const desktop = kind === "desktop";
  const touchTarget = desktop ? undefined : TOUCH_TARGET;
  const mutedButtonClass = desktop
    ? "text-muted-foreground"
    : `${TOUCH_TARGET} text-muted-foreground`;
  const text = projectAgentCopy(locale);
  const [agent, setAgent] = useState<ProjectAgent | null>();
  const [leadEligibility, setLeadEligibility] = useState<ProjectAgentLeadEligibility>();
  // Whether the host lets this session lead; older hosts do not say, and it is offered.
  const [capable, setCapable] = useState(true);
  // Setting one up, or changing what it may do: the same form.
  const [form, setForm] = useState<null | {
    mode: "designate" | "update";
    approveFiles: boolean;
    approveCommands: boolean;
    answers: boolean;
    maxAutoTurns: number;
    stallMinutes: string;
  }>(null);
  const [editingRoleWorkerId, setEditingRoleWorkerId] = useState<string | null>(null);
  const [busyOperation, setBusyOperation] = useState<ProjectAgentCommand["operation"]>();
  const busy = busyOperation !== undefined;
  const [releasing, setReleasing] = useState(false);
  // The worker, by session, whose letting go waits for a confirmation.
  const [removing, setRemoving] = useState<string | null>(null);
  const [failure, setFailure] = useState<ProjectAgentFailure | null>(null);
  const resumeBusy = !!agent?.paused && (agent.recovering === true || busyOperation === "resume");
  const showResumeSpinner = useDelayedBusy(resumeBusy);

  const applyStatus = useCallback((value: unknown) => {
    const nextLead = projectAgentOf(value);
    if (nextLead !== undefined) setAgent(nextLead);
    const eligibility = leadEligibilityOf(value);
    setLeadEligibility(eligibility);
    if (eligibility) {
      setCapable(eligibility.availability.available);
    } else {
      setCapable(
        !value || typeof value !== "object" || (value as { capable?: unknown }).capable !== false,
      );
    }
  }, []);

  const refreshStatus = useCallback(() => {
    if (!selected) return;
    void client.projectAgent(selected).then(applyStatus, () => undefined);
  }, [selected, client, applyStatus]);

  /** Resolves to whether the host did it; a refusal stays on screen with its reason. */
  const run = useCallback(
    (params: Omit<ProjectAgentCommand, "sessionId">): Promise<boolean> => {
      if (!selected) return Promise.resolve(false);
      setBusyOperation(params.operation);
      setFailure(null);
      return client
        .manageProjectAgent({ ...params, sessionId: selected })
        .then(
          (value) => {
            applyStatus(value);
            return true;
          },
          (error: unknown) => {
            const parsed = extractProjectAgentFailure(error, locale);
            setFailure(parsed);
            if (parsed.outcomeUnknown) refreshStatus();
            return false;
          },
        )
        .finally(() => setBusyOperation(undefined));
    },
    [selected, locale, client, applyStatus, refreshStatus],
  );

  useEffect(() => {
    if (!selected) return;
    let live = true;
    const read = () =>
      void client.projectAgent(selected).then(
        (value) => {
          if (!live) return;
          applyStatus(value);
        },
        () => undefined,
      );
    read();
    // Workers change on their own; the panel is open only for a while.
    const timer = setInterval(read, 5_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selected, client, applyStatus]);

  // Desktop only mounts this panel for a user with local manage access.
  const full = device?.accessMode === "full";
  const mayLead = full && !!device?.send && !!device.manage && !!device.advancedControl;
  const leadAvailable = leadEligibility ? leadEligibility.availability.available : capable;
  const leadUnavailableReason =
    leadEligibility && !leadEligibility.availability.available
      ? leadEligibility.availability.reason
      : undefined;
  const designateBlocked = !mayLead || !leadAvailable;
  if (agent === undefined || !selected || (desktop && agent === null)) return null;
  const mayApprove = desktop || !!device?.approve;
  // Changing settings or resuming delegation takes the same permissions as setting it up.
  const mayTakeOver = desktop || (mayLead && (!agent?.scope.approvals?.length || mayApprove));
  const supportsRoleEditing =
    agent !== null &&
    (agent.roleChanges !== undefined || agent.workers.some((worker) => worker.role !== undefined));
  const editingRoleWorker = editingRoleWorkerId
    ? agent?.workers.find((worker) => worker.sessionId === editingRoleWorkerId)
    : undefined;

  const renderFailure = (currentFailure: ProjectAgentFailure | null) => {
    if (!currentFailure) return null;
    const resumeHandler =
      agent?.paused && (mayTakeOver || desktop)
        ? () => void run({ operation: "resume" })
        : undefined;
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive-text">
        <span>{currentFailure.phrase}</span>
        <RecoveryActionButton
          recovery={currentFailure.recovery}
          copy={text}
          busy={busy}
          touchTarget={touchTarget}
          onRefresh={() => {
            setFailure(null);
            refreshStatus();
          }}
          onResume={resumeHandler}
          onConnectTerminal={desktop ? onConnectTerminal : undefined}
          onOpenIntegrations={desktop ? onOpenIntegrations : undefined}
          onOpenWorkspaces={desktop ? onOpenWorkspaces : undefined}
        />
      </div>
    );
  };

  const formOf = (mode: "designate" | "update", scope?: ProjectAgent["scope"]) => ({
    mode,
    approveFiles: scope?.approvals?.includes("file-change") ?? false,
    approveCommands: scope?.approvals?.includes("command") ?? false,
    answers: scope?.answers ?? false,
    maxAutoTurns: desktop && scope ? scope.maxAutoTurns : (scope?.maxAutoTurns ?? 25),
    stallMinutes: String(scope?.stallMinutes ?? DEFAULT_STALL_MINUTES),
  });

  if (editingRoleWorker && supportsRoleEditing) {
    const canEditRole = !providerDisabled && mayTakeOver;
    return (
      <WorkerRoleEditor
        key={editingRoleWorker.sessionId}
        locale={locale}
        copy={text}
        workerName={editingRoleWorker.name}
        currentRole={editingRoleWorker.role}
        editable={canEditRole}
        busy={busy}
        touchTarget={touchTarget}
        errorNotice={renderFailure(failure)}
        onSave={(role: WorkerRoleInput) =>
          run({
            operation: REMOTE_WORKER_ROLE_CONTRACT.operation,
            worker: editingRoleWorker.sessionId,
            role,
          })
        }
        onClear={() =>
          run({
            operation: REMOTE_WORKER_ROLE_CONTRACT.operation,
            worker: editingRoleWorker.sessionId,
            role: null,
          })
        }
        onCancel={() => {
          setFailure(null);
          setEditingRoleWorkerId(null);
        }}
      />
    );
  }

  if (form) {
    const mayEdit =
      !providerDisabled && (form.mode === "designate" ? !designateBlocked : mayTakeOver);
    return (
      <OperationGroup title={text.title}>
        <OperationRow className="block">
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-xs text-muted-foreground">{text.decides}</legend>
            {(
              [
                ["approveFiles", text.approveFiles],
                ["approveCommands", text.approveCommands],
                ["answers", text.answers],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2">
                <NativeCheckbox
                  checked={form[key]}
                  // Deciding approvals for workers takes a device that may approve them.
                  disabled={key !== "answers" && !mayApprove}
                  onChange={(event) => setForm({ ...form, [key]: event.target.checked })}
                />
                <span>{label}</span>
              </label>
            ))}
            <p className="text-xs leading-5 text-muted-foreground">{text.decidesNote}</p>
          </fieldset>
        </OperationRow>
        <OperationRow>
          <label className="grid gap-1.5">
            <span className="text-xs text-muted-foreground">{text.maxAutoTurns}</span>
            <Input
              type="number"
              min={1}
              max={100}
              value={form.maxAutoTurns}
              onChange={(event) =>
                setForm({
                  ...form,
                  maxAutoTurns: Math.min(
                    100,
                    Math.max(1, Math.trunc(Number(event.target.value)) || 1),
                  ),
                })
              }
            />
          </label>
        </OperationRow>
        <StallThreshold
          label={text.stallMinutes}
          value={form.stallMinutes}
          onChange={mayEdit ? (stallMinutes) => setForm({ ...form, stallMinutes }) : undefined}
        />
        <OperationRow className="flex-wrap justify-end gap-2">
          {failure && <div className="mr-auto min-w-0">{renderFailure(failure)}</div>}
          <Button
            variant="outline"
            className={touchTarget}
            onClick={() => {
              setFailure(null);
              setForm(null);
            }}
          >
            {text.cancel}
          </Button>
          <Button
            className={touchTarget}
            disabled={busy || !mayEdit}
            onClick={() => {
              if (busy || !mayEdit) return;
              void run({
                operation: form.mode,
                scope: {
                  maxAutoTurns: form.maxAutoTurns,
                  stallMinutes: clampStallMinutes(form.stallMinutes),
                  approvals: [
                    ...(form.approveFiles ? ["file-change"] : []),
                    ...(form.approveCommands ? ["command"] : []),
                  ],
                  answers: form.answers,
                },
              }).then((done) => done && setForm(null));
            }}
          >
            {form.mode === "designate" ? text.confirm : text.save}
          </Button>
        </OperationRow>
      </OperationGroup>
    );
  }

  if (agent === null) {
    const leadRecovery = leadUnavailableReason
      ? projectAgentRecoveryKind(
          leadUnavailableReason,
          projectAgentReasonRetry(leadUnavailableReason),
        )
      : "none";
    // Only a device that may do what a Project Agent does in its name sets one up.
    return (
      <OperationGroup title={text.title}>
        <OperationRow className="flex-wrap">
          {!providerDisabled && !designateBlocked && (
            <OperationCopy className="basis-64">
              {text.hint}
              <LeadStatusBadges locale={locale} copy={text} eligibility={leadEligibility} />
            </OperationCopy>
          )}
          {designateBlocked && leadEligibility && (
            <div className="min-w-0 flex-1 basis-52">
              <LeadStatusBadges locale={locale} copy={text} eligibility={leadEligibility} />
            </div>
          )}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {leadRecovery !== "none" && (
              <RecoveryActionButton
                recovery={leadRecovery}
                copy={text}
                busy={busy}
                touchTarget={touchTarget}
                onRefresh={refreshStatus}
                onConnectTerminal={desktop ? onConnectTerminal : undefined}
                onOpenIntegrations={desktop ? onOpenIntegrations : undefined}
                onOpenWorkspaces={desktop ? onOpenWorkspaces : undefined}
              />
            )}
            <Button
              variant="outline"
              className={touchTarget}
              disabled={providerDisabled || designateBlocked}
              onClick={() => !providerDisabled && !designateBlocked && setForm(formOf("designate"))}
            >
              {text.designate}
            </Button>
          </div>
        </OperationRow>
      </OperationGroup>
    );
  }

  const decided = [
    ...(agent.scope.approvals?.includes("file-change") ? [text.approveFiles] : []),
    ...(agent.scope.approvals?.includes("command") ? [text.approveCommands] : []),
    ...(agent.scope.answers ? [text.answers] : []),
  ];
  const recovering = agent.paused && agent.recovering === true;
  const mayToggle = agent.paused ? mayTakeOver : desktop || (full && !!device?.send);
  const mayRelease = desktop || (full && !!device?.manage);
  const mayStop = desktop || (full && !!device?.send);
  const workerNames = new Map(agent.workers.map((worker) => [worker.sessionId, worker.name]));
  const roleChanges = agent.roleChanges ? [...agent.roleChanges].reverse() : [];

  return (
    <OperationGroup title={text.title}>
      <OperationRow>
        <OperationCopy title={text.summary(agent.workers.length, agent.pendingReports)}>
          <LeadStatusBadges locale={locale} copy={text} eligibility={leadEligibility} />
          {decided.length > 0 && <p>{text.decided(decided)}</p>}
          {agent.paused && !recovering ? (
            !agent.reason || agent.reason === "user-paused" ? (
              <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs">
                {text.pausedBadge}
              </span>
            ) : (
              <p className="text-amber-700 dark:text-amber-300">
                {text.paused[agent.reason] ?? text.paused["user-paused"]}
              </p>
            )
          ) : null}
          {!recovering && !agent.workers.length && <p>{text.none}</p>}
        </OperationCopy>
      </OperationRow>
      {!mayTakeOver && (
        <StallThreshold
          label={text.stallMinutes}
          value={agent.scope.stallMinutes ?? DEFAULT_STALL_MINUTES}
        />
      )}
      {agent.workers.map((worker) => {
        const stopAction =
          worker.eligibility?.actions && "stop" in worker.eligibility.actions
            ? worker.eligibility.actions.stop
            : undefined;
        const showStop =
          mayStop &&
          (worker.stopEnabled === true ||
            (worker.stopEnabled === undefined && stopAction !== undefined));
        const stopDisabled =
          busy || providerDisabled || (stopAction !== undefined && stopAction !== true);
        const workerUnavailable =
          worker.eligibility && !worker.eligibility.availability.available
            ? projectAgentReasonPhrase(locale, worker.eligibility.availability.reason)
            : undefined;
        const executionBadge =
          worker.eligibility?.executionSide === "terminal"
            ? text.executionTerminal
            : worker.eligibility?.executionSide === "external"
              ? text.executionExternal
              : undefined;
        return removing === worker.sessionId ? (
          <OperationRow key={worker.sessionId} className="flex-wrap gap-2">
            <p className="min-w-0 flex-1 basis-full text-xs leading-5">
              {text.removeConfirm(worker.name)}
            </p>
            <Button
              variant="destructive"
              size="sm"
              className={touchTarget}
              disabled={busy}
              onClick={() =>
                void run({ operation: "remove-worker", worker: worker.sessionId }).then(
                  (done) => done && setRemoving(null),
                )
              }
            >
              {text.removeWorker}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className={touchTarget}
              onClick={() => setRemoving(null)}
            >
              {text.cancel}
            </Button>
          </OperationRow>
        ) : (
          <OperationRow key={worker.sessionId} className="items-start">
            <WorkerStatusIndicator status={worker.status} />
            <div className="min-w-0 flex-1 space-y-0.5 text-xs leading-5 text-muted-foreground">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="text-sm leading-5 font-medium text-foreground">
                  {`${worker.name} · ${text.status[worker.status] ?? text.status.unavailable}`}
                </p>
                {worker.role?.label && (
                  <span
                    data-worker-role-badge=""
                    className="inline-flex max-w-44 items-center truncate rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium leading-4 text-primary-text"
                  >
                    {worker.role.label}
                  </span>
                )}
                {executionBadge && (
                  <span className="inline-flex items-center rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] leading-4 text-muted-foreground">
                    {executionBadge}
                  </span>
                )}
                {workerUnavailable && (
                  <span
                    data-worker-availability-reason=""
                    className="inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium leading-4 text-amber-800 dark:text-amber-300"
                  >
                    {workerUnavailable}
                  </span>
                )}
              </div>
              {(worker.title || worker.lastReportAt) && (
                <p className="truncate">
                  {[
                    worker.title,
                    worker.lastReportAt
                      ? text.reported(formatCatalogTime(worker.lastReportAt))
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              <WorkerSettingsChip locale={locale} settings={worker.settings} />
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {showStop && (
                <Button
                  variant="outline"
                  size="sm"
                  className={touchTarget}
                  disabled={stopDisabled}
                  onClick={() => void run({ operation: "stop-worker", worker: worker.sessionId })}
                >
                  {text.stopWorker}
                </Button>
              )}
              {supportsRoleEditing && mayTakeOver && (
                <Button
                  variant="outline"
                  size="sm"
                  className={touchTarget}
                  disabled={busy || providerDisabled}
                  onClick={() => {
                    setFailure(null);
                    setRemoving(null);
                    setEditingRoleWorkerId(worker.sessionId);
                  }}
                >
                  {text.roleEdit}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className={touchTarget}
                onClick={() => void choose(worker.sessionId)}
              >
                {text.open}
              </Button>
              {mayRelease && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={mutedButtonClass}
                  onClick={() => setRemoving(worker.sessionId)}
                >
                  {text.removeWorker}
                </Button>
              )}
            </div>
          </OperationRow>
        );
      })}
      {roleChanges.length > 0 && (
        <OperationRow className="block">
          <div data-role-changes="" className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{text.roleChangesTitle}</p>
            <ul className="space-y-1 text-xs leading-5 text-muted-foreground">
              {roleChanges.map((change, index) => {
                const actor =
                  change.updatedBy === "project-agent"
                    ? text.roleActorProjectAgent
                    : text.roleActorUser;
                const workerName =
                  workerNames.get(change.workerSessionId) ?? change.workerSessionId;
                const summary =
                  change.roleLabel !== null
                    ? text.roleChangedSet(actor, workerName, change.roleLabel)
                    : text.roleChangedCleared(actor, workerName);
                return (
                  <li
                    key={`${change.workerSessionId}:${change.updatedAt}:${index}`}
                    className="flex items-baseline justify-between gap-2"
                  >
                    <span className="min-w-0 break-words text-foreground/90">{summary}</span>
                    <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
                      {formatCatalogTime(change.updatedAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </OperationRow>
      )}
      {(releasing || mayToggle || mayTakeOver || mayRelease || failure) && (
        <OperationRow className="flex-wrap gap-2">
          {releasing ? (
            <>
              <p className="min-w-0 flex-1 basis-full text-xs leading-5">{text.releaseConfirm}</p>
              <Button
                variant="destructive"
                className={touchTarget}
                disabled={busy}
                onClick={() =>
                  void run({ operation: "release" }).then((done) => done && setReleasing(false))
                }
              >
                {text.release}
              </Button>
              <Button variant="outline" className={touchTarget} onClick={() => setReleasing(false)}>
                {text.cancel}
              </Button>
            </>
          ) : (
            <>
              {mayToggle && (
                <Button
                  variant="outline"
                  className={touchTarget}
                  disabled={busy || recovering || providerDisabled}
                  aria-busy={resumeBusy}
                  onClick={() => void run({ operation: agent.paused ? "resume" : "pause" })}
                >
                  <span className="inline-grid place-items-center">
                    <span
                      className={`col-start-1 row-start-1${showResumeSpinner ? " opacity-0" : ""}`}
                    >
                      {agent.paused ? text.resume : text.pause}
                    </span>
                    {showResumeSpinner && (
                      <span
                        className="col-start-1 row-start-1 grid place-items-center"
                        aria-hidden="true"
                      >
                        <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
                      </span>
                    )}
                  </span>
                </Button>
              )}
              {mayTakeOver && (
                <Button
                  variant="outline"
                  className={touchTarget}
                  disabled={providerDisabled}
                  onClick={() => {
                    setFailure(null);
                    setRemoving(null);
                    setForm(formOf("update", agent.scope));
                  }}
                >
                  {text.edit}
                </Button>
              )}
              {mayRelease && (
                <Button
                  variant="ghost"
                  className={mutedButtonClass}
                  onClick={() => setReleasing(true)}
                >
                  {text.release}
                </Button>
              )}
            </>
          )}
          {failure && <div className="basis-full">{renderFailure(failure)}</div>}
        </OperationRow>
      )}
    </OperationGroup>
  );
}
