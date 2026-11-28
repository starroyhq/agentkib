// @vitest-environment node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquirePortableFileLease,
  existingFileLeaseBusy,
} from "../../../packages/backend/src/managed-session-lock";
import { nativeBindings } from "../../../packages/backend/src/native-files";

const directories: string[] = [];
const leases: Array<() => void> = [];
afterEach(async () => {
  for (const release of leases.splice(0).reverse()) release();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "managed-session-lock-")),
  );
  directories.push(directory);
  return directory;
}

function acquire(filename: string) {
  const release = acquirePortableFileLease(filename);
  leases.push(release);
  return release;
}

describe("portable managed session leases", { timeout: 15_000 }, () => {
  it("rejects a competing lease and permits reacquisition after release without changing content", async () => {
    const filename = path.join(await fixture(), "session.lock");
    const content = Buffer.from("existing lease file\0中文🙂\n");
    await fs.writeFile(filename, content);
    const release = acquire(filename);
    expect(() => acquire(filename)).toThrow("session-managed-by-another-runtime");
    release();
    expect(await fs.readFile(filename)).toEqual(content);
    const releaseNext = acquire(filename);
    expect(() => acquire(filename)).toThrow("session-managed-by-another-runtime");
    releaseNext();
    expect(await fs.readFile(filename)).toEqual(content);
  });

  it("probes real ownership without creating or changing the file", async () => {
    const filename = path.join(await fixture(), "writer.lock");
    expect(existingFileLeaseBusy(filename)).toBe(false);
    await expect(fs.stat(filename)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(filename, "");
    expect(existingFileLeaseBusy(filename)).toBe(false);
    const release = acquire(filename);
    expect(existingFileLeaseBusy(filename)).toBe(true);
    release();
    expect(existingFileLeaseBusy(filename)).toBe(false);
    expect((await fs.stat(filename)).size).toBe(0);
  });

  it.skipIf(process.platform !== "darwin")(
    "probes the current flock when the previous writer still has the file open",
    async () => {
      const filename = path.join(await fixture(), "writer.lock");
      const contents = "native lock fixture";
      await fs.writeFile(filename, contents);
      const library = nativeBindings().load("/usr/lib/libSystem.B.dylib");
      const flock = library.func("int flock(int fd, int operation)");
      const exclusiveNonblocking = 2 | 4;
      const unlock = 8;

      const appFile = await fs.open(filename, "r+");
      try {
        expect(flock(appFile.fd, exclusiveNonblocking)).toBe(0);
        expect(existingFileLeaseBusy(filename)).toBe(true);
        expect(flock(appFile.fd, unlock)).toBe(0);
        // Unlocking a native flock does not close the file description.
        expect((await appFile.stat()).isFile()).toBe(true);
        expect(existingFileLeaseBusy(filename)).toBe(false);

        const cliFile = await fs.open(filename, "r+");
        try {
          expect(flock(cliFile.fd, exclusiveNonblocking)).toBe(0);
          expect(existingFileLeaseBusy(filename)).toBe(true);
          expect((await appFile.stat()).ino).toBe((await cliFile.stat()).ino);
          expect(flock(cliFile.fd, unlock)).toBe(0);
          expect(existingFileLeaseBusy(filename)).toBe(false);
        } finally {
          await cliFile.close();
        }
      } finally {
        await appFile.close();
      }
      expect(await fs.readFile(filename, "utf8")).toBe(contents);
    },
  );

  it("holds independent leases for different paths", async () => {
    const directory = await fixture();
    const first = path.join(directory, "first.lock");
    const second = path.join(directory, "second.lock");
    const releaseFirst = acquire(first);
    const releaseSecond = acquire(second);
    expect(() => acquire(first)).toThrow("session-managed-by-another-runtime");
    expect(() => acquire(second)).toThrow("session-managed-by-another-runtime");
    releaseFirst();
    const releaseFirstAgain = acquire(first);
    expect(() => acquire(second)).toThrow("session-managed-by-another-runtime");
    releaseFirstAgain();
    releaseSecond();
  });

  it("does not let repeated release unlock a subsequently acquired lease", async () => {
    const filename = path.join(await fixture(), "session.lock");
    const releasePrevious = acquire(filename);
    releasePrevious();
    const releaseCurrent = acquire(filename);
    expect(() => {
      releasePrevious();
      releasePrevious();
    }).not.toThrow();
    expect(() => acquire(filename)).toThrow("session-managed-by-another-runtime");
    releaseCurrent();
    acquire(filename)();
  });

  it("rejects a directory at the lock path", async () => {
    const filename = path.join(await fixture(), "session.lock");
    await fs.mkdir(filename);
    expect(() => acquire(filename)).toThrow();
    expect((await fs.lstat(filename)).isDirectory()).toBe(true);
  });
});
