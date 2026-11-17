// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { sessionProviderCapabilities, type CodexSessionSettings } from "@agentkib/web-client";
import { CodexComposerControls } from "./codex-session-controls";
import { useSession } from "./session-context";
import { codexCopy, codexReason } from "./codex-copy";
import { composerModelCopy, planModeCopy } from "@agentkib/session-ui";
import { contextUsageCopy } from "./context-usage-copy";

vi.mock("./session-context", () => ({ useSession: vi.fn() }));
let state: ReturnType<typeof useSession>;
let props: Parameters<typeof CodexComposerControls>[0];
const copy = codexCopy["en-US"];
const settings: CodexSessionSettings = {
  sessionId: "session",
  provider: sessionProviderCapabilities("deepseek-harness"),
  revision: 1,
  available: true,
  current: { modelId: "deepseek/deepseek-chat", effort: "low" },
  defaults: { modelId: "deepseek/deepseek-chat" },
  writable: {
    model: { available: true },
    effort: { available: true },
    restoreDefaults: { available: true },
    mode: { available: false },
    policy: { available: false },
    serviceTier: { available: false },
  },
  options: {
    models: [
      { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", efforts: ["low", "high"] },
      { id: "mock%2Flocal/m-1", name: "Mock One", efforts: [] },
    ],
    policies: [],
    serviceTiers: [],
  },
} as unknown as CodexSessionSettings;
beforeEach(() => {
  props = { resources: [], setResources: vi.fn(), openPhoneFiles: vi.fn(), disabled: false };
  state = {
    selected: "session",
    current: { id: "session", agent: "deepseek-harness" },
    locale: "en-US",
    online: true,
    busy: false,
    usageEpoch: "observation-a",
    access: { bootId: "boot", device: { id: "device", accessMode: "full" } },
    live: { sessionId: "session", status: "idle", revision: 1 },
    capabilities: {
      sessionId: "session",
      features: { settings: { available: true }, "settings-state": { available: true } },
    },
    client: {
      sessionSettings: vi.fn(async () => settings),
      sessionGoals: vi.fn(),
      sessionResources: vi.fn(),
      codexSessionSettings: vi.fn(),
      codexGoals: vi.fn(),
      codexContextOptions: vi.fn(),
    },
    codexAction: vi.fn(),
    control: vi.fn(),
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(cleanup);

describe("DeepSeek Harness model settings in the composer", () => {
  it("reads DSH's own models without showing a settings panel when there are no permissions", async () => {
    render(<CodexComposerControls {...props} />);
    await waitFor(() =>
      expect(state.client.sessionSettings).toHaveBeenCalledWith("session", "deepseek-harness"),
    );
    expect(await screen.findByRole("button", { name: /DeepSeek Chat/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: new RegExp(`^${copy.executionPolicy}:`) }),
    ).not.toBeInTheDocument();
    expect(state.client.codexSessionSettings).not.toHaveBeenCalled();
    expect(state.client.codexGoals).not.toHaveBeenCalled();
    // Without goal, resource or attachment capabilities there is nothing to add.
    expect(state.client.sessionGoals).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: copy.addContext })).toBeDisabled();
    expect(screen.queryByRole("img", { name: copy.contextUsage })).not.toBeInTheDocument();
  });

  it("keeps permission presets accessible when the plugin offers no model settings", async () => {
    vi.mocked(state.client.sessionSettings).mockResolvedValue({
      ...settings,
      current: { policyId: "read-only" },
      writable: {
        ...settings.writable,
        model: { available: false },
        effort: { available: false },
        policy: { available: true },
      },
      options: {
        ...settings.options,
        models: [],
        policies: [{ id: "read-only", name: "Read Only" }],
      },
    });
    render(<CodexComposerControls {...props} />);
    fireEvent.click(
      await screen.findByRole("button", { name: new RegExp(`^${copy.executionPolicy}:`) }),
    );
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /^Read Only/ })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    const picker = composerModelCopy["en-US"];
    expect(
      screen.queryByRole("button", { name: new RegExp(`^${picker.chooseModel}:`) }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: new RegExp(`^${picker.chooseEffort}:`) }),
    ).not.toBeInTheDocument();
    expect(menu).not.toHaveTextContent(contextUsageCopy["en-US"].unavailableDetail);
  });

  it("says once, while a turn runs, that the settings wait for it", async () => {
    const busy = { available: false, reason: "session-busy" };
    state = {
      ...state,
      live: { sessionId: "session", status: "running", revision: 1 },
      capabilities: {
        sessionId: "session",
        features: { settings: busy, "settings-state": { available: true } },
      },
      client: {
        ...state.client,
        sessionSettings: vi.fn(async () => ({
          ...settings,
          writable: { ...settings.writable, model: busy, effort: busy },
        })),
      },
    } as unknown as ReturnType<typeof useSession>;
    render(<CodexComposerControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: /DeepSeek Chat/ }));
    expect(await screen.findByText(copy.settingsWhileRunning)).toBeInTheDocument();
    expect(screen.queryByText(codexReason("en-US", "session-busy").text)).not.toBeInTheDocument();
  });

  it("switches the permission preset during a turn, while the model waits", async () => {
    const busy = { available: false, reason: "session-busy" };
    state = {
      ...state,
      live: { sessionId: "session", status: "running", revision: 1 },
      client: {
        ...state.client,
        sessionSettings: vi.fn(async () => ({
          ...settings,
          current: { ...settings.current, policyId: "workspace-write" },
          writable: {
            ...settings.writable,
            model: busy,
            effort: busy,
            policy: { available: true },
          },
          options: {
            ...settings.options,
            policies: [
              { id: "read-only", name: "Read Only" },
              { id: "workspace-write", name: "Workspace write · ask when needed" },
            ],
          },
        })),
      },
    } as unknown as ReturnType<typeof useSession>;
    render(<CodexComposerControls {...props} />);
    const permissions = await screen.findByRole("button", {
      name: new RegExp(`^${copy.executionPolicy}:`),
    });
    expect(permissions).toHaveTextContent("Workspace Write");
    fireEvent.click(permissions);
    expect(await screen.findByText(copy.settingsWhileRunningModel)).toBeInTheDocument();
    expect(screen.queryByText(copy.settingsWhileRunning)).not.toBeInTheDocument();
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /^Workspace Write/ })).toBeVisible();
    expect(menu).not.toHaveTextContent("workspace-write");
    const readOnly = within(menu).getByRole("menuitem", { name: /^Read Only/ });
    expect(readOnly).not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(readOnly);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("settings", {
      policyId: "read-only",
    });
  });

  it("explains nothing about pausing, resuming or clearing while there is no goal", async () => {
    const unavailable = { available: false, reason: "goal-action-unavailable" };
    state = {
      ...state,
      capabilities: {
        sessionId: "session",
        features: Object.fromEntries(
          ["settings", "settings-state", "goal", "goal-set", "goal-pause", "goal-resume"].map(
            (name) => [name, { available: true }],
          ),
        ),
      },
      client: {
        ...state.client,
        sessionGoals: vi.fn(async () => ({
          sessionId: "session",
          available: true,
          revision: 1,
          budget: "rounds",
          actions: {
            set: { available: true },
            pause: unavailable,
            resume: unavailable,
            clear: unavailable,
          },
        })),
      },
    } as unknown as ReturnType<typeof useSession>;
    render(<CodexComposerControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: copy.addContext }));
    fireEvent.click(await screen.findByRole("button", { name: copy.goals }));
    expect(await screen.findByLabelText(copy.goalObjective)).toBeVisible();
    expect(screen.getByRole("button", { name: copy.goalCreate })).toBeInTheDocument();
    expect(
      screen.queryByText(codexReason("en-US", "goal-action-unavailable").text),
    ).not.toBeInTheDocument();
  });

  it("turns DSH Plan mode off from the shared add menu", async () => {
    state = {
      ...state,
      client: {
        ...state.client,
        sessionSettings: vi.fn(async () => ({
          ...settings,
          current: { ...settings.current, mode: "plan" },
          writable: { ...settings.writable, mode: { available: true } },
          options: {
            ...settings.options,
            collaborationModes: [
              { id: "default", name: "Default" },
              { id: "plan", name: "Plan" },
            ],
          },
        })),
      },
      codexAction: vi.fn(async () => ({ accepted: true })),
    } as unknown as ReturnType<typeof useSession>;
    render(<CodexComposerControls {...props} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: copy.addContext })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: copy.addContext }));
    const add = within(await screen.findByRole("dialog", { name: copy.addContext }));
    fireEvent.click(add.getByRole("button", { name: planModeCopy("en-US").title, pressed: true }));
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledWith("settings", { mode: "default" }),
    );
  });

  it("switches the model and its effort in the composer, as DSH's own window does", async () => {
    const picker = composerModelCopy["en-US"];
    state = {
      ...state,
      client: {
        ...state.client,
        // DSH's own effort is the model's default; its models come from two providers.
        sessionSettings: vi.fn(async () => ({
          ...settings,
          current: { modelId: "deepseek/deepseek-chat" },
          options: {
            ...settings.options,
            models: [
              {
                id: "deepseek/deepseek-chat",
                name: "DeepSeek Chat",
                group: "DeepSeek",
                efforts: ["off", "low", "high", "max"],
                defaultEffort: "high",
                serviceTierIds: [],
              },
              { id: "mock%2Flocal/m-1", name: "Mock One", group: "Local", efforts: [] },
            ],
          },
        })),
      },
    } as unknown as ReturnType<typeof useSession>;
    render(<CodexComposerControls {...props} />);
    // A model-only session has a single entry point.
    expect(
      await screen.findByRole("button", { name: `${picker.chooseEffort}: DeepSeek Chat` }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: new RegExp(`^${copy.executionPolicy}:`) }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `${picker.chooseEffort}: DeepSeek Chat` }));
    const popup = await screen.findByRole("dialog");
    expect(within(popup).getByText(`${picker.defaultEffort} · High`)).toBeInTheDocument();
    // DSH has no service tiers, so no Fast mode to offer.
    expect(within(popup).queryByRole("button", { name: picker.fast })).not.toBeInTheDocument();
    fireEvent.click(
      within(popup).getByRole("button", { name: `${picker.chooseModel}: DeepSeek Chat` }),
    );
    const models = await screen.findByRole("dialog", { name: picker.model });
    expect(within(models).getByText("DeepSeek")).toBeVisible();
    expect(within(models).getByText("Local")).toBeVisible();
    fireEvent.click(within(models).getByRole("button", { name: "Mock One" }));
    // A default effort stays the default of the model chosen.
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledWith("settings", { model: "mock%2Flocal/m-1" }),
    );
  });
});
