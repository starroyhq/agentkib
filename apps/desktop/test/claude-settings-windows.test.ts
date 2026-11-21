import { describe, expect, it } from "vitest";
import { readClaudeSettings } from "../../../packages/backend/src/agents/claude/claude-settings";
import { virtualIo, type VirtualNode } from "./fixtures/claude-virtual-io";

function settingsFixture(
  nodes: Record<string, VirtualNode>,
  cwd = "C:\\repo\\packages\\app",
  home = "C:\\Users\\tester",
) {
  const fake = virtualIo({ [cwd]: { dir: true }, ...nodes }, "win32");
  const settings = readClaudeSettings({
    root: cwd,
    cwd,
    environment: { USERPROFILE: home },
    mode: "full",
    managedDir: null,
    platform: "win32",
    io: fake.io,
  });
  return { fake, settings, text: settings.describe("full") };
}

describe("Windows repository local Claude settings", () => {
  it("uses repository local settings ahead of cwd while retaining fields unique to cwd", () => {
    const rootFile = "C:\\repo\\.claude\\settings.local.json";
    const cwdFile = "C:\\repo\\packages\\app\\.claude\\settings.local.json";
    const f = settingsFixture({
      "C:\\repo\\.git": { dir: true },
      [rootFile]: JSON.stringify({ model: "root-local", enabledMcpjsonServers: ["approved"] }),
      [cwdFile]: JSON.stringify({ model: "old-local", theme: "cwd-theme" }),
    });
    expect(f.settings.complete).toBe(true);
    expect(f.text).toContain('model = "root-local" (local)');
    expect(f.text).toContain('theme = "cwd-theme" (local)');
    expect(f.settings.mcpApprovals().enabled.has("approved")).toBe(true);
    expect(
      f.fake.calls.filter((call) => call.call === "readFile").map((call) => call.path),
    ).toEqual([cwdFile, rootFile]);
  });

  it.each([true, false])(
    "retains cwd local settings when repository settings are absent (git=%s)",
    (git) => {
      const cwdFile = "C:\\repo\\packages\\app\\.claude\\settings.local.json";
      const f = settingsFixture({
        ...(git ? { "C:\\repo\\.git": { dir: true as const } } : {}),
        [cwdFile]: JSON.stringify({ model: "cwd-local", enabledMcpjsonServers: ["cwd-approved"] }),
      });
      expect(f.settings.complete).toBe(true);
      expect(f.text).toContain('model = "cwd-local" (local)');
      expect(f.settings.mcpApprovals().enabled.has("cwd-approved")).toBe(true);
    },
  );

  it("resolves a verified Git worktree layout before reading the common repository local file", () => {
    const cwd = "C:\\checkout\\packages\\app";
    const rootFile = "C:\\main\\.claude\\settings.local.json";
    const f = settingsFixture(
      {
        "C:\\checkout\\.git": "gitdir: C:/main/.git/worktrees/feature\n",
        "C:\\main\\.git\\worktrees\\feature\\commondir": "../..\n",
        "C:\\main\\.git\\worktrees\\feature\\gitdir": "C:/checkout/.git\n",
        [rootFile]: JSON.stringify({
          model: "main-root-local",
          enabledMcpjsonServers: ["main-approved"],
        }),
        [`${cwd}\\.claude\\settings.local.json`]: JSON.stringify({ model: "cwd-local" }),
      },
      cwd,
    );
    expect(f.settings.complete).toBe(true);
    expect(f.text).toContain('model = "main-root-local" (local)');
    expect(f.settings.mcpApprovals().enabled.has("main-approved")).toBe(true);
    expect(f.fake.calls).toContainEqual({ call: "readFile", path: rootFile });
  });

  it("keeps the cwd fallback when a worktree pointer cannot be verified", () => {
    const cwd = "C:\\checkout\\packages\\app";
    const outsideFile = "C:\\foreign\\.claude\\settings.local.json";
    const f = settingsFixture(
      {
        "C:\\checkout\\.git": "gitdir: C:/foreign/.git/worktrees/missing\n",
        [outsideFile]: JSON.stringify({ model: "unverified-root" }),
        [`${cwd}\\.claude\\settings.local.json`]: JSON.stringify({ model: "cwd-local" }),
      },
      cwd,
    );
    expect(f.text).toContain('model = "cwd-local" (local)');
    expect(f.text).not.toContain("unverified-root");
    expect(f.fake.calls).not.toContainEqual({ call: "readFile", path: outsideFile });
  });

  it("does not treat the Home repository local settings as a project setting", () => {
    const home = "C:\\Users\\tester";
    const cwd = `${home}\\project`;
    const homeFile = `${home}\\.claude\\settings.local.json`;
    const f = settingsFixture(
      {
        [`${home}\\.git`]: { dir: true },
        [homeFile]: JSON.stringify({
          model: "private-home-local",
          enabledMcpjsonServers: ["home-approved"],
        }),
        [`${cwd}\\.claude\\settings.local.json`]: JSON.stringify({ model: "project-local" }),
      },
      cwd,
      home,
    );
    expect(f.text).toContain('model = "project-local" (local)');
    expect(f.text).not.toContain("private-home-local");
    expect(f.settings.mcpApprovals().enabled.has("home-approved")).toBe(false);
    expect(f.fake.calls).not.toContainEqual({ call: "readFile", path: homeFile });
  });
});
