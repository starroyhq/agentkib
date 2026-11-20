import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetSessionModelDisplay, type CodexSessionSettings } from "@agentkib/web-client";
import { CodexComposerControls } from "@/features/conversation/features/sessions/codex-session-controls";
import { useSession } from "@/features/conversation/features/sessions/session-context";

vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: vi.fn(),
}));

const historicalSettings: CodexSessionSettings = {
  sessionId: "s",
  revision: 0,
  available: true,
  current: {},
  selected: {},
  historicalSettings: { modelId: "recorded-model", effort: "xhigh" },
  defaults: {},
  writable: {
    model: { available: true },
    effort: { available: true },
    mode: { available: false },
    policy: { available: false },
    serviceTier: { available: false },
    restoreDefaults: { available: false },
  },
  options: {
    models: [{ id: "recorded-model", efforts: ["xhigh"], serviceTierIds: [] }],
    policies: [],
    serviceTiers: [],
  },
  usage: { available: true, state: "stale", historical: true, usedTokens: 29, contextWindow: 100 },
};

const fastSettings: CodexSessionSettings = {
  ...historicalSettings,
  current: { modelId: "fast-model", effort: "low", serviceTierId: "fast", policyId: "old-policy" },
  selected: undefined,
  writable: {
    ...historicalSettings.writable,
    policy: { available: true },
    serviceTier: { available: true },
  },
  options: {
    models: [
      { id: "fast-model", name: "Native Model", efforts: ["low"], serviceTierIds: ["fast"] },
    ],
    policies: [
      { id: "old-policy", name: "Old policy" },
      { id: "new-policy", name: "New policy" },
    ],
    serviceTiers: [{ id: "fast", name: "Fast" }],
  },
};

let state: ReturnType<typeof useSession>;
const props = { resources: [], setResources: vi.fn(), openPhoneFiles: vi.fn(), disabled: false };

beforeEach(() => {
  state = {
    selected: "s",
    current: { id: "s", agent: "codex", availability: "readable" },
    locale: "en-US",
    online: true,
    live: {
      sessionId: "s",
      status: "idle",
      revision: 0,
      usage: { available: true, state: "stale" },
    },
    access: {
      status: "approved",
      bootId: "boot",
      device: { id: "device", accessMode: "full", advancedControl: true },
    },
    capabilities: { sessionId: "s", features: { settings: { available: true } } },
    client: {
      sessionSettings: vi.fn(async () => historicalSettings),
      codexGoals: vi.fn(async () => undefined),
      codexContextOptions: vi.fn(async () => ({ resources: [] })),
    },
    codexAction: vi.fn(),
  } as unknown as ReturnType<typeof useSession>;
  forgetSessionModelDisplay(state.client, state.access, state.selected, "codex");
  vi.mocked(useSession).mockImplementation(() => state);
});

afterEach(cleanup);

it("retains a scoped model and Fast badge when an unconfirmed settings write obscures live", async () => {
  state.access!.device!.id = "uncertain-settings-device";
  vi.mocked(state.client.sessionSettings).mockResolvedValue(fastSettings);
  const first = render(<CodexComposerControls {...props} />);
  expect(await screen.findByRole("button", { name: /Native Model.*Fast mode/ })).toBeVisible();
  first.unmount();

  state.settingsOnlyBlocked = true;
  state.settingsNotice = {
    sessionId: "s",
    scope: "scope",
    target: "settings",
    status: "uncertain",
  };
  state.live = { ...state.live!, status: "outcome-unknown" };
  vi.mocked(state.client.sessionSettings).mockImplementation(() => new Promise(() => {}));
  render(<CodexComposerControls {...props} />);
  const entry = screen.getByRole("button", { name: /Native Model.*Fast mode/ });
  expect(entry.querySelector('svg[fill="currentColor"]')).toBeVisible();
  fireEvent.click(entry);
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByRole("button", { name: "Reset default model" })).toBeDisabled();
  expect(screen.getAllByText("Setting status unconfirmed")).toHaveLength(1);
  expect(state.codexAction).not.toHaveBeenCalled();
});

it("keeps the remembered model and Fast badge while an accepted policy change is pending", async () => {
  state.access!.device!.id = "pending-policy-device";
  vi.mocked(state.client.sessionSettings).mockResolvedValue(fastSettings);
  vi.mocked(state.codexAction).mockResolvedValue({ accepted: true });
  render(<CodexComposerControls {...props} />);
  await screen.findByRole("button", { name: /Native Model.*Fast mode/ });
  vi.mocked(state.client.sessionSettings).mockResolvedValue({
    ...fastSettings,
    current: {},
    selected: { policyId: "new-policy" },
    applicationStatus: "pending",
  });
  fireEvent.click(screen.getByRole("button", { name: /Execution policy: Old policy/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "New policy" }));
  expect(await screen.findByRole("button", { name: /Execution policy: New policy/ })).toBeVisible();
  const entry = screen.getByRole("button", { name: /Native Model.*Fast mode/ });
  expect(entry.querySelector('svg[fill="currentColor"]')).toBeVisible();
  expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("settings", { policyId: "new-policy" });
});

it("shows native model history on a cold open with a staged policy only", async () => {
  state.access!.device!.id = "cold-policy-device";
  vi.mocked(state.client.sessionSettings).mockResolvedValue({
    ...historicalSettings,
    selected: { policyId: "workspace-write-auto-review" },
    applicationStatus: "pending",
  });
  render(<CodexComposerControls {...props} />);
  const entry = await screen.findByRole("button", { name: /recorded-model.*Extra high/ });
  fireEvent.click(entry);
  const overview = within(await screen.findByRole("dialog"));
  fireEvent.click(overview.getByRole("button", { name: "Select model: recorded-model" }));
  expect(await overview.findByRole("button", { name: "recorded-model" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(state.codexAction).not.toHaveBeenCalled();
});

it("starts a revisited session with its model label while keeping settings tied to the read", async () => {
  const first = render(<CodexComposerControls {...props} />);
  await screen.findByRole("button", { name: /recorded-model/ });
  first.unmount();

  state.live = undefined;
  let finish!: (settings: CodexSessionSettings) => void;
  vi.mocked(state.client.sessionSettings).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<CodexComposerControls {...props} />);
  const entry = screen.getByRole("button", { name: /recorded-model/ });
  expect(within(entry).getByText("Extra high")).toBeVisible();
  fireEvent.click(entry);
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByRole("button", { name: "Reset default model" })).toBeDisabled();
  expect(state.codexAction).not.toHaveBeenCalled();

  await waitFor(() => expect(finish).toBeDefined());
  await act(async () =>
    finish({
      ...historicalSettings,
      current: { modelId: "new-model", effort: "low" },
      selected: undefined,
      options: {
        ...historicalSettings.options,
        models: [{ id: "new-model", name: "New Model", efforts: ["low"], serviceTierIds: [] }],
      },
    }),
  );
  expect(await dialog.findByRole("button", { name: "Select model: New Model" })).toBeVisible();
  expect(state.codexAction).not.toHaveBeenCalled();
});

it("replaces an older cached model with native history and keeps it ahead of provider defaults", async () => {
  vi.mocked(state.client.sessionSettings).mockResolvedValue(fastSettings);
  const first = render(<CodexComposerControls {...props} />);
  await screen.findByRole("button", { name: /Native Model.*Fast mode/ });
  first.unmount();

  vi.mocked(state.client.sessionSettings).mockResolvedValue(historicalSettings);
  const second = render(<CodexComposerControls {...props} />);
  await screen.findByRole("button", { name: /recorded-model.*Extra high/ });
  second.unmount();

  vi.mocked(state.client.sessionSettings).mockResolvedValue({
    ...historicalSettings,
    historicalSettings: undefined,
    defaults: { modelId: "default-model" },
    options: { ...historicalSettings.options, policies: [{ id: "test", name: "Read completed" }] },
    current: { policyId: "test" },
    selected: undefined,
  });
  render(<CodexComposerControls {...props} />);
  await screen.findByRole("button", { name: /Execution policy: Read completed/ });
  expect(screen.getByRole("button", { name: /recorded-model.*Extra high/ })).toBeVisible();
  expect(state.codexAction).not.toHaveBeenCalled();
});

it.each(["device", "permission"] as const)(
  "does not reuse the remembered label after a change of %s",
  async (scope) => {
    const first = render(<CodexComposerControls {...props} />);
    await screen.findByRole("button", { name: /recorded-model/ });
    first.unmount();
    state.live = undefined;
    state.access = {
      ...state.access!,
      device: {
        ...state.access!.device!,
        ...(scope === "device" ? { id: "other-device" } : { advancedControl: false }),
      },
    };
    vi.mocked(state.client.sessionSettings).mockImplementation(() => new Promise(() => {}));
    render(<CodexComposerControls {...props} />);
    expect(screen.getByRole("button", { name: "Model settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /recorded-model/ })).not.toBeInTheDocument();
  },
);

it("shows a cached managed model while waiting for settings permission to load", async () => {
  state.current = { ...state.current!, agent: "devin" };
  state.client.sessionSettings = vi.fn(async () => ({
    ...historicalSettings,
    selected: { modelId: "devin-model" },
  }));
  const first = render(<CodexComposerControls {...props} />);
  expect(await screen.findByRole("button", { name: /devin-model/ })).toBeEnabled();
  first.unmount();

  state.capabilities = undefined;
  state.live = undefined;
  render(<CodexComposerControls {...props} />);
  const button = screen.getByRole("button", { name: /devin-model/ });
  fireEvent.click(button);
  const reset = screen.queryByRole("button", { name: "Reset default model" });
  if (reset) expect(reset).toBeDisabled();
  expect(state.codexAction).not.toHaveBeenCalled();
});

it.each([
  ["recorded-model", "Extra high", historicalSettings.historicalSettings],
  ["Default Model", "Medium", undefined],
] as const)("displays %s without prefilling model settings", async (name, effortLabel, history) => {
  vi.mocked(state.client.sessionSettings).mockResolvedValue({
    ...historicalSettings,
    historicalSettings: history,
    defaults: { modelId: "default-model", effort: "medium" },
    options: {
      ...historicalSettings.options,
      models: [
        ...historicalSettings.options.models,
        { id: "default-model", name: "Default Model", efforts: ["medium"], serviceTierIds: [] },
      ],
    },
  });
  render(<CodexComposerControls {...props} />);
  const entry = await screen.findByRole("button", { name: new RegExp(name) });
  expect(within(entry).getByText(effortLabel)).toBeVisible();
  fireEvent.click(entry);
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: `Select model: ${name}` }));
  expect(dialog.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
  expect(dialog.queryByText(/Last used/)).not.toBeInTheDocument();
  await userEvent.setup().hover(screen.getByRole("img", { name: "Context usage" }));
  const usage = within(await screen.findByRole("tooltip"));
  expect(usage.getByText("29% used (71% remaining)")).toBeInTheDocument();
  expect(usage.getByText("29 / 100 tokens used")).toBeInTheDocument();
  expect(state.codexAction).not.toHaveBeenCalled();
});

it("keeps recorded usage available and shows the live model once reported", async () => {
  vi.mocked(state.client.sessionSettings).mockResolvedValue({
    ...historicalSettings,
    available: false,
    defaults: { modelId: "default-model", effort: "medium" },
  });
  state.live = { ...state.live!, status: "unsupported", reason: "runtime_unavailable" };
  const view = render(<CodexComposerControls {...props} />);
  expect(await screen.findByRole("button", { name: /recorded-model/ })).toBeVisible();
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "Context usage" })).toHaveAccessibleDescription(
      expect.stringContaining("29%"),
    ),
  );
  state.live = { ...state.live!, status: "running", reason: undefined };
  view.rerender(<CodexComposerControls {...props} />);
  expect(screen.getByRole("button", { name: /recorded-model/ })).toBeVisible();
  expect(screen.getByRole("img", { name: "Context usage" })).toHaveAccessibleDescription(
    expect.stringContaining("29%"),
  );
  state.live = {
    ...state.live!,
    settings: {
      ...historicalSettings,
      historicalSettings: undefined,
      current: { modelId: "live-model", effort: "low" },
    },
    usage: { available: true, state: "ready", usedTokens: 50, contextWindow: 100 },
  };
  view.rerender(<CodexComposerControls {...props} />);
  expect(await screen.findByRole("button", { name: /live-model/ })).toBeVisible();
  expect(screen.getByRole("img", { name: "Context usage" })).toHaveAccessibleDescription(
    expect.stringContaining("50%"),
  );
});
