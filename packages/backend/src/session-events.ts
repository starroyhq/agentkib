import { sessionTitle } from "./codex-sessions";
import { jsonTimestamp } from "./session-history";
export const MAX_MESSAGE_BYTES = 256 * 1024;
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export type CompatibleFormat = "open-claw" | "hermes" | "grok-build";
export type HistoryFormat = CompatibleFormat | "codex" | "claude-code";
export interface ConversationEvent {
  id: string;
  kind: "user-message" | "agent-message" | "tool-summary";
  turn_id?: string;
  message_phase?: "commentary" | "final_answer";
  timestamp: string | null;
  content: string | null;
  tool_name: string | null;
  tool_status: string | null;
  duration_ms: number | null;
  attachment_count: number;
  truncated: boolean;
}
export interface ConversationEventPage {
  events: ConversationEvent[];
  next_cursor: string | null;
  warnings: string[];
}
export function property(row: any, keys: string[]): unknown {
  if (row !== null && row !== undefined)
    for (const key of keys) if (Object.hasOwn(row, key)) return row[key];
  return undefined;
}
const present = (...values: unknown[]) => values.find((value) => value !== undefined);
export const stringValue = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
export const hasText = (value: string | null): value is string =>
  value !== null && /[^\p{White_Space}]/u.test(value);
export const trimWhitespace = (value: string): string =>
  value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
export function messageText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  return (
    value
      .filter((block) => ["text", "input_text", "output_text"].includes(block?.type))
      .map((block) => stringValue(block?.text))
      .filter((value) => value !== null)
      .join("\n") || null
  );
}
export function truncateUtf8(content: string, maximum = MAX_MESSAGE_BYTES) {
  const bytes = Buffer.from(content);
  if (bytes.length <= maximum) return { content, truncated: false };
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { content: bytes.subarray(0, end).toString("utf8"), truncated: true };
}
export function toolStatus(value: unknown): string | null {
  if (typeof value !== "string") return null;
  switch (value.replace(/[A-Z]/g, (char) => char.toLowerCase())) {
    case "completed":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "started":
    case "running":
    case "in_progress":
      return "running";
    default:
      return "unknown";
  }
}
export function unsignedValue(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < Number(18446744073709551616n)
    ? value
    : null;
}
/** These formats expose message envelopes, but no verified turn/phase boundaries. */
export function compatibleEvents(
  format: CompatibleFormat,
  offset: number,
  row: any,
): ConversationEvent[] {
  const type = stringValue(row?.type);
  if (
    format === "grok-build" &&
    !["user", "assistant", "tool", "toolResult", "tool_result"].includes(type ?? "")
  )
    return [];
  if (format === "open-claw" && type !== null && type !== "message") return [];
  if (
    format === "hermes" &&
    ["reasoning", "thinking", "redacted_thinking", "internal", "system"].includes(type ?? "")
  )
    return [];
  const message: any = property(row, ["message"]) === undefined ? row : row.message,
    role =
      stringValue(
        present(
          property(message, ["role"]),
          property(row, ["role"]),
          format === "grok-build" ? property(row, ["type"]) : undefined,
        ),
      ) ?? "",
    timestamp =
      jsonTimestamp(row?.timestamp) ?? jsonTimestamp(property(message, ["timestamp", "ts"])),
    contentValue = present(property(message, ["content"]), property(row, ["content"])),
    text = messageText(contentValue),
    events: ConversationEvent[] = [];
  const base = (): Omit<ConversationEvent, "id" | "kind"> => ({
    timestamp,
    content: null,
    tool_name: null,
    tool_status: null,
    duration_ms: null,
    attachment_count: 0,
    truncated: false,
  });
  const toolContent = (value: string | null) =>
    hasText(value) ? truncateUtf8(value) : { content: null, truncated: false };
  if (["tool", "toolResult", "tool_result"].includes(role)) {
    const name = present(
        property(message, ["toolName", "tool_name", "name"]),
        property(row, ["toolName", "tool_name", "name"]),
      ),
      explicit = stringValue(present(property(message, ["status"]), property(row, ["status"]))),
      failed = property(message, ["isError", "is_error"]);
    return [
      {
        ...base(),
        id: `tool-${offset}`,
        kind: "tool-summary",
        ...toolContent(text),
        tool_name: sessionTitle(name) ?? "tool",
        tool_status: toolStatus(
          explicit ?? (typeof failed === "boolean" ? (failed ? "failed" : "completed") : null),
        ),
        duration_ms: unsignedValue(
          present(property(message, ["durationMs", "duration_ms"]), property(row, ["durationMs"])),
        ),
      },
    ];
  }
  if (Array.isArray(contentValue))
    for (let index = contentValue.length - 1; index >= 0; index--) {
      const block = contentValue[index],
        call = ["toolCall", "tool_use", "toolUse"].includes(block?.type),
        result = ["toolResult", "tool_result"].includes(block?.type);
      if (!call && !result) continue;
      const name = property(block, ["name", "toolName", "tool_name"]),
        explicit = stringValue(block?.status),
        failed = property(block, ["isError", "is_error"]);
      events.push({
        ...base(),
        id: `tool-${offset}-${index}`,
        kind: "tool-summary",
        ...toolContent(messageText(property(block, ["content", "output", "result", "input"]))),
        tool_name: sessionTitle(name) ?? "tool",
        tool_status: toolStatus(
          explicit ??
            (result && typeof failed === "boolean" ? (failed ? "failed" : "completed") : null),
        ),
        duration_ms: unsignedValue(property(block, ["durationMs", "duration_ms"])),
      });
    }
  const kind =
    role === "user"
      ? "user-message"
      : ["assistant", "agent"].includes(role)
        ? "agent-message"
        : null;
  if (kind && hasText(text))
    events.push({
      ...base(),
      id: `event-${offset}`,
      kind,
      ...truncateUtf8(text),
      attachment_count: Array.isArray(contentValue)
        ? contentValue.filter((block) =>
            ["image", "document", "file", "input_image", "input_file"].includes(block?.type),
          ).length
        : 0,
    });
  return events;
}
