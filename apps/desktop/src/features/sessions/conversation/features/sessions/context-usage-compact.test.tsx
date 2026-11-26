// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextUsage } from "@agentkib/web-client";
import { ContextUsageGauge } from "../../context-usage";
import { useSession } from "../../desktop-session-context";
import { contextUsageCopy } from "@agentkib/session-ui";
import { sessionCopy } from "../../session-copy";

vi.mock("../../desktop-session-context", () => ({ useSession: vi.fn() }));
let state: ReturnType<typeof useSession>;
let control: ReturnType<typeof vi.fn>;
let runSessionAction: ReturnType<typeof vi.fn>;
const copy = contextUsageCopy["en-US"];
beforeEach(() => {
  control = vi.fn();
  runSessionAction = vi.fn();
  state = {
    selected: "s",
    locale: "en-US",
    online: true,
    canSend: true,
    current: { id: "s", agent: "claude-code" },
    access: {
      status: "approved",
      bootId: "boot",
      device: { id: "device", accessMode: "full", advancedControl: true, send: true },
    },
    client: {},
    page: {
      events: [{ id: "u", kind: "user-message", content: "hi", attachment_count: 0 }],
      warnings: [],
    },
    live: {
      sessionId: "s",
      status: "idle",
      revision: 1,
      executionMode: "claude-managed",
      approvals: [],
      usage: { available: true, state: "ready", reportId: 1, usedTokens: 20, contextWindow: 100 },
    },
    control,
    runSessionAction,
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => ({ ...state }));
});
afterEach(cleanup);
const ring = (locale = "en-US" as keyof typeof sessionCopy) =>
  screen.getByRole("img", { name: sessionCopy[locale].contextUsage });
const historicalUsage: ContextUsage = {
  historical: true,
  available: true,
  state: "stale",
  usedTokens: 75584,
  contextWindow: 258400,
  updatedAt: "2026-07-15T06:02:16.051Z",
};

describe("context usage is an informational surface", () => {
  it("shows saved native token counts without a fabricated window or percentage while another process owns the session", async () => {
    state.canSend = false;
    state.live = {
      ...state.live!,
      executionLocation: "external",
      ownershipReason: "claude-owner-busy",
      usage: {
        available: true,
        state: "stale",
        historical: true,
        usedTokens: 738407,
        reason: "model-context-window-unavailable",
      },
    };
    render(<ContextUsageGauge />);
    await userEvent.setup().hover(ring());
    const tooltip = await screen.findByRole("tooltip");
    expect(ring().textContent).toBe("");
    expect(tooltip).toHaveTextContent("738,407 tokens used");
    expect(tooltip).not.toHaveTextContent("%");
    expect(tooltip).not.toHaveTextContent("1,000,000");
    expect(control).not.toHaveBeenCalled();
  });

  it.each(["claude-managed", "claude-follower", "codex-managed", "codex-follower"])(
    "never opens a dialog or sends a command when clicked in %s",
    async (executionMode) => {
      state = {
        ...state,
        current: { id: "s", agent: executionMode.startsWith("codex") ? "codex" : "claude-code" },
        live: { ...state.live!, executionMode },
        capabilities: { sessionId: "s", features: { compact: { available: true } } },
      } as typeof state;
      render(<ContextUsageGauge />);
      expect(screen.queryByRole("button", { name: "Context usage" })).not.toBeInTheDocument();
      const indicator = ring();
      expect(indicator.tagName).toBe("SPAN");
      const user = userEvent.setup();
      await user.hover(indicator);
      expect(await screen.findByRole("tooltip")).toHaveTextContent("20% used");
      await user.click(indicator);
      expect(screen.getByRole("tooltip")).toHaveTextContent("20% used");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(control).not.toHaveBeenCalled();
      expect(runSessionAction).not.toHaveBeenCalled();
    },
  );

  it("still exposes usage when sending is unavailable", async () => {
    state.canSend = false;
    state.access = { ...state.access!, device: { ...state.access!.device!, send: false } };
    render(<ContextUsageGauge />);
    await userEvent.setup().hover(ring());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("20% used");
    expect(control).not.toHaveBeenCalled();
    expect(runSessionAction).not.toHaveBeenCalled();
  });

  it("shows native post-compaction tokens in the tooltip without using the current model limit to invent a percentage", async () => {
    state.live = {
      ...state.live!,
      usage: {
        available: true,
        state: "stale",
        historical: true,
        usedTokens: 24606,
        reason: "claude-post-compaction-usage",
      },
    };
    render(<ContextUsageGauge limit={1000000} />);
    expect(ring().textContent).toBe("");
    expect(ring().querySelector("circle")).not.toHaveAttribute("stroke-dasharray");
    expect(ring().querySelector("path")).toBeInTheDocument();
    await userEvent.setup().hover(ring());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).not.toHaveTextContent("Usage after compaction");
    expect(tooltip).not.toHaveTextContent(copy.stale);
    expect(tooltip).toHaveTextContent("24,606 tokens used");
    expect(tooltip).toHaveTextContent("1,000,000");
    expect(tooltip).not.toHaveTextContent("%");
  });

  it("retains the verified window when the same historical count is replayed without one", async () => {
    const count: ContextUsage = {
      available: true,
      historical: true,
      state: "stale",
      usedTokens: 24606,
      updatedAt: "2026-07-15T06:02:16.051Z",
      reason: "claude-post-compaction-usage",
    };
    state.live = {
      ...state.live!,
      executionMode: "claude-follower",
      model: "claude-opus-5-5",
      usage: { ...count, contextWindow: 1000000 },
    };
    const view = render(<ContextUsageGauge />);
    state.live = {
      ...state.live,
      executionMode: "claude-managed",
      model: undefined,
      usage: count,
    };
    view.rerender(<ContextUsageGauge />);
    await userEvent.setup().hover(ring());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("24,606 / 1,000,000 tokens used");
    expect(tooltip).toHaveTextContent("2% used");

    state.live = {
      ...state.live,
      model: "claude-sonnet-5-5",
      usage: count,
    };
    view.rerender(<ContextUsageGauge />);
    expect(ring()).toHaveAccessibleDescription(expect.stringContaining("24,606 tokens used"));
    expect(ring()).not.toHaveAccessibleDescription(expect.stringContaining("1,000,000"));
  });

  it("waits for the registered Claude live report without showing an invented percentage", async () => {
    const report = state.live!.usage;
    state.live = { ...state.live!, usage: undefined };
    const view = render(<ContextUsageGauge />);
    await userEvent.setup().hover(ring());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(copy.awaitingCliReport);
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("%");
    state.live = { ...state.live, usage: report };
    view.rerender(<ContextUsageGauge />);
    expect(screen.getByRole("tooltip")).toHaveTextContent("20% used");
  });

  it("shows the persisted DSH context reading from the selected session", async () => {
    const view = render(<ContextUsageGauge />);
    await userEvent.setup().hover(ring());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("20% used");

    state = {
      ...state,
      selected: "dsh-session",
      current: { ...state.current!, id: "dsh-session", agent: "deepseek-harness" },
      live: {
        ...state.live!,
        sessionId: "dsh-session",
        executionMode: "dsh-follower",
        usage: {
          available: true,
          historical: true,
          state: "stale",
          usedTokens: 24_000,
          contextWindow: 120_000,
        },
      },
    };
    view.rerender(<ContextUsageGauge />);
    expect(ring()).toHaveAccessibleDescription(
      expect.stringContaining("24,000 / 120,000 tokens used"),
    );
  });
});

describe("compact context usage in the desktop composer", () => {
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "uses an accessible icon during compaction and restores fresh usage in %s",
    async (locale) => {
      state = {
        ...state,
        locale,
        live: { ...state.live!, activity: "compacting" },
      };
      const view = render(<ContextUsageGauge />);
      const button = ring(locale);
      expect(button.querySelector("span:not(.sr-only)")).toBeNull();
      expect(button).toHaveAccessibleDescription(contextUsageCopy[locale].compactingDetail);
      expect(screen.queryByText(contextUsageCopy[locale].compactingDetail)).not.toBeInTheDocument();

      const user = userEvent.setup();
      await user.hover(button);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        contextUsageCopy[locale].compactingDetail,
      );
      expect(screen.getByRole("tooltip")).not.toHaveTextContent("20% used");
      await user.unhover(button);
      state = {
        ...state,
        live: {
          ...state.live!,
          activity: undefined,
          usage: {
            available: true,
            state: "ready",
            reportId: 2,
            usedTokens: 17,
            contextWindow: 100,
          },
        },
      };
      view.rerender(<ContextUsageGauge />);
      expect(ring(locale)).toHaveAccessibleDescription(expect.stringContaining("17%"));
      expect(button.querySelector("span:not(.sr-only)")).toBeNull();
    },
  );
});

describe("context window ring and hover details", () => {
  it.each(["claude-code", "devin"] as const)(
    "draws historical %s occupancy with its exact fraction and token counts",
    async (agent) => {
      const usage: ContextUsage = {
        available: true,
        state: "stale",
        historical: true,
        usedTokens: 24_606,
        contextWindow: 1_000_000,
        ...(agent === "claude-code" ? { reason: "claude-post-compaction-usage" } : {}),
      };
      state.current = { ...state.current!, agent };
      state.live = {
        ...state.live!,
        executionMode: agent === "devin" ? "devin-print" : "claude-follower",
        usage: agent === "devin" ? state.live!.usage : usage,
      };
      render(<ContextUsageGauge fallback={agent === "devin" ? usage : undefined} />);
      const arc = ring().querySelector("circle[pathLength='100']");
      expect(arc).toHaveAttribute("stroke-dasharray", "2.4606 100");
      expect(arc).toHaveAttribute("opacity", "1");
      await userEvent.setup().hover(ring());
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip).toHaveTextContent(copy.lastReading);
      expect(tooltip).toHaveTextContent("2% used (98% remaining)");
      expect(tooltip).toHaveTextContent("24,606 / 1,000,000 tokens used");
    },
  );

  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "shows usage only on hover in %s",
    async (locale) => {
      state = {
        ...state,
        locale,
        live: {
          ...state.live!,
          usage: {
            available: true,
            state: "ready",
            reportId: 1,
            usedTokens: 173000,
            contextWindow: 475000,
          },
        },
      };
      render(<ContextUsageGauge />);
      const button = ring(locale);
      expect(button.querySelector("span:not(.sr-only)")).toBeNull();
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      expect(button).toHaveAccessibleDescription(expect.stringContaining("36%"));
      await userEvent.setup().hover(button);
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip).toHaveTextContent(contextUsageCopy[locale].windowTitle);
      expect(tooltip).toHaveTextContent("36%");
      expect(tooltip).toHaveTextContent("64%");
      expect(tooltip).toHaveTextContent("173,000 / 475,000");
    },
  );

  it("previews on keyboard focus and dismisses with Escape without opening a dialog", async () => {
    render(<ContextUsageGauge />);
    const user = userEvent.setup();
    await user.tab();
    expect(ring()).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("20% used (80% remaining)");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(ring()).toHaveFocus();
  });

  it.each([0, 20, 100])("uses the entire circumference clockwise for %s%%", (percent) => {
    state.live = {
      ...state.live!,
      usage: {
        available: true,
        state: "ready",
        reportId: 1,
        usedTokens: percent,
        contextWindow: 100,
      },
    };
    render(<ContextUsageGauge />);
    const button = ring();
    expect(button).toHaveAccessibleDescription(
      `${percent}% used (${100 - percent}% remaining) ${percent} / 100 tokens used`,
    );
    const fill = button.querySelector("circle[pathLength]");
    if (percent === 0) expect(fill).toBeNull();
    else {
      expect(fill).toHaveAttribute("stroke-dasharray", `${percent} 100`);
      expect(fill).toHaveAttribute("transform", "rotate(-90 10 10)");
      expect(fill).toHaveAttribute("opacity", "1");
    }
  });

  it("identifies the last reading without the generic report notices", async () => {
    state.locale = "zh-Hant";
    state.live = {
      ...state.live!,
      usage: { available: true, state: "stale", usedTokens: 70700, contextWindow: 475000 },
    };
    render(<ContextUsageGauge />);
    const indicator = ring("zh-Hant");
    expect(indicator).toHaveAccessibleDescription(
      "上次讀數 已使用 15%（剩餘 85%） 已使用 70,700 / 475,000 Token",
    );
    await userEvent.setup().hover(indicator);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).not.toHaveTextContent("上次上報");
    expect(tooltip).toHaveTextContent("上次讀數");
    expect(tooltip).toHaveTextContent("15%（剩餘 85%）");
    expect(tooltip).toHaveTextContent("70,700 / 475,000");
  });

  it("shows the offline notice and retained usage", async () => {
    state.online = false;
    render(<ContextUsageGauge />);
    const button = ring();
    expect(button).toHaveAccessibleDescription(expect.stringContaining(copy.offline));
    await userEvent.setup().hover(button);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(copy.offline);
    expect(tooltip).toHaveTextContent(copy.lastReading);
    expect(tooltip).toHaveTextContent("20% used");
  });

  it("does not represent unknown usage as a known zero", async () => {
    state.live = {
      ...state.live!,
      usage: { available: false, state: "pending", reason: "not-reported" },
    };
    render(<ContextUsageGauge />);
    const button = ring();
    expect(button.querySelector("circle[pathLength]")).toBeNull();
    expect(button).toHaveAccessibleDescription(copy.awaitingCliReport);
    await userEvent.setup().hover(button);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(copy.awaitingCliReport);
    expect(tooltip).not.toHaveTextContent("0%");
  });
});

describe("context hover report boundaries", () => {
  it("never exposes retained usage after viewing permission is revoked", async () => {
    const view = render(<ContextUsageGauge />);
    const user = userEvent.setup();
    await user.hover(ring());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("20% used");
    state = {
      ...state,
      access: { ...state.access!, device: { ...state.access!.device!, advancedControl: false } },
    };
    view.rerender(<ContextUsageGauge />);
    expect(ring()).toHaveAccessibleDescription(copy.permission);
    expect(ring().querySelector("circle[pathLength]")).toBeNull();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(ring());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(copy.permission);
  });

  it("closes the old hover surface when the host identity changes", async () => {
    const view = render(<ContextUsageGauge />);
    const user = userEvent.setup();
    await user.hover(ring());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("20% used");
    state = {
      ...state,
      access: { ...state.access!, bootId: "replacement-host" },
    };
    view.rerender(<ContextUsageGauge />);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    expect(ring()).not.toHaveAccessibleDescription(expect.stringContaining("20% used"));
    expect(ring().querySelector("circle[pathLength]")).toBeNull();
    expect(control).not.toHaveBeenCalled();
    expect(runSessionAction).not.toHaveBeenCalled();
  });

  it("does not carry the previous session's report into a different session", () => {
    const view = render(<ContextUsageGauge />);
    expect(ring()).toHaveAccessibleDescription(expect.stringContaining("20% used"));
    state = { ...state, selected: "different-session" };
    view.rerender(<ContextUsageGauge />);
    expect(ring()).not.toHaveAccessibleDescription(expect.stringContaining("20% used"));
    expect(ring().querySelector("circle[pathLength]")).toBeNull();
  });
});

describe("historical Codex context reports", () => {
  beforeEach(() => {
    state.current = { ...state.current!, agent: "codex" };
    state.live = {
      ...state.live!,
      executionMode: "codex-managed",
      usage: { available: true, state: "stale" },
    };
  });

  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "shows the usage figures from an idle fallback in %s",
    async (locale) => {
      state.locale = locale;
      render(<ContextUsageGauge fallback={historicalUsage} />);
      const indicator = ring(locale);
      expect(indicator.querySelector("circle[pathLength]")).toHaveAttribute("opacity", "1");
      const usageCopy = contextUsageCopy[locale];
      const percentages = usageCopy.usedRemaining
        .replace("{used}", "29")
        .replace("{remaining}", "71");
      const tokens = usageCopy.tokenUsage.replace("{used}", "75,584").replace("{total}", "258,400");
      expect(indicator).toHaveAccessibleDescription(
        `${usageCopy.lastReading} ${percentages} ${tokens}`,
      );
      await userEvent.setup().hover(indicator);
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.querySelectorAll("p")).toHaveLength(4);
      expect(tooltip).toHaveTextContent(usageCopy.lastReading);
      expect(tooltip).toHaveTextContent(percentages);
      expect(tooltip).toHaveTextContent(tokens);
    },
  );

  it("prefers a fresh native report and never exposes history across a permission change", () => {
    const { rerender } = render(<ContextUsageGauge fallback={historicalUsage} />);
    expect(ring()).toHaveAccessibleDescription(expect.stringContaining("29% used"));
    state.live = {
      ...state.live!,
      usage: { available: true, state: "ready", reportId: 1, usedTokens: 15, contextWindow: 100 },
    };
    rerender(<ContextUsageGauge fallback={historicalUsage} />);
    expect(ring()).toHaveAccessibleDescription(expect.stringContaining("15% used"));
    expect(ring()).not.toHaveAccessibleDescription(expect.stringContaining("29% used"));
    state.live = {
      ...state.live,
      usage: { available: true, state: "stale" },
    };
    rerender(<ContextUsageGauge fallback={historicalUsage} />);
    expect(ring()).not.toHaveAccessibleDescription(expect.stringContaining("29% used"));
    expect(ring()).toHaveAccessibleDescription(expect.stringContaining("15% used"));
    expect(ring().querySelector("circle[pathLength]")).toHaveAttribute("opacity", "1");
    state.access = {
      ...state.access!,
      device: { ...state.access!.device!, advancedControl: false },
    };
    rerender(<ContextUsageGauge fallback={historicalUsage} />);
    expect(ring()).toHaveAccessibleDescription(copy.permission);
  });

  it("waits for a new native report after compaction", () => {
    state.live = { ...state.live!, activity: "compacting" };
    const { rerender } = render(<ContextUsageGauge fallback={historicalUsage} />);
    expect(ring()).toHaveAccessibleDescription(copy.compactingDetail);
    state.live = { ...state.live, activity: undefined };
    rerender(<ContextUsageGauge fallback={historicalUsage} />);
    expect(ring()).not.toHaveAccessibleDescription(expect.stringContaining("29% used"));
    expect(ring().querySelector("circle[pathLength]")).toBeNull();
  });
});
