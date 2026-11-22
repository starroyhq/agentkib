// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { agentName } from "@agentkib/agent-identity";
import { SessionInteractionDock } from "@agentkib/session-ui";
import type { Approval } from "@agentkib/web-client";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionReason } from "../../session-copy";

type Session = ComponentProps<typeof SessionInteractionDock>["session"];
let state: Session;
// As the host projects the MCP requests CLI 0.163.0 sent while a local MCP stub ran.
const toolApproval: Approval = {
  requestId: 41,
  turnId: "turn",
  method: "mcpServer/elicitation/request",
  toolName: "stubmcp · Write stub record",
  input: {
    kind: "tool-approval",
    server: "stubmcp",
    message: 'Allow the stubmcp MCP server to run tool "write"?',
    tool: "Write stub record",
    params: { name: "x" },
  },
  command: null,
  changes: null,
  availableDecisions: ["accept", "decline", "cancel"],
  supported: true,
};
const form: Approval = {
  ...toolApproval,
  requestId: 42,
  toolName: "stubmcp",
  input: {
    kind: "form",
    server: "stubmcp",
    message: "Pick a color for the stub.",
    fields: [{ name: "color", title: "Color" }],
  },
  availableDecisions: ["decline"],
};
function show(request: Approval) {
  state = { ...state, live: { ...state.live!, approvals: [request] } };
  render(
    <SessionInteractionDock
      session={state}
      agent={agentName("codex")}
      explainReason={(reason) => sessionReason(state.locale, reason).text}
    />,
  );
  return screen.getByRole("region", { name: "Approval required" });
}

beforeEach(() => {
  state = {
    selected: "session",
    locale: "en-US",
    busy: false,
    online: true,
    controlReady: true,
    canStop: false,
    access: {
      protocolVersion: 2,
      experimentalEnabled: true,
      status: "approved",
      bootId: "boot",
      csrfToken: "fixture",
      device: { id: "device", name: "Fixture", approve: true, send: false },
    },
    live: {
      sessionId: "session",
      status: "awaiting-approval",
      revision: 3,
      sendEnabled: false,
      stopEnabled: false,
      approvals: [],
    },
    setModal: vi.fn(),
    control: vi.fn(),
  };
});
afterEach(cleanup);

describe("MCP requests on the approval card", () => {
  it("shows what Codex asks before an MCP tool runs, and answers it", () => {
    const card = show(toolApproval);
    expect(
      within(card).getByRole("heading", { name: "Allow stubmcp to run Write stub record tool?" }),
    ).toBeVisible();
    expect(
      within(card).getByText('Allow the stubmcp MCP server to run tool "write"?'),
    ).toBeVisible();
    expect(within(card).getByText("name: x")).toBeVisible();
    expect(within(card).queryByText(/AgentKib doesn't support yet/)).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
    expect(state.control).toHaveBeenCalledExactlyOnceWith("approve", toolApproval, "accept");
    expect(within(card).getByRole("button", { name: "Deny" })).toBeVisible();
    // The composer cannot stop this turn here, so the card keeps a way to cancel it.
    expect(within(card).getByRole("button", { name: "Deny and stop this turn" })).toBeVisible();
  });

  it("explains that a form can only be declined here", () => {
    const card = show(form);
    expect(within(card).getByRole("heading", { name: "stubmcp needs your input" })).toBeVisible();
    expect(within(card).getByText("Pick a color for the stub.")).toBeVisible();
    expect(
      within(card).getByText("This needs a form or a link, which AgentKib doesn't support yet"),
    ).toBeVisible();
    expect(within(card).queryByRole("button", { name: "Allow once" })).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Deny" }));
    expect(state.control).toHaveBeenCalledExactlyOnceWith("approve", form, "decline");
  });
});
