import { catalogSourceRetry, isCatalogSourceReason } from "@agentkib/runtime-protocol";
import { ANTIGRAVITY_ACP_DISABLED } from "./agents/antigravity/acp-enabled";

export { ANTIGRAVITY_ACP_DISABLED };

export const sessionSourceReasonPattern = /^[a-z][a-z0-9-]{0,79}$/;

export function canRetrySessionSource(reason: string): boolean {
  const retry = catalogSourceRetry(reason);
  return retry === "after-backoff" || retry === "after-refresh";
}

/** In-progress coverage keeps cached rows during reconciliation and does not indicate failure. */
export function retainIncompleteSessionSource(reason: string): boolean {
  return (
    reason === "not-scanned" ||
    reason === "refreshing" ||
    reason === "classification-pending" ||
    canRetrySessionSource(reason)
  );
}

export function parseSessionSourceReasons(detail: string | null): string[] {
  if (!detail?.startsWith("[") || detail.length > 2048) return [];
  try {
    const parsed: unknown = JSON.parse(detail);
    return Array.isArray(parsed)
      ? parsed.filter(
          (reason): reason is string =>
            typeof reason === "string" &&
            (reason === ANTIGRAVITY_ACP_DISABLED || isCatalogSourceReason(reason)),
        )
      : [];
  } catch {
    return [];
  }
}
