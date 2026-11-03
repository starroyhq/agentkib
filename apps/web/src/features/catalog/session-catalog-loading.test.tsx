import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebClient,
  type Access,
  type ConversationCatalog,
  type ConversationEventPage,
  type Live,
} from "@agentkib/web-client";
import { RouterProvider } from "@tanstack/react-router";
import { WebApplication, makeRouter } from "@/router";
import { dictionaries, type Locale } from "@/features/conversation/i18n";
import { catalogCopyForSurface } from "@/features/conversation/features/catalog/catalog-copy";
import { useSessionController } from "@/features/conversation/features/sessions/use-session-controller";

class CatalogEventSource {
  static instances: CatalogEventSource[] = [];
  listeners: Record<string, (event: MessageEvent) => void> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly path: string) {
    CatalogEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.listeners[name] = listener;
  }
  emit(name: string) {
    this.listeners[name]?.(new MessageEvent(name, { data: "{}" }));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const catalog: ConversationCatalog = {
  indexEnabled: true,
  workspaces: [{ id: "project", name: "Project", path: "/work/project" }],
  sessions: [
    {
      id: "first",
      workspace_id: "project",
      agent: "claude-code",
      title: "First session",
      availability: "readable",
      archived: false,
      sidechain: false,
    },
    {
      id: "other",
      workspace_id: "project",
      agent: "codex",
      title: "Other session",
      availability: "readable",
      archived: false,
      sidechain: false,
    },
  ],
};
const emptyCatalog: ConversationCatalog = { ...catalog, sessions: [] };
const history: ConversationEventPage = {
  events: [
    {
      id: "history",
      kind: "agent-message",
      content: "Readable history",
      attachment_count: 0,
      truncated: false,
    },
  ],
  warnings: [],
};

function fixture(locale: Locale = "zh-CN", pathname = "/sessions") {
  const state = {
    access: {
      status: "approved",
      protocolVersion: 2,
      csrfToken: "csrf",
      bootId: "boot",
      experimentalEnabled: true,
      device: { id: "browser", name: "Browser", send: true, approve: true },
    } satisfies Access as Access,
  };
  const readCatalog = vi.fn<() => Promise<Response>>();
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const path = String(input);
    if (path.endsWith("/access")) return Response.json(state.access);
    if (path.endsWith("/catalog")) return readCatalog();
    if (path.includes("/events?")) return Response.json(history);
    if (path.includes("/live?"))
      return Response.json({
        sessionId: new URL(path, "http://localhost").searchParams.get("sessionId")!,
        revision: 1,
        status: "idle",
        sendEnabled: true,
        approvals: [],
        questions: [],
      } satisfies Live);
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  const first = deferred<Response>();
  readCatalog.mockReturnValue(first.promise);
  const router = makeRouter({ initialLocale: locale }, true);
  if (pathname === "/sessions") render(<WebApplication initialLocale={locale} />);
  else {
    router.history.replace(pathname);
    render(<RouterProvider router={router} />);
  }
  return { state, readCatalog, fetcher, first, router };
}

function directoryStream() {
  const source = CatalogEventSource.instances.find(
    (stream) => !new URL(stream.path, "http://localhost").searchParams.has("sessionId"),
  );
  if (!source) throw new Error("Directory observation has not started");
  return source;
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("EventSource", CatalogEventSource);
});
afterEach(() => {
  cleanup();
  CatalogEventSource.instances = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("catalog loading through the real Web application and session provider", () => {
  it("does not present a partial first empty snapshot as a confirmed empty directory", async () => {
    const host = fixture();
    await waitFor(() => expect(host.readCatalog).toHaveBeenCalledOnce());
    await act(async () =>
      host.first.resolve(
        Response.json({
          ...emptyCatalog,
          complete: false,
          incompleteSources: [{ workspaceId: "project", agent: "claude-code" }],
        }),
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent(dictionaries["zh-CN"].loading);
    expect(screen.queryByText(dictionaries["zh-CN"].empty)).not.toBeInTheDocument();
    host.readCatalog.mockResolvedValue(Response.json({ ...emptyCatalog, complete: true }));
    act(() => directoryStream().emit("catalog-invalidated"));
    expect(await screen.findByText(dictionaries["zh-CN"].empty)).toBeVisible();
  });

  it("preserves the selected source on a partial live catalog while removing a completed source", async () => {
    const host = fixture();
    await act(async () => host.first.resolve(Response.json(catalog)));
    fireEvent.click(await screen.findByRole("button", { name: /First session/ }));
    const historyNode = await screen.findByText("Readable history");
    const first = screen.getByRole("button", { name: /First session/ });
    host.readCatalog.mockResolvedValue(
      Response.json({
        ...emptyCatalog,
        complete: false,
        incompleteSources: [{ workspaceId: "project", agent: "claude-code" }],
      }),
    );
    act(() => directoryStream().emit("catalog-invalidated"));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Other session/ })).toBeNull());
    expect(screen.getByRole("button", { name: /First session/ })).toBe(first);
    expect(first).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Readable history")).toBe(historyNode);
    host.readCatalog.mockResolvedValue(Response.json({ ...emptyCatalog, complete: true }));
    act(() => directoryStream().emit("catalog-invalidated"));
    await waitFor(() => expect(screen.queryByRole("button", { name: /First session/ })).toBeNull());
  });

  it.each([undefined, []])(
    "keeps unknown partial missing rows without replaying writes (%s)",
    async (incompleteSources) => {
      const host = fixture();
      await act(async () => host.first.resolve(Response.json(catalog)));
      const first = await screen.findByRole("button", { name: /First session/ });
      host.readCatalog.mockResolvedValue(
        Response.json({ ...emptyCatalog, complete: false, incompleteSources }),
      );
      act(() => directoryStream().emit("catalog-invalidated"));
      await waitFor(() => expect(host.readCatalog).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("button", { name: /First session/ })).toBe(first);
      expect(host.fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    },
  );

  it("re-reads a stale catalog at most three times and retains a loaded reader", async () => {
    const host = fixture();
    await act(async () => host.first.resolve(Response.json(catalog)));
    fireEvent.click(await screen.findByRole("button", { name: /First session/ }));
    const historyNode = await screen.findByText("Readable history");
    const before = host.readCatalog.mock.calls.length;
    host.readCatalog.mockImplementation(async () =>
      Response.json({ error: "catalog_stale" }, { status: 409 }),
    );
    act(() => directoryStream().emit("catalog-invalidated"));
    await waitFor(() => expect(host.readCatalog).toHaveBeenCalledTimes(before + 3));
    expect(screen.getByText("Readable history")).toBe(historyNode);
    expect(screen.getByRole("button", { name: /First session/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(host.fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "shows %s loading until the first accepted snapshot, then the real empty result",
    async (locale) => {
      const host = fixture(locale);
      const t = dictionaries[locale];
      await waitFor(() => expect(host.readCatalog).toHaveBeenCalledOnce());
      expect(screen.getByRole("status")).toHaveTextContent(t.loading);
      expect(screen.queryByText(t.empty)).not.toBeInTheDocument();
      expect(
        screen.queryByText(catalogCopyForSurface(locale, "web").missing),
      ).not.toBeInTheDocument();

      await act(async () => host.first.resolve(Response.json(emptyCatalog)));
      expect(await screen.findByText(t.empty)).toBeVisible();
      expect(screen.queryByText(t.loading)).not.toBeInTheDocument();
      expect(host.fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    },
  );

  it("shows a legacy-host upgrade notice only after the completed response omits workspaces", async () => {
    const host = fixture();
    await waitFor(() => expect(host.readCatalog).toHaveBeenCalledOnce());
    expect(
      screen.queryByText(catalogCopyForSurface("zh-CN", "web").missing),
    ).not.toBeInTheDocument();
    await act(async () =>
      host.first.resolve(Response.json({ indexEnabled: true, sessions: catalog.sessions })),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      catalogCopyForSurface("zh-CN", "web").missing,
    );
    expect(screen.queryByText(dictionaries["zh-CN"].empty)).not.toBeInTheDocument();
  });

  it("preserves an explicitly disabled index instead of calling it an empty catalog", async () => {
    const host = fixture();
    await waitFor(() => expect(host.readCatalog).toHaveBeenCalledOnce());
    await act(async () =>
      host.first.resolve(Response.json({ ...emptyCatalog, indexEnabled: false })),
    );
    expect(await screen.findByText(dictionaries["zh-CN"].indexDisabled)).toBeVisible();
    expect(screen.queryByText(dictionaries["zh-CN"].empty)).not.toBeInTheDocument();
    expect(
      screen.queryByText(catalogCopyForSurface("zh-CN", "web").missing),
    ).not.toBeInTheDocument();
  });

  it("waits for a delayed first catalog before opening a readable session deep link", async () => {
    const host = fixture("zh-CN", "/sessions/first");
    await waitFor(() => expect(host.readCatalog).toHaveBeenCalledOnce());
    expect(screen.queryByText(dictionaries["zh-CN"].empty)).not.toBeInTheDocument();
    expect(
      screen.queryByText(catalogCopyForSurface("zh-CN", "web").missing),
    ).not.toBeInTheDocument();
    expect(host.fetcher.mock.calls.some(([input]) => String(input).includes("/events?"))).toBe(
      false,
    );
    await act(async () => host.first.resolve(Response.json(catalog)));
    expect(await screen.findByText("Readable history")).toBeVisible();
    expect(screen.getByRole("button", { name: /First session/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(host.router.state.location.pathname).toBe("/sessions/first");
    expect(host.fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("keeps an initial failure distinct from empty or legacy data and retries through the existing action", async () => {
    const host = fixture();
    const t = dictionaries["zh-CN"];
    await waitFor(() => expect(host.readCatalog).toHaveBeenCalledOnce());
    await act(async () => host.first.reject(new TypeError("network unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent(t.error);
    expect(screen.queryByText(t.loading)).not.toBeInTheDocument();
    expect(screen.queryByText(t.empty)).not.toBeInTheDocument();
    expect(
      screen.queryByText(catalogCopyForSurface("zh-CN", "web").missing),
    ).not.toBeInTheDocument();

    const retry = deferred<Response>();
    host.readCatalog.mockReturnValue(retry.promise);
    fireEvent.click(screen.getByRole("button", { name: t.retry }));
    await waitFor(() => expect(host.readCatalog).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status")).toHaveTextContent(t.loading);
    expect(screen.queryByText(t.empty)).not.toBeInTheDocument();
    await act(async () => retry.resolve(Response.json(catalog)));
    expect(await screen.findByRole("button", { name: /First session/ })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(host.fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("retains cached rows, search and selection during refresh and a failed refresh", async () => {
    const host = fixture();
    const t = dictionaries["zh-CN"];
    await act(async () => host.first.resolve(Response.json(catalog)));
    fireEvent.click(await screen.findByRole("button", { name: /First session/ }));
    await screen.findByText("Readable history");
    const search = screen.getByRole("textbox", { name: t.search });
    fireEvent.change(search, { target: { value: "First" } });
    const selected = screen.getByRole("button", { name: /First session/ });
    expect(selected).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: /Other session/ })).not.toBeInTheDocument();

    const refresh = deferred<Response>();
    host.readCatalog.mockReturnValue(refresh.promise);
    fireEvent.click(screen.getByRole("button", { name: t.refresh }));
    await waitFor(() => expect(host.readCatalog).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /First session/ })).toBe(selected);
    expect(selected).toBeEnabled();
    expect(selected).toHaveAttribute("aria-current", "page");
    expect(search).toHaveValue("First");
    expect(screen.queryByText(t.empty)).not.toBeInTheDocument();

    await act(async () => refresh.reject(new TypeError("refresh unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent(t.error);
    expect(screen.getByRole("button", { name: /First session/ })).toBe(selected);
    expect(selected).toHaveAttribute("aria-current", "page");
    expect(search).toHaveValue("First");
    expect(screen.queryByText(t.empty)).not.toBeInTheDocument();

    const retry = deferred<Response>();
    host.readCatalog.mockReturnValue(retry.promise);
    fireEvent.click(screen.getByRole("button", { name: t.retry }));
    await waitFor(() => expect(host.readCatalog).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("button", { name: /First session/ })).toBe(selected);
    await act(async () => retry.resolve(Response.json(catalog)));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /First session/ })).toBe(selected);
    expect(selected).toHaveAttribute("aria-current", "page");
    expect(search).toHaveValue("First");
    expect(host.fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("keeps the newer accepted result when a superseded initial request completes later", async () => {
    const host = fixture();
    await waitFor(() => expect(host.readCatalog).toHaveBeenCalledOnce());
    const newer = deferred<Response>();
    host.readCatalog.mockReturnValue(newer.promise);
    const directory = await waitFor(directoryStream);
    act(() => directory.emit("catalog-invalidated"));
    await waitFor(() => expect(host.readCatalog).toHaveBeenCalledTimes(2));
    await act(async () => newer.resolve(Response.json(emptyCatalog)));
    expect(await screen.findByText(dictionaries["zh-CN"].empty)).toBeVisible();
    await act(async () => host.first.resolve(Response.json(catalog)));
    expect(screen.getByText(dictionaries["zh-CN"].empty)).toBeVisible();
    expect(screen.queryByRole("button", { name: /First session/ })).not.toBeInTheDocument();
  });

  it("keeps the accepted directory usable when selecting a session invalidates an in-flight refresh", async () => {
    const host = fixture();
    const t = dictionaries["zh-CN"];
    await act(async () => host.first.resolve(Response.json(catalog)));
    const first = await screen.findByRole("button", { name: /First session/ });
    const refresh = deferred<Response>();
    host.readCatalog.mockReturnValue(refresh.promise);
    fireEvent.click(screen.getByRole("button", { name: t.refresh }));
    await waitFor(() => expect(host.readCatalog).toHaveBeenCalledTimes(2));
    fireEvent.click(first);
    expect(await screen.findByText("Readable history")).toBeVisible();
    await act(async () => refresh.resolve(Response.json(emptyCatalog)));
    expect(screen.getByRole("button", { name: /First session/ })).toBe(first);
    expect(first).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText(t.empty)).not.toBeInTheDocument();
    expect(
      screen.queryByText(catalogCopyForSurface("zh-CN", "web").missing),
    ).not.toBeInTheDocument();
    expect(host.fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("does not publish an old boot's result while the new authorized catalog is pending", async () => {
    const host = fixture();
    await waitFor(() => expect(host.readCatalog).toHaveBeenCalledOnce());
    const next = deferred<Response>();
    host.readCatalog.mockReturnValue(next.promise);
    const directory = await waitFor(directoryStream);
    host.state.access = { ...host.state.access, bootId: "replacement-boot" };
    act(() => directory.emit("access-changed"));
    await waitFor(() => expect(CatalogEventSource.instances).toHaveLength(2));
    act(() => CatalogEventSource.instances.at(-1)!.onopen?.());
    await waitFor(() => expect(host.readCatalog).toHaveBeenCalledTimes(2));
    await act(async () => host.first.resolve(Response.json(catalog)));
    expect(screen.getByRole("status")).toHaveTextContent(dictionaries["zh-CN"].loading);
    expect(screen.queryByRole("button", { name: /First session/ })).not.toBeInTheDocument();
    expect(screen.queryByText(dictionaries["zh-CN"].empty)).not.toBeInTheDocument();
    await act(async () => next.resolve(Response.json(emptyCatalog)));
    expect(await screen.findByText(dictionaries["zh-CN"].empty)).toBeVisible();
  });
});

describe("catalog reads and leaving a conversation", () => {
  function controllerFixture() {
    const first = deferred<Response>();
    const readHistory = vi.fn<() => Promise<Response>>().mockResolvedValue(Response.json(history));
    const access: Access = {
      status: "approved",
      protocolVersion: 2,
      csrfToken: "csrf",
      bootId: "boot",
      experimentalEnabled: true,
      device: { id: "browser", name: "Browser", send: true, approve: true },
    };
    const transport = vi.fn<typeof fetch>(async (input) => {
      const path = String(input);
      if (path.endsWith("/access")) return Response.json(access);
      if (path.endsWith("/catalog")) return first.promise;
      if (path.includes("/events?")) return readHistory();
      if (path.includes("/live?"))
        return Response.json({
          sessionId: "first",
          revision: 1,
          status: "idle",
          sendEnabled: true,
          approvals: [],
          questions: [],
        } satisfies Live);
      return Response.json({});
    });
    const client = new WebClient(transport);
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    return { first, readHistory, transport, view };
  }

  it("still clears transient panels with no selected session while accepting the pending catalog", async () => {
    const host = controllerFixture();
    await waitFor(() =>
      expect(host.transport.mock.calls.some(([input]) => String(input).endsWith("/catalog"))).toBe(
        true,
      ),
    );
    act(() => {
      host.view.result.current.setModal("preferences");
      host.view.result.current.setHistorySearchOpen(true);
    });
    act(() => host.view.result.current.leaveSession());
    expect(host.view.result.current.modal).toBeUndefined();
    expect(host.view.result.current.historySearchOpen).toBe(false);
    expect(host.view.result.current.catalogStatus).toBe("loading");
    await act(async () => host.first.resolve(Response.json(catalog)));
    await waitFor(() => expect(host.view.result.current.catalogStatus).toBe("ready"));
    expect(host.view.result.current.sessions).toEqual(catalog.sessions);
  });

  it("continues invalidating a selected session's pending history when returning to the directory", async () => {
    const host = controllerFixture();
    await act(async () => host.first.resolve(Response.json(catalog)));
    await waitFor(() => expect(host.view.result.current.catalogStatus).toBe("ready"));
    const delayed = deferred<Response>();
    host.readHistory.mockReturnValue(delayed.promise);
    let choose!: Promise<void>;
    act(() => {
      choose = host.view.result.current.choose("first");
    });
    await waitFor(() => expect(host.readHistory).toHaveBeenCalledOnce());
    act(() => {
      host.view.result.current.setModal("preferences");
      host.view.result.current.setHistorySearchOpen(true);
    });
    act(() => host.view.result.current.leaveSession());
    await act(async () => {
      delayed.resolve(Response.json(history));
      await choose;
    });
    expect(host.view.result.current.selected).toBe("");
    expect(host.view.result.current.page).toBeUndefined();
    expect(host.view.result.current.live).toBeUndefined();
    expect(host.view.result.current.modal).toBeUndefined();
    expect(host.view.result.current.historySearchOpen).toBe(false);
    expect(host.view.result.current.controlReady).toBe(false);
    expect(host.view.result.current.catalogStatus).toBe("ready");
    expect(host.view.result.current.sessions).toEqual(catalog.sessions);
    expect(host.transport.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
});
