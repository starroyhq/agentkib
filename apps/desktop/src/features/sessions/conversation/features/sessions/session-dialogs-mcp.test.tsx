// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "@agentkib/web-client";
import { conversationWords } from "@/core/i18n";
import { SessionDialogs } from "./session-dialogs";
import { useSession } from "./session-context";
import { codexCopy } from "./codex-copy";

vi.mock("./session-context", () => ({ useSession: vi.fn() }));
vi.mock("../preferences/preferences-dialog", () => ({ PreferencesDialog: () => null }));
vi.mock("../catalog/session-details-dialog", () => ({ SessionDetailsDialog: () => null }));

type Session = ReturnType<typeof useSession>;
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
function show(modal: Approval) {
  state = { ...state, modal, live: { ...state.live!, approvals: [modal] } };
  render(<SessionDialogs />);
  return screen.getByRole("dialog");
}

beforeEach(() => {
  state = {
    selected: "session",
    locale: "en-US",
    t: conversationWords("en-US"),
    busy: false,
    online: true,
    controlReady: true,
    access: { protocolVersion: 2, experimentalEnabled: true, device: { approve: true } },
    live: {
      sessionId: "session",
      status: "awaiting-approval",
      revision: 3,
      sendEnabled: false,
      approvals: [],
    },
    setModal: vi.fn(),
    control: vi.fn(),
  } as unknown as Session;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(cleanup);

describe("MCP requests in the approval dialog", () => {
  it("shows what Codex asks before an MCP tool runs, and answers it", () => {
    const dialog = show(toolApproval);
    expect(
      within(dialog).getByRole("heading", { name: "stubmcp · Write stub record" }),
    ).toBeVisible();
    expect(
      within(dialog).getByText('Allow the stubmcp MCP server to run tool "write"?'),
    ).toBeVisible();
    // The details name the server, tool and arguments; the question is not repeated there.
    const details = dialog.querySelector("pre")!;
    expect(JSON.parse(details.textContent!)).toEqual({
      server: "stubmcp",
      tool: "Write stub record",
      params: { name: "x" },
    });
    expect(within(dialog).queryByText(codexCopy["en-US"].mcpDeclineOnly)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /Allow once/ }));
    expect(state.control).toHaveBeenCalledExactlyOnceWith("approve", toolApproval, "accept");
    expect(within(dialog).getByRole("button", { name: /Decline/ })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: /Cancel turn/ })).toBeVisible();
  });

  it("explains that a form can only be declined here", () => {
    const dialog = show(form);
    expect(within(dialog).getByText("Pick a color for the stub.")).toBeVisible();
    expect(within(dialog).getByText(codexCopy["en-US"].mcpDeclineOnly)).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: /Allow once/ })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /Decline/ }));
    expect(state.control).toHaveBeenCalledExactlyOnceWith("approve", form, "decline");
  });
});
