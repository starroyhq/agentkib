import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Live } from "@agentkib/web-client";
import {
  ClaudeTurnNotice,
  claudeRetryText,
} from "../conversation/features/sessions/claude-turn-notice";
import { codexReason } from "../conversation/features/sessions/codex-copy";
import type { Locale } from "../conversation/i18n";

// Live fixtures are hand-built after the frames CLI 2.1.311 sent to a local API stub.
const locales: Locale[] = ["zh-CN", "zh-TW", "en-US", "ja-JP"];
const live = (patch: Partial<Live>): Live =>
  ({
    sessionId: "s",
    status: "running",
    sendEnabled: false,
    approvals: [],
    executionMode: "claude-managed",
    ...patch,
  }) as Live;
const rejected = { attempt: 3, maxRetries: 10, status: 401, error: "authentication_failed" };
const overloaded = { attempt: 1, maxRetries: 10, status: 529, error: "server_error" };

describe("managed Claude turn notice", () => {
  afterEach(cleanup);

  it.each(locales)("says which attempt is running and why in %s", (locale) => {
    const auth = claudeRetryText(locale, rejected);
    expect(auth).toContain("3");
    expect(auth).toContain("10");
    expect(auth).toContain("HTTP 401");
    expect(auth).toMatch(/API (key|キー)/);
    // Either report is enough for the hint: the status alone, or the CLI's category alone.
    for (const partial of [
      { ...rejected, error: null },
      { ...rejected, status: null },
    ])
      expect(claudeRetryText(locale, partial)).toMatch(/API (key|キー)/);
    const other = claudeRetryText(locale, overloaded);
    expect(other).toContain("HTTP 529");
    // Only a rejected login or key gets the authentication hint.
    expect(other.length).toBeLessThan(auth.length);
    expect(
      claudeRetryText(locale, { attempt: 2, maxRetries: null, status: null, error: null }),
    ).not.toContain("HTTP");
  });

  it("shows a retry while the turn runs", () => {
    render(<ClaudeTurnNotice locale="en-US" live={live({ apiRetry: rejected })} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Claude Code's request failed and is being retried (attempt 3 of 10, HTTP 401).",
    );
  });

  it("shows the authentication failure of an idle session with the CLI's own text", () => {
    const reason = "claude-auth-failed: Not logged in · Please run /login; key source: none";
    render(
      <ClaudeTurnNotice
        locale="zh-CN"
        surface="web"
        live={live({ status: "idle", sendEnabled: true, reason, apiRetry: null })}
      />,
    );
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(codexReason("zh-CN", reason, "web").text);
    expect(notice).toHaveTextContent("Not logged in · Please run /login; key source: none");
  });

  it("stays out of the way otherwise", () => {
    const cases: Array<[Live | undefined, boolean?]> = [
      [undefined],
      [live({})],
      [live({ status: "idle", reason: "claude-background-task: x" })],
      // A stale retry after the turn ended is not shown.
      [live({ status: "idle", apiRetry: rejected })],
      [live({ executionMode: "claude-follower", apiRetry: rejected })],
      [live({ status: "idle", reason: "claude-auth-failed: x" }), true],
    ];
    for (const [value, retriesOnly] of cases) {
      const view = render(
        <ClaudeTurnNotice locale="en-US" live={value} retriesOnly={retriesOnly} />,
      );
      expect(view.container).toBeEmptyDOMElement();
      view.unmount();
    }
  });
});
