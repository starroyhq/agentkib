// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSessionSummary, RuntimeInfo } from "@/core/types";
import { SESSION_COLLECTIONS } from "@agentkib/runtime-protocol";
import { useAppStore } from "@/stores/app-store";
import { useSessionViewStore } from "./session-view-store";
import { SessionHubProvider, useSessionHub } from "./SessionHubContext";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  bridge: true,
  indexed: [] as ConversationSessionSummary[],
  controlled: [] as ConversationSessionSummary[],
  controlledReady: true,
  controlledError: undefined as unknown,
  codexRuntimeReason: undefined as "codex-cli-version-too-old" | null | undefined,
  search: {} as { sessionId?: string },
  workspaces: [{ id: "workspace", name: "Project", path: "/project" }],
  remote: { hosts: [], sessions: [], workspaces: [], errors: {} },
  refresh: vi.fn(),
  refreshControlled: vi.fn(),
}));
vi.mock("@/core/useI18n", () => ({
  useI18n: () => ({ tr: String, localizeMessage: String, locale: "zh-CN" }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.search,
}));
vi.mock("@/features/home/home-query", () => ({
  useHomeWorkspaces: () => ({ data: mocks.workspaces, isPending: false, refetch: mocks.refresh }),
}));
vi.mock("@/core/conversation-bridge", () => ({ hasDesktopConversation: () => mocks.bridge }));
vi.mock("./useSessionCatalog", () => ({
  useSessionCatalog: (
    _workspaces: unknown,
    _enabled: boolean,
    afterRefresh?: () => Promise<unknown>,
  ) => ({
    sessions: mocks.indexed,
    ready: true,
    refreshing: false,
    errors: {},
    statuses: [],
    refresh: async () => {
      await mocks.refresh();
      await afterRefresh?.();
    },
  }),
}));
vi.mock("./conversation-catalog", () => ({
  useConversationCatalog: () => ({
    sessions: mocks.controlled,
    ready: mocks.controlledReady,
    error: mocks.controlledError,
    codexRuntimeReason: mocks.codexRuntimeReason,
  }),
  refreshConversationCatalog: mocks.refreshControlled,
}));
vi.mock("@/features/remote/remote-catalog-store", () => ({
  useRemoteCatalogEntries: () => mocks.remote,
  refreshRemoteCatalog: mocks.refresh,
}));

function Directory() {
  const hub = useSessionHub();
  return (
    <>
      {hub.catalogError && <p role="alert">{hub.catalogError}</p>}
      {hub.hiddenSessionNotice && <p>Hidden record notice</p>}
      <button onClick={() => void hub.refresh()}>Refresh</button>
      <output>{hub.selected?.id ?? "none"}</output>
      {hub.sessions.map((session) => (
        <button
          key={session.id}
          data-runtime-reason={session.continuation?.reason ?? undefined}
          onClick={() => hub.select(session.id)}
        >
          {session.id}
        </button>
      ))}
    </>
  );
}
const session = (id: string): ConversationSessionSummary => ({
  id,
  workspace_id: "workspace",
  agent: "codex",
  title: "Same native thread",
  availability: "readable",
  archived: false,
  sidechain: false,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.refresh.mockResolvedValue(undefined);
  mocks.refreshControlled.mockResolvedValue([]);
  mocks.bridge = true;
  mocks.indexed = [session("indexed-alias"), session("unmanaged")];
  mocks.controlled = [session("managed-id"), session("unmanaged")];
  mocks.controlledReady = true;
  mocks.controlledError = undefined;
  mocks.codexRuntimeReason = undefined;
  mocks.search = {};
  useAppStore.getState().setRuntime({ session_index_enabled: true } as RuntimeInfo);
  useSessionViewStore.getState().resetFilters();
  useSessionViewStore.getState().setCreatingConversation(false);
});
afterEach(cleanup);

describe("desktop authoritative session directory", () => {
  it("finishes creation when selecting the already committed conversation", () => {
    mocks.search = { sessionId: "managed-id" };
    useSessionViewStore.getState().setCreatingConversation(true);
    render(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "managed-id" }));
    expect(useSessionViewStore.getState().creatingConversation).toBe(false);
  });

  it("waits for the latest selected creation target to commit", () => {
    useSessionViewStore.getState().setCreatingConversation(true);
    const content = (
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>
    );
    const view = render(content);
    fireEvent.click(screen.getByRole("button", { name: "managed-id" }));
    fireEvent.click(screen.getByRole("button", { name: "unmanaged" }));
    mocks.search = { sessionId: "managed-id" };
    view.rerender(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    expect(useSessionViewStore.getState().creatingConversation).toBe(true);
    mocks.search = { sessionId: "unmanaged" };
    view.rerender(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    expect(useSessionViewStore.getState().creatingConversation).toBe(false);
  });

  it("does not finish a later creation from a cancelled selection", () => {
    useSessionViewStore.getState().setCreatingConversation(true);
    const view = render(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "managed-id" }));
    act(() => useSessionViewStore.getState().setCreatingConversation(false));
    act(() => useSessionViewStore.getState().setCreatingConversation(true));
    mocks.search = { sessionId: "managed-id" };
    view.rerender(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    expect(useSessionViewStore.getState().creatingConversation).toBe(true);
  });

  it("preserves a new creation when its entry clears an older pending selection", () => {
    function NewCreation() {
      const hub = useSessionHub();
      return (
        <button
          onClick={() => {
            useSessionViewStore.getState().setCreatingConversation(true);
            hub.select();
          }}
        >
          Begin another creation
        </button>
      );
    }
    useSessionViewStore.getState().setCreatingConversation(true);
    const content = (
      <SessionHubProvider>
        <Directory />
        <NewCreation />
      </SessionHubProvider>
    );
    const view = render(content);
    fireEvent.click(screen.getByRole("button", { name: "managed-id" }));
    fireEvent.click(screen.getByRole("button", { name: "Begin another creation" }));
    mocks.search = { sessionId: "managed-id" };
    view.rerender(
      <SessionHubProvider>
        <Directory />
        <NewCreation />
      </SessionHubProvider>,
    );
    expect(useSessionViewStore.getState().creatingConversation).toBe(true);
  });

  it.each(
    Object.values(SESSION_COLLECTIONS).flatMap((workspaceId) =>
      [true, false].map((bridge) => ({ workspaceId, bridge })),
    ),
  )(
    "keeps ordinary collection conversations visible and excludes internal records (collection: $workspaceId, bridge: $bridge)",
    ({ workspaceId, bridge }) => {
      useSessionViewStore.getState().setCollections(true);
      mocks.bridge = bridge;
      mocks.search = { sessionId: "ordinary" };
      const records: ConversationSessionSummary[] = [
        { ...session("ordinary"), workspace_id: workspaceId, origin: "interactive" },
        { ...session("execution"), workspace_id: workspaceId, origin: "execution" },
        { ...session("auxiliary"), workspace_id: workspaceId, origin: "auxiliary" },
      ];
      mocks.indexed = [...records, session("indexed-workspace")];
      mocks.controlled = [session("managed-id")];
      const view = render(
        <SessionHubProvider>
          <Directory />
        </SessionHubProvider>,
      );
      expect(screen.getByRole("status").textContent).toBe("ordinary");
      expect(screen.getByRole("button", { name: "ordinary" })).toBeTruthy();
      if (bridge) {
        expect(screen.getByRole("button", { name: "managed-id" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "indexed-workspace" })).toBeNull();
      }
      expect(screen.queryByRole("button", { name: "execution" })).toBeNull();
      expect(screen.queryByRole("button", { name: "auxiliary" })).toBeNull();
      expect(mocks.navigate).not.toHaveBeenCalled();
      mocks.search = { sessionId: "execution" };
      view.rerender(
        <SessionHubProvider>
          <Directory />
        </SessionHubProvider>,
      );
      expect(screen.getByText("Hidden record notice")).toBeTruthy();
      expect(mocks.navigate).toHaveBeenCalledOnce();
      expect(mocks.navigate.mock.calls[0][0].search(mocks.search)).toEqual({
        sessionId: undefined,
      });
    },
  );

  it("hides conversation-only collection sessions until their option is enabled", () => {
    mocks.indexed = [
      {
        ...session("rootless"),
        workspace_id: SESSION_COLLECTIONS.unclassified,
        origin: "interactive",
      },
      session("indexed-workspace"),
    ];
    mocks.controlled = [session("managed-id")];
    const view = render(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    expect(screen.queryByRole("button", { name: "rootless" })).toBeNull();
    act(() => useSessionViewStore.getState().setCollections(true));
    view.rerender(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    expect(screen.getByRole("button", { name: "rootless" })).toBeTruthy();
  });

  it("prefers the controlled catalog on a duplicate collection identity", () => {
    const ordinary = { ...session("ordinary"), workspace_id: SESSION_COLLECTIONS.projectless };
    mocks.indexed = [ordinary];
    mocks.controlled = [{ ...ordinary, origin: "execution" }];
    mocks.search = { sessionId: ordinary.id };
    render(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    expect(screen.queryByRole("button", { name: ordinary.id })).toBeNull();
    expect(screen.getByText("Hidden record notice")).toBeTruthy();
  });

  it("hides only proven native aliases across Codex collections", () => {
    useSessionViewStore.getState().setCollections(true);
    mocks.indexed = [
      { ...session("proven-native"), workspace_id: SESSION_COLLECTIONS.projectless },
      { ...session("unproven-native"), workspace_id: SESSION_COLLECTIONS.unclassified },
    ];
    mocks.controlled = [{ ...session("managed-id"), indexedSessionIds: ["proven-native"] }];
    render(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    expect(screen.queryByRole("button", { name: "proven-native" })).toBeNull();
    expect(screen.getByRole("button", { name: "managed-id" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "unproven-native" })).toBeTruthy();
  });

  it.each([false, true])(
    "does not promote a legacy scalar alias across collections (mixed plural: %s)",
    (mixed) => {
      useSessionViewStore.getState().setCollections(true);
      mocks.indexed = [
        { ...session("legacy-native"), workspace_id: SESSION_COLLECTIONS.projectless },
      ];
      const legacy = {
        ...session("legacy-managed"),
        indexedSessionId: "legacy-native",
        ...(mixed ? { indexedSessionIds: ["legacy-native"] } : {}),
      };
      mocks.controlled = [legacy];
      render(
        <SessionHubProvider>
          <Directory />
        </SessionHubProvider>,
      );
      expect(screen.getByRole("button", { name: "legacy-native" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "legacy-managed" })).toBeTruthy();
    },
  );

  it("projects a verified global Codex runtime floor onto raw collection rows", () => {
    useSessionViewStore.getState().setCollections(true);
    mocks.indexed = [{ ...session("raw-native"), workspace_id: SESSION_COLLECTIONS.projectless }];
    mocks.codexRuntimeReason = "codex-cli-version-too-old";
    const view = render(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    expect(
      screen.getByRole("button", { name: "raw-native" }).getAttribute("data-runtime-reason"),
    ).toBe("codex-cli-version-too-old");
    mocks.codexRuntimeReason = null;
    view.rerender(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    expect(
      screen.getByRole("button", { name: "raw-native" }).getAttribute("data-runtime-reason"),
    ).toBeNull();
  });

  it.each(["auxiliary", "execution"] as const)(
    "rejects a legacy %s link without selecting or exposing the record",
    (origin) => {
      mocks.search = { sessionId: "hidden" };
      useSessionViewStore.getState().setCreatingConversation(true);
      mocks.controlled = [{ ...session("hidden"), origin }, session("ordinary")];
      render(
        <SessionHubProvider>
          <Directory />
        </SessionHubProvider>,
      );
      expect(screen.queryByRole("button", { name: "hidden" })).toBeNull();
      expect(screen.getByRole("status").textContent).toBe("none");
      expect(screen.getByText("Hidden record notice")).toBeTruthy();
      expect(useSessionViewStore.getState().creatingConversation).toBe(false);
      expect(mocks.navigate).toHaveBeenCalledOnce();
      expect(mocks.navigate.mock.calls[0][0].search(mocks.search)).toEqual({
        sessionId: undefined,
      });
    },
  );

  it("retains a valid deep link after a catalog error and recovers after retry", () => {
    mocks.search = { sessionId: "unmanaged" };
    mocks.controlled = [];
    mocks.controlledError = new Error("Conversation catalog unavailable");
    const view = render(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Conversation catalog unavailable");
    mocks.controlledError = undefined;
    mocks.controlled = [session("unmanaged")];
    view.rerender(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "unmanaged" })).toBeTruthy();
  });

  it("only clears a missing deep link after the authoritative catalog succeeds", () => {
    mocks.search = { sessionId: "missing" };
    mocks.controlled = [];
    mocks.controlledReady = false;
    const view = render(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
    mocks.controlledReady = true;
    view.rerender(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    expect(mocks.navigate).toHaveBeenCalledOnce();
    expect(mocks.navigate.mock.calls[0][0].search(mocks.search)).toEqual({
      sessionId: undefined,
    });
  });

  it("does not restore an indexed alias removed by the controlled catalog", () => {
    render(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    expect(screen.queryByRole("button", { name: "indexed-alias" })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "managed-id" }));
    const navigation = mocks.navigate.mock.calls.at(-1)![0];
    expect(navigation.search({})).toEqual({ sessionId: "managed-id" });
  });

  it("keeps the existing indexed directory when the desktop bridge is unavailable", () => {
    mocks.bridge = false;
    render(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    expect(screen.getByRole("button", { name: "indexed-alias" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "managed-id" })).toBeNull();
  });

  it.each(["codex", "claude-code"] as const)(
    "routes a legacy %s search link to its verified managed identity without duplicating it",
    (agent) => {
      mocks.search = { sessionId: "indexed-alias" };
      mocks.controlled = [
        { ...session("managed-id"), agent, indexedSessionIds: ["indexed-alias"] },
      ];
      render(
        <SessionHubProvider>
          <Directory />
        </SessionHubProvider>,
      );
      expect(screen.getByRole("status").textContent).toBe("managed-id");
      expect(mocks.navigate).toHaveBeenCalledOnce();
      const navigation = mocks.navigate.mock.calls[0][0];
      expect(navigation.replace).toBe(true);
      expect(navigation.search(mocks.search)).toEqual({ sessionId: "managed-id" });
      expect(screen.queryByRole("button", { name: "indexed-alias" })).toBeNull();
    },
  );

  it("waits for scanning before reading the controlled catalog on manual refresh", async () => {
    let finish!: () => void;
    mocks.refresh.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    render(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mocks.refreshControlled).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() => expect(mocks.refreshControlled).toHaveBeenCalledOnce());
  });
});
