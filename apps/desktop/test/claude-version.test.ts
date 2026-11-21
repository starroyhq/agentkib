import { afterEach, describe, expect, it } from "vitest";
import { supportsClaudeVersion as viaManagedRead } from "../../../packages/backend/src/agents/claude/claude-managed-read";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  readClaudeInstallation,
  readClaudeVersion,
  supportsClaudeVersion,
} from "../../../packages/backend/src/agents/claude/claude-version";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

const fixtures: ContextFixture[] = [];
afterEach(() => {
  for (const created of fixtures.splice(0)) created.dispose();
});
const posix = process.platform === "win32" ? describe.skip : describe;

describe("supportsClaudeVersion", () => {
  it("is still exported by the module that used to define it", () => {
    expect(viaManagedRead).toBe(supportsClaudeVersion);
  });

  it("applies the managed-session minimum by default", () => {
    expect(supportsClaudeVersion("2.1.263 (Claude Code)")).toBe(true);
    expect(supportsClaudeVersion("2.1.262 (Claude Code)")).toBe(false);
  });

  it("compares against an explicit minimum", () => {
    expect(supportsClaudeVersion("2.1.277 (Claude Code)", "2.1.277")).toBe(true);
    expect(supportsClaudeVersion("2.1.276 (Claude Code)", "2.1.277")).toBe(false);
    expect(supportsClaudeVersion("2.10.0 (Claude Code)", "2.9.99")).toBe(true);
  });

  it.each(["", "2.1.296", "Claude Code 2.1.296", "2.1 (Claude Code)", "2.1.296 (Other Tool)"])(
    "rejects the malformed value %j",
    (value) => {
      expect(supportsClaudeVersion(value, "0.0.0")).toBe(false);
    },
  );
});

posix("readClaudeVersion", () => {
  function setup() {
    const f = contextFixture();
    fixtures.push(f);
    return f;
  }

  it("returns the version line of an installed claude", async () => {
    const f = setup();
    f.claude("2.1.296 (Claude Code)");
    expect(await readClaudeVersion(f.commands, f.environment)).toBe("2.1.296 (Claude Code)");
  });

  it("does not apply a minimum version", async () => {
    const f = setup();
    f.claude("1.0.0 (Claude Code)");
    expect(await readClaudeVersion(f.commands, f.environment)).toBe("1.0.0 (Claude Code)");
  });

  it("returns null when claude cannot be found", async () => {
    const f = setup();
    expect(await readClaudeVersion(f.commands, f.environment)).toBeNull();
  });

  it.each([
    ["an unexpected format", "version two", 0],
    ["a missing suffix", "2.1.296", 0],
    ["a non-zero exit code", "2.1.296 (Claude Code)", 1],
    ["more output than the limit", "x".repeat(5000), 0],
  ])("returns null for %s", async (_name, output, exitCode) => {
    const f = setup();
    f.claude(output, { exitCode });
    expect(await readClaudeVersion(f.commands, f.environment)).toBeNull();
  });
});

posix("readClaudeInstallation", () => {
  function setup() {
    const f = contextFixture();
    fixtures.push(f);
    // A second install after PATH's own, in a place the usual lookup also searches.
    const local = path.join(f.environment.HOME!, ".local", "bin");
    mkdirSync(local, { recursive: true });
    const second = (output: string) => {
      const executable = path.join(local, "claude");
      writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
      chmodSync(executable, 0o755);
      return executable;
    };
    return { f, second };
  }

  it("keeps the CLI on PATH when it is new enough", async () => {
    const { f, second } = setup();
    f.claude("2.1.299 (Claude Code)");
    second("2.1.323 (Claude Code)");
    expect(await readClaudeInstallation(f.commands, f.environment)).toEqual({
      executable: path.join(f.bin, "claude"),
      version: "2.1.299 (Claude Code)",
      reason: null,
    });
  });

  it("passes over an old CLI on PATH for a current install elsewhere", async () => {
    const { f, second } = setup();
    f.claude("2.1.200 (Claude Code)");
    const current = second("2.1.323 (Claude Code)");
    expect(await readClaudeInstallation(f.commands, f.environment)).toEqual({
      executable: current,
      version: "2.1.323 (Claude Code)",
      reason: null,
    });
  });

  it("says the CLI is too old, not missing, when no install is new enough", async () => {
    const { f, second } = setup();
    f.claude("2.1.200 (Claude Code)");
    second("version two");
    expect(await readClaudeInstallation(f.commands, f.environment)).toEqual({
      executable: path.join(f.bin, "claude"),
      version: "2.1.200 (Claude Code)",
      reason: "claude-cli-too-old",
    });
  });

  it("says the CLI is missing when none can be read", async () => {
    const { f } = setup();
    f.claude("version two");
    expect(await readClaudeInstallation(f.commands, f.environment)).toEqual({
      executable: null,
      version: null,
      reason: "claude-cli-unavailable",
    });
  });
});
