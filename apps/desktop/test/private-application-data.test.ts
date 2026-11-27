// @vitest-environment node
import {
  chmodSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preparePrivateDatabase } from "../../../packages/backend/src/private-data-path";
import { BackendStore } from "../../../packages/backend/src/store";
import { resolveApplicationDataDir } from "../electron/main/application-data-dir";

let root: string;
const mode = (file: string) => lstatSync(file).mode & 0o777;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ak-private-application-data-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("private shared application data", () => {
  const profile = (base: string) =>
    resolveApplicationDataDir({ XDG_DATA_HOME: base }, "linux", false);

  it("creates the application directory, database and active SQLite sidecars as owner-only", async () => {
    const directory = await profile(root);
    const database = path.join(directory, "agentkib.db");
    const store = new BackendStore(database);
    try {
      expect(mode(directory)).toBe(0o700);
      for (const suffix of ["", "-wal", "-shm"]) expect(mode(database + suffix)).toBe(0o600);
    } finally {
      store.close();
    }
  });

  it("tightens an existing profile idempotently and keeps the original database and its data", async () => {
    const shared = path.join(root, "shared");
    const directory = path.join(shared, "ai.agentkib");
    mkdirSync(directory, { recursive: true });
    chmodSync(shared, 0o755);
    chmodSync(directory, 0o755);
    const database = path.join(directory, "agentkib.db");
    const previous = new DatabaseSync(database);
    previous.exec(
      "CREATE TABLE previous (content TEXT); INSERT INTO previous VALUES ('existing');",
    );
    previous.close();
    chmodSync(database, 0o644);
    const inode = lstatSync(database).ino;

    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await profile(shared)).toBe(directory);
      const store = new BackendStore(database);
      try {
        expect(store.sql.one("SELECT content FROM previous")?.content).toBe("existing");
      } finally {
        store.close();
      }
      expect(lstatSync(database).ino).toBe(inode);
      expect(mode(directory)).toBe(0o700);
      expect(mode(database)).toBe(0o600);
      expect(mode(shared)).toBe(0o755);
    }
  });

  it("keeps the existing legacy profile migration and secures the same directory inode", async () => {
    const previous = path.join(root, "com.agentkib.desktop");
    mkdirSync(previous, { mode: 0o755 });
    chmodSync(previous, 0o755);
    writeFileSync(path.join(previous, "preferences.json"), "{}");
    const inode = lstatSync(previous).ino;

    const directory = await profile(root);
    expect(lstatSync(directory).ino).toBe(inode);
    expect(mode(directory)).toBe(0o700);
    expect(readFileSync(path.join(directory, "preferences.json"), "utf8")).toBe("{}");
  });

  it("narrows existing database and journal permissions without adding owner permissions", () => {
    const database = path.join(root, "agentkib.db");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      writeFileSync(database + suffix, "fixture");
      chmodSync(database + suffix, 0o444);
    }
    preparePrivateDatabase(database);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      expect(mode(database + suffix)).toBe(0o400);
      expect(readFileSync(database + suffix, "utf8")).toBe("fixture");
    }
  });

  it.each(["ai.agentkib", "com.agentkib.desktop"])(
    "rejects a linked profile at %s",
    async (name) => {
      const outside = path.join(root, "outside");
      const link = path.join(root, name);
      mkdirSync(outside);
      chmodSync(outside, 0o755);
      symlinkSync(outside, link);
      await expect(profile(root)).rejects.toThrow("Unsafe AgentKib data directory");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(mode(outside)).toBe(0o755);
    },
  );

  it.each(["", "-wal", "-shm", "-journal"])("rejects a database path linked at %s", (suffix) => {
    const database = path.join(root, "agentkib.db");
    const outside = path.join(root, "outside");
    writeFileSync(outside, "fixture");
    chmodSync(outside, 0o644);
    symlinkSync(outside, database + suffix);
    expect(() => new BackendStore(database)).toThrow("Unsafe AgentKib database file");
    expect(mode(outside)).toBe(0o644);
    expect(readFileSync(outside, "utf8")).toBe("fixture");
  });

  it("rejects hard-linked databases without changing the shared inode", () => {
    const database = path.join(root, "agentkib.db");
    const outside = path.join(root, "outside");
    writeFileSync(outside, "fixture");
    chmodSync(outside, 0o644);
    linkSync(outside, database);
    expect(() => new BackendStore(database)).toThrow("Unsafe AgentKib database file");
    expect(mode(outside)).toBe(0o644);
  });

  it("rejects another owner's directory before changing its permissions", async () => {
    const directory = path.join(root, "ai.agentkib");
    mkdirSync(directory);
    chmodSync(directory, 0o755);
    vi.spyOn(process, "getuid").mockReturnValue(lstatSync(directory).uid + 1);
    await expect(profile(root)).rejects.toThrow("Unsafe AgentKib data directory");
    expect(mode(directory)).toBe(0o755);
  });
});
