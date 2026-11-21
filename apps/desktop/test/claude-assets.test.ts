import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeAssets } from "../../../packages/backend/src/agents/claude/claude-assets";
import { readClaudeSettings } from "../../../packages/backend/src/agents/claude/claude-settings";
import { isSensitiveExternalPath } from "../../../packages/backend/src/context-claude";
import { scanNativeMcp } from "../../../packages/backend/src/mcp-native-scan";
import { canonicalize } from "../../../packages/backend/src/paths";
import { BackendStore } from "../../../packages/backend/src/store";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";
import { virtualIo, type VirtualNode } from "./fixtures/claude-virtual-io";

// Plugins, commands, agents, output styles, workflows and hooks, listed read-only
// (https://code.claude.com/docs/en/plugins/loading and /plugins/components). Settings decide which
// plugins are on; `installed_plugins.json` says where they live.

const fixtures: ContextFixture[] = [];
const cleanups: Array<() => void> = [];
function fixture() {
  const created = contextFixture();
  fixtures.push(created);
  return created;
}
afterEach(() => {
  for (const created of fixtures.splice(0)) created.dispose();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const json = (value: unknown) => JSON.stringify(value, null, 2);
const block = (
  preview: { sections: { source: string; scope: string; content: string }[] },
  title: string,
) => preview.sections.find((section) => section.scope === "assets" && section.source === title);
const everything = (value: unknown) => JSON.stringify(value);
const md = (front: Record<string, string>, body = "Body\n") =>
  `---\n${Object.entries(front)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n${body}`;

/** A plugin on disk, recorded as installed and (by default) enabled in the user's settings. */
function plugin(
  f: ContextFixture,
  id: string,
  files: Record<string, string>,
  options: {
    enabled?: boolean | null;
    manifest?: unknown;
    extraEnabled?: Record<string, boolean>;
  } = {},
) {
  const [name, origin] = id.split("@");
  const dir = path.join(f.home, ".claude", "plugins", "cache", origin!, name!, "1.0.0");
  mkdirSync(dir, { recursive: true });
  for (const [relative, content] of Object.entries(files))
    f.write(path.join(dir, relative), content);
  if (options.manifest !== undefined)
    f.write(path.join(dir, ".claude-plugin", "plugin.json"), json(options.manifest));
  const record = path.join(f.home, ".claude", "plugins", "installed_plugins.json");
  let installed: { version: number; plugins: Record<string, unknown[]> } = {
    version: 2,
    plugins: {},
  };
  try {
    installed = JSON.parse(require("node:fs").readFileSync(record, "utf8"));
  } catch {
    // The first plugin creates the record.
  }
  installed.plugins[id] = [{ scope: "user", installPath: dir, version: "1.0.0" }];
  f.write(record, json(installed));
  if (options.enabled !== null) {
    const settingsFile = path.join(f.home, ".claude", "settings.json");
    let settings: { enabledPlugins?: Record<string, boolean> } = {};
    try {
      settings = JSON.parse(require("node:fs").readFileSync(settingsFile, "utf8"));
    } catch {
      // The first plugin creates the file.
    }
    settings.enabledPlugins = {
      ...settings.enabledPlugins,
      [id]: options.enabled ?? true,
      ...options.extraEnabled,
    };
    f.write(settingsFile, json(settings));
  }
  return dir;
}

function installs(f: ContextFixture, records: Record<string, unknown[]>) {
  f.user("plugins/installed_plugins.json", json({ version: 2, plugins: records }));
}

function assets(f: ContextFixture, root = f.project, withoutProject = false) {
  return readClaudeAssets({
    root,
    dirs: [root],
    environment: f.environment,
    mode: "full",
    withoutProject,
    settings: readClaudeSettings({
      root,
      cwd: root,
      environment: f.environment,
      mode: "full",
      withoutProject,
      managedDir: f.managedDir,
    }),
  });
}

function virtualPlugin(manifest: unknown, nodes: Record<string, VirtualNode>) {
  const fake = virtualIo({
    "/w": { dir: true },
    "/home/test/.claude/settings.json": json({ enabledPlugins: { "tool@market": true } }),
    "/home/test/.claude/plugins/installed_plugins.json": json({
      plugins: { "tool@market": [{ scope: "user", installPath: "/cache/tool" }] },
    }),
    "/cache/tool/.claude-plugin/plugin.json": json(manifest),
    ...nodes,
  });
  const options = {
    root: "/w",
    cwd: "/w",
    environment: { HOME: "/home/test" },
    mode: "full" as const,
    platform: "linux" as const,
    managedDir: null,
    io: fake.io,
    sensitive: isSensitiveExternalPath,
  };
  return {
    fake,
    read: () =>
      readClaudeAssets({ ...options, dirs: ["/w"], settings: readClaudeSettings(options) }),
  };
}

describe("plugins", () => {
  it.each(["commands", "agents", "outputStyles"] as const)(
    "refuses sensitive and oversized manifest %s files before reading them",
    (component) => {
      const { fake, read } = virtualPlugin(
        { [component]: ["./secret.md", "./linked.md", "./.ssh/alias.md", "./huge.md", "./ok.md"] },
        {
          "/cache/tool/secret.md": md({ description: "PRIVATE-MARKER" }),
          "/cache/tool/linked.md": { link: "secret.md" },
          "/cache/tool/.ssh/alias.md": { link: "../private-target.md" },
          "/cache/tool/private-target.md": md({ description: "PRIVATE-MARKER" }),
          "/cache/tool/huge.md": md({ description: "TOO-LARGE" }, "x".repeat(256 * 1024)),
          "/cache/tool/ok.md": md({ description: "Allowed" }),
        },
      );
      const result = read().plugins[0]!;
      expect(result[component].map((item) => item.name)).toEqual(["ok"]);
      expect(
        fake.calls.filter((call) => call.call === "readFile" && call.path.endsWith(".md")),
      ).toEqual([{ call: "readFile", path: "/cache/tool/ok.md" }]);
    },
  );

  it.each([
    { skills: "./extra-skills/" },
    { skills: ["./extra-skills/", "./direct/", "./skills/", "./alias/"] },
  ])(
    "adds declared skill directories to the defaults and deduplicates them: $skills",
    ({ skills }) => {
      const { read } = virtualPlugin(
        { skills },
        {
          "/cache/tool/skills/default/SKILL.md": "default",
          "/cache/tool/extra-skills/extra/SKILL.md": "extra",
          "/cache/tool/direct/SKILL.md": "direct",
          "/cache/tool/alias": { link: "extra-skills" },
        },
      );
      expect(read().plugins[0]!.skills).toEqual(
        typeof skills === "string" ? ["default", "extra"] : ["default", "extra", "direct"],
      );
    },
  );

  it.each([".", "./"])("accepts a skill at the plugin root declared as %s", (skills) => {
    const { read } = virtualPlugin(
      { skills },
      { "/cache/tool/SKILL.md": "root", "/cache/tool/skills/default/SKILL.md": "default" },
    );
    expect(read().plugins[0]!.skills).toEqual(["default", "tool"]);
  });

  it("keeps custom skill discovery inside the plugin and away from sensitive or network paths", () => {
    const { fake, read } = virtualPlugin(
      {
        skills: [
          "../outside",
          "/outside",
          "./.ssh",
          "./linked",
          "./external",
          "./remote",
          "./extras",
        ],
      },
      {
        "/cache/tool/.ssh/hidden/SKILL.md": "sensitive",
        "/cache/tool/linked": { link: ".ssh" },
        "/cache/tool/external": { link: "/outside" },
        "/outside/hidden/SKILL.md": "external",
        "/cache/tool/remote": { link: "/net/host" },
        "/cache/tool/extras/allowed/SKILL.md": "allowed",
        "/cache/tool/extras/secret": { link: "../.ssh/hidden" },
        "/cache/tool/extras/escaped": { link: "/outside/hidden" },
      },
    );
    expect(read().plugins[0]!.skills).toEqual(["allowed"]);
    expect(fake.below("/net")).toEqual([]);
    expect(
      fake.calls.filter((call) => call.call === "readdir").map((call) => call.path),
    ).not.toContain("/cache/tool/.ssh");
    expect(
      fake.calls.some((call) => call.call === "readFile" && call.path.endsWith("SKILL.md")),
    ).toBe(false);
  });

  it("bounds the combined default and custom skill listing", () => {
    const { read } = virtualPlugin(
      { skills: "./extras" },
      Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [
          `/cache/tool/${index < 25 ? "skills" : "extras"}/skill-${String(index).padStart(2, "0")}/SKILL.md`,
          "skill",
        ]),
      ),
    );
    const result = read();
    expect(result.plugins[0]!.skills).toHaveLength(40);
    expect(result.limited).toBe(true);
  });

  it.each(["project", "local"])(
    "reads only this workspace's %s install, including one after unrelated records",
    async (scope) => {
      const f = fixture();
      const otherProject = f.mkdir(f.outside("other-project"));
      const here = plugin(f, "tool@market", {
        "commands/here.md": md({ description: "Current workspace" }),
      });
      const elsewhere = f.mkdir(f.outside("other-install"));
      f.write(path.join(elsewhere, "commands/elsewhere.md"), md({ description: "Other project" }));
      installs(f, {
        "tool@market": [
          ...Array.from({ length: 8 }, () => ({
            scope,
            projectPath: otherProject,
            installPath: elsewhere,
            version: "other-version",
          })),
          { scope, projectPath: `${f.project}${path.sep}`, installPath: here, version: "here" },
        ],
      });
      const current = assets(f).plugins[0]!;
      expect(current.version).toBe("here");
      expect(current.commands.map((command) => command.name)).toEqual(["here"]);
      const other = assets(f, otherProject).plugins[0]!;
      expect(other.version).toBe("other-version");
      expect(other.commands.map((command) => command.name)).toEqual(["elsewhere"]);
      const preview = await f.request();
      expect(block(preview, "Claude Code plugins")!.content).toContain("tool@market here:");
      expect(everything(preview)).not.toContain("other-version");
    },
  );

  it("does not claim unknown, unscoped, relative or ambiguous project installs", () => {
    const f = fixture();
    const dir = plugin(f, "tool@market", { "commands/wrong.md": md({ description: "Wrong" }) });
    const excluded = [
      { scope: "unknown", projectPath: f.project },
      {},
      { scope: "project" },
      { scope: "local", projectPath: "project" },
      { scope: "project", projectPath: `${f.project}/../project` },
      { scope: "project", projectPath: path.dirname(f.project) },
      { scope: "project", projectPath: f.at("child") },
    ].map((record) => ({ ...record, installPath: dir }));
    installs(f, { "tool@market": excluded, "other-only@market": excluded });
    const result = assets(f);
    expect(result.plugins[0]!.installed).toBe(false);
    expect(result.plugins[0]!.commands).toEqual([]);
    expect(result.installedOnly).toEqual([]);
  });

  it("does not infer ownership from an unresolved project alias", () => {
    if (process.platform === "win32") return;
    const f = fixture();
    const dir = plugin(f, "tool@market", {});
    const alias = f.link(f.project, f.outside("project-alias"));
    installs(f, {
      "tool@market": [{ scope: "local", projectPath: alias, installPath: dir }],
    });
    expect(assets(f).plugins[0]!.installed).toBe(false);
    installs(f, {
      "tool@market": [{ scope: "local", projectPath: f.project, installPath: dir }],
    });
    expect(assets(f, alias).plugins[0]!.installed).toBe(true);
  });

  it("lists the enabled plugins with the components each one provides", async () => {
    const f = fixture();
    plugin(
      f,
      "tool@market",
      {
        "commands/hello.md": md({ description: "Say hello" }),
        "commands/db/migrate.md": md({ description: "Run migrations" }),
        "agents/reviewer.md": md({
          name: "reviewer",
          description: "Reviews code",
          tools: "Read, Grep",
          model: "sonnet",
        }),
        "skills/lint/SKILL.md": "skill\n",
        "output-styles/terse.md": md({ name: "terse", description: "Short answers" }),
        "hooks/hooks.json": json({
          hooks: {
            PostToolUse: [
              { matcher: "Write|Edit", hooks: [{ type: "command", command: "./fmt.sh" }] },
            ],
          },
        }),
        ".mcp.json": json({ mcpServers: { db: { type: "http", url: "https://db.example" } } }),
      },
      { manifest: { name: "tool", version: "1.0.0" } },
    );
    plugin(f, "other@market", { "commands/x.md": md({ description: "x" }) }, { enabled: false });
    plugin(f, "idle@market", {}, { enabled: null });
    const preview = await f.request();
    const text = block(preview, "Claude Code plugins")!.content;
    expect(text).toContain(
      "- tool@market 1.0.0: enabled (user settings); 2 commands, 1 agent, 1 skill, 1 output style, 1 hook, 1 MCP server",
    );
    expect(text).toContain("commands: db:migrate, hello");
    expect(text).toContain("agents: reviewer");
    expect(text).toContain("skills: lint");
    expect(text).toContain("output styles: terse");
    expect(text).toContain("MCP servers: db");
    // A plugin that settings turn off, or never turn on, is not enabled.
    expect(text).not.toContain("- other@market");
    expect(text).toContain("Installed, not enabled: ");
    expect(text).toContain("other@market");
    expect(text).toContain("idle@market");
    const hooks = block(preview, "Claude Code hooks")!.content;
    expect(hooks).toContain("PostToolUse [Write|Edit]: command ./fmt.sh (plugin:tool@market)");
  });

  it("reports an enabled plugin that is not installed, and one whose folder is gone", async () => {
    const f = fixture();
    const dir = plugin(f, "gone@market", {});
    rmSync(dir, { recursive: true });
    f.user(
      "settings.json",
      json({ enabledPlugins: { "gone@market": true, "never@market": true } }),
    );
    const text = block(await f.request(), "Claude Code plugins")!.content;
    expect(text).toContain("- gone@market 1.0.0: enabled (user settings), not found on disk");
    expect(text).toContain("- never@market: enabled (user settings), not installed");
  });

  it("lets a manifest path replace the default commands folder", async () => {
    const f = fixture();
    plugin(
      f,
      "tool@market",
      {
        "commands/default.md": md({ description: "d" }),
        "extras/custom.md": md({ description: "c" }),
      },
      { manifest: { name: "tool", commands: ["./extras/"] } },
    );
    const text = block(await f.request(), "Claude Code plugins")!.content;
    expect(text).toContain("commands: custom");
    expect(text).not.toContain("default");
  });

  it("does not follow a link out of the plugin, and refuses an install path with ..", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    const dir = plugin(f, "tool@market", { "agents/ok.md": md({ description: "ok" }) });
    const outside = f.write(
      f.outside("elsewhere", "stolen.md"),
      md({ description: "LINK-CANARY" }),
    );
    symlinkSync(outside, path.join(dir, "agents", "stolen.md"));
    plugin(f, "bad@market", {});
    f.write(
      path.join(f.home, ".claude", "plugins", "installed_plugins.json"),
      json({
        version: 2,
        plugins: {
          "tool@market": [{ scope: "user", installPath: dir, version: "1" }],
          "bad@market": [{ scope: "user", installPath: `${dir}/../../escape`, version: "1" }],
        },
      }),
    );
    const preview = await f.request();
    const text = block(preview, "Claude Code plugins")!.content;
    expect(text).toMatch(/^ {4}agents: ok$/m);
    expect(text).not.toContain("stolen");
    expect(everything(preview)).not.toContain("LINK-CANARY");
    expect(text).toContain(
      "- bad@market 1: enabled (user settings), the install path is not usable",
    );
  });

  it("changes nothing when there are no plugins or assets", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "project\n");
    const preview = await f.request();
    expect(preview.sections.map((section) => section.scope)).toEqual([""]);
    expect(preview.warnings).toEqual([]);
  });
});

describe("commands, agents, output styles and workflows", () => {
  it("lists the project's and the user's, with name, description, tools and model", async () => {
    const f = fixture();
    f.write(".claude/commands/review.md", md({ description: "Review the diff" }));
    f.write(".claude/commands/ops/deploy.md", md({ description: "Deploy" }));
    f.write(
      ".claude/agents/planner.md",
      md({ name: "planner", description: "Plans work", tools: "Read, Write", model: "opus" }),
    );
    f.write(".claude/output-styles/brief.md", md({ name: "Brief", description: "Be brief" }));
    f.write(".claude/workflows/fanout.js", "export default 1;\n");
    f.user("commands/mine.md", md({ description: "Mine" }));
    f.user("agents/helper.md", md({ description: "Helps" }));
    f.user("output-styles/calm.md", md({ description: "Calm" }));
    f.user("workflows/nightly.js", "export default 2;\n");
    const preview = await f.request();
    const commands = block(preview, "Claude Code commands")!.content;
    expect(commands).toContain("- review [project] - Review the diff");
    expect(commands).toContain("- ops:deploy [project] - Deploy");
    expect(commands).toContain("- mine [user] - Mine");
    expect(block(preview, "Claude Code agents")!.content).toContain(
      "- planner [project] - Plans work (tools: Read, Write; model: opus)",
    );
    expect(block(preview, "Claude Code agents")!.content).toContain("- helper [user] - Helps");
    expect(block(preview, "Claude Code output styles")!.content).toContain(
      "- Brief [project] - Be brief",
    );
    const workflows = block(preview, "Claude Code workflows")!.content;
    expect(workflows).toContain("- fanout [project]");
    expect(workflows).toContain("- nightly [user]");
  });

  it("redacts a description that carries a credential", async () => {
    const f = fixture();
    f.write(
      ".claude/commands/leak.md",
      md({ description: '"call with Authorization: Bearer ASSET-CANARY-1a2b3c4d5e6f7g8h"' }),
    );
    const preview = await f.request();
    expect(everything(preview)).not.toContain("ASSET-CANARY");
    expect(block(preview, "Claude Code commands")!.content).toContain("[REDACTED]");
  });

  it("stops at its bounds and says so", async () => {
    const f = fixture();
    for (let index = 0; index < 140; index++)
      f.write(`.claude/commands/c${String(index).padStart(3, "0")}.md`, md({ description: "d" }));
    const preview = await f.request();
    const lines = block(preview, "Claude Code commands")!.content.split("\n");
    expect(lines.length).toBeLessThanOrEqual(129);
    expect(preview.warnings.join("\n")).toContain("more files than AgentKib lists");
  });

  it("keeps a link that leads out of the workspace out of the project's list for MCP", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    f.link(
      f.write(f.outside("shared", "ext.md"), md({ description: "EXT" })),
      ".claude/commands/ext.md",
    );
    f.write(".claude/commands/inside.md", md({ description: "INSIDE" }));
    const preview = await f.mcp();
    const commands = block(preview, "Claude Code commands")!.content;
    expect(commands).toContain("- inside [project] - INSIDE");
    expect(commands).not.toContain("EXT");
    expect(preview.warnings.join("\n")).toContain("1 command outside the workspace");
  });
});

describe("hooks", () => {
  it("lists the hooks of every settings layer with redacted commands", async () => {
    const f = fixture();
    f.user(
      "settings.json",
      json({
        hooks: {
          Stop: [
            {
              hooks: [{ type: "command", command: "notify --token HOOK-CANARY-9z8y7x6w5v4u3t2s" }],
            },
          ],
        },
      }),
    );
    f.write(
      ".claude/settings.json",
      json({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./check.sh" }] }],
        },
      }),
    );
    const preview = await f.request();
    const text = block(preview, "Claude Code hooks")!.content;
    expect(text).toContain("- PreToolUse [Bash]: command ./check.sh (project)");
    expect(text).toContain("- Stop: command notify --token [REDACTED] (user)");
    expect(everything(preview)).not.toContain("HOOK-CANARY");
  });
});

describe("over MCP", () => {
  it("gives the project's own items, and only counts for the user's items and the plugins", async () => {
    const f = fixture();
    plugin(f, "secretname@market", {
      "commands/plug.md": md({ description: "PLUGIN-DETAIL" }),
      "hooks/hooks.json": json({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "./PLUGIN-HOOK.sh" }] }] },
      }),
    });
    f.user("commands/personal.md", md({ description: "PERSONAL-DETAIL" }));
    f.user("agents/personal-agent.md", md({ description: "PERSONAL-AGENT" }));
    f.write(".claude/commands/shared.md", md({ description: "SHARED-DETAIL" }));
    // The listing is Claude Code's; another Agent's context never carries these sources.
    expect(everything(await f.mcp(f.project, "codex"))).not.toContain("secretname");
    {
      const preview = await f.mcp(f.project, "claude-code");
      const output = everything(preview);
      expect(block(preview, "Claude Code commands")!.content).toBe(
        "- shared [project] - SHARED-DETAIL",
      );
      for (const hidden of [
        "PLUGIN-DETAIL",
        "PERSONAL-DETAIL",
        "PERSONAL-AGENT",
        "secretname",
        "PLUGIN-HOOK",
        f.home,
      ])
        expect(output).not.toContain(hidden);
      const notes = preview.warnings.join("\n");
      expect(notes).toContain("Claude Code commands: 1 command outside the workspace");
      expect(notes).toContain("Claude Code agents: 1 agent outside the workspace");
      expect(notes).toContain(
        "Claude Code plugins: 1 plugin enabled, 1 installed, providing 1 command, 0 agents, 0 output styles, 1 hook and 0 MCP servers",
      );
      expect(notes).toContain("Claude Code hooks: 1 hook from plugins");
    }
  });
});

describe("for the Doctor", () => {
  it("reads nothing", async () => {
    const f = fixture();
    plugin(f, "tool@market", { "commands/a.md": md({ description: "a" }) });
    f.write(".claude/commands/b.md", md({ description: "b" }));
    f.write("CLAUDE.md", "project\n");
    const preview = await f.resolve(f.project, { includeOutsideSources: false });
    expect(preview.sections.map((section) => section.scope)).toEqual([""]);
    expect(preview.warnings).toEqual([]);
    const assets = readClaudeAssets({
      root: f.project,
      dirs: [f.project],
      environment: f.environment,
      mode: "none",
      settings: readClaudeSettings({
        root: f.project,
        cwd: f.project,
        environment: f.environment,
        mode: "none",
      }),
    });
    expect(assets.plugins).toEqual([]);
    expect(assets.commands).toEqual([]);
  });
});

describe("plugin MCP servers in the MCP view", () => {
  function setup() {
    const f = fixture();
    const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "claude-plugin-mcp-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const store = new BackendStore(path.join(root, "db.sqlite"));
    cleanups.push(() => store.close());
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
      "registered",
      f.project,
      "fixture",
      "healthy",
      new Date().toISOString(),
    );
    const scan = (project: string | null = f.project) =>
      scanNativeMcp(project === null ? {} : { project }, store, f.environment, {
        managedDir: f.managedDir,
      }).filter((item) => item.agent === "claude-code");
    return { f, scan, store };
  }
  const SECRET = "PLUGIN-MCP-CANARY-0a1b2c";

  it.each([
    [".mcp.json", false],
    [".mcp.json", true],
    ["extra-mcp.json", false],
    ["extra-mcp.json", true],
  ] as const)("reads plugin file %s with wrapper=%s through the MCP scanner", (file, wrapped) => {
    const { f, scan } = setup();
    const servers = {
      plugin_server: {
        type: "http",
        url: "https://plugin.example/mcp",
        headers: { Authorization: `Bearer ${SECRET}` },
      },
    };
    const dir = plugin(
      f,
      "tool@market",
      { [file]: json(wrapped ? { mcpServers: servers } : servers) },
      file === ".mcp.json" ? {} : { manifest: { mcpServers: `./${file}` } },
    );
    expect(assets(f).plugins[0]!.mcp).toEqual([
      { plugin: "tool@market", file: path.join(dir, file), servers },
    ]);
    const candidates = scan().filter((item) => item.scope === "plugin");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: "plugin_server",
      endpoint: "https://plugin.example/mcp",
      source_path: path.join(dir, file),
      supported: false,
    });
    expect(everything(candidates)).not.toContain(SECRET);
  });

  it.each([{}, null, [], "broken", 42])(
    "does not reinterpret an empty or invalid MCP wrapper (%j) as a server map",
    (mcpServers) => {
      const { f, scan } = setup();
      const malformed = { mcpServers, sibling: { type: "http", url: "https://fake.example" } };
      plugin(
        f,
        "tool@market",
        { ".mcp.json": json(malformed), "extra-mcp.json": json(malformed) },
        { manifest: { mcpServers: "./extra-mcp.json" } },
      );
      expect(assets(f).plugins[0]!.mcp).toEqual([]);
      expect(scan().filter((item) => item.scope === "plugin")).toEqual([]);
    },
  );

  it.each(["inline", "file"])(
    "uses the last plugin MCP definition and its source when %s comes last",
    (last) => {
      const { f, scan } = setup();
      const inline = { db: { type: "http", url: "https://inline.example" } };
      const earlier = { db: { type: "http", url: "https://earlier.example" } };
      const file = "./extra-mcp.json";
      const dir = plugin(
        f,
        "tool@market",
        {
          ".mcp.json": json({
            mcpServers: {
              db: { type: "http", url: "https://default.example" },
              retained: { type: "http", url: "https://retained.example" },
            },
          }),
          "extra-mcp.json": json({
            db: { type: "http", url: "https://file.example" },
            extra: { type: "http", url: "https://extra.example" },
          }),
        },
        { manifest: { mcpServers: last === "inline" ? [earlier, file, inline] : [inline, file] } },
      );
      const source = path.join(
        dir,
        last === "inline" ? ".claude-plugin/plugin.json" : "extra-mcp.json",
      );
      const definitions = assets(f).plugins[0]!.mcp.flatMap((entry) =>
        Object.entries(entry.servers).map(([name, server]) => ({ name, server, file: entry.file })),
      );
      expect(definitions.filter((entry) => entry.name === "db")).toEqual([
        { name: "db", server: { type: "http", url: `https://${last}.example` }, file: source },
      ]);
      expect(definitions.map((entry) => entry.name).sort()).toEqual(["db", "extra", "retained"]);
      const servers = scan().filter((item) => item.scope === "plugin");
      expect(servers.map((item) => item.name).sort()).toEqual(["db", "extra", "retained"]);
      expect(servers.find((item) => item.name === "db")).toMatchObject({
        endpoint: `https://${last}.example`,
        source_path: source,
      });
    },
  );

  it("keeps same-named MCP servers from separate plugins separate", () => {
    const { f, scan } = setup();
    for (const name of ["first", "second"])
      plugin(
        f,
        `${name}@market`,
        {},
        {
          manifest: { mcpServers: { db: { type: "http", url: `https://${name}.example` } } },
        },
      );
    const servers = scan().filter((item) => item.scope === "plugin");
    expect(servers).toHaveLength(2);
    expect(servers.map((item) => item.endpoint).sort()).toEqual([
      "https://first.example",
      "https://second.example",
    ]);
  });

  it("selects each registered workspace's own plugin MCP servers", () => {
    const { f, scan, store } = setup();
    const other = f.mkdir(f.outside("other-project"));
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
      "other",
      other,
      "other",
      "healthy",
      new Date().toISOString(),
    );
    const here = plugin(f, "tool@market", {
      ".mcp.json": json({ mcpServers: { here: { type: "http", url: "https://here.example" } } }),
    });
    const elsewhere = f.mkdir(f.outside("other-install"));
    f.write(
      path.join(elsewhere, ".mcp.json"),
      json({ mcpServers: { elsewhere: { type: "http", url: "https://elsewhere.example" } } }),
    );
    installs(f, {
      "tool@market": [
        { scope: "project", projectPath: other, installPath: elsewhere },
        { scope: "project", projectPath: f.project, installPath: here },
      ],
    });
    const current = scan().filter((item) => item.scope === "plugin");
    expect(current.map((item) => item.name)).toEqual(["here"]);
    expect(everything(current)).not.toContain("elsewhere.example");
    expect(
      scan(other)
        .filter((item) => item.scope === "plugin")
        .map((item) => item.name),
    ).toEqual(["elsewhere"]);
  });

  it("excludes project installs from global scans while retaining user and managed installs", () => {
    const { f, scan } = setup();
    const atHome = plugin(f, "project@market", {
      ".mcp.json": json({ mcpServers: { project: { type: "http", url: "https://p.example" } } }),
    });
    const user = plugin(f, "user@market", {
      ".mcp.json": json({ mcpServers: { user: { type: "http", url: "https://u.example" } } }),
    });
    const managed = plugin(f, "managed@market", {
      ".mcp.json": json({ mcpServers: { managed: { type: "http", url: "https://m.example" } } }),
    });
    installs(f, {
      "project@market": [{ scope: "project", projectPath: f.home, installPath: atHome }],
      "local-only@market": [{ scope: "local", projectPath: f.home, installPath: atHome }],
      "user@market": [{ scope: "user", installPath: user }],
      "managed@market": [{ scope: "managed", installPath: managed }],
    });
    expect(
      scan(null)
        .filter((item) => item.scope === "plugin")
        .map((item) => item.name),
    ).toEqual(["managed", "user"]);
    const global = assets(f, f.home, true);
    expect(global.plugins.filter((entry) => entry.installed).map((entry) => entry.id)).toEqual([
      "user@market",
      "managed@market",
    ]);
    expect(global.installedOnly).toEqual([]);
  });

  it("shows them read-only with the plugin that provides them, without any credential", () => {
    const { f, scan } = setup();
    plugin(f, "tool@market", {
      ".mcp.json": json({
        mcpServers: {
          db: {
            type: "http",
            url: "https://db.example",
            headers: { Authorization: `Bearer ${SECRET}` },
          },
          local: { command: "node", args: ["server.js"], env: { TOKEN: SECRET } },
        },
      }),
    });
    plugin(
      f,
      "off@market",
      {
        ".mcp.json": json({
          mcpServers: { hidden: { type: "http", url: "https://hidden.example" } },
        }),
      },
      { enabled: false },
    );
    const items = scan().filter((item) => item.scope === "plugin");
    expect(items.map((item) => [item.name, item.supported, item.transport])).toEqual([
      ["db", false, "http"],
      ["local", false, "stdio"],
    ]);
    expect(JSON.stringify(items)).not.toContain(SECRET);
    expect(JSON.stringify(items)).not.toContain("hidden.example");
    const diagnostics = items[0]!.warning_messages!.map((message) => [message.key, message.params]);
    expect(diagnostics).toContainEqual([
      "mcp.manage.diagnostic.native_plugin_provided",
      { plugin: "tool@market" },
    ]);
    expect(items[0]!.has_secret_values).toBe(true);
  });

  it("marks a plugin server that duplicates one configured directly", () => {
    const { f, scan } = setup();
    plugin(f, "tool@market", {
      ".mcp.json": json({
        mcpServers: {
          twin: { type: "http", url: "https://same.example/mcp" },
          solo: { type: "http", url: "https://solo.example" },
        },
      }),
    });
    f.write(
      ".mcp.json",
      json({ mcpServers: { direct: { type: "http", url: "https://same.example/mcp" } } }),
    );
    f.user(
      "settings.json",
      json({ enabledPlugins: { "tool@market": true }, enabledMcpjsonServers: ["direct"] }),
    );
    const items = scan().filter((item) => item.scope === "plugin");
    const codes = (name: string) =>
      items
        .find((item) => item.name === name)!
        .warning_messages!.map((message) => message.key.replace(/^.*diagnostic\./, ""));
    expect(codes("twin")).toContain("native_plugin_duplicate");
    expect(codes("solo")).not.toContain("native_plugin_duplicate");
  });

  it("applies the deny list of managed settings to plugin servers", () => {
    const { f, scan } = setup();
    plugin(f, "tool@market", {
      ".mcp.json": json({ mcpServers: { banned: { type: "http", url: "https://b.example" } } }),
    });
    f.write(
      path.join(f.managedDir, "managed-settings.json"),
      json({ deniedMcpServers: [{ serverName: "plugin:tool:banned" }] }),
    );
    const [item] = scan().filter((entry) => entry.scope === "plugin");
    expect(item!.warning_messages!.map((message) => message.key)).toContain(
      "mcp.manage.diagnostic.native_policy_denied",
    );
  });
});
