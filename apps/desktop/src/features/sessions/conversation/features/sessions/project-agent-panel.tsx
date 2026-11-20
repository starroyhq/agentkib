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
 * Shows the Project Agent and its assigned Workers. Its delegation settings are edited locally.
 */
export function ProjectAgentPanel() {
  const { locale, selected, choose, formatCatalogTime } = useSession();
  const text = projectAgentCopy(locale);
  const [agent, setAgent] = useState<ProjectAgent | null>();
  const [form, setForm] = useState<null | {
    approveFiles: boolean;
    approveCommands: boolean;
    answers: boolean;
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
    approveFiles: scope.approvals?.includes("file-change") ?? false,
    approveCommands: scope.approvals?.includes("command") ?? false,
    answers: scope.answers ?? false,
    maxAutoTurns: scope.maxAutoTurns,
  });

  if (form) {
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
        <OperationRow className="flex-wrap justify-end gap-2">
          {errorText && (
            <p className="mr-auto min-w-0 text-xs text-destructive-text">{errorText}</p>
          )}
          <Button variant="outline" onClick={() => setForm(null)}>
            {text.cancel}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void run({
                operation: "lead-update",
                scope: {
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
