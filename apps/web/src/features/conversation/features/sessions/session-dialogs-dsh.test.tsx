// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, UserQuestionRequest } from "@agentkib/web-client";
import { dictionaries } from "../../i18n";
import { SessionDialogs } from "./session-dialogs";
import { useSession } from "./session-context";
import { codexReason } from "./codex-copy";

vi.mock("./session-context", () => ({ useSession: vi.fn() }));
vi.mock("../preferences/preferences-dialog", () => ({ PreferencesDialog: () => null }));
vi.mock("../catalog/session-details-dialog", () => ({ SessionDetailsDialog: () => null }));

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
const handledThere = codexReason("en-US", "interaction-answered-elsewhere", "web").text;
function show(
  modal: Approval | UserQuestionRequest,
  live: Partial<NonNullable<Session["live"]>> = {},
) {
  state = { ...state, modal, live: { ...state.live!, ...live } };
  render(<SessionDialogs />);
  return screen.getByRole("dialog");
}

beforeEach(() => {
  state = {
    selected: "session",
    locale: "en-US",
    t: dictionaries["en-US"],
    busy: false,
    online: true,
    controlReady: true,
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
    const dialog = show(approval, { status: "awaiting-approval", approvals: [approval] });
    expect(within(dialog).getByRole("heading", { name: "bash" })).toBeVisible();
    // DSH offers allow once or reject; there is no cancel decision to warn about.
    expect(within(dialog).getByText(dictionaries["en-US"].claudeDecisionInfo)).toBeVisible();
    expect(within(dialog).queryByText(dictionaries["en-US"].decisionInfo)).toBeNull();
    expect(within(dialog).getByRole("button", { name: /Allow once/ })).toBeVisible();
    expect(within(dialog).queryByText(handledThere)).not.toBeInTheDocument();
  });

  it("says an approval DSH withdrew was handled there", () => {
    const dialog = show(approval);
    expect(within(dialog).getByText(handledThere)).toBeVisible();
    expect(within(dialog).queryByText(dictionaries["en-US"].approvalFallback)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Allow once/ })).toBeNull();
  });

  it("does not claim that while our own answer is in flight or the runtime is gone", () => {
    state = { ...state, busy: true };
    const dialog = show(approval);
    expect(within(dialog).queryByText(handledThere)).toBeNull();
    cleanup();
    state = { ...state, busy: false };
    const offline = show(approval, { executionLocation: null, status: "unsupported" });
    expect(within(offline).queryByText(handledThere)).toBeNull();
    expect(within(offline).getByText(dictionaries["en-US"].approvalFallback)).toBeVisible();
  });

  it("says a question DSH withdrew was handled there", () => {
    const dialog = show(question);
    expect(within(dialog).getByText(handledThere)).toBeVisible();
    cleanup();
    const pending = show(question, { status: "waiting-input", questions: [question] });
    expect(within(pending).queryByText(handledThere)).toBeNull();
  });
});
