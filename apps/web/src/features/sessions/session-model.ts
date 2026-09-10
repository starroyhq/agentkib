import type { ConversationEventPage } from "@agentkib/web-client";
export const MAX_MESSAGE_LENGTH = 16_000;
const MAX_MESSAGE_BYTES = 16_384;
const messageEncoder = new TextEncoder();
export function isValidMessage(message: string) {
  const text = message.trim();
  return (
    !!text &&
    message.length <= MAX_MESSAGE_LENGTH &&
    messageEncoder.encode(message).byteLength <= MAX_MESSAGE_BYTES
  );
}
export function mergeLatestPage(
  previous: ConversationEventPage | undefined,
  latest: ConversationEventPage,
): ConversationEventPage {
  if (!previous || latest.events.length === 0) return latest;
  const first = previous.events.findIndex((event) => event.id === latest.events[0].id);
  return first < 0
    ? latest
    : {
        events: [...previous.events.slice(0, first), ...latest.events],
        next_cursor: previous.next_cursor,
        warnings: [...new Set([...previous.warnings, ...latest.warnings])],
      };
}
