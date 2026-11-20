// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HistorySearchStatus } from "@agentkib/web-client";
import { initializeI18n } from "@/core/i18n";
import type {
  DesktopConversationBridge,
  DesktopConversationResponse,
} from "@/core/conversation-bridge";
import { HistorySearchSettings } from "./HistorySearchSettings";

const status = (enabled: boolean, bytes: number): HistorySearchStatus => ({
  enabled,
  bytes,
  generation: String(bytes),
  limitBytes: 4096,
  budgetExceeded: false,
  coverage: {
    total: 1,
    ready: 1,
    building: 0,
    partial: 0,
    stale: 0,
    unavailable: 0,
    limitations: [],
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
}
const previous = window.desktopConversation;
beforeAll(() => initializeI18n("en-US"));
afterEach(() => {
  cleanup();
  window.desktopConversation = previous;
  vi.useRealTimers();
});
function fixture() {
  const pending = deferred<DesktopConversationResponse>();
  let reads = 0;
  const bridge: DesktopConversationBridge = {
    request: vi.fn(async (path, body) => {
      if (path === "access")
        return {
          status: 200,
          body: {
            protocolVersion: 2,
            status: "approved",
            csrfToken: "test",
            bootId: "boot",
            historySearch: true,
          },
        };
      if (path === "history/status")
        return ++reads === 1 ? { status: 200, body: status(true, 1024) } : pending.promise;
      if (path === "history/configure")
        return { status: 200, body: status((body as { enabled: boolean }).enabled, 0) };
      return { status: 200, body: status(true, 0) };
    }),
    cancelRead: vi.fn(async () => {}),
    upload: vi.fn(),
    subscribe: vi.fn(),
    acknowledge: vi.fn(),
    unsubscribe: vi.fn(),
    onEvent: vi.fn(),
    onUnavailable: vi.fn(),
    onControlChanged: vi.fn(),
  };
  window.desktopConversation = bridge;
  return { bridge, pending };
}
describe("content search settings with the real desktop client", () => {
  const actions = [
    { label: "Disable and clear index", operationPath: "history/configure" },
    { label: "Clear index", operationPath: "history/clear" },
    { label: "Rebuild index", operationPath: "history/rebuild" },
  ];
  it.each(actions)(
    "keeps $label authoritative when an older poll settles",
    async ({ label, operationPath }) => {
      vi.useFakeTimers();
      const { bridge, pending } = fixture();
      const mutation = deferred<void>();
      const respond = vi.mocked(bridge.request).getMockImplementation()!;
      vi.mocked(bridge.request).mockImplementation(async (path, body, id) => {
        if (path === operationPath) await mutation.promise;
        return respond(path, body, id);
      });
      render(<HistorySearchSettings />);
      await act(async () => {});
      expect(screen.getByText("1 / 4 KiB")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      const request = vi
        .mocked(bridge.request)
        .mock.calls.filter(([path]) => path === "history/status")
        .at(-1)!;
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: label }));
      });
      expect(bridge.cancelRead).toHaveBeenCalledWith(request[2]);
      for (const action of actions) {
        const button = screen.getByRole<HTMLButtonElement>("button", { name: action.label });
        expect(button.disabled).toBe(true);
        expect(button.getAttribute("title")).toBe("Loading…");
        expect(button.getAttribute("aria-busy")).toBe(action.label === label ? "true" : null);
        expect(Boolean(button.querySelector('svg[aria-hidden="true"]'))).toBe(
          action.label === label,
        );
      }
      expect(screen.queryByText("Loading…")).toBeNull();
      await act(async () => mutation.resolve(undefined));
      expect(screen.queryByRole("button", { busy: true })).toBeNull();
      expect(screen.getByText("0 / 4 KiB")).toBeTruthy();
      await act(async () => {
        pending.resolve({ status: 200, body: status(true, 4096) });
      });
      expect(screen.getByText("0 / 4 KiB")).toBeTruthy();
      const toggle = screen.getByRole("button", {
        name:
          operationPath === "history/configure"
            ? "Enable content indexing"
            : "Disable and clear index",
      }) as HTMLButtonElement;
      expect(toggle.disabled).toBe(false);
      expect(toggle.title).toBe("");
    },
  );
  it("can clear and rebuild a damaged cache when its initial status is unavailable", async () => {
    const { bridge } = fixture();
    const request = vi.mocked(bridge.request).getMockImplementation()!;
    vi.mocked(bridge.request).mockImplementation((path, body, id) =>
      path === "history/status"
        ? Promise.resolve({ status: 410, body: { error: "history-search-cache-unavailable" } })
        : request(path, body, id),
    );
    render(<HistorySearchSettings />);
    await act(async () => {});
    expect(screen.getByRole("alert")).toBeTruthy();
    const clear = screen.getByRole("button", { name: "Clear index" }) as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(clear);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("0 / 4 KiB")).toBeTruthy();
    const rebuild = screen.getByRole("button", { name: "Rebuild index" }) as HTMLButtonElement;
    expect(rebuild.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(rebuild);
    });
    expect(bridge.request).toHaveBeenCalledWith("history/clear", {});
    expect(bridge.request).toHaveBeenCalledWith("history/rebuild", {});
  });
  it("cancels an unfinished initial status read when settings closes", async () => {
    const { bridge, pending } = fixture();
    const request = vi.mocked(bridge.request).getMockImplementation()!;
    vi.mocked(bridge.request).mockImplementation((path, body, id) =>
      path === "history/status" ? pending.promise : request(path, body, id),
    );
    const view = render(<HistorySearchSettings />);
    await act(async () => {});
    const read = vi.mocked(bridge.request).mock.calls.find(([path]) => path === "history/status")!;
    view.unmount();
    expect(bridge.cancelRead).toHaveBeenCalledExactlyOnceWith(read[2]);
    await act(async () => {
      pending.resolve({ status: 200, body: status(true, 4096) });
    });
    expect(screen.queryByText("4 / 4 KiB")).toBeNull();
  });
});
