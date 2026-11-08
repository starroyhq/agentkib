/**
 * Slash commands in a DeepSeek Harness session.
 *
 * DSH runs `/name` itself through its command registry, never the model, and so does AgentKib:
 * a message naming one of the session's commands is sent as usual, and the plugin inside DSH
 * runs it as DSH's own window does (also while a turn runs), with the session's own registry.
 * What the command did shows in the session's history. The rules for which commands AgentKib
 * runs, and for which device, live with the plugin (`dsh-bridge-plugin/commands.js`); this module
 * gives clients the same rules for the `/` menu.
 */
import {
  DSH_COMMAND_LINE,
  DSH_SESSION_COMMANDS,
  DSH_WINDOW_ONLY_COMMANDS,
} from "../../dsh-bridge-plugin/commands.js";

/** Why AgentKib did not run a command; clients explain each one. */
export const DSH_COMMAND_REFUSALS = [
  "dsh-command-window-only",
  "dsh-command-attachments",
  "dsh-command-full-access",
] as const;
export type DshCommandRefusal = (typeof DSH_COMMAND_REFUSALS)[number];

export function isDshCommandRefusal(value: unknown): value is DshCommandRefusal {
  return (DSH_COMMAND_REFUSALS as readonly unknown[]).includes(value);
}

/** One entry of the catalog the running DSH reports, in the shape of Claude Code's. */
export interface DshCommandEntry {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** The commands a `/` menu offers: those a device with this access may run here. */
export function dshMenuCommands(
  commands: readonly DshCommandEntry[],
  fullAccess: boolean,
): DshCommandEntry[] {
  return commands.filter(
    (entry) =>
      DSH_COMMAND_LINE.test(`/${entry.name}`) &&
      !DSH_WINDOW_ONLY_COMMANDS.includes(entry.name) &&
      (fullAccess || DSH_SESSION_COMMANDS.includes(entry.name)),
  );
}
