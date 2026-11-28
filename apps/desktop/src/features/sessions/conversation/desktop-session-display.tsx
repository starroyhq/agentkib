import {
  ManagedTurnNotice as SharedManagedTurnNotice,
  sessionDisplayState as sharedSessionDisplayState,
  type SessionSurface,
} from "@agentkib/session-ui";
import type { ComponentProps } from "react";
import { Button } from "@agentkib/ui/button";
import { localizedUnavailableReasonText } from "./live-status";

export { retryText } from "@agentkib/session-ui";

export function sessionDisplayState(
  session: Parameters<typeof sharedSessionDisplayState>[0],
  surface: SessionSurface = "desktop",
) {
  return sharedSessionDisplayState(session, surface, localizedUnavailableReasonText);
}

export function ManagedTurnNotice(
  props: Omit<ComponentProps<typeof SharedManagedTurnNotice>, "Button" | "unavailableReason">,
) {
  return (
    <SharedManagedTurnNotice
      {...props}
      Button={Button}
      unavailableReason={localizedUnavailableReasonText}
    />
  );
}
