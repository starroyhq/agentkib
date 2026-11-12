import type { AgentKind, AppNavigationRequest } from "../../../src/core/types";

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
  devin: true,
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

export function optionalBoolean(value: unknown, name: string): boolean | undefined {
  return value === undefined || value === null ? undefined : requireBoolean(value, name);
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

const MAIN_WINDOW_PAGES = new Set(["home", "sessions", "quota", "settings"]);
const SETTINGS_SECTIONS = new Set([
  "general",
  "discovery",
  "integrations",
  "privacy",
  "diagnostics",
  "remote",
]);
/** A new session's first message is a composer draft; this keeps a malformed one out. */
const MAX_DRAFT_LENGTH = 100_000;

/**
 * A page of the main window the menu bar popover may open: home, a session (with the first
 * message of one it just created), the quota page or a settings section. Only those fields pass.
 */
export function requireMainWindowRequest(value: unknown): AppNavigationRequest {
  const request = requireObject(value, "navigation request");
  const page = requireString(request.page, "page");
  if (!MAIN_WINDOW_PAGES.has(page)) throw new Error(`Unsupported page: ${page}`);
  const sessionId = optionalString(request.session_id, "session_id");
  if (sessionId !== undefined && (page !== "sessions" || sessionId.length > 256))
    throw new Error("session_id is invalid");
  const draft = request.draft === undefined ? undefined : requireText(request.draft, "draft");
  if (draft !== undefined && (!sessionId || draft.length > MAX_DRAFT_LENGTH))
    throw new Error("draft is invalid");
  const provider = optionalString(request.provider, "provider");
  if (provider !== undefined && (page !== "quota" || provider.length > 256))
    throw new Error("provider is invalid");
  const section = optionalString(request.settings_section, "settings_section");
  if (section !== undefined && (page !== "settings" || !SETTINGS_SECTIONS.has(section)))
    throw new Error("settings_section is invalid");
  return {
    page: page as AppNavigationRequest["page"],
    configure_popover: false,
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    ...(draft === undefined ? {} : { draft }),
    ...(provider === undefined ? {} : { provider }),
    ...(section === undefined
      ? {}
      : { settings_section: section as AppNavigationRequest["settings_section"] }),
  };
}
