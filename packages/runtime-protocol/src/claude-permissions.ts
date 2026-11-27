export const CLAUDE_CREATION_PERMISSION_MODES = ["default", "plan", "acceptEdits"] as const;
export const CLAUDE_PERMISSION_MODES = [...CLAUDE_CREATION_PERMISSION_MODES, "auto"] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === "string" && CLAUDE_PERMISSION_MODES.some((mode) => mode === value);
}
