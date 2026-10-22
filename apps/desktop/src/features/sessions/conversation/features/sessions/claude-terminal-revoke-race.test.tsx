// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import type { SessionController } from "./use-session-controller";
import { ClaudeBridgePanel } from "./claude-bridge-panel";
import { claudeConnectionCopy } from "./claude-connection-copy";

const state = vi.hoisted(() => ({ session: {} as SessionController, request: vi.fn() }));
vi.mock("./session-context", () => ({ useSession: () => state.session }));
vi.mock("@/core/desktop", () => ({ desktopApi: () => ({ claude: { request: state.request } }) }));

const copy = claudeConnectionCopy["zh-CN"];
const runtimeBootId = "synthetic-runtime-boot";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function bridgeStatus(sessionId: string, connected: boolean) {
  return {
    sessionId,
    supported: true,
    connected,
    version: "2.1.301",
    pluginDirectory: "/synthetic/plugin",
    installInstructions: "Install synthetic plugin",
  };
}
function disconnectSnapshot() {
  state.session = {
    ...state.session,
    live: {
      ...state.session.live!,
      connectionGeneration: runtimeBootId,
      status: "unsupported",
      reason: "claude-bridge-disconnected",
    },
  };
}
function operations() {
  return state.request.mock.calls.map(([request]) => request.operation);
}
async function startDisconnect() {
  const acknowledgement = deferred<unknown>();
  let connected = true;
  state.request.mockImplementation(({ operation, sessionId }) => {
    if (operation === "bridge-status")
      return Promise.resolve(bridgeStatus(sessionId, sessionId === "s" && connected));
    connected = false;
    return acknowledgement.promise;
  });
  const view = render(<ClaudeBridgePanel active />);
  await act(async () => {});
  expect(screen.getByText(copy.connectedTitle)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: copy.disconnectShort }));
  fireEvent.click(screen.getByRole("button", { name: copy.confirmDisconnect }));
  expect(operations()).toEqual(["bridge-status", "bridge-disconnect"]);
  return { view, acknowledgement };
}
function expectRevocationSettled() {
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText(copy.connectedTitle)).not.toBeInTheDocument();
  expect(screen.queryByText(copy.connectedBadge, { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: copy.clearConnection })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: copy.disconnectShort })).not.toBeInTheDocument();
}

beforeAll(() => initializeI18n("zh-CN"));
beforeEach(() => {
  vi.useFakeTimers();
  state.request.mockReset();
  state.session = {
    selected: "s",
    current: { id: "s", title: "合成撤销时序测试", agent: "claude-code" },
    locale: "zh-CN",
    access: {
      status: "approved",
      protocolVersion: 2,
      experimentalEnabled: true,
      device: { manage: true },
    },
    online: true,
    controlReady: true,
    busy: false,
    live: {
      sessionId: "s",
      status: "idle",
      executionMode: "claude-follower",
      runtimeBootId,
      connectionGeneration: "synthetic-lease-a",
    },
    refresh: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionController;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("terminal revocation acknowledgement ordering", () => {
  it.each(["pending", "failed"] as const)(
    "does not revive a revoked binding when its boot snapshot precedes the ACK and refresh is %s",
    async (refreshOutcome) => {
      const refresh = vi.fn().mockResolvedValueOnce(undefined);
      // refresh handles its own read failures; a failed refresh can leave the
      // disconnected follower snapshot under its existing control fence.
      refresh.mockImplementationOnce(() =>
        refreshOutcome === "pending" ? deferred<void>().promise : Promise.resolve(),
      );
      state.session.refresh = refresh;
      const { view, acknowledgement } = await startDisconnect();
      disconnectSnapshot();
      state.session = { ...state.session, controlReady: false };
      view.rerender(<ClaudeBridgePanel active />);
      await act(async () => acknowledgement.resolve({ disconnected: true }));
      expect(refresh).toHaveBeenCalledTimes(2);
      expectRevocationSettled();
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(operations()).toEqual(["bridge-status", "bridge-disconnect"]);
      expectRevocationSettled();
    },
  );

  it.each(
    (["busy", "controlReady"] as const).flatMap((gate) =>
      (["before", "after"] as const).map((order) => ({ gate, order })),
    ),
  )(
    "preserves a new binding arriving $order the old ACK while $gate blocks status checks",
    async ({ gate, order }) => {
      const { view, acknowledgement } = await startDisconnect();
      disconnectSnapshot();
      state.session = {
        ...state.session,
        ...(gate === "busy" ? { busy: true } : { controlReady: false }),
      };
      view.rerender(<ClaudeBridgePanel active />);
      function connectNewLease() {
        state.session = {
          ...state.session,
          live: {
            ...state.session.live!,
            connectionGeneration: "synthetic-lease-b",
            status: "idle",
            reason: undefined,
          },
        };
        view.rerender(<ClaudeBridgePanel active />);
      }
      if (order === "before") connectNewLease();
      await act(async () => acknowledgement.resolve({ disconnected: true }));
      if (order === "after") connectNewLease();
      expect(screen.queryByText(copy.connectedTitle)).not.toBeInTheDocument();
      const clear = screen.getByRole("button", { name: copy.clearConnection });
      expect(clear).toBeEnabled();
      fireEvent.click(clear);
      expect(screen.getByRole("button", { name: copy.confirmClearConnection })).toBeEnabled();
      fireEvent.click(screen.getByText(copy.cancel, { selector: "button" }));
      disconnectSnapshot();
      view.rerender(<ClaudeBridgePanel active />);
      expect(screen.getByRole("button", { name: copy.clearConnection })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: copy.clearConnection }));
      expect(screen.getByRole("button", { name: copy.confirmClearConnection })).toBeEnabled();
      expect(operations()).toEqual(["bridge-status", "bridge-disconnect"]);
    },
  );

  it("ignores a late revocation ACK after switching to another session on the same runtime", async () => {
    const previousRefresh = state.session.refresh;
    const { view, acknowledgement } = await startDisconnect();
    const currentRefresh = vi.fn().mockResolvedValue(undefined);
    state.session = {
      ...state.session,
      selected: "other",
      current: { ...state.session.current!, id: "other" },
      live: {
        ...state.session.live!,
        sessionId: "other",
        connectionGeneration: runtimeBootId,
        status: "unsupported",
        reason: "claude-bridge-disconnected",
      },
      refresh: currentRefresh,
    };
    view.rerender(<ClaudeBridgePanel active />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: copy.clearConnection })).toBeEnabled();
    const previousOperations = operations();
    await act(async () => acknowledgement.resolve({ disconnected: true }));
    expect(screen.getByRole("button", { name: copy.clearConnection })).toBeEnabled();
    expect(screen.queryByText(copy.connectedTitle)).not.toBeInTheDocument();
    expect(operations()).toEqual(previousOperations);
    expect(previousRefresh).toHaveBeenCalledTimes(1);
    expect(currentRefresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: copy.clearConnection }));
    expect(screen.getByRole("button", { name: copy.confirmClearConnection })).toBeEnabled();
  });
});
