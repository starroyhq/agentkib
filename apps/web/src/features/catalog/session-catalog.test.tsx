import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationSessionSummary } from "@agentkib/web-client";
import { SessionCatalog } from "./session-catalog";

const workspaces = [
  { id: "alpha", name: "project", path: "/work/client-a/project" },
  { id: "beta", name: "project", path: "/work/client-b/project" },
];

const sessions = [
  {
    id: "primary",
    workspace_id: "alpha",
    title: "Primary session",
    agent: "codex",
    availability: "readable",
    archived: false,
    sidechain: false,
    updated_at: "2026-09-08T00:00:00Z",
  },
  {
    id: "newest",
    workspace_id: "beta",
    title: "Newest session",
    agent: "claude-code",
    availability: "readable",
    archived: false,
    sidechain: false,
    updated_at: "2026-09-09T00:00:00Z",
  },
  {
    id: "helper",
    workspace_id: "alpha",
    title: "Helper session",
    agent: "codex",
    availability: "readable",
    archived: false,
    sidechain: false,
    origin: "auxiliary",
  },
  {
    id: "metadata",
    workspace_id: "alpha",
    title: "Metadata session",
    agent: "codex",
    availability: "metadata-only",
    archived: false,
    sidechain: false,
  },
] as ConversationSessionSummary[];

afterEach(cleanup);

describe("SessionCatalog", () => {
  it("groups duplicate workspace names by path identity and hides auxiliary sessions by default", () => {
    render(
      <SessionCatalog
        sessions={sessions}
        workspaces={workspaces}
        selected=""
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Newest session/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Helper session/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Metadata session/ })).toBeNull();
    expect(screen.getByRole("button", { name: /client-b/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /client-a/ })).toBeVisible();
  });

  it("supports search, auxiliary visibility, and selection", () => {
    const onSelect = vi.fn();
    render(
      <SessionCatalog
        sessions={sessions}
        workspaces={workspaces}
        selected=""
        onSelect={onSelect}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), {
      target: { value: "Newest" },
    });
    expect(screen.getByRole("button", { name: /Newest session/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Helper session/ })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), { target: { value: "" } });
    fireEvent.click(screen.getByText("目录选项"));
    fireEvent.click(screen.getByLabelText("显示辅助会话"));
    fireEvent.click(screen.getByRole("button", { name: /Helper session/ }));

    expect(onSelect).toHaveBeenCalledWith("helper");
  });
});
