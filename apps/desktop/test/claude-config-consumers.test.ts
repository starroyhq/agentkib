import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeSessions } from "../../../packages/backend/src/agents/claude/claude-sessions";
import * as commandResolution from "../../../packages/backend/src/command-resolution";
import { Commands } from "../../../packages/backend/src/commands";
import { scanNativeMcp } from "../../../packages/backend/src/mcp-native-scan";
import { nativeContext } from "../../../packages/backend/src/native-context";
import {
  agentInstallations,
  discoverConfiguredWorkspaces,
} from "../../../packages/backend/src/native-discovery-configured";
import { scanNativeHomeAssets } from "../../../packages/backend/src/native-home-assets";
import { canonicalize } from "../../../packages/backend/src/paths";
import { nativeImportCapability } from "../../../packages/backend/src/session-continuation";
import { Skills } from "../../../packages/backend/src/skills";
import type { BackendStore } from "../../../packages/backend/src/store";
import { collectUsage } from "../../../packages/backend/src/usage-providers";
import {
  assistantRecord,
  jsonl,
  metadataRecords,
  userRecord,
  writeTranscript,
} from "./fixtures/claude-native-session";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type Where = "default" | "custom";
type Fixture = ReturnType<typeof fixture>;

/**
 * Two complete Claude configuration locations, each holding data that names itself: the default one
 * under HOME and a custom one. Whatever a module reads tells which one it resolved.
 */
function fixture() {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "claude-config-consumers-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    defaults = path.join(home, ".claude"),
    custom = path.join(root, "custom-claude"),
    project = path.join(root, "project");
  for (const directory of [home, defaults, custom, project]) mkdirSync(directory);
  const directory = (where: Where) => (where === "default" ? defaults : custom);
  const globalFile = (where: Where) =>
    where === "default" ? path.join(home, ".claude.json") : path.join(custom, ".claude.json");
  const environment = (variable?: string): NodeJS.ProcessEnv => ({
    HOME: home,
    USERPROFILE: home,
    PATH: path.join(root, "no-agent-bin"),
    ...(variable === undefined ? {} : { CLAUDE_CONFIG_DIR: variable }),
  });
  return { root, home, defaults, custom, project, directory, globalFile, environment };
}

interface Row {
  name: string;
  /** Writes data that identifies `where` into that location. */
  seed(f: Fixture, where: Where): void;
  /** What the module produced; compared with `marker`. */
  observe(f: Fixture, environment: NodeJS.ProcessEnv): Promise<string> | string;
  /** The value `observe` returns when the module used `where`. */
  marker?(where: Where, f: Fixture): string;
  /** Reads fall back to the default location, except where a write-side gate closes. */
  whenInvalid?(f: Fixture): string;
}

const claudeHomeOf = (directory: string, f: Fixture) =>
  directory === f.defaults || directory === f.custom ? directory : "";

const rows: Row[] = [
  {
    name: "ClaudeSessions (sessions and history)",
    seed(f, where) {
      const id = randomUUID();
      writeTranscript(
        path.join(f.directory(where), "projects", "p"),
        jsonl([
          {
            type: "user",
            sessionId: id,
            cwd: f.project,
            isSidechain: false,
            message: { role: "user", content: where },
          },
        ]),
        { name: `${id}.jsonl` },
      );
    },
    observe(f, environment) {
      // This module falls back to os.homedir(); make sure that is the fixture, never a real home.
      vi.stubEnv("HOME", f.home);
      vi.stubEnv("USERPROFILE", f.home);
      expect(os.homedir()).toBe(f.home);
      return new ClaudeSessions(environment)
        .list(f.project)
        .sessions.map((entry) => entry.session.title)
        .join("|");
    },
  },
  {
    name: "discoverConfiguredWorkspaces (workspace discovery root)",
    seed(f, where) {
      writeFileSync(
        path.join(f.directory(where), "history.jsonl"),
        JSON.stringify({ project: f.project, sessionId: randomUUID(), timestamp: 1_760_000_000 }),
      );
    },
    observe(f, environment) {
      const diagnostics = discoverConfiguredWorkspaces(environment).source_diagnostics!;
      return String(diagnostics.find((item) => item.agent === "claude-code")!.path);
    },
    marker: (where, f) => f.directory(where),
  },
  {
    name: "agentInstallations (installation home)",
    seed() {},
    observe(f, environment) {
      return String(
        agentInstallations(environment).find((item) => item.agent === "claude-code")!.home,
      );
    },
    marker: (where, f) => f.directory(where),
  },
  {
    name: "nativeContext (agent homes)",
    seed() {},
    observe(f, environment) {
      return nativeContext(environment)
        .agent_homes.filter((item) => claudeHomeOf(item, f))
        .join("|");
    },
    marker: (where, f) => f.directory(where),
  },
  {
    name: "scanNativeHomeAssets (home allowlist)",
    seed(f, where) {
      writeFileSync(path.join(f.directory(where), "CLAUDE.md"), `# ${where}\n`);
    },
    observe(f, environment) {
      return scanNativeHomeAssets(environment)
        .filter(
          (asset) => asset.agent === "claude-code" && path.basename(asset.path) === "CLAUDE.md",
        )
        .map((asset) => asset.path)
        .join("|");
    },
    marker: (where, f) => path.join(f.directory(where), "CLAUDE.md"),
  },
  {
    name: "nativeImportCapability (session root)",
    seed(f, where) {
      const directory = path.join(f.directory(where), "projects", "-another-project");
      // The default location holds a current session; the custom one only a metadata-only file.
      if (where === "default") {
        const id = randomUUID();
        const user = userRecord(id);
        writeTranscript(directory, jsonl([user, assistantRecord(id, user.uuid)]));
      } else writeTranscript(directory, jsonl(metadataRecords(randomUUID())));
    },
    async observe(f, environment) {
      vi.spyOn(commandResolution, "resolveCommand").mockImplementation((name) =>
        path.join(f.root, "bin", name),
      );
      const commands = new Commands();
      cleanups.push(() => commands.close());
      vi.spyOn(commands, "run").mockResolvedValue({
        bytes: Buffer.from("2.1.296 (Claude Code)\n"),
        error: "",
        success: true,
        truncated: false,
        exitCode: 0,
      });
      const result = await nativeImportCapability(
        "claude-code",
        commands,
        environment,
        "/synthetic/work",
      );
      return result.reason ?? "supported";
    },
    marker: (where) => (where === "default" ? "supported" : "session-format-unverified"),
    whenInvalid: () => "config-directory-invalid",
  },
  {
    name: "Skills (personal Claude target)",
    seed() {},
    async observe(f, environment) {
      const skills = new Skills(environment, path.join(f.root, "data"));
      const targets = (await skills.request("skills.targets", {})) as Array<{
        agent: string;
        scope: string;
        root: string;
        writable: boolean;
      }>;
      const target = targets.find(
        (item) => item.agent === "claude-code" && item.scope === "personal",
      )!;
      return `${target.root}|${target.writable}`;
    },
    marker: (where, f) => `${path.join(f.directory(where), "skills")}|true`,
    whenInvalid: (f) => `${path.join(f.defaults, "skills")}|false`,
  },
  {
    name: "scanNativeMcp (global config file)",
    seed(f, where) {
      writeFileSync(
        f.globalFile(where),
        JSON.stringify({ mcpServers: { [where]: { url: "https://example.test/mcp" } } }),
      );
    },
    observe(f, environment) {
      return scanNativeMcp({}, {} as BackendStore, environment)
        .filter((item) => item.agent === "claude-code" && item.scope === "home")
        .map((item) => `${item.name}:${item.supported}`)
        .join("|");
    },
    marker: (where) => `${where}:true`,
    whenInvalid: () => "default:false",
  },
  {
    name: "collectUsage (stats-cache.json)",
    seed(f, where) {
      writeFileSync(
        path.join(f.directory(where), "stats-cache.json"),
        JSON.stringify({
          dailyModelTokens: [{ date: "2026-10-01", tokensByModel: { [`model-${where}`]: 5 } }],
        }),
      );
    },
    async observe(f, environment) {
      // Only the Claude batch is read; the other providers fail without their data.
      const commands = {
        run: async () => {
          throw new Error("no command in this test");
        },
      } as unknown as Commands;
      const batches = await collectUsage(new Map(), { home: f.home, environment, commands });
      const batch = batches.find((item) => item.agent === "claude-code")!;
      return batch.events.map((event) => event.model).join("|");
    },
    marker: (where) => `model-${where}`,
  },
];

const scenarios = [
  { name: "unset", variable: () => undefined, resolves: "default" },
  { name: "blank", variable: () => "   ", resolves: "default" },
  { name: "set to a directory", variable: (f: Fixture) => f.custom, resolves: "custom" },
  {
    name: "set with a trailing separator",
    variable: (f: Fixture) => `${f.custom}${path.sep}`,
    resolves: "custom",
  },
  {
    name: "set with a redundant separator and a dot segment",
    variable: (f: Fixture) =>
      `${path.dirname(f.custom)}${path.sep}.${path.sep}${path.basename(f.custom)}`,
    resolves: "custom",
  },
  { name: "a relative path", variable: () => "relative/claude-dir", resolves: "invalid" },
  {
    name: "a home-relative path (not expanded)",
    variable: () => "~/.claude-work",
    resolves: "invalid",
  },
  {
    name: "a path with a parent segment",
    variable: (f: Fixture) => `${f.custom}${path.sep}..${path.sep}custom-claude`,
    resolves: "invalid",
  },
  {
    name: "the filesystem root",
    variable: () => path.parse(process.cwd()).root,
    resolves: "invalid",
  },
  {
    name: "a Windows drive path",
    variable: () => "C:\\Users\\alice\\.claude-work",
    resolves: "invalid",
  },
] as const;

describe("every Claude module resolves the same configuration directory", () => {
  describe.each(rows)("$name", (row) => {
    it.each(scenarios)("CLAUDE_CONFIG_DIR $name", async (scenario) => {
      // A Windows drive path is a real absolute path on Windows.
      if (scenario.name === "a Windows drive path" && process.platform === "win32") return;
      const f = fixture();
      row.seed(f, "default");
      row.seed(f, "custom");
      const marker = row.marker ?? ((where: Where) => where);
      const expected =
        scenario.resolves === "invalid"
          ? (row.whenInvalid?.(f) ?? marker("default", f))
          : marker(scenario.resolves, f);
      expect(await row.observe(f, f.environment(scenario.variable(f)))).toBe(expected);
    });
  });
});

describe("source guard", () => {
  const sources = path.join(import.meta.dirname, "..", "..", "..", "packages", "backend", "src");

  /** Production sources of the backend, with comment-only lines removed. */
  function code() {
    const files: Array<{ file: string; lines: string[] }> = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
          files.push({
            file: path.relative(sources, file).split(path.sep).join("/"),
            lines: readFileSync(file, "utf8")
              .split("\n")
              .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)),
          });
      }
    };
    visit(sources);
    return files;
  }

  const mentions = (pattern: RegExp) =>
    code()
      .filter(({ lines }) => lines.some((line) => pattern.test(line)))
      .map(({ file }) => file)
      .sort();

  it("reads the variable in one module", () => {
    // `env.CLAUDE_CONFIG_DIR` or a quoted name passed to a lookup; prose in messages is fine.
    expect(mentions(/\.CLAUDE_CONFIG_DIR\b|["'`]CLAUDE_CONFIG_DIR["'`]/)).toEqual([
      "agents/claude/claude-config.ts",
    ]);
  });

  it("builds the global config and usage cache paths in one module", () => {
    // context-claude.ts only lists `.claude.json` among the names it never reads for imports.
    expect(mentions(/\.claude\.json/)).toEqual([
      "agents/claude/claude-config.ts",
      "context-claude.ts",
    ]);
    expect(mentions(/stats-cache\.json/)).toEqual(["agents/claude/claude-config.ts"]);
  });

  it("does not rebuild the default directory from the home directory", () => {
    // Project-relative `.claude/...` joins and OpenCode's `~/.claude/skills` are not this shape.
    expect(mentions(/path\.join\([^()]*(home|Home)[A-Za-z.()]*, "\.claude"[,)]/)).toEqual([]);
  });
});
