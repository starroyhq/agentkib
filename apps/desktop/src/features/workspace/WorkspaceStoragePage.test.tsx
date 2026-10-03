// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import type { RefreshJobStatus, StorageOverview } from "@/core/types";
import { homeKeys } from "@/features/home/home-query";
import { WorkspaceStoragePage } from "./WorkspaceStoragePage";

vi.mock("@/core/api", () => ({ api: { storageOverview: vi.fn(), requestRefresh: vi.fn() } }));

describe("WorkspaceStoragePage", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("reads the overview through the shared home query so storage job events can refresh it", async () => {
    vi.mocked(api.storageOverview).mockImplementation(async () => {
      throw new Error("storage unavailable");
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <WorkspaceStoragePage workspaces={[]} job={undefined as RefreshJobStatus | undefined} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/storage unavailable/)).toBeTruthy();
    expect(api.storageOverview).toHaveBeenCalledOnce();

    vi.mocked(api.storageOverview).mockResolvedValue({
      workspaces: [],
    } as unknown as StorageOverview);
    await client.invalidateQueries({ queryKey: homeKeys.all });
    await waitFor(() => expect(api.storageOverview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/storage unavailable/)).toBeNull());
  });
});
