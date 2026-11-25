// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Commands } from "../../../packages/backend/src/commands";
import { Git } from "../../../packages/backend/src/git";
import { canonicalize } from "../../../packages/backend/src/paths";
import { BackendStore } from "../../../packages/backend/src/store";
import { webDiff } from "../../../packages/backend/src/web-diff";
import { startHost } from "./session-baseline/harness";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const root = canonicalize(mkdtempSync(join(tmpdir(), "ak-web-diff-")));
  const workspace = join(root, "repo");
  mkdirSync(workspace);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const command = (...args: string[]) =>
    execFileSync("git", args, { cwd: workspace, env, stdio: "pipe", timeout: 5_000 })
      .toString()
      .trim();
  command("init", "--quiet", "--template=");
  command("config", "diff.context", "0");
  const store = new BackendStore(join(root, "test.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Fixture",
    "healthy",
    "2026-11-24T00:00:00Z",
  );
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const git = new Git(commands, (id) => store.workspacePath(id), env);
  const write = (path: string, text: string) => {
    const file = join(workspace, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const commit = () => {
    command("add", ".");
    command("commit", "--quiet", "-m", "fixture");
    return command("rev-parse", "HEAD");
  };
  const read = (options: Record<string, unknown> = {}) =>
    webDiff(
      { operation: "diff", workspaceId: "workspace", kind: "worktree", ...options },
      store,
      git,
    );
  return { root, workspace, command, store, git, write, commit, read };
}

describe("supplemental Git diff context", () => {
  it("adds only proven unchanged rows with old and new coordinates", async () => {
    const f = fixture();
    const path = "with spaces.txt";
    f.write(path, "alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot");
    f.commit();
    f.write(path, "alpha\nchanged\ncharlie\ndelta\ninsertion\necho\nfoxtrot");
    const legacy = await f.read();
    expect(legacy).not.toHaveProperty("context");
    const context = {
      lines: [
        { path, oldLine: 1, newLine: 1, text: "alpha", source: "host" },
        { path, oldLine: 3, newLine: 3, text: "charlie", source: "host" },
        { path, oldLine: 4, newLine: 4, text: "delta", source: "host" },
        { path, oldLine: 5, newLine: 6, text: "echo", source: "host" },
        { path, oldLine: 6, newLine: 7, text: "foxtrot", source: "host" },
      ],
    };
    expect(await f.read({ context: true })).toEqual({ ...legacy, context });
    expect(await f.read({ context: true, path })).toEqual({ ...legacy, context });
  });

  it("uses the patch source for the index and a commit independently of the checkout", async () => {
    const f = fixture();
    f.write("proof.md", "unchanged\nold\nlast\n");
    f.commit();
    f.write("proof.md", "unchanged\nnew\nlast\n");
    f.command("add", "proof.md");
    f.write("proof.md", "changed after staging\n");
    const staged = await f.read({ kind: "staged", context: true });
    expect(staged?.patch).toContain("+new");
    expect(staged?.context?.lines.map((row) => row.text)).toEqual(["unchanged", "last"]);
    f.command("commit", "--quiet", "-m", "staged");
    const committed = await f.read({
      kind: "commit",
      oid: f.command("rev-parse", "HEAD"),
      context: true,
    });
    expect(committed).toEqual(staged);
  });

  it("omits existing context and bounds supplemental rows in long gaps", async () => {
    const f = fixture();
    f.command("config", "diff.context", "2");
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
    f.write("many.txt", lines.join("\n") + "\n");
    f.commit();
    lines[100] = "changed";
    f.write("many.txt", lines.join("\n") + "\n");
    const result = await f.read({ context: true });
    expect(result?.context?.truncated).toBe(true);
    expect(result?.context?.lines.length).toBeLessThan(200);
    expect(result?.context?.lines.find((line) => line.oldLine === 101)).toBeUndefined();
    expect(result?.context?.lines.find((line) => line.oldLine === 100)).toBeUndefined();
    expect(result?.context?.lines.find((line) => line.oldLine === 98)?.text).toBe("line 98");
  });

  it("does not read a blob when the file browsing policy denies its path", async () => {
    const f = fixture();
    f.write(".private/proof.txt", "private line\nold\n");
    f.commit();
    f.write(".private/proof.txt", "private line\nnew\n");
    const blob = vi.spyOn(f.git, "diffContextBlob");
    const result = await f.read({ context: true });
    expect(result?.patch).toContain("+new");
    expect(result).not.toHaveProperty("context");
    expect(blob).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("does not read a symlink blob or target", async () => {
    const f = fixture();
    const link = join(f.workspace, "link");
    symlinkSync(join(f.root, "outside"), link);
    f.commit();
    rmSync(link);
    symlinkSync(join(f.root, "test.db"), link);
    const blob = vi.spyOn(f.git, "diffContextBlob");
    const result = await f.read({ context: true });
    expect(result?.patch).toContain("120000");
    expect(result).not.toHaveProperty("context");
    expect(blob).not.toHaveBeenCalled();
  });

  it("omits context when the source is stale or cannot prove the old patch rows", async () => {
    const f = fixture();
    f.write("proof.md", "before\nold\nafter\n");
    f.commit();
    f.write("proof.md", "before\nnew\nafter\n");
    const readBlob = f.git.diffContextBlob.bind(f.git);
    const blob = vi.spyOn(f.git, "diffContextBlob").mockResolvedValueOnce("wrong\nanchor\n");
    expect(await f.read({ context: true })).not.toHaveProperty("context");
    blob.mockImplementationOnce(async (...args) => {
      const result = await readBlob(...args);
      f.write("proof.md", "before\nchanged during read\nafter\n");
      return result;
    });
    const stale = await f.read({ context: true });
    expect(stale?.patch).toContain("+new");
    expect(stale).not.toHaveProperty("context");
    expect((await f.read({ context: true }))?.context?.lines.map((row) => row.text)).toEqual([
      "before",
      "after",
    ]);
  });

  it("keeps optional context on the existing scoped file-read route", async () => {
    const f = fixture();
    f.write("proof.md", "before\nold\nafter\n");
    f.commit();
    f.write("proof.md", "before\nnew\nafter\n");
    const request = vi.fn((value: unknown) => webDiff(value, f.store, f.git));
    const host = await startHost({
      root: f.root,
      workspace: f.workspace,
      rpc: async (_method, value) => {
        const envelope = value as { host?: { request?: { operation?: string } } };
        if (envelope.host?.request?.operation === "diff") return request(envelope.host.request);
        return {};
      },
    });
    try {
      const legacy = await host.http("/diff?workspaceId=workspace");
      expect(legacy.status).toBe(200);
      expect(legacy.body).not.toHaveProperty("context");
      const modern = await host.http("/diff?workspaceId=workspace&context=1");
      expect(modern.status).toBe(200);
      expect(modern.body).toMatchObject({
        patch: legacy.body.patch,
        context: {
          lines: [
            expect.objectContaining({ text: "before" }),
            expect.objectContaining({ text: "after" }),
          ],
        },
      });
      expect(await host.http("/diff?workspaceId=foreign&context=1")).toMatchObject({
        status: 403,
      });
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      await host.dispose();
    }
  });
});
