import { projectAgentCopy } from "@agentkib/session-ui";
import type { ProjectAgentState as ProjectAgent } from "@agentkib/web-client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NativeCheckbox } from "../../components/ui/native-checkbox";
import { OperationCopy, OperationGroup, OperationRow, TOUCH_TARGET } from "./operation-layout";
import { useSession } from "./session-context";

function projectAgentOf(value: unknown): ProjectAgent | null | undefined {
  if (!value || typeof value !== "object" || !("lead" in value)) return undefined;
  const lead = value.lead as Partial<ProjectAgent> | null;
  if (lead === null) return null;
  if (!lead || typeof lead.paused !== "boolean" || !Array.isArray(lead.workers) || !lead.scope)
    return undefined;
  return lead as ProjectAgent;
}

/**
 * Whether this Claude Code, Codex or DeepSeek Harness session is a Project Agent, from Web or a
 * phone: its state for any paired device, and setting it up, pausing, resuming or ending it for a
 * device with the access the host asks for (`/managed/project-agent`).
 */
export function ProjectAgentPanel() {
  const { locale, selected, current, workspaces, choose, formatCatalogTime, client, access } =
    useSession();
  const text = projectAgentCopy(locale);
  const [agent, setAgent] = useState<ProjectAgent | null>();
  // Whether the host lets this session lead; older hosts do not say, and it is offered.
  const [capable, setCapable] = useState(true);
  const [form, setForm] = useState<null | {
    workspaceIds: string[];
    autoReview: boolean;
    approveFiles: boolean;
    approveCommands: boolean;
    answers: boolean;
    maxLanes: number;
    maxAutoTurns: number;
  }>(null);
  const [busy, setBusy] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Resolves to whether the host did it; a refusal stays on screen with its reason. */
  const run = useCallback(
    (params: Record<string, unknown>): Promise<boolean> => {
      if (!selected) return Promise.resolve(false);
      setBusy(true);
      setError(null);
      return client
        .manageProjectAgent({ ...params, sessionId: selected } as Parameters<
          typeof client.manageProjectAgent
        >[0])
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
        .finally(() => setBusy(false));
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

  const device = access?.device;
  const full = device?.accessMode === "full";
  const mayLead = full && !!device?.send && !!device.manage && !!device.advancedControl;
  if (agent === undefined || !selected) return null;
  const errorText = error ? (text.errors[error] ?? text.failed) : null;

  if (agent === null) {
    if (!capable) return null;
    // Only a device that may do what a Project Agent does in its name sets one up.
    if (!mayLead) return null;
    if (!form)
      return (
        <OperationGroup title={text.title}>
          <OperationRow className="flex-wrap">
            <OperationCopy className="basis-64">{text.hint}</OperationCopy>
            <Button
              variant="outline"
              className={TOUCH_TARGET}
              onClick={() =>
                setForm({
                  workspaceIds: current?.workspace_id ? [current.workspace_id] : [],
                  autoReview: false,
                  approveFiles: false,
                  approveCommands: false,
                  answers: false,
                  maxLanes: 4,
                  maxAutoTurns: 25,
                })
              }
            >
              {text.designate}
            </Button>
          </OperationRow>
        </OperationGroup>
      );
    const toggleWorkspace = (id: string, on: boolean) =>
      setForm({
        ...form,
        workspaceIds: on
          ? [...form.workspaceIds, id]
          : form.workspaceIds.filter((value) => value !== id),
      });
    const bounded = (value: string, max: number) =>
      Math.min(max, Math.max(1, Math.trunc(Number(value)) || 1));
    return (
      <OperationGroup title={text.title}>
        <OperationRow className="block">
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-xs text-muted-foreground">{text.workspaces}</legend>
            {(workspaces ?? []).map((workspace) => (
              <label key={workspace.id} className="flex items-center gap-2">
                <NativeCheckbox
                  checked={form.workspaceIds.includes(workspace.id)}
                  onChange={(event) => toggleWorkspace(workspace.id, event.target.checked)}
                />
                <span className="truncate">{workspace.name}</span>
              </label>
            ))}
          </fieldset>
        </OperationRow>
        <OperationRow>
          <label className="flex items-center gap-2">
            <NativeCheckbox
              checked={form.autoReview}
              onChange={(event) => setForm({ ...form, autoReview: event.target.checked })}
            />
            <span>{text.autoReview}</span>
          </label>
        </OperationRow>
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
                  disabled={key !== "answers" && !device?.approve}
                  onChange={(event) => setForm({ ...form, [key]: event.target.checked })}
                />
                <span>{label}</span>
              </label>
            ))}
            <p className="text-xs leading-5 text-muted-foreground">{text.decidesNote}</p>
          </fieldset>
        </OperationRow>
        <OperationRow className="grid grid-cols-2 items-start gap-3">
          <label className="grid gap-1.5">
            <span className="text-xs text-muted-foreground">{text.maxWorkers}</span>
            <Input
              type="number"
              min={1}
              max={8}
              value={form.maxLanes}
              onChange={(event) => setForm({ ...form, maxLanes: bounded(event.target.value, 8) })}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs text-muted-foreground">{text.maxAutoTurns}</span>
            <Input
              type="number"
              min={1}
              max={100}
              value={form.maxAutoTurns}
              onChange={(event) =>
                setForm({ ...form, maxAutoTurns: bounded(event.target.value, 100) })
              }
            />
          </label>
        </OperationRow>
        <OperationRow className="flex-wrap justify-end gap-2">
          {errorText && (
            <p className="mr-auto min-w-0 text-xs text-destructive-text">{errorText}</p>
          )}
          <Button variant="outline" className={TOUCH_TARGET} onClick={() => setForm(null)}>
            {text.cancel}
          </Button>
          <Button
            className={TOUCH_TARGET}
            disabled={busy || !form.workspaceIds.length}
            onClick={() =>
              void run({
                operation: "designate",
                scope: {
                  workspaceIds: form.workspaceIds,
                  policies: form.autoReview
                    ? ["workspace-write-on-request", "workspace-write-auto-review"]
                    : ["workspace-write-on-request"],
                  maxLanes: form.maxLanes,
                  maxAutoTurns: form.maxAutoTurns,
                  approvals: [
                    ...(form.approveFiles ? ["file-change"] : []),
                    ...(form.approveCommands ? ["command"] : []),
                  ],
                  answers: form.answers,
                },
              }).then((done) => done && setForm(null))
            }
          >
            {text.confirm}
          </Button>
        </OperationRow>
      </OperationGroup>
    );
  }

  const decided = [
    ...(agent.scope.approvals?.includes("file-change") ? [text.approveFiles] : []),
    ...(agent.scope.approvals?.includes("command") ? [text.approveCommands] : []),
    ...(agent.scope.answers ? [text.answers] : []),
  ];
  // What this device may do with it; a device that may only look gets no row of buttons.
  const mayToggle = agent.paused
    ? mayLead && (!agent.scope.approvals?.length || !!device?.approve)
    : full && !!device?.send;
  const mayRelease = full && !!device?.manage;
  return (
    <OperationGroup title={text.title}>
      <OperationRow>
        <OperationCopy title={text.summary(agent.workers.length, agent.pendingReports)}>
          {decided.length > 0 && <p>{text.decided(decided)}</p>}
          {agent.paused && (
            <p className="text-amber-700 dark:text-amber-300">
              {text.paused[agent.reason ?? "user-paused"] ?? text.paused["user-paused"]}
            </p>
          )}
          {!agent.workers.length && <p>{text.none}</p>}
        </OperationCopy>
      </OperationRow>
      {agent.workers.map((worker) => (
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
          <Button
            variant="outline"
            size="sm"
            className={TOUCH_TARGET}
            onClick={() => void choose(worker.sessionId)}
          >
            {text.open}
          </Button>
        </OperationRow>
      ))}
      {(releasing || mayToggle || mayRelease || errorText) && (
        <OperationRow className="flex-wrap gap-2">
          {releasing ? (
            <>
              <p className="min-w-0 flex-1 basis-full text-xs leading-5">{text.releaseConfirm}</p>
              <Button
                variant="destructive"
                className={TOUCH_TARGET}
                disabled={busy}
                onClick={() =>
                  void run({ operation: "release" }).then((done) => done && setReleasing(false))
                }
              >
                {text.release}
              </Button>
              <Button
                variant="outline"
                className={TOUCH_TARGET}
                onClick={() => setReleasing(false)}
              >
                {text.cancel}
              </Button>
            </>
          ) : (
            <>
              {mayToggle && (
                <Button
                  variant="outline"
                  className={TOUCH_TARGET}
                  disabled={busy}
                  onClick={() => void run({ operation: agent.paused ? "resume" : "pause" })}
                >
                  {agent.paused ? text.resume : text.pause}
                </Button>
              )}
              {mayRelease && (
                <Button
                  variant="ghost"
                  className={`${TOUCH_TARGET} text-muted-foreground`}
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
