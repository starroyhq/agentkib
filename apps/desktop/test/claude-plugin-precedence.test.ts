import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeAssets } from "../../../packages/backend/src/agents/claude/claude-assets";
import { readClaudeSettings } from "../../../packages/backend/src/agents/claude/claude-settings";
import { scanNativeMcp } from "../../../packages/backend/src/mcp-native-scan";
import { BackendStore } from "../../../packages/backend/src/store";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

const fixtures: ContextFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});
const json = (value: unknown) => JSON.stringify(value);
const pluginId = "target@market";
const switches = (enabled: boolean, count = 256) => ({
  ...Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`filler-${index}@market`, false]),
  ),
  [pluginId]: enabled,
});
function fixture() {
  const f = contextFixture();
  fixtures.push(f);
  return f;
}
function settings(f: ContextFixture) {
  return readClaudeSettings({
    root: f.project,
    cwd: f.project,
    environment: f.environment,
    mode: "full",
    managedDir: f.managedDir,
  });
}
function install(f: ContextFixture) {
  const dir = f.inHome(".claude", "plugins", "cache", "market", "target", "1");
  f.write(
    path.join(dir, "commands", "private-command.md"),
    "---\ndescription: PLUGIN-COMMAND-DESCRIPTION\n---\nPLUGIN-COMMAND-BODY\n",
  );
  f.write(
    path.join(dir, "hooks", "hooks.json"),
    json({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo PLUGIN-HOOK-COMMAND" }] }],
      },
    }),
  );
  f.write(
    path.join(dir, ".mcp.json"),
    json({
      mcpServers: {
        private_server: { command: "PLUGIN-SERVER-EXECUTABLE", args: ["PLUGIN-SERVER-ARGUMENT"] },
      },
    }),
  );
  f.user(
    "plugins/installed_plugins.json",
    json({
      version: 2,
      plugins: { [pluginId]: [{ scope: "user", installPath: dir, version: "1" }] },
    }),
  );
}

describe("effective plugin switches beyond the display budget", () => {
  it.each([255, 256, 300])("keeps a managed false override after %i entries", (count) => {
    const f = fixture();
    f.user("settings.json", json({ enabledPlugins: { [pluginId]: true } }));
    f.write(
      path.join(f.managedDir, "managed-settings.json"),
      json({ enabledPlugins: switches(false, count) }),
    );
    const value = settings(f);
    expect(value.complete).toBe(true);
    expect(value.enabledPlugins().size).toBe(count + 1);
    expect(value.enabledPlugins().get(pluginId)).toEqual({ enabled: false, layer: "managed" });
  });

  it("merges every layer and sorted managed drop-in before applying the display limit", () => {
    const f = fixture();
    f.user("settings.json", json({ enabledPlugins: switches(true) }));
    f.write(
      ".claude/settings.json",
      json({ enabledPlugins: { [pluginId]: false, "project@market": true } }),
    );
    f.write(
      ".claude/settings.local.json",
      json({ enabledPlugins: { [pluginId]: true, "local@market": true } }),
    );
    f.write(
      path.join(f.managedDir, "managed-settings.json"),
      json({ enabledPlugins: switches(false) }),
    );
    f.write(
      path.join(f.managedDir, "managed-settings.d", "20-last.json"),
      json({ enabledPlugins: { [pluginId]: true } }),
    );
    f.write(
      path.join(f.managedDir, "managed-settings.d", "10-first.json"),
      json({ enabledPlugins: { [pluginId]: false } }),
    );
    const value = settings(f);
    expect(value.complete).toBe(true);
    expect(value.enabledPlugins().get(pluginId)).toEqual({ enabled: true, layer: "managed" });
    expect(value.enabledPlugins().get("project@market")).toEqual({
      enabled: true,
      layer: "project",
    });
    expect(value.enabledPlugins().get("local@market")).toEqual({ enabled: true, layer: "local" });
    expect(value.describe("full")).not.toContain(pluginId);
  });

  it.each([false, true])(
    "uses the 257th managed switch (%s) for installed Context and MCP assets",
    async (enabled) => {
      const f = fixture();
      install(f);
      f.user("settings.json", json({ enabledPlugins: { [pluginId]: !enabled } }));
      f.write(
        path.join(f.managedDir, "managed-settings.json"),
        json({ enabledPlugins: switches(enabled) }),
      );
      const value = settings(f);
      const assets = readClaudeAssets({
        root: f.project,
        dirs: [f.project],
        environment: f.environment,
        mode: "full",
        settings: value,
      });
      expect(assets.plugins.map((plugin) => plugin.id)).toEqual(enabled ? [pluginId] : []);
      expect(assets.installedOnly).toEqual(enabled ? [] : [pluginId]);
      const preview = await f.request();
      const renderer = json(preview);
      if (enabled) {
        expect(assets.plugins[0]?.commands[0]?.description).toBe("PLUGIN-COMMAND-DESCRIPTION");
        expect(renderer).toContain("commands: private-command");
        expect(renderer).toContain("PLUGIN-HOOK-COMMAND");
      } else {
        for (const body of ["PLUGIN-COMMAND", "PLUGIN-HOOK", "private_server", "PLUGIN-SERVER"])
          expect(renderer).not.toContain(body);
      }
      for (const agent of ["claude-code", "codex"]) {
        const output = json(await f.mcp(f.project, agent));
        for (const body of ["PLUGIN-COMMAND", "PLUGIN-HOOK", "private_server", "PLUGIN-SERVER"])
          expect(output).not.toContain(body);
      }
      const store = new BackendStore(path.join(f.root, "db.sqlite"));
      try {
        store.sql.run(
          "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
          "workspace",
          f.project,
          "fixture",
          "healthy",
          new Date().toISOString(),
        );
        const candidates = scanNativeMcp({ project: f.project }, store, f.environment, {
          managedDir: f.managedDir,
        }).filter((candidate) => candidate.scope === "plugin");
        expect(candidates.map((candidate) => candidate.name)).toEqual(
          enabled ? ["private_server"] : [],
        );
        if (!enabled) expect(json(candidates)).not.toContain("PLUGIN-SERVER");
      } finally {
        store.close();
      }
    },
  );
});
