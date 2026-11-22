// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "@/features/sessions/conversation/desktop-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type CodexSessionSettings } from "@agentkib/web-client";
import { CodexComposerControls } from "@agentkib/session-ui";
import type { SessionController } from "../../desktop-session-controller";
import { composerModelCopy } from "@agentkib/session-ui";
import { codexReason } from "../../codex-copy";

let state: SessionController;
let boot = 0;
const settings: CodexSessionSettings = {
  sessionId: "session",
  revision: 1,
  available: true,
  current: { modelId: "unlisted-model", effort: "low" },
  defaults: { modelId: "listed-model", effort: "low" },
  writable: {
    model: { available: true },
    effort: { available: true },
    mode: { available: false },
    serviceTier: { available: false },
    policy: { available: false },
    restoreDefaults: { available: true },
  },
  options: {
    models: [{ id: "listed-model", name: "Listed model", efforts: ["low"], serviceTierIds: [] }],
    policies: [],
    serviceTiers: [],
  },
};

beforeEach(() => {
  state = {
    selected: "session",
    current: { id: "session", agent: "codex" },
    locale: "en-US",
    online: true,
    busy: false,
    notice: "notDispatched",
    noticeReason: "unsupported-model",
    access: {
      status: "approved",
      bootId: `boot-${++boot}`,
      device: { id: "device", accessMode: "full", advancedControl: true },
    },
    live: { sessionId: "session", status: "idle", revision: 1 },
    capabilities: { sessionId: "session", features: { settings: { available: true } } },
    client: {
      sessionSettings: vi.fn(async () => settings),
      codexGoals: vi.fn(async () => ({
        sessionId: "session",
        revision: 1,
        available: false,
        actions: {},
      })),
    },
    codexAction: vi.fn(),
    control: vi.fn(),
  } as unknown as SessionController;
});
afterEach(cleanup);

describe("Codex settings recovery on desktop", () => {
  it.each([
    ["unsupported-model", /current model is not in the model list verified on this computer/],
    ["unsupported-effort", /current model does not support the selected reasoning effort/],
  ] as const)("opens the model picker for %s without submitting", async (reason, text) => {
    state.noticeReason = reason;
    render(
      <CodexComposerControls
        session={state}
        resources={[]}
        setResources={vi.fn()}
        openPhoneFiles={vi.fn()}
        disabled={false}
      />,
    );
    expect(await screen.findByText(text)).toBeVisible();
    await screen.findByRole("button", { name: /unlisted-model/ });
    vi.mocked(state.client.sessionSettings).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Change model" }));
    const picker = composerModelCopy["en-US"];
    expect(
      await screen.findByRole("dialog", {
        name:
          reason === "unsupported-model" ? picker.model : new RegExp(`^${picker.chooseEffort}:`),
      }),
    ).toBeVisible();
    await waitFor(() =>
      expect(state.client.sessionSettings).toHaveBeenCalledWith("session", "codex"),
    );
    expect(state.codexAction).not.toHaveBeenCalled();
    expect(state.control).not.toHaveBeenCalled();
  });

  it("does not offer recovery for an uncertain receipt", () => {
    state.notice = "uncertain";
    render(
      <CodexComposerControls
        session={state}
        resources={[]}
        setResources={vi.fn()}
        openPhoneFiles={vi.fn()}
        disabled={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Change model" })).not.toBeInTheDocument();
  });

  it("displays the saved model and usage until the current settings are known", async () => {
    state.notice = undefined;
    const emptySettings = { ...settings, current: {}, selected: {} };
    vi.mocked(state.client.sessionSettings).mockResolvedValue({
      ...emptySettings,
      historicalSettings: { modelId: "older-model", effort: "high" },
      usage: {
        available: true,
        historical: true,
        state: "stale",
        usedTokens: 29,
        contextWindow: 100,
      },
    });
    const controlsProps = {
      resources: [],
      setResources: vi.fn(),
      openPhoneFiles: vi.fn(),
      disabled: false,
    };
    const view = render(<CodexComposerControls session={state} {...controlsProps} />);
    expect(await screen.findByRole("button", { name: /older-model · High/ })).toBeVisible();
    expect(screen.queryByText(/Last used|Next turn/i)).not.toBeInTheDocument();
    const ring = screen.getByRole("img", { name: "Context usage" });
    expect(ring).toHaveAccessibleDescription(expect.stringContaining("29% used"));

    state.live = {
      ...state.live!,
      settings: emptySettings,
      usage: { available: true, state: "stale" },
    };
    view.rerender(<CodexComposerControls session={state} {...controlsProps} />);
    expect(screen.getByRole("button", { name: /older-model · High/ })).toBeVisible();
    expect(ring).toHaveAccessibleDescription(expect.stringContaining("29% used"));

    state.live = { ...state.live, executionLocation: "external" };
    view.rerender(<CodexComposerControls session={state} {...controlsProps} />);
    expect(screen.getByRole("button", { name: /older-model · High/ })).toBeVisible();
    expect(ring).toHaveAccessibleDescription(expect.stringContaining("29% used"));

    state.live = {
      ...state.live,
      executionLocation: undefined,
      settings,
      usage: { available: true, state: "ready", usedTokens: 16, contextWindow: 100 },
    };
    view.rerender(<CodexComposerControls session={state} {...controlsProps} />);
    expect(await screen.findByRole("button", { name: /unlisted-model · Low/ })).toBeVisible();
    expect(ring).toHaveAccessibleDescription(expect.stringContaining("16% used"));
    expect(ring).not.toHaveAccessibleDescription(expect.stringContaining("Last recorded"));
    expect(state.codexAction).not.toHaveBeenCalled();
  });

  it("prefers the external session's recorded model over the cache, and the cache over defaults", async () => {
    state.notice = undefined;
    const props = {
      resources: [],
      setResources: vi.fn(),
      openPhoneFiles: vi.fn(),
      disabled: false,
    };
    const read = vi.mocked(state.client.sessionSettings);
    const view = render(<CodexComposerControls session={state} key="initial" {...props} />);
    await screen.findByRole("button", { name: /unlisted-model/ });

    state.live = { ...state.live!, executionLocation: "external", status: "running" };
    read.mockResolvedValue({
      ...settings,
      current: {},
      historicalSettings: { modelId: "observed-externally", effort: "high" },
    });
    view.rerender(<CodexComposerControls session={state} key="external" {...props} />);
    await screen.findByRole("button", { name: /observed-externally · High/ });

    read.mockResolvedValue({
      ...settings,
      current: { policyId: "test" },
      options: { ...settings.options, policies: [{ id: "test", name: "Read completed" }] },
    });
    view.rerender(<CodexComposerControls session={state} key="again" {...props} />);
    await screen.findByRole("button", { name: /Execution policy: Read completed/ });
    expect(screen.getByRole("button", { name: /observed-externally · High/ })).toBeVisible();
    expect(state.codexAction).not.toHaveBeenCalled();
  });

  it("shows the host default when no model is known without selecting it", async () => {
    state.notice = undefined;
    vi.mocked(state.client.sessionSettings).mockResolvedValue({
      ...settings,
      current: {},
      selected: {},
    });
    render(
      <CodexComposerControls
        session={state}
        resources={[]}
        setResources={vi.fn()}
        openPhoneFiles={vi.fn()}
        disabled={false}
      />,
    );
    const trigger = await screen.findByRole("button", { name: /Listed model · Low/ });
    expect(trigger).toHaveTextContent("Listed model");
    fireEvent.click(trigger);
    const overview = await screen.findByRole("dialog", { name: /^Select reasoning effort/ });
    fireEvent.click(within(overview).getByRole("button", { name: "Select model: Listed model" }));
    const list = await screen.findByRole("dialog", { name: "Model" });
    expect(within(list).getByRole("button", { name: "Listed model" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(state.codexAction).not.toHaveBeenCalled();
  });

  it("keeps the native history model when a cold session has only a staged policy", async () => {
    state.notice = undefined;
    vi.mocked(state.client.sessionSettings).mockResolvedValue({
      ...settings,
      applicationStatus: "pending",
      current: {},
      selected: { policyId: "workspace" },
      historicalSettings: { modelId: "gpt-6.1-sol", effort: "ultra" },
    });
    render(
      <CodexComposerControls
        session={state}
        resources={[]}
        setResources={vi.fn()}
        openPhoneFiles={vi.fn()}
        disabled={false}
      />,
    );
    const trigger = await screen.findByRole("button", { name: /gpt-6\.1-sol · Ultra/ });
    fireEvent.click(trigger);
    const overview = await screen.findByRole("dialog", { name: /^Select reasoning effort/ });
    expect(
      within(overview).getByRole("button", { name: "Select model: gpt-6.1-sol" }),
    ).toBeVisible();
    expect(state.codexAction).not.toHaveBeenCalled();
  });

  it("shows a previously opened model immediately and replaces it with the host response", async () => {
    state.notice = undefined;
    const resolved = {
      ...settings,
      current: { modelId: "listed-model", effort: "low", serviceTierId: "fast" },
    };
    const view = (key: string) => (
      <CodexComposerControls
        session={state}
        key={key}
        resources={[]}
        setResources={vi.fn()}
        openPhoneFiles={vi.fn()}
        disabled={false}
      />
    );
    const read = vi.mocked(state.client.sessionSettings).mockResolvedValue(resolved);
    const mounted = render(view("first"));
    const name = /Listed model · Low · Fast mode/;
    await screen.findByRole("button", { name });
    let finish!: (value: CodexSessionSettings) => void;
    const pending = new Promise<CodexSessionSettings>((resolve) => {
      finish = resolve;
    });
    read.mockReturnValue(pending);
    mounted.rerender(view("reopen"));
    const cached = screen.getByRole("button", { name });
    expect(cached).toHaveTextContent("Listed model");
    fireEvent.click(cached);
    const overview = await screen.findByRole("dialog", { name: /^Select reasoning effort/ });
    expect(within(overview).getByRole("button", { name: "Fast mode" })).toBeDisabled();
    expect(state.codexAction).not.toHaveBeenCalled();
    await act(async () => finish(settings));
    expect(screen.getByRole("button", { name: /unlisted-model · Low/ })).toBeVisible();
  });

  it("drops a displayed model when the current settings read is forbidden", async () => {
    state.notice = undefined;
    const controls = (key: string) => (
      <CodexComposerControls
        session={state}
        key={key}
        resources={[]}
        setResources={vi.fn()}
        openPhoneFiles={vi.fn()}
        disabled={false}
      />
    );
    const read = vi.mocked(state.client.sessionSettings);
    const mounted = render(controls("first"));
    await screen.findByRole("button", { name: /unlisted-model · Low/ });
    read.mockRejectedValue(new ApiError(403, "permission_denied"));
    mounted.rerender(controls("reopen"));
    expect(screen.getByRole("button", { name: /unlisted-model · Low/ })).toBeVisible();
    await screen.findByRole("button", { name: "Model settings" });
    expect(screen.queryByRole("button", { name: /unlisted-model · Low/ })).not.toBeInTheDocument();
  });

  it("shows one writing status below the toolbar and clears it on completion", async () => {
    state.notice = undefined;
    const props = {
      resources: [],
      setResources: vi.fn(),
      openPhoneFiles: vi.fn(),
      disabled: false,
    };
    const view = render(
      <CodexComposerControls
        session={{ ...state, settingsNotice: { status: "writing", target: "settings" } }}
        {...props}
      />,
    );
    const model = await screen.findByRole("button", { name: /unlisted-model · Low/ });
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Saving settings…");
    expect(status.previousElementSibling).toContainElement(model);
    expect(screen.getAllByText("Saving settings…")).toHaveLength(1);
    view.rerender(<CodexComposerControls session={state} {...props} />);
    expect(screen.queryByText("Saving settings…")).not.toBeInTheDocument();
  });

  it("shows a rejected settings action once below the toolbar", async () => {
    state.notice = undefined;
    state.settingsNotice = {
      group: "permissions",
      status: "notDispatched",
      reason: "collaboration-modes-unavailable",
    };
    const read = vi.mocked(state.client.sessionSettings);
    read.mockResolvedValue({
      ...settings,
      options: { ...settings.options, policies: [{ id: "verified", name: "Verified policy" }] },
    });
    render(
      <CodexComposerControls
        session={state}
        resources={[]}
        setResources={vi.fn()}
        openPhoneFiles={vi.fn()}
        disabled={false}
      />,
    );
    await screen.findByRole("button", { name: /unlisted-model · Low/ });
    const permission = screen.getByRole("button", { name: "Execution policy" });
    const feedback = screen.getByRole("status");
    const message = codexReason("en-US", state.settingsNotice.reason).text;
    expect(feedback).toHaveTextContent(message);
    expect(feedback.previousElementSibling).toContainElement(permission);
    fireEvent.click(permission);
    expect(await screen.findByRole("menu")).toBeVisible();
    expect(screen.getAllByText(message)).toHaveLength(1);
  });

  it("keeps the authorized cached model readable while an unconfirmed settings write is fenced", async () => {
    state.notice = undefined;
    const read = vi.mocked(state.client.sessionSettings);
    read.mockResolvedValue({ ...settings, current: { modelId: "listed-model", effort: "low" } });
    const controls = (key: string) => (
      <CodexComposerControls
        session={state}
        key={key}
        resources={[]}
        setResources={vi.fn()}
        openPhoneFiles={vi.fn()}
        disabled={false}
      />
    );
    const mounted = render(controls("initial"));
    await screen.findByRole("button", { name: /Listed model · Low/ });
    state.settingsNotice = { group: "model", status: "uncertain" };
    read.mockResolvedValue({
      ...settings,
      current: {},
      selected: { modelId: "unconfirmed-model" },
      applicationStatus: "unknown",
    });
    mounted.rerender(controls("pending"));
    const trigger = screen.getByRole("button", { name: /Listed model · Low/ });
    const message = "Setting status unconfirmed";
    const feedback = screen.getByText(message);
    expect(feedback.previousElementSibling).toContainElement(trigger);
    expect(trigger).toBeEnabled();
    fireEvent.click(trigger);
    const overview = await screen.findByRole("dialog", { name: /^Select reasoning effort/ });
    expect(within(overview).getByRole("button", { name: "Reset default model" })).toBeDisabled();
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.queryByText("unconfirmed-model")).not.toBeInTheDocument();
    expect(state.codexAction).not.toHaveBeenCalled();
  });
});
