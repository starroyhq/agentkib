import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pushChange,
  type ChangeSet,
  type FileChange,
} from "../../../packages/backend/src/change-plan";
import { applyRequest } from "../../../packages/backend/src/changes";
import { ClaudeConfigError } from "../../../packages/backend/src/agents/claude/claude-config";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/agents/claude/claude-managed-read";
import * as commandResolution from "../../../packages/backend/src/command-resolution";
import { Commands } from "../../../packages/backend/src/commands";
import { canonicalize } from "../../../packages/backend/src/paths";
import * as sessionContinuation from "../../../packages/backend/src/session-continuation";
import { applySessionHandoff } from "../../../packages/backend/src/session-handoff-apply";
import {
  launchPreparedHandoff,
  type PreparedHandoffLaunch,
} from "../../../packages/backend/src/session-handoff-launch";
import { planSessionHandoff } from "../../../packages/backend/src/session-handoff-plan";
import type { SessionDocument } from "../../../packages/backend/src/session-model";
import type { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";
import { assistantRecord, jsonl, userRecord } from "./fixtures/claude-native-session";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

/** What Claude Code itself derives for a working directory; independent of AgentKib's helper. */
const officialKey = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

function fixture() {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "claude-config-writes-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    defaults = path.join(home, ".claude"),
    custom = path.join(root, "custom-claude"),
    project = path.join(root, "project"),
    data = path.join(root, "data");
  for (const directory of [home, project, data]) mkdirSync(directory);
  const store = new BackendStore(path.join(data, "db.sqlite"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id, canonical_path, name, manifest_workspace_id, status, last_discovered_at) VALUES(?,?,?,?,?,?)",
    "workspace",
    project,
    "workspace",
    "workspace",
    "healthy",
    "2026-10-14T00:00:00Z",
  );
  const environment = (variable?: string): NodeJS.ProcessEnv => ({
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(root, "codex-home"),
    PATH: path.join(root, "no-agent-bin"),
    ...(variable === undefined ? {} : { CLAUDE_CONFIG_DIR: variable }),
  });
  return { root, home, defaults, custom, project, data, store, environment };
}
type Fixture = ReturnType<typeof fixture>;

const transcript = (cwd: string) => {
  const id = randomUUID();
  const user = userRecord(id, { cwd });
  return jsonl([user, assistantRecord(id, user.uuid, { cwd })]);
};

describe("ChangeSet application and the Claude configuration directory", () => {
  const plan = (f: Fixture, changes: (target: FileChange[]) => void): ChangeSet => {
    const list: FileChange[] = [];
    changes(list);
    return {
      id: randomUUID(),
      project_root: f.project,
      created_at: "2026-10-14T00:00:00.000Z",
      requires_home_approval: true,
      changes: list,
    };
  };
  const apply = (f: Fixture, environment: NodeJS.ProcessEnv, changeSet: ChangeSet) =>
    applyRequest({ changeSet, approveHome: true }, f.store, f.data, environment);
  const session = (directory: string) =>
    path.join(directory, "projects", "-p", `${randomUUID()}.jsonl`);
  const sessionChange = (target: string) => (list: FileChange[]) =>
    pushChange(list, target, transcript("/synthetic/p"), "agent-home", "high", "jsonl");
  const globalChange = (target: string) => (list: FileChange[]) =>
    pushChange(list, target, '{"mcpServers":{}}\n', "agent-home", "high", "json");

  it("keeps approving the default locations while the variable is unset", () => {
    const f = fixture();
    const target = session(f.defaults);
    apply(f, f.environment(), plan(f, sessionChange(target)));
    expect(existsSync(target)).toBe(true);
    apply(f, f.environment(), plan(f, globalChange(path.join(f.home, ".claude.json"))));
    expect(existsSync(path.join(f.home, ".claude.json"))).toBe(true);
  });

  it("approves the locations inside the directory the variable names", () => {
    const f = fixture();
    mkdirSync(f.custom);
    const target = session(f.custom);
    apply(f, f.environment(f.custom), plan(f, sessionChange(target)));
    expect(existsSync(target)).toBe(true);
    apply(f, f.environment(f.custom), plan(f, globalChange(path.join(f.custom, ".claude.json"))));
    expect(existsSync(path.join(f.custom, ".claude.json"))).toBe(true);
    // A trailing separator names the same directory.
    const again = session(f.custom);
    apply(f, f.environment(`${f.custom}${path.sep}`), plan(f, sessionChange(again)));
    expect(existsSync(again)).toBe(true);
  });

  it("no longer approves the default locations once the variable moves them", () => {
    const f = fixture();
    mkdirSync(f.custom);
    const environment = f.environment(f.custom);
    const stale = session(f.defaults);
    expect(() => apply(f, environment, plan(f, sessionChange(stale)))).toThrow(
      /no longer approved/,
    );
    expect(existsSync(stale)).toBe(false);
    const staleGlobal = path.join(f.home, ".claude.json");
    expect(() => apply(f, environment, plan(f, globalChange(staleGlobal)))).toThrow(
      /no longer approved/,
    );
    expect(existsSync(staleGlobal)).toBe(false);
  });

  it("does not approve the global file while a legacy .config.json shadows it", () => {
    const f = fixture();
    mkdirSync(f.defaults, { recursive: true });
    writeFileSync(path.join(f.defaults, ".config.json"), "{}\n");
    const target = path.join(f.home, ".claude.json");
    expect(() => apply(f, f.environment(), plan(f, globalChange(target)))).toThrow(
      /no longer approved/,
    );
    expect(existsSync(target)).toBe(false);
    // Session files are not affected by the shadowing.
    const written = session(f.defaults);
    apply(f, f.environment(), plan(f, sessionChange(written)));
    expect(existsSync(written)).toBe(true);
  });

  describe.each([
    ["a relative path", "relative/claude-dir", "not-absolute"],
    ["a home-relative path", "~/.claude-work", "not-absolute"],
    ["a path with a parent segment", "/tmp/a/../b", "traversal"],
    ["the filesystem root", "/", "filesystem-root"],
    ["surrounding whitespace", " /tmp/claude-dir", "surrounding-whitespace"],
  ])("with %s", (_name, value, reason) => {
    it("refuses Claude targets with the reason, before the generic approval error", () => {
      if (process.platform === "win32") return;
      const f = fixture();
      const environment = f.environment(value);
      const attempts = [
        plan(f, globalChange(path.join(f.home, ".claude.json"))),
        plan(f, sessionChange(session(f.defaults))),
      ];
      for (const changeSet of attempts) {
        let failure: unknown;
        try {
          apply(f, environment, changeSet);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(ClaudeConfigError);
        expect((failure as ClaudeConfigError).reason).toBe(reason);
        // The message names the rule, never the configured value.
        expect((failure as Error).message).not.toContain(value.trim());
      }
      for (const changeSet of attempts)
        for (const change of changeSet.changes) expect(existsSync(change.target)).toBe(false);
    });

    it("leaves other Agent Home targets alone", () => {
      if (process.platform === "win32") return;
      const f = fixture();
      const target = path.join(f.home, ".codex", "config.toml");
      apply(
        f,
        f.environment(value),
        plan(f, (list) =>
          pushChange(list, target, 'model = "synthetic"\n', "agent-home", "high", "toml"),
        ),
      );
      expect(readFileSync(target, "utf8")).toBe('model = "synthetic"\n');
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses a session write when the configuration directory is a symbolic link",
    () => {
      const f = fixture();
      const real = path.join(f.root, "real-claude");
      mkdirSync(real);
      symlinkSync(real, f.custom);
      const target = session(f.custom);
      expect(() => apply(f, f.environment(f.custom), plan(f, sessionChange(target)))).toThrow(
        /not a regular directory/,
      );
      expect(existsSync(path.join(real, "projects"))).toBe(false);
    },
  );
});

describe("native session import and the Claude configuration directory", () => {
  /** Mirrors the handoff dialog flow for a workspace named `name`, then exposes plan and apply. */
  async function handoff() {
    const f = fixture();
    const project = f.project;
    mkdirSync(path.join(f.defaults, "projects"), { recursive: true });
    mkdirSync(path.join(f.custom, "projects"), { recursive: true });
    const commands = new Commands();
    cleanups.push(() => commands.close());
    vi.spyOn(commandResolution, "resolveCommand").mockImplementation((command) =>
      path.join(f.root, "bin", command),
    );
    vi.spyOn(commands, "run").mockResolvedValue({
      bytes: Buffer.from("2.1.296 (Claude Code)\n"),
      error: "",
      success: true,
      truncated: false,
      exitCode: 0,
    });
    const nativeRef = path.join(f.root, "synthetic-source.jsonl");
    f.store.sessions.sync("workspace", "claude-code", [
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
    const sessionId = f.store.sessions.id("claude-code", nativeRef);
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
    const prepare = async (environment: NodeJS.ProcessEnv) =>
      (
        (await sessionContinuation.prepareSessionHandoff(
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
          f.store.sessions,
          f.store,
          commands,
          environment,
        )) as {
          draft: {
            mode: string;
            filename: string;
            source_fingerprint: string;
            capabilities: { native_resume: { status: string; reason: string | null } };
          };
        }
      ).draft;
    const plan = async (
      environment: NodeJS.ProcessEnv,
      draft: Awaited<ReturnType<typeof prepare>>,
    ) =>
      planSessionHandoff(
        {
          workspaceId: "workspace",
          sessionId,
          targetAgent: "claude-code",
          format: "markdown",
          mode: "native-session",
          filename: draft.filename,
          sourceFingerprint: draft.source_fingerprint,
          acceptLosses: true,
          historyBudgetTokens: 64000,
          archiveId: null,
          mcpHubStatus: hub,
        },
        sources,
        f.store.sessions,
        f.store,
        f.data,
        environment,
        commands,
      );
    type Planned = Awaited<ReturnType<typeof plan>>;
    const apply = (environment: NodeJS.ProcessEnv, planned: Planned) =>
      applySessionHandoff(
        { changeSet: planned.change_set, launchRequest: planned.launch_request, approveHome: true },
        f.store,
        f.data,
        environment,
      );
    return { f, project, prepare, plan, apply };
  }

  it("targets the default directory while the variable is unset", async () => {
    const { f, project, prepare, plan, apply } = await handoff();
    const environment = f.environment();
    const planned = await plan(environment, await prepare(environment));
    const request = planned.launch_request as { target_path: string; target_session_id: string };
    expect(request.target_path).toBe(
      path.join(
        f.home,
        ".claude",
        "projects",
        officialKey(project),
        `${request.target_session_id}.jsonl`,
      ),
    );
    apply(environment, planned);
    expect(existsSync(request.target_path)).toBe(true);
  });

  it.each([
    ["a directory", (f: Fixture) => f.custom],
    ["a directory with a trailing separator", (f: Fixture) => `${f.custom}${path.sep}`],
  ])("targets the directory the variable names (%s)", async (_name, variable) => {
    const { f, project, prepare, plan, apply } = await handoff();
    const environment = f.environment(variable(f));
    const draft = await prepare(environment);
    expect(draft.mode).toBe("native-session");
    const planned = await plan(environment, draft);
    const request = planned.launch_request as { target_path: string; target_session_id: string };
    expect(request.target_path).toBe(
      path.join(f.custom, "projects", officialKey(project), `${request.target_session_id}.jsonl`),
    );
    apply(environment, planned);
    expect(existsSync(request.target_path)).toBe(true);
    expect(existsSync(path.join(f.defaults, "projects", officialKey(project)))).toBe(false);
  });

  it("refuses to apply a launch path that is still in the default directory", async () => {
    const { f, project, prepare, plan, apply } = await handoff();
    const planned = await plan(f.environment(), await prepare(f.environment()));
    const environment = f.environment(f.custom);
    // The variable was set after the preview: the old target is no longer the Claude directory.
    expect(() => apply(environment, planned)).toThrow(/escapes the target Agent Home/);
    expect(existsSync(path.join(f.defaults, "projects", officialKey(project)))).toBe(false);
  });

  it.each(["relative/claude-dir", "~/.claude-work", "/tmp/a/../b", "/"])(
    "turns native import off and says why when the variable is %j",
    async (value) => {
      if (process.platform === "win32") return;
      const { f, prepare, plan } = await handoff();
      const environment = f.environment(value);
      const draft = await prepare(environment);
      expect(draft.mode).toBe("handoff-file");
      expect(draft.capabilities.native_resume).toEqual({
        status: "unavailable",
        reason: "config-directory-invalid",
      });
      await expect(plan(environment, draft)).rejects.toThrow(
        "Native session import is no longer available",
      );
    },
  );

  it("makes the plan refuse an unusable variable on its own, not only through the capability check", async () => {
    const { f, prepare, plan } = await handoff();
    const environment = f.environment(f.custom);
    const draft = await prepare(environment);
    vi.spyOn(sessionContinuation, "nativeImportCapability").mockResolvedValue({
      supported: true,
      beta: true,
    });
    environment.CLAUDE_CONFIG_DIR = "relative/claude-dir";
    await expect(plan(environment, draft)).rejects.toThrow(ClaudeConfigError);
  });

  it("refuses to apply a previewed native session after the variable became unusable", async () => {
    const { f, project, prepare, plan, apply } = await handoff();
    const environment = f.environment(f.custom);
    const planned = await plan(environment, await prepare(environment));
    environment.CLAUDE_CONFIG_DIR = "relative/claude-dir";
    expect(() => apply(environment, planned)).toThrow(ClaudeConfigError);
    expect(existsSync(path.join(f.custom, "projects", officialKey(project)))).toBe(false);
  });

  describe("launching", () => {
    const prepared = (f: Fixture, target: string, id: string): PreparedHandoffLaunch =>
      ({
        request: {
          mode: "native-session",
          workspace_id: "workspace",
          target_agent: "claude-code",
          target_session_id: id,
          target_path: target,
        },
        terminal: { kind: "macos", executable: "/nonexistent-terminal" },
        command: { executable: "/nonexistent-claude", arguments: [], cwd: f.project },
        workspace: f.project,
        validateOwnership: () => {},
      }) as PreparedHandoffLaunch;

    it("validates the session file against the directory the variable names", async () => {
      const f = fixture();
      const id = randomUUID();
      mkdirSync(path.join(f.custom, "projects", "-p"), { recursive: true });
      mkdirSync(path.join(f.defaults, "projects", "-p"), { recursive: true });
      const environment = f.environment(f.custom);
      await expect(
        launchPreparedHandoff(
          prepared(f, path.join(f.defaults, "projects", "-p", `${id}.jsonl`), id),
          f.data,
          environment,
        ),
      ).rejects.toThrow(/escapes the target Agent Home/);
      // Inside the named directory the root check passes; the missing file stops it afterwards.
      await expect(
        launchPreparedHandoff(
          prepared(f, path.join(f.custom, "projects", "-p", `${id}.jsonl`), id),
          f.data,
          environment,
        ),
      ).rejects.toThrow(/ENOENT/);
    });

    it("refuses to launch when the variable is unusable", async () => {
      const f = fixture();
      const id = randomUUID();
      await expect(
        launchPreparedHandoff(
          prepared(f, path.join(f.defaults, "projects", "-p", `${id}.jsonl`), id),
          f.data,
          f.environment("relative/claude-dir"),
        ),
      ).rejects.toThrow(ClaudeConfigError);
    });
  });
});

describe.skipIf(process.platform === "win32")("managed Claude sessions", () => {
  /**
   * A managed-session owner whose `claude` on PATH is a stub; the version probe is stubbed as
   * well, so the stub is never executed and creating a session starts no process.
   */
  function owner(variable?: (f: Fixture) => string, prepare: (f: Fixture) => void = () => {}) {
    const f = fixture();
    prepare(f);
    const bin = path.join(f.root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, "claude"), 0o700);
    const environment = { ...f.environment(variable?.(f)), PATH: bin };
    const commands = {
      run: vi.fn(async (command: string, args: string[]) => {
        if (command === "/bin/ps") return { success: true, bytes: Buffer.from("") };
        if (args[0] === "agents") return { success: true, bytes: Buffer.from("[]\n") };
        expect(args).toEqual(["--version"]);
        return { success: true, bytes: Buffer.from("2.1.286 (Claude Code)\n") };
      }),
    } as unknown as Commands;
    const store = {
      workspacePath: () => f.project,
      sessions: { id: (_agent: string, id: string) => id },
    } as unknown as BackendStore;
    const managed = new ClaudeManagedReadOwner(
      store,
      {} as unknown as SessionReaders,
      commands,
      f.root,
      environment,
      randomUUID(),
    );
    cleanups.push(() => managed.shutdown());
    const create = async () => {
      const created = (await managed.request({
        operation: "create",
        workspaceId: "workspace",
        requestId: randomUUID(),
        deviceId: "browser-device-a",
      })) as { sessionId: string };
      const record = JSON.parse(
        readFileSync(path.join(f.root, "claude-managed", `${created.sessionId}.json`), "utf8"),
      ) as { home: string };
      return record.home;
    };
    return { f, create };
  }

  it("records the default directory while the variable is unset", async () => {
    const { f, create } = owner();
    expect(await create()).toBe(f.defaults);
  });

  it("records the directory the variable names", async () => {
    const { f, create } = owner(
      (f) => f.custom,
      (f) => mkdirSync(f.custom),
    );
    expect(await create()).toBe(f.custom);
  });

  it("follows a symbolic link to the real directory without refusing", async () => {
    let real = "";
    const { create } = owner(
      (f) => f.custom,
      (f) => {
        real = path.join(f.root, "real-claude");
        mkdirSync(real);
        symlinkSync(real, f.custom);
      },
    );
    expect(await create()).toBe(real);
  });

  it.each(["relative/claude-dir", "~/.claude-work", "/tmp/a/../b", "/"])(
    "refuses to create a session when the variable is %j, before anything is recorded",
    async (value) => {
      const { f, create } = owner(() => value);
      await expect(create()).rejects.toThrow(ClaudeConfigError);
      expect(existsSync(path.join(f.root, "claude-managed"))).toBe(false);
    },
  );
});
