import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WebClient, type Approval, type Live } from "@agentkib/web-client";
import { App } from "./App";
import { dictionaries, type Locale } from "./i18n";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup(approval?: Approval) {
  let state: Live = {
    sessionId: "claude",
    status: approval ? "waiting-approval" : "idle",
    revision: 1,
    executionMode: "managed-resume",
    streamText: "",
    sendEnabled: !approval,
    approvals: approval ? [approval] : [],
  };
  let handlers: Parameters<WebClient["stream"]>[1] | undefined;
  vi.spyOn(WebClient.prototype, "stream").mockImplementation((_id, value) => {
    handlers = value;
    return () => {};
  });
  const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/access"))
      return Response.json({
        status: "approved",
        csrfToken: "csrf",
        bootId: "boot",
        experimentalEnabled: true,
        device: { id: "d", name: "Browser", send: true, approve: true },
      });
    if (path.includes("/catalog"))
      return Response.json({
        indexEnabled: true,
        workspaces: [{ id: "w", name: "test", path: "/projects/test" }],
        sessions: [
          {
            id: "claude",
            title: "Claude session",
            workspace_id: "w",
            agent: "claude-code",
            availability: "readable",
            archived: false,
            sidechain: false,
          },
        ],
      });
    if (path.includes("/events")) return Response.json({ events: [], warnings: [] });
    if (path.includes("/live")) return Response.json(state);
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Claude session/ }));
  await waitFor(() => expect(handlers).toBeDefined());
  return {
    fetcher,
    update: (next: Partial<Live>) =>
      act(() => {
        state = { ...state, ...next, revision: state.revision + 1 };
        handlers!.event("snapshot", JSON.stringify(state));
      }),
  };
}

it.each(["allow", "deny"] as const)(
  "shows native Claude tool input and sends %s only once",
  async (decision) => {
    const { fetcher } = await setup({
      requestId: "permission-1",
      turnId: "turn-1",
      method: "claude/can_use_tool",
      toolName: "Write",
      context: {
        blockedPath: "/tmp/example",
        decisionReason: "permission required",
        description: "Write a file",
        permissionSuggestions: [{ type: "addRules", behavior: "allow" }],
      },
      input: { file_path: "/tmp/example", content: "<script>unsafe</script>" },
      command: "legacy command",
      proposedExecpolicyAmendment: ["never display this"],
      availableDecisions: ["allow", "deny", "cancel", "accept"],
      supported: true,
    });
    expect(screen.getByText("实时状态 · 等待审批")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "等待审批" }));
    expect(screen.getByText(/"blockedPath":/)).toHaveTextContent('"permissionSuggestions":');
    expect(screen.getByText(/"blockedPath":/)).toHaveTextContent(
      '"decisionReason": "permission required"',
    );
    expect(screen.getByText(dictionaries["zh-CN"].claudeContextInfo)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Write" })).toBeVisible();
    expect(screen.getByText(/"file_path":/)).toHaveTextContent("<script>unsafe</script>");
    expect(screen.queryByText("legacy command")).toBeNull();
    expect(screen.queryByText(/never display this/)).toBeNull();
    expect(screen.queryByRole("button", { name: "取消轮次" })).toBeNull();
    expect(screen.queryByText(dictionaries["zh-CN"].decisionInfo)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: dictionaries["zh-CN"][decision] }));
    await waitFor(() =>
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/approve"))).toHaveLength(
        1,
      ),
    );
    const request = fetcher.mock.calls.find(([url]) => String(url).endsWith("/approve"))!;
    expect(JSON.parse(String(request[1]?.body))).toMatchObject({
      decision,
      approvalId: "permission-1",
      turnId: "turn-1",
    });
  },
);

it("supports managed sending and clears the live reply when the run completes", async () => {
  const { update, fetcher } = await setup();
  expect(screen.getByText(dictionaries["zh-CN"].managedResumeInfo)).toBeVisible();
  const input = await screen.findByRole("textbox", { name: "发送消息" });
  fireEvent.change(input, { target: { value: "continue" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/send"))).toBe(true),
  );
  update({ status: "running", streamText: "Partial live reply", sendEnabled: false });
  expect(screen.getByRole("article", { name: "当前实时回复" })).toHaveTextContent(
    "Partial live reply",
  );
  update({ status: "idle", streamText: "", sendEnabled: true });
  expect(screen.queryByRole("article", { name: "当前实时回复" })).toBeNull();
});

it.each(Object.keys(dictionaries) as Locale[])(
  "has explicit single-operation Claude copy in %s",
  (locale) => {
    const words = dictionaries[locale];
    expect(words.allow).toBe(words.accept);
    expect(words.deny).toBeTruthy();
    expect(words.deny).not.toBe(words.cancelTurn);
    expect(words.claudeDecisionInfo).not.toBe(words.decisionInfo);
    expect(words.managedResumeInfo).toContain("AgentKib");
    expect(words.streamingReply).toBeTruthy();
    expect(words.streamingReplyTruncated).toBeTruthy();
  },
);

it("shows an explicit truncated preview without changing control state", async () => {
  const { update, fetcher } = await setup();
  update({
    status: "running",
    streamText: "Preview prefix",
    streamTextTruncated: true,
    sendEnabled: false,
  });
  const preview = screen.getByRole("article", { name: "当前实时回复" });
  expect(preview).toHaveTextContent("Preview prefix");
  expect(preview).toHaveTextContent(dictionaries["zh-CN"].streamingReplyTruncated);
  expect(screen.getByText("实时状态 · 运行中")).toBeVisible();
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  expect(fetcher.mock.calls.some(([url]) => /\/(send|approve|answer)$/.test(String(url)))).toBe(
    false,
  );
  update({ streamTextTruncated: false });
  expect(screen.queryByText(dictionaries["zh-CN"].streamingReplyTruncated)).toBeNull();
  expect(screen.getByRole("article", { name: "当前实时回复" })).toHaveTextContent("Preview prefix");
  update({ streamTextTruncated: true, status: "idle" });
  expect(screen.queryByRole("article", { name: "当前实时回复" })).toBeNull();
});
