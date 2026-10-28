// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@agentkib/web-client";
import { initializeI18n } from "@/core/i18n";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import type { ConversationSessionSummary } from "@/core/types";
import { codexCopy, codexReason } from "./conversation/features/sessions/codex-copy";
import { SessionRowMenu } from "./SessionRowMenu";

const { client } = vi.hoisted(() => ({
  client: {
    sessionCapabilities: vi.fn(),
    access: vi.fn(),
    live: vi.fn(),
    sessionAction: vi.fn(),
  },
}));
vi.mock("@/core/conversation-bridge", () => ({
  createDesktopConversationClient: () => client,
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
});
