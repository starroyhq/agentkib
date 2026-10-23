// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSessionSummary } from "@/core/types";
import {
  normalizeDirectoryOrder,
  normalizeSessionDirectoryOrder,
  prepareSessionNavigation,
  useSessionViewStore,
} from "./session-view-store";

const source: ConversationSessionSummary = {
  id: "source",
  workspace_id: "workspace",
  agent: "codex",
  title: "Source",
  archived: false,
  sidechain: false,
  availability: "readable",
};
const auxiliary: ConversationSessionSummary = {
  ...source,
  id: "auxiliary",
  title: "Auxiliary",
  origin: "auxiliary",
  spawned_by_session_id: source.id,
};

describe("session view source visibility", () => {
  beforeEach(() => {
    localStorage.removeItem("agentkib.session-directory-order");
    useSessionViewStore.setState({
      agent: "all",
      host: "all",
      filter: "current",
      collapsed: { workspace: true },
      scrollTop: 0,
    });
  });

  it("keeps newly discovered sessions ahead of manually ordered sessions", () => {
    expect(normalizeSessionDirectoryOrder(["saved"], ["new", "saved"])).toEqual(["new", "saved"]);
  });

  it.each(["auxiliary", "execution"] as const)("does not reveal a targeted %s record", (origin) => {
    useSessionViewStore.setState({ agent: "claude-code", filter: "archived" });
    const before = useSessionViewStore.getState();
    useSessionViewStore.getState().revealSession({ ...auxiliary, origin });
    expect(useSessionViewStore.getState()).toBe(before);
  });

  it("retains ordinary sidechain conversations and expands their workspace", () => {
    useSessionViewStore.getState().revealSession({ ...source, sidechain: true });
    expect(useSessionViewStore.getState().collapsed).toEqual({ workspace: false });
  });

  it("makes a deep link visible through conflicting filters and exits conversation creation", () => {
    useSessionViewStore.setState({
      agent: "claude-code",
      host: "other-computer",
      filter: "archived",
      creatingConversation: true,
    });
    prepareSessionNavigation(source);
    expect(useSessionViewStore.getState()).toMatchObject({
      agent: "all",
      host: "all",
      filter: "all",
      creatingConversation: false,
      collapsed: { workspace: false },
    });
  });

  it("preserves filters that already include a deep-linked session", () => {
    useSessionViewStore.setState({
      agent: "codex",
      host: "local",
      filter: "current",
      creatingConversation: true,
    });
    prepareSessionNavigation(source);
    expect(useSessionViewStore.getState()).toMatchObject({
      agent: "codex",
      host: "local",
      filter: "current",
      creatingConversation: false,
    });
  });

  it("restores saved order and removes stale or duplicate IDs on its next write", async () => {
    localStorage.setItem(
      "agentkib.session-directory-order",
      JSON.stringify({
        workspaceOrder: ["deleted-workspace", "workspace-b", "workspace-b"],
        sessionOrder: { workspace: ["deleted-session", "saved-session", "saved-session"] },
      }),
    );
    vi.resetModules();
    const { useSessionViewStore: restoredView } = await import("./session-view-store");
    expect(restoredView.getState().workspaceOrder).toEqual([
      "deleted-workspace",
      "workspace-b",
      "workspace-b",
    ]);
    expect(restoredView.getState().sessionOrder.workspace).toEqual([
      "deleted-session",
      "saved-session",
      "saved-session",
    ]);

    restoredView
      .getState()
      .setWorkspaceOrder(
        normalizeDirectoryOrder(restoredView.getState().workspaceOrder, [
          "workspace-a",
          "workspace-b",
        ]),
      );
    restoredView
      .getState()
      .setSessionOrder(
        "workspace",
        normalizeDirectoryOrder(restoredView.getState().sessionOrder.workspace, [
          "saved-session",
          "new-session",
        ]),
      );

    expect(JSON.parse(localStorage.getItem("agentkib.session-directory-order") ?? "{}")).toEqual({
      workspaceOrder: ["workspace-b", "workspace-a"],
      sessionOrder: { workspace: ["saved-session", "new-session"] },
    });
  });
  it("keeps a requested terminal panel in memory and never clears a newer destination from a stale consumer", () => {
    const view = useSessionViewStore.getState();
    view.requestPanel("first", "terminal");
    const first = useSessionViewStore.getState().requestedPanel!;
    view.requestPanel("second", "terminal");
    const second = useSessionViewStore.getState().requestedPanel!;
    view.consumePanel(first);
    expect(useSessionViewStore.getState().requestedPanel).toBe(second);
    view.consumePanel(second);
    expect(useSessionViewStore.getState().requestedPanel).toBeUndefined();
    expect(localStorage.getItem("agentkib.session-directory-order") ?? "").not.toContain(
      "terminal",
    );
  });
  it("keeps terminal menu eligibility in memory and ignores an older owner's cleanup", () => {
    const first = { sessionId: "same-session", open: vi.fn() };
    const second = { sessionId: "same-session", open: vi.fn() };
    const view = useSessionViewStore.getState();
    view.registerTerminalEntry(first);
    view.registerTerminalEntry(second);
    view.unregisterTerminalEntry(first);
    expect(useSessionViewStore.getState().terminalEntry).toBe(second);
    useSessionViewStore.getState().terminalEntry?.open();
    expect(second.open).toHaveBeenCalledOnce();
    expect(first.open).not.toHaveBeenCalled();
    view.unregisterTerminalEntry(second);
    expect(useSessionViewStore.getState().terminalEntry).toBeUndefined();
    expect(localStorage.getItem("agentkib.session-directory-order") ?? "").not.toContain(
      "terminal",
    );
  });
});
