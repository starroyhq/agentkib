// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { permissionModeCopy } from "@agentkib/session-ui";
import { createRef, type RefObject } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  forgetSessionModelDisplay,
  rememberSessionModelDisplay,
  sessionProviderCapabilities,
  type CodexSessionSettings,
} from "@agentkib/web-client";
import { CodexComposerControls, type ComposerControlsHandle } from "./codex-session-controls";
import { useSession } from "./session-context";
import { sessionAgentCopy } from "./session-agent-copy";
import { codexCopy } from "./codex-copy";
import {
  composerGoalCopy,
  composerModelCopy,
  composerSettingsSelection,
  confirmsComposerSettings,
  newSessionCopy,
  planModeCopy,
} from "@agentkib/session-ui";
import { SessionComposer } from "./session-composer";

vi.mock("./session-context", () => ({ useSession: vi.fn() }));
let state: ReturnType<typeof useSession>;
let props: Parameters<typeof CodexComposerControls>[0];
function settings(id = "session"): CodexSessionSettings {
  return {
    sessionId: id,
    revision: 1,
    available: true,
    current: { modelId: "model", effort: "low" },
    defaults: { modelId: "model" },
    writable: {
      model: { available: true },
      effort: { available: true },
      permissionMode: { available: true },
      restoreDefaults: { available: true },
      mode: { available: false },
      policy: { available: false },
      serviceTier: { available: false },
    },
    options: {
      models: [{ id: "model", name: `Claude ${id}`, efforts: ["low"], serviceTierIds: [] }],
      permissionModes: [{ id: "default", name: "Default" }],
      policies: [],
      serviceTiers: [],
    },
  };
}
function deferred() {
  let resolve!: (value: CodexSessionSettings) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<CodexSessionSettings>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  props = { resources: [], setResources: vi.fn(), openPhoneFiles: vi.fn(), disabled: false };
  state = {
    selected: "session",
    current: { id: "session", agent: "claude-code" },
    locale: "en-US",
    online: true,
    busy: false,
    usageEpoch: "observation-a",
    access: { bootId: "boot", device: { id: "device", accessMode: "full" } },
    live: { sessionId: "session", status: "idle", revision: 1, executionMode: "claude-managed" },
    capabilities: { sessionId: "session", features: { settings: { available: true } } },
    client: {
      sessionSettings: vi.fn(async (id: string) => settings(id)),
      prepareSessionSettings: vi.fn(async ({ sessionId }: { sessionId: string }) =>
        settings(sessionId),
      ),
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

function permissionTrigger(locale = state.locale) {
  return screen.findByRole("button", {
    name: new RegExp(`^${sessionAgentCopy[locale].permission}(?::|$)`),
  });
}

async function openColdPermissions() {
  fireEvent.click(await screen.findByRole("button", { name: /^Select reasoning effort:/ }));
  const popup = await screen.findByRole("dialog");
  fireEvent.keyDown(popup, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  fireEvent.click(await permissionTrigger());
}

describe("Claude's model in the composer", () => {
  it.each(["effort", "all"] as const)(
    "uses a confirmed next-turn clear of %s overrides for the editable selection",
    (clear) => {
      const value: CodexSessionSettings = {
        ...settings(),
        revision: 2,
        applicationStatus: "pending",
        current: { modelId: "model", effort: "low", permissionMode: "acceptEdits" },
        defaults: { modelId: "configured-model", effort: "high" },
        selected: clear === "all" ? {} : { modelId: "model", permissionMode: "acceptEdits" },
      };
      const pending = {
        expectedRevision: 1,
        nextTurn: true,
        ...(clear === "all" ? { restoreDefaults: true as const } : { effort: null }),
      };
      const kind = { prepared: true, variants: false, follower: false };
      expect(confirmsComposerSettings(value, pending, kind)).toBe(true);
      expect(confirmsComposerSettings({ ...value, revision: 1 }, pending, kind)).toBe(false);
      expect(confirmsComposerSettings({ ...value, selected: value.current }, pending, kind)).toBe(
        false,
      );
      expect(composerSettingsSelection(value, true)).toEqual(value.current);
      const expected = clear === "all" ? { modelId: "configured-model" } : value.selected;
      expect(composerSettingsSelection(value, true, { staged: pending })).toEqual(expected);
      const live = {
        ...state.live!,
        revision: 2,
        status: "running" as const,
        executionLocation: "agentkib" as const,
      };
      expect(composerSettingsSelection(value, true, { live })).toEqual(expected);
      expect(
        composerSettingsSelection(value, true, {
          live: { ...live, executionLocation: "external" },
        }),
      ).toEqual(value.current);
    },
  );

  it("switches the model and its effort in the composer, with the model's default effort", async () => {
    const picker = composerModelCopy["en-US"];
    state.client.sessionSettings = vi.fn(async (id: string) => ({
      ...settings(id),
      current: { modelId: "model" },
      options: {
        ...settings(id).options,
        models: [
          {
            id: "model",
            name: "Claude session",
            efforts: ["low", "high"],
            defaultEffort: "high",
            serviceTierIds: [],
          },
        ],
      },
    }));
    render(<CodexComposerControls {...props} />);
    // The settings button names no model; the composer's model control does.
    const trigger = await screen.findByRole("button", {
      name: `${picker.chooseEffort}: Claude session`,
    });
    expect(await permissionTrigger()).toBeEnabled();
    fireEvent.click(trigger);
    const popup = await screen.findByRole("dialog");
    // Claude Code reports no effort for the model's own default; it has no Fast mode.
    expect(within(popup).getByText(`${picker.defaultEffort} · High`)).toBeInTheDocument();
    expect(within(popup).queryByRole("button", { name: picker.fast })).not.toBeInTheDocument();
  });
});

describe("Claude's plan mode in the composer", () => {
  it("turns Plan mode off from the shared add menu", async () => {
    state.client.sessionSettings = vi.fn(async (id: string) => ({
      ...settings(id),
      current: { modelId: "model", effort: "low", permissionMode: "plan" as const },
      options: {
        ...settings(id).options,
        permissionModes: [
          { id: "default" as const, name: "Default" },
          { id: "plan" as const, name: "Plan" },
        ],
      },
    }));
    vi.mocked(state.codexAction).mockResolvedValue({ accepted: true } as unknown as Awaited<
      ReturnType<typeof state.codexAction>
    >);
    render(<CodexComposerControls {...props} />);
    const addLabel = codexCopy["en-US"].addContext;
    fireEvent.click(await screen.findByRole("button", { name: addLabel }));
    const add = within(await screen.findByRole("dialog", { name: addLabel }));
    fireEvent.click(
      await add.findByRole("button", { name: planModeCopy("en-US").title, pressed: true }),
    );
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledWith("settings", { permissionMode: "default" }),
    );
  });
});

it("stages a goal without a native operation until an imported Claude conversation sends and becomes idle", async () => {
  const copy = codexCopy["en-US"];
  const goalCopy = composerGoalCopy("en-US");
  state.access = {
    ...state.access!,
    status: "approved",
    device: { ...state.access!.device!, advancedControl: true },
  };
  state.live = {
    ...state.live!,
    executionMode: "managed-resume",
    sendEnabled: true,
    approvals: [],
    questions: [],
  };
  state.canSend = true;
  state.controlReady = true;
  state.t = { message: "Message", send: "Send" } as typeof state.t;
  state.setMessage = vi.fn();
  state.message = "";
  state.capabilities = {
    ...state.capabilities!,
    features: { "goal-draft": { available: true } },
  };
  state.client.sessionGoals = vi.fn(async () => ({
    sessionId: "session",
    available: true,
    revision: 2,
    actions: {
      set: { available: true },
      pause: { available: false },
      resume: { available: false },
      clear: { available: false },
    },
  }));
  vi.mocked(state.control).mockResolvedValue(true);
  vi.mocked(state.codexAction).mockResolvedValue({ accepted: true } as Awaited<
    ReturnType<typeof state.codexAction>
  >);
  const { rerender } = render(<SessionComposer />);

  fireEvent.click(screen.getByRole("button", { name: copy.addContext }));
  fireEvent.click(await screen.findByRole("button", { name: goalCopy.title }));
  const editor = await screen.findByRole("dialog", { name: goalCopy.title });
  expect(within(editor).getByRole("button", { name: goalCopy.saveDraft })).toBeDisabled();
  fireEvent.change(within(editor).getByRole("textbox", { name: goalCopy.objective }), {
    target: { value: "  Improve the test coverage  " },
  });
  fireEvent.change(within(editor).getByRole("spinbutton", { name: goalCopy.budget }), {
    target: { value: "3000" },
  });
  fireEvent.click(within(editor).getByRole("button", { name: goalCopy.saveDraft }));
  expect(screen.getByRole("button", { name: goalCopy.title })).toHaveAttribute(
    "title",
    "Improve the test coverage",
  );
  expect(state.client.sessionGoals).not.toHaveBeenCalled();
  expect(state.control).not.toHaveBeenCalled();
  expect(state.codexAction).not.toHaveBeenCalled();

  state.message = "Start reviewing the project";
  rerender(<SessionComposer />);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(state.control).toHaveBeenCalledTimes(1));
  expect(state.codexAction).not.toHaveBeenCalled();

  state.live = { ...state.live, executionMode: "claude-managed", revision: 2 };
  state.capabilities = {
    ...state.capabilities,
    features: { goal: { available: true }, "goal-set": { available: true } },
  };
  rerender(<SessionComposer />);
  await waitFor(() =>
    expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("goal-set", {
      objective: "Improve the test coverage",
      intent: "start",
      tokenBudget: 3000,
    }),
  );
});

describe("Claude settings preparation", () => {
  it("shows the last used model and saved next-turn settings on first open", async () => {
    state.locale = "zh-Hant";
    state.access = {
      ...state.access!,
      status: "approved",
      device: { ...state.access!.device!, advancedControl: true },
    };
    state.live = { ...state.live!, executionLocation: null };
    const cold = settings();
    vi.mocked(state.client.sessionSettings).mockResolvedValue({
      ...cold,
      executionMode: "claude-managed",
      applicationStatus: "pending",
      current: {},
      historicalSettings: { modelId: "claude-opus-5-5" },
      selected: { modelId: "opus", effort: "max" },
      defaults: {},
      options: { ...cold.options, models: [] },
    });

    const view = render(<CodexComposerControls {...props} />);
    const trigger = await screen.findByRole("button", {
      name: /下輪設定 Opus · 最高.*上次使用 claude-opus-5-5/,
    });
    expect(within(trigger).getByText("上次使用 claude-opus-5-5")).toBeVisible();
    expect(within(trigger).getByText("下輪設定 Opus · 最高")).toBeVisible();
    expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
    expect(state.codexAction).not.toHaveBeenCalled();

    state.access = {
      ...state.access,
      device: { ...state.access.device!, advancedControl: false },
    };
    view.rerender(<CodexComposerControls {...props} />);
    expect(screen.queryByText("上次使用 claude-opus-5-5")).not.toBeInTheDocument();
    expect(screen.queryByText("下輪設定 Opus · 最高")).not.toBeInTheDocument();
  });

  it("displays the saved model before an unrelated goal read settles", async () => {
    state.live = { ...state.live!, executionLocation: null };
    state.capabilities = {
      ...state.capabilities!,
      features: {
        settings: { available: true },
        "settings-state": { available: true },
        goal: { available: true },
      },
    };
    const cold = settings();
    vi.mocked(state.client.sessionSettings).mockResolvedValue({
      ...cold,
      applicationStatus: "pending",
      current: {},
      selected: { modelId: "opus", effort: "max" },
      defaults: {},
      options: { ...cold.options, models: [] },
    });
    type Goals = Awaited<ReturnType<typeof state.client.sessionGoals>>;
    const pendingGoals = new Promise<Goals>(() => {});
    state.client.sessionGoals = vi.fn(() => pendingGoals);

    render(<CodexComposerControls {...props} />);
    await waitFor(() => expect(state.client.sessionGoals).toHaveBeenCalled());
    expect(
      await screen.findByRole("button", { name: "Select reasoning effort: opus · Maximum" }),
    ).toBeVisible();
    expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
    expect(state.codexAction).not.toHaveBeenCalled();
  });

  it("reserves Claude settings controls before reading the session's capabilities", async () => {
    const capabilities = state.capabilities;
    state = {
      ...state,
      access: {
        ...state.access!,
        status: "approved",
        device: { ...state.access!.device!, advancedControl: true },
      },
      capabilities: undefined,
    };
    const picker = composerModelCopy["en-US"];
    const { rerender } = render(<CodexComposerControls {...props} />);
    const model = screen.getByRole("button", { name: picker.modelSettings });
    const permissions = screen.getByRole("button", { name: sessionAgentCopy["en-US"].permission });
    expect(model).toBeEnabled();
    expect(permissions).toBeEnabled();
    fireEvent.click(model);
    expect(await screen.findByRole("dialog")).toBeVisible();
    await act(async () => {});
    expect(state.client.sessionSettings).not.toHaveBeenCalled();
    expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
    expect(state.codexAction).not.toHaveBeenCalled();

    state = { ...state, capabilities };
    rerender(<CodexComposerControls {...props} />);
    expect(
      await screen.findByRole("button", { name: /^Select reasoning effort: Claude session/ }),
    ).toBeEnabled();
    expect(state.client.sessionSettings).toHaveBeenCalledWith("session", "claude-code");
    expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
  });

  it("loads the native model catalog from the picker when a session has no options yet", async () => {
    const picker = composerModelCopy["en-US"];
    const value = { ...settings(), provider: sessionProviderCapabilities("claude-code") };
    vi.mocked(state.client.sessionSettings).mockResolvedValue({
      ...value,
      current: {},
      options: { ...value.options, models: [] },
    });
    const catalog = deferred();
    vi.mocked(state.client.prepareSessionSettings).mockReturnValueOnce(catalog.promise);
    render(<CodexComposerControls {...props} />);
    await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: /^Select reasoning effort: model/ }));
    const overview = await screen.findByRole("dialog");
    fireEvent.click(within(overview).getByRole("button", { name: /^Select model(?::|$)/ }));
    const models = await screen.findByRole("dialog", { name: picker.model });
    expect(await within(models).findByText("Reading model options…")).toBeVisible();
    await act(async () => catalog.resolve(value));
    expect(await within(models).findByRole("button", { name: "Claude session" })).toBeVisible();
    expect(within(models).queryByText("Reading model options…")).not.toBeInTheDocument();
    expect(state.client.prepareSessionSettings).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session",
      bootId: "boot",
      expectedRevision: 1,
    });
    expect(state.codexAction).not.toHaveBeenCalled();
  });

  it("leaves native preparation and effort reset unavailable for a Claude follower", async () => {
    const picker = composerModelCopy["en-US"];
    state.live = { ...state.live!, executionMode: "claude-follower" };
    vi.mocked(state.client.sessionSettings).mockResolvedValue({
      ...settings(),
      provider: sessionProviderCapabilities("claude-code"),
    });
    render(<CodexComposerControls {...props} />);
    fireEvent.click(
      await screen.findByRole("button", { name: `${picker.chooseEffort}: Claude session · Low` }),
    );
    const popup = await screen.findByRole("dialog");
    expect(within(popup).queryByRole("button", { name: picker.useDefaultEffort })).toBeNull();
    expect(within(popup).queryByRole("button", { name: picker.fast })).toBeNull();
    expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
    expect(state.codexAction).not.toHaveBeenCalled();
  });

  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "keeps unknown models in the model picker and out of the permissions panel in %s",
    async (locale) => {
      state.locale = locale;
      const value: CodexSessionSettings = { ...settings(), current: {}, defaults: {} };
      vi.mocked(state.client.sessionSettings).mockResolvedValue(value);
      vi.mocked(state.client.prepareSessionSettings).mockResolvedValue(value);
      const copy = codexCopy[locale];
      const picker = composerModelCopy[locale];
      render(<CodexComposerControls {...props} />);
      expect(screen.getByRole("button", { name: picker.modelSettings })).toBeInTheDocument();
      fireEvent.click(await permissionTrigger(locale));
      const panel = await screen.findByRole("menu");
      const defaultLabel = newSessionCopy(locale).permissions["claude-code"].choices.default.name;
      const permission = within(panel).getByRole("menuitem", {
        name: new RegExp(`^${defaultLabel}`),
      });
      await waitFor(() => expect(permission).not.toHaveAttribute("aria-disabled", "true"));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(within(panel).queryByLabelText(copy.model)).not.toBeInTheDocument();
      expect(within(panel).queryByLabelText(copy.effort)).not.toBeInTheDocument();
      expect(
        within(panel).queryByRole("button", { name: copy.restoreDefaults }),
      ).not.toBeInTheDocument();
      expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
      expect(state.codexAction).not.toHaveBeenCalled();
      expect(state.control).not.toHaveBeenCalled();
    },
  );

  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "shows only the supported menu choices before sending from an imported Claude session in %s",
    async (locale) => {
      state.locale = locale;
      state.live = { ...state.live!, executionMode: "managed-resume" };
      const value = settings();
      value.options.permissionModes = (["default", "acceptEdits", "plan"] as const).map((id) => ({
        id,
        name: id,
      }));
      vi.mocked(state.client.sessionSettings).mockResolvedValue(value);
      render(<CodexComposerControls {...props} />);
      fireEvent.click(
        await screen.findByRole("button", {
          name: sessionAgentCopy[locale].permission,
        }),
      );
      const menu = within(await screen.findByRole("menu"));
      const choices = newSessionCopy(locale).permissions["claude-code"].choices;
      expect(menu.getAllByRole("menuitem")).toHaveLength(2);
      for (const { name } of [choices.default, choices.acceptEdits]) {
        expect(menu.getByRole("menuitem", { name: new RegExp(`^${name}`) })).not.toHaveAttribute(
          "aria-current",
        );
      }
      expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
      expect(state.codexAction).not.toHaveBeenCalled();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "releases preparation busy after an observation change and a late %s",
    async (outcome) => {
      vi.mocked(state.client.sessionSettings).mockResolvedValueOnce({
        ...settings(),
        options: { ...settings().options, models: [] },
        writable: { ...settings().writable, permissionMode: { available: false } },
      });
      const pending = deferred();
      vi.mocked(state.client.prepareSessionSettings).mockReturnValueOnce(pending.promise);
      const view = render(<CodexComposerControls {...props} />);
      await openColdPermissions();
      const permission = await screen.findByRole("menuitem", { name: /^Manual approval/ });
      expect(permission).toHaveAttribute("aria-disabled", "true");
      state = { ...state, usageEpoch: "observation-b" };
      view.rerender(<CodexComposerControls {...props} />);
      await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalledTimes(2));
      await act(async () => {
        if (outcome === "resolve")
          pending.resolve({ ...settings(), current: { permissionMode: "plan" } });
        else pending.reject(new Error("stale-prepare-error"));
      });
      await waitFor(() => expect(permission).not.toHaveAttribute("aria-disabled", "true"));
      expect(await permissionTrigger()).toHaveAccessibleName("Tool permissions");
      expect(screen.queryByText("stale-prepare-error")).not.toBeInTheDocument();
      expect(state.client.prepareSessionSettings).toHaveBeenCalledTimes(1);
      expect(state.codexAction).not.toHaveBeenCalled();
      expect(state.control).not.toHaveBeenCalled();
    },
  );

  it.each(["session", "device"] as const)(
    "does not let a previous %s preparation clear a new request's busy state",
    async (scope) => {
      vi.mocked(state.client.sessionSettings).mockImplementation(async (id) => ({
        ...settings(id),
        options: { ...settings(id).options, models: [] },
        writable: { ...settings(id).writable, permissionMode: { available: false } },
      }));
      const old = deferred();
      const next = deferred();
      vi.mocked(state.client.prepareSessionSettings)
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(next.promise);
      const view = render(<CodexComposerControls {...props} />);
      await openColdPermissions();
      if (scope === "session") {
        state = {
          ...state,
          selected: "next",
          current: { ...state.current!, id: "next" },
          live: { ...state.live!, sessionId: "next" },
          capabilities: { ...state.capabilities!, sessionId: "next" },
        };
      } else {
        state = {
          ...state,
          access: { ...state.access!, device: { ...state.access!.device!, id: "next-device" } },
        };
      }
      view.rerender(<CodexComposerControls {...props} />);
      await openColdPermissions();
      expect(state.client.prepareSessionSettings).toHaveBeenCalledTimes(2);
      await act(async () => old.resolve(settings()));
      const permission = await screen.findByRole("menuitem", { name: /^Manual approval/ });
      expect(permission).toHaveAttribute("aria-disabled", "true");
      await act(async () =>
        next.resolve({ ...settings(state.selected), current: { permissionMode: "default" } }),
      );
      await waitFor(() => expect(permission).not.toHaveAttribute("aria-disabled", "true"));
      expect(await permissionTrigger()).toHaveTextContent("Manual approval");
      expect(state.codexAction).not.toHaveBeenCalled();
    },
  );
});

describe("opening the composer's dialogs for a bare command", () => {
  const open = (ref: RefObject<ComposerControlsHandle | null>, dialog: "settings" | "goal") => {
    let opened: boolean | undefined;
    act(() => {
      opened = ref.current!.open(dialog);
    });
    return opened;
  };

  it("opens the settings, and declines the goal this device cannot read", async () => {
    const ref = createRef<ComposerControlsHandle>();
    render(<CodexComposerControls {...props} controlsRef={ref} />);
    expect(open(ref, "goal")).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(open(ref, "settings")).toBe(true);
    expect(await screen.findByRole("menu")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.client.prepareSessionSettings).toHaveBeenCalledTimes(1);
  });

  it("declines while the composer is disabled or the device lacks full access", () => {
    const ref = createRef<ComposerControlsHandle>();
    const view = render(<CodexComposerControls {...props} disabled controlsRef={ref} />);
    expect(open(ref, "settings")).toBe(false);
    view.unmount();
    state.access = { bootId: "boot", device: { id: "device" } } as typeof state.access;
    const partial = createRef<ComposerControlsHandle>();
    render(<CodexComposerControls {...props} controlsRef={partial} />);
    expect(open(partial, "settings")).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
  });
});

describe("Claude settings rejection", () => {
  it.each([
    ["claude-model-unsupported", /support only the models they list/],
    ["claude-effort-unsupported", /can be only low, medium, high, xhigh, or max/],
  ] as const)(
    "explains %s and opens next-turn settings without submitting",
    async (reason, text) => {
      state.notice = "notDispatched";
      state.noticeReason = reason;
      render(<CodexComposerControls {...props} />);
      expect(await screen.findByText(text)).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Change model" }));
      const picker = composerModelCopy["en-US"];
      expect(
        await screen.findByRole("dialog", {
          name:
            reason === "claude-model-unsupported"
              ? picker.model
              : new RegExp(`^${picker.chooseEffort}:`),
        }),
      ).toBeVisible();
      await waitFor(() => expect(state.client.prepareSessionSettings).toHaveBeenCalledTimes(1));
      expect(state.codexAction).not.toHaveBeenCalled();
      expect(state.control).not.toHaveBeenCalled();
    },
  );

  it.each(["unsupported-model", "claude-command-settings"] as const)(
    "offers no settings shortcut for %s",
    (reason) => {
      state.notice = "notDispatched";
      state.noticeReason = reason;
      render(<CodexComposerControls {...props} />);
      expect(screen.queryByRole("button", { name: "Change model" })).not.toBeInTheDocument();
    },
  );
});

it("prepares an external owner's draft without enabling native sends or reusing its capabilities", async () => {
  const copy = codexCopy["en-US"];
  const goalCopy = composerGoalCopy("en-US");
  state.access = {
    ...state.access!,
    status: "approved",
    protocolVersion: 2,
    experimentalEnabled: true,
    device: {
      ...state.access!.device!,
      accessMode: "full",
      advancedControl: true,
      attachments: true,
      send: true,
    },
  };
  state.live = {
    ...state.live!,
    executionMode: "claude-managed",
    executionLocation: "external",
    ownershipReason: "claude-owner-busy",
    reason: "claude-owner-busy",
    sendEnabled: false,
    approvals: [],
    questions: [],
  };
  state.controlReady = true;
  state.canSend = false;
  state.message = "";
  state.setMessage = vi.fn();
  state.t = { message: "Message", send: "Send" } as typeof state.t;
  state.capabilities = {
    ...state.capabilities!,
    features: {
      settings: { available: true },
      "settings-state": { available: true },
      resources: { available: true },
      context: { available: true },
      attachments: { available: true },
      goal: { available: true },
      "goal-set": { available: false },
      "goal-draft": { available: true },
      send: { available: false, reason: "claude-owner-busy" },
    },
  };
  const prepared = {
    ...settings(),
    options: {
      ...settings().options,
      models: [
        { id: "model", name: "Claude session", efforts: ["low", "high"], serviceTierIds: [] },
      ],
      permissionModes: [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
        { id: "acceptEdits", name: "Accept edits" },
      ],
    },
  } satisfies CodexSessionSettings;
  vi.mocked(state.client.sessionSettings).mockResolvedValue(prepared);
  vi.mocked(state.client.prepareSessionSettings).mockResolvedValue(prepared);
  state.client.sessionGoals = vi.fn(async () => ({
    sessionId: "session",
    revision: 1,
    available: true,
    actions: {
      set: { available: false },
      pause: { available: false },
      resume: { available: false },
      clear: { available: false },
    },
  }));
  state.client.sessionResources = vi.fn(async () => ({
    sessionId: "session",
    revision: 1,
    resources: [],
  }));
  state.client.uploadAttachment = vi.fn(async () => ({
    id: "upload",
    name: "note.txt",
    mime: "text/plain",
    size: 3,
    version: "1",
  }));
  vi.mocked(state.codexAction).mockResolvedValue({ accepted: true } as Awaited<
    ReturnType<typeof state.codexAction>
  >);
  const view = render(<SessionComposer />);
  const model = await screen.findByRole("button", {
    name: /^Select reasoning effort: Claude session/,
  });
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  fireEvent.click(model);
  const modelPopup = await screen.findByRole("dialog");
  await waitFor(() =>
    expect(within(modelPopup).getByRole("button", { name: "Reset default model" })).toBeEnabled(),
  );
  fireEvent.keyDown(modelPopup, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  const add = screen.getByRole("button", { name: copy.addContext });
  fireEvent.click(add);
  const menu = within(await screen.findByRole("dialog", { name: copy.addContext }));
  expect(menu.getByRole("button", { name: "Choose attachment files" })).toBeEnabled();
  expect(menu.getByRole("button", { name: "Files and folders" })).toBeEnabled();
  fireEvent.click(menu.getByRole("button", { name: "Plan mode" }));
  await waitFor(() =>
    expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("settings", {
      permissionMode: "plan",
    }),
  );
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add);
  fireEvent.click(await screen.findByRole("button", { name: goalCopy.title }));
  const editor = within(await screen.findByRole("dialog", { name: goalCopy.title }));
  fireEvent.change(editor.getByRole("textbox", { name: goalCopy.objective }), {
    target: { value: "Prepare a review" },
  });
  fireEvent.click(editor.getByRole("button", { name: goalCopy.saveDraft }));
  expect(state.codexAction).toHaveBeenCalledTimes(1);
  state.message = "/";
  state.controlReady = false;
  view.rerender(<SessionComposer />);
  expect(
    within(screen.getByRole("listbox", { name: "Claude Code commands" }))
      .getAllByRole("option")
      .map((item) => item.textContent),
  ).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^\/model/),
      expect.stringMatching(/^\/effort/),
      expect.stringMatching(/^\/goal/),
      expect.stringMatching(/^\/plan/),
    ]),
  );
  state.message = "/goal Prepare another review";
  view.rerender(<SessionComposer />);
  fireEvent.submit(screen.getByRole("textbox", { name: "Message" }).closest("form")!);
  expect(state.codexAction).toHaveBeenCalledTimes(1);
  expect(state.control).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: goalCopy.title })).toHaveAttribute(
    "title",
    "Prepare another review",
  );
  state.message = "";
  state.controlReady = true;
  view.rerender(<SessionComposer />);
  fireEvent.change(screen.getByLabelText(copy.attachment, { selector: "input" }), {
    target: { files: [new File(["abc"], "note.txt", { type: "text/plain" })] },
  });
  await waitFor(() => expect(state.client.uploadAttachment).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(state.control).not.toHaveBeenCalled();
  state = {
    ...state,
    selected: "next",
    current: { ...state.current!, id: "next" },
    live: { ...state.live!, sessionId: "next" },
  };
  view.rerender(<SessionComposer />);
  expect(screen.getByRole("button", { name: copy.addContext })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: copy.addContext }));
  expect(screen.getByRole("button", { name: "Files and folders" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: /^Select reasoning effort: Claude session/ }),
  ).not.toBeInTheDocument();
});

it("opens the connected terminal's model picker only on explicit request and keeps the reported model", async () => {
  state.controlReady = true;
  state.access = {
    ...state.access!,
    status: "approved",
    device: { ...state.access!.device!, advancedControl: true },
  };
  state.live = { ...state.live!, executionMode: "claude-follower" };
  state.capabilities = {
    ...state.capabilities!,
    executionMode: "claude-follower",
    features: {
      "settings-state": { available: true },
      settings: { available: false, reason: "claude-follower-settings-unavailable" },
      "open-model-picker": { available: true },
    },
  };
  const reported = settings();
  reported.writable.model = { available: false, reason: "claude-follower-settings-unavailable" };
  vi.mocked(state.client.sessionSettings).mockResolvedValue(reported);
  vi.mocked(state.codexAction).mockResolvedValue({
    accepted: true,
    requestId: "request",
    sessionId: "session",
  });
  render(<CodexComposerControls {...props} />);
  const model = await screen.findByRole("button", { name: /^Model: Claude session/ });
  fireEvent.click(model);
  const dialog = within(await screen.findByRole("dialog"));
  const open = dialog.getByRole("button", { name: composerModelCopy["en-US"].openTerminalModel });
  expect(state.codexAction).not.toHaveBeenCalled();
  fireEvent.click(open);
  await waitFor(() => expect(open).toBeDisabled());
  expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("open-model-picker");
  expect(model).toHaveTextContent("Claude session");
  expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
  expect(state.control).not.toHaveBeenCalled();
});

it("keeps cached controls visible across an executor change and browses without applying references", async () => {
  state.access = {
    ...state.access!,
    status: "approved",
    device: { ...state.access!.device!, advancedControl: true },
  };
  const pending = deferred();
  const read = vi.mocked(state.client.sessionSettings);
  read.mockResolvedValueOnce(settings()).mockReturnValue(pending.promise);
  const context = {
    sessionId: "session",
    revision: 1,
    directoryId: "root",
    resources: [
      {
        id: "directory",
        kind: "directory" as const,
        name: "src",
        available: true,
        navigationId: "src-navigation",
      },
    ],
  };
  state.client.sessionResources = vi.fn(async () => context);
  const { rerender } = render(<CodexComposerControls {...props} />);
  const modelName = /^Select reasoning effort: Claude session/;
  await screen.findByRole("button", { name: modelName });
  state = {
    ...state,
    live: { ...state.live!, executionMode: "claude-follower", connectionGeneration: "second" },
    capabilities: undefined,
  };
  rerender(<CodexComposerControls {...props} />);
  expect(screen.getByRole("button", { name: modelName })).toBeEnabled();
  fireEvent.click(await permissionTrigger());
  const menu = await screen.findByRole("menu");
  const item = within(menu).getByRole("menuitem", { name: /^Manual approval/ });
  expect(item).toHaveAttribute("aria-disabled", "true");
  fireEvent.keyDown(item, { key: "Escape" });
  state = {
    ...state,
    capabilities: {
      sessionId: "session",
      executionMode: "claude-follower",
      features: {
        "settings-state": { available: true },
        settings: { available: false, reason: "claude-follower-settings-unavailable" },
        resources: { available: true },
        context: { available: false, reason: "follower-resource-input-unsupported" },
        goal: { available: false, reason: "native-operation-not-integrated" },
      },
    } as typeof state.capabilities,
  };
  rerender(<CodexComposerControls {...props} />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: /^Model: Claude session/ })).toBeVisible();
  const value = settings();
  await act(async () =>
    pending.resolve({
      ...value,
      writable: Object.fromEntries(
        Object.keys(value.writable).map((key) => [
          key,
          {
            available: false,
            reason: "claude-follower-settings-unavailable",
          },
        ]),
      ) as typeof value.writable,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Model: Claude session/ }));
  const picker = await screen.findByRole("dialog");
  const modelCopy = composerModelCopy["en-US"];
  expect(
    await within(picker).findByRole("button", { name: modelCopy.openTerminalModel }),
  ).toBeDisabled();
  expect(within(picker).queryByText(modelCopy.chooseInTerminal)).not.toBeInTheDocument();
  expect(within(picker).queryByRole("button", { name: modelCopy.reset })).toBeNull();
  fireEvent.keyDown(picker, { key: "Escape" });
  fireEvent.click(await permissionTrigger());
  const nativePermissions = await screen.findByRole("menu");
  expect(within(nativePermissions).queryByRole("status")).not.toBeInTheDocument();
  for (const item of within(nativePermissions).queryAllByRole("menuitem"))
    expect(item).toHaveAttribute("aria-disabled", "true");
  fireEvent.keyDown(nativePermissions, { key: "Escape" });
  expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: codexCopy["en-US"].addContext }));
  const goalAction = screen.getByRole("button", { name: composerGoalCopy("en-US").title });
  expect(goalAction).toBeDisabled();
  fireEvent.click(goalAction);
  expect(screen.queryByText("This executor does not support this action yet.")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Files and folders" }));
  await waitFor(() => expect(state.client.sessionResources).toHaveBeenCalled());
  expect(
    screen.getAllByText(
      "You can browse files and folders, but this executor cannot add references to messages.",
    ),
  ).toHaveLength(1);
  expect(screen.getByRole("checkbox")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Open folder: src" }));
  await waitFor(() => expect(state.client.sessionResources).toHaveBeenCalledTimes(2));
  expect(props.setResources).not.toHaveBeenCalled();
  expect(state.codexAction).not.toHaveBeenCalled();
  expect(state.control).not.toHaveBeenCalled();
});

it.each([
  ["zh-CN", "工具权限", "自动批准"],
  ["zh-Hant", "工具權限", "自動核准"],
  ["en-US", "Tool permissions", "Auto approval"],
  ["ja-JP", "ツール権限", "自動承認"],
] as const)(
  "displays the verified native Auto permission without adding a writable choice in %s",
  async (locale, title, label) => {
    state.locale = locale;
    state.access = {
      ...state.access!,
      status: "approved",
      device: { ...state.access!.device!, advancedControl: true },
    };
    state.live = { ...state.live!, executionMode: "claude-follower" };
    state.capabilities = {
      sessionId: "session",
      features: {
        "settings-state": { available: true },
        settings: { available: false, reason: "claude-follower-settings-unavailable" },
      },
    } as typeof state.capabilities;
    vi.mocked(state.client.sessionSettings).mockResolvedValue({
      ...settings(),
      current: { modelId: "model", permissionMode: "auto" },
      options: { ...settings().options, permissionModes: [] },
      writable: { ...settings().writable, permissionMode: { available: false } },
    });
    const view = render(<CodexComposerControls {...props} />);
    const trigger = await screen.findByRole("button", { name: title + ": " + label });
    expect(screen.queryByText(permissionModeCopy[locale].auto)).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(await screen.findByRole("menu")).toBeVisible();
    expect(screen.getByText(permissionModeCopy[locale].auto)).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: label })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    state.live = { ...state.live!, permission: { mode: "default" } };
    view.rerender(<CodexComposerControls {...props} />);
    const manual = newSessionCopy(locale).permissions["claude-code"].choices.default;
    expect(await screen.findByRole("button", { name: title + ": " + manual.name })).toBeVisible();
    state.capabilities = {
      sessionId: "session",
      features: { "settings-state": { available: false, reason: "permission_denied" } },
    } as typeof state.capabilities;
    view.rerender(<CodexComposerControls {...props} />);
    expect(
      screen.queryByRole("button", { name: title + ": " + manual.name }),
    ).not.toBeInTheDocument();
    expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
    expect(state.codexAction).not.toHaveBeenCalled();
    expect(state.control).not.toHaveBeenCalled();
  },
);

it.each(["observation", "late-read", "access-denied", "uncertain-receipt"] as const)(
  "keeps a cold external-owner model catalog after a %s race",
  async (race) => {
    state.access = {
      ...state.access!,
      status: "approved",
      device: { ...state.access!.device!, advancedControl: true },
    };
    state.live = {
      ...state.live!,
      executionMode: "claude-managed",
      executionLocation: "external",
      ownershipReason: "claude-owner-busy",
      reason: "claude-owner-busy",
      sendEnabled: false,
    };
    state.canSend = false;
    forgetSessionModelDisplay(state.client, state.access, "session", "claude-code");
    const prepared = { ...settings(), provider: sessionProviderCapabilities("claude-code") };
    const cold = {
      ...prepared,
      current: {},
      defaults: {},
      options: { ...prepared.options, models: [] },
      writable: { ...prepared.writable, model: { available: false }, effort: { available: false } },
    };
    const passive = deferred();
    const probe = deferred();
    vi.mocked(state.client.sessionSettings).mockResolvedValue(cold);
    if (race === "late-read" || race === "access-denied")
      vi.mocked(state.client.sessionSettings).mockReturnValueOnce(passive.promise);
    vi.mocked(state.client.prepareSessionSettings).mockReturnValueOnce(probe.promise);
    const view = render(<CodexComposerControls {...props} />);
    await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: composerModelCopy["en-US"].modelSettings }));
    const overview = await screen.findByRole("dialog");
    fireEvent.click(within(overview).getByRole("button", { name: /^Select model(?::|$)/ }));
    await waitFor(() =>
      expect(state.client.prepareSessionSettings).toHaveBeenCalledExactlyOnceWith({
        sessionId: "session",
        bootId: "boot",
        expectedRevision: 1,
      }),
    );
    if (race === "observation") {
      state = { ...state, usageEpoch: "new-observation" };
      view.rerender(<CodexComposerControls {...props} />);
      await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("dialog", { name: composerModelCopy["en-US"].model })).toBeVisible();
    }
    if (race === "access-denied")
      await act(async () => passive.reject(new ApiError(403, "advanced-control-required")));
    if (race === "uncertain-receipt") {
      state = { ...state, notice: "uncertain" };
      view.rerender(<CodexComposerControls {...props} />);
    }
    await act(async () => probe.resolve(prepared));
    if (race === "late-read") await act(async () => passive.resolve(cold));
    const models = within(
      await screen.findByRole("dialog", { name: composerModelCopy["en-US"].model }),
    );
    if (race === "access-denied" || race === "uncertain-receipt")
      expect(models.queryByRole("button", { name: "Claude session" })).not.toBeInTheDocument();
    else
      await waitFor(() =>
        expect(models.getByRole("button", { name: "Claude session" })).toBeEnabled(),
      );
    expect(state.canSend).toBe(false);
    expect(state.codexAction).not.toHaveBeenCalled();
    expect(state.control).not.toHaveBeenCalled();
  },
);

it("reuses writable settings in both menus while rechecking them in the background", async () => {
  const pendingRead = deferred();
  vi.mocked(state.client.sessionSettings)
    .mockResolvedValueOnce(settings())
    .mockReturnValue(pendingRead.promise);
  render(<CodexComposerControls {...props} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Select reasoning effort: Claude session · Low" }),
  );
  const model = within(await screen.findByRole("dialog"));
  expect(model.getByRole("button", { name: "Select model: Claude session" })).toBeEnabled();
  await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalledTimes(2));
  expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: sessionAgentCopy["en-US"].permission }));
  const permissions = within(await screen.findByRole("menu"));
  expect(permissions.getByRole("menuitem", { name: /^Manual approval/ })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
  expect(state.codexAction).not.toHaveBeenCalled();
});

it("retains the effort scale during an unresolved request and drops it on access denial", async () => {
  state.access = {
    ...state.access!,
    status: "approved",
    device: { ...state.access!.device!, advancedControl: true },
  };
  forgetSessionModelDisplay(state.client, state.access, state.selected, "claude-code");
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
  const loaded = settings();
  loaded.options.models[0].efforts = ["low", "medium", "high"];
  const partial = {
    ...loaded,
    revision: 2,
    current: { ...loaded.current, effort: "medium" },
    options: { ...loaded.options, models: [] },
    writable: { ...loaded.writable, model: { available: false }, effort: { available: false } },
  };
  vi.mocked(state.client.sessionSettings).mockResolvedValue(loaded);
  const view = render(<CodexComposerControls {...props} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Select reasoning effort: Claude session · Low" }),
  );
  const popup = await screen.findByRole("dialog");
  expect(within(popup).getByRole("slider")).toBeEnabled();

  vi.mocked(state.client.sessionSettings).mockResolvedValue(partial);
  state = {
    ...state,
    notice: "uncertain",
    usageEpoch: "observation-b",
    live: { ...state.live!, revision: 2 },
  };
  view.rerender(<CodexComposerControls {...props} />);
  await waitFor(() => {
    const slider = within(popup).getByRole("slider");
    expect(slider).toBeDisabled();
    expect(slider).toHaveAttribute("aria-valuetext", "Medium");
  });
  expect(within(popup).queryByRole("status")).not.toBeInTheDocument();
  expect(state.codexAction).not.toHaveBeenCalled();

  const granted = state.capabilities!;
  state = {
    ...state,
    capabilities: {
      ...granted,
      features: {
        ...granted.features,
        "settings-state": { available: false, reason: "permission_denied" },
      },
    },
  };
  view.rerender(<CodexComposerControls {...props} />);
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();

  state = { ...state, capabilities: granted, notice: undefined };
  view.rerender(<CodexComposerControls {...props} />);
  fireEvent.click(
    await screen.findByRole("button", { name: /^Select reasoning effort: (Claude session|model)/ }),
  );
  expect(within(await screen.findByRole("dialog")).queryByRole("slider")).not.toBeInTheDocument();
});

it.each(["history", "cache", "defaults", "explicit", "uncertain"] as const)(
  "displays the verified %s model without changing the editable selection",
  async (source) => {
    // BaseUI exposes its native range after measuring a non-zero track.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 240,
      bottom: 28,
      width: 240,
      height: 28,
      toJSON: () => ({}),
    });
    state.access = {
      ...state.access!,
      status: "approved",
      device: { ...state.access!.device!, advancedControl: true },
    };
    state.current = { ...state.current!, availability: "readable" };
    state.live = { ...state.live!, executionMode: "claude-managed", executionLocation: "external" };
    const value: CodexSessionSettings = {
      ...settings(),
      current: source === "explicit" ? { modelId: "model", effort: "low" } : {},
      selected: {},
      defaults: { modelId: "default", effort: "high" },
      ...(source === "history" || source === "explicit" || source === "uncertain"
        ? { historicalSettings: { modelId: "history", effort: "low" } }
        : {}),
      options: {
        ...settings().options,
        models: [
          { id: "model", name: "Claude session", efforts: ["low", "high"], serviceTierIds: [] },
          { id: "history", name: "History model", efforts: ["low", "high"], serviceTierIds: [] },
          { id: "cached", name: "Cached model", efforts: ["low", "high"], serviceTierIds: [] },
          { id: "default", name: "CLI default", efforts: ["low", "high"], serviceTierIds: [] },
        ],
      },
    };
    forgetSessionModelDisplay(state.client, state.access, "session", "claude-code");
    if (source !== "defaults")
      rememberSessionModelDisplay(state.client, state.access, "session", "claude-code", {
        modelId: "cached",
        name: "Cached model",
        effort: "high",
      });
    if (source === "uncertain") state.notice = "uncertain";
    vi.mocked(state.client.sessionSettings).mockResolvedValue(value);
    render(<CodexComposerControls {...props} />);
    const name =
      source === "explicit"
        ? "Claude session"
        : source === "history"
          ? "History model"
          : source === "defaults"
            ? "CLI default"
            : "Cached model";
    const trigger = await screen.findByRole("button", {
      name: new RegExp(`^Select reasoning effort: ${name}`),
    });
    if (source !== "uncertain") {
      fireEvent.click(trigger);
      const popup = within(await screen.findByRole("dialog"));
      expect(popup.getByRole("button", { name: `Select model: ${name}` })).toBeVisible();
      expect(popup.getByRole("slider")).toBeVisible();
    }
    expect(value.selected).toEqual({});
    expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
    expect(state.codexAction).not.toHaveBeenCalled();
    expect(state.control).not.toHaveBeenCalled();
  },
);
