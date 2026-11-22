import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import type { Live } from "@agentkib/web-client";
import {
  ManagedTurnNotice,
  retryText,
} from "../conversation/features/sessions/managed-turn-notice";
import { codexReason } from "../conversation/codex-copy";
import type { Locale } from "../conversation/i18n";
import { usageLimitNotice } from "@agentkib/session-ui";

// Claude fixtures are hand-built after the frames CLI 2.1.311 sent to a local API stub; the Codex
// ones after the `error` notifications CLI 0.163.0 sent while a local stub answered 500 and 401.
const locales: Locale[] = ["zh-CN", "zh-Hant", "en-US", "ja-JP"];
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

describe("usage limit notice", () => {
  afterEach(cleanup);
  // The reset at 15:30 local time on a fixed day, read in the test's own time zone.
  const now = new Date(2026, 10, 16, 12, 0).getTime();
  // The notices read the clock: hold it at `now`, or a reset that has passed changes them.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());
  const resetsAt = new Date(2026, 10, 16, 15, 30).getTime();
  const limit = (patch: Partial<NonNullable<Live["usageLimit"]>> = {}) =>
    ({
      agent: "claude-code",
      resetsAt,
      kind: "five-hour",
      scope: null,
      message: "You've hit your 5-hour limit · resets 3:30pm",
      continueAt: resetsAt + 60_000,
      manual: null,
      autoContinues: 0,
      ...patch,
    }) as NonNullable<Live["usageLimit"]>;

  it("says which limit, when it resets and that AgentKib continues, in every locale", () => {
    const texts = locales.map((locale) => usageLimitNotice(locale, limit(), now));
    expect(texts.every((text) => text?.cancel && text.text.length > 0)).toBe(true);
    expect(usageLimitNotice("zh-CN", limit(), now)).toEqual({
      text: "已达到 5 小时使用上限，15:30 重置，重置后自动继续。",
      cancel: "不自动继续",
      arm: null,
    });
    expect(usageLimitNotice("en-US", limit(), now)?.text).toBe(
      "You've hit your 5-hour limit · resets 3:30 PM · continues automatically after the reset.",
    );
    // Another day carries the date.
    expect(
      usageLimitNotice(
        "zh-CN",
        limit({
          kind: "weekly",
          resetsAt: resetsAt + 3 * 86_400_000,
          continueAt: null,
          manual: "reset-too-far",
        }),
        now,
      )?.text,
    ).toBe("已达到每周使用上限，11月19日 15:30 重置。重置后发送消息即可继续。");
  });

  it("follows each agent's own words when nothing is armed", () => {
    // Codex gives no reset time with its error: its desktop app's "请稍后再试".
    expect(
      usageLimitNotice(
        "zh-CN",
        limit({
          agent: "codex",
          kind: null,
          resetsAt: null,
          continueAt: null,
          manual: "reset-unknown",
        }),
        now,
      )?.text,
    ).toBe("你已达到使用上限。请稍后再试。");
    // DeepSeek Harness's own text for a used-up balance.
    expect(
      usageLimitNotice(
        "ja-JP",
        limit({
          agent: "deepseek-harness",
          kind: "quota",
          resetsAt: null,
          continueAt: null,
          manual: "reset-unknown",
        }),
        now,
      )?.text,
    ).toBe("リクエストのクォータを使い切りました。");
    expect(
      usageLimitNotice("zh-Hant", limit({ continueAt: null, manual: "repeated" }), now)?.text,
    ).toBe("已達到 5 小時使用上限，15:30 重置。連續多次達到上限，已停止自動繼續。");
    // Past the reset, or woken long after it: the person continues.
    expect(usageLimitNotice("zh-CN", limit({ continueAt: null, manual: "stale" }), now)?.text).toBe(
      "使用上限已重置，发送消息即可继续。",
    );
    // While AgentKib's continue is on its way there is nothing to say.
    expect(usageLimitNotice("zh-CN", limit({ continueAt: null, manual: null }), now)).toBeNull();
  });

  it("offers to arm the continue only where the host can", () => {
    // Switched off on this computer: the reset is known, so the notice offers the continue.
    expect(usageLimitNotice("zh-CN", limit({ continueAt: null, manual: "off" }), now)).toEqual({
      text: "已达到 5 小时使用上限，15:30 重置。重置后发送消息即可继续。",
      cancel: null,
      arm: "重置后自动继续",
    });
    expect(
      usageLimitNotice("zh-Hant", limit({ continueAt: null, manual: "cancelled" }), now)?.arm,
    ).toBe("重置後自動繼續");
    expect(
      usageLimitNotice("ja-JP", limit({ continueAt: null, manual: "repeated" }), now)?.arm,
    ).toBe("リセット後に自動で続行");
    expect(
      usageLimitNotice("en-US", limit({ continueAt: null, manual: "restarted" }), now)?.arm,
    ).toBe("Continue automatically after the reset");
    // Nothing to arm: already armed, no reset time, an agent without one, or the reset has passed.
    expect(usageLimitNotice("en-US", limit(), now)?.arm).toBeNull();
    expect(
      usageLimitNotice("en-US", limit({ continueAt: null, manual: "off", resetsAt: null }), now)
        ?.arm,
    ).toBeNull();
    expect(
      usageLimitNotice("en-US", limit({ continueAt: null, manual: "reset-unknown" }), now)?.arm,
    ).toBeNull();
    expect(
      usageLimitNotice("en-US", limit({ continueAt: null, manual: "off", resetsAt: now - 1 }), now)
        ?.arm,
    ).toBeNull();
  });

  it("arms the continue from the notice", () => {
    let armed = 0;
    render(
      <ManagedTurnNotice
        live={live({
          status: "idle",
          usageLimit: limit({ continueAt: null, manual: "off" }),
          executionMode: undefined,
        })}
        locale="en-US"
        onUsageLimitArm={() => armed++}
      />,
    );
    expect(screen.queryByRole("button", { name: "Don't continue automatically" })).toBeNull();
    screen.getByRole("button", { name: "Continue automatically after the reset" }).click();
    expect(armed).toBe(1);
  });

  it("shows on an idle session of any agent, with the button only where it can act", () => {
    let cancelled = 0;
    const { rerender } = render(
      <ManagedTurnNotice
        live={live({ status: "idle", usageLimit: limit(), executionMode: undefined })}
        locale="en-US"
        onUsageLimitCancel={() => cancelled++}
      />,
    );
    screen.getByRole("button", { name: "Don't continue automatically" }).click();
    expect(cancelled).toBe(1);
    rerender(
      <ManagedTurnNotice live={live({ status: "idle", usageLimit: limit() })} locale="en-US" />,
    );
    expect(screen.getByRole("status").textContent).toContain("5-hour limit");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
