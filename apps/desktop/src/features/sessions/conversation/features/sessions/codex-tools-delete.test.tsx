// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexTools } from "./codex-tools";
import { codexCopy } from "./codex-copy";
import { useSession } from "./session-context";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("./session-context", () => ({ useSession: vi.fn() }));
vi.mock("./session-navigation", () => ({ useSessionNavigate: () => navigate }));
const copy = codexCopy["en-US"];
let state: ReturnType<typeof useSession>;
function prepare(
  features: Record<string, { available: boolean; reason?: string }>,
  agent: "codex" | "claude-code" = "codex",
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
      device: { id: "device", accessMode: "full", organize: true },
    },
    live: { sessionId: "s", status: "idle", revision: 1 },
    capabilities: { sessionId: "s", executionMode: "codex-managed", status: "idle", features },
    client: {
      codexQueue: vi.fn().mockResolvedValue({ data: [] }),
      sessionQueue: vi.fn().mockResolvedValue({ data: [] }),
      request: vi.fn().mockResolvedValue({ available: true, models: [] }),
    },
    codexAction: vi.fn().mockResolvedValue({ accepted: true, deleted: true }),
    refresh: vi.fn(),
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
}
beforeEach(() => navigate.mockReset());
afterEach(cleanup);

describe("deleting a session from its actions on the desktop", () => {
  it("asks first, deletes once confirmed, and leaves the deleted session", async () => {
    prepare({ delete: { available: true } });
    render(<CodexTools open />);
    fireEvent.click(screen.getByRole("button", { name: copy.delete }));
    expect(state.codexAction).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: copy.deleteTitle })).toHaveAccessibleDescription(
      copy.deleteCodexDetail,
    );
    fireEvent.click(screen.getByRole("button", { name: copy.deleteConfirm }));
    await waitFor(() => expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("delete", {}));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/sessions" }));
  });

  it("names Claude Code when the session is Claude's", () => {
    prepare({ delete: { available: true } }, "claude-code");
    render(<CodexTools open />);
    fireEvent.click(screen.getByRole("button", { name: copy.delete }));
    expect(screen.getByRole("group", { name: copy.deleteTitle })).toHaveAccessibleDescription(
      copy.deleteClaudeDetail,
    );
  });

  it("stays on the session when nothing was deleted", async () => {
    prepare({ delete: { available: true } });
    vi.mocked(state.codexAction).mockResolvedValue(undefined);
    render(<CodexTools open />);
    fireEvent.click(screen.getByRole("button", { name: copy.delete }));
    fireEvent.click(screen.getByRole("button", { name: copy.deleteConfirm }));
    await waitFor(() => expect(state.codexAction).toHaveBeenCalledOnce());
    expect(navigate).not.toHaveBeenCalled();
  });

  it("says another Codex process has to quit first", () => {
    prepare({ delete: { available: false, reason: "codex-owner-busy" } });
    render(<CodexTools open />);
    expect(screen.getByRole("button", { name: copy.delete })).toBeDisabled();
    expect(screen.getByText(copy.deleteOwnerBusy)).toBeVisible();
  });
});
