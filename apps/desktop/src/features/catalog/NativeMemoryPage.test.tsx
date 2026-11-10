// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NativeMemoryDetail,
  NativeMemoryFile,
  NativeMemorySnapshot,
  NativeMemorySource,
} from "@agentkib/runtime-protocol";
import type { MemoryRecord, WorkspaceSummary } from "@/core/types";
import { initializeI18n, tr } from "@/core/i18n";
import { NativeMemoryPage } from "./NativeMemoryPage";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  search: vi.fn(),
  read: vi.fn(),
  refresh: vi.fn(),
  observe: vi.fn(),
  review: vi.fn(),
  changed: vi.fn(),
  unsubscribe: vi.fn(),
  listener: undefined as (() => void) | undefined,
}));
vi.mock("@/core/api", () => ({
  api: {
    nativeMemoryList: (...args: unknown[]) => mocks.list(...args),
    nativeMemorySearch: (...args: unknown[]) => mocks.search(...args),
    nativeMemoryRead: (...args: unknown[]) => mocks.read(...args),
    nativeMemoryRefresh: (...args: unknown[]) => mocks.refresh(...args),
    nativeMemoryObserve: (...args: unknown[]) => mocks.observe(...args),
    reviewMemory: (...args: unknown[]) => mocks.review(...args),
  },
}));
vi.mock("@/core/desktop", () => ({
  desktopApi: () => ({
    events: {
      onNativeMemoryChanged: (listener: () => void) => {
        mocks.changed();
        mocks.listener = listener;
        return mocks.unsubscribe;
      },
    },
  }),
}));

const source: NativeMemorySource = {
  id: "claude-source",
  agent: "claude-code",
  directory: "/fixture/native-memory",
  workspaces: [{ id: "workspace-one", name: "Workspace One" }],
  status: "ready",
  stale: false,
  incomplete: false,
  lastAttemptAt: "2026-11-10T00:00:00Z",
  lastSuccessAt: "2026-11-10T00:00:00Z",
};
const index: NativeMemoryFile = {
  id: "index-id",
  sourceId: source.id,
  relativePath: "MEMORY.md",
  kind: "index",
  modifiedAt: "2026-11-10T00:00:00Z",
  version: "one",
  size: 50,
  truncated: false,
  stale: false,
};
const topic: NativeMemoryFile = {
  ...index,
  id: "topic-id",
  relativePath: "build-notes.md",
  kind: "topic",
};
const snapshot: NativeMemorySnapshot = {
  sources: [source],
  files: [index, topic],
  total: 2,
  nextOffset: null,
  revision: "r1",
  refreshing: false,
};
const record: MemoryRecord = {
  id: "platform-one",
  project_id: "manifest-one",
  memory_type: "project_fact",
  status: "pending",
  content: "Keep build instructions",
  created_at: "2026-11-10T00:00:00Z",
};
const workspace: WorkspaceSummary = {
  id: "workspace-one",
  name: "Workspace One",
  path: "/fixture",
  manifest_workspace_id: "manifest-one",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
const clients: QueryClient[] = [];
function client() {
  const value = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(value);
  return value;
}
function mount({
  records = [record],
  workspaces = [workspace],
  queryClient = client(),
  onReload = vi.fn().mockResolvedValue(undefined),
}: {
  records?: MemoryRecord[];
  workspaces?: WorkspaceSummary[];
  queryClient?: QueryClient;
  onReload?: () => Promise<void>;
} = {}) {
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <NativeMemoryPage records={records} workspaces={workspaces} onReload={onReload} />
      </QueryClientProvider>,
    ),
    queryClient,
    onReload,
  };
}
function detail(file = index): NativeMemoryDetail {
  return {
    file,
    source,
    content: file.kind === "index" ? "# Native index\nBuild notes" : "Topic instructions",
    links: file.kind === "index" ? [{ label: "Build notes", targetId: topic.id }] : [],
  };
}

function reader() {
  return screen.getByRole("region", { name: tr("memory.native.reader") });
}

function projectList() {
  return screen.getByRole("region", { name: tr("memory.native.projects") });
}

function openDiagnostics() {
  const diagnostics = screen.getByRole("region", { name: tr("memory.native.diagnostics") });
  const trigger = within(diagnostics).getByRole("button");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  return diagnostics;
}

function openPlatformRecord() {
  fireEvent.click(within(projectList()).getByRole("button", { name: new RegExp(record.content) }));
}

async function openLocation() {
  const trigger = await within(reader()).findByRole("button", {
    name: tr("memory.native.location"),
  });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
}

async function chooseFilter(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.listener = undefined;
  await initializeI18n("en-US");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  mocks.list.mockResolvedValue(snapshot);
  mocks.search.mockResolvedValue(snapshot);
  mocks.read.mockImplementation((id: string) =>
    Promise.resolve(detail(id === topic.id ? topic : index)),
  );
  mocks.refresh.mockResolvedValue(snapshot);
  mocks.observe.mockResolvedValue(undefined);
  mocks.review.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((value) => value.clear());
  vi.restoreAllMocks();
});

describe("native and platform memory", () => {
  it("shows separate native files and platform pending counts and reads native files without review actions", async () => {
    mount();
    expect(await screen.findByRole("button", { name: /MEMORY.md/ })).toBeVisible();
    expect(screen.getByText(tr("memory.native.filesCount", { count: 2 }))).toBeVisible();
    expect(screen.getByText(tr("memory.native.pendingCount", { count: 1 }))).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /MEMORY.md/ }));
    const nativeDetail = reader();
    expect(await within(nativeDetail).findByText(/Native index/)).toBeVisible();
    await openLocation();
    expect(within(nativeDetail).getByText(tr("memory.native.indexHint"))).toBeVisible();
    expect(
      within(nativeDetail).queryByRole("button", { name: tr("common.approve") }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: tr("common.approve") })).not.toBeInTheDocument();
    openPlatformRecord();
    expect(within(reader()).getByRole("button", { name: tr("common.approve") })).toBeVisible();
  });

  it("shows a topic even when no MEMORY.md index exists", async () => {
    mocks.list.mockResolvedValue({ ...snapshot, files: [topic], total: 1 });
    mount({ records: [] });
    fireEvent.click(await screen.findByRole("button", { name: /build-notes.md/ }));
    expect(await screen.findByText("Topic instructions")).toBeVisible();
    await openLocation();
    expect(screen.getByText(tr("memory.native.topicHint"))).toBeVisible();
    expect(screen.queryByRole("button", { name: /MEMORY.md/ })).not.toBeInTheDocument();
  });

  it("follows only backend-issued same-directory link ids and copies the original location", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    try {
      mount();
      fireEvent.click(await screen.findByRole("button", { name: /MEMORY.md/ }));
      await openLocation();
      fireEvent.click(await screen.findByRole("button", { name: tr("memory.native.copyPath") }));
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith("/fixture/native-memory/MEMORY.md"),
      );
      fireEvent.click(screen.getByRole("button", { name: "Build notes" }));
      expect(await screen.findByText("Topic instructions")).toBeVisible();
      expect(mocks.read).toHaveBeenLastCalledWith(topic.id);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders hostile HTML and remote images as inert text", async () => {
    const content =
      '<img src="https://example.invalid/private" onerror="alert(1)">\n![remote](https://example.invalid/image)';
    mocks.read.mockResolvedValue({ ...detail(), content });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /MEMORY.md/ }));
    const raw = await within(reader()).findByRole("button", { name: tr("memory.native.raw") });
    expect(document.querySelector("img, iframe, [onerror]")).toBeNull();
    fireEvent.click(raw);
    expect(
      await screen.findByText(
        (_text, element) => element?.tagName === "PRE" && element.textContent === content,
      ),
    ).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(document.querySelector("img, iframe, [onerror]")).toBeNull();
  });

  it("filters platform memories locally and sends native search terms with the selected workspace", async () => {
    mount({ records: [record, { ...record, id: "second", content: "Other information" }] });
    await screen.findByRole("button", { name: /MEMORY.md/ });
    await chooseFilter(tr("memory.native.workspaceFilter"), workspace.name);
    fireEvent.change(screen.getByRole("searchbox", { name: tr("memory.native.search") }), {
      target: { value: "build instructions" },
    });
    await waitFor(() =>
      expect(mocks.search).toHaveBeenCalledWith({
        workspaceId: workspace.id,
        offset: 0,
        query: "build instructions",
      }),
    );
    expect(screen.queryByText("Other information")).not.toBeInTheDocument();
    expect(screen.getByText(record.content)).toBeVisible();
    await chooseFilter(tr("memory.native.sourceFilter"), tr("memory.native.claude"));
    expect(
      within(projectList()).queryByRole("button", { name: new RegExp(record.content) }),
    ).not.toBeInTheDocument();
    await chooseFilter(tr("memory.native.sourceFilter"), tr("memory.native.platform"));
    expect(
      within(projectList()).queryByRole("button", { name: /MEMORY.md/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(record.content)).toBeVisible();
  });

  it.each([
    ["", 100],
    ["build", 50],
  ])("paginates %s using backend offsets without duplicate rows", async (search, offset) => {
    const request = search ? mocks.search : mocks.list;
    request
      .mockResolvedValueOnce({ ...snapshot, files: [index], total: offset + 1, nextOffset: offset })
      .mockResolvedValueOnce({
        ...snapshot,
        files: [index, topic],
        total: offset + 1,
        nextOffset: null,
      });
    mount();
    if (search)
      fireEvent.change(screen.getByRole("searchbox", { name: tr("memory.native.search") }), {
        target: { value: search },
      });
    const more = await screen.findByRole("button", { name: tr("memory.native.more") });
    fireEvent.click(more);
    await screen.findByRole("button", { name: /build-notes.md/ });
    expect(request).toHaveBeenLastCalledWith({
      workspaceId: undefined,
      offset,
      ...(search ? { query: search } : {}),
    });
    expect(screen.getAllByRole("button", { name: /MEMORY.md/ })).toHaveLength(1);
  });

  it("keeps cached list and detail visible when refreshing fails", async () => {
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: /MEMORY.md/ }));
    await screen.findByText(/Native index/);
    mocks.list.mockRejectedValue(new Error("scan failed"));
    mocks.read.mockRejectedValue(new Error("file temporarily locked"));
    await act(async () => {
      await view.queryClient.invalidateQueries({ queryKey: ["native-memory"] });
    });
    expect(screen.getByRole("button", { name: /MEMORY.md/ })).toBeVisible();
    expect(screen.getByText(/Native index/)).toBeVisible();
    expect(await screen.findByText(tr("memory.native.loadError"))).toBeVisible();
    expect(await screen.findByText(tr("memory.native.detailError"))).toBeVisible();
    expect(within(reader()).getByText(tr("memory.native.stale"))).toBeVisible();
  });

  it("restores independent cached data immediately after remount", async () => {
    const shared = client();
    const view = mount({ queryClient: shared });
    await screen.findByRole("button", { name: /MEMORY.md/ });
    view.unmount();
    mocks.list.mockReturnValue(new Promise<NativeMemorySnapshot>(() => undefined));
    mount({ queryClient: shared });
    expect(screen.getByRole("button", { name: /MEMORY.md/ })).toBeVisible();
    expect(screen.queryByText(tr("common.loading"))).not.toBeInTheDocument();
  });

  it("does not display a late detail response after workspace changes", async () => {
    let resolve!: (value: NativeMemoryDetail) => void;
    mocks.read.mockReturnValue(
      new Promise<NativeMemoryDetail>((done) => {
        resolve = done;
      }),
    );
    const second = {
      ...workspace,
      id: "workspace-two",
      manifest_workspace_id: "manifest-two",
      name: "Workspace Two",
    };
    mount({ workspaces: [workspace, second] });
    fireEvent.click(await screen.findByRole("button", { name: /MEMORY.md/ }));
    await waitFor(() => expect(mocks.read).toHaveBeenCalled());
    await chooseFilter(tr("memory.native.workspaceFilter"), second.name);
    await act(async () => resolve(detail()));
    expect(screen.queryByText(/Native index/)).not.toBeInTheDocument();
    expect(within(reader()).queryByText(tr("memory.native.readOnly"))).not.toBeInTheDocument();
  });

  it("observes only while visible and focused and unregisters the change listener", async () => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const view = mount();
    await waitFor(() => expect(mocks.observe).toHaveBeenCalledWith(true));
    focus.mockReturnValue(false);
    fireEvent(window, new Event("blur"));
    await waitFor(() => expect(mocks.observe).toHaveBeenLastCalledWith(false));
    focus.mockReturnValue(true);
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(mocks.observe).toHaveBeenLastCalledWith(true));
    const before = mocks.list.mock.calls.length;
    await act(async () => mocks.listener?.());
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(before));
    view.unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.observe).toHaveBeenLastCalledWith(false));
  });

  it("degrades gracefully for old backends and still reviews platform memory", async () => {
    mocks.list.mockRejectedValue(new Error("Unknown RPC nativeMemoryList"));
    mocks.observe.mockRejectedValue(new Error("unsupported"));
    const onReload = vi.fn().mockResolvedValue(undefined);
    mount({ onReload });
    expect(await screen.findByText(tr("memory.native.unsupported"))).toBeVisible();
    openPlatformRecord();
    fireEvent.click(screen.getByRole("button", { name: tr("common.approve") }));
    await waitFor(() =>
      expect(mocks.review).toHaveBeenCalledWith(record.id, "approved", undefined),
    );
    expect(onReload).toHaveBeenCalledOnce();
  });

  it.each([
    ["disabled", "disabled"],
    ["unavailable", "path-unresolved"],
    ["error", "read-failed"],
    ["ready", "limited"],
  ] as const)("distinguishes source status %s and reason %s", async (status, reason) => {
    mocks.list.mockResolvedValue({
      ...snapshot,
      sources: [{ ...source, status, reason, stale: true, incomplete: true }],
    });
    mount();
    await screen.findByText(tr(`memory.native.reason.${reason}`));
    const diagnostics = openDiagnostics();
    expect(within(diagnostics).getByText(tr(`memory.native.reason.${reason}`))).toBeVisible();
    expect(within(diagnostics).getByText(tr(`memory.native.status.${status}`))).toBeVisible();
    expect(within(diagnostics).getByText(tr("memory.native.stale"))).toBeVisible();
    expect(within(diagnostics).getByText(tr("memory.native.incomplete"))).toBeVisible();
  });

  it("keeps the current preview while a newer file version is read in the background", async () => {
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: /MEMORY.md/ }));
    await screen.findByText(/Native index/);
    mocks.list.mockResolvedValue({
      ...snapshot,
      files: [{ ...index, version: "two" }, topic],
      revision: "r2",
    });
    let resolve!: (value: NativeMemoryDetail) => void;
    mocks.read.mockReturnValue(
      new Promise<NativeMemoryDetail>((done) => {
        resolve = done;
      }),
    );
    let updating: Promise<void>;
    act(() => {
      updating = view.queryClient.invalidateQueries({ queryKey: ["native-memory"] });
    });
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Native index/)).toBeVisible();
    await act(async () => {
      resolve({ ...detail({ ...index, version: "two" }), content: "Updated index" });
      await updating;
    });
    expect(await screen.findByText("Updated index")).toBeVisible();
  });

  it("reports a failed native refresh without removing either source or blocking later refreshes", async () => {
    const onReload = vi.fn().mockResolvedValue(undefined);
    mount({ onReload });
    await screen.findByRole("button", { name: /MEMORY.md/ });
    mocks.refresh.mockRejectedValueOnce(new Error("scan failed"));
    const refresh = screen.getByRole("button", { name: tr("common.refresh") });
    fireEvent.click(refresh);
    expect(await screen.findByText(tr("memory.native.refreshError"))).toBeVisible();
    await waitFor(() => expect(refresh).toBeEnabled());
    expect(screen.getByText(record.content)).toBeVisible();
    expect(screen.getByRole("button", { name: /MEMORY.md/ })).toBeVisible();
    fireEvent.click(refresh);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText(tr("memory.native.refreshError"))).not.toBeInTheDocument(),
    );
    expect(onReload).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a pending native preview after switching to AgentKib", async () => {
    let resolve!: (value: NativeMemoryDetail) => void;
    mocks.read.mockReturnValue(
      new Promise<NativeMemoryDetail>((done) => {
        resolve = done;
      }),
    );
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /MEMORY.md/ }));
    await waitFor(() => expect(mocks.read).toHaveBeenCalled());
    await chooseFilter(tr("memory.native.sourceFilter"), tr("memory.native.platform"));
    await act(async () => resolve(detail()));
    expect(screen.queryByText(/Native index/)).not.toBeInTheDocument();
    expect(screen.getByText(record.content)).toBeVisible();
    await waitFor(() => expect(mocks.observe).toHaveBeenLastCalledWith(false));
  });

  it.each(["disabled", "unavailable", "removed"] as const)(
    "purges linked-file previews when their source is %s",
    async (status) => {
      // The linked topic is intentionally outside the loaded list page.
      mocks.list.mockResolvedValue({ ...snapshot, files: [index], total: 1 });
      const view = mount();
      fireEvent.click(await screen.findByRole("button", { name: /MEMORY.md/ }));
      fireEvent.click(await screen.findByRole("button", { name: "Build notes" }));
      await screen.findByText("Topic instructions");
      let resolve!: (value: NativeMemoryDetail) => void;
      mocks.read.mockReturnValue(
        new Promise<NativeMemoryDetail>((done) => {
          resolve = done;
        }),
      );
      let updating: Promise<void>;
      act(() => {
        updating = view.queryClient.invalidateQueries({ queryKey: ["native-memory", "detail"] });
      });
      await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(3));
      mocks.list.mockResolvedValue({
        ...snapshot,
        files: [],
        sources: status === "removed" ? [] : [{ ...source, status }],
        total: 0,
      });
      await act(async () => {
        await view.queryClient.invalidateQueries({ queryKey: ["native-memory", "list"] });
      });
      await waitFor(() => expect(screen.queryByText("Topic instructions")).not.toBeInTheDocument());
      await act(async () => {
        resolve(detail(topic));
        await updating;
      });
      expect(within(reader()).queryByText(tr("memory.native.readOnly"))).not.toBeInTheDocument();
      expect(
        view.queryClient
          .getQueriesData({ queryKey: ["native-memory", "detail", source.id] })
          .every(([, value]) => !value),
      ).toBe(true);
    },
  );

  it.each(["file", "source"] as const)(
    "marks a stale %s preview without claiming it is current",
    async (stalePart) => {
      mocks.read.mockResolvedValue({
        ...detail(),
        file: { ...index, stale: stalePart === "file" },
        source: { ...source, stale: stalePart === "source" },
      });
      mount();
      fireEvent.click(await screen.findByRole("button", { name: /MEMORY.md/ }));
      const region = reader();
      expect(await within(region).findByText(tr("memory.native.stale"))).toBeVisible();
      expect(within(region).getByText(/Native index/)).toBeVisible();
    },
  );

  it.each([
    "Error invoking remote method: AgentKib command failed: native-memory-file-unavailable",
    "AgentKib command failed: Native memory source changed",
  ])(
    "retracts a confirmed unavailable linked topic even while its source remains ready: %s",
    async (message) => {
      mocks.list.mockResolvedValue({ ...snapshot, files: [index], total: 1 });
      const view = mount();
      fireEvent.click(await screen.findByRole("button", { name: /MEMORY.md/ }));
      fireEvent.click(await screen.findByRole("button", { name: "Build notes" }));
      await screen.findByText("Topic instructions");
      mocks.read.mockRejectedValue(new Error(message));
      await act(async () => {
        await view.queryClient.invalidateQueries({ queryKey: ["native-memory", "detail"] });
      });
      expect(await screen.findByText(tr("memory.native.fileUnavailable"))).toBeVisible();
      expect(screen.queryByText("Topic instructions")).not.toBeInTheDocument();
      // Only the removed file's value is replaced; other safe detail caches remain usable.
      expect(
        JSON.stringify(view.queryClient.getQueriesData({ queryKey: ["native-memory", "detail"] })),
      ).not.toContain("Topic instructions");
      expect(screen.getByRole("button", { name: /MEMORY.md/ })).toBeVisible();
      expect(screen.getByText(record.content)).toBeVisible();
    },
  );

  it("groups a large catalog by project and hides routine diagnostics until expanded", async () => {
    const sources: NativeMemorySource[] = Array.from({ length: 60 }, (_, number) => ({
      ...source,
      id: `source-${number}`,
      directory: `/fixture/native-${number}`,
      workspaces: [
        { id: `workspace-${number}`, name: `Project ${String(number).padStart(2, "0")}` },
      ],
      status: number < 35 ? "ready" : "empty",
    }));
    const workspaces: WorkspaceSummary[] = sources.map((item, number) => ({
      ...workspace,
      id: item.workspaces[0].id,
      name: item.workspaces[0].name,
      path: `/projects/project-${number}`,
    }));
    const files: NativeMemoryFile[] = [
      ...sources
        .slice(0, 35)
        .map((item, number) => ({ ...index, id: `index-${number}`, sourceId: item.id })),
      ...Array.from({ length: 60 }, (_, number) => ({
        ...topic,
        id: `topic-${number}`,
        sourceId: sources[number % 35].id,
        relativePath: `topic-${number}.md`,
        title: `Topic title ${number}`,
        excerpt: `Useful excerpt ${number}`,
      })),
    ];
    mocks.list.mockResolvedValue({ ...snapshot, sources, files, total: 95 });
    mocks.read.mockImplementation((id: string) => {
      const file = files.find((item) => item.id === id)!;
      return Promise.resolve({
        file,
        source: sources.find((item) => item.id === file.sourceId)!,
        content: `Content for ${id}`,
        links: [],
      });
    });
    mount({ records: [], workspaces });
    await screen.findByRole("button", { name: /topic-59.md/ });
    const projects = projectList();
    expect(within(projects).getAllByRole("button", { name: /MEMORY.md/ })).toHaveLength(35);
    expect(within(projects).queryByText("Project 59")).not.toBeInTheDocument();
    const diagnostics = screen.getByRole("region", { name: tr("memory.native.diagnostics") });
    expect(within(diagnostics).getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(within(diagnostics).getByText("Project 59")).not.toBeVisible();
    expect(within(projects).queryByText("Useful excerpt 59")).not.toBeInTheDocument();
    projects.scrollTop = 180;
    fireEvent.click(within(projects).getAllByRole("button", { name: /MEMORY.md/ })[0]);
    expect(await within(reader()).findByText("Content for index-0")).toBeVisible();
    expect(projects).not.toContainElement(reader());
    expect(projects.closest(".native-memory-browser")).toContainElement(reader());
    expect(reader().closest("[role=dialog]")).toBeNull();
    expect(projects.scrollTop).toBe(180);
    expect(screen.getAllByRole("region", { name: tr("memory.native.reader") })).toHaveLength(1);
    openDiagnostics();
    expect(within(diagnostics).getByText("Project 59")).toBeVisible();
  });

  it("shows only filenames in the project list without body titles, excerpts or dates", async () => {
    mocks.list.mockResolvedValue({
      ...snapshot,
      files: [
        index,
        { ...topic, title: "Build conventions", excerpt: "Keep releases reproducible" },
      ],
    });
    mount({ records: [] });
    const indexRow = await screen.findByRole("button", { name: /MEMORY.md/ });
    expect(within(indexRow).getByText("MEMORY.md")).toBeVisible();
    expect(within(indexRow).queryByText(tr("memory.native.projectIndex"))).not.toBeInTheDocument();
    const topicRow = screen.getByRole("button", { name: "build-notes.md" });
    expect(within(topicRow).queryByText("Build conventions")).not.toBeInTheDocument();
    expect(within(topicRow).queryByText("Keep releases reproducible")).not.toBeInTheDocument();
    expect(topicRow.querySelector("time")).toBeNull();
  });

  it("keeps project collapse and reader state through a background refresh", async () => {
    mount({ records: [] });
    fireEvent.click(await screen.findByRole("button", { name: /MEMORY.md/ }));
    await within(reader()).findByText(/Native index/);
    const existingReader = reader();
    const scroll = existingReader.querySelector<HTMLElement>(".native-memory-reader-scroll")!;
    expect(scroll).not.toBeNull();
    scroll.scrollTop = 40;
    const projects = projectList();
    const group = within(projects).getByRole("button", { name: /Workspace One/ });
    expect(group).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(group);
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(within(projects).queryByRole("button", { name: /MEMORY.md/ })).not.toBeInTheDocument();
    expect(within(reader()).getByText(/Native index/)).toBeVisible();
    await act(async () => mocks.listener?.());
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(1));
    expect(within(projectList()).getByRole("button", { name: /Workspace One/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(reader()).toBe(existingReader);
    expect(reader().querySelector(".native-memory-reader-scroll")).toBe(scroll);
    expect(scroll.scrollTop).toBe(40);
    expect(within(reader()).getByText(/Native index/)).toBeVisible();
  });

  it("names a shared source after its shortest associated project and expands workspace associations on demand", async () => {
    const main = { ...workspace, name: "Main Project", path: "/fixture/main" };
    const nested = {
      ...workspace,
      id: "nested-workspace",
      name: "Nested Package",
      path: "/fixture/main/packages/nested",
    };
    mocks.list.mockResolvedValue({
      ...snapshot,
      sources: [
        {
          ...source,
          workspaces: [
            { id: nested.id, name: nested.name },
            { id: main.id, name: main.name },
          ],
        },
      ],
    });
    mount({ records: [], workspaces: [nested, main] });
    await screen.findByRole("button", { name: /MEMORY.md/ });
    const projects = projectList();
    expect(within(projects).getByRole("button", { name: /Main Project/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const shared = within(projects).getByRole("button", {
      name: tr("memory.native.sharedWorkspaces", { count: 2 }),
    });
    expect(shared).toHaveAttribute("aria-expanded", "false");
    expect(within(projects).getByText(nested.name)).not.toBeVisible();
    fireEvent.click(shared);
    expect(within(projects).getByText(nested.name)).toBeVisible();
    expect(within(projects).getByText(nested.path)).toBeVisible();
    expect(within(projects).getByText(main.path)).toBeVisible();
  });

  it("retracts a selected file if its source disappears even when a stale list page retains the file", async () => {
    const view = mount({ records: [] });
    fireEvent.click(await screen.findByRole("button", { name: /MEMORY.md/ }));
    await within(reader()).findByText(/Native index/);
    mocks.list.mockResolvedValue({ ...snapshot, sources: [], files: [index], total: 1 });
    await act(async () => {
      await view.queryClient.invalidateQueries({ queryKey: ["native-memory", "list"] });
    });
    await waitFor(() => expect(screen.queryByText(/Native index/)).not.toBeInTheDocument());
    expect(
      within(projectList()).queryByRole("button", { name: /MEMORY.md/ }),
    ).not.toBeInTheDocument();
  });

  it("shows one cached reader in a narrow drawer and returns to the same project list", async () => {
    const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
    try {
      mount({ records: [] });
      fireEvent.click(await screen.findByRole("button", { name: /MEMORY.md/ }));
      const back = await screen.findByRole("button", { name: tr("memory.native.backToList") });
      const dialog = screen.getByRole("dialog", { name: tr("memory.native.reader") });
      expect(await within(reader()).findByText(/Native index/)).toBeVisible();
      expect(dialog).toContainElement(reader());
      expect(screen.getAllByRole("region", { name: tr("memory.native.reader") })).toHaveLength(1);
      fireEvent.click(back);
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: tr("memory.native.reader") }),
        ).not.toBeInTheDocument(),
      );
      fireEvent.click(await screen.findByRole("button", { name: /MEMORY.md/ }));
      expect(await within(reader()).findByText(/Native index/)).toBeVisible();
      expect(mocks.read).toHaveBeenCalledTimes(1);
      expect(screen.getAllByRole("region", { name: tr("memory.native.reader") })).toHaveLength(1);
    } finally {
      if (width) Object.defineProperty(window, "innerWidth", width);
    }
  });

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "has translated controls and wrapping layout in %s",
    async (locale) => {
      await initializeI18n(locale);
      const view = mount();
      await screen.findByRole("button", { name: /MEMORY.md/ });
      expect(screen.getByRole("heading", { name: tr("memory.title") })).toBeVisible();
      expect(screen.getByRole("searchbox", { name: tr("memory.native.search") })).toBeVisible();
      expect(view.container.textContent).not.toContain("memory.native.");
      expect(view.container.firstElementChild).toHaveClass("min-w-0");
      expect(
        screen.getByRole("combobox", { name: tr("memory.native.workspaceFilter") }),
      ).toHaveClass("min-w-0");
    },
  );
});
