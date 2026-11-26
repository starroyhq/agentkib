// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "@/features/sessions/conversation/desktop-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { sessionProviderCapabilities, type SessionSettings } from "@agentkib/web-client";
import { SessionComposerControls } from "@agentkib/session-ui";
import type { useSession } from "../../desktop-session-context";
import { sessionCopy, sessionReason } from "../../session-copy";
import { composerModelCopy, planModeCopy, contextUsageCopy } from "@agentkib/session-ui";

let state: ReturnType<typeof useSession>;
let props: Omit<Parameters<typeof SessionComposerControls>[0], "session">;
const copy = sessionCopy["en-US"];
const settings: SessionSettings = {
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
} as unknown as SessionSettings;
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
      codexGoals: vi.fn(),
      codexContextOptions: vi.fn(),
    },
    runSessionAction: vi.fn(),
    control: vi.fn(),
  } as unknown as ReturnType<typeof useSession>;
});
afterEach(cleanup);

describe("DeepSeek Harness model settings in the composer", () => {
  it("reads DSH's own models and disables the registered picker when no policy is available", async () => {
    render(<SessionComposerControls session={state} {...props} />);
    await waitFor(() =>
      expect(state.client.sessionSettings).toHaveBeenCalledWith("session", "deepseek-harness"),
    );
    expect(await screen.findByRole("button", { name: /DeepSeek Chat/ })).toBeInTheDocument();
    const permission = screen.getByRole("button", { name: copy.executionPolicy });
    expect(permission).toBeDisabled();
    expect(permission).toHaveAttribute("title", copy.settingUnavailable);
    fireEvent.click(permission);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(state.client.codexGoals).not.toHaveBeenCalled();
    expect(state.client.sessionGoals).not.toHaveBeenCalled();
    const gauge = screen.getByRole("img", { name: copy.contextUsage });
    expect(gauge).toHaveAccessibleDescription(contextUsageCopy["en-US"].permission);
    expect(gauge.querySelector("circle[pathLength]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: copy.addContext }));
    fireEvent.click(await screen.findByRole("button", { name: copy.goals }));
    const goalDialog = within(await screen.findByRole("dialog", { name: copy.goals }));
    expect(goalDialog.getByRole("textbox", { name: copy.goalObjective })).toBeDisabled();
    expect(goalDialog.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(state.client.sessionGoals).not.toHaveBeenCalled();
  });

  it("keeps permission presets accessible when the plugin offers no model settings", async () => {
    vi.mocked(state.client.sessionSettings).mockResolvedValue({
      ...settings,
      current: { policyId: "read-only" },
      writable: {
        ...settings.writable,
        model: { available: false },
        effort: { available: false },
        restoreDefaults: { available: false },
        policy: { available: true },
      },
      options: {
        ...settings.options,
        models: [],
        policies: [{ id: "read-only", name: "Read Only" }],
      },
    });
    render(<SessionComposerControls session={state} {...props} />);
    fireEvent.click(
      await screen.findByRole("button", { name: new RegExp(`^${copy.executionPolicy}:`) }),
    );
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /^Read Only/ })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    const picker = composerModelCopy["en-US"];
    const model = screen.getByRole("button", { name: new RegExp(`^${picker.chooseModel}:`) });
    expect(model).toBeDisabled();
    expect(model).toHaveAttribute("title", copy.settingUnavailable);
    fireEvent.click(model);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: new RegExp(`^${picker.chooseEffort}:`) }),
    ).not.toBeInTheDocument();
    expect(menu).not.toHaveTextContent(contextUsageCopy["en-US"].awaitingCliReport);
  });

  it("greys settings the executor cannot write during a turn", async () => {
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
    render(<SessionComposerControls session={state} {...props} />);
    const model = await screen.findByRole("button", { name: /DeepSeek Chat/ });
    expect(model).toBeDisabled();
    fireEvent.click(model);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.runSessionAction).not.toHaveBeenCalled();
  });

  it("re-enables the permission preset only after an authorized idle read", async () => {
    const busy = { available: false, reason: "session-busy" };
    const presetSettings = {
      ...settings,
      current: { ...settings.current, policyId: "workspace-write" },
      options: {
        ...settings.options,
        policies: [
          { id: "read-only", name: "Read Only" },
          { id: "workspace-write", name: "Workspace write · ask when needed" },
        ],
      },
    };
    state = {
      ...state,
      live: { sessionId: "session", status: "running", revision: 1 },
      capabilities: {
        ...state.capabilities!,
        features: { ...state.capabilities!.features, settings: busy },
      },
      client: {
        ...state.client,
        sessionSettings: vi.fn(async () => ({
          ...presetSettings,
          writable: {
            ...settings.writable,
            model: busy,
            effort: busy,
            policy: busy,
          },
        })),
      },
    } as unknown as ReturnType<typeof useSession>;
    const view = render(<SessionComposerControls session={state} {...props} />);
    const permissions = await screen.findByRole("button", {
      name: new RegExp(`^${copy.executionPolicy}:`),
    });
    expect(permissions).toHaveTextContent("Workspace Write");
    expect(permissions).toBeDisabled();
    fireEvent.click(permissions);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(state.runSessionAction).not.toHaveBeenCalled();

    vi.mocked(state.client.sessionSettings).mockResolvedValue({
      ...presetSettings,
      revision: 2,
      writable: { ...settings.writable, policy: { available: true } },
    });
    state.live = { ...state.live!, status: "idle", revision: 2 };
    state.capabilities!.features.settings = { available: true };
    view.rerender(<SessionComposerControls session={state} {...props} />);
    await waitFor(() => expect(permissions).toBeEnabled());
    fireEvent.click(permissions);
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("status")).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /^Workspace Write/ })).toBeVisible();
    expect(menu).not.toHaveTextContent("workspace-write");
    const readOnly = within(menu).getByRole("menuitem", { name: /^Read Only/ });
    await waitFor(() => expect(readOnly).not.toHaveAttribute("aria-disabled", "true"));
    await userEvent.click(readOnly);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.runSessionAction).toHaveBeenCalledExactlyOnceWith("settings", {
      policyId: "read-only",
    });
  });

  it("keeps pause and clear disabled while there is no goal", async () => {
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
    render(<SessionComposerControls session={state} {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: copy.addContext }));
    fireEvent.click(await screen.findByRole("button", { name: copy.goals }));
    expect(await screen.findByLabelText(copy.goalObjective)).toBeVisible();
    expect(screen.getByRole("button", { name: copy.goalCreate })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.goalPause })).toBeDisabled();
    expect(screen.getByRole("button", { name: copy.goalClear })).toBeDisabled();
    expect(
      screen.queryByText(sessionReason("en-US", "goal-action-unavailable").text),
    ).not.toBeInTheDocument();
  });

  it("omits the goal for a provider without a registered goal control", async () => {
    state.current = { ...state.current!, agent: "devin" };
    state.capabilities!.features.goal = { available: true };
    state.capabilities!.features.resources = { available: true };
    render(<SessionComposerControls session={state} {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: copy.addContext }));
    expect(await screen.findByRole("button", { name: "Files and folders" })).toBeVisible();
    expect(screen.queryByRole("button", { name: copy.goals })).not.toBeInTheDocument();
    expect(state.client.sessionGoals).not.toHaveBeenCalled();
  });

  it("applies a staged goal once the first turn has finished and the controller is ready", async () => {
    state.controlReady = true;
    state.capabilities!.features.goal = { available: true };
    state.capabilities!.features["goal-set"] = { available: true };
    vi.mocked(state.client.sessionGoals).mockImplementation(async () => ({
      sessionId: "session",
      available: true,
      revision: state.live!.revision!,
      budget: "rounds",
      actions: {
        set: { available: true },
        pause: { available: false },
        resume: { available: false },
        clear: { available: false },
      },
    }));
    vi.mocked(state.runSessionAction).mockResolvedValue({ accepted: true });
    const onStartupGoalHandled = vi.fn();
    const startupGoal = { value: { objective: "Ship it" }, apply: true, afterRevision: 1 };
    const controls = () => (
      <SessionComposerControls
        session={state}
        {...props}
        startupGoal={startupGoal}
        onStartupGoalHandled={onStartupGoalHandled}
      />
    );
    const { rerender } = render(controls());
    await waitFor(() => expect(state.client.sessionGoals).toHaveBeenCalled());
    expect(state.runSessionAction).not.toHaveBeenCalled();
    state.controlReady = false;
    state.live = { ...state.live!, revision: 2 };
    rerender(controls());
    await waitFor(() => expect(state.client.sessionGoals).toHaveBeenCalledTimes(2));
    expect(state.runSessionAction).not.toHaveBeenCalled();
    state.controlReady = true;
    rerender(controls());
    await waitFor(() => expect(onStartupGoalHandled).toHaveBeenLastCalledWith(true));
    expect(onStartupGoalHandled.mock.calls).toEqual([[false], [true]]);
    expect(state.runSessionAction).toHaveBeenCalledExactlyOnceWith("goal-set", {
      objective: "Ship it",
      intent: "start",
      tokenBudget: null,
    });
  });

  it("shows DSH Plan mode in the add menu and exits it from the toolbar", async () => {
    let mode = "plan";
    state = {
      ...state,
      client: {
        ...state.client,
        sessionSettings: vi.fn(async () => ({
          ...settings,
          current: { ...settings.current, mode },
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
      runSessionAction: vi.fn(async () => {
        mode = "default";
        return true;
      }),
    } as unknown as ReturnType<typeof useSession>;
    render(<SessionComposerControls session={state} {...props} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: copy.addContext })).toBeEnabled(),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: copy.addContext }));
    const add = within(await screen.findByRole("dialog", { name: copy.addContext }));
    expect(
      add.getByRole("button", { name: planModeCopy("en-US").title, pressed: true }),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Exit Plan mode" }));
    await waitFor(() =>
      expect(state.runSessionAction).toHaveBeenCalledExactlyOnceWith("settings", {
        mode: "default",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Exit Plan mode" })).not.toBeInTheDocument(),
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
    render(<SessionComposerControls session={state} {...props} />);
    // A model-only session has a single entry point.
    expect(
      await screen.findByRole("button", { name: `${picker.chooseEffort}: DeepSeek Chat` }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: new RegExp(`^${copy.executionPolicy}:`) }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `${picker.chooseEffort}: DeepSeek Chat` }));
    const popup = await screen.findByRole("dialog");
    expect(within(popup).getByText(picker.defaultEffort)).toBeInTheDocument();
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
      expect(state.runSessionAction).toHaveBeenCalledWith("settings", {
        model: "mock%2Flocal/m-1",
      }),
    );
  });
});
