import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  sessionProviderCapabilities,
  type Access,
  type ManagedAgent,
  type ManagedOptions,
  type NewSessionResources,
} from "@agentkib/web-client";
import {
  composerAddCopy,
  composerGoalCopy,
  composerModelCopy,
  planModeCopy,
} from "@agentkib/session-ui";
import { takeNewSessionDraft } from "@/features/conversation/features/sessions/new-session-draft";
import { publishSessionInvalidation } from "@/features/conversation/features/sessions/session-events";
import { NewSessionComposer } from "./new-session-composer";

const fixture = vi.hoisted(() => ({ session: undefined as unknown as Record<string, unknown> }));
const planLabel = planModeCopy("en-US").title;
const addCopy = composerAddCopy("en-US");
const goalCopy = composerGoalCopy("en-US");
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
  devin: {
    available: true,
    models: [],
    permissionModes: [
      { id: "auto", name: "auto" },
      { id: "accept-edits", name: "accept-edits" },
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
  attachments = true,
  advancedControl = true,
  created = "created",
  disabled = false,
  onRender,
  codexOptions = options.codex,
}: {
  full?: boolean;
  attachments?: boolean;
  advancedControl?: boolean;
  created?: string;
  disabled?: boolean;
  onRender?: () => void;
  codexOptions?: ManagedOptions;
} = {}) {
  const client = {
    managedOptions: vi.fn(
      async (agent: ManagedAgent, _signal?: AbortSignal, _workspaceId?: string) =>
        agent === "codex" ? codexOptions : options[agent],
    ),
    managedAction: vi.fn(async (_operation: string, _body: Record<string, unknown>) => ({
      accepted: true,
      sessionId: created,
    })),
    newSessionResources: vi.fn(),
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
        attachments,
        advancedControl,
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
  const composer = <NewSessionComposer onCreated={onCreated} disabled={disabled} />;
  const view = render(
    onRender ? (
      <Profiler id="new session" onRender={onRender}>
        {composer}
      </Profiler>
    ) : (
      composer
    ),
  );
  return { client, onCreated, view };
}
const message = () => screen.getByRole("textbox", { name: "First message" });
const send = () => screen.getByRole("button", { name: "Send" });
const modelCopy = composerModelCopy["en-US"];
const settingLabel = (name: string) => `${modelCopy.chooseEffort}: ${name}`;
const effortControl = () => screen.findByRole("slider", { name: modelCopy.chooseEffort });
async function highestEffort() {
  const thumb = await effortControl();
  fireEvent.keyDown(thumb, { key: "End" });
  await waitFor(() => expect(thumb).toHaveAttribute("aria-valuetext", "High"));
}
async function write(text: string) {
  fireEvent.change(message(), { target: { value: text } });
  await waitFor(() => expect(send()).toBeEnabled());
}

describe("Web NewSessionComposer", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    // The shared slider measures the control and thumb, which have no size in jsdom.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, 0, this.hasAttribute("data-index") ? 28 : 240, 28);
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

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

  it("starts Codex with its offered Fast tier", async () => {
    const { client } = setup({
      codexOptions: {
        ...options.codex,
        provider: sessionProviderCapabilities("codex"),
        models: options.codex.models?.map((model) => ({ ...model, serviceTierIds: ["priority"] })),
        serviceTiers: [{ id: "priority", name: "Fast" }],
      },
    });
    const user = userEvent.setup();
    const picker = await screen.findByRole("button", {
      name: settingLabel("gpt-6.1-sol · Medium"),
    });
    expect(picker.querySelector('svg[fill="currentColor"]')).toBeNull();
    await user.click(picker);
    await user.click(
      await within(await screen.findByRole("dialog")).findByRole("button", {
        name: modelCopy.fast,
      }),
    );
    const fastPicker = screen.getByRole("button", {
      name: settingLabel(`gpt-6.1-sol · Medium · ${modelCopy.fast}`),
    });
    expect(fastPicker.querySelector('svg[fill="currentColor"]')).toBeVisible();
    await user.keyboard("{Escape}");

    await write("Review the routes");
    fireEvent.click(send());
    await waitFor(() => expect(client.managedAction).toHaveBeenCalledOnce());
    expect(client.managedAction.mock.calls[0]![1]).toMatchObject({
      workspaceId: "atlas",
      model: "gpt-6.1-sol",
      serviceTierId: "priority",
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

  it("reserves the new agent's controls while loading and mounts the warm catalog in its first render", async () => {
    const renders: { agent: string | null; model: string | null }[] = [];
    const label = (prefix: string) =>
      document.querySelector(`button[aria-label^="${prefix}:"]`)?.getAttribute("aria-label") ??
      null;
    const { client } = setup({
      full: false,
      onRender: () =>
        renders.push({
          agent: label("Agent"),
          model: label(modelCopy.chooseEffort) ?? label("Model"),
        }),
    });
    let resolveDevin!: (value: ManagedOptions) => void;
    const devinCatalog = new Promise<ManagedOptions>((resolve) => {
      resolveDevin = resolve;
    });
    client.managedOptions.mockImplementation((agent) =>
      agent === "devin" ? devinCatalog : Promise.resolve(options[agent]),
    );

    const user = userEvent.setup();
    await screen.findByRole("button", { name: settingLabel("gpt-6.1-sol · Medium") });
    await user.click(screen.getByRole("button", { name: "Agent: Codex" }));
    await user.click(await screen.findByRole("menuitem", { name: "Devin" }));

    expect(screen.getByRole("button", { name: "Model: Loading options…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Permissions: Loading options…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Ask for approval/ })).not.toBeInTheDocument();
    fireEvent.change(message(), { target: { value: "Check the parser" } });
    expect(send()).toBeDisabled();

    await act(async () =>
      resolveDevin({
        ...options.devin,
        models: [{ id: "opus", name: "Claude Opus", efforts: ["high"] }],
        defaults: { model: "opus", effort: "high" },
        permissionModes: [
          { id: "accept-edits", name: "accept-edits" },
          { id: "dangerous", name: "dangerous" },
        ],
      }),
    );
    expect(screen.getByRole("button", { name: settingLabel("Claude Opus · High") })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /Accept edits/ }));
    expect(await screen.findAllByRole("menuitem")).toHaveLength(1);
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Agent: Devin" }));
    await user.click(await screen.findByRole("menuitem", { name: "Codex" }));
    const start = renders.length;
    await user.click(screen.getByRole("button", { name: "Agent: Codex" }));
    await user.click(await screen.findByRole("menuitem", { name: "Devin" }));
    expect(renders.slice(start).find(({ agent }) => agent === "Agent: Devin")?.model).toBe(
      settingLabel("Claude Opus · High"),
    );
    expect(client.managedOptions.mock.calls.filter(([agent]) => agent === "devin")).toHaveLength(1);
  });

  it("keeps a catalog from the previous host boot out of the new controls", async () => {
    const { client, onCreated, view } = setup();
    await screen.findByRole("button", { name: settingLabel("gpt-6.1-sol · Medium") });
    client.managedOptions.mockImplementationOnce(() => new Promise(() => {}));
    const access = fixture.session.access as Access;
    fixture.session = { ...fixture.session, access: { ...access, bootId: "rebooted" } };
    view.rerender(<NewSessionComposer onCreated={onCreated} />);

    expect(screen.getByRole("button", { name: "Model: Loading options…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /gpt-6.1-sol/ })).not.toBeInTheDocument();
    expect(client.managedOptions).toHaveBeenCalledTimes(2);
  });

  it("keeps cached options during a background refresh but clears them if access is refused", async () => {
    const { client, onCreated, view } = setup();
    const model = settingLabel("gpt-6.1-sol · Medium");
    await screen.findByRole("button", { name: model });
    const stale = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000 + 1);
    try {
      let rejectRefresh!: (error: Error) => void;
      const refresh = new Promise<ManagedOptions>((_, reject) => {
        rejectRefresh = reject;
      });
      client.managedOptions.mockReturnValueOnce(refresh);
      view.unmount();
      const refreshed = render(<NewSessionComposer onCreated={onCreated} />);
      expect(screen.getByRole("button", { name: model })).toBeEnabled();
      await act(async () => rejectRefresh(new Error("temporarily offline")));
      expect(screen.getByRole("button", { name: model })).toBeEnabled();

      client.managedOptions.mockRejectedValueOnce(new ApiError(403, "workspace_not_authorized"));
      refreshed.unmount();
      render(<NewSessionComposer onCreated={onCreated} />);
      expect(
        await screen.findByRole("button", { name: "Model: Options unavailable" }),
      ).toBeDisabled();
      expect(screen.queryByRole("button", { name: model })).not.toBeInTheDocument();
    } finally {
      stale.mockRestore();
    }
  });

  it("names the model when only the effort changes, as Codex needs", async () => {
    const { client } = setup();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: settingLabel("gpt-6.1-sol · Medium") }),
    );
    await highestEffort();
    await user.keyboard("{Escape}");
    await write("Tidy the logs");
    fireEvent.click(send());
    await waitFor(() => expect(client.managedAction).toHaveBeenCalledOnce());
    expect(client.managedAction.mock.calls[0]![1]).toMatchObject({
      model: "gpt-6.1-sol",
      effort: "high",
    });
  });

  it("verifies Claude startup choices against the selected workspace and hands off its first message", async () => {
    const { client, onCreated } = setup();
    let resolveOld!: (value: ManagedOptions) => void;
    const oldCatalog = new Promise<ManagedOptions>((resolve) => {
      resolveOld = resolve;
    });
    const claudeOptions = {
      ...options["claude-code"],
      provider: sessionProviderCapabilities("claude-code"),
    };
    client.managedOptions.mockImplementation(async (agent, _signal, workspaceId) => {
      if (agent !== "claude-code") return options[agent];
      if (workspaceId === "atlas") return oldCatalog;
      return {
        ...claudeOptions,
        models: [{ id: "north-claude", name: "North Claude", efforts: ["medium", "high"] }],
        defaults: { model: "north-claude", effort: "medium" },
      };
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Agent: Codex" }));
    await user.click(await screen.findByRole("menuitem", { name: "Claude Code" }));
    const oldRequest = client.managedOptions.mock.calls.find(([agent]) => agent === "claude-code");
    expect(oldRequest).toEqual(["claude-code", expect.any(AbortSignal), "atlas"]);
    await user.click(screen.getByRole("button", { name: "Workspace: atlas-studio" }));
    await user.click(await screen.findByRole("button", { name: "northstar-api" }));
    expect(client.managedOptions).toHaveBeenCalledWith(
      "claude-code",
      expect.any(AbortSignal),
      "north",
    );
    expect(oldRequest?.[1]?.aborted).toBe(true);
    await act(async () =>
      resolveOld({
        ...claudeOptions,
        models: [{ id: "old", name: "Old Claude", efforts: ["low"] }],
        defaults: { model: "old", effort: "low" },
      }),
    );

    await user.click(
      await screen.findByRole("button", { name: settingLabel("North Claude · Medium") }),
    );
    const overview = await screen.findByRole("dialog");
    expect(
      within(overview).queryByRole("button", { name: modelCopy.fast }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(overview).getByRole("button", { name: `${modelCopy.chooseModel}: North Claude` }),
    );
    const models = await screen.findByRole("dialog", { name: modelCopy.model });
    expect(within(models).queryByRole("button", { name: "Old Claude" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: settingLabel("North Claude · Medium") }));
    await highestEffort();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Tool permissions" }));
    expect(screen.queryByRole("menuitem", { name: /Plan mode/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("menuitem", { name: /^Accept edits/ }));
    await user.click(screen.getByRole("button", { name: "Add context" }));
    expect(await screen.findByRole("button", { name: addCopy.attachment })).toBeEnabled();
    await user.click(await screen.findByRole("button", { name: planLabel }));
    const attachment = new File(["notes"], "notes.txt", { type: "text/plain" });
    fireEvent.paste(message(), { clipboardData: { files: [attachment] } });
    await write("Review the startup path");
    fireEvent.click(send());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("created"));
    expect(client.managedAction).toHaveBeenCalledExactlyOnceWith("create", {
      agent: "claude-code",
      bootId: "boot",
      requestId: expect.any(String),
      workspaceId: "north",
      model: "north-claude",
      effort: "high",
      permissionMode: "plan",
      verifyStartupModel: true,
    });
    expect(takeNewSessionDraft("created")).toEqual({
      text: "Review the startup path",
      files: [attachment],
      send: true,
    });
  });

  it("stages a DSH goal without offering unsupported Plan or workspace resources", async () => {
    const { client, onCreated } = setup();
    client.managedOptions.mockImplementation(async (agent) =>
      agent === "deepseek-harness"
        ? { ...options[agent], provider: sessionProviderCapabilities(agent) }
        : options[agent],
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Agent: Codex" }));
    await user.click(await screen.findByRole("menuitem", { name: "DeepSeek Harness" }));
    await screen.findByRole("button", { name: /General/ });
    await user.click(screen.getByRole("button", { name: "Add context" }));
    const menu = await screen.findByRole("dialog", { name: "Add context" });
    expect(within(menu).queryByRole("button", { name: planLabel })).not.toBeInTheDocument();
    expect(
      within(menu).queryByRole("button", { name: addCopy.filesAndFolders }),
    ).not.toBeInTheDocument();
    await user.click(within(menu).getByRole("button", { name: goalCopy.title }));
    const editor = await screen.findByRole("dialog", { name: goalCopy.title });
    expect(within(editor).queryByRole("spinbutton")).not.toBeInTheDocument();
    await user.type(
      within(editor).getByRole("textbox", { name: goalCopy.objective }),
      "Organize docs",
    );
    await user.click(within(editor).getByRole("button", { name: goalCopy.saveDraft }));
    expect(client.newSessionResources).not.toHaveBeenCalled();
    expect(client.managedAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Start goal" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("created"));
    expect(client.managedAction).toHaveBeenCalledExactlyOnceWith("create", {
      agent: "deepseek-harness",
      bootId: "boot",
      requestId: expect.any(String),
      workspaceId: "atlas",
    });
    expect(takeNewSessionDraft("created")).toEqual({
      text: "",
      files: [],
      goal: { objective: "Organize docs" },
      send: true,
    });
  });

  it("turns on Plan with the composer shortcut and waits for a first message before starting the goal", async () => {
    const { client, onCreated } = setup({
      codexOptions: { ...options.codex, provider: sessionProviderCapabilities("codex") },
    });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /gpt-6.1-sol/ });
    await user.click(screen.getByRole("button", { name: "Add context" }));
    const menu = await screen.findByRole("dialog", { name: "Add context" });
    await user.click(within(menu).getByRole("button", { name: goalCopy.title }));
    const editor = await screen.findByRole("dialog", { name: goalCopy.title });
    await user.type(
      within(editor).getByRole("textbox", { name: goalCopy.objective }),
      "Review docs",
    );
    await user.click(within(editor).getByRole("button", { name: goalCopy.saveDraft }));

    fireEvent.change(message(), { target: { value: "/plan" } });
    expect(screen.getByRole("listbox").parentElement).toHaveClass("top-full", "mt-2");
    expect(fireEvent.keyDown(message(), { key: "Enter" })).toBe(false);
    expect(message()).toHaveValue("");
    expect(screen.getByRole("button", { name: "Start goal" })).toBeDisabled();
    expect(screen.getByText(goalCopy.planNeedsMessage)).toBeVisible();
    expect(client.managedAction).not.toHaveBeenCalled();

    await write("Check the setup guide");
    await user.click(send());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("created"));
    expect(client.managedAction).toHaveBeenCalledExactlyOnceWith(
      "create",
      expect.objectContaining({ mode: "plan", workspaceId: "atlas" }),
    );
    expect(takeNewSessionDraft("created")).toEqual({
      text: "Check the setup guide",
      files: [],
      goal: { objective: "Review docs" },
      send: true,
    });
  });

  it("cancels selected Plan and goal drafts from the toolbar without creating a session", async () => {
    const { client } = setup({
      codexOptions: { ...options.codex, provider: sessionProviderCapabilities("codex") },
    });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /gpt-6.1-sol/ });
    const add = screen.getByRole("button", { name: "Add context" });
    await user.click(add);
    await user.click(await screen.findByRole("button", { name: planLabel }));
    await user.click(add);
    await user.click(await screen.findByRole("button", { name: goalCopy.title }));
    const editor = within(await screen.findByRole("dialog", { name: goalCopy.title }));
    await user.type(editor.getByRole("textbox", { name: goalCopy.objective }), "Review docs");
    await user.click(editor.getByRole("button", { name: goalCopy.saveDraft }));

    await user.click(screen.getByRole("button", { name: "Exit Plan mode" }));
    await user.click(screen.getByRole("button", { name: goalCopy.clearDraft }));
    expect(screen.queryByRole("button", { name: "Exit Plan mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: goalCopy.title })).not.toBeInTheDocument();
    expect(send()).toBeDisabled();
    expect(client.managedAction).not.toHaveBeenCalled();
  });

  it("rejects references from a previous workspace visit or runtime boot", async () => {
    const { client, view, onCreated } = setup({
      codexOptions: { ...options.codex, provider: sessionProviderCapabilities("codex") },
    });
    let finishOldRead!: (page: NewSessionResources) => void;
    client.newSessionResources
      .mockReturnValueOnce(new Promise<NewSessionResources>((resolve) => (finishOldRead = resolve)))
      .mockResolvedValueOnce({
        workspaceId: "north",
        revision: 0,
        resources: [{ id: "new", name: "Current.md", kind: "file", available: true }],
      });
    const user = userEvent.setup();
    const browse = async () => {
      await user.click(screen.getByRole("button", { name: "Add context" }));
      await user.click(await screen.findByRole("button", { name: addCopy.filesAndFolders }));
    };
    await screen.findByRole("button", { name: /gpt-6.1-sol/ });
    await browse();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Workspace: atlas-studio" }));
    await user.click(await screen.findByRole("button", { name: "northstar-api" }));
    await browse();
    expect(await screen.findByRole("checkbox", { name: /Current.md/ })).toBeVisible();
    expect(client.newSessionResources.mock.calls[0]?.[3]?.aborted).toBe(true);
    await act(async () =>
      finishOldRead({
        workspaceId: "atlas",
        revision: 0,
        resources: [{ id: "old", name: "Previous.md", kind: "file", available: true }],
      }),
    );
    expect(screen.queryByRole("checkbox", { name: /Previous.md/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Current.md/ }));
    await user.click(screen.getByRole("button", { name: "Done" }));
    await write("Review the current file");

    fixture.session.access = { ...(fixture.session.access as Access), bootId: "new-boot" };
    view.rerender(<NewSessionComposer onCreated={onCreated} />);
    expect(
      await screen.findByText("This resource is no longer valid. Select it again."),
    ).toBeVisible();
    expect(send()).toBeDisabled();
    expect(client.managedAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Remove Current.md/ }));
    await waitFor(() => expect(send()).toBeEnabled());
  });

  it("withholds workspace resources and goal writes without advanced control", async () => {
    const { client } = setup({
      advancedControl: false,
      codexOptions: { ...options.codex, provider: sessionProviderCapabilities("codex") },
    });
    await screen.findByRole("button", { name: /gpt-6.1-sol/ });
    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    const menu = await screen.findByRole("dialog", { name: "Add context" });
    expect(within(menu).getByRole("button", { name: addCopy.attachment })).toBeEnabled();
    expect(
      within(menu).queryByRole("button", { name: addCopy.filesAndFolders }),
    ).not.toBeInTheDocument();
    expect(within(menu).queryByRole("button", { name: goalCopy.title })).not.toBeInTheDocument();
    expect(client.newSessionResources).not.toHaveBeenCalled();
  });

  it("keeps Claude Plan explicit when switching to a workspace that offers only Execute", async () => {
    const { client, onCreated } = setup();
    client.managedOptions.mockImplementation(async (agent, _signal, workspaceId) =>
      agent === "claude-code" && workspaceId === "north"
        ? {
            ...options[agent],
            permissionModes: options[agent].permissionModes?.filter(({ id }) => id !== "plan"),
          }
        : options[agent],
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Agent: Codex" }));
    await user.click(await screen.findByRole("menuitem", { name: "Claude Code" }));
    await user.click(await screen.findByRole("button", { name: "Tool permissions" }));
    await user.click(await screen.findByRole("menuitem", { name: /^Accept edits/ }));
    await user.click(screen.getByRole("button", { name: "Add context" }));
    await user.click(await screen.findByRole("button", { name: planLabel }));
    await user.click(screen.getByRole("button", { name: "Tool permissions: Accept edits" }));
    expect(await screen.findByRole("menuitem", { name: /^Accept edits/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Workspace: atlas-studio" }));
    await user.click(await screen.findByRole("button", { name: "northstar-api" }));
    fireEvent.change(message(), { target: { value: "Review before making changes" } });
    expect(
      await screen.findByRole("button", { name: "Tool permissions: Accept edits" }),
    ).toBeEnabled();
    expect(send()).toBeDisabled();
    expect(client.managedAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Add context" }));
    await user.click(await screen.findByRole("button", { name: planLabel }));
    await waitFor(() => expect(send()).toBeEnabled());
    fireEvent.click(send());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("created"));
    expect(client.managedAction).toHaveBeenCalledExactlyOnceWith("create", {
      agent: "claude-code",
      bootId: "boot",
      requestId: expect.any(String),
      workspaceId: "north",
      permissionMode: "acceptEdits",
    });
  });

  it("keeps + visible when the device has no attachment grant", () => {
    setup({ attachments: false });
    const add = screen.getByRole("button", { name: "Add context" });
    expect(add).toBeVisible();
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute(
      "title",
      "This access does not include permission to upload attachments.",
    );
    fireEvent.click(add);
    expect(screen.queryByRole("button", { name: addCopy.attachment })).not.toBeInTheDocument();
  });

  it("starts Devin with an offered effort and Fast pair and never hands off its dispatched prompt", async () => {
    const { client, onCreated } = setup();
    client.managedOptions.mockImplementation(async (agent) =>
      agent === "devin"
        ? {
            ...options.devin,
            provider: sessionProviderCapabilities("devin"),
            models: [
              {
                id: "opus",
                name: "Claude Opus",
                efforts: ["low", "high"],
                serviceTierIds: ["fast"],
                variants: [
                  { id: "opus-low", effort: "low" },
                  { id: "opus-high", effort: "high" },
                  { id: "opus-high-fast", effort: "high", serviceTierId: "fast" },
                ],
              },
            ],
            serviceTiers: [{ id: "fast", name: "Fast" }],
          }
        : options[agent],
    );
    client.managedAction.mockRejectedValue(new ApiError(504, "request_timeout"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Agent: Codex" }));
    await user.click(await screen.findByRole("menuitem", { name: "Devin" }));
    expect(client.managedOptions).toHaveBeenCalledWith("devin", expect.any(AbortSignal), "atlas");
    expect(screen.getByRole("button", { name: "Add context" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: addCopy.attachment })).not.toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", {
        name: `${modelCopy.chooseModel}: ${modelCopy.defaultModel}`,
      }),
    );
    const startSettings = within(
      await screen.findByRole("dialog", { name: modelCopy.modelSettings }),
    );
    expect(startSettings.queryByRole("button", { name: "Claude Opus" })).not.toBeInTheDocument();
    await user.click(
      startSettings.getByRole("button", {
        name: `${modelCopy.chooseModel}: ${modelCopy.defaultModel}`,
      }),
    );
    const models = await screen.findByRole("dialog", { name: modelCopy.model });
    await user.click(within(models).getByRole("button", { name: "Claude Opus" }));
    const overview = await screen.findByRole("dialog");
    const thumb = await effortControl();
    fireEvent.keyDown(thumb, { key: "Home" });
    await waitFor(() => expect(thumb).toHaveAttribute("aria-valuetext", "Low"));
    const fast = within(overview).getByRole("button", { name: modelCopy.fast });
    expect(fast).toBeDisabled();
    await highestEffort();
    expect(fast).toBeEnabled();
    await user.click(fast);
    expect(
      screen.getByRole("button", { name: settingLabel(`Claude Opus · High · ${modelCopy.fast}`) }),
    ).toBeVisible();
    expect(within(overview).queryByRole("slider")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await write("Check the parser");
    fireEvent.click(send());
    await screen.findByText(/Not sure yet whether the session was created/);
    const request = client.managedAction.mock.calls[0]![1];
    expect(request).toMatchObject({
      agent: "devin",
      workspaceId: "atlas",
      model: "opus",
      effort: "high",
      serviceTierId: "fast",
      prompt: "Check the parser",
    });
    client.receipt.mockResolvedValue({
      found: true,
      requestId: request.requestId,
      operation: "create",
      status: "accepted",
      sessionId: "made",
    } as never);
    await act(async () => publishSessionInvalidation(client, "", ["receipts"]));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("made"));
    expect(client.managedAction).toHaveBeenCalledOnce();
    expect(takeNewSessionDraft("made")).toBeUndefined();
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

  it("leaves Claude creation available while Codex awaits a receipt in the same workspace", async () => {
    const { client, onCreated } = setup();
    client.managedAction.mockRejectedValueOnce(new ApiError(504, "request_timeout"));
    await write("Work in Codex");
    fireEvent.click(send());
    await screen.findByText(/Not sure yet whether the session was created/);
    expect(send()).toBeDisabled();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Agent: Codex" }));
    await user.click(await screen.findByRole("menuitem", { name: "Claude Code" }));
    await write("Work in Claude");
    await waitFor(() => expect(send()).toBeEnabled());
    fireEvent.click(send());
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith("created"));
    expect(client.managedAction.mock.calls[1]![1]).toMatchObject({
      agent: "claude-code",
      workspaceId: "atlas",
    });
    expect(takeNewSessionDraft("created")).toMatchObject({ text: "Work in Claude" });

    await user.click(screen.getByRole("button", { name: "Agent: Claude Code" }));
    await user.click(await screen.findByRole("menuitem", { name: "Codex" }));
    fireEvent.change(message(), { target: { value: "Check the original target" } });
    expect(await screen.findByText(/Not sure yet whether the session was created/)).toBeVisible();
    expect(send()).toBeDisabled();
    expect(client.managedAction).toHaveBeenCalledTimes(2);
  });

  it("sends Claude's mode only when chosen and a DeepSeek Harness preset only when not the default", async () => {
    const { client } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Agent: Codex" }));
    await user.click(await screen.findByRole("menuitem", { name: /Claude Code/ }));
    await user.click(await screen.findByRole("button", { name: "Tool permissions" }));
    const menu = within(await screen.findByRole("menu", { name: "Tool permissions" }));
    expect(menu.getAllByRole("menuitem")).toHaveLength(2);
    expect(menu.getByRole("menuitem", { name: /^Manual approval/ })).not.toHaveAttribute(
      "aria-current",
    );
    expect(menu.getByRole("menuitem", { name: /^Accept edits/ })).not.toHaveAttribute(
      "aria-current",
    );
    await user.keyboard("{Escape}");
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

  it("reads the current DSH workspace catalog and sends only its offered startup choices", async () => {
    const { client, onCreated } = setup();
    const dshOptions = options["deepseek-harness"];
    let resolveNorth!: (value: ManagedOptions) => void;
    const northCatalog = new Promise<ManagedOptions>((resolve) => {
      resolveNorth = resolve;
    });
    client.managedOptions.mockImplementation(async (agent, _signal, workspaceId) => {
      if (agent !== "deepseek-harness") return options[agent];
      if (workspaceId === "atlas") return dshOptions;
      return northCatalog;
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Agent: Codex" }));
    await user.click(await screen.findByRole("menuitem", { name: "DeepSeek Harness" }));
    await user.click(await screen.findByRole("button", { name: /Preset/ }));
    await user.click(await screen.findByRole("menuitem", { name: /PTC/ }));
    expect(client.managedOptions).toHaveBeenCalledWith(
      "deepseek-harness",
      expect.any(AbortSignal),
      "atlas",
    );
    await user.click(screen.getByRole("button", { name: "Workspace: atlas-studio" }));
    await user.click(await screen.findByRole("button", { name: "northstar-api" }));
    expect(client.managedOptions).toHaveBeenCalledWith(
      "deepseek-harness",
      expect.any(AbortSignal),
      "north",
    );
    expect(screen.getByRole("button", { name: "Preset: Loading options…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Model: Loading options…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Permissions:/ })).not.toBeInTheDocument();
    await act(async () =>
      resolveNorth({
        available: true,
        provider: sessionProviderCapabilities("deepseek-harness"),
        models: [{ id: "deepseek/chat", name: "DeepSeek Chat", efforts: ["low", "high"] }],
        defaults: { model: "deepseek/chat", effort: "low" },
        workspaces: [],
      }),
    );

    await user.click(
      await screen.findByRole("button", { name: settingLabel("DeepSeek Chat · Low") }),
    );
    expect(screen.queryByRole("button", { name: modelCopy.fast })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preset: Options unavailable" })).toBeDisabled();
    await highestEffort();
    await user.keyboard("{Escape}");
    await write("Profile the parser");
    fireEvent.click(send());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("created"));
    expect(client.managedAction).toHaveBeenCalledExactlyOnceWith("create", {
      agent: "deepseek-harness",
      bootId: "boot",
      requestId: expect.any(String),
      workspaceId: "north",
      model: "deepseek/chat",
      effort: "high",
    });
    expect(takeNewSessionDraft("created")).toMatchObject({
      text: "Profile the parser",
      send: true,
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
