import { unavailableReasonText } from "@agentkib/session-ui";
import { conversationWords } from "@/core/i18n";

export function localizedUnavailableReasonText(
  reason: string,
  locale: Parameters<typeof conversationWords>[0],
): string {
  return unavailableReasonText(reason, conversationWords(locale));
}
