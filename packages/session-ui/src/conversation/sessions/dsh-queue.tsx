import { useEffect, useMemo, useState } from "react";
import {
  ArrowUp,
  CornerDownRight,
  ListEnd,
  ListPlus,
  Paperclip,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  ApiError,
  type Access,
  type ConversationSessionSummary,
  type ResolvedHistoryReference,
  type SessionCapabilities,
  type SessionQueue,
  type WebClient,
} from "@agentkib/web-client";
import { subscribeSessionInvalidation } from "@agentkib/conversation-state";
import {
  canReadSessionQueue,
  moveQueuedItemUp,
  queueActionGranted,
  queueItemPending,
  reorderableQueueItems,
  sessionQueuePanel,
  type SessionQueuePanelAgent,
} from "../../agents/session-queue";
import type { InteractionLocale } from "../../interaction-model";
import { resolveSessionProvider } from "../../session-provider";
import { retryBusyRead } from "../../session-read-retry";
import { useSessionPlatform } from "../../session-platform";
import { sessionCopy, sessionCopyForSurface } from "./session-copy";
import { sessionAgentCopy } from "./session-agent-copy";

type QueueControl = "update" | "delete" | "reorder" | "steer" | "pause" | "resume";
type QueueAction = `queue-${QueueControl}`;
type QueueFields = { queuedSubmissionId?: string; queuedSubmissionIds?: string[]; text?: string };

type SendQueueSession = {
  selected: string;
  client: WebClient;
  capabilities?: SessionCapabilities;
  runSessionAction: (action: QueueAction | "queue-add", fields?: QueueFields) => Promise<unknown>;
  busy: boolean;
  online: boolean;
  controlReady: boolean;
  locale: InteractionLocale;
  access?: Access | null;
};

export function SessionSendQueue({
  agent,
  session,
}: {
  agent: SessionQueuePanelAgent;
  session: SendQueueSession;
}) {
  const {
    kind,
    components: { Button, Input },
  } = useSessionPlatform();
  const {
    selected,
    client,
    capabilities,
    runSessionAction,
    busy,
    online,
    controlReady,
    locale,
    access,
  } = session;
  const copy = sessionCopyForSurface(locale, kind);
  const agentCopy = sessionAgentCopy[locale];
  const panel = sessionQueuePanel(
    agent,
    resolveSessionProvider({ id: selected, agent }, capabilities),
  );
  const serial = panel?.serial === true;
  const readable = canReadSessionQueue(panel, selected, capabilities, access);
  const scope = JSON.stringify([selected, agent, access?.bootId, access?.device?.id]);
  const authority = useMemo(() => ({ client, scope, readable }), [client, scope, readable]);
  const [snapshot, setSnapshot] = useState<{
    authority: typeof authority;
    queue?: SessionQueue;
    error?: string;
  }>();
  const [edit, setEdit] = useState<{ authority: typeof authority; id: string; text: string }>();
  const editing = edit?.authority === authority ? edit.id : undefined;
  const text = edit?.authority === authority ? edit.text : "";
  const [operation, setOperation] = useState(false);
  const [reload, setReload] = useState(0);
  const current = snapshot?.authority === authority ? snapshot : undefined;
  const queue = current?.queue;
  const error = current?.error;
  // The live state changes with every streamed chunk; the queue is read again only when the
  // host says it changed. DSH reports a queued message before the host has finished the
  // control that queued it, and the host turns reads away until then, so a settled control
  // ("receipts") is a reason to read again too.
  useEffect(() => {
    if (!readable) return;
    return subscribeSessionInvalidation(client, (id, domains) => {
      if ((!id || id === selected) && (domains.includes("queue") || domains.includes("receipts")))
        setReload((n) => n + 1);
    });
  }, [client, selected, readable]);
  // The composer mounts one per session, so nothing carries over from another session.
  useEffect(() => {
    if (!readable) return;
    const abort = new AbortController();
    retryBusyRead(() => client.sessionQueue(selected, agent, abort.signal), abort.signal).then(
      (value) => {
        if (abort.signal.aborted || (value.sessionId && value.sessionId !== selected)) return;
        setSnapshot({ authority, queue: value });
      },
      (reason) => {
        if (abort.signal.aborted) return;
        // Keep the last known items in view; the note says they may be out of date.
        setSnapshot((prior) => ({
          authority,
          queue: prior?.authority === authority ? prior.queue : undefined,
          error:
            reason instanceof ApiError && reason.code === "queue_too_large"
              ? copy.queueTooLarge
              : copy.unavailableQueue,
        }));
      },
    );
    return () => abort.abort();
  }, [
    client,
    selected,
    agent,
    readable,
    reload,
    authority,
    copy.queueTooLarge,
    copy.unavailableQueue,
  ]);
  if (!panel) return null;
  const paused = queue?.paused === true || queue?.requiresResume === true;
  const pauseAction = paused ? "resume" : "pause";
  const reorderable = reorderableQueueItems(queue?.data, panel);
  const enabled = (action: QueueControl) =>
    !!(
      access?.experimentalEnabled &&
      !busy &&
      !operation &&
      online &&
      controlReady &&
      readable &&
      !error &&
      queueActionGranted(panel, action, access) &&
      capabilities?.sessionId === selected &&
      capabilities.features[`queue-${action}`]?.available
    );
  async function run(action: QueueControl, fields?: QueueFields) {
    if (!enabled(action)) return;
    setOperation(true);
    try {
      if (await runSessionAction(`queue-${action}`, fields)) {
        setEdit(undefined);
        if (serial || action === "reorder") setReload((n) => n + 1);
      }
    } finally {
      setOperation(false);
    }
  }
  if (!readable) {
    return (
      <div className="mx-4">
        <Button type="button" size="sm" variant="ghost" disabled>
          {copy.queue}
        </Button>
      </div>
    );
  }
  if (!serial && !queue?.data.length && !error) return null;
  return (
    // Opaque: the conversation scrolls behind the composer area.
    <div className="mx-4 -mb-6 rounded-t-2xl border border-b-0 bg-card px-3 pt-1 pb-6 text-sm">
      {error && (
        <p role="status" className="py-1 text-xs text-muted-foreground">
          {error}
        </p>
      )}
      {(serial || !!queue?.data.length) && (
        <div className="flex min-h-9 items-center justify-between gap-2">
          <span className="min-w-0 text-xs text-muted-foreground">
            {paused
              ? queue?.data.some((item) => item.status === "unknown")
                ? agentCopy.queueRecovery
                : agentCopy.queuePaused
              : queue?.data.length === 0
                ? copy.queueEmpty
                : copy.queue}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!queue || !enabled(pauseAction)}
            onClick={() => queue && void run(pauseAction)}
          >
            {paused ? agentCopy.resumeQueue : agentCopy.pauseQueue}
          </Button>
        </div>
      )}
      <ul aria-label={copy.queue} className="empty:hidden">
        {queue?.data.map((item) => {
          const pending = queueItemPending(item, panel);
          const editable = !serial || pending;
          const removable = editable || item.status === "unknown";
          const editableText =
            editable && !item.hasAttachments && item.actions?.update?.available !== false;
          const canEdit = editableText && enabled("update");
          const canRemove =
            removable && enabled("delete") && item.actions?.delete?.available !== false;
          const canSteer = pending && enabled("steer") && item.actions?.steer?.available !== false;
          const reorderIndex = reorderable.findIndex((entry) => entry.id === item.id);
          const canMoveUp = reorderIndex > 0 && enabled("reorder");
          return (
            <li key={item.id} className="flex min-h-10 min-w-0 items-center gap-1">
              <ListEnd
                size={16}
                aria-hidden="true"
                className="mr-1 shrink-0 text-muted-foreground"
              />
              {editing === item.id && editableText ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (canEdit && text.trim())
                      void run("update", { queuedSubmissionId: item.id, text });
                  }}
                >
                  <Input
                    aria-label={copy.text}
                    className="h-8 min-w-0 flex-1"
                    value={text}
                    autoFocus
                    onChange={(event) =>
                      setEdit({ authority, id: item.id, text: event.target.value })
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEdit(undefined);
                    }}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={!enabled("update") || !text.trim()}
                  >
                    {copy.queueSave}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setEdit(undefined)}
                  >
                    {copy.cancel}
                  </Button>
                </form>
              ) : (
                <>
                  {/* DSH edits text only, so a message with images can be withdrawn but not edited. */}
                  {item.hasAttachments && (
                    <span className="shrink-0 text-muted-foreground">
                      <Paperclip size={14} role="img" aria-label={copy.queueAttachments} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate" title={item.text}>
                    {item.text || (item.hasAttachments ? "" : item.id)}
                  </span>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground"
                    aria-label={copy.queueSteerItem}
                    title={canSteer ? copy.steer : undefined}
                    disabled={!canSteer}
                    onClick={() => canSteer && void run("steer", { queuedSubmissionId: item.id })}
                  >
                    <CornerDownRight size={16} aria-hidden="true" />
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground"
                    aria-label={copy.queueDelete}
                    title={canRemove ? copy.queueDelete : undefined}
                    disabled={!canRemove}
                    onClick={() => canRemove && void run("delete", { queuedSubmissionId: item.id })}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground"
                    aria-label={copy.queueUp}
                    title={canMoveUp ? copy.queueUp : undefined}
                    disabled={!canMoveUp}
                    onClick={() =>
                      canMoveUp &&
                      void run("reorder", {
                        queuedSubmissionIds: moveQueuedItemUp(reorderable, reorderIndex),
                      })
                    }
                  >
                    <ArrowUp size={16} aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground"
                    aria-label={copy.queueEditItem}
                    title={canEdit ? copy.queueEditItem : undefined}
                    disabled={!canEdit}
                    onClick={() =>
                      canEdit && setEdit({ authority, id: item.id, text: item.text ?? "" })
                    }
                  >
                    <Pencil size={16} aria-hidden="true" />
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Queue controls for a basic composer. The current session and device own the pending draft. */
export function useBasicSendQueue(
  session: SendQueueSession & {
    current?: ConversationSessionSummary;
    historyReferences?: readonly ResolvedHistoryReference[];
    message: string;
    setMessage(value: string): void;
  },
) {
  const {
    components: { Button },
  } = useSessionPlatform();
  const {
    access,
    busy,
    capabilities,
    runSessionAction: dispatch,
    controlReady,
    current,
    historyReferences = [],
    locale,
    message,
    online,
    selected,
    setMessage,
  } = session;
  const panel =
    current?.id === selected
      ? sessionQueuePanel(current.agent, resolveSessionProvider(current, capabilities))
      : undefined;
  if (panel?.surface !== "basic") return {};

  const text = message.trim();
  const readable = canReadSessionQueue(panel, selected, capabilities, access);
  const canQueue =
    access?.experimentalEnabled &&
    online &&
    !busy &&
    controlReady &&
    readable &&
    queueActionGranted(panel, "add", access) &&
    capabilities?.features["queue-add"]?.available === true &&
    !!text &&
    !historyReferences.length;
  const label = sessionCopy[locale].queueAdd;
  return {
    list: (
      <SessionSendQueue
        key={JSON.stringify([selected, access?.bootId, access?.device?.id])}
        agent={panel.agent}
        session={session}
      />
    ),
    action: panel.actions.includes("add") && (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        title={canQueue ? label : undefined}
        disabled={!canQueue}
        onClick={() => {
          if (canQueue)
            void dispatch("queue-add", { text }).then((result) => {
              if (result) setMessage("");
            });
        }}
      >
        <ListPlus size={16} aria-hidden="true" />
      </Button>
    ),
  };
}
