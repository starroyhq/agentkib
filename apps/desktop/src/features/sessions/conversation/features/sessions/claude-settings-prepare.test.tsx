// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef, type RefObject } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexSessionSettings } from "@agentkib/web-client";
import { CodexComposerControls, type ComposerControlsHandle } from "./codex-session-controls";
import { useSession } from "./session-context";
import { sessionAgentCopy } from "./session-agent-copy";
import { codexCopy } from "./codex-copy";
import { composerModelCopy } from "./composer-model-copy";

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
    expect(
      screen.getByRole("button", { name: codexCopy["en-US"].conversationSettings }),
    ).toBeEnabled();
    fireEvent.click(trigger);
    const popup = await screen.findByRole("dialog");
    // Claude Code reports no effort for the model's own default; it has no Fast mode.
    expect(within(popup).getByText(`${picker.defaultEffort} · High`)).toBeInTheDocument();
    expect(within(popup).queryByRole("button", { name: picker.fast })).not.toBeInTheDocument();
  });
});

describe("Claude's plan mode in the composer", () => {
  it("shows plan mode and turns it off from its chip, as Codex's composer does", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: codexCopy["en-US"].planOn }));
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledWith("settings", { permissionMode: "default" }),
    );
  });
});

describe("Claude settings preparation", () => {
  it("loads the native model catalog from the picker when a session has no options yet", async () => {
    const picker = composerModelCopy["en-US"];
    const value = settings();
    vi.mocked(state.client.sessionSettings).mockResolvedValue({
      ...value,
      current: {},
      options: { ...value.options, models: [] },
    });
    render(<CodexComposerControls {...props} />);
    await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", { name: `${picker.chooseEffort}: ${picker.unknown}` }),
    );
    expect(
      await screen.findByRole("button", { name: `${picker.chooseModel}: Claude session` }),
    ).toBeVisible();
    expect(state.client.prepareSessionSettings).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session",
      bootId: "boot",
      expectedRevision: 1,
    });
    expect(state.codexAction).not.toHaveBeenCalled();
  });

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "keeps unknown models in the model picker and out of the permissions panel in %s",
    async (locale) => {
      state.locale = locale;
      const value: CodexSessionSettings = { ...settings(), current: {}, defaults: {} };
      vi.mocked(state.client.sessionSettings).mockResolvedValue(value);
      vi.mocked(state.client.prepareSessionSettings).mockResolvedValue(value);
      const copy = codexCopy[locale];
      const picker = composerModelCopy[locale];
      render(<CodexComposerControls {...props} />);
      expect(
        screen.getByRole("button", { name: `${picker.chooseEffort}: ${picker.unknown}` }),
      ).toBeInTheDocument();
      fireEvent.click(await screen.findByRole("button", { name: copy.conversationSettings }));
      const panel = await screen.findByRole("dialog", { name: copy.conversationSettings });
      const permission = within(panel).getByLabelText(sessionAgentCopy[locale].permission);
      await waitFor(() => expect(permission).toBeEnabled());
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

  it.each([
    ["zh-CN", "工具权限待确认"],
    ["zh-TW", "工具權限待確認"],
    ["en-US", "Tool permissions unconfirmed"],
    ["ja-JP", "ツール権限は未確認"],
  ] as const)(
    "names unknown Claude permissions in %s without a Codex label",
    async (locale, expected) => {
      state.locale = locale;
      render(<CodexComposerControls {...props} />);
      fireEvent.click(
        await screen.findByRole("button", { name: codexCopy[state.locale].conversationSettings }),
      );
      const select = await screen.findByLabelText(sessionAgentCopy[locale].permission);
      expect(select).toHaveTextContent(expected);
      expect(select).not.toHaveTextContent(/Codex/);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "releases preparation busy after an observation change and a late %s",
    async (outcome) => {
      const pending = deferred();
      vi.mocked(state.client.prepareSessionSettings).mockReturnValueOnce(pending.promise);
      const view = render(<CodexComposerControls {...props} />);
      fireEvent.click(
        await screen.findByRole("button", { name: codexCopy[state.locale].conversationSettings }),
      );
      const permission = screen.getByLabelText(sessionAgentCopy[state.locale].permission);
      expect(permission).toBeDisabled();
      state = { ...state, usageEpoch: "observation-b" };
      view.rerender(<CodexComposerControls {...props} />);
      await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalledTimes(2));
      await act(async () => {
        if (outcome === "resolve")
          pending.resolve({ ...settings(), current: { permissionMode: "plan" } });
        else pending.reject(new Error("stale-prepare-error"));
      });
      await waitFor(() => expect(permission).toBeEnabled());
      expect(permission).toHaveTextContent(sessionAgentCopy[state.locale].permissionUnknown);
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
      fireEvent.click(
        await screen.findByRole("button", { name: codexCopy[state.locale].conversationSettings }),
      );
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
      fireEvent.click(
        await screen.findByRole("button", { name: codexCopy[state.locale].conversationSettings }),
      );
      expect(state.client.prepareSessionSettings).toHaveBeenCalledTimes(2);
      await act(async () => old.resolve(settings()));
      const permission = screen.getByLabelText(sessionAgentCopy[state.locale].permission);
      expect(permission).toBeDisabled();
      await act(async () =>
        next.resolve({ ...settings(state.selected), current: { permissionMode: "default" } }),
      );
      await waitFor(() => expect(permission).toBeEnabled());
      expect(permission).toHaveTextContent("Default");
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
    expect(await screen.findByRole("dialog")).toBeVisible();
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
      fireEvent.click(screen.getByRole("button", { name: "Change next-turn model" }));
      const picker = composerModelCopy["en-US"];
      expect(
        await screen.findByRole("dialog", {
          name:
            reason === "claude-model-unsupported"
              ? picker.chooseModel
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
      expect(
        screen.queryByRole("button", { name: "Change next-turn model" }),
      ).not.toBeInTheDocument();
    },
  );
});
