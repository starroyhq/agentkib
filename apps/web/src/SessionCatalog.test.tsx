import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WebClient } from "@agentkib/web-client";
import { App } from "./App";

const workspaces = [
  { id: "alpha", name: "project", path: "/work/client-a/project" },
  { id: "beta", name: "project", path: "/work/client-b/project" },
  { id: "gamma", name: "unique-project", path: "/work/unique-project" },
];
const session = (id: string, workspace_id: string, extra = {}) => ({
  id,
  workspace_id,
  title: id,
  agent: "codex",
  availability: "readable",
  archived: false,
  sidechain: false,
  ...extra,
});
const sessions = [
  session("older", "alpha", { updated_at: "2026-09-01T00:00:00Z" }),
  session("newest", "beta", {
    agent: "claude-code",
    updated_at: "2026-09-09T00:00:00Z",
    created_at: "2026-09-08T00:00:00Z",
    origin: "interactive",
    forked_from_session_id: "older",
    git_branch: "feature/catalog",
  }),
  session("ordinary", "gamma"),
  session("helper", "alpha", { origin: "auxiliary" }),
  session("unknown-source", "gamma", { origin: "unknown", sidechain: true }),
  session("archived-entry", "alpha", { archived: true }),
  session("metadata-entry", "beta", { availability: "metadata-only" }),
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup(includeWorkspaces = true) {
  vi.spyOn(WebClient.prototype, "stream").mockImplementation(() => () => {});
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path.endsWith("/access"))
      return Response.json({
        status: "approved",
        csrfToken: "x",
        bootId: "b",
        experimentalEnabled: false,
        device: { id: "browser", name: "Browser", send: false, approve: false },
      });
    if (path.includes("/catalog"))
      return Response.json({
        indexEnabled: true,
        sessions,
        ...(includeWorkspaces ? { workspaces } : {}),
      });
    if (path.includes("/events")) return Response.json({ events: [], warnings: [] });
    if (path.includes("/live"))
      return Response.json({ status: "idle", revision: 1, sendEnabled: false, approvals: [] });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  await screen.findByRole("textbox", { name: "搜索会话" });
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/catalog"))).toBe(true),
  );
  return fetcher;
}

it("groups by workspace identity, distinguishes equal names and hides only explicit auxiliary records", async () => {
  await setup();
  expect(await screen.findByRole("button", { name: /Codex.*ordinary/ })).toBeVisible();
  expect(screen.getByRole("button", { name: /Codex.*unknown-source/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Codex.*helper/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /archived-entry/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /metadata-entry/ })).toBeNull();
  const groups = screen
    .getAllByRole("button")
    .filter(
      (button) => button.hasAttribute("aria-expanded") && button.textContent?.includes("project"),
    );
  expect(groups).toHaveLength(3);
  expect(groups[0]).toHaveTextContent("client-b");
  expect(groups[1]).toHaveTextContent("client-a");
  expect(groups[2]).toHaveTextContent("unique-project");
  for (const group of groups) expect(group).toHaveAttribute("aria-expanded", "true");
});

it("searches project names and restores collapsed groups after clearing search", async () => {
  await setup();
  const group = await screen.findByRole("button", { name: /unique-project/ });
  fireEvent.click(group);
  expect(group).toHaveAttribute("aria-expanded", "false");
  const search = screen.getByRole("textbox", { name: "搜索会话" });
  fireEvent.change(search, { target: { value: "unique-project" } });
  expect(screen.getByRole("button", { name: /Codex.*ordinary/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Claude Code.*newest/ })).toBeNull();
  expect(screen.getByRole("button", { name: /unique-project/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  fireEvent.change(search, { target: { value: "" } });
  expect(screen.getByRole("button", { name: /unique-project/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

it("supports the same Agent, record and auxiliary filters as desktop", async () => {
  const fetcher = await setup();
  fireEvent.click(await screen.findByText("目录选项"));
  fireEvent.click(screen.getByLabelText("显示辅助会话"));
  expect(screen.getByRole("button", { name: /Codex.*helper/ })).toBeVisible();
  const filter = screen.getByLabelText("记录类型");
  fireEvent.change(filter, { target: { value: "archived" } });
  expect(screen.getByRole("button", { name: /archived-entry/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Codex.*older/ })).toBeNull();
  fireEvent.change(filter, { target: { value: "metadata" } });
  expect(screen.getByRole("button", { name: /metadata-entry/ })).toBeDisabled();
  fireEvent.change(filter, { target: { value: "all" } });
  expect(screen.getByRole("button", { name: /archived-entry/ })).toBeVisible();
  expect(screen.getByRole("button", { name: /metadata-entry/ })).toBeVisible();
  fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "claude-code" } });
  expect(screen.getByRole("button", { name: /Claude Code.*newest/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Codex.*older/ })).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => /\/(events|live)/.test(String(url)))).toBe(false);
});

it("shows missing project metadata explicitly without presenting workspace UUIDs as names", async () => {
  await setup(false);
  expect(await screen.findByText(/项目信息不可用.*升级桌面端/)).toBeVisible();
  expect(screen.queryByText("alpha")).toBeNull();
  expect(screen.queryByText("beta")).toBeNull();
});

it("retains collapse and selection on refresh and exposes the selected workspace path in details", async () => {
  await setup();
  const group = await screen.findByRole("button", { name: /unique-project/ });
  fireEvent.click(group);
  fireEvent.click(screen.getByRole("button", { name: /Claude Code.*newest/ }));
  await screen.findByRole("heading", { name: /newest/ });
  fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Claude Code.*newest/ })).toHaveClass("selected"),
  );
  expect(screen.getByRole("button", { name: /unique-project/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  fireEvent.click(screen.getByRole("button", { name: "详情" }));
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText("/work/client-b/project")).toBeVisible();
  expect(dialog.getByText("分支").nextElementSibling).toHaveTextContent("feature/catalog");
  expect(dialog.getByText("分叉自").nextElementSibling).toHaveTextContent("older");
  expect(dialog.getByText("来源").nextElementSibling).toHaveTextContent("交互会话");
});
