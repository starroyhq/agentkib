// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ManagedAgent, type ManagedOptions } from "@agentkib/web-client";
import { initializeI18n } from "@/core/i18n";
import { composerModelCopy } from "../conversation/features/sessions/composer-model-copy";
import { takeNewSessionDraft } from "../conversation/features/sessions/new-session-draft";
import { NewSessionComposer, type NewSessionComposerProps } from "./NewSessionComposer";

const doubles = vi.hoisted(() => ({
  client: {
    origin: "",
    access: vi.fn(),
    managedOptions: vi.fn(),
    managedAction: vi.fn(),
    receipt: vi.fn(),
  },
  controlChanged: undefined as (() => void) | undefined,
}));
vi.mock("@/core/conversation-bridge", () => ({
  createDesktopConversationClient: () => doubles.client,
}));
vi.mock("@/features/agents/AgentIcon", () => ({ AgentIcon: () => null }));

const workspaces = [
  { id: "north", name: "northstar-api", last_active_at: "2026-11-09T10:00:00.000Z" },
  { id: "atlas", name: "atlas-studio", last_active_at: "2026-11-08T10:00:00.000Z" },
];
const options: Record<ManagedAgent, ManagedOptions> = {
  codex: {
    available: true,
    models: [{ id: "gpt-6.1-sol", efforts: ["low", "medium", "high"], defaultEffort: "medium" }],
    defaults: { model: "gpt-6.1-sol", effort: "medium" },
    policies: [
      { id: "workspace-write-on-request", name: "On request" },
      { id: "workspace-write-auto-review", name: "Auto review" },
      { id: "full-access-on-request", name: "Full access" },
    ],
    workspaces: [],
  },
  "claude-code": {
    available: true,
    models: [],
    permissionModes: [
      { id: "default", name: "default" },
      { id: "plan", name: "plan" },
      { id: "acceptEdits", name: "acceptEdits" },
    ],
    workspaces: [],
  },
  "deepseek-harness": {
    available: true,
    agentPresets: [
      { id: "general", name: "General", description: null, isDefault: true, broken: null },
      { id: "ptc", name: "PTC", description: "Tool calls in code", isDefault: false, broken: null },
    ],
    workspaces: [],
  },
};
const modelCopy = composerModelCopy["en-US"];
const pickerName = new RegExp(`^${modelCopy.chooseEffort}`);
const anyPickerName = new RegExp(`^(?:${modelCopy.chooseModel}|${modelCopy.chooseEffort}):`);
const claudeCatalog: ManagedOptions = {
  ...options["claude-code"],
  models: [
    { id: "default", name: "Default (recommended)", efforts: ["low", "high"] },
    { id: "sonnet", resolvedModel: "sonnet-native", name: "Sonnet", efforts: ["low", "high"] },
    { id: "opus", name: "Opus", efforts: ["low", "high"] },
  ],
  defaults: { model: "sonnet-native", effort: null },
};
const dshCatalog: ManagedOptions = {
  ...options["deepseek-harness"],
  models: [
    { id: "official/flash", name: "Flash", group: "Official", efforts: ["low", "high"] },
    {
      id: "local/pro",
      name: "Pro",
      group: "Local",
      efforts: ["low", "high"],
      defaultEffort: "low",
    },
  ],
  defaults: { model: "official/flash", effort: null },
};

function renderComposer(extra: Partial<NewSessionComposerProps> = {}) {
  const props: NewSessionComposerProps = {
    workspaces,
    placement: "home",
    onCreated: vi.fn(),
    onAddWorkspace: vi.fn(),
    onOpenSettings: vi.fn(),
    ...extra,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NewSessionComposer {...props} />
    </QueryClientProvider>,
  );
  return props;
}
const message = () => screen.getByRole("textbox", { name: "First message" });
const send = () => screen.getByRole("button", { name: "Send" });
async function write(text: string) {
  fireEvent.change(message(), { target: { value: text } });
  await waitFor(() => expect(send()).toBeEnabled());
}

async function openModelPicker() {
  fireEvent.click(await screen.findByRole("button", { name: pickerName }));
  return screen.findByRole("dialog", { name: pickerName });
}

async function openModels(currentName: string) {
  const picker = await openModelPicker();
  fireEvent.click(
    within(picker).getByRole("button", { name: `${modelCopy.chooseModel}: ${currentName}` }),
  );
  return screen.findByRole("dialog", { name: modelCopy.chooseModel });
}

async function chooseHighestEffort() {
  const picker = await screen.findByRole("dialog", { name: pickerName });
  const thumb = await within(picker).findByRole("slider", { name: modelCopy.chooseEffort });
  fireEvent.keyDown(thumb, { key: "End" });
  await waitFor(() => expect(thumb).toHaveAttribute("aria-valuetext", "High"));
  fireEvent.keyDown(thumb, { key: "Escape" });
}

describe("NewSessionComposer", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.resetAllMocks();
    // BaseUI measures the slider before it exposes the thumb; jsdom has no layout.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const width = this.hasAttribute("data-index") ? 28 : 240;
        return new DOMRect(0, 0, width, 28);
      },
    );
    localStorage.clear();
    sessionStorage.clear();
    doubles.client.access.mockResolvedValue({
      status: "approved",
      bootId: "boot",
      csrfToken: "",
      protocolVersion: 2,
      experimentalEnabled: true,
      device: { id: "desktop", name: "Desktop", send: true, approve: true, manage: true },
    });
    doubles.client.managedOptions.mockImplementation(async (agent: ManagedAgent) => options[agent]);
    doubles.client.receipt.mockResolvedValue({ found: false });
    Object.defineProperty(window, "desktopConversation", {
      configurable: true,
      value: {
        onControlChanged: (listener: () => void) => {
          doubles.controlChanged = listener;
          return () => undefined;
        },
      },
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("starts a Codex session with the chosen permission and hands it the first message", async () => {
    localStorage.setItem(
      "agentkib.newSession.target",
      JSON.stringify({ workspaceId: "atlas", agent: "codex" }),
    );
    doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
    const props = renderComposer();
    expect(screen.getByRole("button", { name: "Workspace: atlas-studio" })).toBeVisible();
    await write("Add rate limiting to login");
    const file = new File(["spec"], "spec.md", { type: "text/markdown" });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    expect(screen.getByText("spec.md")).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Ask for approval/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Full access/ }));
    fireEvent.click(send());

    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith("created"));
    expect(doubles.client.managedAction).toHaveBeenCalledExactlyOnceWith("create", {
      bootId: "boot",
      requestId: expect.any(String),
      workspaceId: "atlas",
      policyId: "full-access-on-request",
    });
    expect(takeNewSessionDraft("created")).toEqual({
      text: "Add rate limiting to login",
      files: [file],
      send: true,
    });
    expect(JSON.parse(localStorage.getItem("agentkib.newSession.target")!)).toEqual({
      workspaceId: "atlas",
      agent: "codex",
    });
  });

  it("names the model when only the effort changes, as Codex needs", async () => {
    doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
    renderComposer();
    await openModelPicker();
    await chooseHighestEffort();
    await write("Tidy the logs");
    fireEvent.click(send());
    await waitFor(() => expect(doubles.client.managedAction).toHaveBeenCalledOnce());
    expect(doubles.client.managedAction.mock.calls[0]![1]).toMatchObject({
      workspaceId: "north",
      model: "gpt-6.1-sol",
      effort: "high",
    });
  });

  it("keeps the draft and says why when nothing was created", async () => {
    doubles.client.managedAction.mockRejectedValue(
      new ApiError(403, "workspace_not_authorized", "not-dispatched"),
    );
    const props = renderComposer();
    await write("Add rate limiting");
    fireEvent.click(send());

    expect(await screen.findByRole("alert")).toHaveTextContent("The session was not created:");
    expect(message()).toHaveValue("Add rate limiting");
    expect(props.onCreated).not.toHaveBeenCalled();
    expect(send()).toBeEnabled();
    expect(sessionStorage.length).toBe(0);
  });

  it("never sends again while a create's outcome is unknown, and opens what it made", async () => {
    doubles.client.managedAction.mockRejectedValue(new ApiError(504, "request_timeout"));
    const props = renderComposer();
    await write("Add rate limiting");
    fireEvent.click(send());

    expect(await screen.findByText(/Not sure yet whether the session was created/)).toBeVisible();
    expect(send()).toBeDisabled();
    await waitFor(() => expect(doubles.client.receipt).toHaveBeenCalled());
    const requestId = doubles.client.managedAction.mock.calls[0]![1].requestId as string;
    doubles.client.receipt.mockResolvedValue({
      found: true,
      requestId,
      operation: "create",
      status: "accepted",
      sessionId: "made",
    });
    await act(async () => doubles.controlChanged?.());

    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith("made"));
    expect(doubles.client.managedAction).toHaveBeenCalledOnce();
    expect(takeNewSessionDraft("made")).toMatchObject({ text: "Add rate limiting", send: true });
  });

  it("starts from a session's own workspace and Agent, sending Claude's mode only when chosen", async () => {
    localStorage.setItem(
      "agentkib.newSession.target",
      JSON.stringify({ workspaceId: "atlas", agent: "codex" }),
    );
    doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
    renderComposer({ initial: { workspaceId: "north", agent: "claude-code" } });
    expect(screen.getByRole("button", { name: "Workspace: northstar-api" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Agent: Claude Code" })).toBeVisible();
    expect(await screen.findByRole("button", { name: /Permissions: Default/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: anyPickerName })).not.toBeInTheDocument();
    await write("Map the routes");
    fireEvent.click(send());

    await waitFor(() => expect(doubles.client.managedAction).toHaveBeenCalledOnce());
    expect(doubles.client.managedAction.mock.calls[0]![1]).toEqual({
      agent: "claude-code",
      bootId: "boot",
      requestId: expect.any(String),
      workspaceId: "north",
    });
  });

  it("uses Claude's native catalogue and submits an explicit model and effort before opening the session", async () => {
    doubles.client.managedOptions.mockResolvedValue(claudeCatalog);
    doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
    const props = renderComposer({ initial: { agent: "claude-code" } });
    const models = await openModels("Sonnet");
    expect(within(models).getByRole("button", { name: "Sonnet" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(within(models).getByRole("button", { name: "Opus" }));
    await chooseHighestEffort();
    await write("Review the routes");
    fireEvent.click(send());

    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith("created"));
    expect(doubles.client.managedAction).toHaveBeenCalledExactlyOnceWith("create", {
      agent: "claude-code",
      bootId: "boot",
      requestId: expect.any(String),
      workspaceId: "north",
      model: "opus",
      effort: "high",
      verifyStartupModel: true,
    });
    expect(takeNewSessionDraft("created")).toMatchObject({ text: "Review the routes", send: true });
  });

  it("opens Claude's model list when its default is unknown and can clear just the chosen effort", async () => {
    doubles.client.managedOptions.mockResolvedValue({ ...claudeCatalog, defaults: undefined });
    doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
    renderComposer({ initial: { agent: "claude-code" } });
    fireEvent.click(
      await screen.findByRole("button", { name: `${modelCopy.chooseModel}: Default` }),
    );
    const models = await screen.findByRole("dialog", { name: modelCopy.chooseModel });
    expect(within(models).getByRole("button", { name: "Default", pressed: true })).toBeVisible();
    expect(within(models).getByRole("button", { name: "Default (recommended)" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(within(models).getByRole("button", { name: "Opus" }));
    await chooseHighestEffort();

    const picker = await openModelPicker();
    const clear = within(picker).getByRole("button", { name: modelCopy.useDefaultEffort });
    fireEvent.click(clear);
    await waitFor(() => expect(clear).not.toBeInTheDocument());
    await userEvent.setup().keyboard("{Escape}");
    expect(
      await screen.findByRole("button", { name: `${modelCopy.chooseEffort}: Opus` }),
    ).toBeVisible();
    await write("Use Opus with its default effort");
    fireEvent.click(send());

    await waitFor(() => expect(doubles.client.managedAction).toHaveBeenCalledOnce());
    expect(doubles.client.managedAction.mock.calls[0]![1]).toEqual({
      agent: "claude-code",
      bootId: "boot",
      requestId: expect.any(String),
      workspaceId: "north",
      model: "opus",
      verifyStartupModel: true,
    });
  });

  it("groups DSH models by provider and submits the preset together with model and effort", async () => {
    doubles.client.managedOptions.mockResolvedValue(dshCatalog);
    doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
    renderComposer({ initial: { agent: "deepseek-harness" } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Preset/ }));
    await user.click(await screen.findByRole("menuitem", { name: /PTC/ }));
    const models = await openModels("Flash");
    expect(within(models).getByText("Official")).toBeVisible();
    expect(within(models).getByText("Local")).toBeVisible();
    fireEvent.click(within(models).getByRole("button", { name: "Pro" }));
    expect(await screen.findByRole("slider", { name: modelCopy.chooseEffort })).toHaveAttribute(
      "aria-valuetext",
      "Default · Low",
    );
    await chooseHighestEffort();
    await write("Profile the parser");
    fireEvent.click(send());

    await waitFor(() => expect(doubles.client.managedAction).toHaveBeenCalledOnce());
    expect(doubles.client.managedAction.mock.calls[0]![1]).toMatchObject({
      agent: "deepseek-harness",
      agentPreset: "ptc",
      model: "local/pro",
      effort: "high",
    });
  });

  it.each(["direct", "receipt"])(
    "keeps the first message when DSH model selection fails via %s",
    async (via) => {
      const reason = "dsh-create-model-not-applied";
      doubles.client.managedOptions.mockResolvedValue(dshCatalog);
      doubles.client.managedAction.mockRejectedValue(
        via === "direct"
          ? new ApiError(409, reason, "not-dispatched")
          : new ApiError(504, "request_timeout"),
      );
      const props = renderComposer({ initial: { agent: "deepseek-harness" } });
      const models = await openModels("Flash");
      fireEvent.click(within(models).getByRole("button", { name: "Pro" }));
      await chooseHighestEffort();
      await write("Keep this draft");
      fireEvent.click(send());

      if (via === "receipt") {
        await waitFor(() => expect(doubles.client.receipt).toHaveBeenCalled());
        const requestId = doubles.client.managedAction.mock.calls[0]![1].requestId as string;
        doubles.client.receipt.mockResolvedValue({
          found: true,
          operation: "create",
          requestId,
          sessionId: "blank",
          status: "not-dispatched",
          ack: { reason },
        });
        await act(async () => doubles.controlChanged?.());
      }

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Could not confirm the model for the new session. Your first message is still a draft.",
      );
      expect(screen.getByRole("alert")).not.toHaveTextContent("The session was not created:");
      expect(message()).toHaveValue("Keep this draft");
      expect(props.onCreated).not.toHaveBeenCalled();
      expect(doubles.client.managedAction).toHaveBeenCalledOnce();
    },
  );

  it("clears a workspace's Claude model selection when moving to a different workspace", async () => {
    doubles.client.managedOptions.mockImplementation(
      async (agent: ManagedAgent, _signal, workspaceId) =>
        workspaceId === "north" ? claudeCatalog : options[agent],
    );
    doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
    renderComposer({ initial: { agent: "claude-code" } });
    const models = await openModels("Sonnet");
    fireEvent.click(within(models).getByRole("button", { name: "Opus" }));
    await chooseHighestEffort();

    fireEvent.click(screen.getByRole("button", { name: "Workspace: northstar-api" }));
    fireEvent.click(await screen.findByRole("button", { name: "atlas-studio" }));
    await write("Review the routes");
    expect(screen.queryByRole("button", { name: anyPickerName })).not.toBeInTheDocument();
    fireEvent.click(send());
    await waitFor(() => expect(doubles.client.managedAction).toHaveBeenCalledOnce());
    expect(doubles.client.managedAction.mock.calls[0]![1]).toEqual({
      agent: "claude-code",
      bootId: "boot",
      requestId: expect.any(String),
      workspaceId: "atlas",
    });
  });

  it("sends a DeepSeek Harness preset only when it is not DSH's default", async () => {
    doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
    renderComposer({ initial: { agent: "deepseek-harness" } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Preset/ }));
    await user.click(await screen.findByRole("menuitem", { name: /PTC/ }));
    await write("Profile the parser");
    fireEvent.click(send());

    await waitFor(() => expect(doubles.client.managedAction).toHaveBeenCalledOnce());
    expect(doubles.client.managedAction.mock.calls[0]![1]).toMatchObject({
      agent: "deepseek-harness",
      agentPreset: "ptc",
    });
  });

  it("explains an Agent that cannot start sessions and points to settings", async () => {
    doubles.client.managedOptions.mockResolvedValue({
      available: false,
      reason: "codex-cli-version-too-old",
      workspaces: [],
    });
    const props = renderComposer();
    fireEvent.change(message(), { target: { value: "Add rate limiting" } });
    expect(await screen.findByText(/Choose another Agent, or check Settings/)).toBeVisible();
    expect(send()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
  });

  it("offers to add a workspace when there is none", () => {
    const props = renderComposer({ workspaces: [] });
    fireEvent.click(screen.getByRole("button", { name: "Add workspace" }));
    expect(props.onAddWorkspace).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
