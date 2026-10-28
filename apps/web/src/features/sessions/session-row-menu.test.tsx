import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSessionSummary } from "@agentkib/web-client";
import { SessionRowMenu } from "@/features/conversation/features/catalog/session-row-menu";
import { SessionCatalog } from "@/features/conversation/features/catalog/session-catalog";
import { useSession } from "@/features/conversation/features/sessions/session-context";
import { codexCopyForSurface } from "@/features/conversation/features/sessions/codex-copy";

vi.mock("@/features/conversation/features/sessions/session-context", () => ({
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

  it("keeps a Claude session without an archive item", async () => {
    features({ rename: { available: true }, delete: { available: true } });
    render(<SessionRowMenu session={summary("claude-code")} />);
    openMenu();
    await screen.findByRole("menuitem", { name: copy.delete });
    expect(screen.queryByRole("menuitem", { name: copy.archive })).not.toBeInTheDocument();
  });

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
