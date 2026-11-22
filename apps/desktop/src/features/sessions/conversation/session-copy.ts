import {
  sessionReason as sharedCodexReason,
  type InteractionLocale,
  type SessionSurface,
} from "@agentkib/session-ui";
import { localizedUnavailableReasonText } from "./live-status";

export { sessionCopy, sessionCopyForSurface } from "@agentkib/session-ui";

export function sessionReason(
  locale: InteractionLocale,
  reason?: string,
  surface: SessionSurface = "desktop",
) {
  return sharedCodexReason(locale, reason, surface, localizedUnavailableReasonText);
}
