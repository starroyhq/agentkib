import { isCatalogSourceReason, REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { ANTIGRAVITY_ACP_DISABLED } from "./agents/antigravity/acp-enabled";

export { ANTIGRAVITY_ACP_DISABLED };

export const sessionSourceReasonPattern = /^[a-z][a-z0-9-]{0,79}$/;

const nonRetryable = new Set<string>([
  ANTIGRAVITY_ACP_DISABLED,
  REMOTE_ERROR_CODES.antigravityAcpWorkspaceUnavailable,
  REMOTE_ERROR_CODES.antigravityLocalLimit,
  REMOTE_ERROR_CODES.backendClosing,
  REMOTE_ERROR_CODES.devinSourceCorrupt,
  REMOTE_ERROR_CODES.devinSourceDenied,
  REMOTE_ERROR_CODES.devinSourceLimit,
  REMOTE_ERROR_CODES.devinSourceRecord,
  REMOTE_ERROR_CODES.devinSourceUnsafe,
  REMOTE_ERROR_CODES.devinSourceUnsupported,
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
            typeof reason === "string" &&
            (reason === ANTIGRAVITY_ACP_DISABLED || isCatalogSourceReason(reason)),
        )
      : [];
  } catch {
    return [];
  }
}
