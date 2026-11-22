// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { render } from "@/features/sessions/conversation/desktop-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionReason } from "../../session-copy";
import { SessionReader } from "./desktop-session-reader";
import type { SessionController } from "../../desktop-session-controller";
const state = vi.hoisted(() => ({ session: {} as SessionController }));
vi.mock("../../desktop-session-context", () => ({
  useSession: () => {
    const [message, setMessage] = useState("");
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
const live = (patch: Record<string, unknown>) =>
  ({
    sessionId: "s",
    executionMode: "devin-print",
    status: "idle",
    revision: 3,
    sendEnabled: true,
    approvals: [],
    questions: [],
    reason: null,
    ...patch,
  }) as unknown as SessionController["live"];
beforeEach(() => {
  state.session = {
    selected: "s",
    current: { id: "s", agent: "devin" },
    locale: "en-US",
    online: true,
    controlReady: true,
    canSend: true,
    busy: false,
    scroll: { current: null },
    t: { message: "Message", send: "Send", stop: "Stop" },
    control: vi.fn(),
    runSessionAction: vi.fn(),
    page: { events: [], warnings: [] },
    access: {
      status: "approved",
      protocolVersion: 2,
      experimentalEnabled: true,
      device: { send: true },
    },
    live: live({}),
  } as unknown as SessionController;
});
afterEach(cleanup);
// The reader says where the read state syncs as well; the composer's notice is one of them.
const notices = () =>
  screen
    .getAllByRole("status")
    .map((node) => node.textContent ?? "")
    .join("\n");

describe("Devin composer notices", () => {
  it("explains a usage limit Devin met, with no continue to choose", () => {
    state.session.live = live({
      usageLimit: {
        agent: "devin",
        resetsAt: null,
        kind: null,
        scope: null,
        message: "Your daily usage quota has been exhausted.",
        continueAt: null,
        manual: "reset-unknown",
        autoContinues: 0,
      },
    });
    render(<SessionReader />);
    expect(notices()).toContain("You've hit your usage limit. Try again later.");
    expect(screen.queryByRole("button", { name: /continue automatically/i })).toBeNull();
  });

  it("offers to turn off the continue armed for Devin's reset, and to arm it again", () => {
    const resetsAt = Date.now() + 3_600_000;
    const limit = {
      agent: "devin",
      resetsAt,
      kind: "weekly",
      scope: null,
      message: "Your weekly usage quota has been exhausted.",
      continueAt: resetsAt + 30_000,
      manual: null,
      autoContinues: 0,
    };
    state.session.live = live({ usageLimit: limit });
    const view = render(<SessionReader />);
    expect(notices()).toContain("continues automatically after the reset");
    fireEvent.click(screen.getByRole("button", { name: "Don't continue automatically" }));
    expect(state.session.runSessionAction).toHaveBeenCalledWith("usage-limit-cancel");
    view.unmount();
    // After a restart of AgentKib the person continues, or arms it again.
    state.session.live = live({ usageLimit: { ...limit, continueAt: null, manual: "restarted" } });
    render(<SessionReader />);
    fireEvent.click(screen.getByRole("button", { name: "Continue automatically after the reset" }));
    expect(state.session.runSessionAction).toHaveBeenCalledWith("usage-limit-continue");
  });

  it("uses feedback for the current turn without carrying recovery across sessions or providers", () => {
    state.session.live = live({
      feedback: [{ code: "devin-login-required" }],
      reason: "devin-run-stopped",
    });
    const { rerender } = render(<SessionReader />);
    const login = "Log in to Devin CLI in a terminal";
    expect(screen.getByRole("button", { name: login })).toBeInTheDocument();

    state.session.live = live({
      sessionId: "other",
      feedback: [{ code: "devin-login-required" }],
    });
    rerender(<SessionReader />);
    expect(screen.queryByRole("button", { name: login })).not.toBeInTheDocument();

    state.session.current = { ...state.session.current!, agent: "claude-code" };
    state.session.live = live({
      executionMode: "claude-managed",
      feedback: [{ code: "devin-login-required" }],
    });
    rerender(<SessionReader />);
    expect(screen.queryByRole("button", { name: login })).not.toBeInTheDocument();
  });

  it("explains a turn whose Devin CLI process was ended", () => {
    state.session.live = live({ reason: "devin-run-stopped" });
    render(<SessionReader />);
    expect(notices()).toContain(sessionReason("en-US", "devin-run-stopped").text);
  });
});
