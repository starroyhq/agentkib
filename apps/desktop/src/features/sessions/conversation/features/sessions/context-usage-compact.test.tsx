// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextUsage } from "@agentkib/web-client";
import { ContextUsageGauge } from "./context-usage";
import { useSession } from "./session-context";
import { contextUsageCopy } from "./context-usage-copy";
import { codexCopy } from "./codex-copy";

vi.mock("./session-context", () => ({ useSession: vi.fn() }));
let state: ReturnType<typeof useSession>;
let control: ReturnType<typeof vi.fn>;
let codexAction: ReturnType<typeof vi.fn>;
const copy = contextUsageCopy["en-US"];
beforeEach(() => {
  control = vi.fn();
  codexAction = vi.fn();
  state = {
    selected: "s",
    locale: "en-US",
    online: true,
    canSend: true,
    current: { id: "s", agent: "claude-code" },
    access: {
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
    codexAction,
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(cleanup);
const ring = (locale = "en-US" as keyof typeof codexCopy) =>
  screen.getByRole("img", { name: codexCopy[locale].contextUsage });
const historicalUsage: ContextUsage = {
  historical: true,
  available: true,
  state: "stale",
  usedTokens: 75584,
  contextWindow: 258400,
  updatedAt: "2026-07-15T06:02:16.051Z",
};

describe("context usage is an informational surface", () => {
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
      expect(codexAction).not.toHaveBeenCalled();
    },
  );

  it("still exposes usage when sending is unavailable", async () => {
    state.canSend = false;
    state.access = { ...state.access!, device: { ...state.access!.device!, send: false } };
    render(<ContextUsageGauge />);
    await userEvent.setup().hover(ring());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("20% used");
    expect(control).not.toHaveBeenCalled();
    expect(codexAction).not.toHaveBeenCalled();
  });
});

describe("compact context usage in the desktop composer", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "uses an accessible icon during compaction and restores fresh usage in %s",
    async (locale) => {
      state = {
        ...state,
        locale,
        live: { ...state.live!, activity: "compacting" },
      };
      const view = render(<ContextUsageGauge />);
      const button = ring(locale);
      expect(button).toHaveTextContent(/^$/);
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
      expect(button).toHaveTextContent(/^$/);
    },
  );
});

describe("context window ring and hover details", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
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
      expect(button).toHaveTextContent(/^$/);
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      expect(button).toHaveAccessibleDescription(expect.stringContaining("36%"));
      await userEvent.setup().hover(button);
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip).toHaveTextContent(contextUsageCopy[locale].windowTitle);
      expect(tooltip).toHaveTextContent("36%");
      expect(tooltip).toHaveTextContent("64%");
      expect(tooltip).toHaveTextContent("173K / 475K");
    },
  );

  it("opens the same details for keyboard focus", async () => {
    render(<ContextUsageGauge />);
    await userEvent.setup().tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("20% used (80% remaining)");
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
    }
  });

  it("labels retained offline usage as the last report", async () => {
    state.online = false;
    render(<ContextUsageGauge />);
    const button = ring();
    expect(button).toHaveAccessibleDescription(expect.stringContaining(copy.offline));
    await userEvent.setup().hover(button);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(copy.offline);
    expect(tooltip).toHaveTextContent(copy.reported);
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
    expect(button).toHaveAccessibleDescription(copy.pendingDetail);
    await userEvent.setup().hover(button);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(copy.pendingDetail);
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
    expect(screen.getByRole("tooltip")).toHaveTextContent(copy.permission);
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("20% used");
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
    expect(codexAction).not.toHaveBeenCalled();
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

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "shows an explicitly historical fallback for an empty idle projection in %s",
    async (locale) => {
      state.locale = locale;
      render(<ContextUsageGauge fallback={historicalUsage} />);
      const indicator = ring(locale);
      expect(indicator.querySelector("circle[pathLength]")).toHaveAttribute("opacity", "0.5");
      expect(indicator).toHaveAccessibleDescription(
        expect.stringContaining(contextUsageCopy[locale].historicalReport),
      );
      await userEvent.setup().hover(indicator);
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip).toHaveTextContent(contextUsageCopy[locale].historicalDetail);
      expect(tooltip).toHaveTextContent("29%");
      expect(tooltip).toHaveTextContent("75.6K / 258.4K");
    },
  );

  it("prefers a fresh native report and never exposes history across a permission change", () => {
    const { rerender } = render(<ContextUsageGauge fallback={historicalUsage} />);
    expect(ring()).toHaveAccessibleDescription(expect.stringContaining(copy.historicalReport));
    state.live = {
      ...state.live!,
      usage: { available: true, state: "ready", reportId: 1, usedTokens: 15, contextWindow: 100 },
    };
    rerender(<ContextUsageGauge fallback={historicalUsage} />);
    expect(ring()).toHaveAccessibleDescription(expect.stringContaining("15% used"));
    expect(ring()).not.toHaveAccessibleDescription(expect.stringContaining(copy.historicalReport));
    state.live = {
      ...state.live,
      usage: { available: true, state: "stale" },
    };
    rerender(<ContextUsageGauge fallback={historicalUsage} />);
    expect(ring()).not.toHaveAccessibleDescription(expect.stringContaining(copy.historicalReport));
    expect(ring().querySelector("circle[pathLength]")).toBeNull();
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
    expect(ring()).not.toHaveAccessibleDescription(expect.stringContaining(copy.historicalReport));
    expect(ring().querySelector("circle[pathLength]")).toBeNull();
  });
});
