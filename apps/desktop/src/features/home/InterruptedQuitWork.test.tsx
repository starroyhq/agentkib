// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { REMOTE_ERROR_CODES as codes } from "@agentkib/runtime-protocol";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import { InterruptedQuitWork } from "./InterruptedQuitWork";

vi.mock("@/core/api", () => ({
  api: { interruptedQuitWork: vi.fn(), resumeInterruptedQuitWork: vi.fn() },
}));
vi.mock("@/features/sessions/conversation-catalog", () => ({
  refreshConversationCatalog: async () => undefined,
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("offers one manual continuation and disables unconfirmed work", async () => {
  await initializeI18n("en-US");
  const interrupted = {
    id: "work",
    sessionId: "session",
    agent: "claude",
    title: "Fix login",
    resumable: true,
    status: "interrupted",
  } as const;
  const unknown = {
    ...interrupted,
    id: "unknown-work",
    title: "Check deployment",
    status: "unknown",
  } as const;
  vi.mocked(api.interruptedQuitWork)
    .mockResolvedValueOnce([interrupted, unknown])
    .mockResolvedValue([unknown]);
  vi.mocked(api.resumeInterruptedQuitWork).mockResolvedValue({ outcome: "continued" });
  const query = new QueryClient();
  render(
    <QueryClientProvider client={query}>
      <InterruptedQuitWork onOpenSession={vi.fn()} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Interrupted on quit")).toBeVisible();
  const [resume, blocked] = screen.getAllByRole("button", { name: "Continue" });
  expect(resume).toBeEnabled();
  expect(blocked).toBeDisabled();
  fireEvent.click(resume);
  await waitFor(() => expect(screen.queryByText("Fix login")).toBeNull());
  expect(api.resumeInterruptedQuitWork).toHaveBeenCalledExactlyOnceWith("work");
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
});

it("opens the original session for a manual-only task without sending a message", async () => {
  await initializeI18n("en-US");
  vi.mocked(api.interruptedQuitWork).mockResolvedValue([
    {
      id: "manual-work",
      sessionId: "original-session",
      agent: "deepseek-harness",
      title: "Check tests",
      resumable: false,
      status: "interrupted",
      openSession: true,
    },
  ]);
  const onOpenSession = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <InterruptedQuitWork onOpenSession={onOpenSession} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open session" }));
  expect(onOpenSession).toHaveBeenCalledExactlyOnceWith("original-session");
  expect(api.resumeInterruptedQuitWork).not.toHaveBeenCalled();
});

it("refreshes an unreadable task list without submitting a continuation", async () => {
  await initializeI18n("en-US");
  vi.mocked(api.interruptedQuitWork)
    .mockRejectedValueOnce(new Error("Untrusted raw error"))
    .mockResolvedValue([]);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <InterruptedQuitWork onOpenSession={vi.fn()} />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("status")).toHaveTextContent("Tasks unavailable");
  expect(screen.queryByText("Untrusted raw error")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(api.resumeInterruptedQuitWork).not.toHaveBeenCalled();
});

it("keeps a task with a lost continuation reply disabled across a stale list read", async () => {
  await initializeI18n("en-US");
  vi.mocked(api.interruptedQuitWork).mockResolvedValue([
    {
      id: "work",
      sessionId: "session",
      agent: "codex",
      title: "Fix login",
      status: "interrupted",
      resumable: true,
    },
  ]);
  vi.mocked(api.resumeInterruptedQuitWork).mockRejectedValue(new Error("reply lost"));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <InterruptedQuitWork onOpenSession={vi.fn()} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  expect(await screen.findByText("Result unconfirmed")).toBeVisible();
  await waitFor(() => expect(api.interruptedQuitWork).toHaveBeenCalledTimes(2));
  const button = screen.getByRole("button", { name: "Continue" });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(api.resumeInterruptedQuitWork).toHaveBeenCalledExactlyOnceWith("work");
});

it("offers the original session when the continuation reached Claude and its queue did not resume", async () => {
  await initializeI18n("en-US");
  vi.mocked(api.interruptedQuitWork)
    .mockResolvedValueOnce([
      {
        id: "work",
        sessionId: "session",
        agent: "claude-code",
        title: "Fix login",
        status: "interrupted",
        resumable: true,
      },
    ])
    .mockResolvedValue([]);
  vi.mocked(api.resumeInterruptedQuitWork).mockResolvedValue({
    outcome: "continued",
    queueRestoreReason: codes.quitWorkQueueRestoreFailed,
  });
  const open = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <InterruptedQuitWork onOpenSession={open} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Queue still paused");
  fireEvent.click(screen.getByRole("button", { name: "Open session" }));
  expect(open).toHaveBeenCalledExactlyOnceWith("session");
  expect(api.resumeInterruptedQuitWork).toHaveBeenCalledExactlyOnceWith("work");
});
