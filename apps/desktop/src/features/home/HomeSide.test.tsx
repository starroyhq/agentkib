// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { HomeSide, type HomeSideProps } from "./HomeSide";

function renderSide(extra: Partial<HomeSideProps> = {}) {
  const props: HomeSideProps = {
    quota: [],
    maintenance: [],
    onOpenQuota: vi.fn(),
    onOpenRemote: vi.fn(),
    onOpenMaintenance: vi.fn(),
    ...extra,
  };
  const view = render(<HomeSide {...props} />);
  return { props, view };
}

describe("HomeSide", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("shows nothing when quota, remote and upkeep have nothing to say", () => {
    const { view } = renderSide();
    expect(view.container).toBeEmptyDOMElement();
  });

  it("opens the quota page from the quota card", () => {
    const { props } = renderSide({
      quota: [
        {
          providerId: "codex",
          name: "Codex",
          window: { kind: "session", label: "5 hours", used_percent: 62, remaining_percent: 38 },
          usedPercent: 62,
          severity: "healthy",
        },
      ],
    });

    expect(screen.getByText("Codex · 5 hours")).toBeInTheDocument();
    expect(screen.getByText("62%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Quota/ }));
    expect(props.onOpenQuota).toHaveBeenCalled();
  });

  it("warns as the relay allowance runs out", () => {
    const { view } = renderSide({
      remote: { devices: 2, relayPercent: 70, relayExhausted: false },
    });
    expect(screen.getByText("On · 2 devices")).toBeInTheDocument();
    expect(screen.queryByText(/relay/)).not.toBeInTheDocument();

    view.rerender(
      <HomeSide
        quota={[]}
        maintenance={[]}
        remote={{ devices: 1, relayPercent: 82, relayExhausted: false }}
        onOpenQuota={vi.fn()}
        onOpenRemote={vi.fn()}
        onOpenMaintenance={vi.fn()}
      />,
    );
    expect(screen.getByText("On · 1 device")).toBeInTheDocument();
    expect(screen.getByText("82% of this month's relay used")).toBeInTheDocument();

    view.rerender(
      <HomeSide
        quota={[]}
        maintenance={[]}
        remote={{ devices: 1, relayPercent: 100, relayExhausted: true }}
        onOpenQuota={vi.fn()}
        onOpenRemote={vi.fn()}
        onOpenMaintenance={vi.fn()}
      />,
    );
    expect(
      screen.getByText("This month's relay allowance is used up; LAN direct still works"),
    ).toBeInTheDocument();
  });

  it("opens each upkeep item's page and only notes unchecked workspaces", () => {
    const { props } = renderSide({
      maintenance: [
        { kind: "config", count: 2 },
        { kind: "memories", count: 1 },
        { kind: "tools", agents: ["codex"] },
        { kind: "undiagnosed", count: 3 },
      ],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "2 workspaces have configuration problems" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "1 memory waiting for review" }));
    fireEvent.click(screen.getByRole("button", { name: "Codex update available" }));
    expect(vi.mocked(props.onOpenMaintenance).mock.calls).toEqual([
      ["config"],
      ["memories"],
      ["tools"],
    ]);
    expect(screen.getByText("3 workspaces not diagnosed yet")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "3 workspaces not diagnosed yet" }),
    ).not.toBeInTheDocument();
  });
});
