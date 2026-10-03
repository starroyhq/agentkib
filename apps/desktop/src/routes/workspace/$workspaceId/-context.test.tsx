// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type { ContextPreview } from "@/core/types";
import { ContextPage } from "./context";

vi.mock("@/core/api", () => ({ api: { context: vi.fn() } }));

const preview = (skill: string) =>
  ({
    sections: [],
    warnings: [],
    visible_skills: [skill],
    visible_connections: [],
    approved_memories: [],
  }) as unknown as ContextPreview;

describe("ContextPage", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("debounces working directory edits and keeps the previous preview while resolving", async () => {
    vi.mocked(api.context).mockImplementation(async (_project, cwd) =>
      preview(cwd === "/repo" ? "root-skill" : "nested-skill"),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ContextPage project="/repo" onOpenInstructions={() => undefined} />
      </QueryClientProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("root-skill")).toBeTruthy();

    const input = screen.getByLabelText(tr("context.workingDirectory"));
    fireEvent.change(input, { target: { value: "/repo/a" } });
    fireEvent.change(input, { target: { value: "/repo/app" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // 防抖期间既不发请求，也不丢掉已有结果。
    expect(api.context).toHaveBeenCalledTimes(1);
    expect(screen.getByText("root-skill")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(api.context).toHaveBeenCalledTimes(2);
    expect(api.context).toHaveBeenLastCalledWith("/repo", "/repo/app", "codex");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("nested-skill")).toBeTruthy();
    expect(screen.queryByText("root-skill")).toBeNull();
  });
});
