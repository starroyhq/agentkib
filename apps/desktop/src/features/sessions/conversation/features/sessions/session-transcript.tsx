import type { ConversationEvent } from "@agentkib/web-client";
import {
  SafeMarkdown,
  MessageActions,
  messageActionGroups,
  ConversationImages,
  conversationImageCopy,
  displayUserMessageText,
  type MessageImageLoader,
  ToolDetailRow,
  TurnFileChanges,
  isHiddenWrapperTool,
  turnDurationOf,
  transcriptProcessCopy,
  transcriptProcessLabel,
} from "@agentkib/session-ui";
import { Button } from "@/components/ui/button";
import { turnFileActivity } from "@agentkib/conversation-state";
import { groupConversationEvents } from "@/features/sessions/conversation-groups";
import type { ConversationEvent as DesktopConversationEvent } from "@/core/types";
import { ChevronRight, CircleAlert, Wrench } from "lucide-react";
import { useId, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { toolStatusLabel } from "./tool-status";
import { SessionImagePreview } from "./session-image-preview";

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

type TranscriptGroup = ReturnType<typeof groupConversationEvents<DesktopConversationEvent>>[number];
type TranscriptSegment = TranscriptGroup["segments"][number];

type TranscriptMessage = {
  id: string;
  role: "assistant" | "user";
  turnId?: string;
  terminalMarkerId?: string;
  events: DesktopConversationEvent[];
  segments: TranscriptSegment[];
  running: boolean;
  outcome?: TranscriptGroup["outcome"];
  durationMs?: number;
  fileActivity?: ReturnType<typeof turnFileActivity<DesktopConversationEvent>>;
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
  const groups = groupConversationEvents(events.map(normalizeEvent), {
    incomplete,
    isHidden: (event) =>
      isHiddenWrapperTool(event) ||
      (event.kind === "user-message" &&
        !displayUserMessageText(event.content ?? "", event.images ?? []).trim() &&
        !event.attachment_count &&
        !event.images?.length &&
        !event.truncated),
  });
  const messages: TranscriptMessage[] = [];
  for (const group of groups) {
    let lastAssistant: TranscriptMessage | undefined;
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
      const message: TranscriptMessage = {
        id: `${group.key}:${role}:${start}`,
        role,
        turnId: group.turnId,
        events: runEvents,
        segments: splitSegments(group.segments, (event) => runEventIds.has(event.id)),
        terminalMarkerId:
          role === "assistant" && end === group.events.length ? group.terminalMarkerId : undefined,
        durationMs: group.durationMs,
        outcome: role === "assistant" && end === group.events.length ? group.outcome : undefined,
        running:
          role === "assistant" && runEvents.some((event) => event.id.startsWith("session-live:")),
      };
      messages.push(message);
      if (role === "assistant") lastAssistant = message;
      start = end;
    }
    if (lastAssistant) lastAssistant.fileActivity = turnFileActivity(group);
    const status = group.segments.find((segment) => segment.outcome && !segment.events.length);
    if (status)
      messages.push({
        id: `${group.key}:status`,
        role: "assistant",
        turnId: group.turnId,
        events: [],
        segments: [status],
        terminalMarkerId: group.terminalMarkerId,
        running: false,
        outcome: group.outcome,
        durationMs: group.durationMs,
      });
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
  openProcesses: Readonly<Record<string, boolean>> = {},
): TranscriptProjection {
  const messages = projectMessages(events, incomplete);
  const previousByItem = new Map<string, TranscriptMessage>();
  const previousStatusByMarker = new Map<string, TranscriptMessage>();
  for (const message of previous?.messages ?? []) {
    for (const event of message.events) previousByItem.set(event.id, message);
    if (!message.events.length && message.terminalMarkerId)
      previousStatusByMarker.set(message.terminalMarkerId, message);
  }
  const usedMessages = new Set<string>();
  let nextKey = previous?.nextKey ?? 0;
  for (const message of messages) {
    // A page can prepend tools or the missing user message to an existing turn.
    // Keep role runs and process bodies mounted using their shared event IDs,
    // without joining distinct runs that happen to carry the same turn ID.
    const status = message.terminalMarkerId
      ? previousStatusByMarker.get(message.terminalMarkerId)
      : undefined;
    const prior =
      message.events
        .map((event) => previousByItem.get(event.id))
        .find(
          (candidate) =>
            candidate &&
            !usedMessages.has(candidate.id) &&
            candidate.role === message.role &&
            candidate.turnId === message.turnId,
        ) ?? (status && !usedMessages.has(status.id) ? status : undefined);
    if (prior) usedMessages.add(prior.id);
    message.id = prior?.id ?? `message:${nextKey++}`;
    const previousProcesses = new Map<string, TranscriptSegment>();
    for (const segment of prior?.segments ?? [])
      if (segment.kind === "process")
        for (const event of segment.events) previousProcesses.set(event.id, segment);
    const usedProcesses = new Set<string>();
    for (const segment of message.segments) {
      if (segment.kind !== "process") continue;
      const candidates = segment.events
        .map((event) => previousProcesses.get(event.id))
        .filter((candidate) => candidate && !usedProcesses.has(candidate.key));
      // A completed turn can combine several live disclosures. Keep one the
      // reader explicitly opened, even if earlier closed tools are merged in.
      const priorProcess =
        candidates.find((candidate) => candidate && openProcesses[candidate.key] === true) ??
        candidates.find((candidate) => candidate && openProcesses[candidate.key] === false) ??
        candidates[0] ??
        (status && prior === status && segment.outcome && !usedProcesses.has(status.segments[0].key)
          ? status.segments[0]
          : undefined);
      if (priorProcess) usedProcesses.add(priorProcess.key);
      segment.key = priorProcess?.key ?? `process:${nextKey++}`;
    }
  }
  return { events, incomplete, messages, nextKey };
}

function messageBody(event: DesktopConversationEvent): string {
  return event.kind === "user-message"
    ? displayUserMessageText(event.content ?? "", event.images ?? [])
    : (event.content ?? "");
}

function EventRow({
  event,
  labels,
  locale,
  onTool,
  imageLoader,
}: {
  event: DesktopConversationEvent;
  labels: ReaderLabels;
  locale: string;
  onTool: (event: ConversationEvent) => void;
  imageLoader?: MessageImageLoader;
}) {
  const isTool = event.kind === "tool-summary";
  const isUser = event.kind === "user-message";
  const images = !isTool && imageLoader ? (event.images ?? []) : [];
  const content = messageBody(event);
  const hasText = !!content.trim();
  const attachmentCount =
    Math.max(0, event.attachment_count, event.images?.length ?? 0) - images.length;
  const hasBubble = hasText || attachmentCount > 0 || event.truncated;
  if (isTool && event.tool)
    return (
      <div data-event-id={event.id}>
        <ToolDetailRow
          event={{ ...event, tool: event.tool }}
          locale={locale}
          statusLabel={toolStatusLabel(event.tool_status, locale)}
        />
      </div>
    );
  return (
    <div
      data-event-id={event.id}
      className={
        isUser
          ? "flex min-w-0 max-w-full flex-col items-end"
          : isTool
            ? "flex min-w-0"
            : "aui-markdown min-w-0 break-words"
      }
    >
      {images.length > 0 && imageLoader && (
        <ConversationImages
          images={images}
          load={imageLoader}
          locale={locale}
          align={isUser ? "end" : "start"}
          renderPreview={({ src, name, onClose }) => (
            <SessionImagePreview
              src={src}
              name={name}
              closeLabel={conversationImageCopy(locale).close}
              onClose={onClose}
            />
          )}
        />
      )}
      {(!isUser || hasBubble) && (
        <div
          data-user-message-bubble={isUser ? "true" : undefined}
          className={
            isUser
              ? "aui-markdown w-fit min-w-0 max-w-full rounded-2xl bg-primary px-4 py-2.5 text-sm leading-7 break-words text-primary-foreground shadow-sm dark:bg-blue-950 dark:text-blue-50"
              : "contents"
          }
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
            hasText && (
              <div data-message-body className="select-text">
                <SafeMarkdown text={content} literal={event.cli_output === true} />
              </div>
            )
          )}
          {(attachmentCount > 0 || event.truncated) && (
            <div
              className={`mt-2 flex flex-wrap gap-2 text-[11px] ${isUser ? "text-inherit" : "text-muted-foreground"}`}
            >
              {attachmentCount > 0 && (
                <span
                  className={`rounded-md px-2 py-1 ${isUser ? "bg-black/10 dark:bg-white/10" : "bg-muted"}`}
                >
                  {labels.attachments}: {attachmentCount}
                </span>
              )}
              {event.truncated && (
                <span
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 ${isUser ? "bg-black/10 text-inherit dark:bg-white/10" : "bg-amber-500/10 text-amber-700 dark:text-amber-300"}`}
                >
                  <CircleAlert aria-hidden="true" className="size-3" />
                  {labels.truncated}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MessageRows({
  events,
  beforeActions,
  ...rowProps
}: Omit<ComponentProps<typeof EventRow>, "event"> & {
  events: DesktopConversationEvent[];
  beforeActions?: ReactNode;
}) {
  const isUser = events[0]?.kind === "user-message";
  const timestamp = [...events].reverse().find((event) => event.timestamp)?.timestamp;
  const text = events
    .map(messageBody)
    .filter((body) => body.trim())
    .join("\n\n");
  return (
    <div
      className={`group/message flex min-w-0 max-w-full flex-col ${isUser ? "items-end" : "gap-1"}`}
    >
      {events.map((event) => (
        <EventRow event={event} {...rowProps} key={event.id} />
      ))}
      {beforeActions}
      <MessageActions
        locale={rowProps.locale}
        timestamp={timestamp}
        text={text}
        role={isUser ? "user" : "assistant"}
        align={isUser ? "end" : "start"}
      />
    </div>
  );
}

function MessageBlock({
  message,
  labels,
  locale,
  onTool,
  imageLoader,
  openProcesses,
  onToggleProcess,
  earlierProcessKey,
  loadEarlierDetails,
  loadingEarlier,
}: {
  message: TranscriptMessage;
  labels: ReaderLabels;
  locale: string;
  onTool: (event: ConversationEvent) => void;
  imageLoader?: MessageImageLoader;
  openProcesses: Record<string, boolean>;
  onToggleProcess: (key: string, open: boolean) => void;
  earlierProcessKey?: string;
  loadEarlierDetails?: () => Promise<void>;
  loadingEarlier: boolean;
}) {
  const processIdPrefix = useId();
  const isUser = message.role === "user";
  const turnDuration = isUser ? undefined : (message.durationMs ?? turnDurationOf(message.events));
  const firstProcess = message.segments.find((segment) => segment.kind === "process")?.key;
  const copy = transcriptProcessCopy(locale);
  const hasVisibleReply = message.segments.some((segment) => segment.kind === "event");
  const blocks = messageActionGroups(message.segments);
  const lastReply = message.fileActivity
    ? [...blocks].reverse().find((block) => block.kind === "message")
    : undefined;
  const fileChanges = message.fileActivity && (
    <TurnFileChanges {...message.fileActivity} locale={locale} />
  );
  const showFailure =
    message.outcome === "failed" &&
    !message.segments.some((segment) => segment.kind === "process" && segment.outcome === "failed");
  return (
    <article
      data-message-role={message.role}
      className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`flex min-w-0 flex-col ${isUser ? "max-w-[min(82%,42rem)] items-end" : "w-full max-w-3xl"}`}
      >
        <div
          className={
            isUser
              ? "min-w-0 max-w-full text-sm leading-7"
              : "w-full text-sm leading-7 text-foreground"
          }
        >
          <div
            className={isUser ? "flex min-w-0 max-w-full flex-col items-end gap-3" : "space-y-3"}
          >
            {showFailure && (
              <p
                data-terminal-turn-id={message.turnId}
                data-terminal-outcome="failed"
                className="text-xs font-medium text-destructive-text"
              >
                {copy.failed}
              </p>
            )}
            {blocks.map((group) => {
              if (group.kind === "message") {
                return (
                  <MessageRows
                    events={group.events}
                    key={group.events[0].id}
                    labels={labels}
                    locale={locale}
                    onTool={onTool}
                    imageLoader={imageLoader}
                    beforeActions={group === lastReply ? fileChanges : undefined}
                  />
                );
              }
              const { segment } = group;
              const label = transcriptProcessLabel(
                locale,
                labels.process,
                segment.outcome,
                segment.key === firstProcess ? turnDuration : undefined,
                hasVisibleReply,
              );
              if (!segment.events.length && segment.key !== earlierProcessKey)
                return (
                  <p
                    key={segment.key}
                    data-history-anchor={segment.key}
                    data-terminal-turn-id={message.turnId}
                    data-terminal-outcome={segment.outcome}
                    className="text-xs text-muted-foreground"
                  >
                    {label}
                  </p>
                );
              const open = openProcesses[segment.key] ?? segment.defaultOpen;
              const bodyId = `process-${processIdPrefix}-${segment.key}`;
              const toolSummary = [
                !segment.outcome && segment.toolCount > 0
                  ? `${segment.toolCount} ${labels.tools}`
                  : "",
                segment.failedToolCount > 0 && (!segment.outcome || segment.outcome === "failed")
                  ? `${segment.failedToolCount} ${labels.failed}`
                  : "",
              ].filter(Boolean);
              return (
                <div key={segment.key}>
                  <div className={segment.outcome ? "border-b border-border/70 pb-1" : undefined}>
                    <Button
                      type="button"
                      variant="ghost"
                      aria-expanded={open}
                      aria-controls={bodyId}
                      aria-label={[label, ...toolSummary].join(" · ")}
                      data-history-anchor={segment.key}
                      data-terminal-turn-id={segment.outcome && message.turnId}
                      data-terminal-outcome={segment.outcome}
                      className="flex h-auto min-h-8 w-fit max-w-full items-center justify-start gap-2 rounded-md px-1.5 py-1 text-left text-sm font-normal text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                      onClick={() => onToggleProcess(segment.key, open)}
                    >
                      <span>{label}</span>
                      {!segment.outcome && segment.toolCount > 0 && (
                        <span>
                          {segment.toolCount} {labels.tools}
                        </span>
                      )}
                      {segment.failedToolCount > 0 &&
                        (!segment.outcome || segment.outcome === "failed") && (
                          <span className="text-destructive-text">
                            · {segment.failedToolCount} {labels.failed}
                          </span>
                        )}
                      <ChevronRight
                        aria-hidden="true"
                        className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
                      />
                    </Button>
                  </div>
                  {open && (
                    <div id={bodyId} className="my-2 space-y-2">
                      {segment.key === earlierProcessKey && loadEarlierDetails && (
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-auto min-h-8 px-2 text-xs text-muted-foreground"
                          disabled={loadingEarlier}
                          onClick={() => void loadEarlierDetails()}
                        >
                          {copy.earlierDetails}
                        </Button>
                      )}
                      {segment.events.map((event) =>
                        event.kind === "tool-summary" ? (
                          <EventRow
                            event={event}
                            key={event.id}
                            labels={labels}
                            locale={locale}
                            onTool={onTool}
                            imageLoader={imageLoader}
                          />
                        ) : (
                          <MessageRows
                            events={[event]}
                            key={event.id}
                            labels={labels}
                            locale={locale}
                            onTool={onTool}
                            imageLoader={imageLoader}
                          />
                        ),
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {!lastReply && fileChanges}
          </div>
        </div>
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
  imageLoader,
  hasEarlier = false,
  loadingEarlier = false,
  earlierLabel,
  onLoadEarlier,
  historyDetailTurnId,
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
  imageLoader?: MessageImageLoader;
  hasEarlier?: boolean;
  loadingEarlier?: boolean;
  earlierLabel: string;
  onLoadEarlier?: (turnId?: string) => Promise<void>;
  historyDetailTurnId?: string;
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
  const [openProcesses, setOpenProcesses] = useState<Record<string, boolean>>({});
  const current =
    projection.events === projectedEvents && projection.incomplete === incomplete
      ? projection
      : projectTranscript(projectedEvents, incomplete, projection, openProcesses);
  // Reconcile before committing children; an effect would already have replaced
  // their DOM nodes and discarded keyboard focus and process expansion.
  if (current !== projection) setProjection(current);
  const firstMessage = current.messages[0];
  const earlierProcessKey =
    hasEarlier &&
    historyDetailTurnId &&
    firstMessage?.role === "assistant" &&
    firstMessage.turnId === historyDetailTurnId
      ? firstMessage.segments.find((segment) => segment.kind === "process" && segment.outcome)?.key
      : undefined;
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
          imageLoader={imageLoader}
          openProcesses={openProcesses}
          onToggleProcess={(key, open) => setOpenProcesses((value) => ({ ...value, [key]: !open }))}
          earlierProcessKey={earlierProcessKey}
          loadEarlierDetails={onLoadEarlier && (() => onLoadEarlier(historyDetailTurnId))}
          loadingEarlier={loadingEarlier}
        />
      ))}
    </div>
  );
}
