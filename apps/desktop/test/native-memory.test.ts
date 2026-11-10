import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendStore } from "../../../packages/backend/src/store";
import { NativeMemoryOwner } from "../../../packages/backend/src/native-memory";
import { redactText } from "../../../packages/backend/src/claude-settings";

const io = vi.hoisted(() => ({
  opens: [] as string[],
  gate: undefined as undefined | ((file: string) => Promise<void>),
  afterRead: undefined as undefined | ((file: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      io.opens.push(String(args[0]));
      await io.gate?.(String(args[0]));
      const handle = await actual.open(...args);
      const read = handle.read.bind(handle);
      handle.read = (async (...parameters: Parameters<typeof read>) => {
        const result = await Reflect.apply(read, handle, parameters);
        await io.afterRead?.(String(args[0]));
        return result;
      }) as typeof handle.read;
      return handle;
    },
  };
});
const created: ReturnType<typeof fixture>[] = [];
function fixture(limits: ConstructorParameters<typeof NativeMemoryOwner>[0]["limits"] = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-native-memory-")));
  const home = path.join(root, "home"),
    project = path.join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const environment: NodeJS.ProcessEnv = { HOME: home };
  const database = path.join(root, "state.db");
  const store = new BackendStore(database);
  const add = (id: string, directory = project) => {
    mkdirSync(directory, { recursive: true });
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
      id,
      directory,
      id,
      "healthy",
      new Date().toISOString(),
    );
  };
  add("workspace");
  const memory = (directory = project, config = path.join(home, ".claude")) =>
    path.join(config, "projects", directory.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const settings = (value: unknown, directory = path.join(home, ".claude")) =>
    write(path.join(directory, "settings.json"), JSON.stringify(value));
  const notify = vi.fn();
  const owner = new NativeMemoryOwner({ store, environment, notify, limits });
  const f = {
    root,
    home,
    project,
    environment,
    database,
    store,
    owner,
    add,
    memory,
    write,
    settings,
    notify,
  };
  created.push(f);
  return f;
}
afterEach(async () => {
  io.gate = undefined;
  io.afterRead = undefined;
  io.opens.length = 0;
  for (const f of created.splice(0)) {
    f.owner.close();
    await nextImmediate();
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("native memory owner", () => {
  it("reads unmanaged discovered workspaces, all markdown beyond Claude startup preview, sanitized detail and safe ID links", async () => {
    const f = fixture();
    f.write(
      path.join(f.memory(), "MEMORY.md"),
      `# Memory\n${"line\n".repeat(205)}[Topic](topics/setup.md#notes) [outside](../not-memory.md) [web](https://example.test)\napi_key=sk-private-value\n`,
    );
    f.write(path.join(f.memory(), "topics/setup.md"), "# Notes\nKeep this");
    f.write(path.join(f.memory(), "ignored.txt"), "not memory");
    const result = await f.owner.refresh();
    expect(result.refreshing).toBe(false);
    expect(result.sources[0]).toMatchObject({
      status: "ready",
      stale: false,
      workspaces: [{ id: "workspace", name: "workspace" }],
    });
    expect(result.total).toBe(2);
    const detail = await f.owner.read(result.files.find((file) => file.kind === "index")!.id);
    expect(detail.content).toContain("line\n".repeat(205));
    expect(detail.content).not.toContain("sk-private-value");
    expect(detail.links).toEqual([
      {
        label: "Topic",
        targetId: result.files.find((file) => file.kind === "topic")!.id,
        fragment: "notes",
      },
    ]);
    expect(detail.file.version).not.toContain(f.root);
    await expect(f.owner.read(path.join(f.memory(), "MEMORY.md"))).rejects.toThrow(
      "native-memory-file-unavailable",
    );
    expect(f.owner.search({ query: "keep SETUP" }).total).toBe(1);
    expect(f.owner.search({ query: "keep missing" }).total).toBe(0);
  });

  it("derives topic title and excerpt from sanitized frontmatter before Markdown headings", async () => {
    const f = fixture();
    f.write(
      path.join(f.memory(), "topic.md"),
      "---\nname: Native project context\ntitle: Lower priority title\ndescription: >-\n  Useful **project** background\n  across two lines.\ntype: project\n---\n```md\n# Ignored code heading\ncode noise\n```\n# Body heading\n\nFirst body paragraph.",
    );
    const snapshot = await f.owner.refresh();
    expect(snapshot.files[0]).toMatchObject({
      title: "Native project context",
      excerpt: "Useful project background across two lines.",
    });
    const opens = io.opens.length;
    expect(f.owner.snapshot().files[0]).toMatchObject({
      title: "Native project context",
      excerpt: "Useful project background across two lines.",
    });
    expect(io.opens).toHaveLength(opens);
  });

  it("uses Markdown headings and plain prose fallbacks without frontmatter or code-block noise", async () => {
    const f = fixture();
    f.write(
      path.join(f.memory(), "heading.md"),
      "---\ntitle: Explicit YAML title\n---\n~~~md\n# Noisy example heading\n~~~\n# **Useful** heading\n\nRead the [project guide](guide.md) for `details`.\n\nAnother paragraph.",
    );
    f.write(
      path.join(f.memory(), "fallback.md"),
      "```yaml\nname: Example only\n```\n# **Heading title**\n\nA concise first paragraph\ncontinued here.\n\nLater text.",
    );
    f.write(
      path.join(f.memory(), "plain.md"),
      "    indented code noise\n\nPlain useful text.\n\nLater paragraph.",
    );
    const snapshot = await f.owner.refresh();
    expect(snapshot.files.find((file) => file.relativePath === "heading.md")).toMatchObject({
      title: "Explicit YAML title",
      excerpt: "Read the project guide for details.",
    });
    expect(snapshot.files.find((file) => file.relativePath === "fallback.md")).toMatchObject({
      title: "Heading title",
      excerpt: "A concise first paragraph continued here.",
    });
    expect(snapshot.files.find((file) => file.relativePath === "plain.md")).toMatchObject({
      title: "Plain useful text.",
      excerpt: "Plain useful text.",
    });
  });

  it("bounds metadata by Unicode code points and never exposes credential values in it", async () => {
    const f = fixture();
    f.write(
      path.join(f.memory(), "long.md"),
      `---\nname: "${"🌿".repeat(150)}"\ndescription: "${"记".repeat(200)}"\n---\nBody`,
    );
    f.write(
      path.join(f.memory(), "private.md"),
      '---\nname: "token=canary-private-title"\ndescription: "password=canary-private-description"\n---\n# Safe heading\n',
    );
    const snapshot = await f.owner.refresh();
    const long = snapshot.files.find((file) => file.relativePath === "long.md")!;
    expect(Array.from(long.title!)).toHaveLength(120);
    expect(Array.from(long.excerpt!)).toHaveLength(180);
    expect(long.title).toBe("🌿".repeat(119) + "…");
    expect(long.excerpt).toBe("记".repeat(179) + "…");
    const privateFile = snapshot.files.find((file) => file.relativePath === "private.md")!;
    expect(
      JSON.stringify({ title: privateFile.title, excerpt: privateFile.excerpt }),
    ).not.toContain("canary");
  });

  it("derives missing optional metadata from old sanitized cache text without file IO", async () => {
    const f = fixture();
    f.write(path.join(f.memory(), "topic.md"), "# Cached heading\n\nCached summary.");
    await f.owner.refresh();
    const row = f.store.sql.one("SELECT source_id,files_json FROM native_memory_cache")!;
    const files = JSON.parse(String(row.files_json)) as Array<{
      file: { title?: string; excerpt?: string };
    }>;
    for (const cached of files) {
      delete cached.file.title;
      delete cached.file.excerpt;
    }
    f.store.sql.run(
      "UPDATE native_memory_cache SET files_json=? WHERE source_id=?",
      JSON.stringify(files),
      String(row.source_id),
    );
    f.owner.close();
    io.opens.length = 0;
    const replacement = new NativeMemoryOwner({
      store: f.store,
      environment: f.environment,
      notify: () => {},
    });
    try {
      expect(replacement.snapshot().files[0]).toMatchObject({
        title: "Cached heading",
        excerpt: "Cached summary.",
        stale: true,
      });
      expect(io.opens).toHaveLength(0);
    } finally {
      replacement.close();
    }
  });

  it("redacts long native text including multiline shell values and private keys while retaining its tail", async () => {
    const f = fixture();
    const prefix = "Visible native note\n".repeat(300);
    const text =
      prefix +
      "run --token 'canary-prefix'\\\n'canary-suffix'; echo ordinary\n" +
      "-----BEGIN PRIVATE KEY-----\ncanary-private-key\n-----END PRIVATE KEY-----\n" +
      "https://user:canary-password@example.test/path?token=canary-query\n" +
      "visible tail";
    f.write(path.join(f.memory(), "MEMORY.md"), text);
    const snapshot = await f.owner.refresh();
    const detail = await f.owner.read(snapshot.files[0]!.id);
    expect(detail.content).toContain(prefix);
    expect(detail.content).toContain("visible tail");
    expect(detail.content).not.toContain("canary");
    expect(detail.file.truncated).toBe(false);
    expect(redactText("x".repeat(500))).toBe("x".repeat(200) + "…");
    expect(redactText("x".repeat(500), 1000)).toBe("x".repeat(500));
  });

  it("switches a valid CLAUDE_CONFIG_DIR to B without reopening A", async () => {
    const f = fixture();
    const firstFile = path.join(f.memory(), "MEMORY.md");
    f.write(firstFile, "from A");
    const first = await f.owner.refresh();
    const alternate = path.join(f.root, "config-b");
    f.settings({}, alternate);
    const secondFile = path.join(f.memory(f.project, alternate), "MEMORY.md");
    f.write(secondFile, "from B");
    f.environment.CLAUDE_CONFIG_DIR = alternate;
    io.opens.length = 0;
    const snapshot = await f.owner.refresh();
    expect(snapshot.sources[0]!.directory).toBe(f.memory(f.project, alternate));
    expect(snapshot.sources[0]!.id).not.toBe(first.sources[0]!.id);
    expect((await f.owner.read(snapshot.files[0]!.id)).content).toBe("from B");
    expect(io.opens).toEqual([secondFile, secondFile]);
    await expect(f.owner.read(first.files[0]!.id)).rejects.toThrow(
      "native-memory-file-unavailable",
    );
    expect(f.store.sql.rows("SELECT directory FROM native_memory_cache")).toEqual([
      { directory: f.memory(f.project, alternate) },
    ]);
  });

  it("expands a trusted ~/ directory, shares it across workspaces and lists topics without MEMORY.md", async () => {
    const f = fixture();
    const shared = path.join(f.home, "shared-memory");
    const other = path.join(f.root, "other");
    f.add("other", other);
    f.settings({ autoMemoryDirectory: "~/shared-memory" });
    f.write(path.join(shared, "topic.md"), "shared native topic");
    const snapshot = await f.owner.refresh();
    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot.sources[0]!.directory).toBe(shared);
    expect(snapshot.sources[0]!.workspaces.map((workspace) => workspace.id).sort()).toEqual([
      "other",
      "workspace",
    ]);
    expect(snapshot.files).toMatchObject([{ kind: "topic", relativePath: "topic.md" }]);
    expect((await f.owner.read(snapshot.files[0]!.id)).content).toBe("shared native topic");
  });

  it.each(["settings.json", "settings.local.json"])(
    "does not guess a source when project %s has an override with unknown trust",
    async (settingsFile) => {
      const f = fixture();
      f.write(path.join(f.memory(), "MEMORY.md"), "default source");
      const first = await f.owner.refresh();
      const unverified = path.join(f.root, "unverified");
      f.write(path.join(unverified, "topic.md"), "must not read unverified target");
      f.write(
        path.join(f.project, ".claude", settingsFile),
        JSON.stringify({ autoMemoryDirectory: unverified }),
      );
      io.opens.length = 0;
      const snapshot = await f.owner.refresh();
      expect(snapshot).toMatchObject({
        total: 0,
        sources: [{ status: "unavailable", reason: "path-unresolved", directory: null }],
      });
      expect(io.opens).toHaveLength(0);
      await expect(f.owner.read(first.files[0]!.id)).rejects.toThrow(
        "native-memory-file-unavailable",
      );
      expect(f.store.sql.rows("SELECT * FROM native_memory_cache")).toHaveLength(0);
    },
  );

  it("keeps the last-good preview when the same inode changes after the first read chunk, then reads the new document", async () => {
    const f = fixture();
    const file = path.join(f.memory(), "MEMORY.md");
    const initial = "original line\n".repeat(6000);
    const updated = "new native line\n".repeat(6000);
    f.write(file, initial);
    const snapshot = await f.owner.refresh();
    const inode = lstatSync(file).ino;
    io.afterRead = async (opened) => {
      if (opened !== file) return;
      io.afterRead = undefined;
      writeFileSync(file, updated);
      expect(lstatSync(file).ino).toBe(inode);
    };
    const stale = await f.owner.read(snapshot.files[0]!.id);
    expect(stale.content).toBe(initial);
    expect(stale.file.stale).toBe(true);
    expect(stale.source).toMatchObject({ status: "error", reason: "read-failed" });
    const current = await f.owner.read(snapshot.files[0]!.id);
    expect(current.content).toBe(updated);
    expect(current.file.stale).toBe(false);
    expect(current.file.version).not.toBe(stale.file.version);
  });

  it("counts non-Markdown files toward the bounded directory scan", async () => {
    const f = fixture({ files: 2 });
    for (let i = 0; i < 3; i++) f.write(path.join(f.memory(), `file-${i}.txt`), "not indexed");
    const snapshot = await f.owner.refresh();
    expect(snapshot.total).toBe(0);
    expect(snapshot.sources[0]).toMatchObject({ incomplete: true, reason: "limited" });
  });

  it("keeps a last-good file stale on invalid UTF-8 and removes it only after confirmed deletion", async () => {
    const f = fixture();
    const file = path.join(f.memory(), "MEMORY.md");
    f.write(file, "last good");
    const first = await f.owner.refresh();
    writeFileSync(file, Buffer.from([0xff, 0xfe]));
    const next = await f.owner.refresh();
    expect(next.sources[0]).toMatchObject({ stale: true, status: "error", reason: "read-failed" });
    expect((await f.owner.read(first.files[0]!.id)).content).toBe("last good");
    unlinkSync(file);
    await expect(f.owner.read(first.files[0]!.id)).rejects.toThrow(
      "native-memory-file-unavailable",
    );
    expect(f.owner.snapshot().files).toHaveLength(0);
  });

  it("shares a canonical source between repository subdirectories and native worktrees", async () => {
    const f = fixture();
    mkdirSync(path.join(f.project, ".git"));
    const nested = path.join(f.project, "packages/app");
    f.add("nested", nested);
    const worktree = path.join(f.root, "worktree");
    f.add("worktree", worktree);
    const admin = path.join(f.project, ".git/worktrees/wt");
    f.write(path.join(worktree, ".git"), `gitdir: ${admin}\n`);
    f.write(path.join(admin, "commondir"), "../..\n");
    f.write(path.join(admin, "gitdir"), `${path.join(worktree, ".git")}\n`);
    f.write(path.join(f.memory(), "MEMORY.md"), "shared");
    const result = await f.owner.refresh();
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.workspaces.map((workspace) => workspace.id).sort()).toEqual([
      "nested",
      "workspace",
      "worktree",
    ]);
    expect(f.owner.snapshot({ workspaceId: "nested" }).files).toHaveLength(1);
  });

  it("isolates disabled sources immediately, rejects old IDs, discards old asynchronous reads, and does not alter native files", async () => {
    const f = fixture();
    const file = path.join(f.memory(), "MEMORY.md");
    f.write(file, "private old note");
    const first = await f.owner.refresh();
    const gate = deferred(),
      entered = deferred();
    io.gate = async (opened) => {
      if (opened === file) {
        entered.resolve();
        await gate.promise;
      }
    };
    const reading = f.owner.read(first.files[0]!.id);
    await entered.promise;
    f.settings({ autoMemoryEnabled: false });
    expect(f.owner.snapshot()).toMatchObject({
      total: 0,
      sources: [{ status: "disabled", directory: null, reason: "disabled" }],
    });
    expect(f.store.sql.rows("SELECT * FROM native_memory_cache")).toHaveLength(0);
    gate.resolve();
    await expect(reading).rejects.toThrow("source changed");
    f.settings({});
    const next = await f.owner.refresh();
    expect((await f.owner.read(next.files[0]!.id)).content).toBe("private old note");
    expect(f.store.sql.rows("SELECT * FROM native_memory_cache")).toHaveLength(1);
  });

  it("does not revive config A when switching to config B with unreadable settings", async () => {
    const f = fixture();
    f.write(path.join(f.memory(), "MEMORY.md"), "from A");
    const first = await f.owner.refresh();
    const alternate = path.join(f.root, "config-b");
    f.write(path.join(alternate, "settings.json"), "{");
    f.environment.CLAUDE_CONFIG_DIR = alternate;
    const snapshot = f.owner.snapshot();
    expect(snapshot.total).toBe(0);
    expect(snapshot.sources[0]!.directory).toBeNull();
    expect(snapshot.sources[0]!.reason).toBe("read-failed");
    await expect(f.owner.read(first.files[0]!.id)).rejects.toThrow(
      "native-memory-file-unavailable",
    );
    f.settings({}, alternate);
    f.write(path.join(f.memory(f.project, alternate), "MEMORY.md"), "from B");
    expect((await f.owner.refresh()).total).toBe(1);
    expect((await f.owner.read(f.owner.snapshot().files[0]!.id)).content).toBe("from B");
  });

  it("preserves stale cache on ordinary settings errors, but removes confirmed deleted files", async () => {
    const f = fixture();
    const file = path.join(f.memory(), "MEMORY.md");
    f.write(file, "cached");
    const first = await f.owner.refresh();
    f.write(path.join(f.home, ".claude/settings.json"), "{");
    expect(f.owner.snapshot()).toMatchObject({
      total: 1,
      sources: [{ status: "error", stale: true, reason: "read-failed" }],
    });
    io.opens.length = 0;
    await f.owner.refresh();
    expect(io.opens).toHaveLength(0);
    expect((await f.owner.read(first.files[0]!.id)).file.stale).toBe(true);
    f.settings({});
    unlinkSync(file);
    const next = await f.owner.refresh();
    expect(next.total).toBe(0);
    expect(next.sources[0]!.status).toBe("empty");
  });

  it("reloads cache after restart without touching legacy memories or schema version", async () => {
    const f = fixture();
    f.write(path.join(f.memory(), "MEMORY.md"), "persisted");
    await f.owner.refresh();
    const legacyBefore = f.store.sql.rows("SELECT * FROM memories");
    f.owner.close();
    const replacement = new NativeMemoryOwner({
      store: f.store,
      environment: f.environment,
      notify: () => {},
    });
    try {
      expect(replacement.snapshot()).toMatchObject({ total: 1, sources: [{ stale: true }] });
      expect(replacement.snapshot().files[0]!.stale).toBe(true);
      io.opens.length = 0;
      await replacement.refresh();
      expect(io.opens).toHaveLength(1);
      expect(
        f.store.sql.one("SELECT value FROM schema_meta WHERE key='schema_version'")?.value,
      ).toBe("15");
      expect(f.store.sql.rows("SELECT * FROM memories")).toEqual(legacyBefore);
    } finally {
      replacement.close();
    }
  });

  it("uses incremental fingerprints, updates changed files only, and does not rewrite unchanged cached bodies", async () => {
    const f = fixture();
    f.write(path.join(f.memory(), "MEMORY.md"), "index");
    f.write(path.join(f.memory(), "topic.md"), "topic");
    await f.owner.refresh();
    io.opens.length = 0;
    f.store.sql.run(
      "CREATE TRIGGER body_unchanged BEFORE UPDATE OF files_json ON native_memory_cache BEGIN SELECT RAISE(ABORT, 'body rewrite'); END",
    );
    await f.owner.refresh();
    expect(io.opens).toHaveLength(0);
    f.store.sql.run("DROP TRIGGER body_unchanged");
    f.write(path.join(f.memory(), "topic.md"), "updated topic");
    await f.owner.refresh();
    expect(io.opens).toEqual([path.join(f.memory(), "topic.md")]);
  });

  it("paginates the list at 100, searches at 50, and ANDs whitespace-separated case-insensitive terms", async () => {
    const f = fixture();
    for (let i = 0; i < 105; i++)
      f.write(path.join(f.memory(), `note-${String(i).padStart(3, "0")}.md`), "one TWO");
    const result = await f.owner.refresh();
    expect(result.files).toHaveLength(100);
    expect(result.nextOffset).toBe(100);
    expect(f.owner.snapshot({ offset: 100 }).files).toHaveLength(5);
    expect(f.owner.search({ query: "  One   two " }).files).toHaveLength(50);
    expect(f.owner.search({ query: "one missing" }).total).toBe(0);
  });

  it("bounded scans indicate file/depth/byte limits and preserve a truncated preview", async () => {
    const f = fixture({ depth: 1, files: 10, fileBytes: 80, characters: 40, directoryBytes: 90 });
    f.write(path.join(f.memory(), "MEMORY.md"), "x".repeat(100));
    f.write(path.join(f.memory(), "sub/deep/hidden.md"), "hidden");
    const snapshot = await f.owner.refresh();
    expect(snapshot.sources[0]).toMatchObject({ incomplete: true, reason: "limited" });
    expect(snapshot.files[0]).toMatchObject({ truncated: true, size: 100 });
    expect((await f.owner.read(snapshot.files[0]!.id)).content).toHaveLength(40);
    expect(snapshot.files.some((file) => file.relativePath.endsWith("hidden.md"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "rejects escaped/sensitive/network symlinks, while allowing in-directory file and directory aliases",
    async () => {
      const f = fixture();
      const root = f.memory();
      f.write(path.join(root, "real/topic.md"), "safe");
      f.write(path.join(f.root, "outside.md"), "outside");
      f.write(path.join(root, "credentials.md"), "password=private");
      symlinkSync("real/topic.md", path.join(root, "alias.md"));
      symlinkSync("real", path.join(root, "alias-dir"), "dir");
      symlinkSync(path.join(f.root, "outside.md"), path.join(root, "escape.md"));
      symlinkSync("/net/should-never-connect/note.md", path.join(root, "network.md"));
      const snapshot = await f.owner.refresh();
      expect(snapshot.files.some((file) => file.relativePath === "alias.md")).toBe(true);
      expect(
        snapshot.files.some((file) => /escape|network|credentials/.test(file.relativePath)),
      ).toBe(false);
      expect(io.opens.every((file) => file.startsWith(root))).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32").each(["outside", "sensitive", "device"] as const)(
    "retracts a previously safe file ID after replacement with a %s symlink",
    async (kind) => {
      const f = fixture();
      const file = path.join(f.memory(), "topic.md");
      f.write(file, "old safe preview");
      const snapshot = await f.owner.refresh();
      const id = snapshot.files[0]!.id;
      const target =
        kind === "outside"
          ? path.join(f.root, "outside.md")
          : kind === "sensitive"
            ? path.join(f.memory(), "credentials.md")
            : "/dev/null";
      if (kind !== "device") f.write(target, "must never be read");
      unlinkSync(file);
      symlinkSync(target, file);
      io.opens.length = 0;
      await expect(f.owner.read(id)).rejects.toThrow("native-memory-file-unavailable");
      expect(f.owner.snapshot().files.some((entry) => entry.id === id)).toBe(false);
      expect(
        String(f.store.sql.one("SELECT files_json FROM native_memory_cache")?.files_json),
      ).not.toContain("old safe preview");
      expect(io.opens).toHaveLength(0);
    },
  );

  it("retains the stale preview for a temporary permission error rather than retracting its ID", async () => {
    const f = fixture();
    const file = path.join(f.memory(), "topic.md");
    f.write(file, "last good preview");
    const snapshot = await f.owner.refresh();
    io.gate = async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    const detail = await f.owner.read(snapshot.files[0]!.id);
    expect(detail.content).toBe("last good preview");
    expect(detail.file.stale).toBe(true);
    expect(f.owner.snapshot().files).toHaveLength(1);
  });

  it("immediately retracts a source switched to a network or sensitive root", async () => {
    const f = fixture();
    f.write(path.join(f.memory(), "MEMORY.md"), "old");
    await f.owner.refresh();
    f.settings({
      autoMemoryDirectory:
        process.platform === "win32"
          ? "\\\\not-a-real-host\\memory"
          : "/net/not-a-real-host/memory",
    });
    expect(f.owner.snapshot()).toMatchObject({
      total: 0,
      sources: [{ status: "unavailable", directory: null, reason: "path-unresolved" }],
    });
    f.settings({ autoMemoryDirectory: path.join(f.root, ".ssh") });
    expect(f.owner.snapshot().total).toBe(0);
    if (process.platform !== "win32") {
      f.settings({ autoMemoryDirectory: "/dev" });
      expect(f.owner.snapshot().sources[0]).toMatchObject({
        status: "unavailable",
        directory: null,
      });
    }
  });

  it("immediately removes excluded workspaces and ignores the old scan's result", async () => {
    const f = fixture();
    f.write(path.join(f.memory(), "MEMORY.md"), "old");
    await f.owner.refresh();
    f.write(path.join(f.memory(), "MEMORY.md"), "new");
    const gate = deferred(),
      entered = deferred();
    io.gate = async () => {
      entered.resolve();
      await gate.promise;
    };
    const refreshing = f.owner.refresh();
    await entered.promise;
    f.store.workspaces.excludeWorkspace("workspace");
    expect(f.owner.snapshot().sources).toEqual([]);
    gate.resolve();
    expect((await refreshing).total).toBe(0);
    expect(f.store.sql.rows("SELECT * FROM native_memory_cache")).toHaveLength(0);
  });

  it("never lets a scan overwrite a newer detail read", async () => {
    const f = fixture();
    const index = path.join(f.memory(), "MEMORY.md"),
      topic = path.join(f.memory(), "ZZ.md");
    f.write(index, "version zero");
    f.write(topic, "topic zero");
    const first = await f.owner.refresh();
    f.write(index, "version one");
    f.write(topic, "topic one");
    const gate = deferred(),
      entered = deferred();
    io.gate = async (file) => {
      if (file === topic) {
        entered.resolve();
        await gate.promise;
      }
    };
    const refreshing = f.owner.refresh();
    await entered.promise;
    f.write(index, "version two");
    expect(
      (await f.owner.read(first.files.find((file) => file.kind === "index")!.id)).content,
    ).toBe("version two");
    gate.resolve();
    await refreshing;
    expect(f.owner.search({ query: "version two" }).total).toBe(1);
  });

  it("prefers a newer actual detail observation even when the detail request began before the scan", async () => {
    const f = fixture();
    const file = path.join(f.memory(), "MEMORY.md");
    f.write(file, "version zero");
    const first = await f.owner.refresh();
    const gate = deferred(),
      entered = deferred();
    let once = true;
    io.gate = async (opened) => {
      if (opened === file && once) {
        once = false;
        entered.resolve();
        await gate.promise;
      }
    };
    const reading = f.owner.read(first.files[0]!.id);
    await entered.promise;
    f.write(file, "version one");
    await f.owner.refresh();
    f.write(file, "version two");
    gate.resolve();
    expect((await reading).content).toBe("version two");
    expect(f.owner.search({ query: "version two" }).total).toBe(1);
  });

  it("never resurrects a file after a detail request confirmed its deletion during a scan", async () => {
    const f = fixture();
    const index = path.join(f.memory(), "MEMORY.md"),
      topic = path.join(f.memory(), "ZZ.md");
    f.write(index, "old index");
    f.write(topic, "old topic");
    const first = await f.owner.refresh();
    f.write(index, "new index");
    f.write(topic, "new topic");
    const gate = deferred(),
      entered = deferred();
    io.gate = async (file) => {
      if (file === topic) {
        entered.resolve();
        await gate.promise;
      }
    };
    const refreshing = f.owner.refresh();
    await entered.promise;
    unlinkSync(index);
    await expect(
      f.owner.read(first.files.find((file) => file.kind === "index")!.id),
    ).rejects.toThrow("native-memory-file-unavailable");
    gate.resolve();
    await refreshing;
    expect(f.owner.snapshot().files.some((file) => file.kind === "index")).toBe(false);
  });

  it("keeps the persisted directory body budget when detail files grow after a scan", async () => {
    const f = fixture({ directoryBytes: 100, fileBytes: 80 });
    f.write(path.join(f.memory(), "MEMORY.md"), "small");
    f.write(path.join(f.memory(), "topic.md"), "x".repeat(60));
    const first = await f.owner.refresh();
    f.write(path.join(f.memory(), "MEMORY.md"), "y".repeat(70));
    await f.owner.read(first.files.find((file) => file.kind === "index")!.id);
    const row = f.store.sql.one("SELECT files_json FROM native_memory_cache")!;
    const files = JSON.parse(String(row.files_json)) as Array<{ content: string }>;
    expect(
      files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    ).toBeLessThanOrEqual(100);
    expect(f.owner.snapshot().sources[0]).toMatchObject({ incomplete: true, reason: "limited" });
  });

  it("coalesces active observers, watches both source directories, and cleans up on close", async () => {
    const f = fixture({ pollMs: 80 });
    f.write(path.join(f.memory(), "sub/topic.md"), "first");
    const second = path.join(f.root, "other");
    f.add("other", second);
    f.write(path.join(f.memory(second), "sub/topic.md"), "other");
    f.owner.observe("one", true);
    f.owner.observe("two", true);
    await f.owner.refresh();
    await writeFile(path.join(f.memory(), "sub/topic.md"), "watch first");
    await writeFile(path.join(f.memory(second), "sub/topic.md"), "watch second");
    await vi.waitFor(() => expect(f.owner.search({ query: "watch" }).total).toBe(2), {
      timeout: 2000,
    });
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalled(), { timeout: 2000 });
    expect(f.notify.mock.calls.length).toBeLessThan(6);
    f.owner.close();
    const notifications = f.notify.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(f.notify.mock.calls).toHaveLength(notifications);
  });
});
