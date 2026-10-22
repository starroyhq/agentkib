import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeResumeCommand } from "../../../packages/backend/src/claude-resume-command";

const nativeId = "00000000-0000-4000-8000-000000000001";

describe("Claude host resume commands", () => {
  it.each(["darwin", "linux"] as const)(
    "keeps Claude's default configuration semantics on %s",
    (platform) => {
      expect(
        claudeResumeCommand("/synthetic/project's files", undefined, nativeId, platform),
      ).toEqual({
        available: true,
        shell: "posix",
        runOn: "host",
        command: `cd -- '/synthetic/project'\\''s files' && claude --resume '${nativeId}'`,
      });
    },
  );

  it("does not set the Claude directory in a default PowerShell resume command", () => {
    expect(claudeResumeCommand("C:\\Project's files", undefined, nativeId, "win32")).toEqual({
      available: true,
      shell: "powershell",
      runOn: "host",
      command: `try { Set-Location -LiteralPath 'C:\\Project''s files' -ErrorAction Stop; & claude --resume '${nativeId}' } catch { Write-Error $_ }`,
    });
  });

  it.skipIf(process.platform === "win32").each([false, true])(
    "quotes paths literally in a POSIX shell (configuration override: %s)",
    (overridden) => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-claude-command-")));
      try {
        const cwd = path.join(root, "project ' $(printf injected)");
        const config = path.join(root, "config ' `printf injected`");
        const bin = path.join(root, "bin");
        for (const dir of [cwd, config, bin]) mkdirSync(dir);
        writeFileSync(
          path.join(bin, "claude"),
          `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({cwd:process.cwd(),config:process.env.CLAUDE_CONFIG_DIR,args:process.argv.slice(2)}));`,
          { mode: 0o700 },
        );
        const result = claudeResumeCommand(cwd, overridden ? config : undefined, nativeId, "linux");
        const actual = JSON.parse(
          execFileSync("/bin/sh", ["-c", result.command], {
            env: { PATH: bin },
            encoding: "utf8",
          }),
        );
        expect(actual).toEqual({
          cwd,
          ...(overridden ? { config } : {}),
          args: ["--resume", nativeId],
        });
        expect(result).toMatchObject({ available: true, shell: "posix", runOn: "host" });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("uses literal PowerShell paths and preserves the configured Claude directory", () => {
    expect(
      claudeResumeCommand("C:\\Project's files", "C:\\Claude's config", nativeId, "win32"),
    ).toEqual({
      available: true,
      shell: "powershell",
      runOn: "host",
      command: `try { Set-Location -LiteralPath 'C:\\Project''s files' -ErrorAction Stop; $env:CLAUDE_CONFIG_DIR = 'C:\\Claude''s config'; & claude --resume '${nativeId}' } catch { Write-Error $_ }`,
    });
  });

  it.each(["--resume other", "'quoted'", "$(touch file)", ""])(
    "rejects an unverified native ID (%j)",
    (id) => {
      expect(() => claudeResumeCommand("/project", "/config", id)).toThrow(
        "unverified-session-identity",
      );
    },
  );

  it.each(["", "/project\0suffix"])("rejects an unusable workspace (%j)", (cwd) => {
    expect(() => claudeResumeCommand(cwd, undefined, nativeId)).toThrow(
      "claude-context-unavailable",
    );
  });

  it.each(["", "/config\0suffix"])("rejects an unusable explicit directory (%j)", (config) => {
    expect(() => claudeResumeCommand("/project", config, nativeId)).toThrow(
      "claude-context-unavailable",
    );
  });
});
