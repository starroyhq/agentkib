import { useI18n } from "@/core/useI18n";
import { Bot, UserRound, Wrench } from "lucide-react";
import { displayUserMessageText, MessageActions } from "@agentkib/session-ui";
import type { ReactNode } from "react";
import { MarkdownContent } from "@/components/MarkdownContent";
import type { ConversationEvent } from "@/core/types";

export function ConversationEventRow({
  event,
  variant = "workspace",
  showActions = true,
  beforeActions,
}: {
  event: ConversationEvent;
  variant?: "workspace" | "hub";
  showActions?: boolean;
  beforeActions?: ReactNode;
}) {
  const { tr, formatDateTime, locale } = useI18n();
  const hub = variant === "hub";
  if (event.kind === "tool-summary") {
    return (
      <div
        data-event-id={event.id}
        className={
          hub
            ? "session-hub-event session-hub-tool flex min-h-[34px] max-w-full flex-wrap items-center gap-2 px-1 py-1 text-sm text-muted-foreground [overflow-wrap:anywhere]"
            : "text-xs flex min-h-[38px] items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-muted-foreground shadow-xs"
        }
      >
        <span className="grid size-5 place-items-center rounded-md bg-muted">
          <Wrench size={12} />
        </span>
        <strong className="text-foreground">{event.tool_name || tr("conversations.tool")}</strong>
        <span>{tr(`conversations.toolStatus.${event.tool_status ?? "unknown"}`)}</span>
        {!hub && (event.timestamp || event.duration_ms != null) && (
          <time className="ml-auto text-[11px]">
            {event.timestamp ? formatDateTime(event.timestamp) : ""}
            {event.timestamp && event.duration_ms != null ? " · " : ""}
            {event.duration_ms != null ? formatDuration(event.duration_ms) : ""}
          </time>
        )}
      </div>
    );
  }
  const isUser = event.kind === "user-message";
  const coloredUser = isUser && !hub;
  const text = isUser ? displayUserMessageText(event.content ?? "", event.images) : event.content;
  const width = hub
    ? isUser
      ? "ml-auto w-fit max-w-[82%]"
      : "w-full"
    : `w-fit max-w-[min(820px,92%)] ${isUser ? "ml-auto" : ""}`;
  const framing = hub
    ? isUser
      ? "session-hub-event session-hub-message session-hub-user self-end rounded-2xl border border-border/50 bg-muted px-4 py-3.5 text-foreground shadow-none"
      : "session-hub-event session-hub-message session-hub-agent px-1 py-1 text-foreground"
    : `rounded-2xl border px-4 py-3.5 shadow-xs ${coloredUser ? "self-end border-primary bg-primary text-primary-foreground" : "border-border/70 bg-card text-foreground"}`;
  return (
    <article
      data-event-id={event.id}
      className={`group/message flex min-w-0 flex-col self-start ${width}`}
    >
      <div className={framing}>
        {!hub && (
          <header
            className={`mb-2.5 flex items-center gap-1.5 text-xs ${coloredUser ? "text-primary-foreground" : "text-muted-foreground"}`}
          >
            {isUser ? <UserRound size={14} /> : <Bot size={14} />}
            <strong className={coloredUser ? "text-primary-foreground" : "text-foreground"}>
              {tr(isUser ? "conversations.you" : "conversations.agent")}
            </strong>
          </header>
        )}
        {text?.trim() && (
          <div data-message-body="" className="select-text">
            <MarkdownContent
              content={text}
              literal={event.cli_output === true}
              className={`text-sm leading-7 [overflow-wrap:anywhere]${coloredUser ? " markdown-on-primary" : ""}`}
            />
          </div>
        )}
        {(event.attachment_count > 0 || event.truncated) && (
          <footer
            className={`mt-3 flex gap-2 ${hub ? "text-sm" : "text-xs"} ${coloredUser ? "text-primary-foreground" : "text-muted-foreground"}`}
          >
            {event.attachment_count > 0 && (
              <span>{tr("conversations.attachments", { count: event.attachment_count })}</span>
            )}
            {event.truncated && <span>{tr("conversations.contentTruncated")}</span>}
          </footer>
        )}
      </div>
      {beforeActions}
      {showActions && (
        <MessageActions
          locale={locale}
          role={isUser ? "user" : "assistant"}
          text={text}
          timestamp={event.timestamp}
          timestampLabel={tr("sessions.recordTime")}
          align={isUser ? "end" : "start"}
        />
      )}
    </article>
  );
}

function formatDuration(milliseconds: number) {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}
