import { describe, expect, it } from "vitest";

import {
  optionalBoolean,
  requireAccentThemePreference,
  requireAgentKind,
  requireMainWindowRequest,
  requireSidebarWidthPreference,
} from "./validation";

describe("agent IPC validation", () => {
  it.each([
    "codex",
    "claude-code",
    "antigravity",
    "cursor",
    "opencode",
    "open-claw",
    "hermes",
    "grok-build",
    "deepseek-harness",
  ])("accepts the supported agent %s", (agent) => {
    expect(requireAgentKind(agent)).toBe(agent);
  });

  it.each(["unknown", "toString", "__proto__", "Codex"])(
    "rejects the unsupported agent %s",
    (agent) => {
      expect(() => requireAgentKind(agent)).toThrow(`Unsupported agent: ${agent}`);
    },
  );

  it.each([undefined, null, "", 1])("rejects the non-string agent %s", (agent) => {
    expect(() => requireAgentKind(agent)).toThrow("agent must be a non-empty string");
  });
});

describe("optional boolean IPC validation", () => {
  it.each([true, false])("accepts %s", (value) => {
    expect(optionalBoolean(value, "flag")).toBe(value);
  });
  it.each([undefined, null])("treats %s as absent", (value) => {
    expect(optionalBoolean(value, "flag")).toBeUndefined();
  });
  it.each(["true", 1, 0, {}, []])("rejects the non-boolean %s", (value) => {
    expect(() => optionalBoolean(value, "flag")).toThrow("flag must be a boolean");
  });
});
describe("sidebar width IPC validation", () => {
  it.each([250, 325, 400])("accepts integer %s", (width) => {
    expect(requireSidebarWidthPreference(width)).toBe(width);
  });

  it.each([null, undefined, "300", 249, 401, 300.5, NaN, Infinity])(
    "rejects invalid width %s",
    (width) => {
      expect(() => requireSidebarWidthPreference(width)).toThrow(
        "sidebar width preference must be an integer between 250 and 400",
      );
    },
  );
});

describe("accent theme IPC validation", () => {
  it.each(["minimal-neutral", "vtron", "claude", "sakura", "ocean-breeze"])(
    "accepts the stable theme id %s",
    (theme) => {
      expect(requireAccentThemePreference(theme)).toBe(theme);
    },
  );

  it.each(["black", "sky", "violet", "emerald", "unknown", null])(
    "rejects the non-current theme id %s",
    (theme) => {
      expect(() => requireAccentThemePreference(theme)).toThrow(
        "accent theme preference is not supported",
      );
    },
  );
});

describe("main window requests from the menu bar popover", () => {
  it("passes the pages it opens and only their fields", () => {
    expect(requireMainWindowRequest({ page: "home", extra: "dropped" })).toEqual({
      page: "home",
      configure_popover: false,
    });
    expect(
      requireMainWindowRequest({ page: "sessions", session_id: "s1", draft: "Fix it" }),
    ).toEqual({ page: "sessions", session_id: "s1", draft: "Fix it", configure_popover: false });
    expect(requireMainWindowRequest({ page: "quota", provider: "codex" })).toEqual({
      page: "quota",
      provider: "codex",
      configure_popover: false,
    });
    expect(requireMainWindowRequest({ page: "settings", settings_section: "remote" })).toEqual({
      page: "settings",
      settings_section: "remote",
      configure_popover: false,
    });
  });

  it.each([
    [{ page: "workspaces" }],
    [{ page: "home", session_id: "s1" }],
    [{ page: "sessions", draft: "text without a session" }],
    [{ page: "sessions", session_id: "x".repeat(257) }],
    [{ page: "sessions", session_id: "s1", draft: "x".repeat(100_001) }],
    [{ page: "settings", settings_section: "accounts" }],
    [{ page: "home", provider: "codex" }],
    ["sessions"],
  ])("refuses %j", (request) => {
    expect(() => requireMainWindowRequest(request)).toThrow();
  });
});
