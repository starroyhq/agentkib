import { unavailableReasonText } from "@agentkib/session-ui";
import { dictionaries, type Locale } from "./i18n";

export function localizedUnavailableReasonText(reason: string, locale: Locale): string {
  return unavailableReasonText(reason, dictionaries[locale]);
}
