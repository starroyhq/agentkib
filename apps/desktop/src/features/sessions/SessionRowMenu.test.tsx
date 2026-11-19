// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@agentkib/web-client";
import { initializeI18n } from "@/core/i18n";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import type { ConversationSessionSummary } from "@/core/types";
import { codexCopy, codexReason } from "./conversation/features/sessions/codex-copy";
import { SessionRowMenu } from "./SessionRowMenu";

const { client, claudeRequest } = vi.hoisted(() => ({
  client: {
    sessionCapabilities: vi.fn(),
    access: vi.fn(),
    live: vi.fn(),
    sessionAction: vi.fn(),
  },
  claudeRequest: vi.fn(),
}));
vi.mock("@/core/conversation-bridge", () => ({
  createDesktopConversationClient: () => client,
}));
vi.mock("@/core/desktop", () => ({
  desktopApi: () => ({ claude: { request: claudeRequest } }),
}));
const copy = codexCopy["en-US"];
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
  client.access.mockResolvedValue({ status: "approved", bootId: "boot", csrfToken: "" });
  client.live.mockResolvedValue({ sessionId: "session", revision: 7, status: "idle" });
  client.sessionAction.mockResolvedValue({ accepted: true });
});
afterEach(cleanup);

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
    fireEvent.click(await screen.findByRole("menuitem", { name: copy.delete }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(copy.deleteClaudeDetail);
    fireEvent.click(screen.getByRole("button", { name: copy.cancel }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(client.sessionAction).not.toHaveBeenCalled();
  });

  it("offers archive only where the host reports it, as for Codex", async () => {
    features({ rename: { available: true }, archive: { available: true } });
    const onChanged = vi.fn();
    open(summary("codex"), { onChanged });
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

  it("renames with the typed name", async () => {
    features({ rename: { available: true } });
    open(summary("codex"));
    fireEvent.click(await screen.findByRole("menuitem", { name: copy.rename }));
    const input = await screen.findByRole("textbox", { name: copy.name });
    fireEvent.change(input, { target: { value: "  Renamed  " } });
    fireEvent.click(screen.getByRole("button", { name: copy.rename }));
    await waitFor(() =>
      expect(client.sessionAction).toHaveBeenCalledWith(
        "rename",
        expect.objectContaining({ name: "Renamed" }),
        "codex",
      ),
    );
  });

  it("explains an unavailable delete and a refused one", async () => {
    features({ delete: { available: false, reason: "codex-owner-busy" } });
    open(summary("codex"));
    expect(await screen.findByText(copy.deleteOwnerBusy)).toBeVisible();
    expect(screen.getByRole("menuitem", { name: new RegExp(copy.delete) })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    cleanup();
    features({ delete: { available: true } });
    client.sessionAction.mockRejectedValue(
      new ApiError(409, "claude-desktop-session", "not-dispatched"),
    );
    open(summary("claude-code"));
    fireEvent.click(await screen.findByRole("menuitem", { name: copy.delete }));
    fireEvent.click(await screen.findByRole("button", { name: copy.deleteConfirm }));
    expect(
      await screen.findByText(codexReason("en-US", "claude-desktop-session").text),
    ).toBeVisible();
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
    ];
    claudeRequest
      .mockResolvedValueOnce({
        capable: true,
        remaining: 1,
        candidates: [
          { sessionId: "available", reason: null },
          { sessionId: "coordinator", reason: "session-is-a-project-agent" },
          { sessionId: "occupied", reason: "session-is-a-worker" },
        ],
      })
      .mockResolvedValueOnce({ lead: { sessionId: "lead" } });
    features({});
    const onChanged = vi.fn();
    open(session, { sessions, onChanged });
    await user.click(await screen.findByRole("menuitem", { name: "Assign Workers…" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Assign Workers to “Synthetic session”",
    });
    const eligible = await within(dialog).findByRole("checkbox", { name: "Available Worker" });
    const otherLead = within(dialog).getByRole("checkbox", { name: "Project coordinator" });
    const existingWorker = within(dialog).getByRole("checkbox", { name: "Existing Worker" });
    expect(otherLead).toBeDisabled();
    expect(existingWorker).toBeDisabled();
    expect(screen.queryByText("This session is already a Project Agent")).not.toBeInTheDocument();
    expect(screen.queryByText("Already assigned to another Project Agent")).not.toBeInTheDocument();
    const disabledRow = within(dialog).getByRole("group", { name: "Project coordinator" });
    act(() => disabledRow.focus());
    expect(disabledRow).toHaveFocus();
    expect(disabledRow).toHaveAccessibleDescription("This session is already a Project Agent");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(within(dialog).getByText("Project coordinator"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "This session is already a Project Agent",
    );
    await user.click(eligible);
    await user.click(within(dialog).getByRole("button", { name: "Assign" }));
    expect(claudeRequest.mock.calls).toEqual([
      [{ operation: "lead-assignment-options", sessionId: "lead" }],
      [{ operation: "lead-assign-workers", sessionId: "lead", workers: ["available"] }],
    ]);
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });

  it("allows an assigned Worker to be removed from the same dialog", async () => {
    const user = userEvent.setup();
    const session = { ...summary("codex"), id: "lead" };
    const sessions = [session, { ...summary("codex"), id: "worker", title: "My Worker" }];
    claudeRequest
      .mockResolvedValueOnce({
        capable: true,
        remaining: 0,
        candidates: [{ sessionId: "worker", reason: "session-is-a-worker", assigned: true }],
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
    await user.click(await screen.findByRole("menuitem", { name: "Assign Workers…" }));
    const remove = await screen.findByRole("button", { name: "Remove" });
    expect(screen.getByRole("checkbox", { name: "My Worker" })).toBeDisabled();
    await user.click(remove);
    const confirmation = await screen.findByRole("alertdialog");
    await user.click(within(confirmation).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(claudeRequest).toHaveBeenCalledWith({
      operation: "lead-worker-remove",
      sessionId: "lead",
      worker: "worker",
    });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "My Worker" })).toBeEnabled());
  });
});
