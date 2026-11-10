// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ManagedAgent, type ManagedOptions } from "@agentkib/web-client";
import { initializeI18n } from "@/core/i18n";
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
vi.mock("../conversation/features/sessions/composer-model-picker", () => ({
  ComposerModelPicker: ({
    selection,
    onChange,
  }: {
    selection?: { modelId?: string; effort?: string };
    onChange: (change: { effort: string }) => Promise<void>;
  }) => (
    <button type="button" onClick={() => void onChange({ effort: "high" })}>
      {`Model ${selection?.modelId} ${selection?.effort}`}
    </button>
  ),
}));

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

describe("NewSessionComposer", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.resetAllMocks();
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
  afterEach(cleanup);

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
    fireEvent.click(await screen.findByRole("button", { name: "Model gpt-6.1-sol medium" }));
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
    expect(screen.queryByRole("button", { name: /^Model/ })).not.toBeInTheDocument();
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
