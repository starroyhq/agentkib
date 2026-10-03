// @vitest-environment node
import { describe, expect, it } from "vitest";
import { markdownLinkTargets } from "./markdown-links";

describe("markdownLinkTargets", () => {
  it("extracts link and image targets, with optional titles and angle brackets", () => {
    expect(
      markdownLinkTargets(
        [
          "See [report](out/report.md) and ![chart](out/chart.png).",
          "Titled [a](docs/a.md \"Doc A\") and [b](docs/b.md 'Doc B').",
          "Spaces [c](<out/with space.txt>).",
        ].join("\n"),
      ),
    ).toEqual(["out/report.md", "out/chart.png", "docs/a.md", "docs/b.md", "out/with space.txt"]);
  });

  it("keeps one level of balanced parentheses inside the target", () => {
    expect(markdownLinkTargets("[copy](out/report(1).pdf)")).toEqual(["out/report(1).pdf"]);
  });

  it("ignores links inside fenced and inline code", () => {
    const content = [
      "Real [file](real.txt).",
      "```md",
      "[example](fenced.txt)",
      "```",
      "~~~",
      "[tilde](tilde.txt)",
      "~~~",
      "Inline `[code](inline.txt)` stays code.",
    ].join("\n");
    expect(markdownLinkTargets(content)).toEqual(["real.txt"]);
  });

  it("treats an unclosed fence as code until the end", () => {
    expect(markdownLinkTargets("[a](a.txt)\n```\n[b](b.txt)")).toEqual(["a.txt"]);
  });

  it("returns nothing for plain text or malformed links", () => {
    expect(markdownLinkTargets("no links here [broken](")).toEqual([]);
  });
});
