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

  it.each(["com.openai.codex", "com.openai.chat"])(
    "reports only a running Codex bundle's version (%s)",
    async (bundle) => {
      const output = (text: string) => ({
        bytes: Buffer.from(text),
        success: true,
        truncated: false,
        error: "",
        exitCode: 0,
      });
      vi.spyOn(CodexDesktopApp, "supported").mockReturnValue(true);
      const command = vi
        .spyOn(Commands.prototype, "run")
        .mockResolvedValueOnce(output("/fixture/ChatGPT.app/Contents/MacOS/ChatGPT\n"))
        .mockResolvedValueOnce(output(`${bundle}\n26.1120.50957\n`));
      const app = new CodexDesktopApp({ HOME: "/fixture" });
      try {
        expect(await app.running()).toBe(true);
        const version = bundle === "com.openai.codex" ? "26.1120.50957" : undefined;
        expect(await Promise.all([app.version(), app.version()])).toEqual([version, version]);
        expect(command.mock.calls.map(([program]) => program)).toEqual([
          "/bin/ps",
          "/usr/libexec/PlistBuddy",
        ]);
        expect(command.mock.calls[1]?.[1].at(-1)).toBe("/fixture/ChatGPT.app/Contents/Info.plist");
      } finally {
        app.close();
      }
    },
  );
});
