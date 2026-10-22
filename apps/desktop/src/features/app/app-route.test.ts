import { describe, expect, it } from "vitest";
import type { AppSearch } from "./app-route";
import { legacyAgentSettingsSearch, parseRoute, workspaceSearchForPage } from "./app-route";

describe("parseRoute", () => {
  it("distinguishes the global hub from workspace session history", () => {
    expect(parseRoute("/sessions")).toEqual({ kind: "global", page: "sessions" });
    expect(parseRoute("/workspace/example/sessions")).toEqual({
      kind: "workspace",
      workspaceId: "example",
      page: "sessions",
    });
  });
});

describe("workspaceSearchForPage", () => {
  const gitSubview = { kind: "commit", oid: "abc123" } as const;

  it("clears Git detail state when navigating to another workspace page", () => {
    const current: AppSearch = { gitSubview, doctorVerification: "applied" };

    expect(workspaceSearchForPage(current, "doctor")).toEqual({
      gitSubview: undefined,
      doctorVerification: "applied",
    });
  });

  it("preserves Git detail state when navigating to the Git page", () => {
    const current: AppSearch = { gitSubview };

    expect(workspaceSearchForPage(current, "git")).toBe(current);
  });

  it("keeps continuation recovery state only within sessions and changes", () => {
    const current: AppSearch = {
      handoffSession: "session",
      handoffTarget: "claude-code",
      handoffBudget: 120_000,
      handoffFormat: "markdown",
      handoffResume: "recheck",
    };

    expect(workspaceSearchForPage(current, "changes")).toMatchObject(current);
    expect(workspaceSearchForPage(current, "overview")).toEqual({ gitSubview: undefined });
  });

  it("carries the pre-compaction history choice with the rest of the continuation state", () => {
    const current: AppSearch = {
      handoffSession: "session",
      handoffTarget: "codex",
      handoffBudget: 120_000,
      handoffFormat: "markdown",
      handoffPreCompaction: true,
      handoffResume: "return",
    };

    expect(workspaceSearchForPage(current, "sessions")).toMatchObject(current);
    expect(workspaceSearchForPage(current, "changes")).toMatchObject(current);
    expect(workspaceSearchForPage(current, "overview")).toEqual({ gitSubview: undefined });
    expect(workspaceSearchForPage({ handoffPreCompaction: true }, "git")).toEqual({});
  });
});

describe("legacy Agent settings destination", () => {
  it("maps saved Agent and filters into the settings namespace", () => {
    expect(
      legacyAgentSettingsSearch({
        agent: "claude-code",
        agentFilter: "available",
        settingsSection: "general",
        settingsTarget: "general-interface",
      }),
    ).toEqual({
      settingsSection: "integrations",
      settingsTarget: "integrations-agents",
      settingsAgent: "claude-code",
      settingsAgentFilter: "available",
      agent: undefined,
      agentFilter: undefined,
    });
  });
  it("keeps an omitted legacy Agent eligible for the first-data default", () => {
    expect(legacyAgentSettingsSearch({}).settingsAgent).toBeUndefined();
  });
});
