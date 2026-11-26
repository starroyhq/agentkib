// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { publishSessionInvalidation } from "@agentkib/conversation-state";
import {
  pendingScope,
  readPending,
  rememberPending,
  SessionReceiptRecovery,
  type InteractionLocale,
  type SessionReceiptRecoveryProps,
} from "@agentkib/session-ui";
import type {
  ManagedActionBody,
  ManagedActionResult,
  ManagedOptions,
  WebClient,
} from "@agentkib/web-client";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "../conversation/web-reader-test-utils";

const managementLocales = [
  {
    locale: "en-US",
    handoff: "Hand over to AgentKib",
    release: "Return to original client",
    notHandedOver: "This session has not been handed over to AgentKib",
    handedOver: "This session has been handed over to AgentKib",
    pending:
      "The last result is being checked. Wait before another operation. Refreshing won’t resend it.",
  },
  {
    locale: "zh-CN",
    handoff: "交给 AgentKib",
    release: "交还原客户端",
    notHandedOver: "此会话尚未交给 AgentKib",
    handedOver: "此会话已交给 AgentKib",
    pending: "上次操作结果待核对。请先核对再操作，刷新不会重发。",
  },
  {
    locale: "zh-Hant",
    handoff: "交給 AgentKib",
    release: "交還原客戶端",
    notHandedOver: "此對話尚未交給 AgentKib",
    handedOver: "此對話已交給 AgentKib",
    pending: "上次操作結果待核對。請先核對再操作，重新整理不會重送。",
  },
  {
    locale: "ja-JP",
    handoff: "AgentKib に引き渡す",
    release: "元のクライアントに引き渡す",
    notHandedOver: "この会話はまだ AgentKib に引き渡されていません",
    handedOver: "この会話は AgentKib に引き渡されています",
    pending: "前回の結果を確認中です。確認後に操作してください。更新しても再送信しません。",
  },
] as const;

const options: ManagedOptions = {
  available: true,
  workspaces: [{ id: "workspace", name: "Project" }],
  models: [],
};
function createSession() {
  return {
    origin: "",
    selected: "session",
    current: { id: "session", agent: "claude-code" },
    live: {
      sessionId: "session",
      executionMode: "external",
      connectionGeneration: undefined as string | undefined,
      status: "idle",
      reason: "handoff-required",
      activity: undefined as string | undefined,
      approvals: [] as unknown[],
      questions: [] as unknown[],
    },
    capabilities: {
      sessionId: "session",
      reason: undefined as string | undefined,
      features: { adopt: { available: true }, reconcile: { available: false } },
    },
    access: {
      status: "approved",
      protocolVersion: 2,
      bootId: "boot",
      experimentalEnabled: true,
      device: { id: "device", manage: true, send: true },
    },
    client: {
      managedAction:
        vi.fn<(action: string, body: ManagedActionBody) => Promise<ManagedActionResult>>(),
      request: vi.fn(async (path: string, _body?: unknown) =>
        path.startsWith("managed/options") ? options : { sessionId: "session" },
      ),
      managedInspect: vi.fn(async () => ({
        sessionId: "session",
        handoffFingerprint: "verified-history" as string | undefined,
      })),
      receipt: vi.fn<(...args: [string]) => Promise<unknown>>(async (requestId) => ({
        found: false,
        requestId,
      })),
    },
    online: true,
    controlReady: true,
    busy: false,
    notice: undefined as string | undefined,
    locale: "en-US" as InteractionLocale,
    refresh: vi.fn(async () => {}),
  };
}
let session: ReturnType<typeof createSession>;
const mutations = () =>
  session.client.request.mock.calls.filter(([path]) => !path.startsWith("managed/options"));
const requestId = "11111111-1111-4111-8111-111111111111";
const recovery = (renderContent: SessionReceiptRecoveryProps["renderContent"]) => (
  <SessionReceiptRecovery
    session={session as unknown as SessionReceiptRecoveryProps["session"]}
    renderContent={renderContent}
  />
);
const panel = (active: boolean) =>
  recovery((children) => (active ? <section>{children}</section> : null));
function save(kind: "adopt" | "release" | "reconcile" = "adopt") {
  const scope = pendingScope(session.origin, session.access.device.id);
  rememberPending(scope, { requestId, sessionId: session.selected, kind, agent: "claude-code" });
  return scope;
}
function invalidate() {
  act(() =>
    publishSessionInvalidation(session.client as unknown as WebClient, session.selected, [
      "receipts",
    ]),
  );
}
describe("automatic Claude continuation replaces execution handoff", () => {
  beforeEach(() => {
    sessionStorage.clear();
    session = createSession();
  });
  afterEach(cleanup);
  it.each(managementLocales)(
    "never offers handoff, release or execution management in $locale",
    (copy) => {
      session.locale = copy.locale;
      const view = render(recovery((content) => content));
      for (const [mode, status] of [
        ["managed-resume", "idle"],
        ["claude-managed", "idle"],
        ["claude-managed", "released"],
        ["claude-follower", "running"],
        ["external", "unsupported"],
      ]) {
        session.live.executionMode = mode;
        session.live.status = status;
        view.rerender(recovery((content) => content));
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
        expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
        expect(screen.queryByText(copy.notHandedOver)).not.toBeInTheDocument();
        expect(screen.queryByText(copy.handedOver)).not.toBeInTheDocument();
      }
      expect(session.client.managedInspect).not.toHaveBeenCalled();
      expect(session.client.request).not.toHaveBeenCalled();
    },
  );
  it.each([
    "offline",
    "synchronizing",
    "sessionBusy",
    "uncertain",
    "staleSession",
    "capability",
    "permission",
    "experimental",
    "protocol",
    "compacting",
  ])("keeps removed actions absent across the %s boundary", (boundary) => {
    if (boundary === "offline") session.online = false;
    if (boundary === "synchronizing") session.controlReady = false;
    if (boundary === "sessionBusy") session.busy = true;
    if (boundary === "uncertain") session.notice = "uncertain";
    if (boundary === "staleSession") session.live.sessionId = "other";
    if (boundary === "capability") session.capabilities.features.adopt.available = false;
    if (boundary === "permission") session.access.device.manage = false;
    if (boundary === "experimental") session.access.experimentalEnabled = false;
    if (boundary === "protocol") session.access.protocolVersion = 1;
    if (boundary === "compacting") session.live.activity = "compacting";
    render(recovery((content) => content));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(session.client.managedInspect).not.toHaveBeenCalled();
    expect(mutations()).toEqual([]);
  });
  it.each(managementLocales)(
    "keeps unknown legacy requests protected and localized through terminal transitions in $locale",
    async (copy) => {
      session.locale = copy.locale;
      const scope = save();
      const view = render(panel(true));
      expect(await screen.findByText(copy.pending)).toBeVisible();
      await waitFor(() => expect(session.client.receipt).toHaveBeenCalledWith(requestId));
      for (const mode of ["claude-follower", "managed-resume", "claude-managed"]) {
        session.live.executionMode = mode;
        view.rerender(panel(false));
        view.rerender(panel(true));
        expect(screen.getByText(copy.pending)).toBeVisible();
        expect(readPending(scope)).toHaveLength(1);
      }
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(mutations()).toEqual([]);
    },
  );
  it.each(["adopt", "release", "reconcile"] as const)(
    "settles saved %s while hidden without replaying or reopening the old panel",
    async (kind) => {
      const scope = save(kind);
      const view = render(recovery(() => null));
      await waitFor(() => expect(session.client.receipt).toHaveBeenCalledWith(requestId));
      expect(readPending(scope)).toHaveLength(1);
      session.client.receipt.mockResolvedValue({
        found: true,
        requestId,
        sessionId: session.selected,
        operation: kind,
        status: "accepted",
      });
      invalidate();
      await waitFor(() => expect(readPending(scope)).toEqual([]));
      expect(session.refresh).toHaveBeenCalledWith(true);
      view.rerender(panel(true));
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(mutations()).toEqual([]);
    },
  );
  it.each([
    "unknown",
    "not-found",
    "wrong-session",
    "wrong-operation",
    "wrong-request",
    "recovery",
  ])("retains saved identity for %s proof and never infers not-dispatched", async (invalid) => {
    const scope = save();
    session.client.receipt.mockResolvedValue({
      found: invalid !== "not-found",
      requestId: invalid === "wrong-request" ? crypto.randomUUID() : requestId,
      sessionId: invalid === "wrong-session" ? "other" : session.selected,
      operation: invalid === "wrong-operation" ? "release" : "adopt",
      status: invalid === "unknown" ? "unknown" : "accepted",
      ...(invalid === "recovery" ? { recovery: "legacy-prepared", completionObserved: false } : {}),
    });
    render(panel(true));
    await waitFor(() => expect(session.client.receipt).toHaveBeenCalledWith(requestId));
    expect(readPending(scope)).toHaveLength(1);
    expect(session.refresh).not.toHaveBeenCalled();
    expect(mutations()).toEqual([]);
  });
  it("preserves unknown requests on transport failure and retries only the receipt lookup", async () => {
    const scope = save();
    session.client.receipt.mockRejectedValueOnce(new Error("offline"));
    render(panel(false));
    await waitFor(() => expect(session.client.receipt).toHaveBeenCalledOnce());
    expect(readPending(scope)).toHaveLength(1);
    session.client.receipt.mockResolvedValue({
      found: true,
      requestId,
      sessionId: session.selected,
      operation: "adopt",
      status: "not-dispatched",
    });
    invalidate();
    await waitFor(() => expect(readPending(scope)).toEqual([]));
    expect(session.refresh).toHaveBeenCalledWith(true);
    expect(mutations()).toEqual([]);
  });
  it("does not apply a previous selection's late receipt to a new session", async () => {
    const scope = save();
    let finish!: (value: unknown) => void;
    session.client.receipt.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(panel(true));
    await waitFor(() => expect(session.client.receipt).toHaveBeenCalledOnce());
    session.selected = "second-session";
    session.current.id = "second-session";
    view.rerender(panel(true));
    await act(async () =>
      finish({
        found: true,
        requestId,
        sessionId: "session",
        operation: "adopt",
        status: "accepted",
      }),
    );
    expect(readPending(scope)).toHaveLength(1);
    expect(session.refresh).not.toHaveBeenCalled();
    expect(mutations()).toEqual([]);
  });
  it("keeps corrupt stored identities fenced without inspection or dispatch", async () => {
    sessionStorage.setItem(pendingScope(session.origin, session.access.device.id), "broken");
    render(panel(true));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot read the saved request identity.",
    );
    expect(session.client.receipt).not.toHaveBeenCalled();
    expect(session.client.managedInspect).not.toHaveBeenCalled();
    expect(mutations()).toEqual([]);
  });
});

describe("reconciling a Claude managed execution on Web", () => {
  beforeEach(() => {
    sessionStorage.clear();
    session = createSession();
    session.live.executionMode = "claude-managed";
    session.live.status = "outcome-unknown";
    session.capabilities.features.reconcile.available = true;
  });
  afterEach(cleanup);

  it.each(["read-only", "legacy host", "another session"] as const)(
    "hides reconciliation for %s",
    (restriction) => {
      if (restriction === "read-only") session.access.device.send = false;
      if (restriction === "legacy host") session.access.protocolVersion = 1;
      if (restriction === "another session") session.live.sessionId = "other";
      render(panel(true));
      expect(screen.queryByRole("button", { name: "Reconcile outcome" })).not.toBeInTheDocument();
      expect(session.client.managedAction).not.toHaveBeenCalled();
    },
  );

  it.each(["manage", "capability", "stale capability"] as const)(
    "keeps the button disabled when a sending device lacks %s",
    (restriction) => {
      if (restriction === "manage") session.access.device.manage = false;
      if (restriction === "capability") session.capabilities.features.reconcile.available = false;
      if (restriction === "stale capability") session.capabilities.sessionId = "other";
      render(panel(true));
      const button = screen.getByRole("button", { name: "Reconcile outcome" });
      expect(button).toBeDisabled();
      expect(button.getAttribute("title")).toBeTruthy();
      fireEvent.click(button);
      expect(session.client.managedAction).not.toHaveBeenCalled();
    },
  );

  it("writes one durable reconciliation identity before dispatch and refreshes after acceptance", async () => {
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
    expect(session.client.receipt).not.toHaveBeenCalled();
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
});
