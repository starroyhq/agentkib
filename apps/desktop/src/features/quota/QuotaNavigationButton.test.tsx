// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/core/api";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type { QuotaAccount, QuotaProvider, QuotaSnapshot, QuotaWindow } from "@/core/types";
import { QuotaNavigationButton } from "./QuotaNavigationButton";
import { quotaKeys, useQuotaSnapshot } from "./quota-query";

const clients: QueryClient[] = [];
const click = vi.fn();
const quotaWindow = (remaining: number, label = "Weekly"): QuotaWindow => ({
  kind: "weekly",
  label,
  used_percent: 100 - remaining,
  remaining_percent: remaining,
});
const account = (id: string, remaining: number, active = false): QuotaAccount => ({
  id,
  label: id,
  active,
  windows: [quotaWindow(remaining, `${id} window`)],
});
const provider = (
  id: string,
  windows: QuotaWindow[] = [],
  accounts: QuotaAccount[] = [],
): QuotaProvider => ({ id, name: id, enabled: true, windows, accounts });
function snapshot(
  providers: QuotaProvider[],
  options: { freshness?: QuotaSnapshot["freshness"]; age?: number; expires?: number } = {},
): QuotaSnapshot {
  const at = new Date(Date.now() - (options.age ?? 0)).toISOString();
  return {
    schema_version: 1,
    backend: "codex-bar-cli",
    generated_at: at,
    fetched_at: at,
    stale_after_seconds: options.expires ?? 300,
    freshness: options.freshness ?? "fresh",
    providers,
  };
}
function button(value?: QuotaSnapshot, active = false) {
  return (
    <TooltipProvider>
      <QuotaNavigationButton
        snapshot={value}
        label="Quota"
        active={active}
        shortcut="Meta+5"
        onClick={click}
      />
    </TooltipProvider>
  );
}

beforeEach(async () => {
  click.mockClear();
  await initializeI18n("en-US");
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("quota navigation's independent agent remaining values", () => {
  it("ignores unknown placeholders and null percentages when choosing and drawing a minimum", () => {
    render(
      button(
        snapshot([
          provider("codex", [
            { ...quotaWindow(100), usage_known: false },
            { ...quotaWindow(0), used_percent: null, remaining_percent: null },
            quotaWindow(42),
          ]),
          provider("claude", [{ ...quotaWindow(100), usage_known: false }]),
        ]),
      ),
    );
    const navigation = screen.getByRole("button", { name: "Quota" });
    expect(navigation).toHaveAccessibleDescription(
      /Codex: 42% remaining.*Claude Code: Unavailable/,
    );
    expect(navigation).not.toHaveAccessibleDescription(/100%/);
    expect(navigation.querySelectorAll("g circle")).toHaveLength(1);
    expect(navigation.querySelector("g circle")).toHaveAttribute("stroke-dasharray", "21 79");
  });
  it("selects each agent's minimum across provider and all account windows", async () => {
    render(
      button(
        snapshot([
          provider(
            "codex",
            [quotaWindow(80, "Codex week"), quotaWindow(60, "Codex session")],
            [account("active Codex", 45, true), account("inactive Codex", 20)],
          ),
          provider(
            "claude",
            [quotaWindow(75, "Claude week"), quotaWindow(50, "Claude session")],
            [account("active Claude", 35, true)],
          ),
        ]),
      ),
    );
    const navigation = screen.getByRole("button", { name: "Quota" });
    expect(navigation).toHaveAccessibleDescription(
      /Codex: 20% remaining.*Claude Code: 35% remaining/,
    );
    await userEvent.setup().hover(navigation);
    expect(await screen.findByText("inactive Codex · inactive Codex window")).toBeVisible();
    expect(screen.getByText("active Claude · active Claude window")).toBeVisible();
  });

  it("combines canonical and compatible Claude provider IDs into one agent's minimum", async () => {
    render(
      button(
        snapshot([
          provider("claude", [quotaWindow(70)]),
          provider("claude-code", [quotaWindow(25)]),
          provider(" CODEX ", [quotaWindow(91)]),
        ]),
      ),
    );
    const navigation = screen.getByRole("button", { name: "Quota" });
    expect(navigation).toHaveAccessibleDescription(
      /Codex: 91% remaining.*Claude Code: 25% remaining/,
    );
    await userEvent.setup().hover(navigation);
    await screen.findByText("Claude Code · 25% remaining · Lowest remaining");
    expect(screen.getAllByText(/Claude Code ·/)).toHaveLength(1);
  });

  it("ignores disabled providers and invalid percentages without treating unknown providers as agents", () => {
    render(
      button(
        snapshot([
          { ...provider("codex", [quotaWindow(0)]), enabled: false },
          provider("codex", [
            quotaWindow(NaN),
            quotaWindow(Infinity),
            quotaWindow(-1),
            quotaWindow(101),
            quotaWindow(64),
          ]),
          provider("claude", [quotaWindow(NaN), quotaWindow(-3), quotaWindow(120)]),
          { ...provider("unknown", [quotaWindow(0)]), name: "Claude Code Codex" },
        ]),
      ),
    );
    expect(screen.getByRole("button", { name: "Quota" })).toHaveAccessibleDescription(
      /Codex: 64% remaining.*Claude Code: Unavailable/,
    );
  });

  it.each([undefined, snapshot([]), snapshot([provider("codex"), provider("claude")])])(
    "keeps missing data explicitly unavailable instead of presenting zero or full quota",
    (value) => {
      render(button(value));
      const navigation = screen.getByRole("button", { name: "Quota" });
      expect(navigation).toHaveAccessibleDescription(
        "Codex: Unavailable; Claude Code: Unavailable",
      );
      expect(navigation).toBeEnabled();
    },
  );

  it("keeps exact exhausted and full values, then updates the same mounted navigation button", () => {
    const view = render(
      button(
        snapshot([provider("codex", [quotaWindow(0)]), provider("claude", [quotaWindow(100)])]),
      ),
    );
    const navigation = screen.getByRole("button", { name: "Quota" });
    expect(navigation).toHaveAccessibleDescription(
      /Codex: 0% remaining.*Claude Code: 100% remaining/,
    );
    view.rerender(
      button(
        snapshot([provider("claude", [quotaWindow(42)]), provider("codex", [quotaWindow(93)])]),
      ),
    );
    expect(screen.getByRole("button", { name: "Quota" })).toBe(navigation);
    expect(navigation).toHaveAccessibleDescription(
      /Codex: 93% remaining.*Claude Code: 42% remaining/,
    );
    view.rerender(button());
    expect(navigation).toHaveAccessibleDescription("Codex: Unavailable; Claude Code: Unavailable");
  });

  it("joins the two data-driven segments without reserving separate halves of the ring", () => {
    render(
      button(
        snapshot([provider("codex", [quotaWindow(20)]), provider("claude", [quotaWindow(60)])]),
      ),
    );
    const navigation = screen.getByRole("button", { name: "Quota" });
    expect(navigation).toHaveAccessibleDescription(
      /Codex: 20% remaining.*Claude Code: 60% remaining/,
    );
    const segments = [...navigation.querySelectorAll("[stroke-dashoffset]")];
    const lengths = segments.map((segment) =>
      Number(segment.getAttribute("stroke-dasharray")!.split(" ")[0]),
    );
    expect(lengths).toEqual([10, 30]);
    expect(segments.map((segment) => Number(segment.getAttribute("stroke-dashoffset")))).toEqual([
      0, -10,
    ]);
    expect(lengths.reduce((total, length) => total + length, 0)).toBe(40);
  });

  it("supports native button activation, keyboard navigation and current-page semantics", async () => {
    const view = render(button(undefined, true));
    const user = userEvent.setup();
    const navigation = screen.getByRole("button", { name: "Quota" });
    expect(navigation).toHaveAttribute("type", "button");
    expect(navigation).toHaveAttribute("aria-current", "page");
    expect(navigation).toHaveAttribute("aria-keyshortcuts", "Meta+5");
    await user.tab();
    expect(navigation).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.keyboard("[Space]");
    await user.click(navigation);
    expect(click).toHaveBeenCalledTimes(3);
    view.rerender(button(undefined, false));
    expect(navigation).not.toHaveAttribute("aria-current");
  });

  it.each(["fresh", "stale", "unavailable"] as const)(
    "labels cached %s snapshots using both their age and freshness",
    async (freshness) => {
      render(
        button(
          snapshot([provider("codex", [quotaWindow(37)])], {
            freshness,
            age: freshness === "fresh" ? 400_000 : 0,
          }),
        ),
      );
      const navigation = screen.getByRole("button", { name: "Quota" });
      expect(navigation).toHaveAccessibleDescription(/Codex: 37% remaining.*Stale data/);
      await userEvent.setup().hover(navigation);
      expect(await screen.findByText(tr("quota.staleReset"))).toBeVisible();
    },
  );

  it("marks a mounted snapshot stale at its deadline without inventing a quota refill", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-11-04T00:00:00Z");
    const view = render(button(snapshot([provider("codex", [quotaWindow(8)])], { expires: 2 })));
    const navigation = screen.getByRole("button", { name: "Quota" });
    expect(navigation).not.toHaveAccessibleDescription(/Stale data/);
    act(() => vi.advanceTimersByTime(1_999));
    expect(navigation).not.toHaveAccessibleDescription(/Stale data/);
    act(() => vi.advanceTimersByTime(1));
    expect(navigation).toHaveAccessibleDescription(/Codex: 8% remaining.*Stale data/);
    view.rerender(button(snapshot([provider("codex", [quotaWindow(61)])], { expires: 5 })));
    expect(navigation).toHaveAccessibleDescription(/Codex: 61% remaining/);
    expect(navigation).not.toHaveAccessibleDescription(/Stale data/);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("updates its accessible remaining values with the actual application language", async () => {
    render(button(snapshot([provider("codex", [quotaWindow(23)])])));
    const navigation = screen.getByRole("button", { name: "Quota" });
    for (const locale of ["zh-CN", "zh-TW", "ja-JP", "en-US"] as const) {
      await act(() => changeLocale(locale));
      expect(navigation).toHaveAccessibleDescription(
        `Codex: ${tr("quota.remaining", { value: 23 })} · ${tr("quota.lowestRemaining")}; Claude Code: ${tr("quota.unavailable")}`,
      );
    }
  });

  it("observes shared query cache updates without collecting or refreshing quota", async () => {
    const read = vi.spyOn(api, "quotaSnapshot");
    const collect = vi.spyOn(api, "refreshQuota");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    client.setQueryData(quotaKeys.snapshot(), snapshot([provider("codex", [quotaWindow(55)])]));
    function CachedNavigation() {
      const current = useQuotaSnapshot();
      return button(current.data);
    }
    render(
      <QueryClientProvider client={client}>
        <CachedNavigation />
      </QueryClientProvider>,
    );
    const navigation = screen.getByRole("button", { name: "Quota" });
    expect(navigation).toHaveAccessibleDescription(/Codex: 55% remaining/);
    act(() =>
      client.setQueryData(
        quotaKeys.snapshot(),
        snapshot([provider("codex", [quotaWindow(31)]), provider("claude", [quotaWindow(62)])]),
      ),
    );
    await waitFor(() =>
      expect(navigation).toHaveAccessibleDescription(
        /Codex: 31% remaining.*Claude Code: 62% remaining/,
      ),
    );
    expect(read).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });
});
