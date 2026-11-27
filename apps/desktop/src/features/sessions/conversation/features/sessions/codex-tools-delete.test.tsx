// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@/features/sessions/conversation/desktop-reader-test-utils";
import { SessionTools } from "./desktop-session-operations";
import { sessionCopy, sessionReason } from "../../session-copy";
import { useSession } from "../../desktop-session-context";
import { webLayoutCopy } from "@agentkib/session-ui";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../../desktop-session-context", () => ({ useSession: vi.fn() }));
vi.mock("../../desktop-session-navigation", () => ({ useSessionNavigate: () => navigate }));
const copy = sessionCopy["en-US"];
let state: ReturnType<typeof useSession>;
function prepare(
  features: Record<string, { available: boolean; reason?: string }>,
  agent: "codex" | "claude-code" = "codex",
  full = true,
) {
  state = {
    selected: "s",
    locale: "en-US",
    online: true,
    controlReady: true,
    busy: false,
    current: {
      id: "s",
      agent,
      title: "Synthetic",
      workspace_id: "w",
      archived: false,
      sidechain: false,
      availability: "readable",
    },
    access: {
      status: "approved",
      experimentalEnabled: true,
      bootId: "boot",
      device: {
        id: "device",
        ...(full && { accessMode: "full" }),
        organize: true,
        advancedControl: true,
      },
    },
    live: { sessionId: "s", status: "idle", revision: 1 },
    capabilities: { sessionId: "s", executionMode: "codex-managed", status: "idle", features },
    client: {
      codexQueue: vi.fn().mockResolvedValue({ data: [] }),
      sessionQueue: vi.fn().mockResolvedValue({ data: [] }),
      request: vi.fn().mockResolvedValue({ available: true, models: [] }),
    },
    runSessionAction: vi.fn().mockResolvedValue({ accepted: true, deleted: true }),
    refresh: vi.fn(),
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
}
beforeEach(() => navigate.mockReset());
afterEach(cleanup);

it.each([true, false])(
  "keeps model settings out of desktop actions (full access: %s)",
  async (full) => {
    prepare({ settings: { available: true } }, "codex", full);
    render(<SessionTools open />);
    await screen.findByText(copy.queueEmpty);
    expect(screen.queryByRole("heading", { name: copy.settings })).not.toBeInTheDocument();
    expect(state.client.request).not.toHaveBeenCalled();
  },
);

describe("deleting a session from its actions on the desktop", () => {
  it("asks first, deletes once confirmed, and leaves the deleted session", async () => {
    prepare({ delete: { available: true } });
    render(<SessionTools open />);
    fireEvent.click(screen.getByRole("button", { name: copy.delete }));
    expect(state.runSessionAction).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: copy.deleteTitle })).toHaveAccessibleDescription(
      copy.deleteCodexDetail,
    );
    fireEvent.click(screen.getByRole("button", { name: copy.cancel }));
    expect(screen.queryByRole("group", { name: copy.deleteTitle })).not.toBeInTheDocument();
    expect(state.runSessionAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: copy.delete }));
    fireEvent.click(screen.getByRole("button", { name: copy.deleteConfirm }));
    await waitFor(() =>
      expect(state.runSessionAction).toHaveBeenCalledExactlyOnceWith("delete", {}),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/sessions" }));
  });

  it("names Claude Code when the session is Claude's", () => {
    prepare({ delete: { available: true } }, "claude-code");
    render(<SessionTools open />);
    fireEvent.click(screen.getByRole("button", { name: copy.delete }));
    expect(screen.getByRole("group", { name: copy.deleteTitle })).toHaveAccessibleDescription(
      copy.deleteClaudeDetail,
    );
  });

  it("stays on the session when nothing was deleted", async () => {
    prepare({ delete: { available: true } });
    vi.mocked(state.runSessionAction).mockResolvedValue(undefined);
    render(<SessionTools open />);
    fireEvent.click(screen.getByRole("button", { name: copy.delete }));
    fireEvent.click(screen.getByRole("button", { name: copy.deleteConfirm }));
    await waitFor(() => expect(state.runSessionAction).toHaveBeenCalledOnce());
    expect(navigate).not.toHaveBeenCalled();
  });

  const forkReason = sessionReason("en-US", "session-busy").text;
  it.each([
    ["session-busy", forkReason],
    ["codex-owner-busy", copy.deleteOwnerBusy],
  ])("keeps unavailable management actions' reasons in their titles (%s)", (reason, text) => {
    prepare({
      fork: { available: false, reason: "session-busy" },
      delete: { available: false, reason },
    });
    render(<SessionTools open />);
    const management = within(
      screen.getByRole("region", { name: webLayoutCopy["en-US"].management }),
    );
    const fork = management.getByRole("button", { name: copy.fork });
    const remove = management.getByRole("button", { name: copy.delete });
    expect(fork).toBeDisabled();
    expect(fork).not.toHaveAttribute("title");
    expect(remove).toBeDisabled();
    expect(remove).not.toHaveAttribute("title");
    expect(management.queryByText(forkReason)).not.toBeInTheDocument();
    expect(management.queryByText(text)).not.toBeInTheDocument();
  });

  it.each([
    ["claude-owner-busy", copy.deleteClaudeOwnerBusy],
    ["claude-desktop-session", sessionReason("en-US", "claude-desktop-session").text],
  ])("disables delete without explanatory title for Claude (%s)", (reason, text) => {
    prepare({ delete: { available: false, reason } }, "claude-code");
    render(<SessionTools open />);
    const management = within(
      screen.getByRole("region", { name: webLayoutCopy["en-US"].management }),
    );
    const remove = management.getByRole("button", { name: copy.delete });
    expect(remove).toBeDisabled();
    expect(remove).not.toHaveAttribute("title");
    expect(management.queryByText(text)).not.toBeInTheDocument();
    expect(text).toMatch(/Claude/);
  });
});
