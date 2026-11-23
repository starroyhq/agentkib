// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { agentName } from "@agentkib/agent-identity";
import { SessionInteractionDock } from "@agentkib/session-ui";
import type { Approval, Live, UserQuestionRequest } from "@agentkib/web-client";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionReason } from "../../session-copy";

type Session = ComponentProps<typeof SessionInteractionDock>["session"];
let state: Session;
// As the backend projects a DSH bash approval and an ask_user_question request.
const approval: Approval = {
  requestId: "dsh-approval-1",
  turnId: "dsh-turn-6",
  method: "dsh/approval",
  toolName: "bash",
  input: { command: "echo akdsh-approved" },
  command: { tool: "bash", arguments: { command: "echo akdsh-approved" } },
  availableDecisions: ["accept", "decline"],
  supported: true,
  unsupportedReason: null,
};
const question: UserQuestionRequest = {
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
};
function live(overrides: Partial<Live> = {}) {
  return { ...state.live!, ...overrides };
}

beforeEach(() => {
  state = {
    selected: "session",
    locale: "en-US",
    busy: false,
    online: true,
    controlReady: true,
    canStop: true,
    access: {
      protocolVersion: 2,
      experimentalEnabled: true,
      status: "approved",
      bootId: "boot",
      csrfToken: "fixture",
      device: { id: "device", name: "Fixture", approve: true, send: true },
    },
    live: {
      sessionId: "session",
      executionMode: "dsh-follower",
      executionLocation: "external",
      status: "running",
      revision: 3,
      sendEnabled: false,
      stopEnabled: true,
      approvals: [],
      questions: [],
    },
    setModal: vi.fn(),
    control: vi.fn(),
  };
});
afterEach(cleanup);

describe.each(["desktop", "web"] as const)(
  "DSH requests answered in DeepSeek Harness on %s",
  (surface) => {
    const explainReason = (reason: string) => sessionReason("en-US", reason, surface).text;
    const handledThere = explainReason("interaction-answered-elsewhere");
    const dock = () => (
      <SessionInteractionDock
        session={state}
        agent={agentName("deepseek-harness")}
        explainReason={explainReason}
      />
    );
    it("keeps a pending approval actionable, for this one call only", () => {
      state = { ...state, live: live({ status: "awaiting-approval", approvals: [approval] }) };
      render(dock());
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
      const view = render(dock());
      state = { ...state, live: live({ status: "running", approvals: [] }) };
      view.rerender(dock());
      const card = screen.getByRole("region", { name: "Approval required" });
      expect(within(card).getByText(handledThere)).toBeVisible();
      expect(within(card).queryByRole("button", { name: "Allow once" })).not.toBeInTheDocument();
    });

    it("uses the declared connection and live owner even without the legacy execution mode", () => {
      state = {
        ...state,
        current: { id: "session", agent: "deepseek-harness" },
        live: live({
          status: "awaiting-approval",
          approvals: [approval],
          executionMode: undefined,
          executionLocation: undefined,
          execution: { owner: "external", observed: true, confidence: "live" },
        }),
      };
      const view = render(dock());
      state = { ...state, live: live({ status: "running", approvals: [] }) };
      view.rerender(dock());
      expect(screen.getByText(handledThere)).toBeVisible();
    });

    it("does not claim that while our own answer is in flight or the runtime is gone", () => {
      state = { ...state, live: live({ status: "awaiting-approval", approvals: [approval] }) };
      const view = render(dock());
      state = { ...state, busy: true, live: live({ approvals: [] }) };
      view.rerender(dock());
      expect(screen.queryByText(handledThere)).not.toBeInTheDocument();
      cleanup();
      state = { ...state, busy: false, live: live({ approvals: [approval] }) };
      const offline = render(dock());
      state = {
        ...state,
        live: live({ executionLocation: null, status: "unsupported", approvals: [] }),
      };
      offline.rerender(dock());
      expect(screen.queryByText(handledThere)).not.toBeInTheDocument();
    });

    it("does not claim it for a request answered from this card", () => {
      state = { ...state, live: live({ status: "awaiting-approval", approvals: [approval] }) };
      const view = render(dock());
      fireEvent.click(screen.getByRole("button", { name: "Deny" }));
      state = { ...state, live: live({ approvals: [] }) };
      view.rerender(dock());
      expect(screen.queryByText(handledThere)).not.toBeInTheDocument();
    });

    it("says a question DSH withdrew was handled there", () => {
      state = { ...state, live: live({ status: "waiting-input", questions: [question] }) };
      const view = render(dock());
      expect(screen.getByRole("heading", { name: "Which colour?" })).toBeVisible();
      expect(screen.queryByText(handledThere)).not.toBeInTheDocument();
      state = { ...state, live: live({ status: "running", questions: [] }) };
      view.rerender(dock());
      expect(
        within(screen.getByRole("region", { name: "Question waiting" })).getByText(handledThere),
      ).toBeVisible();
    });
  },
);
