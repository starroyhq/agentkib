import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dshSessionDirectory, probeDshWriter } from "../../../packages/backend/src/dsh-writer";
import { acquirePortableFileLease } from "../../../packages/backend/src/managed-session-lock";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "DSH writer lease",
  () => {
    it("checks the native path and distinguishes a held lease from a retained file", () => {
      const home = mkdtempSync(path.join(tmpdir(), "agentkib-dsh-writer-"));
      homes.push(home);
      const cwd = "/Users/test/目录:name";
      const id = "session~a";
      const directory = path.join(
        home,
        "sessions",
        "--Users-test-~76EE~5F55-name--",
        "session~007Ea",
      );
      const lock = path.join(directory, "session.lock");
      mkdirSync(directory, { recursive: true });

      expect(dshSessionDirectory(id, cwd, home)).toBe(directory);
      expect(probeDshWriter(id, cwd, home)).toBe("free");
      expect(existsSync(lock)).toBe(false);
      const release = acquirePortableFileLease(lock);
      const before = statSync(lock);
      try {
        expect(probeDshWriter(id, cwd, home)).toBe("held");
      } finally {
        release();
      }
      expect(probeDshWriter(id, cwd, home)).toBe("free");
      expect(statSync(lock).ino).toBe(before.ino);
    });

    it("does not infer an unowned session from missing or redirected storage", () => {
      const home = mkdtempSync(path.join(tmpdir(), "agentkib-dsh-writer-"));
      homes.push(home);
      const project = path.join(home, "sessions", "--repo--");
      mkdirSync(project, { recursive: true });
      expect(probeDshWriter("session-a", "/repo", home)).toBe("unknown");
      symlinkSync(project, path.join(project, "session-a"));
      expect(probeDshWriter("session-a", "/repo", home)).toBe("unknown");
      const session = path.join(project, "session-b");
      mkdirSync(session);
      symlinkSync(path.join(session, "missing"), path.join(session, "session.lock"));
      expect(probeDshWriter("session-b", "/repo", home)).toBe("unknown");
    });
  },
);
