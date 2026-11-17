// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef, type RefObject } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionProviderCapabilities, type CodexSessionSettings } from "@agentkib/web-client";
import { CodexComposerControls, type ComposerControlsHandle } from "./codex-session-controls";
import { useSession } from "./session-context";
import { sessionAgentCopy } from "./session-agent-copy";
import { codexCopy } from "./codex-copy";
import {
  composerGoalCopy,
  composerModelCopy,
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
afterEach(cleanup);

function permissionTrigger(locale = state.locale) {
  return screen.findByRole("button", {
    name: new RegExp(`^${sessionAgentCopy[locale].permission}(?::|$)`),
  });
}

describe("Claude's model in the composer", () => {
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
    expect(model).toBeDisabled();
    expect(permissions).toBeDisabled();
    fireEvent.click(model);
    fireEvent.click(permissions);
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
    render(<CodexComposerControls {...props} />);
    await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: picker.modelSettings }));
    const overview = await screen.findByRole("dialog");
    fireEvent.click(within(overview).getByRole("button", { name: /^Select model(?::|$)/ }));
    const models = await screen.findByRole("dialog", { name: picker.model });
    expect(await within(models).findByRole("button", { name: "Claude session" })).toBeVisible();
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
      expect(state.client.prepareSessionSettings).toHaveBeenCalledTimes(1);
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
      const pending = deferred();
      vi.mocked(state.client.prepareSessionSettings).mockReturnValueOnce(pending.promise);
      const view = render(<CodexComposerControls {...props} />);
      fireEvent.click(await permissionTrigger());
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
      const old = deferred();
      const next = deferred();
      vi.mocked(state.client.prepareSessionSettings)
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(next.promise);
      const view = render(<CodexComposerControls {...props} />);
      fireEvent.click(await permissionTrigger());
      if (scope === "session") {
        state = {
          ...state,
          selected: "next",
          current: { ...state.current!, id: "next" },
          live: { ...state.live!, sessionId: "next" },
        };
      } else {
        state = {
          ...state,
          access: { ...state.access!, device: { ...state.access!.device!, id: "next-device" } },
        };
      }
      view.rerender(<CodexComposerControls {...props} />);
      fireEvent.click(await permissionTrigger());
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
