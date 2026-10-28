import { useSessionNavigate } from "./session-navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  ApiError,
  type SessionAction,
  type SessionActionBody,
  type CodexOptions,
  type CodexQueue,
} from "@agentkib/web-client";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";
import { webLayoutCopy } from "./web-layout-copy";
import { codexCopyForSurface, codexReason } from "./codex-copy";
import { blockedWhileCompacting } from "./session-activity";
import { contextUsageCopyForSurface } from "./context-usage-copy";
import { subscribeSessionInvalidation } from "./session-events";
import { sessionAgentCopy } from "./session-agent-copy";

export function CodexTools({
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
  ownership,
  shortcuts,
}: {
  open?: boolean;
  onOpenChange?: (value: boolean) => void;
  showTrigger?: boolean;
  ownership?: ReactNode;
  shortcuts?: ReactNode;
} = {}) {
  const session = useSession();
  const {
    current,
    selected,
    client,
    capabilities,
    codexAction,
    busy,
    online,
    controlReady,
    locale,
    access,
    live,
    refresh,
  } = session;
  const copy = codexCopyForSurface(locale, "web");
  const agentCopy = sessionAgentCopy[locale];
  const isClaude = current?.agent === "claude-code";
  const queueReadable =
    !isClaude ||
    ["queue-list", "queue-add", "queue-resume", "queue-pause"].some(
      (key) => capabilities?.features[key as SessionAction | "queue-list"]?.available,
    );
  const navigate = useSessionNavigate();
  const [context, setContext] = useState<unknown>();
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  function setOpen(value: boolean) {
    setLocalOpen(value);
    onOpenChange?.(value);
  }
  const layout = webLayoutCopy[locale];
  const [queue, setQueue] = useState<CodexQueue>();
  const [options, setOptions] = useState<CodexOptions>();
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [mode, setMode] = useState<"" | "default" | "plan">("");
  const [editing, setEditing] = useState("");
  const [text, setText] = useState("");
  const [queueError, setQueueError] = useState("");
  const [revision, setRevision] = useState(0);
  const [operation, setOperation] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setContext(undefined);
    setQueue(undefined);
    setOptions(undefined);
    setModel("");
    setEffort("");
    setMode("");
    setEditing("");
    setText("");
    setConfirmDelete(false);
  }, [selected]);
  useEffect(() => {
    setName(current?.title ?? "");
  }, [selected, current?.title]);
  useEffect(() => {
    if (!open || !selected || access?.status !== "approved") return;
    const abort = new AbortController();
    let flight = false;
    let dirty = false;
    const load = async () => {
      if (flight) {
        dirty = true;
        return;
      }
      flight = true;
      try {
        do {
          dirty = false;
          try {
            if (!queueReadable) {
              setQueue(undefined);
              setQueueError("");
              return;
            }
            const result = isClaude
              ? await client.sessionQueue(selected, "claude-code", abort.signal)
              : await client.codexQueue(selected, abort.signal);
            if (!abort.signal.aborted) {
              setQueue(result);
              setQueueError("");
            }
          } catch (error) {
            if (!abort.signal.aborted) {
              setQueue(undefined);
              setQueueError(
                error instanceof ApiError && error.code === "queue_too_large"
                  ? copy.queueTooLarge
                  : copy.unavailableQueue,
              );
            }
          }
        } while (dirty && !abort.signal.aborted);
      } finally {
        flight = false;
      }
    };
    void load();
    if (!isClaude)
      void client
        .request<CodexOptions>("managed/options", undefined, abort.signal)
        .then((value) => {
          if (!abort.signal.aborted) setOptions(value);
        })
        .catch(() => {
          if (!abort.signal.aborted) setOptions(undefined);
        });
    const unsubscribe = subscribeSessionInvalidation(client, (id, domains) => {
      if (
        (!id || id === selected) &&
        domains.some((domain) => ["queue", "ownership"].includes(domain))
      )
        void load();
    });
    return () => {
      abort.abort();
      unsubscribe();
    };
  }, [
    open,
    selected,
    client,
    access?.status,
    access?.device?.id,
    revision,
    copy.queueTooLarge,
    copy.unavailableQueue,
    isClaude,
    queueReadable,
  ]);
  if (current?.agent !== "codex" && !isClaude) return null;
  function enabled(action: SessionAction) {
    return !!(
      access?.experimentalEnabled &&
      !busy &&
      !operation &&
      !(live?.activity === "compacting" && blockedWhileCompacting(action)) &&
      (action === "inspect" || action === "resume" || (online && controlReady)) &&
      capabilities?.sessionId === selected &&
      capabilities.features[action]?.available
    );
  }
  const actionLabels: Record<string, string> = {
    inspect: copy.inspect,
    steer: copy.steer,
    "queue-add": copy.queueAdd,
    "queue-update": copy.queueUpdate,
    "queue-delete": copy.queueDelete,
    "queue-reorder": copy.queueUp,
    "queue-start": copy.queueStart,
    "queue-pause": agentCopy.pauseQueue,
    "queue-resume": agentCopy.resumeQueue,
    rename: copy.rename,
    archive: copy.archive,
    unarchive: copy.unarchive,
    delete: copy.delete,
    fork: copy.fork,
    settings: copy.settings,
    attachments: copy.attachment,
  };
  const reason = (action: SessionAction) =>
    live?.activity === "compacting" && blockedWhileCompacting(action)
      ? contextUsageCopyForSurface(locale, "web").compactingDetail
      : // Only quitting the other process frees the session for deletion.
        action === "delete" && capabilities?.features.delete?.reason === "codex-owner-busy"
        ? copy.deleteOwnerBusy
        : action === "delete" &&
            ["claude-owner-busy", "claude-background-session-running"].includes(
              capabilities?.features.delete?.reason ?? "",
            )
          ? copy.deleteClaudeOwnerBusy
          : codexReason(
              locale,
              capabilities?.features[action]?.reason || capabilities?.reason,
              "web",
            ).text;
  async function run(
    action: SessionAction,
    fields: Omit<
      Partial<SessionActionBody>,
      "requestId" | "bootId" | "sessionId" | "expectedRevision"
    > = {},
  ) {
    if (!enabled(action)) return;
    setOperation(true);
    try {
      const result = await codexAction(action, fields);
      if (result) {
        if (action === "inspect") setContext(result.context);
        if (action === "fork" && result.sessionId && result.sessionId !== selected) {
          setOpen(false);
          void navigate({ to: "/sessions/$sessionId", params: { sessionId: result.sessionId } });
        }
        if (action === "archive" || action === "delete") {
          setConfirmDelete(false);
          setOpen(false);
          void navigate({ to: "/sessions" });
        }
        setEditing("");
        setText("");
        setRevision((n) => n + 1);
      }
    } finally {
      setOperation(false);
    }
  }
  const actionButton = (
    action: SessionAction,
    label: string,
    fields = {},
    itemAvailable = true,
  ) => (
    <div className="min-w-0 max-w-full space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!itemAvailable || !enabled(action)}
        title={enabled(action) ? undefined : reason(action)}
        onClick={() => void run(action, fields)}
      >
        {label}
      </Button>
      {!enabled(action) && (
        <p className="max-w-64 text-xs text-muted-foreground">{reason(action)}</p>
      )}
    </div>
  );
  const pendingQueue =
    queue?.data?.filter(
      (item) => item.status === "pending" || (!isClaude && item.status === undefined),
    ) ?? [];
  return (
    <>
      {showTrigger && (
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          {layout.actions}
        </Button>
      )}
      {open && (
        <Dialog panel title={layout.actions} closeLabel={copy.close} onClose={() => setOpen(false)}>
          {shortcuts}

          <section className="space-y-3 border-t pt-3">
            <h3 className="font-medium">{layout.management}</h3>
            <label className="block text-sm">
              {copy.name}
              <Input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!enabled("rename") || !name.trim()}
                title={reason("rename")}
                onClick={() => void run("rename", { name: name.trim() })}
              >
                {copy.rename}
              </Button>
              {/* Archiving is the agent's own (Codex); AgentKib keeps no archive of its own. */}
              {(capabilities?.features.archive || capabilities?.features.unarchive) &&
                actionButton(
                  current.archived ? "unarchive" : "archive",
                  current.archived ? copy.unarchive : copy.archive,
                )}
              {actionButton("fork", copy.fork)}
              {capabilities?.features.delete && (
                <div className="min-w-0 max-w-full space-y-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!enabled("delete") || confirmDelete}
                    title={enabled("delete") ? undefined : reason("delete")}
                    onClick={() => setConfirmDelete(true)}
                  >
                    {copy.delete}
                  </Button>
                  {!enabled("delete") && (
                    <p className="max-w-64 text-xs text-muted-foreground">{reason("delete")}</p>
                  )}
                </div>
              )}
            </div>
            {confirmDelete && (
              <div
                role="group"
                aria-labelledby="session-delete-title"
                aria-describedby="session-delete-detail"
                className="space-y-2 rounded-md border border-destructive/40 p-3"
              >
                <p id="session-delete-title" className="text-sm font-medium">
                  {copy.deleteTitle}
                </p>
                <p id="session-delete-detail" className="text-sm text-muted-foreground">
                  {isClaude ? copy.deleteClaudeDetail : copy.deleteCodexDetail}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={!enabled("delete")}
                    onClick={() => void run("delete")}
                  >
                    {copy.deleteConfirm}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={operation}
                    onClick={() => setConfirmDelete(false)}
                  >
                    {copy.cancel}
                  </Button>
                </div>
              </div>
            )}
          </section>
          {isClaude && ownership}
          {!isClaude && access?.device?.accessMode !== "full" && (
            <section className="space-y-3 border-t pt-3">
              <h3>{copy.settings}</h3>
              <label className="block text-sm">
                {copy.model}
                <select
                  className="block w-full rounded border bg-background p-2"
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setEffort("");
                  }}
                >
                  <option value="">{copy.keep}</option>
                  {options?.models?.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name || item.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                {copy.effort}
                <select
                  className="block w-full rounded border bg-background p-2"
                  value={effort}
                  onChange={(e) => setEffort(e.target.value)}
                >
                  <option value="">{copy.keep}</option>
                  {options?.models
                    ?.find((item) => item.id === model)
                    ?.efforts?.map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                </select>
              </label>
              <label className="block text-sm">
                {copy.mode}
                <select
                  className="block w-full rounded border bg-background p-2"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as "" | "default" | "plan")}
                >
                  <option value="">{copy.keep}</option>
                  <option value="default">{copy.normal}</option>
                  <option value="plan">{copy.plan}</option>
                </select>
              </label>
              {actionButton("settings", copy.apply, {
                ...(model ? { model } : {}),
                ...(effort ? { effort } : {}),
                ...(mode ? { mode } : {}),
              })}
            </section>
          )}
          {queueReadable && (
            <section className="space-y-3 border-t pt-3">
              <h3>{isClaude ? agentCopy.queue : copy.queue}</h3>
              {isClaude && (queue?.requiresResume || queue?.paused) && (
                <p role="status" className="text-sm text-muted-foreground">
                  {queue.requiresResume ? agentCopy.queueRecovery : agentCopy.queuePaused}
                </p>
              )}
              {isClaude &&
                queue &&
                (queue.paused || queue.requiresResume
                  ? actionButton("queue-resume", agentCopy.resumeQueue)
                  : !!queue.data.length && actionButton("queue-pause", agentCopy.pauseQueue))}
              {queueError && <p role="status">{queueError}</p>}
              {queue?.data?.length === 0 && <p>{copy.queueEmpty}</p>}
              {queue?.data?.map((item) => {
                const pendingIndex = pendingQueue.findIndex((entry) => entry.id === item.id);
                const editable = pendingIndex >= 0;
                return (
                  <div key={item.id} className="space-y-2 rounded border p-3">
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {item.text || item.id}
                    </p>
                    {item.hasAttachments && (
                      <p className="text-xs text-muted-foreground">{copy.queueAttachments}</p>
                    )}
                    {editing === item.id && editable && !item.hasAttachments && (
                      <Input
                        aria-label={copy.text}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                      />
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          !enabled("queue-update") ||
                          !editable ||
                          item.hasAttachments === true ||
                          (editing === item.id && !text.trim())
                        }
                        onClick={() => {
                          if (editing === item.id)
                            void run("queue-update", { queuedSubmissionId: item.id, text });
                          else {
                            setEditing(item.id);
                            setText(item.text ?? "");
                          }
                        }}
                      >
                        {copy.queueUpdate}
                      </Button>
                      {actionButton(
                        "queue-delete",
                        copy.queueDelete,
                        { queuedSubmissionId: item.id },
                        editable,
                      )}
                      {pendingIndex > 0 &&
                        actionButton("queue-reorder", copy.queueUp, {
                          queuedSubmissionIds: pendingQueue.map((entry, position) =>
                            position === pendingIndex - 1
                              ? item.id
                              : position === pendingIndex
                                ? pendingQueue[pendingIndex - 1]!.id
                                : entry.id,
                          ),
                        })}
                    </div>
                  </div>
                );
              })}
            </section>
          )}
          <details className="space-y-3 border-t pt-3">
            <summary className="cursor-pointer py-2 font-medium">{layout.diagnostics}</summary>
            <h3>{copy.capabilities}</h3>
            <p className="break-words text-xs text-muted-foreground">
              {capabilities
                ? `${capabilities.status}${capabilities.reason ? ` · ${codexReason(locale, capabilities.reason, "web").text}` : ""}`
                : copy.unavailable}
            </p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {Object.entries(capabilities?.features ?? {})
                .filter(
                  ([action, feature]) =>
                    !feature?.available &&
                    (isClaude || !["resume", "queue-start"].includes(action)),
                )
                .map(([action, feature]) => (
                  <li key={action}>
                    {actionLabels[action] ?? action}:{" "}
                    {codexReason(locale, feature?.reason, "web").text}
                    {codexReason(locale, feature?.reason, "web").technical && (
                      <details>
                        <summary>{copy.context}</summary>
                        <code className="break-all">{feature?.reason}</code>
                      </details>
                    )}
                  </li>
                ))}
            </ul>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setRevision((n) => n + 1);
                void refresh(true);
              }}
            >
              {copy.refresh}
            </Button>
            <div className="flex flex-wrap gap-2">{actionButton("inspect", copy.inspect)}</div>
            {context !== undefined && (
              <pre className="whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(context, null, 2)}
              </pre>
            )}
          </details>
        </Dialog>
      )}
    </>
  );
}
