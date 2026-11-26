import type { Access, ProjectAgentState as ProjectAgent, WebClient } from "@agentkib/web-client";
import { useCallback, useEffect, useState } from "react";
import { DelayedSpinner } from "../../loading-feedback";
import { projectAgentCopy } from "../../project-agent-copy";
import { useSessionPlatform } from "../../session-platform";
import { OperationCopy, OperationGroup, OperationRow, TOUCH_TARGET } from "./operation-layout";

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

/** Shows a Project Agent and its workers, with the controls offered on this platform. */
export function ProjectAgentPanel({
  locale,
  selected,
  choose,
  formatCatalogTime,
  client,
  device,
  providerDisabled = false,
}: {
  locale: string;
  selected: string;
  choose(sessionId: string): Promise<void> | void;
  formatCatalogTime(value: string): string;
  client: ProjectAgentPanelClient;
  device?: Access["device"];
  providerDisabled?: boolean;
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
  const [busyOperation, setBusyOperation] = useState<ProjectAgentCommand["operation"]>();
  const busy = busyOperation !== undefined;
  const [releasing, setReleasing] = useState(false);
  // The worker, by session, whose letting go waits for a confirmation.
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Resolves to whether the host did it; a refusal stays on screen with its reason. */
  const run = useCallback(
    (params: Omit<ProjectAgentCommand, "sessionId">): Promise<boolean> => {
      if (!selected) return Promise.resolve(false);
      setBusyOperation(params.operation);
      setError(null);
      return client
        .manageProjectAgent({ ...params, sessionId: selected })
        .then(
          (value) => {
            const next = projectAgentOf(value);
            if (next !== undefined) setAgent(next);
            return true;
          },
          (failure: unknown) => {
            const code = failure instanceof Error ? failure.message : "";
            setError(Object.keys(text.errors).find((key) => code.includes(key)) ?? "failed");
            return false;
          },
        )
        .finally(() => setBusyOperation(undefined));
    },
    [selected, text.errors, client],
  );

  useEffect(() => {
    if (!selected) return;
    let live = true;
    const read = () =>
      void client.projectAgent(selected).then(
        (value) => {
          if (!live) return;
          setAgent(projectAgentOf(value));
          setCapable(
            !value ||
              typeof value !== "object" ||
              (value as { capable?: unknown }).capable !== false,
          );
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
  }, [selected, client]);

  // Desktop only mounts this panel for a user with local manage access.
  const full = device?.accessMode === "full";
  const mayLead = full && !!device?.send && !!device.manage && !!device.advancedControl;
  const designateBlocked = !mayLead
    ? text.designatePermission
    : !capable
      ? text.errors["lead-requires-managed-claude"]
      : undefined;
  if (agent === undefined || !selected || (desktop && agent === null)) return null;
  const mayApprove = desktop || !!device?.approve;
  // Changing settings or resuming delegation takes the same permissions as setting it up.
  const mayTakeOver = desktop || (mayLead && (!agent?.scope.approvals?.length || mayApprove));
  const errorText = error ? (text.errors[error] ?? text.failed) : null;
  const formOf = (mode: "designate" | "update", scope?: ProjectAgent["scope"]) => ({
    mode,
    approveFiles: scope?.approvals?.includes("file-change") ?? false,
    approveCommands: scope?.approvals?.includes("command") ?? false,
    answers: scope?.answers ?? false,
    maxAutoTurns: desktop && scope ? scope.maxAutoTurns : (scope?.maxAutoTurns ?? 25),
    stallMinutes: String(scope?.stallMinutes ?? DEFAULT_STALL_MINUTES),
  });

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
          {errorText && (
            <p className="mr-auto min-w-0 text-xs text-destructive-text">{errorText}</p>
          )}
          <Button variant="outline" className={touchTarget} onClick={() => setForm(null)}>
            {text.cancel}
          </Button>
          <Button
            className={`${touchTarget ?? ""} disabled:pointer-events-auto`}
            disabled={busy || !mayEdit}
            title={form.mode === "designate" ? designateBlocked : undefined}
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

  if (agent === null)
    // Only a device that may do what a Project Agent does in its name sets one up.
    return (
      <OperationGroup title={text.title}>
        <OperationRow className="flex-wrap">
          {!providerDisabled && !designateBlocked && (
            <OperationCopy className="basis-64">{text.hint}</OperationCopy>
          )}
          <Button
            variant="outline"
            className={`${touchTarget ?? ""} disabled:pointer-events-auto`}
            disabled={providerDisabled || !!designateBlocked}
            title={providerDisabled ? undefined : designateBlocked}
            onClick={() => !providerDisabled && !designateBlocked && setForm(formOf("designate"))}
          >
            {text.designate}
          </Button>
        </OperationRow>
      </OperationGroup>
    );

  const decided = [
    ...(agent.scope.approvals?.includes("file-change") ? [text.approveFiles] : []),
    ...(agent.scope.approvals?.includes("command") ? [text.approveCommands] : []),
    ...(agent.scope.answers ? [text.answers] : []),
  ];
  const recovering = agent.paused && agent.recovering === true;
  const mayToggle = agent.paused ? mayTakeOver : desktop || (full && !!device?.send);
  const mayRelease = desktop || (full && !!device?.manage);
  const mayStop = desktop || (full && !!device?.send);
  return (
    <OperationGroup title={text.title}>
      <OperationRow>
        <OperationCopy title={text.summary(agent.workers.length, agent.pendingReports)}>
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
      {agent.workers.map((worker) =>
        removing === worker.sessionId ? (
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
          <OperationRow key={worker.sessionId}>
            <OperationCopy
              title={`${worker.name} · ${text.status[worker.status] ?? text.status.unavailable}`}
            >
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
            </OperationCopy>
            <div className="flex shrink-0 items-center gap-1.5">
              {mayStop && worker.stopEnabled && (
                <Button
                  variant="outline"
                  size="sm"
                  className={touchTarget}
                  disabled={busy || providerDisabled}
                  onClick={() => void run({ operation: "stop-worker", worker: worker.sessionId })}
                >
                  {text.stopWorker}
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
        ),
      )}
      {(releasing || mayToggle || mayTakeOver || mayRelease || errorText) && (
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
                  aria-busy={recovering || busyOperation === "resume"}
                  onClick={() => void run({ operation: agent.paused ? "resume" : "pause" })}
                >
                  {agent.paused && (
                    <span className="grid size-3.5 place-items-center" aria-hidden>
                      <DelayedSpinner active={recovering || busyOperation === "resume"} />
                    </span>
                  )}
                  {agent.paused ? text.resume : text.pause}
                </Button>
              )}
              {mayTakeOver && (
                <Button
                  variant="outline"
                  className={touchTarget}
                  disabled={providerDisabled}
                  onClick={() => {
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
          {errorText && <p className="basis-full text-xs text-destructive-text">{errorText}</p>}
        </OperationRow>
      )}
    </OperationGroup>
  );
}
