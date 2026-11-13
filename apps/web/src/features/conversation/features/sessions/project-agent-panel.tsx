import { projectAgentCopy } from "@agentkib/session-ui";
import type { ProjectAgentState as ProjectAgent } from "@agentkib/web-client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NativeCheckbox } from "../../components/ui/native-checkbox";
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
 * Whether this Claude Code or Codex session is a Project Agent, from Web or a phone: its state for
 * any paired device, and setting it up, pausing, resuming or ending it for a device with the
 * access the host asks for (`/managed/project-agent`).
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
        <section className="space-y-2 border-t pt-4 text-sm" aria-label={text.title}>
          <p>{text.title}</p>
          <p className="text-xs leading-5 text-muted-foreground">{text.hint}</p>
          <Button
            variant="outline"
            className="min-h-11"
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
        </section>
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
      <section className="space-y-3 border-t pt-4 text-sm" aria-label={text.title}>
        <p>{text.title}</p>
        <fieldset className="space-y-1">
          <legend className="text-xs text-muted-foreground">{text.workspaces}</legend>
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
        <label className="flex items-center gap-2">
          <NativeCheckbox
            checked={form.autoReview}
            onChange={(event) => setForm({ ...form, autoReview: event.target.checked })}
          />
          <span>{text.autoReview}</span>
        </label>
        <fieldset className="space-y-1">
          <legend className="text-xs text-muted-foreground">{text.decides}</legend>
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
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">{text.maxWorkers}</span>
            <Input
              type="number"
              min={1}
              max={8}
              value={form.maxLanes}
              onChange={(event) => setForm({ ...form, maxLanes: bounded(event.target.value, 8) })}
            />
          </label>
          <label className="space-y-1">
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
        </div>
        {errorText && <p className="text-xs text-destructive">{errorText}</p>}
        <div className="flex gap-2">
          <Button
            className="min-h-11"
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
          <Button variant="outline" className="min-h-11" onClick={() => setForm(null)}>
            {text.cancel}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3 border-t pt-4 text-sm" aria-label={text.title}>
      <div className="space-y-0.5">
        <p>{text.title}</p>
        <p className="text-xs text-muted-foreground">
          {text.summary(agent.workers.length, agent.pendingReports)}
        </p>
        {(agent.scope.approvals?.length || agent.scope.answers) && (
          <p className="text-xs leading-5 text-muted-foreground">
            {text.decided([
              ...(agent.scope.approvals?.includes("file-change") ? [text.approveFiles] : []),
              ...(agent.scope.approvals?.includes("command") ? [text.approveCommands] : []),
              ...(agent.scope.answers ? [text.answers] : []),
            ])}
          </p>
        )}
        {agent.paused && (
          <p className="text-xs leading-5 text-muted-foreground">
            {text.paused[agent.reason ?? "user-paused"] ?? text.paused["user-paused"]}
          </p>
        )}
      </div>
      {agent.workers.length ? (
        <ul className="space-y-2">
          {agent.workers.map((worker) => (
            <li key={worker.sessionId} className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  {worker.name} · {text.status[worker.status] ?? text.status.unavailable}
                </p>
                {(worker.title || worker.lastReportAt) && (
                  <p className="truncate text-xs text-muted-foreground">
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
              </div>
              <Button variant="outline" size="sm" onClick={() => void choose(worker.sessionId)}>
                {text.open}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{text.none}</p>
      )}
      {errorText && <p className="text-xs text-destructive">{errorText}</p>}
      {releasing ? (
        <div className="space-y-2">
          <p className="text-xs leading-5">{text.releaseConfirm}</p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={busy}
              onClick={() =>
                void run({ operation: "release" }).then((done) => done && setReleasing(false))
              }
            >
              {text.release}
            </Button>
            <Button variant="outline" className="min-h-11" onClick={() => setReleasing(false)}>
              {text.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {(agent.paused
            ? mayLead && (!agent.scope.approvals?.length || !!device?.approve)
            : full && !!device?.send) && (
            <Button
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => void run({ operation: agent.paused ? "resume" : "pause" })}
            >
              {agent.paused ? text.resume : text.pause}
            </Button>
          )}
          {full && !!device?.manage && (
            <Button variant="outline" className="min-h-11" onClick={() => setReleasing(true)}>
              {text.release}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
