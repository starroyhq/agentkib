// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexSessionSettings } from "@agentkib/web-client";
import { CodexComposerControls } from "./codex-session-controls";
import { useSession } from "./session-context";
import { codexCopy } from "./codex-copy";

vi.mock("./session-context", () => ({ useSession: vi.fn() }));
let state: ReturnType<typeof useSession>;
let settings: CodexSessionSettings;
const props = { resources: [], setResources: vi.fn(), openPhoneFiles: vi.fn(), disabled: false };
beforeEach(() => {
  // BaseUI measures its thumb before exposing the input; jsdom has no layout.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const width = this.hasAttribute("data-index") ? 28 : 240;
      return {
        left: 0,
        right: width,
        width,
        top: 0,
        bottom: 28,
        height: 28,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    },
  );
  const writable = { available: true };
  settings = {
    sessionId: "session",
    revision: 1,
    available: true,
    current: { modelId: "sol", effort: "high" },
    defaults: { modelId: "sol", effort: "low" },
    writable: {
      model: writable,
      effort: writable,
      serviceTier: writable,
      restoreDefaults: writable,
      mode: writable,
      policy: writable,
    },
    options: {
      models: [{ id: "sol", name: "Sol", efforts: ["low", "high"], serviceTierIds: ["fast"] }],
      policies: [],
      serviceTiers: [{ id: "fast", name: "Fast" }],
    },
  };
  state = {
    selected: "session",
    current: { id: "session", agent: "codex" },
    locale: "en-US",
    online: true,
    busy: false,
    usageEpoch: "epoch",
    access: { bootId: "boot", device: { id: "device", accessMode: "full" } },
    live: { sessionId: "session", status: "idle", revision: 1 },
    capabilities: { sessionId: "session", features: { settings: writable } },
    client: {
      codexSessionSettings: vi.fn(async () => settings),
      codexGoals: vi.fn(),
      codexContextOptions: vi.fn(),
    },
    codexAction: vi.fn(),
    control: vi.fn(),
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openPicker() {
  fireEvent.click(await screen.findByRole("button", { name: /Select reasoning effort: Sol/ }));
  return screen.findByRole("dialog", { name: /Select reasoning effort:/ });
}

describe("Codex composer quick model settings", () => {
  it("places the model after the context ring and keeps advanced settings separate", async () => {
    render(<CodexComposerControls {...props} action={<button>Send</button>} />);
    const picker = await screen.findByRole("button", { name: /Select reasoning effort: Sol/ });
    const ring = screen.getByRole("img", { name: codexCopy["en-US"].contextUsage });
    expect(
      picker.compareDocumentPosition(screen.getByRole("button", { name: "Send" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(ring.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Session settings" }));
    expect(screen.getByRole("dialog", { name: "Session settings" })).toBeVisible();
    expect(state.codexAction).not.toHaveBeenCalled();
  });

  it("uses the existing settings action and reads back the acknowledged selection", async () => {
    vi.mocked(state.codexAction).mockImplementation(async () => {
      settings = {
        ...settings,
        revision: 2,
        applicationStatus: "pending",
        selected: { modelId: "sol", effort: "high", serviceTierId: "fast" },
      };
      state = { ...state, live: { ...state.live!, revision: 2 } };
      return { accepted: true } as unknown as Awaited<ReturnType<typeof state.codexAction>>;
    });
    render(<CodexComposerControls {...props} />);
    const dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole("button", { name: "Fast mode" }));
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("settings", {
        serviceTierId: "fast",
      }),
    );
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Fast mode" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    // A saved next-turn selection is not an unknown write: further edits remain possible.
    expect(within(dialog).getByRole("button", { name: "Fast mode" })).toBeEnabled();
    expect(state.client.codexSessionSettings).toHaveBeenCalledTimes(2);
  });

  it("lets a running native follower inspect its model without sending settings", async () => {
    state = {
      ...state,
      live: { ...state.live!, status: "running" },
      capabilities: { ...state.capabilities!, features: { settings: { available: false } } },
    };
    render(<CodexComposerControls {...props} />);
    const dialog = await openPicker();
    expect(within(dialog).getByRole("button", { name: "Fast mode" })).toBeDisabled();
    expect(await within(dialog).findByRole("slider")).toBeDisabled();
    expect(within(dialog).getByText(codexCopy["en-US"].settingsWhileRunning)).toBeVisible();
    expect(state.codexAction).not.toHaveBeenCalled();
  });

  it("does not apply an old settings receipt after switching conversations", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof state.codexAction>>) => void;
    vi.mocked(state.codexAction).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<CodexComposerControls {...props} />);
    const dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole("button", { name: "Fast mode" }));
    await waitFor(() => expect(state.codexAction).toHaveBeenCalledTimes(1));
    settings = { ...settings, sessionId: "other", current: { modelId: "other-model" } };
    state = {
      ...state,
      selected: "other",
      current: { ...state.current!, id: "other" },
      live: { ...state.live!, sessionId: "other" },
    };
    view.rerender(<CodexComposerControls {...props} />);
    await screen.findByRole("button", { name: /Select reasoning effort: other-model/ });
    const reads = vi.mocked(state.client.codexSessionSettings).mock.calls.length;
    await act(async () =>
      resolve({ accepted: true } as unknown as Awaited<ReturnType<typeof state.codexAction>>),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Select reasoning effort: other-model/ }),
    ).toBeVisible();
    expect(state.client.codexSessionSettings).toHaveBeenCalledTimes(reads);
  });

  it("releases the mutation busy state after a reconnect invalidates its read generation", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof state.codexAction>>) => void;
    vi.mocked(state.codexAction).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<CodexComposerControls {...props} />);
    const dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole("button", { name: "Fast mode" }));
    await waitFor(() => expect(state.codexAction).toHaveBeenCalledTimes(1));
    state = { ...state, online: false };
    view.rerender(<CodexComposerControls {...props} disabled />);
    await act(async () =>
      resolve({ accepted: true } as unknown as Awaited<ReturnType<typeof state.codexAction>>),
    );
    state = { ...state, online: true, usageEpoch: "new-observation" };
    view.rerender(<CodexComposerControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: /Select reasoning effort: Sol/ }));
    const reconnected = await screen.findByRole("dialog", { name: /Select reasoning effort:/ });
    expect(within(reconnected).getByRole("button", { name: "Fast mode" })).toBeEnabled();
    expect(state.codexAction).toHaveBeenCalledTimes(1);
  });
});
