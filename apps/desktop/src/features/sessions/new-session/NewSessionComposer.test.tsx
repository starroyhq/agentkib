// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  sessionProviderCapabilities,
  type ManagedAgent,
  type ManagedOptions,
} from "@agentkib/web-client";
import {
  composerAddCopy,
  composerGoalCopy,
  composerModelCopy,
  newSessionCopy,
  planModeCopy,
  takeNewSessionDraft,
} from "@agentkib/session-ui";
import { initializeI18n } from "@/core/i18n";
import type { ConversationSessionSummary } from "@/core/types";
import { composerLayoutCopy } from "@agentkib/session-ui";
import { NewSessionComposer, type NewSessionComposerProps } from "./NewSessionComposer";
import { useOpenWhenListed } from "./use-open-when-listed";

const doubles = vi.hoisted(() => ({
  client: {
    origin: "",
    access: vi.fn(),
    managedOptions: vi.fn(),
    newSessionResources: vi.fn(),
    managedAction: vi.fn(),
    receipt: vi.fn(),
    devinTerminal: vi.fn(),
  },
  controlChanged: undefined as (() => void) | undefined,
}));
vi.mock("@/core/conversation-bridge", () => ({
  createDesktopConversationClient: () => doubles.client,
}));
vi.mock("@/features/agents/AgentIcon", () => ({ AgentIcon: () => null }));
vi.mock("../conversation-catalog", () => ({
  refreshConversationCatalog: async () => undefined,
}));

const workspaces = [
  { id: "north", name: "northstar-api", last_active_at: "2026-11-09T10:00:00.000Z" },
  { id: "atlas", name: "atlas-studio", last_active_at: "2026-11-08T10:00:00.000Z" },
];
const options: Record<ManagedAgent, ManagedOptions> = {
  antigravity: {
    available: true,
    models: [{ id: "gemini-3.8-flash", efforts: ["low", "medium", "high"] }],
    permissionModes: [
      { id: "default", name: "Default" },
      { id: "accept-edits", name: "Accept edits" },
      { id: "auto", name: "Auto" },
      { id: "plan", name: "Plan" },
    ],
    workspaces: [],
  },
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
  devin: {
    available: true,
    models: [],
    permissionModes: [
      { id: "auto", name: "auto" },
      { id: "accept-edits", name: "accept-edits" },
      { id: "smart", name: "smart" },
      { id: "dangerous", name: "dangerous" },
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
const copy = newSessionCopy("en-US");
const addCopy = composerAddCopy("en-US");
const goalCopy = composerGoalCopy("en-US");
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
  provider: sessionProviderCapabilities("deepseek-harness"),
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

function renderComposer(
  extra: Partial<NewSessionComposerProps> = {},
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const props: NewSessionComposerProps = {
    workspaces,
    placement: "home",
    onCreated: vi.fn(),
    onAddWorkspace: vi.fn(),
    onOpenSettings: vi.fn(),
    ...extra,
  };
  render(
    <QueryClientProvider client={client}>
      <NewSessionComposer {...props} />
    </QueryClientProvider>,
  );
  return props;
}
const message = () => screen.getByRole("textbox", { name: "First message" });
const send = () => screen.getByRole("button", { name: "Send" });
const addContext = () => screen.getByRole("button", { name: "Add context" });
const planLabel = () => planModeCopy("en-US").title;
const optionSlot = (label: string, status = copy.loadingOptions) =>
  screen.getByRole("button", { name: `${label}: ${status}` });
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
  return screen.findByRole("dialog", { name: modelCopy.model });
}

async function openDefaultModelList() {
  const modelButton = `${modelCopy.chooseModel}: ${modelCopy.defaultModel}`;
  fireEvent.click(await screen.findByRole("button", { name: modelButton }));
  const overview = await screen.findByRole("dialog", { name: modelCopy.modelSettings });
  fireEvent.click(within(overview).getByRole("button", { name: modelButton }));
  return screen.findByRole("dialog", { name: modelCopy.model });
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
      device: {
        id: "desktop",
        name: "Desktop",
        accessMode: "full",
        send: true,
        approve: true,
        manage: true,
        advancedControl: true,
      },
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

  it("reserves the selected Agent's slots while loading and reuses its cached options immediately", async () => {
    let resolveDevin!: (value: ManagedOptions) => void;
    const devinCatalog = new Promise<ManagedOptions>((resolve) => {
      resolveDevin = resolve;
    });
    doubles.client.managedOptions.mockImplementation((agent: ManagedAgent) =>
      agent === "devin" ? devinCatalog : Promise.resolve(options[agent]),
    );
    renderComposer();
    const chooseAgent = async (from: string, to: string) => {
      fireEvent.click(screen.getByRole("button", { name: `Agent: ${from}` }));
      fireEvent.click(await screen.findByRole("menuitem", { name: to }));
    };
    await write("Keep this draft while switching");
    await chooseAgent("Codex", "Devin");
    for (const label of [copy.permission, copy.model]) {
      expect(optionSlot(label)).toBeDisabled();
      expect(optionSlot(label)).toHaveAttribute("aria-busy", "true");
    }
    expect(screen.queryByRole("button", { name: /Ask for approval/ })).not.toBeInTheDocument();
    expect(addContext()).toBeDisabled();
    expect(send()).toBeDisabled();
    expect(message()).toHaveValue("Keep this draft while switching");

    await act(async () => {
      resolveDevin({
        ...options.devin,
        permissionModes: [{ id: "accept-edits", name: "Accept edits" }],
        models: [{ id: "devin-native", name: "Devin native model", efforts: ["high"] }],
        defaults: { model: "devin-native", effort: "high" },
      });
    });
    expect(await screen.findByRole("button", { name: /Devin native model/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Accept edits/ }));
    const choices = await screen.findAllByRole("menuitem");
    expect(choices).toHaveLength(1);
    fireEvent.click(choices[0]!);
    await chooseAgent("Devin", "Codex");
    expect(screen.getByRole("button", { name: /gpt-6\.1-sol/ })).toBeEnabled();
    await chooseAgent("Codex", "Devin");
    expect(screen.getByRole("button", { name: /Devin native model/ })).toBeEnabled();
    expect(doubles.client.managedOptions).toHaveBeenCalledTimes(2);
    expect(doubles.client.managedAction).not.toHaveBeenCalled();
  });

  it("keeps supported startup actions visible but disabled until the host options arrive", async () => {
    let resolveOptions!: (value: ManagedOptions) => void;
    doubles.client.managedOptions.mockReturnValue(
      new Promise<ManagedOptions>((resolve) => {
        resolveOptions = resolve;
      }),
    );
    renderComposer();
    await waitFor(() => expect(doubles.client.managedOptions).toHaveBeenCalledOnce());
    const user = userEvent.setup();
    await user.click(addContext());
    const menu = await screen.findByRole("dialog", { name: "Add context" });
    const actions = [addCopy.filesAndFolders, goalCopy.title, planLabel()].map((name) =>
      within(menu).getByRole("button", { name }),
    );
    for (const action of actions) {
      expect(action).toBeDisabled();
      expect(action).toHaveAttribute("title", copy.loadingOptions);
      await user.click(action);
    }
    expect(doubles.client.newSessionResources).not.toHaveBeenCalled();
    expect(doubles.client.managedAction).not.toHaveBeenCalled();

    await act(async () => {
      resolveOptions({ ...options.codex, provider: sessionProviderCapabilities("codex") });
    });
    await waitFor(() => {
      for (const action of actions) expect(action).toBeEnabled();
    });
    expect(screen.getByRole("button", { name: /gpt-6\.1-sol/ })).toBeEnabled();
    expect(doubles.client.newSessionResources).not.toHaveBeenCalled();
    expect(doubles.client.managedAction).not.toHaveBeenCalled();
  });

  it("shows no selectable permissions or model when this device cannot create sessions", async () => {
    doubles.client.access.mockResolvedValue({
      status: "approved",
      bootId: "boot",
      csrfToken: "",
      protocolVersion: 2,
      experimentalEnabled: true,
      device: { id: "desktop", name: "Desktop", send: true, approve: false, manage: false },
    });
    renderComposer();
    await screen.findByRole("button", { name: `${copy.permission}: ${copy.optionsUnavailable}` });
    expect(optionSlot(copy.permission, copy.optionsUnavailable)).toBeDisabled();
    expect(optionSlot(copy.model, copy.optionsUnavailable)).toBeDisabled();
    expect(doubles.client.managedOptions).not.toHaveBeenCalled();
    fireEvent.change(message(), { target: { value: "Draft only" } });
    expect(send()).toBeDisabled();
    fireEvent.click(send());
    expect(doubles.client.managedAction).not.toHaveBeenCalled();
  });

  it("keeps a warm catalogue through a transient error and removes it after access is refused", async () => {
    doubles.client.managedOptions.mockResolvedValue({
      ...options.codex,
      provider: sessionProviderCapabilities("codex"),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderComposer({}, client);
    await write("Keep this draft");
    const refresh = () => client.invalidateQueries({ queryKey: ["new-session-options"] });
    let resolveRefresh!: (value: ManagedOptions) => void;
    doubles.client.managedOptions.mockReturnValueOnce(
      new Promise<ManagedOptions>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = refresh();
    });
    await waitFor(() => expect(doubles.client.managedOptions).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /gpt-6\.1-sol/ })).toBeEnabled();
    fireEvent.click(addContext());
    const menu = await screen.findByRole("dialog", { name: "Add context" });
    for (const name of [addCopy.filesAndFolders, goalCopy.title, planLabel()])
      expect(within(menu).getByRole("button", { name })).toBeEnabled();
    await act(async () => {
      resolveRefresh({ ...options.codex, provider: sessionProviderCapabilities("codex") });
      await refreshing;
    });

    doubles.client.managedOptions.mockRejectedValueOnce(new ApiError(503, "host_offline"));
    await act(refresh);
    expect(screen.getByRole("button", { name: /gpt-6\.1-sol/ })).toBeEnabled();
    expect(send()).toBeEnabled();

    doubles.client.managedOptions.mockRejectedValueOnce(new ApiError(403, "permission_denied"));
    await act(refresh);
    await waitFor(() => expect(optionSlot(copy.model, copy.optionsUnavailable)).toBeDisabled());
    expect(optionSlot(copy.permission, copy.optionsUnavailable)).toBeDisabled();
    for (const name of [addCopy.filesAndFolders, goalCopy.title, planLabel()])
      expect(within(menu).getByRole("button", { name })).toBeDisabled();
    expect(doubles.client.newSessionResources).not.toHaveBeenCalled();
    expect(send()).toBeDisabled();
    expect(message()).toHaveValue("Keep this draft");
    doubles.client.managedOptions.mockRejectedValueOnce(new ApiError(503, "host_offline"));
    await act(refresh);
    expect(optionSlot(copy.model, copy.optionsUnavailable)).toBeDisabled();
    expect(send()).toBeDisabled();
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
    const user = userEvent.setup();
    const fileInput = screen.getByLabelText("Add files", { selector: "input" });
    const chooseFile = vi.spyOn(fileInput, "click");
    await user.click(addContext());
    const addMenu = await screen.findByRole("dialog", { name: "Add context" });
    expect(within(addMenu).getByRole("button", { name: planLabel() })).toBeDisabled();
    await user.click(within(addMenu).getByRole("button", { name: addCopy.attachment }));
    expect(chooseFile).toHaveBeenCalledOnce();
    const file = new File(["spec"], "spec.md", { type: "text/markdown" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(screen.getByText("spec.md")).toBeVisible();
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

  it("stages workspace references, Plan, and a goal before creating a native thread", async () => {
    const folder = {
      id: "opaque-folder",
      kind: "directory",
      name: "docs",
      available: true,
      navigationId: "opaque-nav",
    };
    const file = { id: "opaque-file", kind: "file", name: "Guide.md", available: true };
    doubles.client.managedOptions.mockResolvedValue({
      ...options.codex,
      provider: sessionProviderCapabilities("codex"),
    });
    doubles.client.newSessionResources
      .mockResolvedValueOnce({ workspaceId: "north", revision: 0, resources: [folder] })
      .mockResolvedValueOnce({ workspaceId: "north", revision: 0, resources: [file] });
    doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
    const props = renderComposer();
    const user = userEvent.setup();

    await screen.findByRole("button", { name: /gpt-6.1-sol/ });
    await user.click(addContext());
    expect(doubles.client.newSessionResources).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: planLabel(), pressed: false })).toBeVisible();
    await user.keyboard("{Escape}");
    await user.type(message(), "/");
    expect(screen.getByRole("listbox").parentElement).toHaveClass("top-full");
    expect(screen.getByRole("option", { name: /\/plan/ })).toBeVisible();
    await user.keyboard("{Enter}");
    expect(message()).toHaveValue("");

    await user.click(addContext());
    expect(await screen.findByRole("button", { name: planLabel(), pressed: true })).toBeVisible();
    await user.click(await screen.findByRole("button", { name: goalCopy.title }));
    await user.type(screen.getByRole("textbox", { name: goalCopy.objective }), "Improve docs");
    fireEvent.change(screen.getByRole("spinbutton", { name: goalCopy.budget }), {
      target: { value: "4000" },
    });
    await user.click(screen.getByRole("button", { name: goalCopy.saveDraft }));
    const startGoal = screen.getByRole("button", { name: "Start goal" });
    expect(startGoal).toBeDisabled();
    expect(startGoal).toHaveAttribute("title", goalCopy.planNeedsMessage);
    expect(startGoal).not.toHaveClass("disabled:pointer-events-none");
    expect(screen.queryByText(goalCopy.planNeedsMessage)).not.toBeInTheDocument();
    await user.click(addContext());
    await user.click(await screen.findByRole("button", { name: addCopy.filesAndFolders }));
    await user.click(await screen.findByRole("checkbox", { name: /docs/ }));
    await user.click(screen.getByRole("button", { name: "Open folder: docs" }));
    await user.click(await screen.findByRole("checkbox", { name: /Guide.md/ }));
    await user.click(screen.getByRole("button", { name: "Done" }));
    const resourceNeedsMessage = composerLayoutCopy["en-US"].resourceNeedsMessage;
    expect(startGoal).toBeDisabled();
    expect(startGoal).toHaveAttribute("title", resourceNeedsMessage);
    expect(screen.queryByText(resourceNeedsMessage)).not.toBeInTheDocument();
    expect(doubles.client.newSessionResources.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ["north", "codex", undefined],
      ["north", "codex", "opaque-nav"],
    ]);
    expect(doubles.client.managedAction).not.toHaveBeenCalled();

    await write("Review this project before updating the docs");
    expect(send()).toHaveAttribute("title", "Send");
    await user.click(send());
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith("created"));
    expect(doubles.client.managedAction).toHaveBeenCalledExactlyOnceWith("create", {
      bootId: "boot",
      requestId: expect.any(String),
      workspaceId: "north",
      mode: "plan",
      policyId: "workspace-write-on-request",
    });
    expect(takeNewSessionDraft("created")).toEqual({
      text: "Review this project before updating the docs",
      files: [],
      resources: [folder, file],
      goal: { objective: "Improve docs", tokenBudget: 4000 },
      send: true,
    });
  });

  it("opens and removes a saved goal from the composer toolbar without creating a session", async () => {
    doubles.client.managedOptions.mockResolvedValue({
      ...options.codex,
      provider: sessionProviderCapabilities("codex"),
    });
    renderComposer();
    await write("Keep this first message");
    const user = userEvent.setup();
    await user.click(addContext());
    await user.click(await screen.findByRole("button", { name: goalCopy.title }));
    await user.type(screen.getByRole("textbox", { name: goalCopy.objective }), "Fix docs");
    await user.click(screen.getByRole("button", { name: goalCopy.saveDraft }));

    const goalChip = screen.getByRole("button", { name: goalCopy.title });
    expect(goalChip).toHaveAttribute("title", "Fix docs");
    await user.click(goalChip);
    expect(screen.getByRole("textbox", { name: goalCopy.objective })).toHaveValue("Fix docs");
    await user.click(screen.getByRole("button", { name: goalCopy.close }));
    await user.click(screen.getByRole("button", { name: goalCopy.clearDraft }));
    expect(screen.queryByRole("button", { name: goalCopy.title })).not.toBeInTheDocument();
    expect(message()).toHaveValue("Keep this first message");
    expect(doubles.client.managedAction).not.toHaveBeenCalled();
  });

  it("uses the host's create capabilities in preference to its local provider defaults", async () => {
    const provider = sessionProviderCapabilities("codex")!;
    doubles.client.managedOptions.mockResolvedValue({
      ...options.codex,
      provider: {
        ...provider,
        create: { ...provider.create, mode: "with-first-message", attachments: false },
      },
    } satisfies ManagedOptions);
    doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
    const props = renderComposer({ initial: { agent: "codex" } });

    await write("Review the routes");
    expect(addContext()).toBeEnabled();
    const user = userEvent.setup();
    await user.click(addContext());
    const menu = await screen.findByRole("dialog", { name: "Add context" });
    expect(within(menu).queryByRole("button", { name: addCopy.attachment })).toBeNull();
    for (const name of [addCopy.filesAndFolders, goalCopy.title, planLabel()])
      expect(within(menu).getByRole("button", { name })).toBeDisabled();
    expect(doubles.client.newSessionResources).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    fireEvent.click(send());
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith("created"));
    expect(doubles.client.managedAction).toHaveBeenCalledExactlyOnceWith("create", {
      bootId: "boot",
      requestId: expect.any(String),
      workspaceId: "north",
      policyId: "workspace-write-on-request",
      prompt: "Review the routes",
    });
    expect(takeNewSessionDraft("created")).toBeUndefined();
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

  it("starts Codex with its offered Fast tier", async () => {
    doubles.client.managedOptions.mockResolvedValue({
      ...options.codex,
      provider: sessionProviderCapabilities("codex"),
      models: options.codex.models?.map((model) => ({ ...model, serviceTierIds: ["priority"] })),
      serviceTiers: [{ id: "priority", name: "Fast" }],
    } satisfies ManagedOptions);
    doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
    renderComposer();

    const picker = await openModelPicker();
    const fast = within(picker).getByRole("button", { name: modelCopy.fast });
    expect(fast).toBeEnabled();
    expect(fast.querySelector("svg")).toHaveAttribute("fill", "none");
    fireEvent.click(fast);
    await waitFor(() => expect(fast).toHaveAttribute("aria-pressed", "true"));
    expect(fast.querySelector("svg")).toHaveAttribute("fill", "currentColor");
    await userEvent.setup().keyboard("{Escape}");
    expect(
      screen.getByRole("button", { name: /gpt-6\.1-sol.*Fast/ }).querySelector("svg"),
    ).toHaveAttribute("fill", "currentColor");

    await write("Review the routes");
    fireEvent.click(send());
    await waitFor(() => expect(doubles.client.managedAction).toHaveBeenCalledOnce());
    expect(doubles.client.managedAction.mock.calls[0]![1]).toMatchObject({
      workspaceId: "north",
      model: "gpt-6.1-sol",
      serviceTierId: "priority",
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

  it("allows creating in another workspace and ignores an earlier target's late receipt", async () => {
    doubles.client.managedAction.mockRejectedValueOnce(new ApiError(504, "request_timeout"));
    let finishReceipt!: (result: unknown) => void;
    doubles.client.receipt.mockReturnValueOnce(
      new Promise((resolve) => {
        finishReceipt = resolve;
      }),
    );
    const { onCreated } = renderComposer();
    await write("Work in northstar");
    fireEvent.click(send());
    await screen.findByText(/Not sure yet whether the session was created/);
    await waitFor(() => expect(doubles.client.receipt).toHaveBeenCalledOnce());
    const requestId = doubles.client.managedAction.mock.calls[0]![1].requestId;
    expect(send()).toBeDisabled();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Workspace: northstar-api" }));
    await user.click(await screen.findByRole("button", { name: "atlas-studio" }));
    await write("Work in atlas");
    await act(async () =>
      finishReceipt({
        found: true,
        requestId,
        operation: "create",
        status: "accepted",
        workspaceId: "north",
        sessionId: "northstar-session",
      }),
    );
    expect(onCreated).not.toHaveBeenCalled();
    expect(takeNewSessionDraft("northstar-session")).toBeUndefined();
    expect(message()).toHaveValue("Work in atlas");
    expect(send()).toBeEnabled();

    doubles.client.managedAction.mockResolvedValueOnce({
      accepted: true,
      sessionId: "atlas-session",
    });
    fireEvent.click(send());
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith("atlas-session"));
    expect(doubles.client.managedAction).toHaveBeenCalledTimes(2);
    expect(doubles.client.managedAction.mock.calls[1]![1]).toMatchObject({ workspaceId: "atlas" });
  });

  it.each([undefined, "default"])(
    "starts from the session's workspace and sends Claude permission %s only when chosen",
    async (permissionMode) => {
      localStorage.setItem(
        "agentkib.newSession.target",
        JSON.stringify({ workspaceId: "atlas", agent: "codex" }),
      );
      doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
      renderComposer({ initial: { workspaceId: "north", agent: "claude-code" } });
      expect(screen.getByRole("button", { name: "Workspace: northstar-api" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Agent: Claude Code" })).toBeVisible();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Tool permissions" }));
      const menu = within(await screen.findByRole("menu", { name: "Tool permissions" }));
      const manual = menu.getByRole("menuitem", { name: /^Manual approval/ });
      const acceptEdits = menu.getByRole("menuitem", { name: /^Accept edits/ });
      expect(menu.getAllByRole("menuitem")).toEqual([manual, acceptEdits]);
      expect(manual).not.toHaveAttribute("aria-current");
      expect(acceptEdits).not.toHaveAttribute("aria-current");
      if (permissionMode) {
        await user.click(manual);
        expect(
          screen.getByRole("button", { name: "Tool permissions: Manual approval" }),
        ).toBeVisible();
      } else {
        await user.keyboard("{Escape}");
      }
      expect(screen.queryByRole("button", { name: anyPickerName })).not.toBeInTheDocument();
      await write("Map the routes");
      fireEvent.click(send());

      await waitFor(() => expect(doubles.client.managedAction).toHaveBeenCalledOnce());
      expect(doubles.client.managedAction.mock.calls[0]![1]).toEqual({
        agent: "claude-code",
        bootId: "boot",
        requestId: expect.any(String),
        workspaceId: "north",
        ...(permissionMode ? { permissionMode } : {}),
      });
    },
  );

  it.each([
    ["Plan", "plan"],
    ["Execute", "acceptEdits"],
  ])(
    "starts Claude in %s with the matching native permission field",
    async (mode, permissionMode) => {
      doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
      renderComposer({ initial: { workspaceId: "north", agent: "claude-code" } });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Tool permissions" }));
      const permissions = await screen.findByRole("menu", { name: "Tool permissions" });
      expect(within(permissions).queryByText(/Plan/)).not.toBeInTheDocument();
      await user.click(within(permissions).getByText("Accept edits"));

      await user.click(addContext());
      const addMenu = await screen.findByRole("dialog", { name: "Add context" });
      expect(within(addMenu).getByRole("button", { name: addCopy.attachment })).toBeVisible();
      await user.click(within(addMenu).getByText(planLabel()));
      await user.click(screen.getByRole("button", { name: "Tool permissions: Accept edits" }));
      expect(await screen.findByRole("menuitem", { name: /^Accept edits/ })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await user.keyboard("{Escape}");
      if (mode === "Execute") {
        await user.click(addContext());
        const addMenu = await screen.findByRole("dialog", { name: "Add context" });
        const plan = within(addMenu).getByRole("button", { name: planLabel() });
        expect(plan).toHaveAttribute("aria-pressed", "true");
        await user.click(plan);
      }

      await write("Map the routes");
      fireEvent.click(send());
      await waitFor(() => expect(doubles.client.managedAction).toHaveBeenCalledOnce());
      expect(doubles.client.managedAction.mock.calls[0]![1]).toMatchObject({
        agent: "claude-code",
        permissionMode,
      });
    },
  );

  it("requires an explicit mode change if the next workspace cannot start in Plan", async () => {
    doubles.client.managedOptions.mockImplementation(async (_agent, _signal, workspaceId) =>
      workspaceId === "north"
        ? options["claude-code"]
        : { ...options["claude-code"], permissionModes: [{ id: "default", name: "default" }] },
    );
    renderComposer({ initial: { workspaceId: "north", agent: "claude-code" } });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Tool permissions" });
    await user.click(addContext());
    const addMenu = await screen.findByRole("dialog", { name: "Add context" });
    await user.click(within(addMenu).getByRole("button", { name: planLabel() }));
    await write("Map the routes");

    await user.click(screen.getByRole("button", { name: "Workspace: northstar-api" }));
    await user.click(await screen.findByRole("button", { name: "atlas-studio" }));
    await screen.findByRole("button", { name: "Tool permissions" });
    expect(send()).toBeDisabled();
    expect(doubles.client.managedAction).not.toHaveBeenCalled();
    await user.click(addContext());
    const menu = await screen.findByRole("dialog", { name: "Add context" });
    await user.click(within(menu).getByRole("button", { name: planLabel() }));
    expect(send()).toBeEnabled();
  });

  it("uses Claude's native catalogue and submits an explicit model and effort before opening the session", async () => {
    doubles.client.managedOptions.mockResolvedValue({
      ...claudeCatalog,
      provider: sessionProviderCapabilities("claude-code"),
    });
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
    const file = new File(["spec"], "spec.md", { type: "text/markdown" });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    fireEvent.click(send());

    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith("created"));
    expect(doubles.client.managedOptions).toHaveBeenCalledWith(
      "claude-code",
      expect.any(AbortSignal),
      "north",
    );
    expect(doubles.client.managedAction).toHaveBeenCalledExactlyOnceWith("create", {
      agent: "claude-code",
      bootId: "boot",
      requestId: expect.any(String),
      workspaceId: "north",
      model: "opus",
      effort: "high",
      verifyStartupModel: true,
    });
    expect(takeNewSessionDraft("created")).toEqual({
      text: "Review the routes",
      files: [file],
      send: true,
    });
  });

  it.each(["times out", "is cancelled"] as const)(
    "keeps Claude's first message as an unsent draft when the new session catalog wait %s",
    async (end) => {
      const sessionId = `claude-missing-from-catalog-${end}`;
      const retryId = "claude-retry";
      const session = {
        id: sessionId,
        agent: "claude-code",
        workspace_id: "north",
        archived: false,
        sidechain: false,
        availability: "readable",
      } satisfies ConversationSessionSummary;
      doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId });
      const open = vi.fn();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      function Composer({ sessions }: { sessions: ConversationSessionSummary[] }) {
        const onCreated = useOpenWhenListed(sessions, open);
        return (
          <QueryClientProvider client={client}>
            <NewSessionComposer
              initial={{ agent: "claude-code" }}
              workspaces={workspaces}
              placement="home"
              onCreated={onCreated}
              onAddWorkspace={vi.fn()}
              onOpenSettings={vi.fn()}
            />
          </QueryClientProvider>
        );
      }
      const view = render(<Composer sessions={[]} />);
      await write("Review the routes");
      const file = new File(["spec"], "spec.md", { type: "text/markdown" });
      fireEvent.change(document.querySelector('input[type="file"]')!, {
        target: { files: [file] },
      });
      vi.useFakeTimers();
      try {
        await act(async () => fireEvent.click(send()));
        expect(doubles.client.managedAction).toHaveBeenCalledExactlyOnceWith(
          "create",
          expect.not.objectContaining({ prompt: expect.any(String) }),
        );
        expect(send()).toBeDisabled();
        if (end === "is cancelled") {
          await act(async () => view.unmount());
          expect(takeNewSessionDraft(sessionId)).toEqual({
            text: "Review the routes",
            files: [file],
            send: false,
          });
          await act(async () => vi.advanceTimersByTimeAsync(10_000));
          expect(open).not.toHaveBeenCalled();
          return;
        }
        await act(async () => vi.advanceTimersByTimeAsync(10_000));
        expect(send()).toBeEnabled();
        expect(message()).toHaveValue("Review the routes");
        expect(screen.getByText("spec.md")).toBeVisible();
        expect(screen.getByText(copy.notListed)).toBeVisible();

        const retry = { ...session, id: retryId };
        view.rerender(<Composer sessions={[session, retry]} />);
        expect(open).not.toHaveBeenCalled();
        expect(takeNewSessionDraft(sessionId)).toBeUndefined();

        doubles.client.managedAction.mockResolvedValueOnce({ accepted: true, sessionId: retryId });
        await act(async () => fireEvent.click(send()));
        expect(open).toHaveBeenCalledExactlyOnceWith(retry);
        expect(takeNewSessionDraft(retryId)).toEqual({
          text: "Review the routes",
          files: [file],
          send: true,
        });
        expect(takeNewSessionDraft(retryId)).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("opens Claude's model list when its default is unknown and resets both model and effort", async () => {
    doubles.client.managedOptions.mockResolvedValue({ ...claudeCatalog, defaults: undefined });
    doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
    renderComposer({ initial: { agent: "claude-code" } });
    const models = await openDefaultModelList();
    expect(within(models).getByRole("button", { name: "Default", pressed: true })).toBeVisible();
    expect(within(models).getByRole("button", { name: "Default (recommended)" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(within(models).getByRole("button", { name: "Opus" }));
    await chooseHighestEffort();

    const picker = await openModelPicker();
    expect(within(picker).queryByRole("button", { name: modelCopy.useDefaultEffort })).toBeNull();
    fireEvent.click(within(picker).getByRole("button", { name: modelCopy.reset }));
    await screen.findByRole("dialog", { name: modelCopy.modelSettings });
    await userEvent.setup().keyboard("{Escape}");
    expect(
      await screen.findByRole("button", {
        name: `${modelCopy.chooseModel}: ${modelCopy.defaultModel}`,
      }),
    ).toBeVisible();
    await write("Use the default model and effort");
    fireEvent.click(send());

    await waitFor(() => expect(doubles.client.managedAction).toHaveBeenCalledOnce());
    expect(doubles.client.managedAction.mock.calls[0]![1]).toEqual({
      agent: "claude-code",
      bootId: "boot",
      requestId: expect.any(String),
      workspaceId: "north",
    });
  });

  it("groups DSH models by provider and submits the preset together with model and effort", async () => {
    let resolveCatalog!: (value: ManagedOptions) => void;
    doubles.client.managedOptions.mockReturnValue(
      new Promise<ManagedOptions>((resolve) => {
        resolveCatalog = resolve;
      }),
    );
    doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
    renderComposer({ initial: { agent: "deepseek-harness" } });
    expect(optionSlot(copy.preset)).toBeDisabled();
    expect(optionSlot(copy.model)).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Permissions/ })).not.toBeInTheDocument();
    await act(async () => resolveCatalog(dshCatalog));
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole("button", { name: /Preset/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Preset/ }));
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
    expect(doubles.client.managedOptions).toHaveBeenCalledWith(
      "deepseek-harness",
      expect.any(AbortSignal),
      "north",
    );
    expect(doubles.client.managedAction.mock.calls[0]![1]).toMatchObject({
      agent: "deepseek-harness",
      agentPreset: "ptc",
      model: "local/pro",
      effort: "high",
    });
    expect(doubles.client.managedAction.mock.calls[0]![1]).not.toHaveProperty("prompt");
    expect(takeNewSessionDraft("created")?.text).toBe("Profile the parser");
  });

  it("shows registered presets, keeps the host order and explains a disabled preset in its title", async () => {
    doubles.client.managedOptions.mockResolvedValue({
      available: true,
      workspaces: [],
      agentPresets: [
        { id: "standard", name: null, description: null, isDefault: true, broken: null },
        {
          id: "broken",
          name: "Broken preset",
          description: null,
          isDefault: false,
          broken: "preset-load-failed",
        },
      ],
    });
    renderComposer({ initial: { agent: "deepseek-harness" } });
    const user = userEvent.setup();
    const preset = await screen.findByRole("button", { name: /Standard mode/ });
    await user.click(preset);
    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAccessibleName(/Standard mode/);
    expect(items[1]).toHaveAccessibleName("Broken preset");
    expect(items[1]).toHaveAttribute("aria-disabled", "true");
    expect(items[1]).toHaveAttribute("title", "Failed to load");
    await user.click(items[1]!);
    expect(preset).toHaveTextContent("Standard mode");
  });

  it("disables DSH's startup preset UI when the host declares it unavailable", async () => {
    const provider = sessionProviderCapabilities("deepseek-harness")!;
    doubles.client.managedOptions.mockResolvedValue({
      ...dshCatalog,
      provider: { ...provider, create: { ...provider.create, agentPresets: false } },
    });
    doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
    renderComposer({ initial: { agent: "deepseek-harness" } });
    await write("Start with the default preset");
    expect(screen.queryByRole("button", { name: /Preset/ })).not.toBeInTheDocument();
    fireEvent.click(send());
    await waitFor(() => expect(doubles.client.managedAction).toHaveBeenCalledOnce());
    expect(doubles.client.managedAction.mock.calls[0]![1]).not.toHaveProperty("agentPreset");
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
    await waitFor(() => expect(screen.getByRole("button", { name: /Preset/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Preset/ }));
    await user.click(await screen.findByRole("menuitem", { name: /PTC/ }));
    await write("Profile the parser");
    fireEvent.click(send());

    await waitFor(() => expect(doubles.client.managedAction).toHaveBeenCalledOnce());
    expect(doubles.client.managedAction.mock.calls[0]![1]).toMatchObject({
      agent: "deepseek-harness",
      agentPreset: "ptc",
    });
  });

  it("submits a supported Devin effort and Fast variant and shows its model capacity", async () => {
    const catalog: ManagedOptions = {
      ...options.devin,
      models: [
        {
          id: "opus",
          name: "Opus",
          efforts: ["low", "medium", "high"],
          serviceTierIds: ["fast"],
          variants: [
            { id: "opus-low", effort: "low", maxContextTokens: 200_000 },
            { id: "opus-medium", effort: "medium", maxContextTokens: 400_000 },
            { id: "opus-high", effort: "high", maxContextTokens: 600_000 },
            {
              id: "opus-medium-fast",
              effort: "medium",
              serviceTierId: "fast",
              maxContextTokens: 800_000,
            },
            {
              id: "opus-high-fast",
              effort: "high",
              serviceTierId: "fast",
              maxContextTokens: 1_000_000,
            },
          ],
        },
      ],
      serviceTiers: [{ id: "fast", name: "Fast" }],
    };
    doubles.client.managedOptions.mockResolvedValue(catalog);
    doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
    renderComposer({ initial: { agent: "devin" } });

    const models = await openDefaultModelList();
    fireEvent.click(within(models).getByRole("button", { name: "Opus" }));
    const slider = await screen.findByRole("slider", { name: modelCopy.chooseEffort });
    expect(screen.getByRole("button", { name: modelCopy.fast })).toBeDisabled();
    fireEvent.keyDown(slider, { key: "Home" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: modelCopy.fast })).toBeDisabled(),
    );
    fireEvent.keyDown(slider, { key: "End" });
    const fast = screen.getByRole("button", { name: modelCopy.fast });
    await waitFor(() => expect(fast).toBeEnabled());
    fireEvent.click(fast);
    await waitFor(() => expect(fast).toHaveAttribute("aria-pressed", "true"));
    await userEvent.setup().keyboard("{Escape}");
    expect(screen.getByRole("button", { name: /Opus.*Fast/ }).querySelector("svg")).toHaveAttribute(
      "fill",
      "currentColor",
    );

    await write("Review the routes");
    fireEvent.click(send());
    await waitFor(() => expect(doubles.client.managedAction).toHaveBeenCalledOnce());
    expect(doubles.client.managedAction.mock.calls[0]![1]).toMatchObject({
      agent: "devin",
      model: "opus",
      effort: "high",
      serviceTierId: "fast",
      prompt: "Review the routes",
    });
  });

  it("can start a Devin session using a standalone context window variant", async () => {
    const standard = { id: "opus", maxContextTokens: 200_000 };
    const long = { id: "opus-1m", maxContextTokens: 1_000_000 };
    doubles.client.managedOptions.mockResolvedValue({
      ...options.devin,
      models: [
        { id: "opus", name: "Opus", variants: [standard, long] },
        { ...long, name: "Opus 1M", variants: [long] },
      ],
    } satisfies ManagedOptions);
    doubles.client.managedAction.mockResolvedValue({ accepted: true, sessionId: "created" });
    renderComposer({ initial: { agent: "devin" } });
    const models = await openDefaultModelList();
    fireEvent.click(within(models).getByRole("button", { name: "Opus" }));
    fireEvent.click(await screen.findByRole("button", { name: "Opus 1M" }));
    await userEvent.setup().keyboard("{Escape}");
    await write("Review the routes");
    fireEvent.click(send());
    await waitFor(() => expect(doubles.client.managedAction).toHaveBeenCalledOnce());
    expect(doubles.client.managedAction.mock.calls[0]![1]).toMatchObject({
      agent: "devin",
      model: "opus-1m",
      prompt: "Review the routes",
    });
  });

  it("offers Devin CLI's own login in a terminal when Devin is not logged in", async () => {
    doubles.client.managedAction.mockRejectedValue(
      new ApiError(409, "devin-login-required", "not-dispatched"),
    );
    doubles.client.devinTerminal.mockResolvedValue({ terminal: "Terminal.app" });
    renderComposer({ initial: { agent: "devin" } });
    await write("Fix the build");
    fireEvent.click(send());
    fireEvent.click(
      await screen.findByRole("button", { name: "Log in to Devin CLI in a terminal" }),
    );
    expect(await screen.findByText(/Opened in Terminal\.app/)).toBeVisible();
    // The same client that read this device's access asks; a fresh one would refuse to send.
    expect(doubles.client.devinTerminal).toHaveBeenCalledWith({
      action: "login",
      workspaceId: expect.any(String),
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
