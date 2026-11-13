import { describe, expect, it } from "vitest";
import {
  codexDesktopListed,
  codexThreadLink,
} from "../../../packages/backend/src/codex-desktop-app";

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
});
