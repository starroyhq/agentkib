// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexSessionSettings } from "@agentkib/web-client";
import { createRef } from "react";
import { confirmsComposerSettings, planModeCopy } from "@agentkib/session-ui";
import { CodexComposerControls, type ComposerControlsHandle } from "./codex-session-controls";
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
    access: {
      status: "approved",
      bootId: "boot",
      device: { id: "device", accessMode: "full", advancedControl: true },
    },
    live: { sessionId: "session", status: "idle", revision: 1 },
    capabilities: { sessionId: "session", features: { settings: writable } },
    client: {
      sessionSettings: vi.fn(async () => settings),
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
  it("confirms a next-turn receipt using the native owner's settings readback", () => {
    const pending = { model: "terra", expectedRevision: 1, nextTurn: true };
    const flags = { prepared: false, variants: false, follower: true };
    const readback: CodexSessionSettings = {
      ...settings,
      revision: 2,
      executionMode: "codex-follower",
      applicationStatus: "confirmed",
      current: { modelId: "terra" },
    };
    expect(confirmsComposerSettings(readback, pending, flags)).toBe(true);
    expect(confirmsComposerSettings({ ...readback, revision: 1 }, pending, flags)).toBe(false);
    expect(
      confirmsComposerSettings({ ...readback, current: settings.current }, pending, flags),
    ).toBe(false);
  });

  it("keeps the current model and effort visible when Codex owns model writes", async () => {
    state.live = { ...state.live!, executionMode: "codex-follower" };
    state.capabilities!.features = {
      "settings-state": { available: true },
      settings: { available: false, reason: "follower-operation-unverified" },
    };
    settings.current.policyId = "workspace-write-on-request";
    settings.writable.policy = { available: false };
    render(<CodexComposerControls {...props} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Execution policy: / })).toBeDisabled(),
    );
    const trigger = await screen.findByRole("button", { name: "Model settings: Sol · High" });
    fireEvent.click(trigger);
    const popup = await screen.findByRole("dialog");
    expect(trigger).toHaveTextContent("Sol");
    expect(trigger).toHaveTextContent("High");
    expect(within(popup).getByText("Sol")).toBeVisible();
    expect(within(popup).queryByRole("status")).not.toBeInTheDocument();
    expect(within(popup).getByRole("slider")).toBeDisabled();
    expect(state.codexAction).not.toHaveBeenCalled();
  });

  it("binds a follower model change to the current owner's settings read", async () => {
    state.live = { ...state.live!, executionMode: "codex-follower", connectionGeneration: "one" };
    settings.executionMode = "codex-follower";
    settings.writeScope = "owner-one";
    settings.options.models.push({
      id: "terra",
      name: "Terra",
      efforts: ["low", "high"],
      serviceTierIds: [],
    });
    const view = render(<CodexComposerControls {...props} />);
    const trigger = await screen.findByRole("button", { name: /Select reasoning effort: Sol/ });
    fireEvent.click(trigger);
    const picker = await screen.findByRole("dialog");
    fireEvent.click(within(picker).getByRole("button", { name: "Select model: Sol" }));
    const models = await screen.findByRole("dialog", { name: "Model" });
    expect(within(models).getByRole("button", { name: "Terra" })).toBeEnabled();

    let resolveRead!: (value: CodexSessionSettings) => void;
    vi.mocked(state.client.sessionSettings).mockReturnValue(
      new Promise((resolve) => (resolveRead = resolve)),
    );
    state.live = { ...state.live!, connectionGeneration: "two" };
    view.rerender(<CodexComposerControls {...props} />);
    expect(within(models).getByRole("button", { name: "Terra" })).toBeDisabled();
    expect(state.codexAction).not.toHaveBeenCalled();

    await act(async () => resolveRead({ ...settings, writeScope: "owner-two" }));
    const terra = within(models).getByRole("button", { name: "Terra" });
    await waitFor(() => expect(terra).toBeEnabled());
    let finishWrite!: () => void;
    vi.mocked(state.codexAction).mockImplementationOnce(
      () => new Promise((resolve) => (finishWrite = () => resolve({ accepted: true }))),
    );
    fireEvent.click(terra);
    expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("settings", {
      model: "terra",
      expectedSettingsScope: "owner-two",
    });
    expect(trigger).toHaveTextContent("Terra");

    vi.mocked(state.client.sessionSettings).mockImplementation(() => new Promise(() => {}));
    state.live = { ...state.live!, connectionGeneration: "three" };
    view.rerender(<CodexComposerControls {...props} />);
    expect(trigger).toHaveTextContent("Sol");
    await act(async () => finishWrite());
    expect(trigger).toHaveTextContent("Sol");
  });

  it("places the model after the context ring and keeps advanced settings separate", async () => {
    render(<CodexComposerControls {...props} action={<button>Send</button>} />);
    const picker = await screen.findByRole("button", { name: /Select reasoning effort: Sol/ });
    const ring = screen.getByRole("img", { name: codexCopy["en-US"].contextUsage });
    expect(
      picker.compareDocumentPosition(screen.getByRole("button", { name: "Send" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(ring.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const policy = codexCopy["en-US"].executionPolicy;
    fireEvent.click(screen.getByRole("button", { name: policy }));
    expect(await screen.findByRole("menu", { name: policy })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.codexAction).not.toHaveBeenCalled();
  });

  it("shows only policies in the permissions menu and applies only the selected policy", async () => {
    settings.current = { ...settings.current, mode: "default", policyId: "old-policy" };
    settings.options.collaborationModes = [
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
    ];
    settings.options.policies = [
      { id: "old-policy", name: "Current policy" },
      { id: "new-policy", name: "Verified policy" },
    ];
    render(<CodexComposerControls {...props} />);
    const copy = codexCopy["en-US"];
    fireEvent.click(
      await screen.findByRole("button", { name: `${copy.executionPolicy}: Current policy` }),
    );
    const menu = await screen.findByRole("menu", { name: copy.executionPolicy });
    expect(within(menu).getByRole("menuitem", { name: "Current policy" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(2);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Verified policy" }));
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("settings", {
        policyId: "new-policy",
      }),
    );
  });

  it("keeps the staged Fast selection editable before a Codex connection is active", async () => {
    vi.mocked(state.codexAction).mockImplementation(async () => {
      settings = {
        ...settings,
        revision: 2,
        current: {},
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
    expect(within(dialog).queryByText(/next turn/i)).not.toBeInTheDocument();
    expect(state.control).not.toHaveBeenCalled();
    expect(state.client.sessionSettings).toHaveBeenCalledTimes(2);
  });

  it("lets a running native follower inspect its model without sending settings", async () => {
    state = {
      ...state,
      live: { ...state.live!, status: "running" },
      capabilities: {
        ...state.capabilities!,
        features: {
          settings: { available: false },
          "settings-state": { available: true },
        },
      },
    };
    render(<CodexComposerControls {...props} />);
    const dialog = await openPicker();
    expect(within(dialog).getByRole("button", { name: "Fast mode" })).toBeDisabled();
    expect(await within(dialog).findByRole("slider")).toBeDisabled();
    expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
    expect(state.codexAction).not.toHaveBeenCalled();
  });

  it("can stage writable settings during a turn and keeps other fields disabled", async () => {
    state.live = { ...state.live!, executionMode: "codex-managed", status: "running" };
    settings.current = { ...settings.current, mode: "default", policyId: "first-policy" };
    settings.writable.serviceTier = { available: false };
    settings.writable.restoreDefaults = { available: false };
    settings.writable.mode = { available: false };
    settings.options.models.push({
      id: "terra",
      name: "Terra",
      efforts: ["low", "high"],
      serviceTierIds: [],
    });
    settings.options.collaborationModes = [
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
    ];
    settings.options.policies = [
      { id: "first-policy", name: "First policy" },
      { id: "second-policy", name: "Second policy" },
    ];
    vi.mocked(state.codexAction).mockResolvedValue({ accepted: true });
    render(<CodexComposerControls {...props} />);

    const model = await screen.findByRole("button", { name: /Select reasoning effort: Sol/ });
    fireEvent.click(model);
    const panel = within(await screen.findByRole("dialog"));
    expect(panel.queryByRole("status")).not.toBeInTheDocument();
    expect(panel.getByRole("button", { name: "Fast mode" })).toBeDisabled();
    expect(panel.getByRole("button", { name: "Reset default model" })).toBeDisabled();
    const effort = await panel.findByRole("slider");
    expect(effort).toBeEnabled();
    fireEvent.keyDown(effort, { key: "Home" });
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenNthCalledWith(1, "settings", { effort: "low" }),
    );

    fireEvent.click(panel.getByRole("button", { name: "Select model: Sol" }));
    const terra = await screen.findByRole("button", { name: "Terra" });
    await waitFor(() => expect(terra).toBeEnabled());
    fireEvent.click(terra);
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenNthCalledWith(2, "settings", { model: "terra" }),
    );
    fireEvent.click(model);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Execution policy: First policy/ }));
    const policy = await screen.findByRole("menuitem", { name: "Second policy" });
    await waitFor(() => expect(policy).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(policy);
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenNthCalledWith(3, "settings", {
        policyId: "second-policy",
      }),
    );
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
    state = { ...state, live: { ...state.live!, revision: 2 } };
    view.rerender(<CodexComposerControls {...props} />);
    expect(within(dialog).getByRole("button", { name: "Fast mode" })).toBeDisabled();
    expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
    settings = { ...settings, sessionId: "other", current: { modelId: "other-model" } };
    state = {
      ...state,
      selected: "other",
      current: { ...state.current!, id: "other" },
      live: { ...state.live!, sessionId: "other" },
      capabilities: { ...state.capabilities!, sessionId: "other" },
    };
    view.rerender(<CodexComposerControls {...props} />);
    await screen.findByRole("button", { name: /Select reasoning effort: other-model/ });
    const reads = vi.mocked(state.client.sessionSettings).mock.calls.length;
    await act(async () =>
      resolve({ accepted: true } as unknown as Awaited<ReturnType<typeof state.codexAction>>),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Select reasoning effort: other-model/ }),
    ).toBeVisible();
    expect(state.client.sessionSettings).toHaveBeenCalledTimes(reads);
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
    await screen.findByRole("button", { name: /Select reasoning effort: Sol/ });
    // Observations keep the open picker mounted while releasing the previous write's busy state.
    const reconnected = await screen.findByRole("dialog", { name: /Select reasoning effort:/ });
    expect(within(reconnected).getByRole("button", { name: "Fast mode" })).toBeEnabled();
    expect(state.codexAction).toHaveBeenCalledTimes(1);
  });
});

describe("plan mode in the composer, as in Codex's own", () => {
  const modes = [
    { id: "default" as const, name: "Default" },
    { id: "plan" as const, name: "Plan" },
  ];
  it("turns Plan mode off from the add menu", async () => {
    settings = {
      ...settings,
      current: { ...settings.current, mode: "plan" },
      options: { ...settings.options, collaborationModes: modes },
    };
    vi.mocked(state.codexAction).mockResolvedValue({ accepted: true } as unknown as Awaited<
      ReturnType<typeof state.codexAction>
    >);
    const onPlan = vi.fn();
    render(<CodexComposerControls {...props} onPlan={onPlan} />);
    await waitFor(() => expect(onPlan).toHaveBeenLastCalledWith({ on: true, available: true }));
    const addLabel = codexCopy["en-US"].addContext;
    fireEvent.click(screen.getByRole("button", { name: addLabel }));
    const add = await screen.findByRole("dialog", { name: addLabel });
    expect(add).not.toHaveAttribute("aria-modal", "true");
    fireEvent.click(
      within(add).getByRole("button", { name: planModeCopy("en-US").title, pressed: true }),
    );
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("settings", { mode: "default" }),
    );
  });

  it("turns plan mode on when the composer takes /plan", async () => {
    settings = { ...settings, options: { ...settings.options, collaborationModes: modes } };
    const onPlan = vi.fn();
    const ref = createRef<ComposerControlsHandle>();
    render(<CodexComposerControls {...props} controlsRef={ref} onPlan={onPlan} />);
    await waitFor(() => expect(onPlan).toHaveBeenLastCalledWith({ on: false, available: true }));
    expect(
      screen.queryByRole("button", { name: planModeCopy("en-US").title }),
    ).not.toBeInTheDocument();
    act(() => {
      expect(ref.current!.plan()).toBe(true);
    });
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("settings", { mode: "plan" }),
    );
  });

  it("clears a saved mode from Add when Codex no longer offers collaboration modes", async () => {
    const unchanged = {
      modelId: "sol",
      effort: "high",
      serviceTierId: "fast",
      policyId: "current",
    };
    settings = {
      ...settings,
      current: { ...unchanged, mode: "plan" },
      selected: { ...unchanged, mode: "plan" },
      applicationStatus: "confirmed",
    };
    state.live = { ...state.live!, executionMode: "codex-managed" };
    vi.mocked(state.codexAction).mockImplementation(async () => {
      settings = { ...settings, revision: 2, selected: unchanged };
      state.live = { ...state.live!, revision: 2 };
      return { accepted: true } as Awaited<ReturnType<typeof state.codexAction>>;
    });
    const onPlan = vi.fn();
    render(<CodexComposerControls {...props} onPlan={onPlan} />);
    await waitFor(() => expect(onPlan).toHaveBeenLastCalledWith({ on: true, available: false }));
    const label = codexCopy["en-US"].addContext;
    fireEvent.click(screen.getByRole("button", { name: label }));
    const add = within(await screen.findByRole("dialog", { name: label }));
    expect(add.getByRole("button", { name: planModeCopy("en-US").title })).toBeDisabled();
    fireEvent.click(add.getByRole("button", { name: planModeCopy("en-US").clear }));

    await waitFor(() => {
      expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("settings", { mode: null });
      expect(onPlan).toHaveBeenLastCalledWith({ on: false, available: false });
      expect(screen.queryByRole("dialog", { name: label })).not.toBeInTheDocument();
    });
    expect(state.control).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: label }));
    const reopened = within(await screen.findByRole("dialog", { name: label }));
    expect(
      reopened.queryByRole("button", { name: planModeCopy("en-US").clear }),
    ).not.toBeInTheDocument();
  });
});
