import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as commandResolution from "../../../packages/backend/src/command-resolution";
import { Commands } from "../../../packages/backend/src/commands";
import { canonicalize } from "../../../packages/backend/src/paths";
import {
  nativeImportCapability,
  prepareSessionHandoff,
} from "../../../packages/backend/src/session-continuation";
import { planSessionHandoff } from "../../../packages/backend/src/session-handoff-plan";
import type { SessionDocument } from "../../../packages/backend/src/session-model";
import { BackendStore } from "../../../packages/backend/src/store";
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
});

/** Isolated Agent homes plus a stubbed CLI: no real Agent is resolved or executed. */
function fixture(versionOutput = "2.1.296 (Claude Code)\n") {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "claude-native-import-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    claudeHome = path.join(root, "claude-config"),
    codexHome = path.join(root, "codex-home"),
    projects = path.join(claudeHome, "projects");
  mkdirSync(home);
  mkdirSync(projects, { recursive: true });
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
    PATH: path.join(root, "no-agent-bin"),
  };
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const resolve = vi
    .spyOn(commandResolution, "resolveCommand")
    .mockImplementation((name) => path.join(root, "bin", name));
  const run = vi.spyOn(commands, "run").mockImplementation(async (_program, args) => {
    if (args.length !== 1 || args[0] !== "--version")
      throw new Error("Real Agent execution forbidden");
    return {
      bytes: Buffer.from(versionOutput),
      error: "",
      success: true,
      truncated: false,
      exitCode: 0,
    };
  });
  return { root, environment, commands, claudeHome, codexHome, projects, resolve, run };
}

function currentSession(directory: string, modified?: number) {
  const id = randomUUID();
  const user = userRecord(id);
  return writeTranscript(
    directory,
    jsonl([
      { type: "mode", mode: "normal", sessionId: id },
      { type: "permission-mode", permissionMode: "default", sessionId: id },
      user,
      assistantRecord(id, user.uuid),
    ]),
    { modified },
  );
}

describe("Claude native import capability", () => {
  const project = "/synthetic/workspace";
  const claude = (f: ReturnType<typeof fixture>, workspace = project) =>
    nativeImportCapability("claude-code", f.commands, f.environment, workspace);

  it("accepts a current session whose first records are mode and permission-mode", async () => {
    const f = fixture();
    currentSession(path.join(f.projects, "-synthetic-workspace"));
    expect(await claude(f)).toEqual({ supported: true, beta: true });
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("accepts a session directory that has no transcripts yet", async () => {
    const f = fixture();
    expect(await claude(f)).toEqual({ supported: true, beta: true });
  });

  it("ignores a newer subagent transcript and judges the main session file", async () => {
    const f = fixture();
    const directory = path.join(f.projects, "-synthetic-workspace");
    const main = currentSession(directory, 1_700_000_000);
    const id = randomUUID();
    writeTranscript(
      path.join(directory, path.basename(main, ".jsonl"), "subagents"),
      jsonl([{ type: "unrelated-subagent-header", sessionId: id }]),
      { name: "agent-synthetic.jsonl", modified: 1_800_000_000 },
    );
    expect(await claude(f)).toEqual({ supported: true, beta: true });
  });

  it("fails closed with an explicit reason when the newest session has only metadata", async () => {
    const f = fixture();
    const id = randomUUID();
    writeTranscript(path.join(f.projects, "-synthetic-workspace"), jsonl(metadataRecords(id)));
    expect(await claude(f)).toEqual({
      supported: false,
      beta: true,
      reason: "session-format-unverified",
    });
  });

  it("fails closed when a user record in the window has an unexpected structure", async () => {
    const f = fixture();
    const id = randomUUID();
    const broken: Record<string, unknown> = userRecord(id);
    delete broken.sessionId;
    writeTranscript(
      path.join(f.projects, "-synthetic-workspace"),
      jsonl([{ type: "mode", mode: "normal", sessionId: id }, broken]),
    );
    expect(await claude(f)).toMatchObject({
      supported: false,
      reason: "session-format-unverified",
    });
  });

  it("refuses a release before 2.1 with the version reason", async () => {
    const f = fixture("2.0.9 (Claude Code)\n");
    currentSession(path.join(f.projects, "-synthetic-workspace"));
    expect(await claude(f)).toEqual({
      supported: false,
      beta: true,
      reason: "unsupported-version-or-schema",
    });
  });

  it.each(["2.2.0 (Claude Code)\n", "3.0.0 (Claude Code)\n"])(
    "accepts %j, a release after the 2.1 series, once its sessions pass the format probe",
    async (output) => {
      const f = fixture(output);
      currentSession(path.join(f.projects, "-synthetic-workspace"));
      expect(await claude(f)).toEqual({ supported: true, beta: true });
    },
  );

  it("reports an unavailable CLI before looking at any transcript", async () => {
    const f = fixture();
    f.resolve.mockReturnValue(null);
    expect(await claude(f)).toEqual({ supported: false, beta: true, reason: "cli-unavailable" });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects a session root that is a file before claiming its format is verified", async () => {
    const f = fixture();
    rmSync(f.projects, { recursive: true });
    writeFileSync(f.projects, "not a directory");
    expect(await claude(f)).toEqual({
      supported: false,
      beta: true,
      reason: "session-format-unverified",
    });
  });

  it("refuses native import when the project directory name cannot be derived", async () => {
    const f = fixture();
    const tooLong = `/${"a".repeat(200)}`;
    expect(await claude(f, tooLong)).toEqual({
      supported: false,
      beta: true,
      reason: "project-directory-unverified",
    });
    expect(await claude(f, `/${"a".repeat(199)}`)).toEqual({ supported: true, beta: true });
  });

  it.each([
    ["a relative path", "relative/claude-dir"],
    ["a home-relative path", "~/.claude-work"],
    ["a path with a parent segment", "/tmp/claude/../other"],
    ["the filesystem root", "/"],
    ["a path with surrounding whitespace", " /tmp/claude-dir "],
  ])("refuses native import when CLAUDE_CONFIG_DIR is %s", async (_name, value) => {
    if (process.platform === "win32") return;
    const f = fixture();
    currentSession(path.join(f.projects, "-synthetic-workspace"));
    f.environment.CLAUDE_CONFIG_DIR = value;
    expect(await claude(f)).toEqual({
      supported: false,
      beta: true,
      reason: "config-directory-invalid",
    });
    // The refusal comes before the project directory name is considered.
    f.environment.CLAUDE_CODE_PROJECT_DIR_NAME = "shared-project";
    expect(await claude(f)).toMatchObject({ reason: "config-directory-invalid" });
  });

  it("treats a blank CLAUDE_CONFIG_DIR as unset instead of refusing", async () => {
    const f = fixture();
    f.environment.CLAUDE_CONFIG_DIR = "  ";
    mkdirSync(path.join(f.environment.HOME!, ".claude", "projects"), { recursive: true });
    expect(await claude(f)).toEqual({ supported: true, beta: true });
  });

  it("refuses native import when the project directory name is overridden", async () => {
    const f = fixture();
    f.environment.CLAUDE_CODE_PROJECT_DIR_NAME = "shared-project";
    expect(await claude(f)).toEqual({
      supported: false,
      beta: true,
      reason: "project-directory-unverified",
    });
    delete f.environment.CLAUDE_CONFIG_DIR;
    expect(await claude(f)).toEqual({ supported: true, beta: true });
  });
});

describe("Codex native import capability", () => {
  const sessions = (f: ReturnType<typeof fixture>) =>
    path.join(f.codexHome, "sessions", "2026", "10", "13");
  const codex = (f: ReturnType<typeof fixture>, project = "/synthetic/workspace") =>
    nativeImportCapability("codex", f.commands, f.environment, project);
  const meta = { type: "session_meta", payload: { id: randomUUID() } };

  it("accepts a session_meta first record and ignores the project path", async () => {
    const f = fixture("codex-cli 0.159.2\n");
    writeTranscript(sessions(f), jsonl([meta]), { name: "rollout-synthetic.jsonl" });
    expect(await codex(f)).toEqual({ supported: true, beta: true });
    expect(await codex(f, `/${"a".repeat(400)}`)).toEqual({ supported: true, beta: true });
  });

  it("still judges only the first record and keeps the legacy reason", async () => {
    const f = fixture("codex-cli 0.159.2\n");
    writeTranscript(sessions(f), jsonl([{ type: "mode", mode: "normal" }, meta]), {
      name: "rollout-synthetic.jsonl",
    });
    expect(await codex(f)).toEqual({
      supported: false,
      beta: true,
      reason: "unsupported-version-or-schema",
    });
  });

  it.each(["codex-cli 0.160.0\n", "codex-cli 0.163.0\n", "codex-cli 1.0.0\n"])(
    "accepts %j, a release after the one whose rollout format it writes",
    async (output) => {
      const f = fixture(output);
      writeTranscript(sessions(f), jsonl([meta]), { name: "rollout-synthetic.jsonl" });
      expect(await codex(f)).toEqual({ supported: true, beta: true });
    },
  );

  it.each([
    "codex-cli 0.159.1\n",
    "codex-cli 0.147.0\n",
    // Only the CLI's own version counts, not a later one printed after it.
    "codex-cli 0.158.0 (0.163.0 available)\n",
    "codex-cli\n",
  ])("refuses %j with the version reason", async (output) => {
    const f = fixture(output);
    expect(await codex(f)).toEqual({
      supported: false,
      beta: true,
      reason: "unsupported-version-or-schema",
    });
  });
});

describe("Claude native import target directory", () => {
  /** Independent oracle for the documented rule: every character outside [A-Za-z0-9] becomes "-". */
  const official = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

  type Draft = {
    mode: string;
    filename: string;
    source_fingerprint: string;
    native_capability: { supported: boolean; reason?: string };
    capabilities: { native_resume: { status: string; reason: string | null } };
  };

  /** Prepare the preview for a workspace named `name`, then expose a native-session plan request. */
  async function plan(name: string, setup: (f: ReturnType<typeof fixture>) => void = () => {}) {
    const f = fixture();
    setup(f);
    const project = path.join(f.root, name);
    mkdirSync(project);
    const data = path.join(f.root, "data");
    const store = new BackendStore(path.join(data, "store.db"));
    cleanups.push(() => store.close());
    store.sql.run(
      "INSERT INTO workspaces(id, canonical_path, name, manifest_workspace_id, status, last_discovered_at) VALUES(?,?,?,?,?,?)",
      "workspace",
      project,
      "workspace",
      "workspace",
      "healthy",
      "2026-10-13T00:00:00Z",
    );
    const nativeRef = path.join(f.root, "synthetic-source.jsonl");
    store.sessions.sync("workspace", "claude-code", [
      {
        native_ref: nativeRef,
        agent: "claude-code",
        title: "Synthetic source",
        created_at: null,
        updated_at: null,
        message_count: 2,
        git_branch: null,
        archived: false,
        sidechain: false,
        availability: "readable",
        origin: "interactive",
      },
    ]);
    const sessionId = store.sessions.id("claude-code", nativeRef);
    const document: SessionDocument = {
      schema_version: 1,
      source: { agent: "claude-code", workspace_id: "workspace" },
      turns: [
        { id: "one", role: "user", blocks: [{ type: "text", text: "Synthetic question" }] },
        { id: "two", role: "assistant", blocks: [{ type: "text", text: "Synthetic answer" }] },
      ],
      losses: [],
      redaction_count: 0,
    };
    const sources = { document: async () => structuredClone(document) };
    const hub = { running: false, port: 4010 };
    const prepared = (await prepareSessionHandoff(
      {
        request: {
          session_id: sessionId,
          target_agent: "claude-code",
          format: "markdown",
          history_budget_tokens: 64000,
        },
        mcpHubStatus: hub,
      },
      sources,
      store.sessions,
      store,
      f.commands,
      f.environment,
    )) as { draft: Draft };
    const planned = () =>
      planSessionHandoff(
        {
          workspaceId: "workspace",
          sessionId,
          targetAgent: "claude-code",
          format: "markdown",
          mode: "native-session",
          filename: prepared.draft.filename,
          sourceFingerprint: prepared.draft.source_fingerprint,
          acceptLosses: true,
          historyBudgetTokens: 64000,
          archiveId: null,
          mcpHubStatus: hub,
        },
        sources,
        store.sessions,
        store,
        data,
        f.environment,
        f.commands,
      );
    return { f, project, prepared: prepared.draft, planned };
  }

  it.each(["plain", "dotted.name", "snake_case", "with space", "项目", "mixed.a_b c"])(
    "writes the session under the directory Claude Code derives for %j",
    async (name) => {
      const { f, project, prepared, planned } = await plan(name);
      expect(prepared.mode).toBe("native-session");
      const result = await planned();
      const target = result.launch_request.target_path as string;
      expect(path.dirname(target)).toBe(path.join(f.projects, official(project)));
      expect(path.basename(target)).toBe(`${result.launch_request.target_session_id}.jsonl`);
      expect(result.change_set.changes.map((change) => change.target)).toEqual([target]);
    },
  );

  it("offers native import when the newest session opens with mode records", async () => {
    const { prepared } = await plan("current", (f) =>
      currentSession(path.join(f.projects, "-another-project")),
    );
    expect(prepared.mode).toBe("native-session");
    expect(prepared.native_capability).toEqual({ supported: true, beta: true });
  });

  it("falls back to a handoff file, with the reason, when the session format is not confirmed", async () => {
    const { prepared } = await plan("metadata-only", (f) =>
      writeTranscript(
        path.join(f.projects, "-another-project"),
        jsonl(metadataRecords(randomUUID())),
      ),
    );
    expect(prepared.mode).toBe("handoff-file");
    expect(prepared.capabilities.native_resume).toEqual({
      status: "unsupported",
      reason: "session-format-unverified",
    });
  });

  // A real directory this deep is not portable to Windows path limits.
  it.skipIf(process.platform === "win32")(
    "falls back to a handoff file, with the reason, for a path Claude Code would truncate",
    async () => {
      const { prepared } = await plan("x".repeat(220));
      expect(prepared.mode).toBe("handoff-file");
      expect(prepared.native_capability).toMatchObject({
        supported: false,
        reason: "project-directory-unverified",
      });
      expect(prepared.capabilities.native_resume).toEqual({
        status: "unsupported",
        reason: "project-directory-unverified",
      });
    },
  );

  it("rejects a plan prepared before the project directory name was overridden", async () => {
    const { f, planned } = await plan("override-check");
    f.environment.CLAUDE_CODE_PROJECT_DIR_NAME = "shared-project";
    await expect(planned()).rejects.toThrow("Native session import is no longer available");
  });
});
