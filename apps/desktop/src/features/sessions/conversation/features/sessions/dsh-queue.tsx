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
import { ApiError, type SessionQueue } from "@agentkib/web-client";
import {
  sessionQueuePanel,
  type SessionQueuePanelAgent,
  retryBusyRead,
} from "@agentkib/session-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSession } from "./session-context";
import { subscribeSessionInvalidation } from "@agentkib/conversation-state";
import { codexCopy, codexReason } from "./codex-copy";
import { sessionAgentCopy } from "./session-agent-copy";

type QueueAction = "queue-update" | "queue-delete" | "queue-steer" | "queue-pause" | "queue-resume";

export function SessionSendQueue({ agent }: { agent: SessionQueuePanelAgent }) {
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
  } = useSession();
  const copy = codexCopy[locale];
  const agentCopy = sessionAgentCopy[locale];
  const serial = sessionQueuePanel(agent)?.serial === true;
  const [queue, setQueue] = useState<SessionQueue>();
  const [error, setError] = useState("");
  const [editing, setEditing] = useState("");
  const [text, setText] = useState("");
  const [operation, setOperation] = useState(false);
  const [reload, setReload] = useState(0);
  const readable =
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
  const pauseAction = paused ? "queue-resume" : "queue-pause";
  const enabled = (action: QueueAction) =>
    !!(
      access?.experimentalEnabled &&
      !busy &&
      !operation &&
      online &&
      controlReady &&
      capabilities?.features[action]?.available
    );
  const reason = (action: QueueAction) =>
    codexReason(locale, capabilities?.features[action]?.reason || capabilities?.reason).text;
  async function run(action: QueueAction, fields?: { queuedSubmissionId: string; text?: string }) {
    if (!enabled(action)) return;
    setOperation(true);
    try {
      if (await codexAction(action, fields)) {
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
          return (
            <li key={item.id} className="flex min-h-10 min-w-0 items-center gap-1">
              <ListEnd
                size={16}
                aria-hidden="true"
                className="mr-1 shrink-0 text-muted-foreground"
              />
              {editing === item.id && editable ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (text.trim())
                      void run("queue-update", { queuedSubmissionId: item.id, text });
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
                    disabled={!enabled("queue-update") || !text.trim()}
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
                  {!serial && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-muted-foreground"
                      disabled={!enabled("queue-steer")}
                      title={enabled("queue-steer") ? copy.steer : reason("queue-steer")}
                      onClick={() => void run("queue-steer", { queuedSubmissionId: item.id })}
                    >
                      <CornerDownRight size={16} aria-hidden="true" />
                      {copy.queueSteerItem}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground"
                    aria-label={copy.queueDelete}
                    title={enabled("queue-delete") ? copy.queueDelete : reason("queue-delete")}
                    disabled={!removable || !enabled("queue-delete")}
                    onClick={() => void run("queue-delete", { queuedSubmissionId: item.id })}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
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
                        disabled={
                          !editable || !enabled("queue-update") || item.hasAttachments === true
                        }
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
export function basicSendQueue(session: ReturnType<typeof useSession>) {
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
  const panel = sessionQueuePanel(current?.agent);
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
