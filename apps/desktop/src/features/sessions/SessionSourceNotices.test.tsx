// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { ConversationIndexStatus, ConversationSessionSummary } from "@/core/types";
import { SessionSourceNotices } from "./SessionSourceNotices";

const status: ConversationIndexStatus = {
  workspace_id: "project",
  agent: "antigravity",
  freshness: "unavailable",
  session_count: 0,
  error_key: "errors.conversations.sourceUnavailable",
};
beforeAll(() => initializeI18n("en-US"));
afterEach(cleanup);
describe("named source notices", () => {
  it("keeps an unused installed Agent neutral and retries with the existing refresh action", () => {
    const retry = vi.fn();
    const { rerender } = render(
      <SessionSourceNotices
        statuses={[status]}
        sessions={[]}
        installedAgents={["antigravity"]}
        refreshing={false}
        onRetry={retry}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      tr("sessions.sourceUnavailable", { agent: "Antigravity" }),
    );
    expect(screen.getByRole("status")).toHaveClass("text-muted-foreground");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    rerender(
      <SessionSourceNotices
        statuses={[status]}
        sessions={[]}
        installedAgents={["antigravity"]}
        refreshing
        onRetry={retry}
      />,
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  });
  it("uses warning only for this workspace's previous Agent records", () => {
    const other = { workspace_id: "other", agent: "antigravity" } as ConversationSessionSummary;
    const { rerender } = render(
      <SessionSourceNotices
        statuses={[status]}
        sessions={[other]}
        refreshing={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveClass("text-muted-foreground");
    rerender(
      <SessionSourceNotices
        statuses={[{ ...status, session_count: 1 }]}
        sessions={[other]}
        refreshing={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveClass("text-warning");
    rerender(
      <SessionSourceNotices
        statuses={[status]}
        sessions={[{ ...other, workspace_id: "project" }]}
        refreshing={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveClass("text-warning");
  });
  it("hides uninstalled or recovered source errors", () => {
    const { rerender } = render(
      <SessionSourceNotices
        statuses={[status]}
        sessions={[]}
        installedAgents={[]}
        refreshing={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    rerender(
      <SessionSourceNotices
        statuses={[{ ...status, error_key: undefined }]}
        sessions={[]}
        refreshing={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});
