import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WebClient } from "@agentkib/web-client";
import { App } from "./App";
import { dictionaries } from "./i18n";

const workspaceId = "f8b2077c-01f9-4137-8340-b446c3330000";
const sessionId = "3121ec99-e4cb-465b-8056-0d653212b113";
const longTitle = "长标题用于确认可访问名称仍然保留完整内容".repeat(8);
const sessions = [
  { id: "codex-session", agent: "codex", title: "分析 Electron 风险" },
  { id: sessionId, agent: "claude-code", title: "Claude 代码检查" },
  { id: "untitled", agent: "codex", title: null },
  { id: "unknown", agent: "future-agent", title: "未来 Agent 会话" },
  { id: "long", agent: "codex", title: longTitle },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup() {
  vi.spyOn(WebClient.prototype, "stream").mockImplementation(() => () => {});
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path.endsWith("/access"))
      return Response.json({
        status: "approved",
        csrfToken: "csrf",
        bootId: "boot",
        experimentalEnabled: false,
        device: { id: "browser", name: "Test Browser", send: false, approve: false },
      });
    if (path.includes("/catalog"))
      return Response.json({
        indexEnabled: true,
        workspaces: [{ id: workspaceId, name: "test", path: "/projects/test" }],
        sessions: sessions.map((session) => ({
          ...session,
          workspace_id: workspaceId,
          availability: "readable",
          archived: false,
          sidechain: false,
        })),
      });
    if (path.includes("/events")) return Response.json({ events: [], warnings: [] });
    if (path.includes("/live"))
      return Response.json({ status: "idle", revision: 1, sendEnabled: false, approvals: [] });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  await screen.findByRole("button", { name: /Codex.*分析 Electron 风险/ });
  return fetcher;
}

it("identifies sessions by Agent and complete title without exposing workspace IDs", async () => {
  const fetcher = await setup();
  expect(screen.getByRole("button", { name: /Claude Code.*Claude 代码检查/ })).toBeVisible();
  expect(screen.getByRole("button", { name: /Codex.*未命名会话/ })).toBeVisible();
  expect(screen.getByRole("button", { name: /future-agent.*未来 Agent 会话/ })).toBeVisible();
  expect(screen.getByRole("button", { name: new RegExp(`Codex.*${longTitle}`) })).toBeVisible();
  expect(screen.queryByText(workspaceId)).toBeNull();
  expect(screen.queryByText(sessionId)).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("/events"))).toBe(false);
});

it("preserves title search, selection and returning to the catalog", async () => {
  await setup();
  const search = screen.getByRole("textbox", { name: dictionaries["zh-CN"].search });
  fireEvent.change(search, { target: { value: "代码检查" } });
  expect(screen.queryByRole("button", { name: /分析 Electron 风险/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Claude Code.*Claude 代码检查/ }));
  expect(await screen.findByRole("heading", { name: /Claude 代码检查/ })).toBeVisible();
  expect(screen.getByRole("button", { name: /Claude Code.*Claude 代码检查/ })).toHaveClass(
    "selected",
  );
  fireEvent.click(screen.getByRole("button", { name: dictionaries["zh-CN"].back }));
  expect(screen.queryByRole("heading", { name: /Claude 代码检查/ })).toBeNull();
  expect(search).toHaveValue("代码检查");
  fireEvent.change(search, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: /Codex.*分析 Electron 风险/ }));
  expect(await screen.findByRole("heading", { name: /分析 Electron 风险/ })).toBeVisible();
});

it("labels workspace and session IDs separately and reveals them only in details", async () => {
  await setup();
  fireEvent.click(screen.getByRole("button", { name: /Claude Code.*Claude 代码检查/ }));
  await screen.findByRole("heading", { name: /Claude 代码检查/ });
  expect(screen.queryByText(workspaceId)).toBeNull();
  expect(screen.queryByText(sessionId)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: dictionaries["zh-CN"].details }));
  const dialog = await screen.findByRole("dialog");
  const details = within(dialog);
  expect(details.getByText("工作区 ID").nextElementSibling).toHaveTextContent(workspaceId);
  expect(details.getByText("会话 ID").nextElementSibling).toHaveTextContent(sessionId);
  fireEvent.click(details.getByRole("button", { name: dictionaries["zh-CN"].close }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByText(workspaceId)).toBeNull();
});
