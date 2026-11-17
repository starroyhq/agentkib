// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef, type RefObject } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionProviderCapabilities, type CodexSessionSettings } from "@agentkib/web-client";
import { composerModelCopy } from "@agentkib/session-ui";
import {
  CodexComposerControls,
  type ComposerControlsHandle,
} from "../conversation/features/sessions/codex-session-controls";
import { useSession } from "../conversation/features/sessions/session-context";
import { sessionAgentCopy } from "../conversation/features/sessions/session-agent-copy";
import { codexCopy } from "../conversation/features/sessions/codex-copy";

vi.mock("../conversation/features/sessions/session-context", () => ({ useSession: vi.fn() }));
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
    live: { sessionId: "session", status: "idle", revision: 1 },
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

async function openModelList(model = "Claude session") {
  fireEvent.click(
    await screen.findByRole("button", { name: `Select reasoning effort: ${model} · Low` }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: `Select model: ${model}` }));
  return screen.findByRole("button", { name: model });
}

describe("Claude settings preparation", () => {
  it("opens the existing catalog when the provider does not offer preparation", async () => {
    const declared = sessionProviderCapabilities("claude-code")!;
    vi.mocked(state.client.sessionSettings).mockResolvedValue({
      ...settings(),
      provider: { ...declared, models: { ...declared.models, prepare: undefined } },
    });
    render(<CodexComposerControls {...props} />);
    expect(await openModelList()).toBeEnabled();
    expect(state.client.prepareSessionSettings).not.toHaveBeenCalled();
  });

  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "offers the localized default choice without selecting a native model in %s",
    async (locale) => {
      state.locale = locale;
      const value: CodexSessionSettings = { ...settings(), current: {}, defaults: {} };
      vi.mocked(state.client.sessionSettings).mockResolvedValue(value);
      vi.mocked(state.client.prepareSessionSettings).mockResolvedValue(value);
      render(<CodexComposerControls {...props} />);
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
      expect(state.client.prepareSessionSettings).toHaveBeenCalledTimes(1);
      expect(state.codexAction).not.toHaveBeenCalled();
      expect(state.control).not.toHaveBeenCalled();
    },
  );

  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "shows Claude permission options without inventing a selected one in %s",
    async (locale) => {
      state.locale = locale;
      render(<CodexComposerControls {...props} />);
      const title = sessionAgentCopy[locale].permission;
      fireEvent.click(
        await screen.findByRole("button", { name: new RegExp(`^${title}(?:: ${title})?$`) }),
      );
      const item = await screen.findByRole("menuitem", { name: "Default" });
      await waitFor(() => expect(item).not.toHaveAttribute("aria-disabled", "true"));
      expect(item).not.toHaveAttribute("aria-current", "true");
      expect(screen.getByRole("menu", { name: title })).not.toHaveTextContent(/Codex/);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "releases preparation busy after an observation change and a late %s",
    async (outcome) => {
      const pending = deferred();
      vi.mocked(state.client.prepareSessionSettings).mockReturnValueOnce(pending.promise);
      const view = render(<CodexComposerControls {...props} />);
      const model = await openModelList();
      expect(model).toBeDisabled();
      state = { ...state, usageEpoch: "observation-b" };
      view.rerender(<CodexComposerControls {...props} />);
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
      await openModelList();
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
      const model = await openModelList(scope === "session" ? "Claude next" : "Claude session");
      expect(state.client.prepareSessionSettings).toHaveBeenCalledTimes(2);
      await act(async () => old.resolve(settings()));
      expect(model).toBeDisabled();
      await act(async () => next.resolve(settings(state.selected)));
      await waitFor(() => expect(model).toBeEnabled());
      expect(model).toHaveAttribute("aria-pressed", "true");
      expect(state.codexAction).not.toHaveBeenCalled();
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
    const copy = codexCopy["en-US"];
    const ref = createRef<ComposerControlsHandle>();
    const view = render(<CodexComposerControls {...props} controlsRef={ref} />);
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
    render(<CodexComposerControls {...props} controlsRef={goal} />);
    expect(open(goal, "goal")).toBe(true);
    expect(await screen.findByLabelText(copy.goalObjective)).toBeVisible();
  });

  it("declines while the composer is disabled or the device lacks full access", () => {
    const ref = createRef<ComposerControlsHandle>();
    const view = render(<CodexComposerControls {...props} disabled controlsRef={ref} />);
    expect(open(ref, "models")).toBe(false);
    expect(open(ref, "permissions")).toBe(false);
    view.unmount();
    state.access = { bootId: "boot", device: { id: "device" } } as typeof state.access;
    const partial = createRef<ComposerControlsHandle>();
    render(<CodexComposerControls {...props} controlsRef={partial} />);
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
      render(<CodexComposerControls {...props} />);
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
