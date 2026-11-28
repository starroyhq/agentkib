import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexDesktopApp,
  codexDesktopListed,
  codexThreadLink,
} from "../../../packages/backend/src/agents/codex/codex-desktop-app";
import { Commands } from "../../../packages/backend/src/commands";

afterEach(() => vi.restoreAllMocks());

describe("Codex desktop app", () => {
  it("links to a thread by its UUID only", () => {
    expect(codexThreadLink("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")).toBe(
      "codex://threads/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
    for (const value of ["", "thread", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/../x", "a b"])
      expect(() => codexThreadLink(value)).toThrow("not a Codex thread id");
  });

  it("finds the app's main process, not its helpers or other apps", () => {
    expect(
      codexDesktopListed(
        [
          "/usr/sbin/cfprefsd",
          "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
          "/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper (Renderer).app/Contents/MacOS/ChatGPT Helper (Renderer)",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(codexDesktopListed("/Users/me/Applications/Codex.app/Contents/MacOS/Codex  \n")).toBe(
      true,
    );
    expect(
      codexDesktopListed(
        [
          "/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper",
          "/usr/local/bin/codex",
          "/Applications/Safari.app/Contents/MacOS/Safari",
        ].join("\n"),
      ),
    ).toBe(false);
  });

  it.skipIf(!process.getuid).each([
    { version: "26.1120.50957", recheckedPid: 54, expected: { version: "26.1120.50957" } },
    { version: undefined, recheckedPid: 54, expected: {} },
    { version: "26.1120.50957", recheckedPid: 68, expected: undefined },
  ])(
    "reads a verified writer's bundle metadata ($version, $recheckedPid)",
    async ({ version, recheckedPid, expected }) => {
      const directory = mkdtempSync(join(tmpdir(), "ak-codex-writer-test-"));
      const lock = join(directory, "synthetic-thread.lock");
      writeFileSync(lock, "");
      const uid = process.getuid!();
      const { dev, ino } = statSync(lock, { bigint: true });
      const output = (text: string, success = true) => ({
        bytes: Buffer.from(text),
        success,
        truncated: false,
        error: "",
        exitCode: success ? 0 : 1,
      });
      const openFile = (pid: number, flags: string) =>
        [
          ["p" + pid, "u" + uid, "\n"].join("\0"),
          ["f4", "G" + flags + ";0x2", "D0x" + dev.toString(16), "i" + ino, "\n"].join("\0"),
        ].join("");
      vi.spyOn(CodexDesktopApp, "supported").mockReturnValue(true);
      const command = vi
        .spyOn(Commands.prototype, "run")
        .mockResolvedValueOnce(output(openFile(53, "0x2") + openFile(54, "0x4002")))
        .mockResolvedValueOnce(
          output(
            [
              "54 72 " + uid + " /fixture/Codex.app/Contents/Resources/codex",
              "72 1 " + uid + " /fixture/Codex.app/Contents/MacOS/Codex",
            ].join("\n"),
          ),
        )
        .mockResolvedValueOnce(output("com.openai.codex\n"))
        .mockResolvedValueOnce(output(version ?? "", version !== undefined))
        .mockResolvedValueOnce(output(openFile(recheckedPid, "0x4002")));
      const app = new CodexDesktopApp({ HOME: directory });
      try {
        expect(await app.writerOwner(lock)).toEqual(expected);
        expect(command.mock.calls[0]?.[1].at(-1)).toBe(lock);
        expect(command.mock.calls[2]?.[1].at(-1)).toBe("/fixture/Codex.app/Contents/Info.plist");
      } finally {
        app.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
