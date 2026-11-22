// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  pendingScope,
  readPending,
  SessionReceiptRecovery,
  type SessionReceiptRecoveryProps,
} from "@agentkib/session-ui";
import { ApiError, type ManagedActionBody, type ManagedActionResult } from "@agentkib/web-client";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "../../desktop-reader-test-utils";

function createSession() {
  return {
    origin: "",
    selected: "session",
    current: { id: "session", agent: "claude-code" },
    live: {
      sessionId: "session",
      executionMode: "external",
      status: "idle",
    },
    capabilities: {
      sessionId: "session",
      features: { reconcile: { available: false } },
    },
    access: {
      status: "approved",
      protocolVersion: 2,
      bootId: "boot",
      experimentalEnabled: true,
      device: { id: "desktop", manage: true, send: true },
    },
    client: {
      managedAction:
        vi.fn<(action: string, body: ManagedActionBody) => Promise<ManagedActionResult>>(),
      receipt: vi.fn(async (requestId: string) => ({ found: false, requestId })),
    },
    online: true,
    busy: false,
    locale: "en-US",
    refresh: vi.fn(async () => {}),
  };
}
let session: ReturnType<typeof createSession>;
const panel = (active: boolean) => (
  <SessionReceiptRecovery
    session={session as unknown as SessionReceiptRecoveryProps["session"]}
    renderContent={(children) => (active ? <section>{children}</section> : null)}
  />
);
describe("desktop Claude execution outcome recovery", () => {
  beforeEach(() => {
    sessionStorage.clear();
    session = createSession();
  });
  afterEach(cleanup);
  it("checks an uncertain Claude execution from session actions with a durable request", async () => {
    session.live.executionMode = "claude-managed";
    session.live.status = "outcome-unknown";
    // Desktop keeps its host management grant even if this device cannot send.
    session.access.device.send = false;
    session.capabilities.features.reconcile.available = true;
    const scope = pendingScope(session.origin, session.access.device.id);
    let finish!: (result: ManagedActionResult) => void;
    session.client.managedAction.mockImplementation((_action, body) => {
      expect(readPending(scope)).toMatchObject([{ requestId: body.requestId, kind: "reconcile" }]);
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    render(panel(true));
    const button = screen.getByRole("button", { name: "Reconcile outcome" });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(session.client.managedAction).toHaveBeenCalledExactlyOnceWith("reconcile", {
      agent: "claude-code",
      sessionId: session.selected,
      bootId: session.access.bootId,
      requestId: expect.any(String),
    });
    await act(async () =>
      finish({
        accepted: true,
        reconciled: true,
        requestId: session.client.managedAction.mock.calls[0]?.[1].requestId,
        sessionId: session.selected,
      }),
    );
    expect(readPending(scope)).toEqual([]);
    expect(session.refresh).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("checks only the saved receipt after a reconciliation response is lost", async () => {
    session.live.executionMode = "claude-managed";
    session.live.status = "outcome-unknown";
    session.capabilities.features.reconcile.available = true;
    const scope = pendingScope(session.origin, session.access.device.id);
    session.client.managedAction.mockRejectedValue(new ApiError(503, "outcome_unknown", "unknown"));
    render(panel(true));
    fireEvent.click(screen.getByRole("button", { name: "Reconcile outcome" }));
    const [{ requestId: sent }] = readPending(scope);
    await waitFor(() => expect(session.client.receipt).toHaveBeenCalledWith(sent));
    expect(screen.getByRole("button", { name: "Reconcile outcome" })).toBeDisabled();
    expect(readPending(scope)).toMatchObject([{ requestId: sent, kind: "reconcile" }]);
    expect(session.client.managedAction).toHaveBeenCalledOnce();
  });
  it("clears a structured rejection when the host did not admit reconciliation", async () => {
    session.live.executionMode = "claude-managed";
    session.live.status = "outcome-unknown";
    session.capabilities.features.reconcile.available = true;
    const scope = pendingScope(session.origin, session.access.device.id);
    session.client.managedAction.mockImplementation(async (_action, body) => ({
      accepted: false,
      completed: false,
      controlOutcome: "not-dispatched",
      requestId: body.requestId,
      sessionId: body.sessionId,
      reason: "web-busy",
    }));
    render(panel(true));
    const button = screen.getByRole("button", { name: "Reconcile outcome" });
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("web-busy");
    expect(readPending(scope)).toEqual([]);
    expect(button).toBeEnabled();
    expect(session.client.managedAction).toHaveBeenCalledOnce();
    expect(session.client.receipt).not.toHaveBeenCalled();
  });
});
