// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
