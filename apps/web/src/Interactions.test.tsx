import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WebClient, type Live, type UserQuestionRequest } from "@agentkib/web-client";
import { SessionApp } from "./App";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const question: UserQuestionRequest = {
  requestId: "q1",
  turnId: "t1",
  supported: true,
  questions: [
    {
      id: "choice",
      question: "选一个",
      options: [{ label: "甲" }, { label: "乙" }],
      multiSelect: false,
      allowCustom: false,
    },
  ],
};
async function setup(send = true, initial?: Live) {
  let state: Live = initial ?? {
    sessionId: "s",
    status: "awaiting-input",
    turnId: "t1",
    revision: 1,
    sendEnabled: false,
    approvals: [],
    questions: [question],
  };
  let callbacks: Parameters<WebClient["stream"]>[1] | undefined;
  vi.spyOn(WebClient.prototype, "access").mockResolvedValue({
    status: "approved",
    csrfToken: "c",
    bootId: "b",
    experimentalEnabled: true,
    device: { id: "browser", name: "test", send, approve: !!initial?.approvals.length },
  });
  vi.spyOn(WebClient.prototype, "catalog").mockResolvedValue({
    indexEnabled: true,
    workspaces: [{ id: "w", name: "test", path: "/test" }],
    sessions: [
      {
        id: "s",
        workspace_id: "w",
        agent: "claude-code",
        title: "测试",
        availability: "readable",
        archived: false,
        sidechain: false,
      },
    ],
  });
  vi.spyOn(WebClient.prototype, "events").mockResolvedValue({ events: [], warnings: [] });
  vi.spyOn(WebClient.prototype, "live").mockImplementation(async () => state);
  vi.spyOn(WebClient.prototype, "stream").mockImplementation((_id, handlers) => {
    callbacks = handlers;
    return () => {};
  });
  const request = vi.spyOn(WebClient.prototype, "request").mockResolvedValue({});
  render(<SessionApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Claude Code · 测试" }));
  await waitFor(() => expect(callbacks).toBeDefined());
  return {
    request,
    update(next: Live) {
      state = next;
      act(() => callbacks!.event("snapshot", JSON.stringify(next)));
    },
  };
}
it("opens once, dismisses without answering and permits reopening", async () => {
  const { request } = await setup();
  expect(await screen.findByRole("dialog", { name: "需要你的回答" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "需要你的回答" }));
  fireEvent.click(screen.getByLabelText("甲"));
  fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "answer",
      expect.objectContaining({ questionId: "q1", turnId: "t1", answers: { choice: ["甲"] } }),
    ),
  );
});
it.each(["answer", "approve"] as const)(
  "clears %s receipt when first refreshed snapshot is completed",
  async (kind) => {
    const initial: Live = {
      sessionId: "s",
      status: "waiting-question",
      revision: 1,
      sendEnabled: false,
      approvals:
        kind === "approve"
          ? [
              {
                requestId: "a",
                turnId: "t1",
                method: "claude/can_use_tool",
                toolName: "Bash",
                input: { command: "/usr/bin/true" },
                supported: true,
                availableDecisions: ["allow", "deny"],
              },
            ]
          : [],
      questions: kind === "answer" ? [question] : [],
    };
    const { request, update } = await setup(true, initial);
    await screen.findByRole("dialog");
    request.mockImplementationOnce(async () => {
      update({
        sessionId: "s",
        turnId: "t1",
        status: "idle",
        revision: 2,
        sendEnabled: true,
        approvals: [],
        questions: [],
      });
      return {};
    });
    if (kind === "answer") {
      fireEvent.click(screen.getByLabelText("甲"));
      fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    } else fireEvent.click(screen.getByRole("button", { name: /允许/ }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.queryByText("请求已接收，不代表执行完成。")).not.toBeInTheDocument(),
    );
  },
);
it("invalidates an open form on cancellation", async () => {
  const { update, request } = await setup();
  await screen.findByRole("dialog");
  update({
    sessionId: "s",
    status: "idle",
    revision: 2,
    sendEnabled: true,
    approvals: [],
    questions: [],
  });
  expect(screen.getByRole("button", { name: "提交回答" })).toBeDisabled();
  expect(request).not.toHaveBeenCalled();
});
it("does not auto-open without send permission", async () => {
  await setup(false);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "需要你的回答" }));
  expect(screen.getByRole("button", { name: "提交回答" })).toBeDisabled();
});
