import { useI18n } from "@/core/useI18n";
import { Bot, UserRound, Wrench } from "lucide-react";
import { MarkdownContent } from "@/components/MarkdownContent";
import type { ConversationEvent } from "@/core/types";

export function ConversationEventRow({
  event,
  variant = "workspace",
}: {
  event: ConversationEvent;
  variant?: "workspace" | "hub";
}) {
  const { tr, formatDateTime } = useI18n();
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
  const messageClassName = hub
    ? isUser
      ? "session-hub-event session-hub-message session-hub-user ml-auto w-fit max-w-[82%] self-start rounded-2xl border border-border/50 bg-muted px-4 py-3.5 text-foreground shadow-none [overflow-wrap:anywhere]"
      : "session-hub-event session-hub-message session-hub-agent w-full min-w-0 max-w-full self-start px-1 py-1 text-foreground [overflow-wrap:anywhere]"
    : `max-w-[min(820px,92%)] self-start rounded-2xl border px-4 py-3.5 shadow-xs ${coloredUser ? "ml-auto border-primary bg-primary text-primary-foreground" : isUser ? "ml-auto border-border/70 bg-muted text-foreground" : "border-border/70 bg-card text-foreground"}`;
  return (
    <article data-event-id={event.id} className={messageClassName}>
      {!hub && (
        <header
          className={`mb-2.5 flex items-center gap-1.5 text-xs ${coloredUser ? "text-primary-foreground" : "text-muted-foreground"}`}
        >
          {isUser ? <UserRound size={14} /> : <Bot size={14} />}
          <strong className={coloredUser ? "text-primary-foreground" : "text-foreground"}>
            {tr(isUser ? "conversations.you" : "conversations.agent")}
          </strong>
          {event.timestamp && <time className="ml-auto">{formatDateTime(event.timestamp)}</time>}
        </header>
      )}
      <MarkdownContent
        content={event.content ?? ""}
        literal={event.cli_output === true}
        className={`select-text text-sm leading-7 [overflow-wrap:anywhere]${coloredUser ? " markdown-on-primary" : ""}`}
      />
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
    </article>
  );
}

function formatDuration(milliseconds: number) {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}
