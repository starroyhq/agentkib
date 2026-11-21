import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexRuntimePreflight,
  codexServerVersion,
  codexVersionSupportsWriterLock,
} from "../../../packages/backend/src/agents/codex/codex-runtime-preflight";
import { codexDesktopExecutables } from "../../../packages/backend/src/agents/codex/codex-executable";
import { Commands } from "../../../packages/backend/src/commands";
import {
  acquirePortableFileLease,
  existingFileLeaseBusy,
} from "../../../packages/backend/src/managed-session-lock";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
describe("Codex writer preflight", () => {
  it("shares concurrent catalog version reads and invalidates the cached executable identity", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agentkib-version-check-"));
    roots.push(root);
    const executable = path.join(root, process.platform === "win32" ? "codex.exe" : "codex");
    writeFileSync(executable, "old fixture");
    chmodSync(executable, 0o700);
    const run = vi.spyOn(Commands.prototype, "run").mockResolvedValue({
      bytes: Buffer.from("codex-cli 0.146.0"),
      error: "",
      success: true,
      truncated: false,
      exitCode: 0,
    });
    const checker = new CodexRuntimePreflight({ PATH: root }, () => [executable]);
    try {
      const results = await Promise.all(Array.from({ length: 20 }, () => checker.check()));
      expect(results.every(({ reason }) => reason === "codex-cli-version-too-old")).toBe(true);
      expect(run).toHaveBeenCalledOnce();
      writeFileSync(executable, "updated fixture with a different identity");
      run.mockResolvedValue({
        bytes: Buffer.from("codex-cli 0.155.1"),
        error: "",
        success: true,
        truncated: false,
        exitCode: 0,
      });
      expect(await checker.check()).toMatchObject({ reason: null });
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      checker.close();
    }
  });
  it.each([
    ["codex-cli 0.147.0", null],
    ["codex-cli 0.146.0", "codex-cli-version-too-old"],
    // Named no release it can read: tried rather than left read-only.
    ["unrecognized version", null],
  ])("runs a bounded version command and caches its result for %s", async (output, reason) => {
    const root = mkdtempSync(path.join(tmpdir(), "agentkib-version-check-"));
    roots.push(root);
    const executable = path.join(root, process.platform === "win32" ? "codex.exe" : "codex");
    writeFileSync(executable, "fixture");
    chmodSync(executable, 0o700);
    const run = vi.spyOn(Commands.prototype, "run").mockResolvedValue({
      bytes: Buffer.from(output),
      error: "",
      success: true,
      truncated: false,
      exitCode: 0,
    });
    const checker = new CodexRuntimePreflight({ PATH: root }, () => [executable]);
    try {
      expect(await checker.check()).toMatchObject({ executable, reason });
      expect(await checker.check()).toMatchObject({ executable, reason });
      expect(run).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith(
        executable,
        ["--version"],
        expect.objectContaining({ timeout: 5000, limit: 512, strictOutput: true }),
      );
    } finally {
      checker.close();
    }
  });
  it.each([
    ["codex-cli 0.146.9", false],
    ["codex-cli 0.147.0-alpha.1", false],
    ["codex-cli 0.147.0", true],
    ["codex-cli 0.155.1", true],
    ["codex-cli 0.163.0-alpha.1", true],
    ["codex 0.147.0", true],
    ["0.155.1", false],
    ["codex-cli 0.155.1 unexpected", true],
    ["codex-cli 1.0.0 (abc123)", true],
    ["Codex CLI v1.2.3", true],
    ["codex-cli 0.146.0 (abc123)", false],
    ["codex-cli 01.2.3", false],
  ])("checks %s against the first stable writer-lock release", (version, expected) => {
    expect(codexVersionSupportsWriterLock(version)).toBe(expected);
  });

  it("reads the release from the app-server's user agent", () => {
    expect(
      codexServerVersion(
        "agentkib/0.167.0 (Mac OS 27.0.1; arm64) iTerm.app/3.7.7 (agentkib; 0.13.0)",
      ),
    ).toBe("0.167.0");
    expect(codexServerVersion("agentkib/0.167.0-alpha.4.1 (Mac OS 27.0.1; arm64)")).toBe(
      "0.167.0-alpha.4.1",
    );
    for (const value of [undefined, 42, "", "agentkib", "agentkib/latest (Mac OS)"])
      expect(codexServerVersion(value)).toBeNull();
  });

  describe("choosing among installed CLIs", () => {
    const install = (name: string) => {
      const root = mkdtempSync(path.join(tmpdir(), "agentkib-codex-install-"));
      roots.push(root);
      const executable = path.join(root, name);
      writeFileSync(executable, "fixture");
      chmodSync(executable, 0o700);
      return executable;
    };
    const versions = (table: Record<string, string | Error>) =>
      vi.spyOn(Commands.prototype, "run").mockImplementation(async (program) => {
        const value = table[program];
        if (value === undefined) throw new Error(`unexpected ${program}`);
        if (value instanceof Error) throw value;
        return {
          bytes: Buffer.from(value),
          error: "",
          success: true,
          truncated: false,
          exitCode: 0,
        };
      });

    it("falls back to the desktop app's CLI when the one on PATH is too old", async () => {
      const onPath = install("codex");
      const desktop = install("codex-desktop");
      versions({ [onPath]: "codex-cli 0.146.0", [desktop]: "codex-cli 0.167.0-alpha.4.1" });
      const checker = new CodexRuntimePreflight({}, () => [onPath, desktop]);
      try {
        expect(checker.preferred()).toBeNull();
        expect(await checker.check()).toEqual({ executable: desktop, reason: null });
        expect(checker.preferred()).toBe(desktop);
      } finally {
        checker.close();
      }
    });

    it("keeps the CLI on PATH when it can write, without running the others", async () => {
      const onPath = install("codex");
      const desktop = install("codex-desktop");
      const run = versions({ [onPath]: "codex-cli 0.155.1", [desktop]: "codex-cli 0.167.0" });
      const checker = new CodexRuntimePreflight({}, () => [onPath, desktop]);
      try {
        expect(await checker.check()).toEqual({ executable: onPath, reason: null });
        expect(run).toHaveBeenCalledOnce();
      } finally {
        checker.close();
      }
    });

    it("prefers a known release, and tries one it cannot read only when nothing else can write", async () => {
      const unreadable = install("codex");
      const current = install("codex-current");
      const old = install("codex-old");
      versions({
        [unreadable]: "codex (dev build)",
        [current]: "codex-cli 0.155.1",
        [old]: "codex-cli 0.120.0",
      });
      for (const [candidates, expected] of [
        [[unreadable, current], current],
        [[old, unreadable], unreadable],
      ] as const) {
        const checker = new CodexRuntimePreflight({}, () => [...candidates]);
        try {
          expect(await checker.check()).toEqual({ executable: expected, reason: null });
        } finally {
          checker.close();
        }
      }
    });

    it("stays read-only with the first CLI's reason when none can write", async () => {
      const old = install("codex");
      const broken = install("codex-broken");
      versions({ [old]: "codex-cli 0.146.0", [broken]: new Error("exited 1") });
      for (const [candidates, expected] of [
        [[old, broken], { executable: old, reason: "codex-cli-version-too-old" }],
        [[broken, old], { executable: broken, reason: "codex-cli-version-unavailable" }],
      ] as const) {
        const checker = new CodexRuntimePreflight({}, () => [...candidates]);
        try {
          expect(await checker.check()).toEqual(expected);
          expect(checker.preferred()).toBeNull();
        } finally {
          checker.close();
        }
      }
      const none = new CodexRuntimePreflight({}, () => [path.join(tmpdir(), "missing-codex")]);
      try {
        expect(await none.check()).toEqual({ reason: "codex-cli-unavailable" });
      } finally {
        none.close();
      }
    });

    it.runIf(process.platform === "darwin")(
      "finds the CLIs the desktop app ships, executable ones only",
      () => {
        const applications = mkdtempSync(path.join(tmpdir(), "agentkib-applications-"));
        roots.push(applications);
        const place = (file: string, mode: number) => {
          const target = path.join(applications, file);
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, "fixture");
          chmodSync(target, mode);
          return target;
        };
        const chatgpt = place("ChatGPT.app/Contents/Resources/codex-cli/bin/codex", 0o755);
        const standalone = place("Codex.app/Contents/Resources/codex", 0o755);
        place("Codex.app/Contents/Resources/codex-cli/bin/codex", 0o644);
        expect(codexDesktopExecutables({}, [applications])).toEqual([chatgpt, standalone]);
        expect(codexDesktopExecutables({}, [path.join(applications, "none")])).toEqual([]);
      },
    );
  });

  it("probes existing locks without changing contents, permissions or creating missing files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agentkib-writer-probe-"));
    roots.push(root);
    const directory = path.join(root, "thread-writer-locks");
    mkdirSync(directory);
    const lock = path.join(directory, "thread.lock");
    writeFileSync(lock, "owner metadata", { mode: 0o640 });
    const before = statSync(lock);
    expect(existingFileLeaseBusy(path.join(directory, "missing.lock"))).toBe(false);
    expect(existingFileLeaseBusy(lock)).toBe(false);
    const release = acquirePortableFileLease(lock);
    try {
      // The owner helper restricts its own file; the probe itself must leave that mode alone.
      const ownerMode = statSync(lock).mode;
      expect(existingFileLeaseBusy(lock)).toBe(true);
      expect(statSync(lock).mode).toBe(ownerMode);
      expect(readFileSync(lock, "utf8")).toBe("owner metadata");
    } finally {
      release();
    }
    expect(existingFileLeaseBusy(lock)).toBe(false);
    expect(statSync(lock).ino).toBe(before.ino);
  });
});
