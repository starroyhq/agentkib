// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { api } from "@/core/api";
import type { CursorBridgeResponse, CursorBridgeStatus, WorkspaceSummary } from "@/core/types";
import { CursorBridgePanel } from "./CursorBridgePanel";

vi.mock("@/core/api", () => ({
  api: { cursorBridge: vi.fn(), cursorBridgeBundle: vi.fn(), revealCursorBridgeBundle: vi.fn() },
}));
const workspace = {
  id: "local-workspace",
  path: "/synthetic/workspace",
  name: "synthetic",
} as WorkspaceSummary;
const offline = {
  id: "existing-binding",
  profile: "explicit-profile",
  version: "3.22.12",
  connected: false,
};
const challenge = "synthetic-one-time-code";
const other = { ...offline, id: "other-binding", profile: "other-profile" };
const status: CursorBridgeStatus = {
  supported: true,
  supportedVersions: ["3.22.12", "3.23.12"],
  bindings: [offline, other],
};
function panel(bindingId = offline.id) {
  return (
    <CursorBridgePanel
      workspace={workspace}
      bindingId={bindingId}
      disabled={false}
      onBindingChange={vi.fn()}
      onStatusChange={vi.fn()}
    />
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}
describe("Cursor bridge connection UI", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.mocked(api.cursorBridge)
      .mockReset()
      .mockImplementation(async (request) =>
        request.action === "connect"
          ? { challenge, expires_in_seconds: 1 }
          : { supported: true, supportedVersions: ["3.22.12", "3.23.12"], bindings: [offline] },
      );
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it("reconnects the selected binding and removes an expired one-time code", async () => {
    render(
      <CursorBridgePanel
        workspace={workspace}
        bindingId={offline.id}
        disabled={false}
        onBindingChange={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );
    const reconnect = await screen.findByRole("button", { name: "Reconnect selected window" });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(reconnect);
    });
    expect(api.cursorBridge).toHaveBeenCalledWith({
      action: "connect",
      workspaceId: workspace.id,
      bindingId: offline.id,
    });
    expect(screen.getByRole("textbox", { name: "One-time local connection code" })).toHaveValue(
      challenge,
    );
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByRole("textbox", { name: "One-time local connection code" })).toBeNull();
  });
  it.each(["succeeds", "fails"])(
    "removes a revoked reconnect code before the subsequent refresh %s",
    async (refreshOutcome) => {
      const disconnect = deferred<CursorBridgeResponse>();
      const refresh = deferred<CursorBridgeStatus>();
      let statusReads = 0;
      vi.mocked(api.cursorBridge).mockImplementation((request) => {
        if (request.action === "connect")
          return Promise.resolve({ challenge, expires_in_seconds: 120 });
        if (request.action === "disconnect") return disconnect.promise;
        return statusReads++ === 0 ? Promise.resolve(status) : refresh.promise;
      });
      const view = render(panel());
      const reconnect = await screen.findByRole("button", { name: "Reconnect selected window" });
      vi.useFakeTimers();
      await act(async () => {
        fireEvent.click(reconnect);
      });
      expect(screen.getByRole("textbox", { name: "One-time local connection code" })).toHaveValue(
        challenge,
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Disconnect selected window" }));
      });
      expect(api.cursorBridge).toHaveBeenLastCalledWith({
        action: "disconnect",
        workspaceId: workspace.id,
        bindingId: offline.id,
      });
      expect(screen.getByRole("textbox", { name: "One-time local connection code" })).toHaveValue(
        challenge,
      );
      expect(screen.getByRole("button", { name: "Copy connection code" })).toBeDisabled();
      view.rerender(panel(other.id));
      await act(async () => {
        disconnect.resolve({ disconnected: true });
      });
      expect(screen.queryByRole("textbox", { name: "One-time local connection code" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Copy connection code" })).toBeNull();
      expect(screen.queryByText(/Expires in \d+ seconds/)).toBeNull();
      expect(screen.getByRole("button", { name: "Refresh connections" })).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      expect(statusReads).toBe(2);
      await act(async () => {
        if (refreshOutcome === "succeeds") refresh.resolve(status);
        else refresh.reject(new Error("Synthetic refresh failed"));
      });
      expect(screen.getByRole("button", { name: "Refresh connections" })).toBeEnabled();
      expect(screen.queryByRole("textbox", { name: "One-time local connection code" })).toBeNull();
      if (refreshOutcome === "fails")
        expect(screen.getByRole("alert")).toHaveTextContent("Synthetic refresh failed");
    },
  );
  it("keeps a valid reconnect code when disconnect fails", async () => {
    const disconnect = deferred<CursorBridgeResponse>();
    vi.mocked(api.cursorBridge).mockImplementation((request) => {
      if (request.action === "connect")
        return Promise.resolve({ challenge, expires_in_seconds: 120 });
      if (request.action === "disconnect") return disconnect.promise;
      return Promise.resolve(status);
    });
    render(panel());
    const reconnect = await screen.findByRole("button", { name: "Reconnect selected window" });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(reconnect);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Disconnect selected window" }));
    });
    await act(async () => {
      disconnect.reject(new Error("Synthetic disconnect failed"));
    });
    expect(screen.getByRole("textbox", { name: "One-time local connection code" })).toHaveValue(
      challenge,
    );
    expect(screen.getByRole("button", { name: "Copy connection code" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Synthetic disconnect failed");
    expect(api.cursorBridge).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole("textbox", { name: "One-time local connection code" })).toHaveValue(
      challenge,
    );
    expect(api.cursorBridge).toHaveBeenLastCalledWith({
      action: "status",
      workspaceId: workspace.id,
    });
  });
  it.each(["reconnect", "first connection"])(
    "keeps a %s code when disconnecting another binding",
    async (connection) => {
      vi.mocked(api.cursorBridge).mockImplementation(async (request) => {
        if (request.action === "connect") return { challenge, expires_in_seconds: 120 };
        if (request.action === "disconnect") return { disconnected: true };
        return status;
      });
      const view = render(panel());
      await screen.findByRole("button", { name: "Reconnect selected window" });
      vi.useFakeTimers();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name:
              connection === "reconnect" ? "Reconnect selected window" : "Connect a Cursor window",
          }),
        );
      });
      expect(api.cursorBridge).toHaveBeenLastCalledWith({
        action: "connect",
        workspaceId: workspace.id,
        ...(connection === "reconnect" ? { bindingId: offline.id } : {}),
      });
      view.rerender(panel(other.id));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Disconnect selected window" }));
      });
      expect(api.cursorBridge).toHaveBeenCalledWith({
        action: "disconnect",
        workspaceId: workspace.id,
        bindingId: other.id,
      });
      expect(screen.getByRole("textbox", { name: "One-time local connection code" })).toHaveValue(
        challenge,
      );
      expect(screen.getByRole("button", { name: "Copy connection code" })).toBeEnabled();
    },
  );
  it("does not contact a local bridge for a remote workspace", async () => {
    render(
      <CursorBridgePanel
        workspace={{ ...workspace, remote: {} as NonNullable<WorkspaceSummary["remote"]> }}
        bindingId=""
        disabled={false}
        onBindingChange={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Connect Cursor from a local workspace on this computer."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect a Cursor window" })).toBeDisabled();
    await act(async () => {});
    expect(api.cursorBridge).not.toHaveBeenCalled();
  });
  it("never chooses a profile automatically when connection status arrives", async () => {
    const onBindingChange = vi.fn();
    const onStatusChange = vi.fn();
    vi.mocked(api.cursorBridge).mockResolvedValue({
      supported: true,
      supportedVersions: ["3.22.12", "3.23.12"],
      bindings: [{ ...offline, connected: true }],
    });
    render(
      <CursorBridgePanel
        workspace={workspace}
        bindingId=""
        disabled={false}
        onBindingChange={onBindingChange}
        onStatusChange={onStatusChange}
      />,
    );
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenCalledWith(
        expect.objectContaining({ bindings: expect.any(Array) }),
      ),
    );
    expect(onBindingChange).not.toHaveBeenCalled();
    expect(screen.getByText("Choose the intended profile and window")).toBeVisible();
  });
});
