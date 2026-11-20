import { useSessionNavigate } from "./session-navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  ApiError,
  type SessionAction,
  type SessionActionBody,
  type CodexOptions,
  type CodexQueue,
  type CodexSessionSettings,
} from "@agentkib/web-client";
import { ComposerModelPicker } from "@agentkib/session-ui";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Dialog } from "../../components/dialog";
import {
  OperationDisclosure,
  OperationGroup,
  OperationRow,
  TOUCH_TARGET,
} from "./operation-layout";
import { useSession } from "./session-context";
import { webLayoutCopy } from "./web-layout-copy";
import { composerLayoutCopy } from "./composer-layout-copy";
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
    settingsNotice,
    t,
  } = session;
  const copy = codexCopyForSurface(locale, "web");
  const agentCopy = sessionAgentCopy[locale];
  const isClaude = current?.agent === "claude-code";
  // DeepSeek Harness takes management actions here; its model is set from the composer and its
  // waiting messages sit in the strip above it, so neither is repeated in this panel.
  const isDsh = current?.agent === "deepseek-harness";
  const queueReadable =
    !isDsh &&
    (!isClaude ||
      ["queue-list", "queue-add", "queue-resume", "queue-pause"].some(
        (key) => capabilities?.features[key as SessionAction | "queue-list"]?.available,
      ));
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
    if (!isClaude && !isDsh && access.device?.accessMode !== "full")
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
    access?.device?.accessMode,
    revision,
    copy.queueTooLarge,
    copy.unavailableQueue,
    isClaude,
    isDsh,
    queueReadable,
  ]);
  if (current?.agent !== "codex" && !isClaude && !isDsh) return null;
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
  ): Promise<boolean> {
    if (!enabled(action)) return false;
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
      return !!result;
    } finally {
      setOperation(false);
    }
  }
  const actionButton = (
    action: SessionAction,
    label: string,
    fields = {},
    itemAvailable = true,
    size: "default" | "sm" = "sm",
  ) => (
    <div className="min-w-0 max-w-full">
      <Button
        type="button"
        variant="outline"
        size={size}
        className={TOUCH_TARGET}
        disabled={!itemAvailable || !enabled(action)}
        title={enabled(action) ? undefined : reason(action)}
        onClick={() => void run(action, fields)}
      >
        {label}
      </Button>
    </div>
  );
  const archiveAction: SessionAction | null =
    capabilities?.features.archive || capabilities?.features.unarchive
      ? current.archived
        ? "unarchive"
        : "archive"
      : null;
  const pendingQueue =
    queue?.data?.filter(
      (item) => item.status === "pending" || (!isClaude && item.status === undefined),
    ) ?? [];
  const limitedSettings = !isClaude && !isDsh && access?.device?.accessMode !== "full";
  // A follower write requires a fresh privileged settings read from the current owner.
  const followerModelReadOnly =
    live?.sessionId === selected && live.executionMode === "codex-follower";
  const limitedModelWritable = enabled("settings") && !followerModelReadOnly;
  const observedSettings =
    live?.sessionId === selected && live.settings?.sessionId === selected
      ? live.settings
      : undefined;
  const limitedModel: CodexSessionSettings | undefined =
    limitedSettings && options?.available
      ? {
          sessionId: selected,
          revision: live?.revision ?? 0,
          available: true,
          current: observedSettings?.current ?? {
            modelId: live?.sessionId === selected ? live.model : undefined,
          },
          selected: observedSettings?.selected,
          defaults: {},
          writable: {
            model: { available: limitedModelWritable },
            effort: { available: limitedModelWritable },
            mode: { available: false },
            serviceTier: { available: false },
            policy: { available: false },
            restoreDefaults: { available: false },
          },
          options: {
            models: (options.models ?? []).map((model) => ({
              ...model,
              efforts: model.efforts ?? [],
              serviceTierIds: [],
            })),
            serviceTiers: [],
            policies: [],
          },
        }
      : undefined;
  const settingsStatus =
    settingsNotice?.status === "uncertain"
      ? composerLayoutCopy[locale].settingsUnknown
      : settingsNotice?.status === "notDispatched"
        ? settingsNotice.reason
          ? codexReason(locale, settingsNotice.reason, "web").text
          : t.notDispatched
        : undefined;
  return (
    <>
      {showTrigger && (
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          {layout.actions}
        </Button>
      )}
      {open && (
        <Dialog
          panel
          title={layout.actions}
          closeLabel={copy.close}
          onClose={() => setOpen(false)}
          bodyClassName="space-y-5 leading-5"
        >
          {shortcuts}

          <OperationGroup title={layout.management}>
            <OperationRow className="flex-wrap">
              <label className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                <span className="shrink-0 text-muted-foreground">{copy.name}</span>
                <Input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
              </label>
              <Button
                variant="outline"
                className={TOUCH_TARGET}
                disabled={!enabled("rename") || !name.trim()}
                title={enabled("rename") ? undefined : reason("rename")}
                onClick={() => void run("rename", { name: name.trim() })}
              >
                {copy.rename}
              </Button>
            </OperationRow>
            <OperationRow className="block space-y-2">
              <div className="flex flex-wrap items-start gap-2">
                {/* Archiving is the agent's own (Codex); AgentKib keeps no archive of its own. */}
                {archiveAction &&
                  actionButton(
                    archiveAction,
                    archiveAction === "unarchive" ? copy.unarchive : copy.archive,
                    {},
                    true,
                    "default",
                  )}
                {actionButton("fork", copy.fork, {}, true, "default")}
                {capabilities?.features.delete && (
                  <div className="min-w-0 max-w-full">
                    <Button
                      type="button"
                      variant="outline"
                      className={TOUCH_TARGET}
                      disabled={!enabled("delete") || confirmDelete}
                      title={enabled("delete") ? undefined : reason("delete")}
                      onClick={() => setConfirmDelete(true)}
                    >
                      {copy.delete}
                    </Button>
                  </div>
                )}
              </div>
            </OperationRow>
            {confirmDelete && (
              <OperationRow className="block">
                <div
                  role="group"
                  aria-labelledby="session-delete-title"
                  aria-describedby="session-delete-detail"
                  className="grid gap-2"
                >
                  <p id="session-delete-title" className="font-medium">
                    {copy.deleteTitle}
                  </p>
                  <p id="session-delete-detail" className="text-xs leading-5 text-muted-foreground">
                    {isClaude ? copy.deleteClaudeDetail : copy.deleteCodexDetail}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      className={TOUCH_TARGET}
                      disabled={!enabled("delete")}
                      onClick={() => void run("delete")}
                    >
                      {copy.deleteConfirm}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className={TOUCH_TARGET}
                      disabled={operation}
                      onClick={() => setConfirmDelete(false)}
                    >
                      {copy.cancel}
                    </Button>
                  </div>
                </div>
              </OperationRow>
            )}
          </OperationGroup>
          {isClaude && ownership}
          {limitedSettings && (
            <OperationGroup title={copy.settings}>
              <OperationRow className="flex-wrap">
                <ComposerModelPicker
                  locale={locale}
                  settings={limitedModel}
                  selection={limitedModel?.selected ?? limitedModel?.current}
                  disabled={!limitedModelWritable}
                  readOnly={followerModelReadOnly}
                  saving={operation}
                  side="bottom"
                  onOpen={() => {}}
                  onChange={(change) =>
                    limitedModelWritable ? run("settings", change) : Promise.resolve(false)
                  }
                />
              </OperationRow>
              {settingsStatus && (
                <p role="status" className="text-xs text-muted-foreground">
                  {settingsStatus}
                </p>
              )}
            </OperationGroup>
          )}
          {queueReadable && (queue || queueError) && (
            <OperationGroup title={isClaude ? agentCopy.queue : copy.queue}>
              {isClaude &&
                queue &&
                (queue.requiresResume || queue.paused || !!queue.data.length) && (
                  <OperationRow className="flex-wrap gap-2">
                    {(queue.requiresResume || queue.paused) && (
                      <p role="status" className="min-w-0 flex-1 text-muted-foreground">
                        {queue.requiresResume ? agentCopy.queueRecovery : agentCopy.queuePaused}
                      </p>
                    )}
                    {queue.paused || queue.requiresResume
                      ? actionButton("queue-resume", agentCopy.resumeQueue)
                      : actionButton("queue-pause", agentCopy.pauseQueue)}
                  </OperationRow>
                )}
              {queueError && (
                <OperationRow>
                  <p role="status">{queueError}</p>
                </OperationRow>
              )}
              {queue?.data?.length === 0 && (
                <OperationRow>
                  <p className="text-muted-foreground">{copy.queueEmpty}</p>
                </OperationRow>
              )}
              {queue?.data?.map((item) => {
                const pendingIndex = pendingQueue.findIndex((entry) => entry.id === item.id);
                const editable = pendingIndex >= 0;
                return (
                  <OperationRow key={item.id} className="block space-y-2">
                    <p className="whitespace-pre-wrap break-words">{item.text || item.id}</p>
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
                        className={TOUCH_TARGET}
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
                  </OperationRow>
                );
              })}
            </OperationGroup>
          )}
          <OperationDisclosure
            title={layout.diagnostics}
            className="overflow-hidden rounded-xl border border-border/70"
          >
            <div className="grid gap-1">
              <h3>{copy.capabilities}</h3>
              <p className="break-words text-xs text-muted-foreground">
                {capabilities
                  ? `${capabilities.status}${capabilities.reason ? ` · ${codexReason(locale, capabilities.reason, "web").text}` : ""}`
                  : copy.unavailable}
              </p>
            </div>
            <ul className="space-y-1 text-xs text-muted-foreground empty:hidden">
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
            <div className="flex flex-wrap items-start gap-2">
              <Button
                variant="outline"
                size="sm"
                className={TOUCH_TARGET}
                disabled={busy}
                onClick={() => {
                  setRevision((n) => n + 1);
                  void refresh(true);
                }}
              >
                {copy.refresh}
              </Button>
              {actionButton("inspect", copy.inspect)}
            </div>
            {context !== undefined && (
              <pre className="whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(context, null, 2)}
              </pre>
            )}
          </OperationDisclosure>
        </Dialog>
      )}
    </>
  );
}
