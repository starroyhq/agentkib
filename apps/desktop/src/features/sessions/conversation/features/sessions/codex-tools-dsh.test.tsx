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
function prepare(accessMode = "full") {
  state = {
    selected: "s",
    locale: "en-US",
    online: true,
    controlReady: true,
    busy: false,
    current: {
      id: "s",
      agent: "deepseek-harness",
      title: "DSH session",
      workspace_id: "w",
      archived: false,
      sidechain: false,
      availability: "readable",
    },
    access: {
      status: "approved",
      experimentalEnabled: true,
      bootId: "boot",
      device: { id: "device", accessMode, organize: true },
    },
    live: { sessionId: "s", status: "idle", revision: 1 },
    capabilities: {
      sessionId: "s",
      executionMode: "dsh-follower",
      status: "idle",
      features: {
        rename: { available: true },
        archive: { available: true },
        unarchive: { available: false, reason: "operation-unavailable" },
        fork: { available: true },
      },
    },
    client: {
      codexQueue: vi.fn().mockResolvedValue({ data: [] }),
      sessionQueue: vi.fn().mockResolvedValue({ data: [] }),
      request: vi.fn().mockResolvedValue({ available: true, models: [] }),
    },
    codexAction: vi.fn().mockResolvedValue({ accepted: true, sessionId: "s-fork" }),
    refresh: vi.fn(),
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
}
beforeEach(() => navigate.mockReset());
afterEach(cleanup);

describe("DeepSeek Harness session actions on the desktop", () => {
  it("renames, archives and forks through the session's own actions", async () => {
    prepare();
    render(<CodexTools open />);
    fireEvent.change(screen.getByDisplayValue("DSH session"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: copy.rename }));
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("rename", { name: "Renamed" }),
    );
    expect(screen.getByRole("button", { name: copy.archive })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: copy.fork }));
    // The copy opens like a Codex fork.
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/sessions/$sessionId",
        params: { sessionId: "s-fork" },
      }),
    );
  });

  it("repeats neither the Codex queue nor Codex's model options", async () => {
    // A restricted device would otherwise get the Codex settings section here.
    prepare("custom");
    render(<CodexTools open />);
    expect(screen.getByRole("button", { name: copy.fork })).toBeInTheDocument();
    expect(screen.queryByText(copy.queue)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: copy.settings })).not.toBeInTheDocument();
    await Promise.resolve();
    expect(state.client.codexQueue).not.toHaveBeenCalled();
    expect(state.client.sessionQueue).not.toHaveBeenCalled();
    expect(state.client.request).not.toHaveBeenCalled();
  });
});
