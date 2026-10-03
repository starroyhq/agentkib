// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import type { RefreshJobStatus } from "@/core/types";
import {
  useInsightsQueryEvents,
  useInsightsRefreshJob,
  useInsightsRefreshMutation,
  useInsightsView,
} from "./insights-query";

const events = vi.hoisted(() => ({
  refresh: undefined as ((status: unknown) => void) | undefined,
}));
vi.mock("@/core/api", () => ({
  api: { insightsView: vi.fn(), refreshStatus: vi.fn(), requestRefresh: vi.fn() },
}));
vi.mock("@/core/desktop", () => ({
  desktopApi: () => ({
    events: {
      onRefreshState: (listener: (status: unknown) => void) => {
        events.refresh = listener;
        return () => (events.refresh = undefined);
      },
    },
  }),
}));

const succeeded = {
  kind: "insights",
  state: "succeeded",
  request_id: "previous",
} as unknown as RefreshJobStatus;
const handles: { mutate?: () => Promise<unknown> } = {};

function Page() {
  // 与路由 + 页面一致：两处各挂一个 refresh job 观察者。
  useInsightsRefreshJob();
  useInsightsRefreshJob();
  useInsightsView({ from: "2026-01-01", to: "2026-03-01" });
  const { mutateAsync } = useInsightsRefreshMutation();
  useEffect(() => {
    handles.mutate = mutateAsync;
  });
  return null;
}
function Bridge({ children }: { children: ReactNode }) {
  useInsightsQueryEvents();
  return children;
}

describe("insights query invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.insightsView).mockResolvedValue({} as never);
    vi.mocked(api.refreshStatus).mockResolvedValue([succeeded]);
  });
  afterEach(cleanup);

  it("refetches the view once per successful refresh and not merely on mount", async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <Bridge>
          <Page />
        </Bridge>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(api.refreshStatus).toHaveBeenCalled());
    await act(async () => {});
    // 上一次刷新早已成功：挂载时不能因此再失效一次。
    expect(api.insightsView).toHaveBeenCalledTimes(1);

    const done = { ...succeeded, request_id: "manual" };
    vi.mocked(api.requestRefresh).mockImplementation(async () => {
      // 主进程在 invoke 返回前就发出了成功事件。
      events.refresh?.(done);
      return { kind: "insights", disposition: "queued", request_id: "manual", status: done };
    });
    await act(async () => {
      await handles.mutate!();
    });
    await waitFor(() => expect(api.insightsView).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(api.insightsView).toHaveBeenCalledTimes(2);
    expect(api.refreshStatus).toHaveBeenCalledTimes(1);
  });
});
