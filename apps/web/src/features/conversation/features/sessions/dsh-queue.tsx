import { useEffect, useState } from "react";
import { CornerDownRight, ListEnd, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { ApiError, type SessionQueue } from "@agentkib/web-client";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { useSession } from "./session-context";
import { subscribeSessionInvalidation } from "./session-events";
import { retryBusyRead } from "./session-read-retry";
import { codexCopyForSurface, codexReason } from "./codex-copy";

type QueueAction = "queue-update" | "queue-delete" | "queue-steer";

/**
 * Messages DSH holds for its next turn, stacked above the composer: move one into the running
 * turn, edit it or withdraw it. Steering never shows here; it already went into the turn.
 */
export function DshQueue() {
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
  const copy = codexCopyForSurface(locale, "web");
  const [queue, setQueue] = useState<SessionQueue>();
  const [error, setError] = useState("");
  const [editing, setEditing] = useState("");
  const [text, setText] = useState("");
  const [operation, setOperation] = useState(false);
  const [reload, setReload] = useState(0);
  const readable =
    capabilities?.sessionId === selected && capabilities.features["queue-list"]?.available === true;
  // The live state changes with every streamed chunk; the queue is read again only when the
  // host says it changed. DSH reports a queued message before the host has finished the
  // control that queued it, and the host turns reads away until then, so a settled control
  // ("receipts") is a reason to read again too.
  useEffect(
    () =>
      subscribeSessionInvalidation(client, (id, domains) => {
        if ((!id || id === selected) && (domains.includes("queue") || domains.includes("receipts")))
          setReload((n) => n + 1);
      }),
    [client, selected],
  );
  // The composer mounts one per session, so nothing carries over from another session.
  useEffect(() => {
    if (!readable) return;
    const abort = new AbortController();
    retryBusyRead(
      () => client.sessionQueue(selected, "deepseek-harness", abort.signal),
      abort.signal,
    ).then(
      (value) => {
        if (abort.signal.aborted) return;
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
  }, [client, selected, readable, reload, copy.queueTooLarge, copy.unavailableQueue]);
  if (!readable || !queue?.data.length) return null;
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
    codexReason(locale, capabilities?.features[action]?.reason || capabilities?.reason, "web").text;
  async function run(action: QueueAction, fields: { queuedSubmissionId: string; text?: string }) {
    if (!enabled(action)) return;
    setOperation(true);
    try {
      if (await codexAction(action, fields)) {
        setEditing("");
        setText("");
      }
    } finally {
      setOperation(false);
    }
  }
  return (
    // Opaque: the conversation scrolls behind the composer area.
    <div className="mx-4 -mb-6 rounded-t-2xl border border-b-0 bg-card px-3 pt-1 pb-6 text-sm">
      {error && <p className="py-1 text-xs text-muted-foreground">{error}</p>}
      <ul aria-label={copy.queue}>
        {queue.data.map((item) => (
          <li key={item.id} className="flex min-h-10 min-w-0 items-center gap-1">
            <ListEnd size={16} aria-hidden="true" className="mr-1 shrink-0 text-muted-foreground" />
            {editing === item.id ? (
              <form
                className="flex min-w-0 flex-1 items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (text.trim()) void run("queue-update", { queuedSubmissionId: item.id, text });
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
                <span className="min-w-0 flex-1 truncate" title={item.text}>
                  {item.text || item.id}
                </span>
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
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground"
                  aria-label={copy.queueDelete}
                  title={enabled("queue-delete") ? copy.queueDelete : reason("queue-delete")}
                  disabled={!enabled("queue-delete")}
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
                      disabled={!enabled("queue-update")}
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
        ))}
      </ul>
    </div>
  );
}
