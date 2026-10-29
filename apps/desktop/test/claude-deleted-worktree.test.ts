import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/claude-managed-read";
import { Commands } from "../../../packages/backend/src/commands";
import type { CursorBridge } from "../../../packages/backend/src/cursor-bridge";
import { recordedDirectory, SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function temporaryRoot() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-claude-deleted-worktree-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * A registered repository whose only Claude session ran in one of its worktrees. `place` picks a
 * different recorded folder and leaves creating it to the caller.
 */
async function fixture(place?: (repo: string, root: string) => string) {
  const root = temporaryRoot();
  const repo = path.join(root, "repo"),
    config = path.join(root, "claude"),
    bin = path.join(root, "bin"),
    project = path.join(config, "projects", "fixture");
  for (const directory of [repo, bin, project]) mkdirSync(directory, { recursive: true });
  const worktree = place ? place(repo, root) : path.join(repo, ".claude", "worktrees", "gone");
  if (!place) mkdirSync(worktree, { recursive: true });
  writeFileSync(path.join(bin, "claude"), "isolated fixture; never run\n", { mode: 0o700 });
  const nativeId = randomUUID();
  const prompt = {
    type: "user",
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: nativeId,
    cwd: worktree,
    timestamp: "2026-10-01T00:00:00.000Z",
    message: { role: "user", content: "Synthetic prompt in a worktree" },
  };
  const answer = {
    type: "assistant",
    uuid: randomUUID(),
    parentUuid: prompt.uuid,
    sessionId: nativeId,
    cwd: worktree,
    timestamp: "2026-10-01T00:00:01.000Z",
    message: { role: "assistant", content: "Synthetic answer", stop_reason: "end_turn" },
  };
  writeFileSync(
    path.join(project, `${nativeId}.jsonl`),
    [prompt, answer].map((row) => JSON.stringify(row) + "\n").join(""),
  );
  const environment = { HOME: root, CLAUDE_CONFIG_DIR: config, PATH: bin };
  const commands = new Commands();
  cleanups.push(() => commands.close());
  vi.spyOn(commands, "run").mockImplementation(async (program, args) => ({
    success: true,
    bytes: Buffer.from(
      program === "/bin/ps" ? "" : args[0] === "agents" ? "[]" : "2.1.303 (Claude Code)",
    ),
    error: "",
    truncated: false,
    exitCode: 0,
  }));
  const store = new BackendStore(path.join(root, "backend.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "repo",
    repo,
    "repo",
    "healthy",
    "2026-10-01T00:00:00.000Z",
  );
  const sessions = new SessionReaders(store.sessions, commands, environment, {
    profiles: () => [],
  } as unknown as CursorBridge);
  cleanups.push(() => sessions.close());
  store.sessions.sync("repo", "claude-code", (await sessions.list("claude-code", repo)).sessions);
  const id = store.sessions.id("claude-code", nativeId);
  expect(store.sessions.get(id)).toBeTruthy();
  const owner = new ClaudeManagedReadOwner(
    store,
    sessions,
    commands,
    root,
    environment,
    randomUUID(),
  );
  cleanups.push(() => owner.shutdown());
  return { root, repo, worktree, nativeId, id, sessions, owner };
}

describe("recordedDirectory", () => {
  it("returns the real path of an existing directory", () => {
    const root = temporaryRoot();
    mkdirSync(path.join(root, "real"));
    symlinkSync(path.join(root, "real"), path.join(root, "link"));
    expect(recordedDirectory(path.join(root, "link"))).toEqual({
      path: path.join(root, "real"),
      missing: false,
    });
  });

  it("joins the missing part to the nearest existing ancestor's real path", () => {
    const root = temporaryRoot();
    mkdirSync(path.join(root, "real"));
    symlinkSync(path.join(root, "real"), path.join(root, "link"));
    expect(recordedDirectory(path.join(root, "link", "gone", "deeper"))).toEqual({
      path: path.join(root, "real", "gone", "deeper"),
      missing: true,
    });
  });

  it("still fails for a path that exists but cannot be resolved", () => {
    const root = temporaryRoot();
    symlinkSync(path.join(root, "loop-b"), path.join(root, "loop-a"));
    symlinkSync(path.join(root, "loop-a"), path.join(root, "loop-b"));
    expect(() => recordedDirectory(path.join(root, "loop-a", "child"))).toThrow(
      expect.objectContaining({ code: "ELOOP" }),
    );
  });
});

describe("a Claude session whose worktree folder was deleted", () => {
  it("can be continued while its worktree exists", async () => {
    const f = await fixture();
    expect(f.sessions.verifiedClaudeReadSource(f.id)).toMatchObject({
      workspace: f.worktree,
      directoryMissing: false,
    });
    expect(await f.owner.live(f.id, true)).toMatchObject({ reason: null, sendEnabled: true });
  });

  it("stays readable but view only once the folder is gone", async () => {
    const f = await fixture();
    rmSync(f.worktree, { recursive: true });
    expect(f.sessions.verifiedClaudeReadSource(f.id)).toMatchObject({
      workspaceId: "repo",
      workspace: f.worktree,
      directoryMissing: true,
      nativeId: f.nativeId,
    });
    expect(await f.owner.live(f.id, true)).toMatchObject({
      reason: "session-directory-missing",
      ownershipReason: "session-directory-missing",
      sendEnabled: false,
    });
    const page = (await f.owner.events(f.id, null, 50)) as { events: unknown[] };
    expect(JSON.stringify(page.events)).toContain("Synthetic prompt in a worktree");
    expect(JSON.stringify(page.events)).toContain("Synthetic answer");
    expect(await f.owner.historyVersion(f.id)).toEqual(expect.any(String));
  });

  it("keeps control checks strict for the deleted folder", async () => {
    const f = await fixture();
    rmSync(f.worktree, { recursive: true });
    expect(() => f.sessions.claudeControlWorkspace(f.nativeId, f.repo)).toThrow();
    expect(() => f.sessions.verifiedClaudeControlTarget(f.nativeId, f.worktree)).toThrow();
    expect(() => f.sessions.verifiedClaudeControlMetadata(f.nativeId, f.worktree)).toThrow();
  });

  it("does not follow a link out of the workspace to reach a deleted folder", async () => {
    const f = await fixture((repo, root) => {
      mkdirSync(path.join(root, "outside"));
      symlinkSync(path.join(root, "outside"), path.join(repo, "link"));
      return path.join(repo, "link", "gone");
    });
    expect(() => f.sessions.verifiedClaudeReadSource(f.id)).toThrow("session-workspace-mismatch");
    await expect(f.owner.events(f.id, null, 50)).rejects.toThrow("session-workspace-mismatch");
  });
});
