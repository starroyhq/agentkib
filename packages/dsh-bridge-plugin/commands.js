// Which of DeepSeek Harness's slash commands AgentKib runs, and for which device. One policy
// shared by the shipped plugin, which decides with the session's own command registry, and the
// AgentKib clients' `/` menus (through runtime-protocol).
//
// DSH runs `/name` itself, never the model: its own window runs a line that names a command of
// the session's agent and sends any other line as a message. `/export` downloads a file in DSH's
// own window, so AgentKib does not run it. `/goal` and `/permission <preset>` change the session's
// goal and its sandbox and approval policy, so like AgentKib's goal and settings controls they
// need a device with full access; so do commands other DSH plugins add.

/** Commands that act on this session only; any device that can send may run them. */
export const DSH_SESSION_COMMANDS = Object.freeze(["compact", "plan", "feedback"]);
export const DSH_WINDOW_ONLY_COMMANDS = Object.freeze(["export"]);
// DSH's own window leaves these out of the conversation (its chat visibility rule): a preset
// switch shows in the preset control instead, as AgentKib's execution policy does. AgentKib keeps
// one that failed, since its reason shows nowhere else.
export const DSH_HIDDEN_COMMANDS = Object.freeze(["permission"]);

// DSH's own grammar (`parseCommand`): lowercase, and whitespace or the end after the name, so a
// path such as `/private/tmp` stays text for the model.
export const DSH_COMMAND_LINE = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/;

/** Why AgentKib does not run this command for this message, or null when it does. */
export function dshCommandRefusal(name, { fullAccess = false, attachments = false } = {}) {
  if (DSH_WINDOW_ONLY_COMMANDS.includes(name)) return "dsh-command-window-only";
  if (attachments) return "dsh-command-attachments";
  if (!fullAccess && !DSH_SESSION_COMMANDS.includes(name)) return "dsh-command-full-access";
  return null;
}
