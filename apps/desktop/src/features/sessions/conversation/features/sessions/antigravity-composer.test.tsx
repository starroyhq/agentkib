// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { render } from "@/features/sessions/conversation/desktop-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionReader } from "./desktop-session-reader";
import type { SessionController } from "../../desktop-session-controller";
const state = vi.hoisted(() => ({ session: {} as SessionController, control: vi.fn() }));
vi.mock("../../desktop-session-context", () => ({
  useSession: () => {
    const [message, setMessage] = useState("first line");
    return { ...state.session, message, setMessage };
  },
}));
vi.mock("./desktop-session-operations", () => ({ DesktopSessionOperations: () => null }));
vi.mock("@agentkib/session-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agentkib/session-ui")>()),
  useSessionPanels: () => null,
  SessionTranscript: () => null,
}));
vi.mock("../../context-usage", () => ({ ContextUsageGauge: () => null }));
beforeEach(() => {
  state.control.mockReset().mockResolvedValue(true);
  state.session = {
    selected: "s",
    current: { id: "s", agent: "antigravity" },
    locale: "en-US",
    online: true,
    controlReady: true,
    canSend: true,
    busy: false,
    scroll: { current: null },
    t: { message: "Message", send: "Send", stop: "Stop" },
    control: state.control,
    page: { events: [], warnings: [] },
    access: {
      status: "approved",
      protocolVersion: 2,
      experimentalEnabled: true,
      device: { send: true },
    },
    live: { sessionId: "s", status: "idle", approvals: [], questions: [] },
  } as unknown as SessionController;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("Antigravity composer shortcuts", () => {
  it("queues from the primary action and restores Stop when the draft clears", async () => {
    const runSessionAction = vi.fn().mockResolvedValue({ queuedSubmission: { id: "queued" } });
    const sessionQueue = vi.fn().mockResolvedValue({ sessionId: "s", data: [] });
    state.session = {
      ...state.session,
      runSessionAction,
      client: { sessionQueue },
      canSend: false,
      canStop: true,
      live: { ...state.session.live!, status: "running" },
      access: { ...state.session.access!, device: { send: true, advancedControl: true } },
      capabilities: {
        sessionId: "s",
        features: { "queue-list": { available: true }, "queue-add": { available: true } },
      },
    } as unknown as SessionController;
    render(<SessionReader />);
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    const queue = screen.getByRole("button", { name: "Queue for automatic execution" });
    expect(queue).toBeEnabled();
    await act(async () => {
      fireEvent.click(queue);
    });
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(runSessionAction).toHaveBeenCalledExactlyOnceWith("queue-add", { text: "first line" });
    expect(state.control).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    expect(sessionQueue).toHaveBeenCalledWith("s", "antigravity", expect.any(AbortSignal));
  });

  it("can still explicitly add to a paused queue while the session is idle", async () => {
    const runSessionAction = vi.fn().mockResolvedValue({ queuedSubmission: { id: "queued" } });
    const sessionQueue = vi.fn().mockResolvedValue({ sessionId: "s", paused: true, data: [] });
    state.session = {
      ...state.session,
      runSessionAction,
      client: { sessionQueue },
      access: { ...state.session.access!, device: { send: true, advancedControl: true } },
      capabilities: {
        sessionId: "s",
        features: { "queue-list": { available: true }, "queue-add": { available: true } },
      },
    } as unknown as SessionController;
    render(<SessionReader />);
    const input = screen.getByRole("textbox", { name: "Message" });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    });
    expect(runSessionAction).toHaveBeenCalledExactlyOnceWith("queue-add", { text: "first line" });
    expect(state.control).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Send now" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(state.control.mock.calls[0]?.[0]).toBe("send");
  });

  it("sends with desktop Enter and keeps Shift+Enter and IME input as text", async () => {
    render(<SessionReader />);
    const input = screen.getByRole("textbox", { name: "Message" });
    for (const extra of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }])
      expect(fireEvent.keyDown(input, { key: "Enter", ...extra })).toBe(true);
    fireEvent.compositionStart(input);
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    fireEvent.compositionEnd(input);
    expect(state.control).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    await act(async () => {});
    expect(state.control).toHaveBeenCalledOnce();
    expect(state.control.mock.calls[0]?.[0]).toBe("send");
  });
  it("keeps coarse-pointer Enter as a newline and uses the send button", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    render(<SessionReader />);
    const input = screen.getByRole("textbox", { name: "Message" });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    expect(state.control).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "first line\nsecond line" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {});
    expect(state.control).toHaveBeenCalledOnce();
    expect(state.control.mock.calls[0]?.[0]).toBe("send");
  });
  it("keeps submission locks scoped to the selected session", async () => {
    let finishFirst!: (value: boolean) => void;
    let finishSecond!: (value: boolean) => void;
    state.control
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          finishFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          finishSecond = resolve;
        }),
      );
    const view = render(<SessionReader />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    state.session = {
      ...state.session,
      selected: "second",
      current: { ...state.session.current!, id: "second" },
      live: { ...state.session.live!, sessionId: "second" },
    };
    view.rerender(<SessionReader />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(state.control).toHaveBeenCalledTimes(2);
    await act(async () => finishFirst(true));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(state.control).toHaveBeenCalledTimes(2);
    await act(async () => finishSecond(true));
  });
  it.each([
    { online: false },
    { canSend: false },
    { busy: true },
    {
      live: {
        sessionId: "s",
        status: "idle",
        activity: "compacting",
        approvals: [],
        questions: [],
      },
    },
  ])("preserves the existing send gate %j", (override) => {
    state.session = { ...state.session, ...override } as SessionController;
    render(<SessionReader />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(state.control).not.toHaveBeenCalled();
  });
});
