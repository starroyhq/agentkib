import { PROJECT_AGENT_MAX_WORKERS } from "@agentkib/runtime-protocol";
import { projectAgentCopy } from "@agentkib/session-ui";
import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "@/core/desktop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { OperationCopy, OperationGroup, OperationRow } from "./operation-layout";
import { useSession } from "./session-context";

type Worker = {
  name: string;
  sessionId: string;
  status: string;
  /** A turn runs that the person can stop; absent from older hosts. */
  stopEnabled?: boolean;
  title: string | null;
  lastReportAt: string | null;
};
type ProjectAgent = {
  sessionId: string;
  paused: boolean;
  reason: string | null;
  scope: {
    workspaceIds: string[];
    policies: string[];
    maxLanes: number;
    maxAutoTurns: number;
    approvals?: string[];
    answers?: boolean;
  };
  pendingReports: number;
  workers: Worker[];
};

function projectAgentOf(value: unknown): ProjectAgent | null | undefined {
  if (!value || typeof value !== "object" || !("lead" in value)) return undefined;
  const lead = value.lead as Partial<ProjectAgent> | null;
  if (lead === null) return null;
  if (!lead || typeof lead.paused !== "boolean" || !Array.isArray(lead.workers) || !lead.scope)
    return undefined;
  return lead as ProjectAgent;
}

/** Optional, like the other computer settings: a bridge that cannot answer hides it. */
const request = (params: Record<string, unknown>) =>
  Promise.resolve().then(() => desktopApi().claude.request(params));

/**
 * Whether this Claude Code, Codex or DeepSeek Harness session is a Project Agent: it opens
 * workers (Codex or DeepSeek Harness sessions) and hears from them as reports. Its scope is set
 * here, on this computer.
 */
export function ProjectAgentPanel() {
  const { locale, selected, workspaces, choose, formatCatalogTime } = useSession();
  const text = projectAgentCopy(locale);
  const [agent, setAgent] = useState<ProjectAgent | null>();
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
  // The worker, by session, whose letting go waits for a confirmation.
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Resolves to whether the host did it; a refusal stays on screen with its reason. */
  const run = useCallback(
    (params: Record<string, unknown>): Promise<boolean> => {
      if (!selected) return Promise.resolve(false);
      setBusy(true);
      setError(null);
      return request({ ...params, sessionId: selected })
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
    [selected, text.errors],
  );

  useEffect(() => {
    if (!selected) return;
    let live = true;
    const read = () =>
      void request({ operation: "lead-status", sessionId: selected }).then(
        (value) => {
          if (!live) return;
          setAgent(projectAgentOf(value));
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
  }, [selected]);

  if (!agent || !selected) return null;
  const errorText = error ? (text.errors[error] ?? text.failed) : null;
  const formOf = (scope: ProjectAgent["scope"]) => ({
    workspaceIds: scope.workspaceIds,
    autoReview: scope.policies.includes("workspace-write-auto-review"),
    approveFiles: scope.approvals?.includes("file-change") ?? false,
    approveCommands: scope.approvals?.includes("command") ?? false,
    answers: scope.answers ?? false,
    maxLanes: scope.maxLanes,
    maxAutoTurns: scope.maxAutoTurns,
  });

  if (form) {
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
              max={PROJECT_AGENT_MAX_WORKERS}
              value={form.maxLanes}
              onChange={(event) =>
                setForm({
                  ...form,
                  maxLanes: bounded(event.target.value, PROJECT_AGENT_MAX_WORKERS),
                })
              }
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
          <Button variant="outline" onClick={() => setForm(null)}>
            {text.cancel}
          </Button>
          <Button
            disabled={busy || !form.workspaceIds.length}
            onClick={() =>
              void run({
                operation: "lead-update",
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
            {text.save}
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
      {agent.workers.map((worker) =>
        removing === worker.sessionId ? (
          <OperationRow key={worker.sessionId} className="flex-wrap gap-2">
            <p className="min-w-0 flex-1 basis-full text-xs leading-5">
              {text.removeConfirm(worker.name)}
            </p>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run({ operation: "lead-worker-remove", worker: worker.sessionId }).then(
                  (done) => done && setRemoving(null),
                )
              }
            >
              {text.removeWorker}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setRemoving(null)}>
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
              {worker.stopEnabled && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run({ operation: "lead-worker-stop", worker: worker.sessionId })
                  }
                >
                  {text.stopWorker}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => void choose(worker.sessionId)}>
                {text.open}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setRemoving(worker.sessionId)}
              >
                {text.removeWorker}
              </Button>
            </div>
          </OperationRow>
        ),
      )}
      <OperationRow className="flex-wrap gap-2">
        {releasing ? (
          <>
            <p className="min-w-0 flex-1 basis-full text-xs leading-5">{text.releaseConfirm}</p>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void run({ operation: "lead-release" }).then((done) => done && setReleasing(false))
              }
            >
              {text.release}
            </Button>
            <Button variant="outline" onClick={() => setReleasing(false)}>
              {text.cancel}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void run({ operation: agent.paused ? "lead-resume" : "lead-pause" })}
            >
              {agent.paused ? text.resume : text.pause}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setRemoving(null);
                setForm(formOf(agent.scope));
              }}
            >
              {text.edit}
            </Button>
            <Button
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => setReleasing(true)}
            >
              {text.release}
            </Button>
          </>
        )}
        {errorText && <p className="basis-full text-xs text-destructive-text">{errorText}</p>}
      </OperationRow>
    </OperationGroup>
  );
}
