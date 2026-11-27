// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@agentkib/web-client";
import { initializeI18n } from "@/core/i18n";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import type { ConversationSessionSummary } from "@/core/types";
import { sessionCopy, sessionReason } from "./conversation/session-copy";
import { SessionRowMenu } from "./SessionRowMenu";
import { SessionWorkerAssignmentDialog } from "./SessionWorkerAssignmentDialog";

const { client, claudeRequest, createConversationClient } = vi.hoisted(() => ({
  client: {
    sessionCapabilities: vi.fn(),
    access: vi.fn(),
    live: vi.fn(),
    sessionAction: vi.fn(),
    setSessionPinned: vi.fn(),
  },
  claudeRequest: vi.fn(),
  createConversationClient: vi.fn(),
}));
vi.mock("@/core/conversation-bridge", () => ({
  createDesktopConversationClient: createConversationClient,
}));
vi.mock("@/core/desktop", () => ({
  desktopApi: () => ({ claude: { request: claudeRequest } }),
}));
const copy = sessionCopy["en-US"];
const summary = (agent: string, archived = false) =>
  ({
    id: "session",
    agent,
    title: "Synthetic session",
    workspace_id: "workspace",
    archived,
    sidechain: false,
    availability: "readable",
  }) as ConversationSessionSummary;
const features = (value: Record<string, { available: boolean; reason?: string }>) =>
  client.sessionCapabilities.mockResolvedValue({ sessionId: "session", features: value });

beforeAll(() => initializeI18n("en-US"));
beforeEach(() => {
  for (const mock of Object.values(client)) mock.mockReset();
  claudeRequest.mockReset();
  createConversationClient.mockReset().mockReturnValue(client);
  client.access.mockResolvedValue({ status: "approved", bootId: "boot", csrfToken: "" });
  client.live.mockResolvedValue({ sessionId: "session", revision: 7, status: "idle" });
  client.sessionAction.mockResolvedValue({ accepted: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function open(session: ConversationSessionSummary, handlers = {}) {
  render(
    <AppDialogProvider>
      <SessionRowMenu session={session} {...handlers} />
    </AppDialogProvider>,
  );
  const trigger = screen.getByRole("button", { name: copy.rowMenu });
  expect(trigger).toHaveAccessibleDescription(session.title!);
  fireEvent.click(trigger);
}

describe("a session row's menu on the desktop", () => {
  it.each(["codex", "claude-code", "deepseek-harness"])(
    "keeps registered %s actions visible while the provider capability is unresolved",
    async (agent) => {
      const pending = deferred<{ features: Record<string, { available: boolean }> }>();
      client.sessionCapabilities.mockReturnValue(pending.promise);
      open(summary(agent), { sidebar: {} });
      const rename = screen.getByRole("menuitem", { name: copy.rename });
      expect(rename).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("menuitem", { name: `${copy.fork}…` })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await act(async () => pending.resolve({ features: { rename: { available: true } } }));
      expect(rename).not.toHaveAttribute("aria-disabled");
      fireEvent.keyDown(rename, { key: "r" });
      expect(screen.getByRole("dialog", { name: copy.rename })).toBeVisible();
    },
  );

  it("keeps registered management items disabled when the capability read fails", async () => {
    const pending = deferred<never>();
    client.sessionCapabilities.mockReturnValue(pending.promise);
    open(summary("codex"), { sidebar: {} });
    await act(async () => pending.reject(new Error("unavailable")));
    for (const name of [copy.rename, `${copy.fork}…`, copy.archive, copy.delete]) {
      expect(screen.getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true");
    }
  });

  it("opens the existing session actions for a supported fork without dispatching it", async () => {
    features({ fork: { available: true } });
    const onOpenFork = vi.fn();
    open(summary("codex"), { sidebar: { onOpenFork } });
    await act(async () => {
      await client.sessionCapabilities.mock.results.at(-1)?.value;
    });
    fireEvent.click(screen.getByRole("menuitem", { name: `${copy.fork}…` }));
    expect(onOpenFork).toHaveBeenCalledOnce();
    expect(client.sessionAction).not.toHaveBeenCalled();
  });

  describe("with a new desktop conversation client", () => {
    const request = vi.fn();

    beforeEach(async () => {
      const { createDesktopConversationClient } = await vi.importActual<
        typeof import("@/core/conversation-bridge")
      >("@/core/conversation-bridge");
      createConversationClient.mockImplementation(createDesktopConversationClient);
      request.mockReset();
      vi.stubGlobal("desktopConversation", { request });
    });

    it.each([
      [false, "Pin session"],
      [true, "Unpin session"],
    ] as const)("updates a DSH row (initially pinned: %s)", async (pinned, label) => {
      const onChanged = vi.fn();
      request
        .mockResolvedValueOnce({
          status: 200,
          body: { status: "approved", csrfToken: "desktop-local", protocolVersion: 2 },
        })
        .mockResolvedValueOnce({ status: 200, body: { pinned: !pinned } });
      open({ ...summary("dsh"), pinned, pinningAvailable: true }, { onChanged, pinOnly: true });

      fireEvent.click(screen.getByRole("menuitem", { name: label }));

      await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
      expect(request.mock.calls).toEqual([
        ["access", undefined],
        ["session-pin", { sessionId: "session", pinned: !pinned }],
      ]);
    });

    it.each([
      ["approved", 1],
      ["ended", 2],
    ] as const)("refuses to pin with access %s on protocol %s", async (status, protocolVersion) => {
      const onChanged = vi.fn();
      request.mockResolvedValue({
        status: 200,
        body: { status, csrfToken: "desktop-local", protocolVersion },
      });
      open(
        { ...summary("dsh"), pinned: false, pinningAvailable: true },
        { onChanged, pinOnly: true },
      );

      fireEvent.click(screen.getByRole("menuitem", { name: "Pin session" }));

      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(request).toHaveBeenCalledExactlyOnceWith("access", undefined);
      expect(onChanged).not.toHaveBeenCalled();
    });
  });

  it("pins sessions without requesting provider management capabilities for a pin-only row", async () => {
    const onChanged = vi.fn();
    client.setSessionPinned.mockResolvedValue({ pinned: true });
    open(
      { ...summary("opencode"), pinned: false, pinningAvailable: true },
      { onChanged, pinOnly: true },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin session" }));
    expect(client.setSessionPinned).toHaveBeenCalledExactlyOnceWith("session", true);
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(client.sessionCapabilities).not.toHaveBeenCalled();
  });

  it("unpins an existing pin and refreshes the same catalog", async () => {
    const onChanged = vi.fn();
    client.setSessionPinned.mockResolvedValue({ pinned: false });
    open(
      { ...summary("codex"), pinned: true, pinningAvailable: true },
      { onChanged, pinOnly: true },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin session" }));
    expect(client.setSessionPinned).toHaveBeenCalledExactlyOnceWith("session", false);
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });

  it("keeps old-host menus unchanged and cannot mutate a paired host's cached pin", () => {
    features({});
    open(summary("codex"));
    expect(screen.getByRole("menuitem", { name: copy.rename })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /pin session/i })).not.toBeInTheDocument();
    cleanup();
    open(
      { ...summary("codex"), pinned: false, pinningAvailable: true },
      { canPin: false, pinOnly: true },
    );
    const pin = screen.getByRole("menuitem", { name: "Pin session" });
    expect(pin).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(pin);
    expect(client.setSessionPinned).not.toHaveBeenCalled();
  });

  it("reports a failed pin and leaves the catalog unchanged", async () => {
    const onChanged = vi.fn();
    client.setSessionPinned.mockRejectedValue(new Error("provider unavailable"));
    open(
      { ...summary("codex"), pinned: false, pinningAvailable: true },
      { onChanged, pinOnly: true },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't change the session's pin status.",
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("keeps an unavailable pin action disabled on a host that advertises it", () => {
    features({});
    open({ ...summary("codex"), pinned: true, pinningAvailable: false });
    const unpin = screen.getByRole("menuitem", { name: "Unpin session" });
    expect(unpin).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(unpin);
    expect(client.setSessionPinned).not.toHaveBeenCalled();
  });

  it.each([
    ["devin", "antigravity"],
    ["antigravity", "devin"],
  ] as const)("offers %s as a lead with a %s Worker", async (leadAgent, workerAgent) => {
    features({});
    const session = { ...summary(leadAgent), id: "lead" };
    const sessions = [
      session,
      { ...summary(workerAgent), id: "worker", title: "ACP Worker" },
      { ...summary(workerAgent), id: "busy", title: "Assigned Worker" },
      { ...summary("unknown"), id: "unsupported", title: "Unsupported Worker" },
    ];
    claudeRequest.mockResolvedValue({
      capable: true,
      remaining: 2,
      candidates: [
        { sessionId: "worker", reason: null },
        { sessionId: "busy", reason: "session-is-a-worker" },
      ],
    });
    open(session, { sessions });
    const assignWorkers = await screen.findByRole("menuitem", { name: "Assign Workers" });
    await waitFor(() => expect(assignWorkers).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(assignWorkers);
    const worker = await screen.findByRole("button", { name: "ACP Worker" });
    expect(worker).toBeEnabled();
    expect(screen.getByRole("button", { name: "Assigned Worker" })).toBeDisabled();
    expect(claudeRequest).toHaveBeenCalledExactlyOnceWith({
      operation: "lead-assignment-options",
      sessionId: "lead",
      candidateIds: ["busy", "worker"],
    });
    fireEvent.click(worker);
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() =>
      expect(claudeRequest).toHaveBeenLastCalledWith({
        operation: "lead-assign-workers",
        sessionId: "lead",
        workers: ["worker"],
      }),
    );
  });

  it("keeps the registered assignment action disabled for an archived session", async () => {
    features({});
    open(summary("antigravity", true));
    const assign = await screen.findByRole("menuitem", { name: "Assign Workers" });
    expect(assign).toHaveAttribute("aria-disabled", "true");
    expect(assign).not.toHaveAttribute("title");
    fireEvent.click(assign);
    expect(claudeRequest).not.toHaveBeenCalled();
  });

  it("keeps assignment unavailable for a disabled Antigravity lead or Worker", async () => {
    client.sessionCapabilities.mockResolvedValue({
      sessionId: "session",
      reason: "antigravity-acp-disabled",
      features: {},
    });
    open(summary("antigravity"));
    const assignWorkers = screen.getByRole("menuitem", { name: "Assign Workers" });
    await act(async () => {});
    expect(assignWorkers).toHaveAttribute("aria-disabled", "true");
    expect(assignWorkers).not.toHaveAttribute("title");
    fireEvent.click(assignWorkers);
    expect(claudeRequest).not.toHaveBeenCalled();

    cleanup();
    features({});
    const lead = { ...summary("devin"), id: "lead" };
    claudeRequest.mockResolvedValue({
      capable: true,
      remaining: 1,
      candidates: [{ sessionId: "session", reason: "worker-agent-unsupported" }],
    });
    open(lead, { sessions: [lead, summary("antigravity")] });
    fireEvent.click(screen.getByRole("menuitem", { name: "Assign Workers" }));
    const worker = await screen.findByRole("button", { name: "Synthetic session" });
    expect(worker).toBeDisabled();
    fireEvent.click(worker);
    expect(screen.getByRole("button", { name: "Assign" })).toBeDisabled();
    expect(claudeRequest).toHaveBeenCalledTimes(1);
  });

  it("names an untitled session as its row does", () => {
    render(
      <AppDialogProvider>
        <SessionRowMenu session={{ ...summary("codex"), title: undefined }} />
      </AppDialogProvider>,
    );
    expect(screen.getByRole("button", { name: copy.rowMenu })).toHaveAccessibleDescription(
      "Untitled session",
    );
  });
  it("deletes only after the destructive confirmation, against the current revision", async () => {
    features({ rename: { available: true }, delete: { available: true } });
    const onDeleted = vi.fn();
    open(summary("codex"), { onDeleted });
    await act(async () => {
      await client.sessionCapabilities.mock.results.at(-1)?.value;
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: copy.delete }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(copy.deleteCodexDetail);
    expect(client.sessionAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: copy.deleteConfirm }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    expect(client.sessionAction).toHaveBeenCalledExactlyOnceWith(
      "delete",
      expect.objectContaining({ sessionId: "session", bootId: "boot", expectedRevision: 7 }),
      "codex",
    );
  });

  it("does nothing when the confirmation is cancelled", async () => {
    features({ delete: { available: true } });
    open(summary("claude-code"));
    await act(async () => {
      await client.sessionCapabilities.mock.results.at(-1)?.value;
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: copy.delete }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(copy.deleteClaudeDetail);
    fireEvent.click(screen.getByRole("button", { name: copy.cancel }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(client.sessionAction).not.toHaveBeenCalled();
  });

  it("offers archive for registered providers such as Codex", async () => {
    features({ rename: { available: true }, archive: { available: true } });
    const onChanged = vi.fn();
    open(summary("codex"), { onChanged });
    await act(async () => {
      await client.sessionCapabilities.mock.results.at(-1)?.value;
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: copy.archive }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(client.sessionAction).toHaveBeenCalledWith(
      "archive",
      expect.objectContaining({ sessionId: "session" }),
      "codex",
    );
    cleanup();
    features({ rename: { available: true }, delete: { available: true } });
    open(summary("claude-code"));
    await screen.findByRole("menuitem", { name: copy.delete });
    expect(screen.queryByRole("menuitem", { name: copy.archive })).not.toBeInTheDocument();
  });

  it("keeps the typed name in the rename dialog after failure and retries there", async () => {
    features({ rename: { available: true } });
    client.sessionAction.mockRejectedValueOnce(
      new ApiError(409, "follower-operation-unverified", "not-dispatched"),
    );
    const onChanged = vi.fn();
    open(summary("codex"), { onChanged });
    await act(async () => {
      await client.sessionCapabilities.mock.results.at(-1)?.value;
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: copy.rename }));
    const dialog = await screen.findByRole("dialog", { name: copy.rename });
    const input = within(dialog).getByRole("textbox", { name: copy.name });
    const save = within(dialog).getByRole("button", { name: copy.rename });
    fireEvent.change(input, { target: { value: "  Renamed  " } });
    fireEvent.click(save);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      sessionReason("en-US", "follower-operation-unverified").text,
    );
    expect(input).toHaveValue("  Renamed  ");
    expect(onChanged).not.toHaveBeenCalled();
    expect(client.sessionAction).toHaveBeenCalledExactlyOnceWith(
      "rename",
      expect.objectContaining({ name: "Renamed" }),
      "codex",
    );
    fireEvent.click(save);
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog", { name: copy.rename })).not.toBeInTheDocument();
  });

  it.each([
    ["codex", ["rename", "archive", "delete"]],
    ["claude-code", ["rename", "delete"]],
    ["deepseek-harness", ["rename", "archive"]],
  ] as const)("shows only disabled action labels for %s", (agent, actions) => {
    features(
      Object.fromEntries(
        actions.map((action) => [
          action,
          { available: false, reason: "follower-operation-unverified" },
        ]),
      ),
    );
    open(summary(agent));
    const items = actions.map((action) => screen.getByRole("menuitem", { name: copy[action] }));
    for (const item of items) {
      expect(item).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(item);
    }
    expect(screen.queryByText(copy.deleteOwnerBusy)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(client.sessionAction).not.toHaveBeenCalled();
  });

  it("keeps the destructive confirmation open on failure and retries there", async () => {
    features({ delete: { available: true } });
    client.sessionAction.mockRejectedValueOnce(
      new ApiError(409, "claude-desktop-session", "not-dispatched"),
    );
    const onDeleted = vi.fn();
    open(summary("claude-code"), { onDeleted });
    await act(async () => {
      await client.sessionCapabilities.mock.results.at(-1)?.value;
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: copy.delete }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: copy.deleteConfirm });
    fireEvent.click(confirm);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      sessionReason("en-US", "claude-desktop-session").text,
    );
    expect(onDeleted).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("is not offered for agents AgentKib does not manage", () => {
    render(
      <AppDialogProvider>
        <SessionRowMenu session={summary("opencode")} />
      </AppDialogProvider>,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("assigns existing Workers from the row and reveals disabled reasons only on hover", async () => {
    const user = userEvent.setup();
    const session = { ...summary("claude-code"), id: "lead" };
    const sessions = [
      session,
      { ...summary("codex"), id: "available", title: "Available Worker" },
      { ...summary("codex"), id: "coordinator", title: "Project coordinator" },
      { ...summary("deepseek-harness"), id: "occupied", title: "Existing Worker" },
      { ...summary("codex", true), id: "archived" },
      { ...summary("codex"), id: "sidechain", sidechain: true },
      { ...summary("codex"), id: "metadata-only", availability: "metadata-only" as const },
      {
        ...summary("codex"),
        id: "remote",
        remote: {
          host_id: "host",
          host_name: "Remote host",
          original_id: "remote",
          online: true,
          last_synced_at: "",
        },
      },
    ];
    claudeRequest
      .mockResolvedValueOnce({
        capable: true,
        remaining: 10,
        candidates: [
          { sessionId: "available", reason: null },
          { sessionId: "coordinator", reason: "session-is-a-project-agent" },
          { sessionId: "occupied", reason: "session-is-a-worker" },
          { sessionId: "missing", reason: "session-is-a-worker" },
        ],
      })
      .mockResolvedValueOnce({ lead: { sessionId: "lead" } });
    features({});
    const onChanged = vi.fn();
    open(session, { sessions, onChanged });
    await user.click(await screen.findByRole("menuitem", { name: "Assign Workers" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Assign Workers to “Synthetic session”",
    });
    const eligible = await within(dialog).findByRole("button", { name: "Available Worker" });
    const otherLead = within(dialog).getByRole("button", { name: "Project coordinator" });
    const existingWorker = within(dialog).getByRole("button", { name: "Existing Worker" });
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Untitled session")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Codex")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("DeepSeek Harness")).not.toBeInTheDocument();
    expect(within(dialog).getByText("10 Worker slots remaining")).toBeVisible();
    expect(otherLead).toBeDisabled();
    expect(existingWorker).toBeDisabled();
    expect(screen.queryByText("This session is already a Project Agent")).not.toBeInTheDocument();
    expect(screen.queryByText("Already assigned to another Project Agent")).not.toBeInTheDocument();
    expect(otherLead).toHaveAccessibleDescription("This session is already a Project Agent");
    await user.hover(within(dialog).getByText("Project coordinator"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    act(() => eligible.focus());
    await user.keyboard(" ");
    expect(eligible).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByText("9 Worker slots remaining")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Assign" }));
    expect(claudeRequest.mock.calls).toEqual([
      [
        {
          operation: "lead-assignment-options",
          sessionId: "lead",
          candidateIds: ["available", "coordinator", "occupied"],
        },
      ],
      [{ operation: "lead-assign-workers", sessionId: "lead", workers: ["available"] }],
    ]);
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });

  it.each([
    [
      "lead-claude-terminal-disconnected",
      "This terminal session is disconnected from AgentKib. Open Connect Terminal.",
    ],
    ["delegation-paused", "This session cannot coordinate Workers right now."],
    [undefined, "This session cannot coordinate Workers right now."],
  ])(
    "shows the relevant disabled reason for %s and opens the connection panel only when applicable",
    async (reason, tooltip) => {
      const user = userEvent.setup();
      const session = { ...summary("claude-code"), id: "lead" };
      const sessions = [
        session,
        { ...summary("codex"), id: "available", title: "Available Worker" },
        { ...summary("codex"), id: "coordinator", title: "Project coordinator" },
      ];
      claudeRequest.mockResolvedValueOnce({
        capable: false,
        remaining: 0,
        reason,
        candidates: [
          { sessionId: "available", reason: null },
          { sessionId: "coordinator", reason: "session-is-a-project-agent" },
        ],
      });
      const onConnectTerminal = vi.fn();
      features({});
      open(session, { sessions, onConnectTerminal });
      await user.click(await screen.findByRole("menuitem", { name: "Assign Workers" }));
      const dialog = await screen.findByRole("dialog");
      const candidate = await within(dialog).findByRole("button", { name: "Available Worker" });
      expect(candidate).toBeDisabled();
      expect(candidate).toHaveAccessibleDescription(tooltip);
      expect(within(dialog).getByRole("button", { name: "Assign" })).toBeDisabled();
      expect(
        await within(dialog).findByRole("button", { name: "Project coordinator" }),
      ).toHaveAccessibleDescription("This session is already a Project Agent");
      await user.hover(within(dialog).getByText("Available Worker"));
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      const connect = within(dialog).queryByRole("button", {
        name: /^Connect terminal$/i,
      });
      if (reason === "lead-claude-terminal-disconnected") {
        expect(connect).toBeEnabled();
        await user.click(connect!);
        expect(onConnectTerminal).toHaveBeenCalledOnce();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      } else {
        expect(connect).not.toBeInTheDocument();
        expect(onConnectTerminal).not.toHaveBeenCalled();
      }
    },
  );

  it("requests eligibility once in Strict Mode and uses updated directory titles locally", async () => {
    const user = userEvent.setup();
    const session = { ...summary("codex"), id: "lead" };
    const worker = { ...summary("codex"), id: "worker", title: "Original title" };
    claudeRequest.mockImplementation(async ({ candidateIds }: { candidateIds: string[] }) => ({
      capable: true,
      remaining: 10,
      candidates: candidateIds.map((sessionId) => ({ sessionId, reason: null })),
    }));
    const content = (sessions: ConversationSessionSummary[]) => (
      <StrictMode>
        <AppDialogProvider>
          <SessionWorkerAssignmentDialog session={session} sessions={sessions} onClose={() => {}} />
        </AppDialogProvider>
      </StrictMode>
    );
    const { rerender } = render(content([session, worker]));
    await user.click(await screen.findByRole("button", { name: "Original title" }));
    rerender(content([{ ...worker, title: "Updated title" }, session]));
    expect(screen.getByRole("button", { name: "Updated title" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(claudeRequest).toHaveBeenCalledTimes(1);
    rerender(content([session]));
    expect(screen.getByRole("button", { name: "Assign" })).toBeDisabled();
    expect(await screen.findByText("There are no other sessions in this project.")).toBeVisible();
    expect(claudeRequest).toHaveBeenLastCalledWith({
      operation: "lead-assignment-options",
      sessionId: "lead",
      candidateIds: [],
    });
  });

  it("shows known candidates and footer before assignment eligibility returns", async () => {
    const close = vi.fn();
    type Options = {
      capable: boolean;
      remaining: number;
      candidates: { sessionId: string; reason: null }[];
    };
    let resolve!: (options: Options) => void;
    claudeRequest.mockReturnValue(new Promise<Options>((done) => (resolve = done)));
    const session = { ...summary("claude-code"), id: "lead" };
    const worker = { ...summary("codex"), id: "worker", title: "Ready Worker" };
    render(
      <AppDialogProvider>
        <SessionWorkerAssignmentDialog session={session} sessions={[worker]} onClose={close} />
      </AppDialogProvider>,
    );
    const dialog = within(screen.getByRole("dialog"));
    const row = dialog.getByRole("button", { name: worker.title });
    const assign = dialog.getByRole("button", { name: "Assign" });
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    expect(row).toBeDisabled();
    expect(assign).toBeDisabled();
    expect(cancel).toBeEnabled();
    expect(dialog.queryByText("Loading…")).not.toBeInTheDocument();
    await act(async () => {
      resolve({
        capable: true,
        remaining: 1,
        candidates: [{ sessionId: worker.id, reason: null }],
      });
    });
    expect(dialog.getByRole("button", { name: worker.title })).toBe(row);
    expect(row).toBeEnabled();
    fireEvent.click(row);
    expect(assign).toBeEnabled();
  });

  it("keeps the assigned alias for removal and offers the canonical Worker after it", async () => {
    const user = userEvent.setup();
    const session = { ...summary("codex"), id: "lead" };
    const sessions = [
      session,
      { ...summary("codex"), id: "worker", title: "My Worker", indexedSessionIds: ["indexed"] },
    ];
    claudeRequest
      .mockResolvedValueOnce({
        capable: true,
        remaining: 0,
        candidates: [
          { sessionId: "worker", reason: null },
          { sessionId: "indexed", reason: "session-is-a-worker", assigned: true },
        ],
      })
      .mockResolvedValueOnce({ lead: { sessionId: "lead" } })
      .mockResolvedValueOnce({
        capable: true,
        remaining: 1,
        candidates: [{ sessionId: "worker", reason: null }],
      });
    features({});
    const onChanged = vi.fn();
    open(session, { sessions, onChanged });
    await user.click(await screen.findByRole("menuitem", { name: "Assign Workers" }));
    const assigned = await screen.findByRole("button", { name: "My Worker", pressed: true });
    expect(assigned).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(claudeRequest).toHaveBeenCalledExactlyOnceWith({
      operation: "lead-assignment-options",
      sessionId: "lead",
      candidateIds: ["indexed", "worker"],
    });
    await user.click(assigned);
    const canceled = await screen.findByRole("alertdialog");
    await user.click(within(canceled).getByRole("button", { name: "Cancel" }));
    expect(claudeRequest).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "My Worker", pressed: true }));
    const confirmation = await screen.findByRole("alertdialog");
    await user.click(within(confirmation).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(claudeRequest).toHaveBeenCalledWith({
      operation: "lead-worker-remove",
      sessionId: "lead",
      worker: "indexed",
    });
    expect(await screen.findByRole("button", { name: "My Worker", pressed: false })).toBeEnabled();
  });
});
