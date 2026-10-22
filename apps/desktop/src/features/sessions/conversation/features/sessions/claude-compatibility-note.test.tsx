// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCompatibilityNote } from "./claude-compatibility-note";
import { claudeConnectionCopy } from "./claude-connection-copy";

afterEach(cleanup);

describe("native terminal compatibility note", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "renders an observed unverified version as neutral copy in %s",
    (locale) => {
      render(
        <ClaudeCompatibilityNote
          locale={locale}
          compatibility={{ cliVersion: "2.1.307", status: "unverified" }}
        />,
      );
      const note = screen.getByText(
        claudeConnectionCopy[locale].unverifiedVersion.replace("{version}", "2.1.307"),
      );
      expect(note).toHaveClass("text-muted-foreground");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
    },
  );

  it.each([
    undefined,
    null,
    { cliVersion: "2.1.301", status: "verified" as const },
    { cliVersion: "2.1.300", status: "unverified" as const },
    { cliVersion: "/private/diagnostic", status: "unverified" as const },
  ])("does not turn %j into an unverified connection", (compatibility) => {
    const { container } = render(
      <ClaudeCompatibilityNote locale="zh-CN" compatibility={compatibility} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
