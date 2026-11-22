import { devinTerminalAction, devinTerminalCopy } from "../../devin-terminal";
import type { SessionCreationDescription } from "../session-creation";

export const devinCreation = {
  terminalAction(reason, locale) {
    const action = devinTerminalAction(reason);
    if (!action) return undefined;
    const copy = devinTerminalCopy(locale);
    return {
      label: copy[action],
      opened: copy.opened,
      failed: copy.failed,
      open: (client, workspaceId) => client.devinTerminal({ action, workspaceId }),
    };
  },
} satisfies SessionCreationDescription;
