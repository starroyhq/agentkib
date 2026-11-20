// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { SessionActivities } from "@agentkib/session-ui";
import {
  type SessionActivity,
  type SessionActivityCapabilities,
  WebClient,
} from "@agentkib/web-client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const parentId = "parent";
const childId = "a".repeat(64);
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

function activities(props: Partial<React.ComponentProps<typeof SessionActivities>> = {}) {
  return (
    <SessionActivities
      sessionId={parentId}
      locale="en-US"
      capabilities={capabilities}
      client={new WebClient()}
      {...props}
    />
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

afterEach(cleanup);

describe("session activities", () => {
  it("opens a counted list with titles, statuses and observed durations", () => {
    const entry = { ...task, actions: { stop: { available: true } } };
    render(activities({ live: { sessionId: parentId, activities: [entry, child] } }));

    const button = screen.getByRole("button", { name: "2 activities" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Generate index")).toBeVisible();
    expect(screen.getByText("Completed")).toBeVisible();
    expect(screen.getByText("42 sec")).toBeVisible();
    expect(screen.getByText("Check references")).toBeVisible();
    expect(screen.getByText("Running")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
  });

  it("keeps the entry disabled when the current session has no activity", () => {
    const { rerender } = render(activities());
    const button = screen.getByRole("button", { name: "Session activities" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Session activities are unavailable");

    rerender(activities({ live: { sessionId: "another-parent", activities: [child] } }));
    expect(button).toBeDisabled();
    expect(screen.queryByText(child.title)).toBeNull();
    rerender(activities({ live: { sessionId: parentId, activities: [] } }));
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "No session activities");
  });

  it("hides the entry when activity kinds are undeclared", () => {
    const live = { sessionId: parentId, activities: [child] };
    const { rerender } = render(activities({ capabilities: undefined, live }));
    expect(screen.queryByRole("button")).toBeNull();
    rerender(activities({ capabilities: { ...capabilities, kinds: [] }, live }));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("uses the activity kind when the title is blank", () => {
    render(activities({ live: { sessionId: parentId, activities: [{ ...task, title: "  " }] } }));
    fireEvent.click(screen.getByRole("button", { name: "1 background task" }));
    expect(screen.getByText("Background task", { exact: true })).toBeVisible();
  });

  it("opens the child's read-only history within the current parent", async () => {
    const fetchHistory = vi.fn<typeof fetch>().mockResolvedValue(childPage("References checked"));
    const client = new WebClient(fetchHistory);
    render(activities({ client, live: { sessionId: parentId, activities: [child] } }));

    fireEvent.click(screen.getByRole("button", { name: "1 subagent" }));
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

    fireEvent.click(screen.getByRole("button", { name: "1 subagent" }));
    fireEvent.click(screen.getByRole("button", { name: "View history · Check references" }));
    const signal = fetchHistory.mock.calls[0]?.[1]?.signal;
    rerender(activities({ client, sessionId: "another-parent" }));
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(childPage("Previous child's output")));
    expect(screen.queryByText("Previous child's output")).toBeNull();
  });
});
