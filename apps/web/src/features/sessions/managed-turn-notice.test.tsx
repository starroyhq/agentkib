import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Live } from "@agentkib/web-client";
import {
  ManagedTurnNotice,
  retryText,
} from "../conversation/features/sessions/managed-turn-notice";
import { codexReason } from "../conversation/features/sessions/codex-copy";
import type { Locale } from "../conversation/i18n";

// Claude fixtures are hand-built after the frames CLI 2.1.311 sent to a local API stub; the Codex
// ones after the `error` notifications CLI 0.163.0 sent while a local stub answered 500 and 401.
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
const codexRejected = {
  attempt: 1,
  maxRetries: 2,
  status: 401,
  error: "responseStreamDisconnected",
  detail: "unexpected status 401 Unauthorized: invalid key, url: http://127.0.0.1:1/v1/responses",
};
const codexBusy = {
  attempt: 2,
  maxRetries: 2,
  status: null,
  error: "responseStreamDisconnected",
  detail: "We’re currently experiencing high demand, which may cause temporary errors.",
};

describe("managed turn notice", () => {
  afterEach(cleanup);

  it.each(locales)("says which attempt is running and why in %s", (locale) => {
    const auth = retryText(locale, rejected);
    expect(auth).toContain("Claude Code");
    expect(auth).toContain("3");
    expect(auth).toContain("10");
    expect(auth).toContain("HTTP 401");
    expect(auth).toMatch(/API (key|キー)/);
    // Either report is enough for the hint: the status alone, or the CLI's category alone.
    for (const partial of [
      { ...rejected, error: null },
      { ...rejected, status: null },
      { ...rejected, status: null, error: "unauthorized" },
    ])
      expect(retryText(locale, partial)).toMatch(/API (key|キー)/);
    const other = retryText(locale, overloaded);
    expect(other).toContain("HTTP 529");
    // Only a rejected login or key gets the authentication hint.
    expect(other.length).toBeLessThan(auth.length);
    expect(
      retryText(locale, { attempt: 2, maxRetries: null, status: null, error: null }),
    ).not.toContain("HTTP");
    expect(retryText(locale, codexRejected, "Codex")).toContain("Codex");
    expect(retryText(locale, codexRejected, "Codex")).not.toContain("Claude");
  });

  it("shows a retry while the turn runs", () => {
    render(<ManagedTurnNotice locale="en-US" live={live({ apiRetry: rejected })} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Claude Code's request failed and is being retried (attempt 3 of 10, HTTP 401).",
    );
  });

  it("shows a Codex retry with what Codex said failed", () => {
    const view = render(
      <ManagedTurnNotice
        locale="zh-CN"
        live={live({ executionMode: "codex-managed", apiRetry: codexRejected })}
      />,
    );
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(
      "Codex 的请求失败了，正在重试（第 1/2 次，HTTP 401）。认证被拒绝：检查 Codex 的登录或 API key，可以先停止本轮。",
    );
    expect(notice).toHaveTextContent(codexRejected.detail);
    view.rerender(
      <ManagedTurnNotice
        locale="en-US"
        live={live({ executionMode: "codex-managed", apiRetry: codexBusy })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Codex's request failed and is being retried (attempt 2 of 2).",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("Authentication");
  });

  it("shows the authentication failure of an idle session with the CLI's own text", () => {
    const reason = "claude-auth-failed: Not logged in · Please run /login; key source: none";
    render(
      <ManagedTurnNotice
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
      [live({ status: "idle", executionMode: "codex-managed", apiRetry: codexBusy })],
      [live({ executionMode: "claude-follower", apiRetry: rejected })],
      [live({ executionMode: "codex-follower", apiRetry: codexBusy })],
      [live({ status: "idle", reason: "claude-auth-failed: x" }), true],
      // The Claude authentication reason never belongs to a Codex session.
      [live({ status: "idle", executionMode: "codex-managed", reason: "claude-auth-failed: x" })],
    ];
    for (const [value, retriesOnly] of cases) {
      const view = render(
        <ManagedTurnNotice locale="en-US" live={value} retriesOnly={retriesOnly} />,
      );
      expect(view.container).toBeEmptyDOMElement();
      view.unmount();
    }
  });
});
