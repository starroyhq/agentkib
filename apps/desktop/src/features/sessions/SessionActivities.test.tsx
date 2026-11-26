// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { SessionActivities, SessionActivityButton } from "@agentkib/session-ui";
import {
  type SessionActivity,
  type SessionActivityCapabilities,
  WebClient,
} from "@agentkib/web-client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";

const parentId = "parent";
const childId = "a".repeat(64);
const panelOpenKey = "agentkib.session-activities.open";
const label = "Session activities";
const defaultClient = new WebClient();
const capabilities: SessionActivityCapabilities = {
  kinds: ["background-task", "subagent", "terminal"],
  canOpenSubagentHistory: true,
  canStopIndividually: false,
};
const task: SessionActivity = {
  id: "task",
  kind: "background-task",
  title: "Generate index",
  status: "completed",
  startedAt: "2026-11-20T01:00:00Z",
  endedAt: "2026-11-20T01:00:42Z",
};
const child: SessionActivity = {
  id: "activity",
  kind: "subagent",
  childId,
  title: "Check references",
  status: "running",
};

function activities({
  sessionId = parentId,
  locale = "en-US",
  capabilities: declared = capabilities,
  live,
  client = defaultClient,
  onStop,
}: Partial<Omit<React.ComponentProps<typeof SessionActivities>, "capabilities">> & {
  capabilities?: SessionActivityCapabilities | null;
} = {}) {
  const source = { sessionId, locale, capabilities: declared ?? undefined, live };
  return (
    <>
      <SessionActivityButton {...source} Button={Button} />
      <SessionActivities {...source} client={client} onStop={onStop} />
      <div aria-label="Transcript" tabIndex={0}>
        <button type="button">Outside</button>
      </div>
    </>
  );
}

function childPage(content: string, sessionId = parentId) {
  return Response.json({
    version: 1,
    sessionId,
    subagentId: childId,
    epoch: "fixture-epoch",
    events: [
      { id: "event", kind: "agent-message", content, attachment_count: 0, truncated: false },
    ],
    next_cursor: null,
    warnings: [],
  });
}

afterEach(() => {
  cleanup();
  localStorage.removeItem(panelOpenKey);
});

describe("session activities", () => {
  it("toggles the list with titles, statuses and observed durations", () => {
    const entry = { ...task, actions: { stop: { available: true } } };
    render(activities({ live: { sessionId: parentId, activities: [entry, child] } }));

    const button = screen.getByRole("button", { name: label });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: label })).not.toBeInTheDocument();
    fireEvent.click(button, { detail: 1 });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAttribute("aria-controls", screen.getByRole("region", { name: label }).id);
    expect(screen.getByText("Generate index")).toBeVisible();
    expect(screen.getByText("Completed")).toBeVisible();
    expect(screen.getByText("42 sec")).toBeVisible();
    expect(screen.getByText("Check references")).toBeVisible();
    expect(screen.getByText("Running")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    fireEvent.click(button, { detail: 1 });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: label })).not.toBeInTheDocument();
  });

  it("stays open through outside clicks, transcript scrolling and live updates", async () => {
    const user = userEvent.setup();
    const { rerender } = render(activities({ live: { sessionId: parentId, activities: [task] } }));
    const button = screen.getByRole("button", { name: label });
    await user.click(button);
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.scroll(screen.getByLabelText("Transcript"));
    expect(screen.getByRole("region", { name: label })).toBeVisible();

    rerender(activities({ live: { sessionId: parentId, activities: [task, child] } }));
    expect(screen.getByText(child.title)).toBeVisible();
    expect(button).toHaveAttribute("aria-expanded", "true");
    rerender(activities({ live: { sessionId: parentId, activities: [] } }));
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("No session activities")).toBeVisible();
  });

  it("allows supported sessions to open when activity is missing or empty", () => {
    const { rerender } = render(activities());
    const button = screen.getByRole("button", { name: label });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(screen.getByText("Session activities are unavailable")).toBeVisible();

    rerender(activities({ live: { sessionId: "another-parent", activities: [child] } }));
    expect(screen.queryByText(child.title)).toBeNull();
    expect(screen.getByText("Session activities are unavailable")).toBeVisible();
    rerender(activities({ live: { sessionId: parentId, activities: [] } }));
    expect(button).toBeEnabled();
    expect(screen.getByText("No session activities")).toBeVisible();
  });

  it("leaves a disabled button visible when activity kinds are undeclared", () => {
    localStorage.setItem(panelOpenKey, "true");
    const live = { sessionId: parentId, activities: [child] };
    const { rerender } = render(activities({ capabilities: null, live }));
    const button = screen.getByRole("button", { name: label });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).not.toHaveAttribute("aria-description");
    rerender(activities({ capabilities: { ...capabilities, kinds: [] }, live }));
    expect(button).toBeDisabled();
    expect(screen.queryByRole("region", { name: label })).not.toBeInTheDocument();
    rerender(activities({ live }));
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("shows status for only in-progress activities of supported kinds", () => {
    const terminal: SessionActivity = {
      id: "terminal",
      kind: "terminal",
      title: "Run checks",
      status: "waiting-approval",
    };
    const live = { sessionId: parentId, activities: [task, child, terminal] };
    const { rerender } = render(activities({ live }));
    const button = screen.getByRole("button", { name: label });
    expect(button).toHaveAttribute("aria-description", "In progress · 2 activities");
    rerender(activities({ live, capabilities: { ...capabilities, kinds: ["background-task"] } }));
    expect(button).not.toHaveAttribute("aria-description");
    rerender(activities({ live, capabilities: { ...capabilities, kinds: ["subagent"] } }));
    expect(button).toHaveAttribute("aria-description", "In progress · 1 subagent");
    rerender(activities({ live: { ...live, sessionId: "another-parent" } }));
    expect(button).not.toHaveAttribute("aria-description");
  });

  it("shows the terminal handover in the activity list without an active badge", () => {
    const handover: SessionActivity = {
      id: "handover",
      kind: "terminal",
      event: "terminal-auto-adopted",
      title: "",
      status: "completed",
    };
    render(
      activities({
        capabilities: { ...capabilities, kinds: ["terminal"] },
        live: { sessionId: parentId, activities: [handover] },
      }),
    );
    const button = screen.getByRole("button", { name: label });
    expect(button).not.toHaveAttribute("aria-description");
    expect(screen.queryByText("AgentKib took over after the terminal exited")).toBeNull();
    fireEvent.click(button);
    expect(screen.getByText("AgentKib took over after the terminal exited")).toBeVisible();
  });

  it("persists both open and closed states across session switches and remounts", () => {
    const first = render(activities({ live: { sessionId: parentId, activities: [child] } }));
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(localStorage.getItem(panelOpenKey)).toBe("true");
    first.rerender(activities({ sessionId: "another-parent" }));
    expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText(child.title)).not.toBeInTheDocument();
    first.unmount();

    const second = render(activities());
    expect(screen.getByRole("region", { name: label })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close session activities" }));
    expect(localStorage.getItem(panelOpenKey)).toBe("false");
    second.rerender(activities({ sessionId: "another-parent" }));
    expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-expanded", "false");
    second.unmount();

    render(activities());
    expect(screen.queryByRole("region", { name: label })).not.toBeInTheDocument();
  });

  it("moves focus into the panel and back to the trigger when opened and closed by keyboard", async () => {
    const user = userEvent.setup();
    render(activities());
    const button = screen.getByRole("button", { name: label });
    button.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("region", { name: label })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close session activities" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("region", { name: label })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("uses the activity kind when the title is blank", () => {
    render(activities({ live: { sessionId: parentId, activities: [{ ...task, title: "  " }] } }));
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.getByText("Background task", { exact: true })).toBeVisible();
  });

  it("keeps the existing stop action when individual stopping is supported and available", () => {
    const onStop = vi.fn();
    const entry = { ...task, actions: { stop: { available: false, reason: "operation_busy" } } };
    const running = { ...child, actions: { stop: { available: true } } };
    render(
      activities({
        capabilities: { ...capabilities, canStopIndividually: true },
        live: { sessionId: parentId, activities: [entry, running] },
        onStop,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: label }));
    const unavailable = screen.getByRole("button", { name: "Stop · Generate index" });
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveAttribute("title", "Wait for the current operation to finish");
    fireEvent.click(screen.getByRole("button", { name: "Stop · Check references" }));
    expect(onStop).toHaveBeenCalledExactlyOnceWith(child.id);
  });

  it("opens the child's read-only history within the current parent", async () => {
    const fetchHistory = vi.fn<typeof fetch>().mockResolvedValue(childPage("References checked"));
    const client = new WebClient(fetchHistory);
    render(activities({ client, live: { sessionId: parentId, activities: [child] } }));

    fireEvent.click(screen.getByRole("button", { name: label }));
    fireEvent.click(screen.getByRole("button", { name: "View history · Check references" }));
    expect(await screen.findByText("References checked")).toBeVisible();
    expect(fetchHistory).toHaveBeenCalledExactlyOnceWith(
      `/api/web/v1/subagent/events?sessionId=${parentId}&subagentId=${childId}`,
      expect.objectContaining({ method: "GET" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to activities" }));
    expect(screen.getByText("Check references")).toBeVisible();
    expect(screen.queryByText("References checked")).toBeNull();
  });

  it("discards late child history when the parent changes", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetchHistory = vi.fn<typeof fetch>().mockReturnValue(pending);
    const client = new WebClient(fetchHistory);
    const { rerender } = render(
      activities({ client, live: { sessionId: parentId, activities: [child] } }),
    );

    fireEvent.click(screen.getByRole("button", { name: label }));
    fireEvent.click(screen.getByRole("button", { name: "View history · Check references" }));
    const signal = fetchHistory.mock.calls[0]?.[1]?.signal;
    rerender(activities({ client, sessionId: "another-parent" }));
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(childPage("Previous child's output")));
    expect(screen.queryByText("Previous child's output")).toBeNull();
  });
});
