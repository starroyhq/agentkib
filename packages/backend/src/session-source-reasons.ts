import { ANTIGRAVITY_ACP_DISABLED } from "./agents/antigravity/acp-enabled";

export { ANTIGRAVITY_ACP_DISABLED };

export const sessionSourceReasonPattern = /^[a-z][a-z0-9-]{0,79}$/;

const nonRetryable = new Set([
  ANTIGRAVITY_ACP_DISABLED,
  "backend-closing",
  "devin-source-denied",
  "devin-source-unsafe",
  "devin-source-unsupported",
  "devin-source-corrupt",
]);

export function canRetrySessionSource(reason: string): boolean {
  return !nonRetryable.has(reason);
}

export function parseSessionSourceReasons(detail: string | null): string[] {
  if (!detail?.startsWith("[") || detail.length > 2048) return [];
  try {
    const parsed: unknown = JSON.parse(detail);
    return Array.isArray(parsed)
      ? parsed.filter(
          (reason): reason is string =>
            typeof reason === "string" && sessionSourceReasonPattern.test(reason),
        )
      : [];
  } catch {
    return [];
  }
}
