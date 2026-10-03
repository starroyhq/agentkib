// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import type { WorkspaceOpener, WorkspaceSummary } from "@/core/types";
import { WorkspaceOpenWith } from "./WorkspaceOpenWith";

vi.mock("@/core/api", () => ({
  api: { workspaceOpeners: vi.fn(), openWorkspaceWithApp: vi.fn() },
}));

const workspace = (id: string) => ({ id, name: id, path: `/${id}` }) as WorkspaceSummary;
const opener = (id: string, preferred = false) =>
  ({ id, name: id, category: "editor", preferred }) as WorkspaceOpener;

function renderOpenWith(id: string, client: QueryClient, onError = vi.fn()) {
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceOpenWith workspace={workspace(id)} onError={onError} />
    </QueryClientProvider>,
  );
}

describe("WorkspaceOpenWith", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("shows the preferred opener for each workspace without leaking the previous one", async () => {
    vi.mocked(api.workspaceOpeners).mockImplementation(async (id) =>
      id === "a" ? [opener("Editor A", true)] : [opener("Editor B", true)],
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = renderOpenWith("a", client);
    expect(await screen.findByText("Editor A")).toBeTruthy();

    view.rerender(
      <QueryClientProvider client={client}>
        <WorkspaceOpenWith workspace={workspace("b")} onError={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.queryByText("Editor A")).toBeNull();
    expect(await screen.findByText("Editor B")).toBeTruthy();
  });

  it("reports load failures through onError", async () => {
    vi.mocked(api.workspaceOpeners).mockImplementation(async () => {
      throw new Error("no openers");
    });
    const onError = vi.fn();
    renderOpenWith(
      "a",
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      onError,
    );
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(String(onError.mock.calls.at(-1)?.[0])).toContain("no openers");
  });
});
