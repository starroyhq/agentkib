// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@agentkib/web-client";
import type { RequestedConversationPanel } from "./session-view-store";
import { DesktopConversationPane } from "./DesktopConversationPane";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  refresh: vi.fn(),
  creating: vi.fn(),
  reveal: vi.fn(),
  revision: 0,
  selectionRevision: 0,
  sessions: [] as { id: string }[],
  requestedPanel: undefined as RequestedConversationPanel | undefined,
  consumePanel: vi.fn(),
  selected: undefined as { id: string; indexedSessionIds?: string[] } | undefined,
}));
vi.mock("@/core/useI18n", () => ({
  useI18n: () => ({ locale: "en-US", tr: (key: string) => key, localizeMessage: String }),
}));
vi.mock("@/core/conversation-bridge", () => ({ createDesktopConversationClient: () => ({}) }));
vi.mock("./SessionHubContext", () => ({
  useSessionHub: () => ({
    select: mocks.select,
    selectionVersion: () => mocks.selectionRevision,
    sessions: mocks.sessions,
    selected: mocks.selected,
    conversationRefreshRevision: mocks.revision,
  }),
}));
vi.mock("./conversation-catalog", () => ({
  refreshConversationCatalog: mocks.refresh,
  cachedConversationCatalog: () => undefined,
}));
vi.mock("./session-view-store", () => ({
  useSessionViewStore: Object.assign(
    (selector: (state: { requestedPanel?: RequestedConversationPanel }) => unknown) =>
      selector({ requestedPanel: mocks.requestedPanel }),
    {
      getState: () => ({
        revealSession: mocks.reveal,
        setCreatingConversation: mocks.creating,
        consumePanel: mocks.consumePanel,
      }),
    },
  ),
}));
vi.mock("./conversation/conversation", () => ({
  EmbeddedConversation: ({
    onSessionChange,
    refreshRevision,
    initialPanel,
    onInitialPanelConsumed,
    onCatalogChange,
  }: {
    onSessionChange: (id?: string) => void;
    refreshRevision?: number;
    initialPanel?: string;
    onInitialPanelConsumed?: () => void;
    onCatalogChange: () => void;
  }) => (
    <>
      <button onClick={() => onSessionChange("fork")}>Open fork</button>
      <button onClick={() => onSessionChange(undefined)}>Clear selection</button>
      <button onClick={onCatalogChange}>Embedded catalog updated</button>
      <output>{refreshRevision}</output>
      {initialPanel && <button onClick={onInitialPanelConsumed}>{initialPanel}</button>}
    </>
  ),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.refresh.mockReset();
  mocks.revision = 0;
  mocks.selectionRevision = 0;
  mocks.sessions = [];
  mocks.requestedPanel = undefined;
  mocks.selected = undefined;
});
afterEach(cleanup);

describe("desktop conversation navigation", () => {
  it("lets the directory handle catalog changes without pending navigation", async () => {
    render(<DesktopConversationPane sessionId="original" />);
    const button = await screen.findByText("Embedded catalog updated");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("does not report read contention as a catalog failure after opening a fork", async () => {
    mocks.refresh.mockRejectedValue(new ApiError(409, "operation_busy"));
    render(<DesktopConversationPane sessionId="original" />);
    const button = await screen.findByText("Open fork");
    await act(async () => fireEvent.click(button));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByText(/sessions\.conversationCatalogError/)).not.toBeInTheDocument();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("retains a real failure when a pending navigation retry only encounters contention", async () => {
    mocks.refresh
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockRejectedValueOnce(new ApiError(409, "operation_busy"))
      .mockResolvedValueOnce([]);
    render(<DesktopConversationPane sessionId="original" />);
    const open = await screen.findByText("Open fork");
    await act(async () => fireEvent.click(open));
    expect(screen.getByText(/sessions\.conversationCatalogError/)).toHaveTextContent(
      "catalog unavailable",
    );
    const retry = screen.getByText("Embedded catalog updated");
    await act(async () => fireEvent.click(retry));
    expect(mocks.refresh).toHaveBeenLastCalledWith({ joinPending: true });
    expect(screen.getByText(/sessions\.conversationCatalogError/)).toHaveTextContent(
      "catalog unavailable",
    );
    await act(async () => fireEvent.click(retry));
    expect(screen.queryByText(/sessions\.conversationCatalogError/)).not.toBeInTheDocument();
  });

  it("forwards explicit toolbar refreshes to the mounted conversation", async () => {
    mocks.revision = 2;
    const view = render(<DesktopConversationPane sessionId="original" />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("2"));
    mocks.revision = 3;
    view.rerender(<DesktopConversationPane sessionId="original" />);
    expect(screen.getByRole("status").textContent).toBe("3");
  });
  it("does not steal a newer selection when a fork catalog refresh resolves late", async () => {
    let resolve!: (sessions: { id: string }[]) => void;
    mocks.refresh.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<DesktopConversationPane sessionId="original" />);
    fireEvent.click(await screen.findByText("Open fork"));
    view.rerender(<DesktopConversationPane sessionId="new-selection" />);
    await act(async () => {
      resolve([{ id: "fork" }]);
    });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.reveal).not.toHaveBeenCalled();
  });

  it("finishes a deferred fork when a catalog change recovers from a real failure", async () => {
    mocks.refresh
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce([{ id: "fork" }]);
    render(<DesktopConversationPane sessionId="original" />);
    fireEvent.click(await screen.findByText("Open fork"));
    await waitFor(() =>
      expect(screen.getByText(/sessions\.conversationCatalogError/)).toHaveTextContent(
        "catalog unavailable",
      ),
    );
    expect(mocks.select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Embedded catalog updated"));
    await waitFor(() => expect(mocks.select).toHaveBeenCalledExactlyOnceWith("fork"));
    expect(mocks.reveal).toHaveBeenCalledExactlyOnceWith({ id: "fork" });
    expect(screen.queryByText(/sessions\.conversationCatalogError/)).not.toBeInTheDocument();
  });

  it("discards deferred navigation after a newer selection even if the outer session ID is unchanged", async () => {
    mocks.refresh.mockRejectedValueOnce(new ApiError(409, "operation_busy"));
    const view = render(<DesktopConversationPane sessionId="original" />);
    fireEvent.click(await screen.findByText("Open fork"));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    mocks.selectionRevision += 1;
    fireEvent.click(screen.getByText("Embedded catalog updated"));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    mocks.sessions = [{ id: "fork" }];
    view.rerender(<DesktopConversationPane sessionId="original" />);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.reveal).not.toHaveBeenCalled();
  });

  it("discards deferred navigation when the pane unmounts before its catalog read finishes", async () => {
    let finish!: (sessions: { id: string }[]) => void;
    mocks.refresh.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const view = render(<DesktopConversationPane sessionId="original" />);
    fireEvent.click(await screen.findByText("Open fork"));
    view.unmount();
    await act(async () => finish([{ id: "fork" }]));
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.reveal).not.toHaveBeenCalled();
  });

  it("clears the desktop selection and invalidates a pending fork navigation", async () => {
    let resolve!: (sessions: { id: string }[]) => void;
    mocks.refresh.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<DesktopConversationPane sessionId="original" />);
    fireEvent.click(await screen.findByText("Open fork"));
    fireEvent.click(screen.getByText("Clear selection"));
    expect(mocks.select).toHaveBeenCalledWith();
    await act(async () => {
      resolve([{ id: "fork" }]);
    });
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.reveal).not.toHaveBeenCalled();
  });
  it("retains a queued terminal destination until the matching lazy conversation consumes it", async () => {
    const request = { sessionId: "target", panel: "terminal" as const };
    mocks.requestedPanel = request;
    const view = render(<DesktopConversationPane sessionId="other" />);
    await screen.findByText("Open fork");
    expect(screen.queryByRole("button", { name: "terminal" })).not.toBeInTheDocument();
    expect(mocks.consumePanel).not.toHaveBeenCalled();
    view.rerender(<DesktopConversationPane sessionId="target" />);
    fireEvent.click(await screen.findByRole("button", { name: "terminal" }));
    expect(mocks.consumePanel).toHaveBeenCalledExactlyOnceWith(request);
  });
  it("recognizes an indexed alias after the hub selects its canonical session", async () => {
    const request = { sessionId: "indexed", panel: "terminal" as const };
    mocks.requestedPanel = request;
    mocks.selected = { id: "managed", indexedSessionIds: ["indexed"] };
    render(<DesktopConversationPane sessionId="managed" />);
    fireEvent.click(await screen.findByRole("button", { name: "terminal" }));
    expect(mocks.consumePanel).toHaveBeenCalledExactlyOnceWith(request);
  });
});
