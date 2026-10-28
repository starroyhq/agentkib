// Event helpers that import nothing. conversation-tools uses them, and Web tests load that module
// through ManagedCodexState, so it must not reach the history readers and their node:sqlite.
export const MAX_MESSAGE_BYTES = 256 * 1024;

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
    case "inprogress":
      return "running";
    case "declined":
      return "declined";
    default:
      return "unknown";
  }
}
