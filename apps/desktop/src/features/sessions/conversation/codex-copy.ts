import {
  codexReason as sharedCodexReason,
  type InteractionLocale,
  type SessionSurface,
} from "@agentkib/session-ui";
import { localizedUnavailableReasonText } from "./live-status";

export { codexCopy, codexCopyForSurface } from "@agentkib/session-ui";

export function codexReason(
  locale: InteractionLocale,
  reason?: string,
  surface: SessionSurface = "desktop",
) {
  return sharedCodexReason(locale, reason, surface, localizedUnavailableReasonText);
}
