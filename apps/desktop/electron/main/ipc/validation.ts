import type { AgentKind } from "../../../src/core/types";

// Record 强制覆盖 AgentKind 的每个成员：新增 agent 时漏写这里会直接编译失败。
const AGENT_KINDS: Record<AgentKind, true> = {
  codex: true,
  "claude-code": true,
  antigravity: true,
  cursor: true,
  opencode: true,
  "open-claw": true,
  hermes: true,
  "grok-build": true,
  "deepseek-harness": true,
};

export function requireAgentKind(value: unknown): AgentKind {
  const agent = requireString(value, "agent");
  if (!Object.hasOwn(AGENT_KINDS, agent)) throw new Error(`Unsupported agent: ${agent}`);
  return agent as AgentKind;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

export function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

export function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

export function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined || value === null ? undefined : requireString(value, name);
}

export function optionalCloseBehavior(value: unknown): "minimize-to-tray" | "quit" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== "minimize-to-tray" && value !== "quit") {
    throw new TypeError("close behavior must be minimize-to-tray or quit");
  }
  return value;
}

export function requireThemePreference(value: unknown): "system" | "light" | "dark" {
  if (value !== "system" && value !== "light" && value !== "dark") {
    throw new TypeError("theme preference must be system, light, or dark");
  }
  return value;
}

export function requireAccentThemePreference(
  value: unknown,
): "minimal-neutral" | "vtron" | "claude" | "sakura" | "ocean-breeze" {
  if (
    value !== "minimal-neutral" &&
    value !== "vtron" &&
    value !== "claude" &&
    value !== "sakura" &&
    value !== "ocean-breeze"
  ) {
    throw new TypeError("accent theme preference is not supported");
  }
  return value;
}

export function requireAppIconPreference(value: unknown): "white" | "black" {
  if (value !== "white" && value !== "black") {
    throw new TypeError("app icon preference must be white or black");
  }
  return value;
}

export function requireSidebarWidthPreference(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 250 || value > 400) {
    throw new TypeError("sidebar width preference must be an integer between 250 and 400");
  }
  return value;
}

export function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

export function requirePositiveInteger(value: unknown, name: string): number {
  const parsed = optionalPositiveInteger(value, name);
  if (parsed === undefined) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}
