import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ManagedAgent, type ManagedOptions } from "@agentkib/web-client";
import { takeNewSessionDraft } from "@/features/conversation/features/sessions/new-session-draft";
import { publishSessionInvalidation } from "@/features/conversation/features/sessions/session-events";
import { NewSessionComposer } from "./new-session-composer";

const fixture = vi.hoisted(() => ({ session: undefined as unknown as Record<string, unknown> }));
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => fixture.session,
}));

const options: Record<ManagedAgent, ManagedOptions> = {
  codex: {
    available: true,
    models: [
      { id: "gpt-6.1-sol", name: "gpt-6.1-sol", efforts: ["low", "medium", "high"] },
      { id: "gpt-6.1-mini", name: "gpt-6.1-mini", efforts: ["low", "medium"] },
    ],
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

let origin = 0;
function setup({
  full = true,
  created = "created",
  disabled = false,
}: { full?: boolean; created?: string; disabled?: boolean } = {}) {
  const client = {
    managedOptions: vi.fn(async (agent: ManagedAgent) => options[agent]),
    managedAction: vi.fn(async (_operation: string, _body: Record<string, unknown>) => ({
      accepted: true,
      sessionId: created,
    })),
    receipt: vi.fn(async (requestId: string) => ({ found: false, requestId })),
  };
  fixture.session = {
    locale: "en-US",
    // A fresh origin keeps each test's cached options and saved identities apart.
    origin: `http://127.0.0.1:${2000 + ++origin}`,
    client,
    access: {
      status: "approved",
      csrfToken: "csrf",
      bootId: "boot",
      protocolVersion: 2,
      experimentalEnabled: true,
      device: {
        id: "browser",
        name: "Browser",
        send: true,
        approve: true,
        manage: true,
        ...(full ? { accessMode: "full" } : {}),
      },
    },
    sessions: [
      {
        id: "s1",
        workspace_id: "atlas",
        agent: "codex",
        updated_at: "2026-11-11T10:00:00.000Z",
        archived: false,
        sidechain: false,
        availability: "readable",
      },
    ],
    workspaces: [
      { id: "north", name: "northstar-api", path: "/demo/northstar-api" },
      { id: "atlas", name: "atlas-studio", path: "/demo/atlas-studio" },
    ],
  };
  const onCreated = vi.fn();
  render(<NewSessionComposer onCreated={onCreated} disabled={disabled} />);
  return { client, onCreated };
}
const message = () => screen.getByRole("textbox", { name: "First message" });
const send = () => screen.getByRole("button", { name: "Send" });
async function write(text: string) {
  fireEvent.change(message(), { target: { value: text } });
  await waitFor(() => expect(send()).toBeEnabled());
}

describe("Web NewSessionComposer", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(cleanup);

  it("starts in the most recent workspace and hands the new session its first message", async () => {
    const { client, onCreated } = setup();
    expect(screen.getByRole("button", { name: "Workspace: atlas-studio" })).toBeVisible();
    await write("Add rate limiting to login");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Ask for approval/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Full access/ }));
    fireEvent.click(send());

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("created"));
    expect(client.managedAction).toHaveBeenCalledExactlyOnceWith("create", {
      bootId: "boot",
      requestId: expect.any(String),
      workspaceId: "atlas",
      policyId: "full-access-on-request",
    });
    expect(takeNewSessionDraft("created")).toEqual({
      text: "Add rate limiting to login",
      files: [],
      send: true,
    });
    expect(JSON.parse(localStorage.getItem("agentkib.newSession.target")!)).toEqual({
      workspaceId: "atlas",
      agent: "codex",
    });
  });

  it("offers a browser without full access only the policies the host takes from it", async () => {
    const { client } = setup({ full: false });
    await write("Tidy the logs");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Ask for approval/ }));
    expect(await screen.findAllByRole("menuitem")).toHaveLength(1);
    await user.keyboard("{Escape}");
    fireEvent.click(send());
    await waitFor(() => expect(client.managedAction).toHaveBeenCalledOnce());
    expect(client.managedAction.mock.calls[0]![1]).toMatchObject({
      policyId: "workspace-write-on-request",
    });
  });

  it("names the model when only the effort changes, as Codex needs", async () => {
    const { client } = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Model: gpt-6.1-sol · Medium" }));
    await user.click(await screen.findByRole("menuitem", { name: "High" }));
    await write("Tidy the logs");
    fireEvent.click(send());
    await waitFor(() => expect(client.managedAction).toHaveBeenCalledOnce());
    expect(client.managedAction.mock.calls[0]![1]).toMatchObject({
      model: "gpt-6.1-sol",
      effort: "high",
    });
  });

  it("keeps the draft and says why when nothing was created", async () => {
    const { client, onCreated } = setup();
    client.managedAction.mockRejectedValue(
      new ApiError(403, "workspace_not_authorized", "not-dispatched"),
    );
    await write("Add rate limiting");
    fireEvent.click(send());
    expect(await screen.findByRole("alert")).toHaveTextContent("The session was not created:");
    expect(message()).toHaveValue("Add rate limiting");
    expect(onCreated).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });

  it("never sends again while a create's outcome is unknown, and opens what it made", async () => {
    const { client, onCreated } = setup();
    client.managedAction.mockRejectedValue(new ApiError(504, "request_timeout"));
    await write("Add rate limiting");
    fireEvent.click(send());
    expect(await screen.findByText(/Not sure yet whether the session was created/)).toBeVisible();
    expect(send()).toBeDisabled();
    const requestId = (client.managedAction.mock.calls[0] as unknown[])[1] as {
      requestId: string;
    };
    client.receipt.mockResolvedValue({
      found: true,
      requestId: requestId.requestId,
      operation: "create",
      status: "accepted",
      sessionId: "made",
    } as never);
    await act(async () => publishSessionInvalidation(client, "", ["receipts"]));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("made"));
    expect(client.managedAction).toHaveBeenCalledOnce();
    expect(takeNewSessionDraft("made")).toMatchObject({ text: "Add rate limiting", send: true });
  });

  it("sends Claude's mode only when chosen and a DeepSeek Harness preset only when not the default", async () => {
    const { client } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Agent: Codex" }));
    await user.click(await screen.findByRole("menuitem", { name: /Claude Code/ }));
    expect(await screen.findByRole("button", { name: /Permissions: Default/ })).toBeVisible();
    await write("Map the routes");
    fireEvent.click(send());
    await waitFor(() => expect(client.managedAction).toHaveBeenCalledOnce());
    expect(client.managedAction.mock.calls[0]![1]).toEqual({
      agent: "claude-code",
      bootId: "boot",
      requestId: expect.any(String),
      workspaceId: "atlas",
    });

    cleanup();
    // The last session's Agent is remembered; start this one from Codex again.
    localStorage.clear();
    const dsh = setup();
    await user.click(screen.getByRole("button", { name: "Agent: Codex" }));
    await user.click(await screen.findByRole("menuitem", { name: /DeepSeek Harness/ }));
    await user.click(await screen.findByRole("button", { name: /Preset/ }));
    await user.click(await screen.findByRole("menuitem", { name: /PTC/ }));
    await write("Profile the parser");
    fireEvent.click(send());
    await waitFor(() => expect(dsh.client.managedAction).toHaveBeenCalledOnce());
    expect(dsh.client.managedAction.mock.calls[0]![1]).toMatchObject({
      agent: "deepseek-harness",
      agentPreset: "ptc",
    });
  });

  it("explains an Agent that cannot start sessions here", async () => {
    const { client } = setup();
    client.managedOptions.mockResolvedValue({
      available: false,
      reason: "codex-cli-version-too-old",
      workspaces: [],
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Agent: Codex" }));
    await user.click(await screen.findByRole("menuitem", { name: /Claude Code/ }));
    fireEvent.change(message(), { target: { value: "Add rate limiting" } });
    expect(await screen.findByText(/Choose another Agent\./)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Settings" })).not.toBeInTheDocument();
    expect(send()).toBeDisabled();
  });

  it("waits while the connection is lost", async () => {
    setup({ disabled: true });
    fireEvent.change(message(), { target: { value: "Add rate limiting" } });
    await screen.findByRole("button", { name: /Ask for approval/ });
    expect(send()).toBeDisabled();
  });
});
