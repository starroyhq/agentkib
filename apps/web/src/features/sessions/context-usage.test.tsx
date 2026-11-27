import { createRef } from "react";
import userEvent from "@testing-library/user-event";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextUsage } from "@agentkib/web-client";
import { ContextUsageGauge } from "@/features/conversation/context-usage";
import { useSession } from "@/features/conversation/web-session-context";
import { contextUsageCopy } from "@agentkib/session-ui";
import { sessionCopy } from "@/features/conversation/session-copy";
import type { Locale } from "@/features/conversation/i18n";

vi.mock("@/features/conversation/web-session-context", () => ({
  useSession: vi.fn(),
}));
let state: ReturnType<typeof useSession>;
const report = (usedTokens = 20, reportId = 1, reportGeneration?: number): ContextUsage => ({
  available: true,
  state: "ready",
  reportId,
  ...(reportGeneration !== undefined ? { reportGeneration } : {}),
  usedTokens,
  contextWindow: 100,
});
beforeEach(() => {
  state = {
    selected: "s",
    locale: "zh-CN",
    online: true,
    access: {
      status: "approved",
      bootId: "boot",
      device: { id: "device", accessMode: "full", advancedControl: true },
    },
    client: {},
    live: { sessionId: "s", status: "idle", revision: 1, usage: report(), approvals: [] },
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => ({ ...state }));
});
afterEach(cleanup);
const gauge = () =>
  screen.getByRole("img", { name: sessionCopy[state.locale].contextUsage, hidden: true });
const preview = async () => {
  await userEvent.setup().hover(gauge());
  await screen.findByRole("tooltip");
};
const description = (part: string) => expect.stringContaining(part);
const unmanagedClaude = () => {
  state.current = { id: "s", agent: "claude-code" } as typeof state.current;
  state.live = {
    ...state.live!,
    executionMode: "claude-managed",
    executionLocation: null,
    reason: undefined,
    usage: undefined,
  };
};

it("retains the last DSH context reading across reconnect and then shows the updated report", () => {
  state.current = { id: "s", agent: "deepseek-harness" } as typeof state.current;
  state.live = {
    ...state.live!,
    executionMode: "dsh-follower",
    usage: { ...report(27), state: "stale", historical: true },
  };
  const view = render(<ContextUsageGauge />);
  expect(gauge()).toHaveAccessibleDescription(description("27%"));
  expect(gauge()).not.toHaveAccessibleDescription(description("上次读数"));
  state.live = { ...state.live!, usage: report(41) };
  view.rerender(<ContextUsageGauge />);
  expect(gauge()).toHaveAccessibleDescription(description("41%"));
  expect(gauge()).not.toHaveAccessibleDescription(description("上次读数"));
});

it.each(["claude-code", "devin"] as const)(
  "draws historical %s occupancy with its exact fraction and token counts",
  async (agent) => {
    const usage: ContextUsage = {
      available: true,
      state: "stale",
      historical: true,
      usedTokens: 24_606,
      contextWindow: 1_000_000,
      ...(agent === "claude-code" ? { reason: "claude-post-compaction-current-window" } : {}),
    };
    state.current = { id: "s", agent } as typeof state.current;
    state.live = {
      ...state.live!,
      executionMode: agent === "devin" ? "devin-print" : "claude-follower",
      usage: agent === "devin" ? state.live!.usage : usage,
    };
    render(<ContextUsageGauge fallback={agent === "devin" ? usage : undefined} />);
    const arc = gauge().querySelector("circle[pathLength='100']");
    expect(arc).toHaveAttribute("stroke-dasharray", "2.4606 100");
    expect(arc).toHaveAttribute("opacity", "1");
    await preview();
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).not.toHaveTextContent("上次读数");
    expect(tooltip).toHaveTextContent("已使用 2%（剩余 98%）");
    expect(tooltip).toHaveTextContent("已使用 24,606 / 1,000,000 Token");
    expect(tooltip).not.toHaveTextContent("压缩完成时的用量");
  },
);

describe("Claude context usage before its first continued turn", () => {
  it("shows saved native tokens without inventing a window or showing explanatory prose", async () => {
    unmanagedClaude();
    state.canSend = false;
    state.live = {
      ...state.live!,
      executionLocation: "external",
      ownershipReason: "claude-owner-busy",
      usage: {
        available: true,
        state: "stale",
        historical: true,
        usedTokens: 892756,
        reason: "model-context-window-unavailable",
      },
    };
    render(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(/^$/);
    expect(gauge()).toHaveAccessibleDescription(/892,756/);
    await preview();
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent(contextUsageCopy["zh-CN"].windowTitle);
    expect(tooltip).toHaveTextContent("已使用 892,756 Token");
    expect(tooltip).not.toHaveTextContent("原生接口未上报当前模型的上下文窗口");
    expect(tooltip).not.toHaveTextContent("上次读数");
    expect(tooltip).not.toHaveTextContent("%");
    expect(tooltip).not.toHaveTextContent("1,000,000");
  });

  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as Locale[])(
    "shows a dash for missing CLI report in %s without inventing usage",
    async (locale) => {
      unmanagedClaude();
      state.locale = locale;
      render(<ContextUsageGauge />);
      expect(gauge()).toHaveAccessibleDescription("—");
      expect(gauge()).not.toHaveAccessibleDescription(description("0%"));
      await preview();
      expect(screen.getByRole("tooltip")).toHaveTextContent("—");
      expect(screen.getByRole("tooltip")).not.toHaveTextContent("%");
    },
  );

  it("shows the last verified native report through pending or missing updates", () => {
    unmanagedClaude();
    state.live = { ...state.live!, usage: report(0) };
    const view = render(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("0%"));
    for (const nextState of ["pending", "stale", "unavailable"] as const) {
      state.live = {
        ...state.live!,
        usage: { available: false, state: nextState },
      };
      view.rerender(<ContextUsageGauge />);
      expect(gauge()).toHaveAccessibleDescription(description("0%"));
      expect(gauge()).not.toHaveAccessibleDescription("—");
    }
  });

  it("shows dash when offline or when authorization is revoked", async () => {
    unmanagedClaude();
    const view = render(<ContextUsageGauge />);
    await preview();
    state.online = false;
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription("—");
    expect(screen.getByRole("tooltip")).toHaveTextContent("—");
    state.access = {
      ...state.access!,
      device: { ...state.access!.device!, advancedControl: false },
    };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription("—");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await preview();
    expect(screen.getByRole("tooltip")).toHaveTextContent("—");
  });

  it("shows a reported window without estimating a count or percentage", async () => {
    state.live = {
      ...state.live!,
      usage: { available: true, state: "pending", contextWindow: 123456 },
    };
    render(<ContextUsageGauge />);
    await preview();
    const details = screen.getByRole("tooltip");
    expect(details).toHaveTextContent("123,456");
    expect(details).not.toHaveTextContent("%");
  });

  it("shows the precise post-compaction report and a separate current model limit", async () => {
    state.live = {
      ...state.live!,
      usage: {
        available: true,
        historical: true,
        state: "stale",
        usedTokens: 24606,
        reason: "claude-post-compaction-usage",
      },
    };
    render(<ContextUsageGauge capacity={1000000} />);
    expect(gauge()).toHaveTextContent(/^$/);
    expect(gauge()).toHaveAccessibleDescription(/24,606/);
    await preview();
    const details = screen.getByRole("tooltip");
    expect(details).not.toHaveTextContent("压缩完成时的用量");
    expect(details).not.toHaveTextContent("上次读数");
    expect(details).toHaveTextContent("24,606");
    expect(details).toHaveTextContent("1,000,000");
    expect(details).not.toHaveTextContent("%");
  });

  it.each(["settings", "live"])(
    "restores only a verified new transcript count via %s after each compaction",
    (source) => {
      unmanagedClaude();
      const start = (time: number) => {
        state.live = {
          ...state.live!,
          executionMode: "claude-follower",
          activity: "compacting",
          usage: {
            available: true,
            state: "pending",
            reason: "session-compacting",
            updatedAt: new Date(time).toISOString(),
          },
        };
      };
      const history = (time: number, usedTokens: number): ContextUsage => ({
        available: true,
        historical: true,
        state: "stale",
        usedTokens,
        updatedAt: new Date(time).toISOString(),
        reason: "claude-post-compaction-usage",
      });
      start(100);
      const view = render(<ContextUsageGauge />);
      const poll = (count: ContextUsage) => {
        state.live = {
          ...state.live!,
          activity: null,
          usage:
            source === "live"
              ? count
              : { available: true, state: "pending", reason: "usage-not-reported" },
        };
        view.rerender(<ContextUsageGauge fallback={source === "settings" ? count : undefined} />);
      };
      poll(history(50, 15555));
      expect(gauge()).toHaveTextContent(/^$/);
      expect(gauge()).not.toHaveAccessibleDescription(/15,555/);
      poll(history(101, 24606));
      expect(gauge()).toHaveAccessibleDescription(/24,606/);
      start(200);
      view.rerender(<ContextUsageGauge />);
      poll(history(101, 24606));
      expect(gauge()).not.toHaveAccessibleDescription(/24,606/);
      poll(history(210, 12345));
      expect(gauge()).toHaveAccessibleDescription(/12,345/);
      state.access = { ...state.access!, status: "ended" };
      view.rerender(<ContextUsageGauge />);
      expect(gauge()).not.toHaveAccessibleDescription(/12,345/);
    },
  );

  it("drops cached usage when access ends before the device grant disappears", () => {
    const view = render(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("%"));
    state.access = { ...state.access!, status: "ended" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).not.toHaveAccessibleDescription(description("%"));
    expect(gauge()).toHaveAccessibleDescription("—");
  });

  it("shows known context capacity without explanatory error prose when usage is unavailable", async () => {
    unmanagedClaude();
    state.live = {
      ...state.live!,
      usage: { available: false, state: "unavailable", reason: "invalid-usage" },
    };
    render(<ContextUsageGauge capacity={100_000} />);
    expect(gauge()).toHaveAccessibleDescription(description("100,000"));
    await preview();
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("100,000");
    expect(tooltip).not.toHaveTextContent(/无法解析|上次读数/);
  });

  it("does not carry a reading to another selected session or stale live identity", () => {
    unmanagedClaude();
    state.live = { ...state.live!, usage: { ...report(42), historical: true } };
    const view = render(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("42%"));
    state.selected = "other";
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription("—");
    state.current = { ...state.current!, id: "other" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription("—");
  });

  it("uses the same empty label for another agent or a running worker without a report", () => {
    unmanagedClaude();
    state.current = { ...state.current!, agent: "codex" };
    const view = render(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription("—");
    state.current = { ...state.current!, agent: "claude-code" };
    state.live = {
      ...state.live!,
      status: "running",
      executionLocation: "agentkib",
      reason: undefined,
    };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription("—");
  });
});

describe("native context usage", () => {
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "shows numeric usage from a historical Codex report in %s",
    async (locale) => {
      state.locale = locale;
      state.live = { ...state.live!, usage: { available: true, state: "stale" } };
      const updatedAt = "2026-10-02T14:00:00Z";
      render(
        <ContextUsageGauge
          fallback={{ ...report(29), state: "stale", historical: true, updatedAt }}
        />,
      );
      const copy = contextUsageCopy[locale];
      const proportions = copy.usedRemaining.replace("{used}", "29").replace("{remaining}", "71");
      const tokens = copy.tokenUsage.replace("{used}", "29").replace("{total}", "100");
      expect(gauge()).toHaveAccessibleDescription(`${proportions} ${tokens}`);
      await preview();
      const tooltip = screen.getByRole("tooltip");
      expect(tooltip).not.toHaveTextContent(/上次读数|上次讀數|Last reading|前回の読み取り/);
      expect(tooltip).toHaveTextContent(proportions);
      expect(tooltip).toHaveTextContent(tokens);
      expect(tooltip.querySelector("time")).toBeNull();
      expect(tooltip.querySelector('[role="status"]')).toBeNull();
    },
  );

  it("keeps historical usage out of compaction, newer native reports and restricted access", () => {
    const fallback: ContextUsage = { ...report(29), state: "stale", historical: true };
    state.live = { ...state.live!, usage: { available: true, state: "stale" } };
    const view = render(<ContextUsageGauge fallback={fallback} />);
    expect(gauge()).toHaveAccessibleDescription(description("29%"));
    state.live = { ...state.live!, activity: "compacting" };
    view.rerender(<ContextUsageGauge fallback={fallback} />);
    expect(gauge()).toHaveAccessibleDescription(description(contextUsageCopy["zh-CN"].compacting));
    expect(gauge()).not.toHaveAccessibleDescription(description("29%"));
    state.live = { ...state.live!, activity: null, usage: report(40, 2, 1) };
    view.rerender(<ContextUsageGauge fallback={fallback} />);
    expect(gauge()).toHaveAccessibleDescription(description("40%"));
    state.live = {
      ...state.live!,
      usage: { available: false, state: "unavailable", reportGeneration: 1, reportId: 3 },
    };
    view.rerender(<ContextUsageGauge fallback={fallback} />);
    expect(gauge()).not.toHaveAccessibleDescription(description("29%"));
    state.access = {
      ...state.access!,
      device: { ...state.access!.device!, advancedControl: false },
    };
    view.rerender(<ContextUsageGauge fallback={fallback} />);
    expect(gauge()).toHaveAccessibleDescription("—");
  });

  it("renders valid zero without settings and opens the reported numerator and window", async () => {
    state.live = { ...state.live!, usage: report(0) };
    render(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("0%"));
    await preview();
    expect(screen.getByRole("tooltip")).toHaveTextContent("已使用 0 / 100 Token");
    expect(screen.getByRole("tooltip")).toHaveTextContent("已使用 0%（剩余 100%）");
  });

  it("exposes exact token counts in the anchored details and accessible description for a rounded percentage", async () => {
    state.live = { ...state.live!, usage: { ...report(24606), contextWindow: 1000000 } };
    render(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("2%"));
    expect(gauge()).toHaveAccessibleDescription(/24,606 \/ 1,000,000/);
    await preview();
    expect(screen.getByRole("tooltip")).toHaveTextContent("已使用 24,606 / 1,000,000 Token");
  });

  it("keeps native reports ahead of late settings and rejects an older report even with a newer control revision", () => {
    const view = render(<ContextUsageGauge fallback={report(80)} />);
    expect(gauge()).toHaveAccessibleDescription(description("20%"));
    state.live = { ...state.live!, revision: 2, usage: report(30, 2) };
    view.rerender(<ContextUsageGauge fallback={report(90)} />);
    expect(gauge()).toHaveAccessibleDescription(description("30%"));
    state.live = { ...state.live!, revision: 10, usage: report(10, 1) };
    view.rerender(<ContextUsageGauge fallback={report(95)} />);
    expect(gauge()).toHaveAccessibleDescription(description("30%"));
    state.live = { ...state.live!, usage: { available: false, state: "unavailable", reportId: 3 } };
    view.rerender(<ContextUsageGauge fallback={report(95)} />);
    expect(gauge()).toHaveAccessibleDescription("—");
  });

  it("resets report generations on session and runtime changes and ignores the preceding live object", () => {
    state.live = { ...state.live!, usage: report(80, 50) };
    const view = render(<ContextUsageGauge />);
    state = { ...state, selected: "next" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).not.toHaveAccessibleDescription(description("80%"));
    state.live = { ...state.live!, sessionId: "next", usage: report(10, 1) };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("10%"));
    state.access = { ...state.access!, bootId: "new-boot" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).not.toHaveAccessibleDescription(description("10%"));
    state.live = { ...state.live!, usage: report(5, 0) };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("5%"));
  });

  it("hides usage immediately when the existing observation authorization is revoked", async () => {
    const view = render(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("20%"));
    await preview();
    expect(screen.getByRole("tooltip")).toHaveTextContent("20 / 100");
    state.access = {
      ...state.access!,
      device: { ...state.access!.device!, advancedControl: false },
    };
    view.rerender(<ContextUsageGauge />);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(gauge()).not.toHaveAccessibleDescription(/20%|20 \/ 100/);
    expect(gauge()).not.toHaveAccessibleDescription(description("20%"));
    await preview();
    expect(screen.getByRole("tooltip")).toHaveTextContent("—");
    expect(screen.getByRole("tooltip")).not.toHaveTextContent(/20%|20 \/ 100/);
  });

  it("keeps a scoped count across executor changes until the terminal reports its own count", () => {
    unmanagedClaude();
    state.live = { ...state.live!, usage: report(42) };
    const view = render(<ContextUsageGauge />);
    state.live = {
      ...state.live!,
      executionMode: "claude-follower",
      executionLocation: "terminal",
      usage: { available: false, state: "unavailable", reason: "usage-unavailable" },
    };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("42%"));
    state.live = { ...state.live, usage: { available: true, state: "ready", usedTokens: 70 } };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("70"));
    expect(gauge()).not.toHaveAccessibleDescription(description("%"));
    state.live = { ...state.live, activity: "compacting" };
    view.rerender(<ContextUsageGauge />);
    state.live = {
      ...state.live,
      executionMode: "claude-managed",
      activity: null,
      usage: { available: false, state: "unavailable" },
    };
    view.rerender(<ContextUsageGauge fallback={{ ...report(42), historical: true }} />);
    expect(gauge()).not.toHaveAccessibleDescription(description("42%"));
    expect(gauge()).not.toHaveAccessibleDescription(description("70"));
  });

  it("accepts a reset report ID only after a new native stream epoch", () => {
    state.usageEpoch = "native-1";
    state.live = { ...state.live!, usage: report(80, 50) };
    const view = render(<ContextUsageGauge />);
    state = { ...state, usageEpoch: "native-2", live: { ...state.live!, usage: report(5, 1) } };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("5%"));
    state.live = { ...state.live!, usage: report(99, 0) };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("5%"));
  });

  it("accepts a rebuilt observer's lower report ID without changing its transport epoch", () => {
    state.usageEpoch = "retained-stream";
    state.live = { ...state.live!, usage: report(80, 2, 1) };
    const view = render(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("80%"));
    state.live = { ...state.live!, usage: { ...report(80, 2, 1), state: "stale" } };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("80%"));
    state.live = { ...state.live!, usage: { ...report(80, 0, 2), state: "stale" } };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("80%"));
    state.live = { ...state.live!, usage: report(5, 1, 2) };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("5%"));
  });

  it("rejects late older observers and legacy reports after accepting a tagged generation", () => {
    state.live = { ...state.live!, usage: report(5, 1, 2) };
    const view = render(<ContextUsageGauge />);
    state.live = { ...state.live!, usage: report(80, 100, 1), activity: "compacting" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("5%"));
    state.live = { ...state.live!, usage: report(90, 200), activity: "compacting" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("5%"));
  });

  it("keeps same-generation report ordering and accepts state changes at the same ID", () => {
    state.live = { ...state.live!, usage: report(30, 2, 1) };
    const view = render(<ContextUsageGauge />);
    state.live = { ...state.live!, usage: report(10, 1, 1), activity: "compacting" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("30%"));
    state.live = {
      ...state.live!,
      usage: { ...report(30, 2, 1), state: "stale" },
      activity: null,
    };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("30%"));
    state.live = { ...state.live!, usage: { ...report(30, 2, 1), state: "pending" } };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).not.toHaveAccessibleDescription(/%/);
    expect(gauge()).not.toHaveAccessibleDescription(description("30"));
    expect(gauge()).not.toHaveAccessibleDescription(/30|%/);
    expect(gauge()).toHaveAccessibleDescription("—");
    state.live = { ...state.live!, usage: report(30, 2, 1) };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("30%"));
  });

  it("discards the old observer's compaction barrier when a new generation takes over", () => {
    state.live = { ...state.live!, usage: report(80, 50, 1), activity: "compacting" };
    const view = render(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description(contextUsageCopy["zh-CN"].compacting));
    state.live = { ...state.live!, usage: report(5, 1, 2), activity: null };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("5%"));
    state.live = { ...state.live!, usage: report(90, 51, 1), activity: "compacting" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("5%"));
  });

  it("establishes the new observer's barrier and ignores late old compaction completions", () => {
    state.live = { ...state.live!, usage: report(80, 50, 1), activity: "compacting" };
    const view = render(<ContextUsageGauge />);
    state.live = {
      ...state.live!,
      usage: { ...report(20, 0, 2), state: "pending" },
      activity: "compacting",
    };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description(contextUsageCopy["zh-CN"].compacting));
    state.live = { ...state.live!, usage: report(90, 51, 1), activity: null };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description(contextUsageCopy["zh-CN"].compacting));
    state.live = {
      ...state.live!,
      usage: { ...report(20, 0, 2), state: "stale" },
      activity: null,
    };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("20%"));
    state.live = { ...state.live!, usage: report(90, 52, 1) };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("20%"));
    state.live = { ...state.live!, usage: report(5, 1, 2) };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("5%"));
  });

  it("accepts an unreported new generation instead of retaining the old percentage", async () => {
    state.live = { ...state.live!, usage: report(80, 2, 1) };
    const view = render(<ContextUsageGauge />);
    state.live = {
      ...state.live!,
      usage: { available: false, state: "pending", reportGeneration: 2, reportId: 0 },
    };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription("—");
    await preview();
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("80%");
  });

  it("allows lower generation numbers after a backend boot change", () => {
    state.live = { ...state.live!, usage: report(80, 2, 50) };
    const view = render(<ContextUsageGauge />);
    state = {
      ...state,
      access: { ...state.access!, bootId: "new-boot" },
      live: { ...state.live!, usage: report(5, 1, 1) },
    };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("5%"));
  });

  it("keeps the previous report stale after compaction ends until a new report arrives", () => {
    const view = render(<ContextUsageGauge />);
    state.live = { ...state.live!, activity: "compacting" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description(contextUsageCopy["zh-CN"].compacting));
    state.live = { ...state.live!, activity: null, revision: 2 };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("20%"));
    state.live = { ...state.live!, usage: report(5, 2) };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("5%"));
    state.online = false;
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description("5%"));
  });

  it("handles pending report without a window across offline, permission and compaction transitions", async () => {
    state.live = {
      ...state.live!,
      usage: {
        available: false,
        state: "pending",
        reason: "usage-model-window-unavailable",
        usedTokens: 4,
      },
    };
    const view = render(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription("—");
    state.online = false;
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription("—");
    await preview();
    expect(screen.getByRole("tooltip")).toHaveTextContent("—");
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("%");

    state.access = {
      ...state.access!,
      device: { ...state.access!.device!, advancedControl: false },
    };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription("—");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await preview();
    expect(screen.getByRole("tooltip")).toHaveTextContent("—");

    state.access = {
      ...state.access!,
      device: { ...state.access!.device!, advancedControl: true },
    };
    state.live = { ...state.live!, activity: "compacting" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveAccessibleDescription(description(contextUsageCopy["zh-CN"].compacting));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await preview();
    expect(screen.getByRole("tooltip")).toHaveTextContent(contextUsageCopy["zh-CN"].compacting);
  });

  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as Locale[])(
    "localizes pending, stale and unavailable in %s without a bare question mark",
    async (locale) => {
      state.locale = locale;
      state.live = {
        ...state.live!,
        usage: {
          available: false,
          state: "pending",
          reason: "usage-model-window-unavailable",
          usedTokens: 4,
        },
      };
      const view = render(<ContextUsageGauge />);
      expect(gauge()).toHaveAccessibleDescription("—");
      expect(gauge()).not.toHaveAccessibleDescription(description("?"));
      await preview();
      expect(screen.getByRole("tooltip")).toHaveTextContent("—");
      state.live = {
        ...state.live!,
        usage: { ...report(), state: "stale", reason: "usage-after-compaction-unconfirmed" },
      };
      view.rerender(<ContextUsageGauge />);
      expect(gauge()).toHaveAccessibleDescription(description("20%"));
      const tooltip = screen.getByRole("tooltip");
      expect(tooltip).toHaveTextContent(
        contextUsageCopy[locale].usedRemaining.replace("{used}", "20").replace("{remaining}", "80"),
      );
      expect(tooltip).toHaveTextContent(
        contextUsageCopy[locale].tokenUsage.replace("{used}", "20").replace("{total}", "100"),
      );
      expect(tooltip.querySelector('[role="status"]')).toBeNull();
      state.live = { ...state.live!, usage: { available: false, state: "unavailable" } };
      view.rerender(<ContextUsageGauge />);
      expect(gauge()).toHaveAccessibleDescription(description("20%"));
      state.live = {
        ...state.live,
        usage: { available: false, state: "unavailable", reportId: 2 },
      };
      view.rerender(<ContextUsageGauge />);
      expect(gauge()).toHaveAccessibleDescription("—");
    },
  );
});

it.each(["touch", "shortcut"] as const)(
  "opens the same read-only tooltip by %s",
  async (method) => {
    const usageRef = createRef<{ open(): void }>();
    state.control = vi.fn();
    state.runSessionAction = vi.fn();
    render(<ContextUsageGauge usageRef={usageRef} />);
    if (method === "shortcut") {
      act(() => usageRef.current!.open());
    } else {
      await userEvent
        .setup()
        .pointer([{ keys: "[TouchA>]", target: gauge() }, { keys: "[/TouchA]" }]);
    }
    expect(await screen.findByRole("tooltip")).toHaveTextContent("20 / 100");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.control).not.toHaveBeenCalled();
    expect(state.runSessionAction).not.toHaveBeenCalled();
  },
);

it.each(["claude-managed", "claude-follower", "codex-managed", "codex-follower"] as const)(
  "lets %s read usage without dispatching a control",
  async (executionMode) => {
    state.current = {
      id: "s",
      agent: executionMode.startsWith("claude") ? "claude-code" : "codex",
    } as typeof state.current;
    state.live = { ...state.live!, executionMode };
    state.access = { ...state.access!, device: { ...state.access!.device!, send: true } };
    state.canSend = true;
    state.control = vi.fn();
    state.runSessionAction = vi.fn();
    render(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(/^$/);
    await preview();
    expect(screen.getByRole("tooltip")).toHaveTextContent("20 / 100");
    fireEvent.click(gauge());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /压缩上下文|Compact context/i }),
    ).not.toBeInTheDocument();
    expect(state.control).not.toHaveBeenCalled();
    expect(state.runSessionAction).not.toHaveBeenCalled();
  },
);
