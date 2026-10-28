import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextUsage } from "@agentkib/web-client";
import { ContextUsageGauge } from "@/features/conversation/features/sessions/context-usage";
import { useSession } from "@/features/conversation/features/sessions/session-context";
import { contextUsageCopy } from "@/features/conversation/features/sessions/context-usage-copy";
import { codexCopy } from "@/features/conversation/features/sessions/codex-copy";
import type { Locale } from "@/features/conversation/i18n";

vi.mock("@/features/conversation/features/sessions/session-context", () => ({
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
    access: { bootId: "boot", device: { id: "device", accessMode: "full", advancedControl: true } },
    client: {},
    live: { sessionId: "s", status: "idle", revision: 1, usage: report(), approvals: [] },
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(cleanup);
const gauge = () =>
  screen.getByRole("button", { name: codexCopy[state.locale].contextUsage, hidden: true });
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

describe("Claude context usage before its first continued turn", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as Locale[])(
    "explains the missing CLI report in %s without inventing usage",
    (locale) => {
      unmanagedClaude();
      state.locale = locale;
      render(<ContextUsageGauge />);
      expect(gauge()).toHaveTextContent(contextUsageCopy[locale].awaitingCliReport);
      expect(gauge()).not.toHaveTextContent("0%");
      fireEvent.click(gauge());
      expect(screen.getByRole("dialog")).toHaveTextContent(
        contextUsageCopy[locale].awaitingCliReportDetail,
      );
      expect(screen.getByRole("dialog")).not.toHaveTextContent("%");
    },
  );

  it("preserves native reports and pending/stale states before continuing", () => {
    unmanagedClaude();
    state.live = { ...state.live!, usage: report(0) };
    const view = render(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("0%");
    for (const nextState of ["pending", "stale"] as const) {
      state.live = {
        ...state.live!,
        usage: { available: false, state: nextState },
      };
      view.rerender(<ContextUsageGauge />);
      expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"][nextState]);
      expect(gauge()).not.toHaveTextContent(contextUsageCopy["zh-CN"].awaitingCliReport);
    }
  });

  it("prioritizes disconnect and revoked authorization over the pending CLI explanation", () => {
    unmanagedClaude();
    const view = render(<ContextUsageGauge />);
    fireEvent.click(gauge());
    state.online = false;
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].stale);
    expect(screen.getByRole("dialog")).toHaveTextContent(contextUsageCopy["zh-CN"].offline);
    state.access = {
      ...state.access!,
      device: { ...state.access!.device!, advancedControl: false },
    };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].unavailable);
    expect(screen.getByRole("dialog")).toHaveTextContent(contextUsageCopy["zh-CN"].permission);
    expect(screen.getByRole("dialog")).not.toHaveTextContent(
      contextUsageCopy["zh-CN"].awaitingCliReportDetail,
    );
  });

  it("keeps an explicit native usage error visible", () => {
    unmanagedClaude();
    state.live = {
      ...state.live!,
      usage: { available: false, state: "unavailable", reason: "invalid-usage" },
    };
    render(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].unavailable);
    fireEvent.click(gauge());
    expect(screen.getByRole("dialog")).toHaveTextContent(contextUsageCopy["zh-CN"].invalid);
  });

  it("does not carry the Claude explanation to another selected session or stale live identity", () => {
    unmanagedClaude();
    const view = render(<ContextUsageGauge />);
    state.selected = "other";
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].unavailable);
    state.current = { ...state.current!, id: "other" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].unavailable);
  });

  it("does not apply the pre-start explanation to another agent or an already running worker", () => {
    unmanagedClaude();
    state.current = { ...state.current!, agent: "codex" };
    const view = render(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].unavailable);
    state.current = { ...state.current!, agent: "claude-code" };
    state.live = { ...state.live!, executionLocation: "agentkib", reason: undefined };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].unavailable);
  });
});

describe("native context usage", () => {
  it("renders valid zero without settings and opens the reported numerator and window", () => {
    state.live = { ...state.live!, usage: report(0) };
    render(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("0%");
    fireEvent.click(gauge());
    expect(screen.getByRole("dialog")).toHaveTextContent("0 / 100 (0%)");
  });

  it("keeps native reports ahead of late settings and rejects an older report even with a newer control revision", () => {
    const view = render(<ContextUsageGauge fallback={report(80)} />);
    expect(gauge()).toHaveTextContent("20%");
    state.live = { ...state.live!, revision: 2, usage: report(30, 2) };
    view.rerender(<ContextUsageGauge fallback={report(90)} />);
    expect(gauge()).toHaveTextContent("30%");
    state.live = { ...state.live!, revision: 10, usage: report(10, 1) };
    view.rerender(<ContextUsageGauge fallback={report(95)} />);
    expect(gauge()).toHaveTextContent("30%");
    state.live = { ...state.live!, usage: { available: false, state: "unavailable", reportId: 3 } };
    view.rerender(<ContextUsageGauge fallback={report(95)} />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].unavailable);
  });

  it("resets report generations on session and runtime changes and ignores the preceding live object", () => {
    state.live = { ...state.live!, usage: report(80, 50) };
    const view = render(<ContextUsageGauge />);
    state = { ...state, selected: "next" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).not.toHaveTextContent("80%");
    state.live = { ...state.live!, sessionId: "next", usage: report(10, 1) };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("10%");
    state.access = { ...state.access!, bootId: "new-boot" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).not.toHaveTextContent("10%");
    state.live = { ...state.live!, usage: report(5, 0) };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("5%");
  });

  it("hides usage immediately when the existing observation authorization is revoked", () => {
    const view = render(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("20%");
    state.access = {
      ...state.access!,
      device: { ...state.access!.device!, advancedControl: false },
    };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).not.toHaveTextContent("20%");
    fireEvent.click(gauge());
    expect(screen.getByRole("dialog")).toHaveTextContent(contextUsageCopy["zh-CN"].permission);
  });

  it("accepts a reset report ID only after a new native stream epoch", () => {
    state.usageEpoch = "native-1";
    state.live = { ...state.live!, usage: report(80, 50) };
    const view = render(<ContextUsageGauge />);
    state = { ...state, usageEpoch: "native-2", live: { ...state.live!, usage: report(5, 1) } };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("5%");
    state.live = { ...state.live!, usage: report(99, 0) };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("5%");
  });

  it("accepts a rebuilt observer's lower report ID without changing its transport epoch", () => {
    state.usageEpoch = "retained-stream";
    state.live = { ...state.live!, usage: report(80, 2, 1) };
    const view = render(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("80%");
    state.live = { ...state.live!, usage: { ...report(80, 2, 1), state: "stale" } };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].stale);
    state.live = { ...state.live!, usage: { ...report(80, 0, 2), state: "stale" } };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].stale);
    state.live = { ...state.live!, usage: report(5, 1, 2) };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("5%");
  });

  it("rejects late older observers and legacy reports after accepting a tagged generation", () => {
    state.live = { ...state.live!, usage: report(5, 1, 2) };
    const view = render(<ContextUsageGauge />);
    state.live = { ...state.live!, usage: report(80, 100, 1), activity: "compacting" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("5%");
    state.live = { ...state.live!, usage: report(90, 200), activity: "compacting" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("5%");
  });

  it("keeps same-generation report ordering and accepts state changes at the same ID", () => {
    state.live = { ...state.live!, usage: report(30, 2, 1) };
    const view = render(<ContextUsageGauge />);
    state.live = { ...state.live!, usage: report(10, 1, 1), activity: "compacting" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("30%");
    state.live = {
      ...state.live!,
      usage: { ...report(30, 2, 1), state: "stale" },
      activity: null,
    };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].stale);
    state.live = { ...state.live!, usage: { ...report(30, 2, 1), state: "pending" } };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].pending);
    state.live = { ...state.live!, usage: report(30, 2, 1) };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("30%");
  });

  it("discards the old observer's compaction barrier when a new generation takes over", () => {
    state.live = { ...state.live!, usage: report(80, 50, 1), activity: "compacting" };
    const view = render(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].compacting);
    state.live = { ...state.live!, usage: report(5, 1, 2), activity: null };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("5%");
    state.live = { ...state.live!, usage: report(90, 51, 1), activity: "compacting" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("5%");
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
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].compacting);
    state.live = { ...state.live!, usage: report(90, 51, 1), activity: null };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].compacting);
    state.live = {
      ...state.live!,
      usage: { ...report(20, 0, 2), state: "stale" },
      activity: null,
    };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].stale);
    state.live = { ...state.live!, usage: report(90, 52, 1) };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].stale);
    state.live = { ...state.live!, usage: report(5, 1, 2) };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("5%");
  });

  it("accepts an unreported new generation instead of retaining the old percentage", () => {
    state.live = { ...state.live!, usage: report(80, 2, 1) };
    const view = render(<ContextUsageGauge />);
    state.live = {
      ...state.live!,
      usage: { available: false, state: "pending", reportGeneration: 2, reportId: 0 },
    };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].pending);
    fireEvent.click(gauge());
    expect(screen.getByRole("dialog")).not.toHaveTextContent("80%");
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
    expect(gauge()).toHaveTextContent("5%");
  });

  it("keeps the previous report stale after compaction ends until a new report arrives", () => {
    const view = render(<ContextUsageGauge />);
    state.live = { ...state.live!, activity: "compacting" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].compacting);
    state.live = { ...state.live!, activity: null, revision: 2 };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].stale);
    state.live = { ...state.live!, usage: report(5, 2) };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent("5%");
    state.online = false;
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].stale);
  });

  it("shows a disconnected pending report without a window, preserving permission and compaction messages", () => {
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
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].pending);
    state.online = false;
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].stale);
    fireEvent.click(gauge());
    expect(screen.getByRole("dialog")).toHaveTextContent(contextUsageCopy["zh-CN"].offline);
    expect(screen.getByRole("dialog")).not.toHaveTextContent("%");

    state.access = {
      ...state.access!,
      device: { ...state.access!.device!, advancedControl: false },
    };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].unavailable);
    expect(screen.getByRole("dialog")).toHaveTextContent(contextUsageCopy["zh-CN"].permission);
    expect(screen.getByRole("dialog")).not.toHaveTextContent(contextUsageCopy["zh-CN"].offline);

    state.access = {
      ...state.access!,
      device: { ...state.access!.device!, advancedControl: true },
    };
    state.live = { ...state.live!, activity: "compacting" };
    view.rerender(<ContextUsageGauge />);
    expect(gauge()).toHaveTextContent(contextUsageCopy["zh-CN"].compacting);
    expect(screen.getByRole("dialog")).toHaveTextContent(
      contextUsageCopy["zh-CN"].compactingDetail,
    );
    expect(screen.getByRole("dialog")).not.toHaveTextContent(contextUsageCopy["zh-CN"].offline);
  });

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as Locale[])(
    "localizes pending, stale and unavailable in %s without a bare question mark",
    (locale) => {
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
      expect(gauge()).toHaveTextContent(contextUsageCopy[locale].pending);
      expect(gauge()).not.toHaveTextContent("?");
      fireEvent.click(gauge());
      expect(screen.getByRole("dialog")).toHaveTextContent(contextUsageCopy[locale].window);
      state.live = {
        ...state.live!,
        usage: { ...report(), state: "stale", reason: "usage-after-compaction-unconfirmed" },
      };
      view.rerender(<ContextUsageGauge />);
      expect(gauge()).toHaveTextContent(contextUsageCopy[locale].stale);
      expect(screen.getByRole("dialog")).toHaveTextContent(contextUsageCopy[locale].staleDetail);
      state.live = { ...state.live!, usage: { available: false, state: "unavailable" } };
      view.rerender(<ContextUsageGauge />);
      expect(gauge()).toHaveTextContent(contextUsageCopy[locale].unavailable);
    },
  );
});

describe("compacting a managed Claude session from the usage dialog", () => {
  const copy = contextUsageCopy["zh-CN"];
  let control: ReturnType<typeof vi.fn>;
  const claude = () => {
    control = vi.fn();
    state.current = { id: "s", agent: "claude-code" } as typeof state.current;
    state.live = { ...state.live!, executionMode: "claude-managed", status: "idle" };
    state.access = { ...state.access!, device: { ...state.access!.device!, send: true } };
    state.canSend = true;
    state.page = {
      events: [
        { id: "u", kind: "user-message", content: "hi", attachment_count: 0, truncated: false },
      ],
      warnings: [],
    } as unknown as typeof state.page;
    state.control = control as unknown as typeof state.control;
  };
  const compact = () => screen.queryByRole("button", { name: copy.compactAction });

  it("sends /compact as a message of its own and closes the dialog", () => {
    claude();
    render(<ContextUsageGauge />);
    fireEvent.click(gauge());
    expect(screen.getByRole("dialog")).toHaveTextContent(copy.compactDetail);
    fireEvent.click(compact()!);
    // The draft and its attachments stay in the composer.
    expect(control).toHaveBeenCalledExactlyOnceWith(
      "send",
      undefined,
      undefined,
      undefined,
      undefined,
      { command: "/compact" },
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("waits for the running turn to end, and for a first message", () => {
    claude();
    state.canSend = false;
    state.live = { ...state.live!, status: "running" };
    const view = render(<ContextUsageGauge />);
    fireEvent.click(gauge());
    expect(compact()).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveTextContent(copy.compactAfterTurn);
    state.canSend = true;
    state.live = { ...state.live!, status: "idle" };
    state.page = { events: [], warnings: [] } as unknown as typeof state.page;
    view.rerender(<ContextUsageGauge />);
    expect(compact()).toBeDisabled();
    expect(screen.getByRole("dialog")).not.toHaveTextContent(copy.compactAfterTurn);
    fireEvent.click(compact()!);
    expect(control).not.toHaveBeenCalled();
  });

  it.each([
    [
      "Codex",
      () => {
        state.current = { id: "s", agent: "codex" } as typeof state.current;
      },
    ],
    [
      "a terminal-connected session",
      () => {
        state.live = { ...state.live!, executionMode: "claude-follower" };
      },
    ],
    [
      "a device that cannot send",
      () => {
        state.access = { ...state.access!, device: { ...state.access!.device!, send: false } };
      },
    ],
    [
      "another session's live state",
      () => {
        state.live = { ...state.live!, sessionId: "other" };
      },
    ],
  ])("is not offered for %s", (_label, change) => {
    claude();
    change();
    render(<ContextUsageGauge />);
    fireEvent.click(gauge());
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(compact()).not.toBeInTheDocument();
  });
});
