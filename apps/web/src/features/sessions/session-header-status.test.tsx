// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SessionHeaderStatus, webLayoutCopy } from "@agentkib/session-ui";
import { afterEach, describe, expect, it, vi } from "vitest";

const locale = "en-US";
const copy = webLayoutCopy[locale];
const offline = { label: copy.offline, reason: copy.offline, tone: "warning" } as const;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("session header status", () => {
  it("shows the reconnect status after two seconds and resets for a new interruption", () => {
    vi.useFakeTimers();
    const view = render(<SessionHeaderStatus locale={locale} status={offline} reconnecting />);

    act(() => vi.advanceTimersByTime(1999));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("status")).toHaveTextContent(copy.streamReconnecting);

    view.rerender(<SessionHeaderStatus locale={locale} status={offline} reconnecting={false} />);
    expect(screen.getByRole("status")).toHaveTextContent(copy.offline);
    view.rerender(<SessionHeaderStatus locale={locale} status={offline} reconnecting />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps the result-verification badge visible even while reconnecting", () => {
    render(
      <SessionHeaderStatus
        locale={locale}
        reconnecting
        status={{ label: copy.uncertain, reason: "Do not send again", tone: "warning" }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(copy.uncertainShort);
    expect(screen.getByRole("status")).toHaveAttribute("title", "Do not send again");
  });

  it("uses a delayed spinner for transient states and hides the normal ready label", () => {
    vi.useFakeTimers();
    const view = render(
      <SessionHeaderStatus
        locale={locale}
        reconnecting={false}
        status={{ label: copy.verifying, reason: copy.verifying, tone: "muted", loading: true }}
      />,
    );
    const status = screen.getByRole("status", { name: copy.verifying });
    expect(status).toBeEmptyDOMElement();
    act(() => vi.advanceTimersByTime(300));
    expect(status.querySelector("svg")).not.toBeNull();
    expect(status).not.toHaveTextContent(copy.verifying);
    view.rerender(
      <SessionHeaderStatus
        locale={locale}
        reconnecting={false}
        status={{ label: copy.ready, reason: "", tone: "active" }}
      />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
