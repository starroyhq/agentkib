import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/claude-managed-read";
import type { Commands } from "../../../packages/backend/src/commands";
import type { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { BackendStore } from "../../../packages/backend/src/store";

// Whether managed Claude sessions may keep background tasks on this computer: the person's
// preference, the platform and the installed CLI's version. No CLI is started; `--version`
// answers from the stub below.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function owner(version: string | null, preference: boolean) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-claude-background-")));
  const bin = path.join(directory, "bin");
  mkdirSync(bin, { mode: 0o700 });
  // Only found on PATH, never run: the version comes from the stubbed command runner.
  if (version !== null)
    writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const run = vi.fn(async () => ({ success: true, bytes: Buffer.from(`${version}\n`) }));
  const value = new ClaudeManagedReadOwner(
    {
      workspacePath: () => directory,
      sessions: { id: (_agent: string, id: string) => id },
    } as unknown as BackendStore,
    {} as unknown as SessionReaders,
    { run } as unknown as Commands,
    directory,
    { PATH: bin, HOME: directory },
    randomUUID(),
    undefined,
    { backgroundTasks: () => preference },
  );
  cleanups.push(async () => {
    await value.shutdown();
    rmSync(directory, { recursive: true, force: true });
  });
  return value;
}

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Claude Code background task setting",
  () => {
    const macOS = process.platform === "darwin";
    it("is available on macOS with a CLI that reports when a message's turn starts", async () => {
      await expect(owner("2.1.323 (Claude Code)", true).backgroundTasksStatus()).resolves.toEqual(
        macOS
          ? {
              enabled: true,
              available: true,
              reason: null,
              minimumVersion: "2.1.299",
              cliVersion: "2.1.323",
            }
          : {
              enabled: true,
              available: false,
              reason: "platform-unsupported",
              minimumVersion: "2.1.299",
              cliVersion: null,
            },
      );
      // The person's choice is reported as is, whether or not it can apply.
      await expect(
        owner("2.1.299 (Claude Code)", false).backgroundTasksStatus(),
      ).resolves.toMatchObject({ enabled: false, available: macOS });
    });

    it.skipIf(process.platform !== "darwin")(
      "says why an older or missing CLI cannot",
      async () => {
        await expect(owner("2.1.298 (Claude Code)", true).backgroundTasksStatus()).resolves.toEqual(
          {
            enabled: true,
            available: false,
            reason: "claude-cli-too-old",
            minimumVersion: "2.1.299",
            cliVersion: "2.1.298",
          },
        );
        await expect(owner(null, true).backgroundTasksStatus()).resolves.toEqual({
          enabled: true,
          available: false,
          reason: "claude-cli-unavailable",
          minimumVersion: "2.1.299",
          cliVersion: null,
        });
      },
    );
  },
);
