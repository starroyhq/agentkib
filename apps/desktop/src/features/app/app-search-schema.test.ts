// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { appSearchSchema } from "./app-search-schema";

describe("appSearchSchema", () => {
  it.each(["library", "workspace", "discover"])(
    "accepts the Skills section %s without losing other search fields",
    (skillSection) => {
      const search = {
        assetSection: "skills",
        catalogTarget: "mcp-network",
        skillSection,
        workspaceAssetSection: "native",
        workspaceView: "storage",
        sessionId: "saved-session",
      };
      expect(appSearchSchema.parse(search)).toMatchObject(search);
    },
  );
  it("safely drops missing or invalid Skills sections", () => {
    expect(appSearchSchema.parse({}).skillSection).toBeUndefined();
    for (const skillSection of ["unknown", "Library", true, null, 1, ["library"], {}])
      expect(appSearchSchema.parse({ assetSection: "skills", skillSection })).toMatchObject({
        assetSection: "skills",
        skillSection: undefined,
      });
  });
  it("only accepts the supported MCP network destination", () => {
    expect(
      appSearchSchema.parse({ assetSection: "mcp", catalogTarget: "mcp-network" }),
    ).toMatchObject({
      assetSection: "mcp",
      catalogTarget: "mcp-network",
    });
    for (const catalogTarget of ["mcp", "unknown", true, null, 1]) {
      expect(appSearchSchema.parse({ catalogTarget }).catalogTarget).toBeUndefined();
    }
  });
  it("accepts the pre-compaction history choice only as true", () => {
    expect(appSearchSchema.parse({ handoffPreCompaction: true }).handoffPreCompaction).toBe(true);
    for (const value of [false, "true", 1, null])
      expect(appSearchSchema.parse({ handoffPreCompaction: value }).handoffPreCompaction).toBe(
        undefined,
      );
    expect(appSearchSchema.parse({}).handoffPreCompaction).toBeUndefined();
  });
  it("keeps settings Agent selection distinct from a workspace Agent", () => {
    expect(
      appSearchSchema.parse({
        agent: "codex",
        settingsSection: "integrations",
        settingsTarget: "integrations-agents",
        settingsAgent: "claude-code",
        settingsAgentFilter: "available",
      }),
    ).toMatchObject({
      agent: "codex",
      settingsAgent: "claude-code",
      settingsAgentFilter: "available",
      settingsTarget: "integrations-agents",
    });
    expect(appSearchSchema.parse({ agent: "codex" }).settingsAgent).toBeUndefined();
  });
  it("drops malformed settings Agent and filter fields without changing other navigation", () => {
    for (const settingsAgent of ["not-an-agent", true, null, {}, ["codex"]])
      expect(
        appSearchSchema.parse({ settingsAgent, settingsSection: "integrations" }),
      ).toMatchObject({ settingsAgent: undefined, settingsSection: "integrations" });
    expect(
      appSearchSchema.parse({ settingsAgentFilter: "unknown" }).settingsAgentFilter,
    ).toBeUndefined();
  });
});
