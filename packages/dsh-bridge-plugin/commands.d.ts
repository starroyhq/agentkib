export const DSH_SESSION_COMMANDS: readonly string[];
export const DSH_WINDOW_ONLY_COMMANDS: readonly string[];
export const DSH_HIDDEN_COMMANDS: readonly string[];
export const DSH_COMMAND_LINE: RegExp;
export function dshCommandRefusal(
  name: string,
  options?: { fullAccess?: boolean; attachments?: boolean },
): "dsh-command-window-only" | "dsh-command-attachments" | "dsh-command-full-access" | null;
