import type { ConversationEvent } from "@agentkib/web-client";
import {
  SafeMarkdown,
  ToolDetailRow,
  TurnFileChanges,
  formatToolDuration,
  isHiddenWrapperTool,
  toolDetailCopy,
  turnDurationOf,
} from "@agentkib/session-ui";
import { Button } from "@/components/ui/button";
import { groupConversationEvents } from "@/features/sessions/conversation-groups";
import type { ConversationEvent as DesktopConversationEvent } from "@/core/types";
import { ChevronRight, CircleAlert, Wrench } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { toolStatusLabel } from "./tool-status";

interface ReaderLabels {
  process: string;
  tools: string;
  failed: string;
  incomplete: string;
  details: string;
  attachments: string;
  truncated: string;
  unknownTool: string;
}

type TranscriptGroup = ReturnType<typeof groupConversationEvents>[number];
type TranscriptSegment = TranscriptGroup["segments"][number];

type TranscriptMessage = {
  id: string;
  role: "assistant" | "user";
  turnId?: string;
  events: DesktopConversationEvent[];
  segments: TranscriptSegment[];
  time?: string;
  running: boolean;
};

function normalizeEvent(event: ConversationEvent): DesktopConversationEvent {
  const { turn_id, message_phase, ...rest } = event;
  return {
    ...rest,
    ...(turn_id ? { turn_id } : {}),
    ...(message_phase ? { message_phase } : {}),
  };
}

function withEvents(segment: TranscriptSegment, events: DesktopConversationEvent[]) {
  return { ...segment, events };
}

function splitSegments(
  segments: TranscriptSegment[],
  predicate: (event: DesktopConversationEvent) => boolean,
) {
  return segments
    .map((segment) => withEvents(segment, segment.events.filter(predicate)))
    .filter((segment) => segment.events.length > 0);
}

function projectMessages(events: ConversationEvent[], incomplete: boolean): TranscriptMessage[] {
  // A wrapper call is shown through the items it recorded, not as its own row.
  const visible = events.filter((event) => !isHiddenWrapperTool(event));
  const groups = groupConversationEvents(visible.map(normalizeEvent), { incomplete });
  const messages: TranscriptMessage[] = [];
  for (const group of groups) {
    let start = 0;
    while (start < group.events.length) {
      const role: TranscriptMessage["role"] =
        group.events[start].kind === "user-message" ? "user" : "assistant";
      let end = start + 1;
      while (
        end < group.events.length &&
        (group.events[end].kind === "user-message" ? "user" : "assistant") === role
      ) {
        end += 1;
      }
      const runEvents = group.events.slice(start, end);
      const runEventIds = new Set(runEvents.map((event) => event.id));
      messages.push({
        id: `${group.key}:${role}:${start}`,
        role,
        turnId: group.turnId,
        events: runEvents,
        segments: splitSegments(group.segments, (event) => runEventIds.has(event.id)),
        time: start === 0 ? group.timestamp : undefined,
        running:
          role === "assistant" && runEvents.some((event) => event.id.startsWith("session-live:")),
      });
      start = end;
    }
  }
  return messages;
}

interface TranscriptProjection {
  events: ConversationEvent[];
  incomplete: boolean;
  messages: TranscriptMessage[];
  nextKey: number;
}

function projectTranscript(
  events: ConversationEvent[],
  incomplete: boolean,
  previous?: TranscriptProjection,
): TranscriptProjection {
  const messages = projectMessages(events, incomplete);
  const previousByItem = new Map<string, TranscriptMessage>();
  for (const message of previous?.messages ?? [])
    for (const event of message.events) previousByItem.set(event.id, message);
  const usedMessages = new Set<string>();
  let nextKey = previous?.nextKey ?? 0;
  for (const message of messages) {
    // A page can prepend tools or the missing user message to an existing turn.
    // Keep role runs and process bodies mounted using their shared event IDs,
    // without joining distinct runs that happen to carry the same turn ID.
    const prior = message.events
      .map((event) => previousByItem.get(event.id))
      .find(
        (candidate) =>
          candidate &&
          !usedMessages.has(candidate.id) &&
          candidate.role === message.role &&
          candidate.turnId === message.turnId,
      );
    if (prior) usedMessages.add(prior.id);
    message.id = prior?.id ?? `message:${nextKey++}`;
    const previousProcesses = new Map<string, TranscriptSegment>();
    for (const segment of prior?.segments ?? [])
      if (segment.kind === "process")
        for (const event of segment.events) previousProcesses.set(event.id, segment);
    const usedProcesses = new Set<string>();
    for (const segment of message.segments) {
      if (segment.kind !== "process") continue;
      const priorProcess = segment.events
        .map((event) => previousProcesses.get(event.id))
        .find((candidate) => candidate && !usedProcesses.has(candidate.key));
      if (priorProcess) usedProcesses.add(priorProcess.key);
      segment.key = priorProcess?.key ?? `process:${nextKey++}`;
    }
  }
  return { events, incomplete, messages, nextKey };
}

function EventRow({
  event,
  labels,
  locale,
  onTool,
}: {
  event: DesktopConversationEvent;
  labels: ReaderLabels;
  locale: string;
  onTool: (event: ConversationEvent) => void;
}) {
  const isTool = event.kind === "tool-summary";
  if (isTool && event.tool)
    return (
      <ToolDetailRow
        event={{ ...event, tool: event.tool }}
        locale={locale}
        statusLabel={toolStatusLabel(event.tool_status, locale)}
      />
    );
  return (
    <div
      data-event-id={event.id}
      className={isTool ? "flex min-w-0" : "aui-markdown min-w-0 break-words"}
    >
      {isTool ? (
        <Button
          type="button"
          variant="ghost"
          aria-label={`${event.tool_name || labels.unknownTool} ${toolStatusLabel(event.tool_status, locale)}`}
          className="group/tool flex h-auto min-w-0 max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-normal text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onTool(event)}
        >
          <Wrench aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate text-foreground">
            {event.tool_name || labels.unknownTool}
          </span>
          <span className="shrink-0">{toolStatusLabel(event.tool_status, locale)}</span>
          <ChevronRight
            aria-hidden="true"
            className="ml-auto size-3.5 shrink-0 opacity-50 transition-transform group-hover/tool:translate-x-0.5"
          />
        </Button>
      ) : (
        event.content && <SafeMarkdown text={event.content} />
      )}
      {(event.attachment_count > 0 || event.truncated) && (
        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          {event.attachment_count > 0 && (
            <span className="rounded-md bg-muted px-2 py-1">
              {labels.attachments}: {event.attachment_count}
            </span>
          )}
          {event.truncated && (
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-300">
              <CircleAlert aria-hidden="true" className="size-3" />
              {labels.truncated}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function MessageBlock({
  message,
  labels,
  locale,
  onTool,
  openProcesses,
  onToggleProcess,
}: {
  message: TranscriptMessage;
  labels: ReaderLabels;
  locale: string;
  onTool: (event: ConversationEvent) => void;
  openProcesses: Record<string, boolean>;
  onToggleProcess: (key: string, open: boolean) => void;
}) {
  const processIdPrefix = useId();
  const isUser = message.role === "user";
  const turnDuration = isUser ? undefined : turnDurationOf(message.events);
  const firstProcess = message.segments.find((segment) => segment.kind === "process")?.key;
  const processLabel = (key: string) =>
    turnDuration !== undefined && key === firstProcess
      ? toolDetailCopy(locale).worked(formatToolDuration(turnDuration, locale))
      : labels.process;
  return (
    <article
      data-message-role={message.role}
      className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`flex min-w-0 flex-col ${isUser ? "max-w-[min(82%,42rem)] items-end" : "w-full max-w-3xl"}`}
      >
        {message.time && (
          <time
            dateTime={message.time}
            tabIndex={0}
            className="mb-2 px-1 text-[11px] text-muted-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          >
            {new Date(message.time).toLocaleString(locale)}
          </time>
        )}
        <div
          className={
            isUser
              ? "rounded-2xl bg-primary px-4 py-2.5 text-sm leading-7 text-primary-foreground shadow-sm"
              : "w-full text-sm leading-7 text-foreground"
          }
        >
          <div className="space-y-3">
            {message.segments.flatMap((segment) => {
              if (segment.kind !== "process") {
                return segment.events.map((event) => (
                  <EventRow
                    event={event}
                    key={event.id}
                    labels={labels}
                    locale={locale}
                    onTool={onTool}
                  />
                ));
              }
              const open = openProcesses[segment.key] ?? segment.defaultOpen;
              const bodyId = `process-${processIdPrefix}-${segment.key}`;
              return (
                <div
                  key={segment.key}
                  className="my-2 overflow-hidden rounded-xl border border-border/70 bg-muted/20"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    aria-expanded={open}
                    aria-controls={bodyId}
                    aria-label={`${processLabel(segment.key)} ${segment.toolCount} ${labels.tools}${segment.failedToolCount > 0 ? ` · ${segment.failedToolCount} ${labels.failed}` : ""}`}
                    className="flex h-auto min-h-10 w-full items-center justify-start gap-2 rounded-none px-3 py-2 text-left text-xs font-normal transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    onClick={() => onToggleProcess(segment.key, open)}
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
                    />
                    <span className="font-medium text-foreground">{processLabel(segment.key)}</span>
                    <span className="text-muted-foreground">
                      {segment.toolCount} {labels.tools}
                    </span>
                    {segment.failedToolCount > 0 && (
                      <span className="text-destructive-text">
                        · {segment.failedToolCount} {labels.failed}
                      </span>
                    )}
                  </Button>
                  {open && (
                    <div id={bodyId} className="space-y-1 border-t border-border/60 px-3 py-2">
                      {segment.events.map((event) => (
                        <EventRow
                          event={event}
                          key={event.id}
                          labels={labels}
                          locale={locale}
                          onTool={onTool}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {!isUser && <TurnFileChanges events={message.events} locale={locale} />}
        </div>
        {message.running && (
          <span className="mt-2 px-1 text-[11px] text-muted-foreground">{labels.incomplete}</span>
        )}
      </div>
    </article>
  );
}

export function SessionTranscript({
  events,
  pendingMessage,
  streamText,
  streamTextTruncated = false,
  liveTurnId,
  incomplete = false,
  labels,
  locale,
  onTool,
  hasEarlier = false,
  loadingEarlier = false,
  earlierLabel,
  onLoadEarlier,
}: {
  events: ConversationEvent[];
  pendingMessage?: { text: string; afterEventId?: string };
  streamText?: string;
  streamTextTruncated?: boolean;
  liveTurnId?: string;
  incomplete?: boolean;
  labels: ReaderLabels;
  locale: string;
  onTool: (event: ConversationEvent) => void;
  hasEarlier?: boolean;
  loadingEarlier?: boolean;
  earlierLabel: string;
  onLoadEarlier?: () => Promise<void>;
}) {
  const projectedEvents = useMemo(() => {
    const projected = [...events];
    if (pendingMessage) {
      const anchor = pendingMessage.afterEventId
        ? events.findIndex((item) => item.id === pendingMessage.afterEventId) + 1
        : 0;
      // Native replies can precede persistence of their user message. Keep the
      // temporary row at the send-time boundary, rather than after those replies.
      if (
        !events
          .slice(anchor)
          .some(
            (item) =>
              item.kind === "user-message" && item.content?.trim() === pendingMessage.text.trim(),
          )
      ) {
        projected.splice(anchor, 0, {
          id: "session-pending:user",
          kind: "user-message",
          content: pendingMessage.text,
          attachment_count: 0,
          truncated: false,
          ephemeral: true,
        });
      }
    }
    if (streamText) {
      projected.push({
        id: `session-live:${liveTurnId ?? "current"}`,
        kind: "agent-message",
        turn_id: liveTurnId,
        message_phase: "final_answer",
        content: streamText,
        attachment_count: 0,
        truncated: streamTextTruncated,
        ephemeral: true,
      });
    }
    return projected;
  }, [events, liveTurnId, pendingMessage, streamText, streamTextTruncated]);
  const [projection, setProjection] = useState(() =>
    projectTranscript(projectedEvents, incomplete),
  );
  const current =
    projection.events === projectedEvents && projection.incomplete === incomplete
      ? projection
      : projectTranscript(projectedEvents, incomplete, projection);
  // Reconcile before committing children; an effect would already have replaced
  // their DOM nodes and discarded keyboard focus and process expansion.
  if (current !== projection) setProjection(current);
  const [openProcesses, setOpenProcesses] = useState<Record<string, boolean>>({});
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      {hasEarlier && (
        <Button
          type="button"
          variant="ghost"
          className="mx-auto mb-1 min-h-9 rounded-lg border border-border/70 bg-background px-3 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          disabled={loadingEarlier}
          onClick={() => void onLoadEarlier?.()}
        >
          {earlierLabel}
        </Button>
      )}
      {current.messages.map((message) => (
        <MessageBlock
          key={message.id}
          message={message}
          labels={labels}
          locale={locale}
          onTool={onTool}
          openProcesses={openProcesses}
          onToggleProcess={(key, open) => setOpenProcesses((value) => ({ ...value, [key]: !open }))}
        />
      ))}
    </div>
  );
}
