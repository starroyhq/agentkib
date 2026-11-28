import { tr } from "@/core/i18n";

import { displaySessionTitle as sharedDisplaySessionTitle } from "@agentkib/session-catalog";

export function displaySessionTitle(
  title?: string,
  translate = tr,
  firstUserMessage?: string | null,
) {
  return sharedDisplaySessionTitle(title, translate("conversations.untitled"), firstUserMessage);
}
