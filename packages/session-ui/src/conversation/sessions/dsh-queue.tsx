import { useEffect, useState } from "react";
import {
  CornerDownRight,
  ListEnd,
  ListPlus,
  MoreHorizontal,
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
import { sessionQueuePanel, type SessionQueuePanelAgent } from "../../agents/session-queue";
import type { InteractionLocale } from "../../interaction-model";
import { resolveSessionProvider } from "../../session-provider";
import { retryBusyRead } from "../../session-read-retry";
import { useSessionPlatform } from "../../session-platform";
import { codexCopy, codexCopyForSurface, codexReason } from "./codex-copy";
import { sessionAgentCopy } from "./session-agent-copy";

type QueueControl = "update" | "delete" | "steer" | "pause" | "resume";
type QueueAction = `queue-${QueueControl}`;

type SendQueueSession = {
  selected: string;
  client: WebClient;
  capabilities?: SessionCapabilities;
  codexAction: (
    action: QueueAction | "queue-add",
    fields?: { queuedSubmissionId?: string; text?: string },
  ) => Promise<unknown>;
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
    copy: { unavailableReason },
    components: {
      Button,
      Input,
      DropdownMenu,
      DropdownMenuContent,
      DropdownMenuItem,
      DropdownMenuTrigger,
    },
  } = useSessionPlatform();
  const {
    selected,
    client,
    capabilities,
    codexAction,
    busy,
    online,
    controlReady,
    locale,
    access,
  } = session;
  const copy = codexCopyForSurface(locale, kind);
  const agentCopy = sessionAgentCopy[locale];
  const panel = sessionQueuePanel(
    agent,
    resolveSessionProvider({ id: selected, agent }, capabilities),
  );
  const serial = panel?.serial === true;
  const offered = (action: QueueControl) => panel?.actions.includes(action) === true;
  const [queue, setQueue] = useState<SessionQueue>();
  const [error, setError] = useState("");
  const [editing, setEditing] = useState("");
  const [text, setText] = useState("");
  const [operation, setOperation] = useState(false);
  const [reload, setReload] = useState(0);
  const readable =
    !!panel &&
    capabilities?.sessionId === selected &&
    capabilities.features["queue-list"]?.available === true &&
    (!serial || (access?.status === "approved" && access.device?.advancedControl === true));
  // The live state changes with every streamed chunk; the queue is read again only when the
  // host says it changed. DSH reports a queued message before the host has finished the
  // control that queued it, and the host turns reads away until then, so a settled control
  // ("receipts") is a reason to read again too.
  useEffect(() => {
    if (serial && !readable) return;
    return subscribeSessionInvalidation(client, (id, domains) => {
      if ((!id || id === selected) && (domains.includes("queue") || domains.includes("receipts")))
        setReload((n) => n + 1);
    });
  }, [client, selected, readable, serial]);
  // The composer mounts one per session, so nothing carries over from another session.
  useEffect(() => {
    if (!readable) return;
    const abort = new AbortController();
    retryBusyRead(() => client.sessionQueue(selected, agent, abort.signal), abort.signal).then(
      (value) => {
        if (abort.signal.aborted || (value.sessionId && value.sessionId !== selected)) return;
        setQueue(value);
        setError("");
      },
      (reason) => {
        if (abort.signal.aborted) return;
        // Keep the last known items in view; the note says they may be out of date.
        setError(
          reason instanceof ApiError && reason.code === "queue_too_large"
            ? copy.queueTooLarge
            : copy.unavailableQueue,
        );
      },
    );
    return () => abort.abort();
  }, [client, selected, agent, readable, reload, copy.queueTooLarge, copy.unavailableQueue]);
  if (!readable || (serial ? !queue && !error : !queue?.data.length)) return null;
  const paused = queue?.paused === true || queue?.requiresResume === true;
  const pauseAction = paused ? "resume" : "pause";
  const enabled = (action: QueueControl) =>
    !!(
      access?.experimentalEnabled &&
      !busy &&
      !operation &&
      online &&
      controlReady &&
      offered(action) &&
      capabilities?.features[`queue-${action}`]?.available
    );
  const reason = (action: QueueControl, itemReason?: string) =>
    codexReason(
      locale,
      itemReason || capabilities?.features[`queue-${action}`]?.reason || capabilities?.reason,
      kind,
      unavailableReason,
    ).text;
  async function run(action: QueueControl, fields?: { queuedSubmissionId: string; text?: string }) {
    if (!enabled(action)) return;
    setOperation(true);
    try {
      if (await codexAction(`queue-${action}`, fields)) {
        setEditing("");
        setText("");
        if (serial) setReload((n) => n + 1);
      }
    } finally {
      setOperation(false);
    }
  }
  return (
    // Opaque: the conversation scrolls behind the composer area.
    <div className="mx-4 -mb-6 rounded-t-2xl border border-b-0 bg-card px-3 pt-1 pb-6 text-sm">
      {error && <p className="py-1 text-xs text-muted-foreground">{error}</p>}
      {serial && queue && (
        <div className="flex min-h-9 items-center justify-between gap-2">
          <span className="min-w-0 text-xs text-muted-foreground">
            {paused
              ? queue.data.some((item) => item.status === "unknown")
                ? agentCopy.queueRecovery
                : agentCopy.queuePaused
              : queue.data.length
                ? copy.queue
                : copy.queueEmpty}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!enabled(pauseAction)}
            title={enabled(pauseAction) ? undefined : reason(pauseAction)}
            onClick={() => void run(pauseAction)}
          >
            {paused ? agentCopy.resumeQueue : agentCopy.pauseQueue}
          </Button>
        </div>
      )}
      <ul aria-label={copy.queue}>
        {queue?.data.map((item) => {
          const editable = !serial || item.status === undefined || item.status === "pending";
          const removable = editable || item.status === "unknown";
          const canEdit =
            editable && !item.hasAttachments && item.actions?.update?.available !== false;
          const editTitle =
            canEdit && enabled("update")
              ? undefined
              : item.hasAttachments
                ? copy.queueAttachments
                : reason("update", item.actions?.update?.reason);
          const canRemove =
            removable && enabled("delete") && item.actions?.delete?.available !== false;
          const canSteer = enabled("steer") && item.actions?.steer?.available !== false;
          return (
            <li key={item.id} className="flex min-h-10 min-w-0 items-center gap-1">
              <ListEnd
                size={16}
                aria-hidden="true"
                className="mr-1 shrink-0 text-muted-foreground"
              />
              {editing === item.id && canEdit ? (
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
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditing("");
                    }}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={!enabled("update") || !text.trim()}
                    title={editTitle}
                  >
                    {copy.queueSave}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing("")}>
                    {copy.cancel}
                  </Button>
                </form>
              ) : (
                <>
                  {/* DSH edits text only, so a message with images can be withdrawn but not edited. */}
                  {item.hasAttachments && (
                    <span className="shrink-0 text-muted-foreground" title={copy.queueAttachments}>
                      <Paperclip size={14} role="img" aria-label={copy.queueAttachments} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate" title={item.text}>
                    {item.text || (item.hasAttachments ? "" : item.id)}
                  </span>
                  {offered("steer") && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-muted-foreground"
                      disabled={!canSteer}
                      title={canSteer ? copy.steer : reason("steer", item.actions?.steer?.reason)}
                      onClick={() => canSteer && void run("steer", { queuedSubmissionId: item.id })}
                    >
                      <CornerDownRight size={16} aria-hidden="true" />
                      {copy.queueSteerItem}
                    </Button>
                  )}
                  {offered("delete") && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground"
                      aria-label={copy.queueDelete}
                      title={
                        canRemove
                          ? copy.queueDelete
                          : reason("delete", item.actions?.delete?.reason)
                      }
                      disabled={!canRemove}
                      onClick={() =>
                        canRemove && void run("delete", { queuedSubmissionId: item.id })
                      }
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </Button>
                  )}
                  {offered("update") && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        type="button"
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label={copy.advanced}
                        title={copy.advanced}
                      >
                        <MoreHorizontal size={16} aria-hidden="true" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="top" align="end">
                        <DropdownMenuItem
                          disabled={!canEdit || !enabled("update")}
                          title={editTitle}
                          onClick={() => {
                            setEditing(item.id);
                            setText(item.text ?? "");
                          }}
                        >
                          <Pencil size={16} aria-hidden="true" />
                          {copy.queueEditItem}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
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
    codexAction: dispatch,
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
  if (
    panel?.surface !== "basic" ||
    access?.device?.advancedControl !== true ||
    capabilities?.sessionId !== selected ||
    capabilities.features["queue-list"]?.available !== true
  )
    return {};

  const text = message.trim();
  const canQueue =
    access.experimentalEnabled &&
    online &&
    !busy &&
    controlReady &&
    access.device.send === true &&
    capabilities.features["queue-add"]?.available === true &&
    !!text &&
    !historyReferences.length;
  const label = codexCopy[locale].queueAdd;
  return {
    list: (
      <SessionSendQueue
        key={JSON.stringify([selected, access.bootId, access.device.id])}
        agent={panel.agent}
        session={session}
      />
    ),
    action: (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        title={label}
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
