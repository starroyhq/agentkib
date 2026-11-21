import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerSession } from "../../../packages/backend/src/agents/codex/codex-app-server";
import { CodexFollowerBridge } from "../../../packages/backend/src/agents/codex/codex-follower-bridge";
import { codexResumeCommand } from "../../../packages/backend/src/agents/codex/codex-resume-command";
import { CodexRuntimePreflight } from "../../../packages/backend/src/agents/codex/codex-runtime-preflight";
import type { Commands } from "../../../packages/backend/src/commands";
import { readManagedRecord, saveManagedRecord } from "../../../packages/backend/src/managed-ledger";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";
import { WebReadRequests } from "../../../packages/backend/src/web-read";

const nativeId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-resume-command-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "project's $HOME; `literal`"),
    cwd = path.join(workspace, "nested's $USER"),
    home = path.join(root, "home's $USER");
  for (const directory of [cwd, home]) mkdirSync(directory, { recursive: true });
  const nativeDb = new DatabaseSync(path.join(home, "state_1.sqlite"));
  nativeDb.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT)");
  const transcript = path.join(home, "thread.jsonl");
  writeFileSync(
    transcript,
    JSON.stringify({ type: "session_meta", payload: { id: nativeId, cwd, source: "cli" } }) + "\n",
  );
  nativeDb.prepare("INSERT INTO threads VALUES(?,?,?)").run(nativeId, transcript, cwd);
  nativeDb.close();
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Fixture",
    "healthy",
    "2026-10-19T00:00:00Z",
  );
  const summary = {
    id: "indexed-session",
    workspace_id: "workspace",
    agent: "codex",
    title: "Title",
    sidechain: false,
    archived: false,
    availability: "readable",
  };
  vi.spyOn(store.sessions, "get").mockImplementation((id) =>
    id === summary.id ? (summary as ReturnType<typeof store.sessions.get>) : undefined,
  );
  const env = { CODEX_HOME: home, PATH: "" };
  const readers = new SessionReaders(store.sessions, {} as Commands, env, {
    profiles: async () => [],
  });
  cleanups.push(() => readers.close());
  vi.spyOn(readers, "resolve").mockResolvedValue({
    summary,
    native: { agent: "codex", native_ref: nativeId },
    workspace,
  } as unknown as Awaited<ReturnType<SessionReaders["resolve"]>>);
  let generation = 0n;
  const web = new WebReadRequests(store, readers, root, () => generation, env);
  cleanups.push(() => web.closeAsync());
  const preflight = vi
    .spyOn(CodexRuntimePreflight.prototype, "check")
    .mockRejectedValue(new Error("must-not-check-cli"));
  const start = vi
    .spyOn(CodexAppServerSession, "start")
    .mockRejectedValue(new Error("must-not-start"));
  const follower = vi
    .spyOn(CodexFollowerBridge, "connect")
    .mockRejectedValue(new Error("must-not-follow"));
  const read = () => web.request({ operation: "resume-command", sessionId: summary.id });
  return {
    root,
    workspace,
    cwd,
    home,
    store,
    readers,
    web,
    summary,
    transcript,
    preflight,
    start,
    follower,
    read,
    bump: () => {
      generation++;
    },
  };
}

describe("read-only Codex resume commands", () => {
  it("uses verified native subdirectory and shared home without a CLI, runner, or follower", async () => {
    const f = fixture();
    const result = await f.read();
    expect(result).toEqual(codexResumeCommand(f.cwd, f.home, nativeId));
    expect(f.preflight).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.follower).not.toHaveBeenCalled();
    expect(readManagedRecord(f.root, f.summary.id)).toBeNull();
  });

  it("does not run version preflight when the installed CLI would be too old", async () => {
    const f = fixture();
    f.preflight.mockResolvedValue({
      executable: "/old/codex",
      reason: "codex-cli-version-too-old",
    });
    expect(await f.read()).toMatchObject({ available: true });
    expect(f.preflight).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it("refuses native cwd/header disagreement and cwd outside the registered workspace", async () => {
    const f = fixture();
    writeFileSync(
      f.transcript,
      JSON.stringify({
        type: "session_meta",
        payload: { id: nativeId, cwd: f.home, source: "cli" },
      }) + "\n",
    );
    await expect(f.read()).rejects.toThrow("unverified-session-identity");
    const db = new DatabaseSync(path.join(f.home, "state_1.sqlite"));
    db.prepare("UPDATE threads SET cwd=?").run(f.home);
    db.close();
    await expect(f.read()).rejects.toThrow("codex-context-outside-workspace");
  });

  it("revalidates workspace registration and index generation after resolving", async () => {
    const f = fixture();
    vi.spyOn(f.readers, "verifiedCodexResumeIdentity").mockImplementation(() => {
      f.bump();
      return { id: nativeId, cwd: f.cwd };
    });
    await expect(f.read()).rejects.toThrow("session-unavailable");
    vi.restoreAllMocks();
    vi.spyOn(f.store.sessions, "get").mockReturnValue(
      f.summary as ReturnType<typeof f.store.sessions.get>,
    );
    vi.spyOn(f.readers, "resolve").mockImplementation(async () => {
      f.store.sql.run("UPDATE workspaces SET canonical_path=? WHERE id=?", f.home, "workspace");
      return {
        summary: f.summary,
        native: { agent: "codex", native_ref: nativeId },
        workspace: f.workspace,
      } as unknown as Awaited<ReturnType<SessionReaders["resolve"]>>;
    });
    await expect(f.read()).rejects.toThrow("session-workspace-mismatch");
  });

  it("revalidates stored managed native UUIDs instead of trusting a persisted record", async () => {
    const f = fixture();
    saveManagedRecord(f.root, {
      id: f.summary.id,
      workspace_id: "workspace",
      workspace: f.workspace,
      home: f.home,
      native_id: "not-a-uuid",
      title: "Title",
      created_at: "2026-10-19T00:00:00Z",
      policy_id: "workspace-write-on-request",
      released: true,
      adopted: true,
      snapshot: { revision: 0 },
    });
    await expect(f.read()).rejects.toThrow("unverified-session-identity");
  });

  it.skipIf(process.platform === "win32")(
    "quotes POSIX path metacharacters literally and gates execution on cd success",
    async () => {
      const f = fixture();
      const bin = path.join(f.root, "bin");
      mkdirSync(bin);
      const executable = path.join(bin, "codex");
      writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$CODEX_HOME" "$@"\n');
      chmodSync(executable, 0o700);
      const command = codexResumeCommand(f.cwd, f.home, nativeId, "darwin").command;
      const child = spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: { ...process.env, PATH: bin },
      });
      expect(child.status).toBe(0);
      expect(child.stdout.trimEnd().split("\n")).toEqual([f.cwd, f.home, "resume", nativeId]);
      const missing = codexResumeCommand(path.join(f.root, "missing"), f.home, nativeId, "darwin");
      const failed = spawnSync("/bin/sh", ["-c", missing.command], {
        encoding: "utf8",
        env: { ...process.env, PATH: bin },
      });
      expect(failed.status).not.toBe(0);
      expect(failed.stdout).toBe("");
    },
  );

  it("quotes PowerShell paths literally and handles a failed Set-Location before executing", () => {
    expect(
      codexResumeCommand("C:\\work's $env:USER;`x`", "D:\\home's $(x)", nativeId, "win32"),
    ).toEqual({
      available: true,
      shell: "powershell",
      runOn: "host",
      command: `try { Set-Location -LiteralPath 'C:\\work''s $env:USER;\`x\`' -ErrorAction Stop; $env:CODEX_HOME = 'D:\\home''s $(x)'; & codex resume '${nativeId}' } catch { Write-Error $_ }`,
    });
    expect(() => codexResumeCommand("C:\\work", "C:\\home", "'; Start-Process x", "win32")).toThrow(
      "unverified-session-identity",
    );
  });
});
