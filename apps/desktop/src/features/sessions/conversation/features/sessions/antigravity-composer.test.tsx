// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { render } from "@/features/sessions/conversation/desktop-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionReader } from "./desktop-session-reader";
import type { SessionController } from "./use-session-controller";
const state = vi.hoisted(() => ({ session: {} as SessionController, control: vi.fn() }));
vi.mock("./session-context", () => ({
  useSession: () => {
    const [message, setMessage] = useState("first line");
    return { ...state.session, message, setMessage };
  },
}));
vi.mock("./desktop-session-operations", () => ({ DesktopSessionOperations: () => null }));
vi.mock("./session-panels", () => ({ useSessionPanels: () => null }));
vi.mock("@agentkib/session-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agentkib/session-ui")>()),
  SessionTranscript: () => null,
}));
vi.mock("./context-usage", () => ({ ContextUsageGauge: () => null }));
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
  it("adds the current draft to the queue while the native turn can still be stopped", async () => {
    const codexAction = vi.fn().mockResolvedValue({ queuedSubmission: { id: "queued" } });
    const sessionQueue = vi.fn().mockResolvedValue({ sessionId: "s", data: [] });
    state.session = {
      ...state.session,
      codexAction,
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
    const queue = screen.getByRole("button", { name: "Queue for automatic execution" });
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(queue).toBeEnabled();
    await act(async () => {
      fireEvent.click(queue);
    });
    expect(codexAction).toHaveBeenCalledExactlyOnceWith("queue-add", { text: "first line" });
    expect(state.control).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    expect(sessionQueue).toHaveBeenCalledWith("s", "antigravity", expect.any(AbortSignal));
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
    expect(state.control).toHaveBeenCalledExactlyOnceWith("send");
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
    expect(state.control).toHaveBeenCalledExactlyOnceWith("send");
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
