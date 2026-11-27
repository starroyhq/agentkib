// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef, type RefObject } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "@/features/conversation/web-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  forgetSessionModelDisplay,
  rememberSessionModelDisplay,
  sessionProviderCapabilities,
  type SessionSettings,
} from "@agentkib/web-client";
import { composerGoalCopy, composerModelCopy, newSessionCopy } from "@agentkib/session-ui";
import { SessionComposerControls, type ComposerControlsHandle } from "@agentkib/session-ui";
import { useSession } from "../conversation/web-session-context";
import { SessionComposer } from "@/features/conversation/web-session-composer";
import { sessionAgentCopy } from "@agentkib/session-ui";
import { sessionCopy } from "../conversation/session-copy";

vi.mock("../conversation/web-session-context", () => ({ useSession: vi.fn() }));
let state: ReturnType<typeof useSession>;
let props: Omit<Parameters<typeof SessionComposerControls>[0], "session">;
function settings(id = "session"): SessionSettings {
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
  let resolve!: (value: SessionSettings) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SessionSettings>((yes, no) => {
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
    live: { sessionId: "session", status: "idle", revision: 1 },
    capabilities: { sessionId: "session", features: { settings: { available: true } } },
    client: {
      sessionSettings: vi.fn(async (id: string) => settings(id)),
      prepareSessionSettings: vi.fn(async ({ sessionId }: { sessionId: string }) =>
        settings(sessionId),
      ),
    },
    runSessionAction: vi.fn(),
    control: vi.fn(),
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openModelList(model = "Claude session", refresh = false) {
  fireEvent.click(
    await screen.findByRole("button", {
      name: refresh ? "Change model" : `Select reasoning effort: ${model} · Low`,
    }),
  );
  const dialog = await screen.findByRole("dialog");
  if (!refresh)
    fireEvent.click(within(dialog).getByRole("button", { name: `Select model: ${model}` }));
  return screen.findByRole("button", { name: model });
}

describe("Claude settings preparation", () => {
  it("keeps an imported goal draft local and disables saving if the advertised feature disappears", async () => {
    const base = state.capabilities!;
    state.controlReady = true;
    state.client.sessionGoals = vi.fn();
    const settingsWhileEditing = deferred();
    vi.mocked(state.client.sessionSettings).mockReturnValue(settingsWhileEditing.promise);
    const capabilities = {
      ...base,
      features: { ...base.features, "goal-draft": { available: true } },
    };
    state.capabilities = capabilities;
    const onStageGoal = vi.fn();
    const view = render(
      <SessionComposerControls session={state} {...props} onStageGoal={onStageGoal} />,
    );
    const copy = composerGoalCopy("en-US");
    const addLabel = sessionCopy["en-US"].addContext;
    fireEvent.click(screen.getByRole("button", { name: addLabel }));
    const add = within(await screen.findByRole("dialog", { name: addLabel }));
    fireEvent.click(add.getByRole("button", { name: copy.title }));
    const editor = within(await screen.findByRole("dialog", { name: copy.title }));
    fireEvent.change(editor.getByRole("textbox", { name: copy.objective }), {
      target: { value: "  Review the imported session  " },
    });
    fireEvent.change(editor.getByRole("spinbutton", { name: copy.budget }), {
      target: { value: "10" },
    });
    await act(async () => settingsWhileEditing.resolve(settings()));
    expect(editor.getByRole("textbox", { name: copy.objective })).toHaveValue(
      "  Review the imported session  ",
    );
    expect(editor.getByRole("spinbutton", { name: copy.budget })).toHaveValue(10);

    state.capabilities = base;
    view.rerender(<SessionComposerControls session={state} {...props} onStageGoal={onStageGoal} />);
    const save = editor.getByRole("button", { name: copy.saveDraft });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onStageGoal).not.toHaveBeenCalled();

    state.capabilities = capabilities;
    view.rerender(<SessionComposerControls session={state} {...props} onStageGoal={onStageGoal} />);
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(onStageGoal).toHaveBeenCalledExactlyOnceWith({
      objective: "Review the imported session",
      tokenBudget: 10,
    });
    expect(state.client.sessionGoals).not.toHaveBeenCalled();
    expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
    expect(state.runSessionAction).not.toHaveBeenCalled();
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
    const { rerender } = render(<SessionComposerControls session={state} {...props} />);
    const model = screen.getByRole("button", { name: picker.modelSettings });
    const permissions = screen.getByRole("button", { name: sessionAgentCopy["en-US"].permission });
    expect(model).toBeEnabled();
    expect(permissions).toBeEnabled();
    fireEvent.click(model);
    expect(await screen.findByRole("dialog")).toBeVisible();
    await act(async () => {});
    expect(state.client.sessionSettings).not.toHaveBeenCalled();
    expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
    expect(state.runSessionAction).not.toHaveBeenCalled();

    state = { ...state, capabilities };
    rerender(<SessionComposerControls session={state} {...props} />);
    expect(
      await screen.findByRole("button", { name: /^Select reasoning effort: Claude session/ }),
    ).toBeEnabled();
    expect(state.client.sessionSettings).toHaveBeenCalledWith("session", "claude-code");
    expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
  });

  it("opens the existing catalog when the provider does not offer preparation", async () => {
    const declared = sessionProviderCapabilities("claude-code")!;
    vi.mocked(state.client.sessionSettings).mockResolvedValue({
      ...settings(),
      provider: { ...declared, models: { ...declared.models, prepare: undefined } },
    });
    render(<SessionComposerControls session={state} {...props} />);
    expect(await openModelList()).toBeEnabled();
    expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
  });

  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "offers the localized default choice without selecting a native model in %s",
    async (locale) => {
      state.locale = locale;
      const value: SessionSettings = { ...settings(), current: {}, defaults: {} };
      vi.mocked(state.client.sessionSettings).mockResolvedValue(value);
      vi.mocked(state.client.prepareSessionSettings).mockResolvedValue(value);
      render(<SessionComposerControls session={state} {...props} />);
      const copy = composerModelCopy[locale];
      const name = `${copy.chooseModel}: ${copy.defaultModel}`;
      fireEvent.click(await screen.findByRole("button", { name }));
      const overview = within(await screen.findByRole("dialog", { name: copy.modelSettings }));
      fireEvent.click(overview.getByRole("button", { name }));
      const options = within(await screen.findByRole("group", { name: copy.chooseModel }));
      const fallback = options.getByRole("button", { name: new RegExp(`^${copy.defaultModel}`) });
      await waitFor(() => expect(fallback).toBeEnabled());
      expect(fallback).toHaveAttribute("aria-pressed", "true");
      expect(options.getByRole("button", { name: "Claude session" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
      expect(state.runSessionAction).not.toHaveBeenCalled();
      expect(state.control).not.toHaveBeenCalled();
    },
  );

  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "shows Claude permission options without inventing a selected one in %s",
    async (locale) => {
      state.locale = locale;
      render(<SessionComposerControls session={state} {...props} />);
      const title = sessionAgentCopy[locale].permission;
      fireEvent.click(
        await screen.findByRole("button", { name: new RegExp(`^${title}(?:: ${title})?$`) }),
      );
      const manual = newSessionCopy(locale).permissions["claude-code"].choices.default.name;
      const item = await screen.findByRole("menuitem", { name: new RegExp(`^${manual}`) });
      await waitFor(() => expect(item).not.toHaveAttribute("aria-disabled", "true"));
      expect(item).not.toHaveAttribute("aria-current", "true");
      expect(screen.getByRole("menu", { name: title })).not.toHaveTextContent(/Codex/);
    },
  );

  it.each([true, false])("respects the host's Auto mode availability (%s)", async (available) => {
    const ready = settings();
    ready.options.permissionModes!.push({ id: "auto", name: "auto", available });
    state.access = {
      ...state.access!,
      status: "approved",
      device: { ...state.access!.device!, advancedControl: true },
    };
    vi.mocked(state.client.sessionSettings).mockResolvedValue(ready);
    vi.mocked(state.client.prepareSessionSettings).mockResolvedValue(ready);
    vi.mocked(state.runSessionAction).mockResolvedValue({ accepted: true } as Awaited<
      ReturnType<typeof state.runSessionAction>
    >);
    await act(async () => {
      render(<SessionComposerControls session={state} {...props} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Tool permissions" }));
    });
    const menu = within(screen.getByRole("menu", { name: "Tool permissions" }));
    const auto = menu.getByRole("menuitem", { name: "Auto approval" });
    // No explanatory description prose is added to Auto approval (U68).
    expect(auto).toHaveTextContent(/^Auto approval$/);
    expect(auto).not.toHaveAttribute("title");
    expect(menu.getByRole("menuitem", { name: /^Manual approval/ })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    if (available) {
      expect(auto).not.toHaveAttribute("aria-disabled", "true");
      expect(auto).toHaveClass("text-orange-600");
      await act(async () => fireEvent.click(auto));
      expect(state.runSessionAction).toHaveBeenCalledExactlyOnceWith("settings", {
        permissionMode: "auto",
      });
    } else {
      // Unavailable Auto approval is dimmed/disabled without a disabled reason tooltip (U16, U68).
      expect(auto).toHaveAttribute("aria-disabled", "true");
      expect(auto).not.toHaveAttribute("title");
      expect(auto).not.toHaveClass("text-orange-600");
      fireEvent.click(auto);
      expect(state.runSessionAction).not.toHaveBeenCalled();
    }
  });

  it("matches terminal auto trigger styling when selected and disables while running", async () => {
    const ready = settings();
    ready.options.permissionModes!.push({ id: "auto", name: "auto", available: true });
    ready.current.permissionMode = "auto";
    ready.selected = { permissionMode: "auto" };
    state.access = {
      ...state.access!,
      status: "approved",
      device: { ...state.access!.device!, advancedControl: true },
    };
    vi.mocked(state.client.sessionSettings).mockResolvedValue(ready);
    vi.mocked(state.client.prepareSessionSettings).mockResolvedValue(ready);
    const view = render(<SessionComposerControls session={state} {...props} />);
    const trigger = await screen.findByRole("button", { name: "Tool permissions: Auto approval" });
    expect(trigger).toBeEnabled();
    expect(trigger).toHaveClass("text-orange-600");

    fireEvent.click(trigger);
    const menu = within(await screen.findByRole("menu", { name: "Tool permissions" }));
    const auto = menu.getByRole("menuitem", { name: "Auto approval" });
    expect(auto).toHaveAttribute("aria-current", "true");
    expect(auto).toHaveClass("text-orange-600");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    // Running turn still disables permission changes (U44).
    state.live = { ...state.live!, status: "running" };
    view.rerender(<SessionComposerControls session={state} {...props} />);
    const runningTrigger = screen.getByRole("button", { name: "Tool permissions: Auto approval" });
    expect(runningTrigger).toBeDisabled();
    expect(runningTrigger).toHaveClass("disabled:opacity-50", "disabled:grayscale");
  });

  it.each(["resolve", "reject"] as const)(
    "releases preparation busy after an observation change and a late %s",
    async (outcome) => {
      state.notice = "notDispatched";
      state.noticeReason = "claude-model-unsupported";
      const pending = deferred();
      vi.mocked(state.client.prepareSessionSettings).mockReturnValueOnce(pending.promise);
      const view = render(<SessionComposerControls session={state} {...props} />);
      const model = await openModelList("Claude session", true);
      expect(model).toBeDisabled();
      state = { ...state, usageEpoch: "observation-b" };
      view.rerender(<SessionComposerControls session={state} {...props} />);
      await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalledTimes(2));
      await act(async () => {
        if (outcome === "resolve")
          pending.resolve({ ...settings(), current: { modelId: "stale" } });
        else pending.reject(new Error("stale-prepare-error"));
      });
      await waitFor(() => expect(model).toBeEnabled());
      expect(model).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByText("stale-prepare-error")).not.toBeInTheDocument();
      expect(state.client.prepareSessionSettings).toHaveBeenCalledTimes(1);
      expect(state.runSessionAction).not.toHaveBeenCalled();
      expect(state.control).not.toHaveBeenCalled();
    },
  );

  it.each(["session", "device"] as const)(
    "does not let a previous %s preparation clear a new request's busy state",
    async (scope) => {
      state.notice = "notDispatched";
      state.noticeReason = "claude-model-unsupported";
      const old = deferred();
      const next = deferred();
      vi.mocked(state.client.prepareSessionSettings)
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(next.promise);
      const view = render(<SessionComposerControls session={state} {...props} />);
      await openModelList("Claude session", true);
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
      view.rerender(<SessionComposerControls session={state} {...props} />);
      const model = await openModelList(
        scope === "session" ? "Claude next" : "Claude session",
        true,
      );
      expect(state.client.prepareSessionSettings).toHaveBeenCalledTimes(2);
      await act(async () => old.resolve(settings()));
      expect(model).toBeDisabled();
      await act(async () => next.resolve(settings(state.selected)));
      await waitFor(() => expect(model).toBeEnabled());
      expect(model).toHaveAttribute("aria-pressed", "true");
      expect(state.runSessionAction).not.toHaveBeenCalled();
    },
  );
});

describe("opening the composer's controls for a bare command", () => {
  const open = (
    ref: RefObject<ComposerControlsHandle | null>,
    panel: "models" | "permissions" | "goal",
  ) => {
    let opened: boolean | undefined;
    act(() => {
      opened = ref.current!.open(panel);
    });
    return opened;
  };

  it("opens the models, and the goal only where this device can read it", async () => {
    const copy = sessionCopy["en-US"];
    const ref = createRef<ComposerControlsHandle>();
    const view = render(<SessionComposerControls session={state} {...props} controlsRef={ref} />);
    // No goal feature reaches this device.
    expect(open(ref, "goal")).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(open(ref, "models")).toBe(true);
    expect(await screen.findByRole("group", { name: "Select model" })).toBeVisible();
    expect(state.client.prepareSessionSettings).toHaveBeenCalledTimes(1);
    view.unmount();
    state.capabilities = {
      sessionId: "session",
      features: { goal: { available: true }, "goal-set": { available: true } },
    } as typeof state.capabilities;
    state.client = {
      ...state.client,
      sessionGoals: vi.fn(async () => ({ available: true, revision: 1, actions: {} })),
    } as unknown as typeof state.client;
    const goal = createRef<ComposerControlsHandle>();
    render(<SessionComposerControls session={state} {...props} controlsRef={goal} />);
    expect(open(goal, "goal")).toBe(true);
    expect(await screen.findByLabelText(copy.goalObjective)).toBeVisible();
  });

  it("declines while the composer is disabled or the device lacks full access", () => {
    const ref = createRef<ComposerControlsHandle>();
    const view = render(
      <SessionComposerControls session={state} {...props} disabled controlsRef={ref} />,
    );
    expect(open(ref, "models")).toBe(false);
    expect(open(ref, "permissions")).toBe(false);
    view.unmount();
    state.access = { bootId: "boot", device: { id: "device" } } as typeof state.access;
    const partial = createRef<ComposerControlsHandle>();
    render(<SessionComposerControls session={state} {...props} controlsRef={partial} />);
    expect(open(partial, "models")).toBe(false);
    expect(open(partial, "permissions")).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
  });
});

describe("Claude settings rejection", () => {
  it.each([
    ["claude-model-unsupported", /support only the models they list/, "Change model", "models"],
    [
      "claude-effort-unsupported",
      /can be only low, medium, high, xhigh, or max/,
      "Change model",
      "effort",
    ],
  ] as const)(
    "explains %s and opens the relevant control without submitting",
    async (reason, text, shortcut, page) => {
      state.notice = "notDispatched";
      state.noticeReason = reason;
      render(<SessionComposerControls session={state} {...props} />);
      expect(await screen.findByText(text)).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: shortcut }));
      const picker = within(await screen.findByRole("dialog"));
      if (page === "models")
        expect(picker.getByRole("group", { name: "Select model" })).toBeVisible();
      else
        expect(
          await picker.findByRole("button", { name: "Select model: Claude session" }),
        ).toBeVisible();
      await waitFor(() => expect(state.client.prepareSessionSettings).toHaveBeenCalledTimes(1));
      expect(state.runSessionAction).not.toHaveBeenCalled();
      expect(state.control).not.toHaveBeenCalled();
    },
  );

  it.each(["unsupported-model", "claude-command-settings"] as const)(
    "offers no settings shortcut for %s",
    (reason) => {
      state.notice = "notDispatched";
      state.noticeReason = reason;
      render(<SessionComposerControls session={state} {...props} />);
      expect(screen.queryByRole("button", { name: "Change model" })).not.toBeInTheDocument();
    },
  );
});

it("prepares an external owner's draft without enabling native sends or reusing its capabilities", async () => {
  const copy = sessionCopy["en-US"];
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
  } satisfies SessionSettings;
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
  vi.mocked(state.runSessionAction).mockResolvedValue({ accepted: true } as Awaited<
    ReturnType<typeof state.runSessionAction>
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
    expect(state.runSessionAction).toHaveBeenCalledExactlyOnceWith("settings", {
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
  expect(state.runSessionAction).toHaveBeenCalledTimes(1);
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
  expect(state.runSessionAction).toHaveBeenCalledTimes(1);
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

it("shows the terminal model to a remote device without offering the native picker", async () => {
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
  const modelId = "claude-fable-5-2[1m]";
  reported.current = { modelId };
  reported.options.models = [{ id: modelId, name: modelId, efforts: [], serviceTierIds: [] }];
  reported.writable.model = { available: false, reason: "claude-follower-settings-unavailable" };
  vi.mocked(state.client.sessionSettings).mockResolvedValue(reported);
  vi.mocked(state.runSessionAction).mockResolvedValue({
    accepted: true,
    requestId: "request",
    sessionId: "session",
  });
  render(<SessionComposerControls session={state} {...props} />);
  const model = await screen.findByRole("button", { name: "Model: Fable 5.2" });
  fireEvent.click(model);
  const dialog = within(await screen.findByRole("dialog"));
  expect(
    dialog.queryByRole("button", { name: composerModelCopy["en-US"].openTerminalModel }),
  ).not.toBeInTheDocument();
  expect(state.runSessionAction).not.toHaveBeenCalled();
  expect(model).toHaveTextContent(/^Fable 5\.2$/);
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
  const { rerender } = render(<SessionComposerControls session={state} {...props} />);
  const modelName = /^Select reasoning effort: Claude session/;
  await screen.findByRole("button", { name: modelName });
  state = {
    ...state,
    live: { ...state.live!, executionMode: "claude-follower", connectionGeneration: "second" },
    capabilities: undefined,
  };
  rerender(<SessionComposerControls session={state} {...props} />);
  expect(screen.getByRole("button", { name: modelName })).toBeEnabled();
  fireEvent.click(await screen.findByRole("button", { name: /^Tool permissions(?::|$)/ }));
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
  rerender(<SessionComposerControls session={state} {...props} />);
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
    within(picker).queryByRole("button", { name: modelCopy.openTerminalModel }),
  ).not.toBeInTheDocument();
  expect(within(picker).queryByText(/终端内按 s|Press s in the terminal/i)).not.toBeInTheDocument();
  expect(within(picker).queryByRole("button", { name: modelCopy.reset })).toBeNull();
  fireEvent.keyDown(picker, { key: "Escape" });
  fireEvent.click(await screen.findByRole("button", { name: /^Tool permissions(?::|$)/ }));
  const nativePermissions = await screen.findByRole("menu");
  expect(within(nativePermissions).queryByRole("status")).not.toBeInTheDocument();
  for (const item of within(nativePermissions).queryAllByRole("menuitem"))
    expect(item).toHaveAttribute("aria-disabled", "true");
  fireEvent.keyDown(nativePermissions, { key: "Escape" });
  expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: sessionCopy["en-US"].addContext }));
  const goalLabels = sessionCopy["en-US"];
  const goalAction = screen.getByRole("button", { name: composerGoalCopy("en-US").title });
  expect(goalAction).toBeEnabled();
  fireEvent.click(goalAction);
  const goalDialog = within(await screen.findByRole("dialog", { name: goalLabels.goals }));
  const unavailableReason = "This executor does not support this action yet.";
  const objective = goalDialog.getByRole("textbox", { name: goalLabels.goalObjective });
  const budget = goalDialog.getByRole("spinbutton", { name: goalLabels.goalBudget });
  for (const field of [objective, budget]) {
    expect(field).toBeDisabled();
    expect(field.closest("[title]")).toBeNull();
  }
  for (const name of [goalLabels.goalCreate, goalLabels.goalPause, goalLabels.goalClear]) {
    const button = goalDialog.getByRole("button", { name });
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("title");
  }
  expect(goalDialog.queryByText(unavailableReason)).not.toBeInTheDocument();
  fireEvent.click(goalDialog.getByRole("button", { name: goalLabels.close }));
  fireEvent.click(screen.getByRole("button", { name: goalLabels.addContext }));
  fireEvent.click(await screen.findByRole("button", { name: "Files and folders" }));
  await waitFor(() => expect(state.client.sessionResources).toHaveBeenCalled());
  const readOnlyReferences =
    "You can browse files and folders, but this executor cannot add references to messages.";
  const reference = await screen.findByRole("checkbox");
  expect(reference).toBeDisabled();
  expect(reference).not.toHaveAttribute("title");
  expect(screen.queryByText(readOnlyReferences)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open folder: src" }));
  await waitFor(() => expect(state.client.sessionResources).toHaveBeenCalledTimes(2));
  expect(props.setResources).not.toHaveBeenCalled();
  expect(state.runSessionAction).not.toHaveBeenCalled();
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
    const view = render(<SessionComposerControls session={state} {...props} />);
    const trigger = await screen.findByRole("button", { name: title + ": " + label });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(menu).toBeVisible();
    expect(menu).not.toHaveTextContent(
      /由分类器审核操作|Shift\+Tab|classifier|原 Claude Code 终端/i,
    );
    const autoItem = within(menu).getByRole("menuitem", { name: label });
    expect(autoItem).toHaveAttribute("aria-disabled", "true");
    expect(autoItem.querySelector("svg")).not.toBeNull();
    const items = within(menu).getAllByRole("menuitem");
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const menuItem of items) expect(menuItem).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(menu, { key: "Escape" });
    state.live = { ...state.live!, permission: { mode: "default" } };
    view.rerender(<SessionComposerControls session={state} {...props} />);
    const manual = newSessionCopy(locale).permissions["claude-code"].choices.default;
    expect(await screen.findByRole("button", { name: title + ": " + manual.name })).toBeVisible();
    state.capabilities = {
      sessionId: "session",
      features: { "settings-state": { available: false, reason: "permission_denied" } },
    } as typeof state.capabilities;
    view.rerender(<SessionComposerControls session={state} {...props} />);
    expect(
      screen.queryByRole("button", { name: title + ": " + manual.name }),
    ).not.toBeInTheDocument();
    const permission = screen.getByRole("button", { name: title });
    expect(permission).toBeDisabled();
    expect(permission).not.toHaveAttribute("title");
    expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
    expect(state.runSessionAction).not.toHaveBeenCalled();
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
    const view = render(<SessionComposerControls session={state} {...props} />);
    await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Select model: Default" }));
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
      view.rerender(<SessionComposerControls session={state} {...props} />);
      await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("dialog", { name: composerModelCopy["en-US"].model })).toBeVisible();
    }
    if (race === "access-denied")
      await act(async () => passive.reject(new ApiError(403, "advanced-control-required")));
    if (race === "uncertain-receipt") {
      state = { ...state, notice: "uncertain" };
      view.rerender(<SessionComposerControls session={state} {...props} />);
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
    expect(state.runSessionAction).not.toHaveBeenCalled();
    expect(state.control).not.toHaveBeenCalled();
  },
);

it("reuses writable settings in both menus while rechecking them in the background", async () => {
  const pendingRead = deferred();
  vi.mocked(state.client.sessionSettings)
    .mockResolvedValueOnce(settings())
    .mockReturnValue(pendingRead.promise);
  render(<SessionComposerControls session={state} {...props} />);
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
  expect(state.runSessionAction).not.toHaveBeenCalled();
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
    const value: SessionSettings = {
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
    render(<SessionComposerControls session={state} {...props} />);
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
    expect(state.runSessionAction).not.toHaveBeenCalled();
    expect(state.control).not.toHaveBeenCalled();
  },
);
