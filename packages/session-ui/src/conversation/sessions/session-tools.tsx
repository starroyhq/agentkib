import { subscribeSessionInvalidation } from "@agentkib/conversation-state";
import {
  ApiError,
  type Access,
  type ConversationSessionSummary,
  type Live,
  type ManagedOptions,
  type SessionAction,
  type SessionActionBody,
  type SessionActionResult,
  type SessionCapabilities,
  type SessionQueue,
  type SessionQueueAction,
  type SessionSettings,
  type WebClient,
} from "@agentkib/web-client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  canReadSessionQueue,
  queueItemPending,
  registeredSessionQueue,
} from "../../agents/session-queue";
import { ComposerModelPicker } from "../../composer-model-picker";
import { contextUsageCopyForSurface } from "../../context-usage-copy";
import type { InteractionLocale } from "../../interaction-model";
import { useSessionPlatform } from "../../session-platform";
import { resolveSessionProvider } from "../../session-provider";
import { composerSettingsStatus } from "./composer-layout-copy";
import { OperationDisclosure, OperationGroup, OperationRow } from "./operation-layout";
import { blockedWhileCompacting } from "./session-activity";
import { sessionAgentCopy } from "./session-agent-copy";
import { sessionCopyForSurface, sessionReason } from "./session-copy";
import { webLayoutCopy } from "./web-layout-copy";

type ActionFields = Omit<
  Partial<SessionActionBody>,
  "requestId" | "bootId" | "sessionId" | "expectedRevision"
>;

export type SessionToolsProps = {
  open?: boolean;
  onOpenChange?: (value: boolean) => void;
  showTrigger?: boolean;
  ownership?: ReactNode;
  shortcuts?: ReactNode;
};

type SessionToolsSession = {
  current?: ConversationSessionSummary;
  selected: string;
  client: WebClient;
  capabilities?: SessionCapabilities;
  runSessionAction(
    action: SessionAction,
    fields?: ActionFields,
  ): Promise<SessionActionResult | undefined>;
  busy: boolean;
  online: boolean;
  controlReady: boolean;
  locale: InteractionLocale;
  access?: Access | null;
  live?: Live;
  refresh(manual: boolean): Promise<unknown>;
  settingsNotice?: {
    status: "writing" | "uncertain" | "notDispatched";
    reason?: string;
  };
  t: { notDispatched: string };
};

export function SessionTools({
  session,
  onNavigate,
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
  ownership,
  shortcuts,
}: SessionToolsProps & { session: SessionToolsSession; onNavigate(sessionId?: string): void }) {
  const {
    kind,
    copy: { unavailableReason },
    components: {
      Button,
      Input,
      SessionDialog,
      Disclosure,
      DisclosureSummary,
      touchTargetClassName,
    },
    controls: { restrictedModelControls },
  } = useSessionPlatform();
  const {
    current,
    selected,
    client,
    capabilities,
    runSessionAction,
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
  const copy = sessionCopyForSurface(locale, kind);
  const explainReason = (reason?: string) => sessionReason(locale, reason, kind, unavailableReason);
  const agentCopy = sessionAgentCopy[locale];
  const provider = resolveSessionProvider(current, capabilities);
  const registeredQueue =
    current?.id === selected ? registeredSessionQueue(current.agent, provider) : undefined;
  const operationsQueue =
    provider?.operations.execution && registeredQueue?.surface === "operations"
      ? registeredQueue
      : undefined;
  const queueAgent = operationsQueue?.agent;
  const queueReadable = canReadSessionQueue(operationsQueue, selected, capabilities, access);
  const queueScope = JSON.stringify([
    selected,
    queueAgent,
    current?.workspace_id,
    access?.bootId,
    access?.device?.id,
  ]);
  const queueAuthority = useMemo(
    () => ({ client, scope: queueScope, readable: queueReadable }),
    [client, queueScope, queueReadable],
  );
  const isClaude = current?.agent === "claude-code";
  // DeepSeek Harness takes management actions here; its model is set from the composer and its
  // waiting messages sit in the strip above it, so neither is repeated in this panel.
  const isDsh = current?.agent === "deepseek-harness";
  const modelsInOperations = restrictedModelControls === "operation-panel";
  const modelAccessMode = modelsInOperations ? access?.device?.accessMode : undefined;
  const limitedSettings = modelsInOperations && !isClaude && !isDsh && modelAccessMode !== "full";
  const [context, setContext] = useState<unknown>();
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  function setOpen(value: boolean) {
    setLocalOpen(value);
    onOpenChange?.(value);
  }
  const layout = webLayoutCopy[locale];
  const [queueSnapshot, setQueueSnapshot] = useState<{
    authority: typeof queueAuthority;
    queue?: SessionQueue;
    error?: string;
  }>();
  const currentQueue = queueSnapshot?.authority === queueAuthority ? queueSnapshot : undefined;
  const queue = currentQueue?.queue;
  const queueError = currentQueue?.error;
  const [options, setOptions] = useState<ManagedOptions>();
  const [name, setName] = useState("");
  const [queueEdit, setQueueEdit] = useState<{
    authority: typeof queueAuthority;
    id: string;
    text: string;
  }>();
  const editing = queueEdit?.authority === queueAuthority ? queueEdit.id : undefined;
  const text = queueEdit?.authority === queueAuthority ? queueEdit.text : "";
  const [revision, setRevision] = useState(0);
  const [operation, setOperation] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setContext(undefined);
    setOptions(undefined);
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
      if (!queueAgent || !queueReadable) return;
      if (flight) {
        dirty = true;
        return;
      }
      flight = true;
      try {
        do {
          dirty = false;
          try {
            const result = await client.sessionQueue(selected, queueAgent, abort.signal);
            if (!abort.signal.aborted && (!result.sessionId || result.sessionId === selected))
              setQueueSnapshot({ authority: queueAuthority, queue: result });
          } catch (error) {
            if (!abort.signal.aborted) {
              setQueueSnapshot({
                authority: queueAuthority,
                error:
                  error instanceof ApiError && error.code === "queue_too_large"
                    ? copy.queueTooLarge
                    : copy.unavailableQueue,
              });
            }
          }
        } while (dirty && !abort.signal.aborted);
      } finally {
        flight = false;
      }
    };
    void load();
    if (limitedSettings)
      void client
        .request<ManagedOptions>("managed/options", undefined, abort.signal)
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
    modelAccessMode,
    revision,
    copy.queueTooLarge,
    copy.unavailableQueue,
    limitedSettings,
    queueAgent,
    queueReadable,
    queueAuthority,
  ]);
  if (!current || !provider?.operations.execution) return null;
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
    ...(modelsInOperations && { settings: copy.settings }),
    attachments: copy.attachment,
  };
  const reason = (action: SessionAction) =>
    live?.activity === "compacting" && blockedWhileCompacting(action)
      ? contextUsageCopyForSurface(locale, kind).compactingDetail
      : // Only quitting the other process frees the session for deletion.
        action === "delete" && capabilities?.features.delete?.reason === "codex-owner-busy"
        ? copy.deleteOwnerBusy
        : action === "delete" &&
            ["claude-owner-busy", "claude-background-session-running"].includes(
              capabilities?.features.delete?.reason ?? "",
            )
          ? copy.deleteClaudeOwnerBusy
          : explainReason(capabilities?.features[action]?.reason || capabilities?.reason).text;
  async function run(action: SessionAction, fields: ActionFields = {}): Promise<boolean> {
    if (!enabled(action)) return false;
    setOperation(true);
    try {
      const result = await runSessionAction(action, fields);
      if (result) {
        if (action === "inspect") setContext(result.context);
        if (action === "fork" && result.sessionId && result.sessionId !== selected) {
          setOpen(false);
          onNavigate(result.sessionId);
        }
        if (action === "archive" || action === "delete") {
          setConfirmDelete(false);
          setOpen(false);
          onNavigate();
        }
        setQueueEdit(undefined);
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
    itemReason?: string,
  ) => {
    const available = itemAvailable && enabled(action);
    return (
      <div className="min-w-0 max-w-full">
        <Button
          type="button"
          variant="outline"
          size={size}
          className={
            action.startsWith("queue-")
              ? `${touchTargetClassName ?? ""} disabled:pointer-events-auto`
              : touchTargetClassName
          }
          disabled={!available}
          title={available ? undefined : (itemReason ?? reason(action))}
          onClick={() => available && void run(action, fields)}
        >
          {label}
        </Button>
      </div>
    );
  };
  const archiveAction: SessionAction | null =
    capabilities?.features.archive || capabilities?.features.unarchive
      ? current.archived
        ? "unarchive"
        : "archive"
      : null;
  const pendingQueue = operationsQueue
    ? (queue?.data.filter((item) => queueItemPending(item, operationsQueue)) ?? [])
    : [];
  const offeredQueueAction = (action: SessionQueueAction) =>
    operationsQueue?.actions.includes(action) === true;
  const queueReason = (action: SessionQueueAction, itemReason?: string) =>
    explainReason(
      itemReason ||
        (capabilities?.sessionId === selected
          ? capabilities.features[`queue-${action}`]?.reason || capabilities.reason
          : undefined),
    ).text;
  const queuePaused = queue?.requiresResume === true || queue?.paused === true;
  const queuePauseAction =
    queuePaused && offeredQueueAction("resume")
      ? "resume"
      : offeredQueueAction("pause")
        ? "pause"
        : offeredQueueAction("resume")
          ? "resume"
          : undefined;
  // A follower write requires a fresh privileged settings read from the current owner.
  const followerModelReadOnly =
    live?.sessionId === selected && live.executionMode === "codex-follower";
  const limitedModelWritable = enabled("settings") && !followerModelReadOnly;
  const observedSettings =
    live?.sessionId === selected && live.settings?.sessionId === selected
      ? live.settings
      : undefined;
  const limitedModel: SessionSettings | undefined =
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
    limitedSettings && settingsNotice
      ? composerSettingsStatus(
          locale,
          settingsNotice,
          (reason) => explainReason(reason).text,
          t.notDispatched,
        )
      : undefined;
  return (
    <>
      {showTrigger && (
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          {layout.actions}
        </Button>
      )}
      {open && (
        <SessionDialog
          panel
          title={layout.actions}
          closeLabel={copy.close}
          onClose={() => setOpen(false)}
          bodyClassName="space-y-5 leading-5"
        >
          {shortcuts}

          <OperationGroup title={layout.management}>
            <OperationRow className={kind === "web" ? "flex-wrap" : undefined}>
              <label
                className={
                  kind === "web"
                    ? "flex min-w-0 flex-1 basis-56 items-center gap-3"
                    : "flex min-w-0 flex-1 items-center gap-3"
                }
              >
                <span className="shrink-0 text-muted-foreground">{copy.name}</span>
                <Input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
              </label>
              <Button
                variant="outline"
                className={kind === "web" ? touchTargetClassName : "h-8"}
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
                      className={touchTargetClassName}
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
                      className={touchTargetClassName}
                      disabled={!enabled("delete")}
                      onClick={() => void run("delete")}
                    >
                      {copy.deleteConfirm}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className={touchTargetClassName}
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
          {provider.connection?.kind === "terminal-bridge" && ownership}
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
          {operationsQueue && (queue || queueError || queuePauseAction) && (
            <OperationGroup title={operationsQueue.title?.(locale) ?? copy.queue}>
              {queuePauseAction && (
                <OperationRow className="flex-wrap gap-2">
                  {queuePaused && (
                    <p role="status" className="min-w-0 flex-1 text-muted-foreground">
                      {queue?.requiresResume ? agentCopy.queueRecovery : agentCopy.queuePaused}
                    </p>
                  )}
                  {actionButton(
                    `queue-${queuePauseAction}`,
                    queuePauseAction === "resume" ? agentCopy.resumeQueue : agentCopy.pauseQueue,
                    {},
                    !!queue &&
                      (queuePauseAction === "resume"
                        ? queuePaused
                        : !queuePaused && queue.data.length > 0),
                    "sm",
                    queue?.data.length === 0 && !queuePaused
                      ? copy.queueEmpty
                      : queueReason(queuePauseAction),
                  )}
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
                const pending = pendingIndex >= 0;
                const editable =
                  pending && !item.hasAttachments && item.actions?.update?.available !== false;
                const canEdit =
                  editable && enabled("queue-update") && (editing !== item.id || !!text.trim());
                return (
                  <OperationRow key={item.id} className="block space-y-2">
                    <p className="whitespace-pre-wrap break-words">{item.text || item.id}</p>
                    {item.hasAttachments && (
                      <p className="text-xs text-muted-foreground">{copy.queueAttachments}</p>
                    )}
                    {offeredQueueAction("update") && editing === item.id && editable && (
                      <Input
                        aria-label={copy.text}
                        value={text}
                        onChange={(e) =>
                          setQueueEdit({
                            authority: queueAuthority,
                            id: item.id,
                            text: e.target.value,
                          })
                        }
                      />
                    )}
                    <div className="flex flex-wrap gap-2">
                      {offeredQueueAction("update") && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className={`${touchTargetClassName ?? ""} disabled:pointer-events-auto`}
                          disabled={!canEdit}
                          title={
                            canEdit
                              ? undefined
                              : item.hasAttachments
                                ? copy.queueAttachments
                                : queueReason("update", item.actions?.update?.reason)
                          }
                          onClick={() => {
                            if (!canEdit) return;
                            if (editing === item.id)
                              void run("queue-update", { queuedSubmissionId: item.id, text });
                            else
                              setQueueEdit({
                                authority: queueAuthority,
                                id: item.id,
                                text: item.text ?? "",
                              });
                          }}
                        >
                          {copy.queueUpdate}
                        </Button>
                      )}
                      {offeredQueueAction("delete") &&
                        actionButton(
                          "queue-delete",
                          copy.queueDelete,
                          { queuedSubmissionId: item.id },
                          pending && item.actions?.delete?.available !== false,
                          "sm",
                          queueReason("delete", item.actions?.delete?.reason),
                        )}
                      {offeredQueueAction("reorder") &&
                        actionButton(
                          "queue-reorder",
                          copy.queueUp,
                          pendingIndex > 0
                            ? {
                                queuedSubmissionIds: pendingQueue.map((entry, position) =>
                                  position === pendingIndex - 1
                                    ? item.id
                                    : position === pendingIndex
                                      ? pendingQueue[pendingIndex - 1]!.id
                                      : entry.id,
                                ),
                              }
                            : {},
                          pendingIndex > 0,
                          "sm",
                          queueReason("reorder"),
                        )}
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
                  ? `${capabilities.status}${capabilities.reason ? ` · ${explainReason(capabilities.reason).text}` : ""}`
                  : copy.unavailable}
              </p>
            </div>
            <ul className="space-y-1 text-xs text-muted-foreground empty:hidden">
              {Object.entries(capabilities?.features ?? {})
                .filter(
                  ([action, feature]) =>
                    !feature?.available &&
                    (action !== "resume" || isClaude) &&
                    (action !== "queue-start" ||
                      (offeredQueueAction("start") && !operationsQueue?.automatic)),
                )
                .map(([action, feature]) => {
                  const explanation = explainReason(feature?.reason);
                  return (
                    <li key={action}>
                      {actionLabels[action] ?? action}: {explanation.text}
                      {explanation.technical && (
                        <Disclosure>
                          <DisclosureSummary>{copy.context}</DisclosureSummary>
                          <code className="break-all">{feature?.reason}</code>
                        </Disclosure>
                      )}
                    </li>
                  );
                })}
            </ul>
            <div className="flex flex-wrap items-start gap-2">
              <Button
                variant="outline"
                size="sm"
                className={touchTargetClassName}
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
        </SessionDialog>
      )}
    </>
  );
}
