// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  WebClient,
  type Access,
  type ConversationCatalog,
  type HistoryLocatedRecord,
  type HistorySearchStatus,
} from "@agentkib/web-client";
import {
  HistorySearchControls,
  HistorySearchPanel,
  historyAccessScope,
  createHistoryOpenLock,
  historySessionTarget,
  historyCopy,
} from "@agentkib/session-ui";
import { isSessionVisible } from "@agentkib/session-catalog";
import { render } from "../../desktop-reader-test-utils";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const c = historyCopy["en-US"];
const record: HistoryLocatedRecord = {
  location: {
    sessionId: "source",
    recordId: "record",
    chunkId: "chunk",
    sourceRevision: "revision",
  },
  workspaceId: "workspace",
  agent: "claude-code",
  title: "Source history",
  timestamp: null,
  kind: "assistant",
  toolName: null,
  content: "needle source content",
  contentHash: "content-hash",
  before: null,
  after: null,
};
const status: HistorySearchStatus = {
  enabled: true,
  generation: "index",
  bytes: 0,
  limitBytes: 10000,
  budgetExceeded: false,
  coverage: {
    total: 1,
    ready: 1,
    building: 0,
    partial: 0,
    stale: 0,
    unavailable: 0,
    limitations: [],
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(currentSessionId?: string) {
  const grant: Access = {
    protocolVersion: 2,
    status: "approved",
    csrfToken: "test",
    bootId: "boot",
    experimentalEnabled: true,
    historySearch: true,
    historySearchScope: "scope",
    device: { id: "device", name: "Test", send: true, approve: true },
  };
  const catalog: ConversationCatalog = {
    indexEnabled: true,
    workspaces: [{ id: "workspace", name: "Workspace", path: "/workspace" }],
    sessions: [
      {
        id: "source",
        workspace_id: "workspace",
        agent: "claude-code",
        availability: "readable",
        origin: "interactive",
        archived: false,
        sidechain: false,
      },
    ],
  };
  const client = new WebClient(vi.fn());
  vi.spyOn(client, "access").mockImplementation(async () => ({ ...grant }));
  vi.spyOn(client, "catalog").mockImplementation(async () => ({
    ...catalog,
    sessions: [...catalog.sessions],
  }));
  vi.spyOn(client, "historyStatus").mockResolvedValue(status);
  vi.spyOn(client, "historySearch").mockResolvedValue({
    hits: [{ ...record, snippet: record.content, matchRanges: [], stale: false }],
    status,
    nextCursor: null,
    limited: false,
  });
  vi.spyOn(client, "historyLocate").mockResolvedValue(record);
  const resolved = {
    references: [
      {
        ...record,
        reference: {
          ...record.location,
          start: 0,
          end: record.content.length,
          contentHash: record.contentHash,
        },
      },
    ],
    text: record.content,
  };
  vi.spyOn(client, "historyReferences").mockResolvedValue(resolved);
  const props = {
    client,
    locale: "en-US" as const,
    scope: historyAccessScope(grant),
    initialQuery: "needle",
    currentSessionId,
    navigationContext: JSON.stringify([currentSessionId, "keep draft"]),
    onOpenSession: vi.fn(),
    onReference: vi.fn(),
    onScopeEnded: vi.fn(),
  };
  return { client, catalog, grant, props, resolved };
}
async function openSource() {
  fireEvent.click(await screen.findByRole("button", { name: /Source history/ }));
  await screen.findByRole("region", { name: c.source });
}
async function renderSource(f: ReturnType<typeof fixture>) {
  const view = render(<HistorySearchPanel {...f.props} />);
  await openSource();
  return view;
}
async function requestOpen() {
  fireEvent.click(screen.getByRole("button", { name: c.openSession }));
  await waitFor(() => expect(screen.getByRole("button", { name: c.openSession })).toBeEnabled());
}

describe("explicit history session opening", () => {
  it("revalidates the source, scope and catalog before opening, and states the message-position boundary", async () => {
    const f = fixture();
    await renderSource(f);
    expect(screen.getByText(c.openPosition)).toBeVisible();
    await requestOpen();
    expect(f.props.onOpenSession).toHaveBeenCalledExactlyOnceWith(f.catalog.sessions[0]);
    expect(f.client.historyLocate).toHaveBeenCalledTimes(2);
    expect(f.client.catalog).toHaveBeenCalledTimes(2);
    expect(f.props.onReference).not.toHaveBeenCalled();
  });

  it("keeps reference selection independent of navigation and the current draft", async () => {
    const f = fixture("current");
    await renderSource(f);
    expect(screen.getByText(c.quoteOnly)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: c.quote }));
    await screen.findByText(c.added);
    expect(f.props.onReference).toHaveBeenCalledOnce();
    expect(f.props.currentSessionId).toBe("current");
    expect(f.props.navigationContext).toBe(JSON.stringify(["current", "keep draft"]));
    expect(f.props.onOpenSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: c.openConfirm })).toBeNull();
  });

  it("keeps the reference action disabled until an excerpt is selected", async () => {
    const f = fixture("current");
    await renderSource(f);
    const excerpt = screen.getByRole("textbox", { name: c.excerpt }) as HTMLTextAreaElement;
    act(() => {
      excerpt.focus();
      excerpt.setSelectionRange(0, 0);
      fireEvent.select(excerpt);
    });
    const quote = screen.getByRole("button", { name: c.quote });
    expect(quote).toBeDisabled();
    expect(quote).toHaveAttribute("title", c.selection);
    fireEvent.click(quote);
    expect(f.client.historyReferences).not.toHaveBeenCalled();
  });

  it.each([
    ["codex", false, undefined, false, c.referenceSendPermission],
    ["claude-code", true, undefined, true, c.referenceBusy],
    ["antigravity", false, "uncertain", true, c.referenceUncertain],
    ["devin", false, undefined, true, undefined],
    ["deepseek-harness", false, undefined, true, undefined],
  ] as const)(
    "uses the provider registration and current access for %s history references",
    async (agent, busy, notice, send, title) => {
      const f = fixture("current");
      const addHistoryReference = vi.fn();
      f.grant.device = { id: "device", name: "Test", send, approve: true };
      render(
        <HistorySearchControls
          session={{
            access: f.grant,
            historySearchOpen: true,
            modal: undefined,
            selected: "current",
            current: { id: "current", agent },
            busy,
            notice,
            client: f.client,
            locale: f.props.locale,
            message: "",
            historyReferences: [],
            setHistorySearchOpen: vi.fn(),
            setHistoryReferences: vi.fn(),
            addHistoryReference,
          }}
          onOpenSession={f.props.onOpenSession}
        />,
      );
      fireEvent.change(screen.getByRole("textbox", { name: c.query }), {
        target: { value: "needle" },
      });
      await openSource();
      if (title) {
        const quote = screen.getByRole("button", { name: c.quote });
        expect(quote).toBeDisabled();
        expect(quote).toHaveAttribute("title", title);
        expect(screen.queryByText(title)).not.toBeInTheDocument();
        expect(screen.queryByText(c.quoteOnly)).not.toBeInTheDocument();
        fireEvent.click(quote);
      } else {
        expect(screen.queryByRole("button", { name: c.quote })).not.toBeInTheDocument();
      }
      expect(f.client.historyReferences).not.toHaveBeenCalled();
      expect(addHistoryReference).not.toHaveBeenCalled();
    },
  );

  it.each(["read scope", "send permission", "session availability", "selected target"] as const)(
    "rejects a pending history reference if %s changes",
    async (change) => {
      const f = fixture("current");
      const view = await renderSource(f);
      const pending = deferred<typeof f.resolved>();
      vi.mocked(f.client.historyReferences).mockReturnValueOnce(pending.promise);
      fireEvent.click(screen.getByRole("button", { name: c.quote }));
      expect(f.client.historyReferences).toHaveBeenCalledOnce();
      if (change === "read scope") {
        delete f.grant.historySearch;
      } else if (change === "send permission") {
        f.grant.device = { id: "device", name: "Test", send: false, approve: true };
      } else {
        view.rerender(
          <HistorySearchPanel
            {...f.props}
            currentSessionId={change === "selected target" ? "different" : "current"}
            referenceDisabledReason={
              change === "session availability" ? c.referenceBusy : undefined
            }
          />,
        );
      }
      await act(async () => pending.resolve(f.resolved));
      expect(f.props.onReference).not.toHaveBeenCalled();
      expect(screen.queryByText(c.added)).not.toBeInTheDocument();
      if (change === "read scope") expect(f.props.onScopeEnded).toHaveBeenCalledOnce();
    },
  );

  it("allows cancelling a cross-session opening without touching the draft or references", async () => {
    const f = fixture("current");
    await renderSource(f);
    await requestOpen();
    expect(screen.getByRole("group", { name: c.openConfirm })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: c.openCancel }));
    expect(screen.queryByRole("group", { name: c.openConfirm })).toBeNull();
    expect(f.props.onOpenSession).not.toHaveBeenCalled();
    expect(f.props.onReference).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: c.source })).toBeVisible();
  });

  it("requires confirmation and revalidates again before navigating only once", async () => {
    const f = fixture("current");
    await renderSource(f);
    await requestOpen();
    expect(f.props.onOpenSession).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: c.openDiscard });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(f.props.onOpenSession).toHaveBeenCalledOnce());
    expect(f.client.historyLocate).toHaveBeenCalledTimes(3);
  });

  it("opens the already selected managed alias without clearing or confirming its draft", async () => {
    const f = fixture("managed");
    f.catalog.sessions = [
      { ...f.catalog.sessions[0], id: "managed", indexedSessionIds: ["source"] },
    ];
    await renderSource(f);
    await requestOpen();
    expect(f.props.onOpenSession).toHaveBeenCalledExactlyOnceWith(f.catalog.sessions[0]);
    expect(screen.queryByRole("group", { name: c.openConfirm })).toBeNull();
    expect(f.props.onReference).not.toHaveBeenCalled();
  });

  it.each(["draft", "selection"])(
    "rejects an outdated confirmation after the %s changes",
    async (change) => {
      const f = fixture("current");
      const view = await renderSource(f);
      await requestOpen();
      view.rerender(<HistorySearchPanel {...f.props} navigationContext={change} />);
      fireEvent.click(screen.getByRole("button", { name: c.openDiscard }));
      expect(await screen.findByRole("alert")).toHaveTextContent(c.openChanged);
      expect(f.props.onOpenSession).not.toHaveBeenCalled();
      expect(f.client.historyLocate).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects a source whose content changed before opening", async () => {
    const f = fixture();
    await renderSource(f);
    vi.mocked(f.client.historyLocate).mockResolvedValueOnce({ ...record, contentHash: "changed" });
    await requestOpen();
    expect(screen.getByRole("alert")).toHaveTextContent(c.stale);
    expect(f.props.onOpenSession).not.toHaveBeenCalled();
  });

  it.each(["metadata-only", "auxiliary", "workspace", "agent", "missing"])(
    "does not navigate when the current catalog changes to %s",
    async (change) => {
      const f = fixture();
      await renderSource(f);
      if (change === "missing") f.catalog.sessions = [];
      else if (change === "metadata-only") f.catalog.sessions[0].availability = "metadata-only";
      else if (change === "auxiliary") f.catalog.sessions[0].origin = "auxiliary";
      else if (change === "workspace") f.catalog.sessions[0].workspace_id = "other";
      else f.catalog.sessions[0].agent = "codex";
      await requestOpen();
      expect(screen.getByRole("alert")).toHaveTextContent(c.error);
      expect(f.props.onOpenSession).not.toHaveBeenCalled();
    },
  );

  it.each(["scope", "revoked", "forbidden"])(
    "rejects access %s after confirmation",
    async (change) => {
      const f = fixture("current");
      await renderSource(f);
      await requestOpen();
      if (change === "scope") f.grant.historySearchScope = "new-scope";
      else if (change === "revoked") delete f.grant.historySearch;
      else
        vi.mocked(f.client.historyLocate).mockRejectedValueOnce(new ApiError(403, "access_ended"));
      fireEvent.click(screen.getByRole("button", { name: c.openDiscard }));
      await waitFor(() => expect(f.props.onScopeEnded).toHaveBeenCalledOnce());
      expect(f.props.onOpenSession).not.toHaveBeenCalled();
    },
  );

  it("cancels a pending opening when returning to results even if the transport ignores abort", async () => {
    const f = fixture();
    await renderSource(f);
    const pending = deferred<HistoryLocatedRecord>();
    vi.mocked(f.client.historyLocate).mockReturnValueOnce(pending.promise);
    const button = screen.getByRole("button", { name: c.openSession });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(f.client.historyLocate).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: c.back }));
    await act(async () => pending.resolve(record));
    expect(f.props.onOpenSession).not.toHaveBeenCalled();
  });

  it("keeps navigation disabled during a current conversation operation", async () => {
    const f = fixture("current");
    const view = await renderSource(f);
    view.rerender(<HistorySearchPanel {...f.props} openDisabled />);
    expect(screen.getByRole("button", { name: c.openSession })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: c.openSession }));
    expect(f.client.historyLocate).toHaveBeenCalledOnce();
    expect(f.props.onOpenSession).not.toHaveBeenCalled();
  });
});

it("can reopen a source while an aborted older opening never settles", async () => {
  const f = fixture();
  await renderSource(f);
  vi.mocked(f.client.historyLocate).mockReturnValueOnce(new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: c.openSession }));
  fireEvent.click(screen.getByRole("button", { name: c.back }));
  fireEvent.click(await screen.findByRole("button", { name: /Source history/ }));
  await screen.findByRole("region", { name: c.source });
  await requestOpen();
  expect(f.props.onOpenSession).toHaveBeenCalledOnce();
  expect(f.client.historyLocate).toHaveBeenCalledTimes(4);
});

it("does not release a newer pending opening when an aborted request finally returns", async () => {
  const f = fixture();
  await renderSource(f);
  const older = deferred<HistoryLocatedRecord>();
  vi.mocked(f.client.historyLocate).mockReturnValueOnce(older.promise);
  fireEvent.click(screen.getByRole("button", { name: c.openSession }));
  fireEvent.click(screen.getByRole("button", { name: c.back }));
  fireEvent.click(await screen.findByRole("button", { name: /Source history/ }));
  await screen.findByRole("region", { name: c.source });
  const newer = deferred<HistoryLocatedRecord>();
  vi.mocked(f.client.historyLocate).mockReturnValueOnce(newer.promise);
  fireEvent.click(screen.getByRole("button", { name: c.openSession }));
  await act(async () => older.resolve(record));
  expect(screen.getByRole("button", { name: c.openSession })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: c.openSession }));
  expect(f.client.historyLocate).toHaveBeenCalledTimes(4);
  expect(f.props.onOpenSession).not.toHaveBeenCalled();
  await act(async () => newer.resolve(record));
  await waitFor(() => expect(f.props.onOpenSession).toHaveBeenCalledOnce());
});

it("releases only the matching opening token and ignores aborted or obsolete generations", () => {
  const lock = createHistoryOpenLock();
  const oldSignal = new AbortController();
  const releaseOlder = lock.start(1, oldSignal.signal);
  expect(lock.isPending(1)).toBe(true);
  expect(lock.isPending(2)).toBe(false);
  oldSignal.abort();
  expect(lock.isPending(1)).toBe(false);
  const newSignal = new AbortController();
  const releaseNewer = lock.start(2, newSignal.signal);
  releaseOlder();
  expect(lock.isPending(2)).toBe(true);
  releaseNewer();
  expect(lock.isPending(2)).toBe(false);
});

it("rejects ambiguous or unverified aliases instead of guessing a conversation route", () => {
  const f = fixture();
  const owner = { ...f.catalog.sessions[0], id: "managed", indexedSessionIds: ["source"] };
  expect(
    historySessionTarget(record, [owner, { ...owner, id: "second-owner" }], isSessionVisible),
  ).toBeUndefined();
  expect(
    historySessionTarget(record, [{ ...owner, origin: "unknown" }], isSessionVisible),
  ).toBeUndefined();
});
