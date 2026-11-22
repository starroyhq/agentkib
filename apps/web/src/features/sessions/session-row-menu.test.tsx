import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ConversationSessionSummary } from "@agentkib/web-client";
import { SessionRowMenu } from "@/features/conversation/features/catalog/session-row-menu";
import { SessionCatalog } from "@/features/conversation/features/catalog/session-catalog";
import { useSession } from "@/features/conversation/web-session-context";
import { codexCopyForSurface, codexReason } from "@/features/conversation/codex-copy";

vi.mock("@/features/conversation/web-session-context", () => ({
  useSession: vi.fn(),
}));
const copy = codexCopyForSurface("en-US", "web");
const client = {
  sessionCapabilities: vi.fn(),
  access: vi.fn(),
  live: vi.fn(),
  sessionAction: vi.fn(),
};
const context = { client, locale: "en-US", refresh: vi.fn(), dropDeletedSession: vi.fn() };
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
beforeEach(() => {
  for (const mock of [...Object.values(client), context.refresh, context.dropDeletedSession])
    mock.mockReset();
  client.access.mockResolvedValue({ status: "approved", bootId: "boot", csrfToken: "" });
  client.live.mockResolvedValue({ sessionId: "session", revision: 3, status: "idle" });
  client.sessionAction.mockResolvedValue({ accepted: true });
  vi.mocked(useSession).mockReturnValue(context as unknown as ReturnType<typeof useSession>);
});
afterEach(cleanup);
const openMenu = () => fireEvent.click(screen.getByRole("button", { name: copy.rowMenu }));

describe("a session row's menu in the browser", () => {
  it("names an untitled session as its row does", () => {
    render(<SessionRowMenu session={{ ...summary("codex"), title: undefined }} />);
    expect(screen.getByRole("button", { name: copy.rowMenu })).toHaveAttribute(
      "title",
      "Untitled session",
    );
  });
  it("deletes after confirming and drops the row at once", async () => {
    features({ delete: { available: true } });
    render(<SessionRowMenu session={summary("codex")} />);
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: copy.delete }));
    expect(await screen.findByRole("dialog", { name: copy.deleteTitle })).toHaveTextContent(
      copy.deleteCodexDetail,
    );
    expect(client.sessionAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: copy.deleteConfirm }));
    await waitFor(() => expect(context.dropDeletedSession).toHaveBeenCalledWith("session"));
    expect(client.sessionAction).toHaveBeenCalledExactlyOnceWith(
      "delete",
      expect.objectContaining({ sessionId: "session", bootId: "boot", expectedRevision: 3 }),
      "codex",
    );
  });

  it.each([
    {
      action: "rename",
      title: copy.rename,
      confirmLabel: copy.rename,
      menuLabel: copy.rename,
      code: "follower-operation-unverified",
      message: codexReason("en-US", "follower-operation-unverified", "web").text,
    },
    {
      action: "delete",
      title: copy.deleteTitle,
      confirmLabel: copy.deleteConfirm,
      menuLabel: copy.delete,
      code: "codex-owner-busy",
      message: copy.deleteOwnerBusy,
    },
  ])("keeps the $action dialog open on failure and retries there", async (scenario) => {
    features({ [scenario.action]: { available: true } });
    client.sessionAction.mockRejectedValueOnce(new ApiError(409, scenario.code, "not-dispatched"));
    render(<SessionRowMenu session={summary("codex")} />);
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: scenario.menuLabel }));
    const dialog = await screen.findByRole("dialog", { name: scenario.title });
    const submit = within(dialog).getByRole("button", { name: scenario.confirmLabel });
    fireEvent.click(submit);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(scenario.message);
    expect(context.refresh).not.toHaveBeenCalled();
    expect(context.dropDeletedSession).not.toHaveBeenCalled();

    fireEvent.click(submit);
    expect(submit).toBeDisabled();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(submit);
    await waitFor(() => expect(context.refresh).toHaveBeenCalledExactlyOnceWith(true));
    expect(client.sessionAction).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog", { name: scenario.title })).not.toBeInTheDocument();
  });

  it("keeps a Claude session without an archive item", async () => {
    features({ rename: { available: true }, delete: { available: true } });
    render(<SessionRowMenu session={summary("claude-code")} />);
    openMenu();
    await screen.findByRole("menuitem", { name: copy.delete });
    expect(screen.queryByRole("menuitem", { name: copy.archive })).not.toBeInTheDocument();
  });

  it.each([
    {
      agent: "codex",
      reason: "follower-operation-unverified",
      deleteReason: "codex-owner-busy",
      deleteCopy: copy.deleteOwnerBusy,
    },
    {
      agent: "claude-code",
      reason: "claude-desktop-session",
      deleteReason: "claude-owner-busy",
      deleteCopy: copy.deleteClaudeOwnerBusy,
    },
  ])(
    "shows unavailable $agent actions as disabled labels",
    async ({ agent, reason, deleteReason, deleteCopy }) => {
      const unavailable = { available: false, reason };
      const supportsArchive = agent === "codex";
      features({
        rename: unavailable,
        ...(supportsArchive ? { archive: unavailable } : {}),
        delete: { available: false, reason: deleteReason },
      });
      render(<SessionRowMenu session={summary(agent)} />);
      openMenu();
      await screen.findByRole("menuitem", { name: copy.delete });
      for (const name of [copy.rename, ...(supportsArchive ? [copy.archive] : []), copy.delete]) {
        const item = screen.getByRole("menuitem", { name });
        expect(item).toHaveAttribute("aria-disabled", "true");
        fireEvent.click(item);
      }
      expect(screen.queryByText(codexReason("en-US", reason, "web").text)).not.toBeInTheDocument();
      expect(screen.queryByText(deleteCopy)).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(client.sessionAction).not.toHaveBeenCalled();
    },
  );

  it("is rendered beside the row, never inside its button", () => {
    render(
      <SessionCatalog
        sessions={[summary("codex")]}
        workspaces={[{ id: "workspace", name: "Workspace", path: "/synthetic" }]}
        selected=""
        onSelect={vi.fn()}
        locale="en-US"
        rowMenu={(row) => <SessionRowMenu session={row} />}
      />,
    );
    const menu = screen.getByRole("button", { name: copy.rowMenu });
    expect(menu).toHaveAccessibleDescription("Synthetic session");
    // A button inside the row's button would be invalid and unreachable.
    expect(menu.parentElement?.closest("button")).toBeNull();
    expect(menu.parentElement?.querySelectorAll(":scope > button")).toHaveLength(2);
  });
});
