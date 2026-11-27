export const ACP_WORKER_REPORT_MESSAGE_ID_LIMIT = 1024;

/** Correlates native user chunks with the single prompt sent on this ACP connection. */
export function trackAcpWorkerReportPrompt(
  text: string,
  alreadyObserved?: (id: string) => boolean,
) {
  let id: string | undefined;
  let end = 0;
  let ambiguous = false;
  return {
    observe(update: Record<string, unknown>) {
      if (ambiguous || update.sessionUpdate !== "user_message_chunk") return;
      const messageId = update.messageId;
      const content = update.content;
      if (
        typeof messageId !== "string" ||
        !messageId ||
        messageId.length > ACP_WORKER_REPORT_MESSAGE_ID_LIMIT ||
        (id === undefined && alreadyObserved?.(messageId)) ||
        (id !== undefined && id !== messageId) ||
        !content ||
        typeof content !== "object" ||
        !("type" in content) ||
        content.type !== "text" ||
        !("text" in content) ||
        typeof content.text !== "string" ||
        !text.startsWith(content.text, end)
      ) {
        ambiguous = true;
        return;
      }
      id = messageId;
      end += content.text.length;
    },
    match() {
      return !ambiguous && end === text.length ? id : undefined;
    },
  };
}

export function antigravityAcpReportProof(messageId: string): string {
  return `antigravity-acp:${messageId}`;
}
