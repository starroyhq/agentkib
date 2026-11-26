import { verifiedNativeJsonlTail } from "./native-jsonl-tail";

export function claudePromptRecorded(file: string, nativeId: string, requestId: string): boolean {
  return matchingRow(file, requestId, (row) => {
    const message = record(row.message);
    return (
      row.type === "user" &&
      row.sessionId === nativeId &&
      row.uuid === requestId &&
      row.isMeta !== true &&
      row.isSidechain !== true &&
      row.isCompactSummary !== true &&
      message?.role === "user" &&
      (!Array.isArray(message.content) ||
        !message.content.some((block) => record(block)?.type === "tool_result"))
    );
  });
}

export function codexPromptRecorded(
  file: string,
  nativeId: string,
  requestId: string,
  expectedTurn?: string,
): boolean {
  return matchingRow(file, requestId, (row) => {
    const event = record(row.payload);
    const item = record(event?.item);
    return (
      row.type === "event_msg" &&
      event?.type === "item_completed" &&
      event.thread_id === nativeId &&
      typeof event.turn_id === "string" &&
      (expectedTurn === undefined || event.turn_id === expectedTurn) &&
      item?.type === "UserMessage" &&
      item.client_id === requestId
    );
  });
}

export function codexStopRecorded(file: string, turnId: string): boolean {
  return matchingRow(file, turnId, (row) => {
    const event = record(row.payload);
    return (
      row.type === "event_msg" &&
      event?.type === "turn_aborted" &&
      event.turn_id === turnId &&
      event.reason === "interrupted"
    );
  });
}

function matchingRow(
  file: string,
  id: string,
  matches: (row: Record<string, unknown>) => boolean,
): boolean {
  return verifiedNativeJsonlTail(file).some((line) => {
    if (!line.includes(id)) return false;
    try {
      const row = record(JSON.parse(line));
      return row !== undefined && matches(row);
    } catch {
      // A malformed row provides no evidence.
      return false;
    }
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
