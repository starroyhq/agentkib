// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import type {
  LocalCostProvider,
  LocalCostSnapshot,
  LocalCostStatus,
  LocalCostUpdate,
} from "@/core/types";
import { useLocalCosts } from "./local-cost-query";
import { localCostFixture } from "./__fixtures__/local-cost";

const events = vi.hoisted(() => ({
  listener: undefined as ((update: LocalCostUpdate) => void) | undefined,
}));
vi.mock("@/core/api", () => ({
  api: {
    localCostSnapshot: vi.fn(),
    localCostStatus: vi.fn(),
    refreshLocalCost: vi.fn(),
    observeLocalCosts: vi.fn(),
  },
}));
vi.mock("@/core/desktop", () => ({
  desktopApi: () => ({
    events: {
      onLocalCostUpdated(listener: (update: LocalCostUpdate) => void) {
        events.listener = listener;
        return () => {
          events.listener = undefined;
        };
      },
    },
  }),
}));

function View({ provider }: { provider: LocalCostProvider }) {
  const costs = useLocalCosts(provider);
  return (
    <div>
      <span data-testid="provider">{costs.snapshot?.provider ?? "no snapshot"}</span>
      <span data-testid="version">{costs.snapshot?.data_version ?? "none"}</span>
      <span data-testid="state">{costs.status?.state}</span>
    </div>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const idle = (provider: LocalCostProvider): LocalCostStatus => ({
  provider,
  scope_key: `scope-${provider}`,
  state: "idle",
});

describe("local cost query isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.observeLocalCosts).mockResolvedValue(undefined);
    vi.mocked(api.localCostStatus).mockImplementation(async (provider) => idle(provider));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });
  afterEach(cleanup);

  it("keeps the selected provider isolated from a late previous-provider read", async () => {
    const first = deferred<LocalCostSnapshot>();
    vi.mocked(api.localCostSnapshot).mockImplementation((provider) =>
      provider === "codex" ? first.promise : Promise.resolve(localCostFixture("claude")),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <View provider="codex" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(api.observeLocalCosts).toHaveBeenCalledWith("codex"));
    view.rerender(
      <QueryClientProvider client={client}>
        <View provider="claude" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("provider").textContent).toBe("claude"));
    await act(async () => first.resolve(localCostFixture("codex")));
    expect(screen.getByTestId("provider").textContent).toBe("claude");
    expect(api.observeLocalCosts).toHaveBeenCalledWith(null);
    expect(api.observeLocalCosts).toHaveBeenLastCalledWith("claude");
    client.clear();
  });

  it("does not let an in-flight cached read overwrite a newer completion event", async () => {
    const pending = deferred<LocalCostSnapshot>();
    vi.mocked(api.localCostSnapshot).mockReturnValue(pending.promise);
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <View provider="codex" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(api.localCostSnapshot).toHaveBeenCalled());
    const next = { ...localCostFixture(), data_version: "v2" };
    await act(async () =>
      events.listener!({
        provider: "codex",
        snapshot: next,
        status: { ...idle("codex"), state: "succeeded", data_version: "v2" },
      }),
    );
    await waitFor(() => expect(screen.getByTestId("version").textContent).toBe("v2"));
    await act(async () => pending.resolve(localCostFixture()));
    expect(screen.getByTestId("version").textContent).toBe("v2");
    expect(api.localCostSnapshot).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it("removes old-scope aggregates while a changed log-root scope refreshes", async () => {
    vi.mocked(api.localCostSnapshot).mockResolvedValue(localCostFixture());
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <View provider="codex" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("version").textContent).toBe("v1"));
    vi.mocked(api.localCostSnapshot).mockResolvedValue(undefined);
    vi.mocked(api.localCostStatus).mockResolvedValue({
      ...idle("codex"),
      scope_key: "new-scope",
      state: "running",
    });
    await act(async () =>
      events.listener!({
        provider: "codex",
        status: { ...idle("codex"), scope_key: "new-scope", state: "running" },
      }),
    );
    await waitFor(() => expect(screen.getByTestId("version").textContent).toBe("none"));
    expect(screen.getByTestId("state").textContent).toBe("running");
    client.clear();
  });

  it("does not replace a newly read scope with a delayed old-scope cancellation", async () => {
    const current = { ...localCostFixture(), scope_key: "new-scope", data_version: "v2" };
    vi.mocked(api.localCostSnapshot).mockResolvedValue(current);
    vi.mocked(api.localCostStatus).mockResolvedValue({
      ...idle("codex"),
      scope_key: "new-scope",
      state: "succeeded",
      data_version: "v2",
    });
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <View provider="codex" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("version").textContent).toBe("v2"));
    await act(async () =>
      events.listener!({
        provider: "codex",
        snapshot: localCostFixture(),
        status: { ...idle("codex"), state: "cancelled" },
      }),
    );
    await waitFor(() => expect(api.localCostStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("version").textContent).toBe("v2");
    expect(screen.getByTestId("state").textContent).toBe("succeeded");
    client.clear();
  });

  it("releases the page observer when hidden and resumes the selected provider on return", async () => {
    vi.mocked(api.localCostSnapshot).mockResolvedValue(undefined);
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <View provider="codex" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(api.observeLocalCosts).toHaveBeenCalledWith("codex"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(api.observeLocalCosts).toHaveBeenLastCalledWith(null);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(api.observeLocalCosts).toHaveBeenLastCalledWith("codex");
    view.unmount();
    expect(api.observeLocalCosts).toHaveBeenLastCalledWith(null);
    client.clear();
  });
});
