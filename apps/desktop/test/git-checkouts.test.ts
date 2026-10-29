import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  catalogCheckouts,
  CheckoutSnapshot,
  GitCheckouts,
  normalizeOrigin,
  repositoryGroupId,
} from "../../../packages/backend/src/git-checkouts";
import { canonicalize } from "../../../packages/backend/src/paths";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      chmodSync(path.join(root, "locked"), 0o755);
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "git-checkouts-")));
  roots.push(root);
  const home = path.join(root, "home"),
    codexHome = path.join(home, ".codex"),
    repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString().trim();
  git(repo, "init", "--quiet", "--template=", "-b", "main");
  git(repo, "remote", "add", "origin", "https://example.invalid/team/repo.git");
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "--quiet", "-m", "init");
  const worktree = (target: string, branch: string) => {
    mkdirSync(path.dirname(target), { recursive: true });
    git(repo, "worktree", "add", "--quiet", "-b", branch, target);
    return target;
  };
  const group = repositoryGroupId(canonicalize(path.join(repo, ".git")));
  return { root, home, codexHome, repo, git, worktree, group };
}

describe("git checkout facts", () => {
  it("recognizes the main checkout and linked worktrees inside and outside the repository", () => {
    const f = fixture();
    const outside = f.worktree(path.join(f.root, "repo-worktrees", "feature"), "feature/outside");
    const codex = f.worktree(path.join(f.codexHome, "worktrees", "a1b2", "repo"), "codex/task");
    const claude = f.worktree(path.join(f.repo, ".claude", "worktrees", "tidy"), "claude/tidy");
    const snapshot = new CheckoutSnapshot(
      [
        { id: "main", path: f.repo },
        { id: "outside", path: outside },
        { id: "codex", path: codex },
      ],
      f.codexHome,
    );
    expect(snapshot.workspace("main")).toEqual({
      repository_group_id: f.group,
      kind: "primary",
      primary_path: f.repo,
      name: null,
      branch: "main",
      status: "present",
    });
    expect(snapshot.workspace("outside")).toMatchObject({
      repository_group_id: f.group,
      kind: "worktree",
      primary_path: f.repo,
      name: "feature",
      branch: "feature/outside",
    });
    expect(snapshot.workspace("codex")).toMatchObject({ kind: "worktree", name: "a1b2" });
    expect(snapshot.session(path.join(f.repo, "src"))).toBeNull();
    expect(snapshot.session(path.join(codex, "apps", "web"))).toEqual({
      repository_group_id: f.group,
      name: "a1b2",
      path: codex,
      branch: "codex/task",
      status: "present",
    });
    expect(snapshot.session(claude)).toMatchObject({
      repository_group_id: f.group,
      name: "tidy",
      branch: "claude/tidy",
      status: "present",
    });
  });

  it("reports a detached worktree by its short commit", () => {
    const f = fixture();
    const head = f.git(f.repo, "rev-parse", "HEAD");
    const detached = path.join(f.root, "detached");
    f.git(f.repo, "worktree", "add", "--quiet", "--detach", detached);
    expect(new CheckoutSnapshot([], f.codexHome).session(detached)?.branch).toBe(head.slice(0, 7));
  });

  it("marks a worktree git still records but whose folder is gone as deleted", () => {
    const f = fixture();
    const outside = f.worktree(path.join(f.root, "repo-worktrees", "gone"), "gone");
    rmSync(outside, { recursive: true, force: true });
    const snapshot = new CheckoutSnapshot([{ id: "main", path: f.repo }], f.codexHome);
    expect(snapshot.session(path.join(outside, "pkg"))).toEqual({
      repository_group_id: f.group,
      name: "gone",
      path: outside,
      branch: "gone",
      status: "deleted",
    });
  });

  it("places a pruned Codex worktree by the thread's origin remote", () => {
    const f = fixture();
    const codex = f.worktree(path.join(f.codexHome, "worktrees", "h2", "repo"), "codex/h2");
    rmSync(path.dirname(codex), { recursive: true, force: true });
    f.git(f.repo, "worktree", "prune");
    const snapshot = new CheckoutSnapshot([{ id: "main", path: f.repo }], f.codexHome);
    expect(snapshot.session(codex)).toBeNull();
    expect(snapshot.session(codex, "https://example.invalid/team/repo.git")).toEqual({
      repository_group_id: f.group,
      name: "h2",
      path: codex,
      branch: null,
      status: "deleted",
    });
    expect(snapshot.session(codex, "https://example.invalid/team/other.git")).toBeNull();
  });

  it("leaves a deleted Codex worktree unplaced when two clones share its remote", () => {
    const f = fixture();
    const clone = path.join(f.root, "clone");
    f.git(f.root, "clone", "--quiet", f.repo, clone);
    f.git(clone, "remote", "set-url", "origin", "https://example.invalid/team/repo");
    const missing = path.join(f.codexHome, "worktrees", "h3", "repo");
    const snapshot = new CheckoutSnapshot(
      [
        { id: "main", path: f.repo },
        { id: "clone", path: clone },
      ],
      f.codexHome,
    );
    expect(snapshot.session(missing, "https://example.invalid/team/repo.git")).toBeNull();
  });

  it("places a deleted Claude worktree inside its repository", () => {
    const f = fixture();
    const claude = f.worktree(path.join(f.repo, ".claude", "worktrees", "old"), "claude/old");
    rmSync(claude, { recursive: true, force: true });
    f.git(f.repo, "worktree", "prune");
    expect(new CheckoutSnapshot([], f.codexHome).session(claude)).toMatchObject({
      repository_group_id: f.group,
      name: "old",
      status: "deleted",
    });
  });

  it("keeps the stored group of a registered worktree whose folder is gone", () => {
    const f = fixture();
    const outside = f.worktree(path.join(f.root, "repo-worktrees", "kept"), "kept");
    const stored = new CheckoutSnapshot([{ id: "w", path: outside }], f.codexHome).workspace("w");
    rmSync(outside, { recursive: true, force: true });
    f.git(f.repo, "worktree", "prune");
    const snapshot = new CheckoutSnapshot(
      [
        { id: "main", path: f.repo, repository_group_id: f.group },
        { id: "w", path: outside, repository_group_id: stored?.repository_group_id },
      ],
      f.codexHome,
    );
    expect(snapshot.workspace("w")).toEqual({
      repository_group_id: f.group,
      kind: "worktree",
      primary_path: f.repo,
      name: "kept",
      branch: null,
      status: "deleted",
    });
    expect(
      new CheckoutSnapshot([{ id: "w", path: outside }], f.codexHome).workspace("w"),
    ).toBeNull();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports unreadable Codex worktree metadata as unknown",
    () => {
      const f = fixture();
      const locked = path.join(f.root, "locked");
      const codex = path.join(f.codexHome, "worktrees", "h9", "repo");
      mkdirSync(locked);
      mkdirSync(path.dirname(codex), { recursive: true });
      renameSync(f.worktree(path.join(locked, "repo"), "locked"), codex);
      writeFileSync(path.join(codex, ".git"), `gitdir: ${path.join(locked, "missing")}\n`);
      chmodSync(locked, 0);
      expect(new CheckoutSnapshot([], f.codexHome).session(codex)).toMatchObject({
        name: "h9",
        status: "unknown",
      });
    },
  );

  it("ignores directories that are not git repositories", () => {
    const f = fixture();
    const plain = path.join(f.root, "plain");
    mkdirSync(plain);
    const snapshot = new CheckoutSnapshot([{ id: "plain", path: plain }], f.codexHome);
    expect(snapshot.workspace("plain")).toBeNull();
    expect(snapshot.session(plain)).toBeNull();
    expect(snapshot.session("relative/path")).toBeNull();
  });

  it("marks catalog rows through their own or their indexed session's directory", () => {
    const f = fixture();
    const codex = f.worktree(path.join(f.codexHome, "worktrees", "z9", "repo"), "codex/z9");
    const directories = new Map([
      ["native-worktree", { cwd: codex, git_origin_url: null }],
      ["native-main", { cwd: f.repo, git_origin_url: null }],
    ]);
    const requested: string[][] = [];
    const checkouts = catalogCheckouts(
      {
        listWorkspaces: () => [{ id: "main", path: f.repo, repository_group_id: f.group }],
        sessions: {
          directories: (ids) => {
            requested.push([...ids]);
            return directories;
          },
        },
      },
      { CODEX_HOME: f.codexHome },
    );
    expect(checkouts.workspaces([{ id: "main" }, { id: "other" }])).toEqual([
      { id: "main", checkout: expect.objectContaining({ kind: "primary", branch: "main" }) },
      { id: "other" },
    ]);
    const rows = checkouts.sessions([
      { id: "native-worktree" },
      { id: "managed", indexedSessionIds: ["native-worktree"] },
      { id: "claude-managed", indexedSessionId: "native-worktree" },
      { id: "native-main" },
      { id: "unindexed" },
    ]);
    expect(rows.map((row) => (row as { worktree?: { name: string } }).worktree?.name)).toEqual([
      "z9",
      "z9",
      "z9",
      undefined,
      undefined,
    ]);
    expect(requested[0]).toEqual(
      expect.arrayContaining(["native-worktree", "managed", "native-main", "unindexed"]),
    );
  });

  it("normalizes remotes and briefly reuses a snapshot for the same workspaces", () => {
    expect(normalizeOrigin(" https://example.invalid/a/b.git/ ")).toBe(
      "https://example.invalid/a/b",
    );
    let now = 0;
    const checkouts = new GitCheckouts(1000, () => now);
    const first = checkouts.snapshot([{ id: "a", path: "/missing" }], "/codex");
    expect(checkouts.snapshot([{ id: "a", path: "/missing" }], "/codex")).toBe(first);
    expect(checkouts.snapshot([{ id: "b", path: "/missing" }], "/codex")).not.toBe(first);
    now = 5000;
    expect(checkouts.snapshot([{ id: "b", path: "/missing" }], "/codex")).not.toBe(first);
  });
});
