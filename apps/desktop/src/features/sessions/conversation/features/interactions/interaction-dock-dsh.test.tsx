// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, UserQuestionRequest } from "@agentkib/web-client";
import { SessionInteractionDock } from "./interaction-dock";
import { useSession } from "../sessions/session-context";
import { codexReason } from "../sessions/codex-copy";

vi.mock("../sessions/session-context", () => ({ useSession: vi.fn() }));

type Session = ReturnType<typeof useSession>;
let state: Session;
// As the backend projects a DSH bash approval and an ask_user_question request.
const approval = {
  requestId: "dsh-approval-1",
  turnId: "dsh-turn-6",
  method: "dsh/approval",
  toolName: "bash",
  input: { command: "echo akdsh-approved" },
  command: { tool: "bash", arguments: { command: "echo akdsh-approved" } },
  availableDecisions: ["accept", "decline"],
  supported: true,
  unsupportedReason: null,
} as unknown as Approval;
const question = {
  requestId: "dsh-question-1",
  turnId: "dsh-turn-7",
  method: "dsh/question",
  supported: true,
  unsupportedReason: null,
  questions: [
    {
      id: "pick",
      question: "Which colour?",
      options: [{ label: "Red" }, { label: "Blue" }],
      multiSelect: false,
      allowCustom: true,
    },
  ],
} as unknown as UserQuestionRequest;
const handledThere = codexReason("en-US", "interaction-answered-elsewhere").text;
function live(overrides: Partial<NonNullable<Session["live"]>> = {}) {
  return { ...state.live!, ...overrides } as Session["live"];
}

beforeEach(() => {
  state = {
    selected: "session",
    locale: "en-US",
    busy: false,
    online: true,
    controlReady: true,
    canStop: true,
    current: { id: "session", agent: "deepseek-harness" },
    access: {
      protocolVersion: 2,
      experimentalEnabled: true,
      bootId: "boot",
      device: { approve: true, send: true },
    },
    live: {
      sessionId: "session",
      executionMode: "dsh-follower",
      executionLocation: "external",
      status: "running",
      revision: 3,
      sendEnabled: false,
      approvals: [],
      questions: [],
    },
    setModal: vi.fn(),
    control: vi.fn(),
  } as unknown as Session;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(cleanup);

describe("DSH requests answered in DeepSeek Harness", () => {
  it("keeps a pending approval actionable, for this one call only", () => {
    state = { ...state, live: live({ status: "awaiting-approval", approvals: [approval] }) };
    render(<SessionInteractionDock />);
    const card = screen.getByRole("region", { name: "Approval required" });
    expect(
      within(card).getByRole("heading", {
        name: "Do you want DeepSeek Harness to run this command?",
      }),
    ).toBeVisible();
    expect(within(card).getByText("echo akdsh-approved")).toBeVisible();
    fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
    expect(state.control).toHaveBeenCalledExactlyOnceWith("approve", approval, "accept");
    expect(within(card).getByRole("button", { name: "Deny" })).toBeVisible();
    expect(within(card).queryByText(handledThere)).not.toBeInTheDocument();
  });

  it("says an approval DSH withdrew was handled there", () => {
    state = { ...state, live: live({ status: "awaiting-approval", approvals: [approval] }) };
    const view = render(<SessionInteractionDock />);
    state = { ...state, live: live({ status: "running", approvals: [] }) };
    view.rerender(<SessionInteractionDock />);
    const card = screen.getByRole("region", { name: "Approval required" });
    expect(within(card).getByText(handledThere)).toBeVisible();
    expect(within(card).queryByRole("button", { name: "Allow once" })).not.toBeInTheDocument();
  });

  it("does not claim that while our own answer is in flight or the runtime is gone", () => {
    state = { ...state, live: live({ status: "awaiting-approval", approvals: [approval] }) };
    const view = render(<SessionInteractionDock />);
    state = { ...state, busy: true, live: live({ approvals: [] }) };
    view.rerender(<SessionInteractionDock />);
    expect(screen.queryByText(handledThere)).not.toBeInTheDocument();
    cleanup();
    state = { ...state, busy: false, live: live({ approvals: [approval] }) };
    const offline = render(<SessionInteractionDock />);
    state = {
      ...state,
      live: live({ executionLocation: null, status: "unsupported", approvals: [] }),
    };
    offline.rerender(<SessionInteractionDock />);
    expect(screen.queryByText(handledThere)).not.toBeInTheDocument();
  });

  it("does not claim it for a request answered from this card", () => {
    state = { ...state, live: live({ status: "awaiting-approval", approvals: [approval] }) };
    const view = render(<SessionInteractionDock />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    state = { ...state, live: live({ approvals: [] }) };
    view.rerender(<SessionInteractionDock />);
    expect(screen.queryByText(handledThere)).not.toBeInTheDocument();
  });

  it("says a question DSH withdrew was handled there", () => {
    state = { ...state, live: live({ status: "waiting-input", questions: [question] }) };
    const view = render(<SessionInteractionDock />);
    expect(screen.getByRole("heading", { name: "Which colour?" })).toBeVisible();
    expect(screen.queryByText(handledThere)).not.toBeInTheDocument();
    state = { ...state, live: live({ status: "running", questions: [] }) };
    view.rerender(<SessionInteractionDock />);
    expect(
      within(screen.getByRole("region", { name: "Question waiting" })).getByText(handledThere),
    ).toBeVisible();
  });
});
