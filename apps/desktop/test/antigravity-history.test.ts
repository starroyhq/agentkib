// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AntigravityLocalRecord } from "../../../packages/backend/src/antigravity-local-store";
import type { ConversationEventPage } from "../../../packages/backend/src/session-events";
import {
  AntigravityHistory,
  antigravityLocalRef,
} from "../../../packages/backend/src/antigravity-history";

const sources = vi.hoisted(() => ({
  acp: {
    list: vi.fn(),
    close: vi.fn(),
    controlExecutable: vi.fn(),
    readHandoff: vi.fn(),
    readDocument: vi.fn(),
    readEvents: vi.fn(),
  },
  local: { list: vi.fn(), events: vi.fn() },
  runtime: { list: vi.fn(), available: vi.fn(), events: vi.fn() },
}));
vi.mock("../../../packages/backend/src/antigravity-sessions", () => ({
  AntigravitySessions: class {
    list = sources.acp.list;
    close = sources.acp.close;
    controlExecutable = sources.acp.controlExecutable;
    readHandoff = sources.acp.readHandoff;
    readDocument = sources.acp.readDocument;
    readEvents = sources.acp.readEvents;
  },
}));
vi.mock("../../../packages/backend/src/antigravity-local-store", () => ({
  AntigravityLocalStore: class {
    list = sources.local.list;
    events = sources.local.events;
  },
}));
vi.mock("../../../packages/backend/src/antigravity-local-runtime", () => ({
  AntigravityLocalRuntime: class {
    list = sources.runtime.list;
    available = sources.runtime.available;
    events = sources.runtime.events;
  },
}));
const ID = "12345678-1234-1234-1234-123456789abc";
const OTHER_ID = "12345678-1234-1234-1234-123456789abd";
const workspace = "/synthetic/antigravity/workspace";
const otherWorkspace = "/synthetic/antigravity/other-workspace";
const record = (
  surface: "app" | "ide",
  id = ID,
  directory = workspace,
): AntigravityLocalRecord => ({
  surface,
  id,
  workspace: directory,
  title: `${surface} title`,
  created_at: null,
  updated_at: "2026-11-10T00:00:00Z",
  message_count: null,
  availability: "readable",
});
const page = (content: string): ConversationEventPage => ({
  events: [
    {
      id: content,
      kind: "agent-message",
      timestamp: null,
      content,
      tool_name: null,
      tool_status: null,
      duration_ms: null,
      attachment_count: 0,
      truncated: false,
    },
  ],
  next_cursor: null,
  warnings: [],
});
function localRecords(records: AntigravityLocalRecord[]) {
  sources.local.list.mockImplementation((directory?: string) => ({
    records: records.filter((value) => directory === undefined || value.workspace === directory),
    incomplete: false,
  }));
}
beforeEach(() => {
  for (const group of Object.values(sources))
    for (const mock of Object.values(group)) mock.mockReset();
  sources.acp.list.mockResolvedValue({ sessions: [], incomplete: false });
  localRecords([]);
  sources.runtime.available.mockReturnValue(false);
  sources.runtime.list.mockResolvedValue([]);
  sources.runtime.events.mockResolvedValue(null);
  sources.local.events.mockReturnValue(page("offline preview"));
});

describe("Antigravity read-only history aggregation", () => {
  it.each([
    ["app", "ide"],
    ["ide", "app"],
  ] as const)(
    "deduplicates migrated UUID and workspace pairs and prefers App on a timestamp tie (%s first)",
    async (first, second) => {
      localRecords([record(first), record(second)]);
      const listing = await new AntigravityHistory({}).list(workspace);
      expect(listing.incomplete).toBe(false);
      expect(listing.sessions).toHaveLength(1);
      expect(listing.sessions[0]).toMatchObject({
        native_ref: antigravityLocalRef("app", ID),
        title: "app title",
        cwd: workspace,
        availability: "readable",
      });
    },
  );
  it("prefers the newer IDE history over an older migrated App copy", async () => {
    localRecords([
      { ...record("ide"), updated_at: "2026-11-10T01:00:00Z", title: "newer IDE title" },
      { ...record("app"), updated_at: "2026-11-10T00:00:00Z", title: "older App title" },
    ]);
    const listing = await new AntigravityHistory({}).list(workspace);
    expect(listing.sessions).toHaveLength(1);
    expect(listing.sessions[0]).toMatchObject({
      native_ref: antigravityLocalRef("ide", ID),
      title: "newer IDE title",
      updated_at: "2026-11-10T01:00:00Z",
      cwd: workspace,
    });
  });
  it("keeps distinct UUIDs separate", async () => {
    localRecords([record("app"), record("ide", OTHER_ID)]);
    const listing = await new AntigravityHistory({}).list(workspace);
    expect(new Set(listing.sessions.map((value) => value.native_ref)).size).toBe(2);
  });
  it("keeps workspace ownership separate even when native UUIDs match", async () => {
    localRecords([record("app"), record("ide", ID, otherWorkspace)]);
    const history = new AntigravityHistory({});
    const first = await history.list(workspace),
      second = await history.list(otherWorkspace);
    expect(first.sessions).toHaveLength(1);
    expect(second.sessions).toHaveLength(1);
    expect(first.sessions[0]?.native_ref).toBe(antigravityLocalRef("app", ID));
    expect(second.sessions[0]?.native_ref).toBe(antigravityLocalRef("ide", ID));
    expect(first.sessions[0]?.cwd).not.toBe(second.sessions[0]?.cwd);
  });
  it("does not report a missing optional ACP server as a failed local source", async () => {
    localRecords([record("app")]);
    expect(await new AntigravityHistory({}).list(workspace)).toMatchObject({
      incomplete: false,
      sessions: [{ native_ref: antigravityLocalRef("app", ID) }],
    });
    localRecords([]);
    expect(await new AntigravityHistory({}).list(workspace)).toEqual({
      incomplete: false,
      sessions: [],
    });
  });
  it("preserves local sessions and records incompleteness when configured ACP fails", async () => {
    localRecords([record("app")]);
    sources.acp.list.mockRejectedValue(new Error("configured server failed"));
    expect(await new AntigravityHistory({}).list(workspace)).toMatchObject({
      incomplete: true,
      sessions: [{ native_ref: antigravityLocalRef("app", ID) }],
    });
  });
  it("keeps source failure visible if no local history can be retained", async () => {
    sources.acp.list.mockRejectedValue(new Error("configured server failed"));
    await expect(new AntigravityHistory({}).list(workspace)).rejects.toThrow();
  });
  it("preserves genuine offline index failure with other successful sources", async () => {
    sources.local.list.mockReturnValue({ records: [record("app")], incomplete: true });
    expect((await new AntigravityHistory({}).list(workspace)).incomplete).toBe(true);
  });
  it("never sends local history to writable ACP document or handoff paths", () => {
    const history = new AntigravityHistory({});
    for (const surface of ["app", "ide"] as const) {
      const ref = antigravityLocalRef(surface, ID);
      expect(() => history.readHandoff(ref)).toThrow("read-only");
      expect(() =>
        history.readDocument(ref, {
          agent: "antigravity",
          workspace_id: "workspace",
          title: null,
          created_at: null,
          updated_at: null,
          git_branch: null,
        }),
      ).toThrow("complete history");
    }
    expect(sources.acp.readHandoff).not.toHaveBeenCalled();
    expect(sources.acp.readDocument).not.toHaveBeenCalled();
  });
  it("rejects malformed or foreign-workspace references before reading either source", async () => {
    localRecords([record("app")]);
    const history = new AntigravityHistory({});
    await expect(
      history.readEvents(antigravityLocalRef("app", ID), null, 20, otherWorkspace),
    ).rejects.toThrow("workspace");
    await expect(history.readEvents(antigravityLocalRef("app", ID), null, 20)).rejects.toThrow(
      "workspace",
    );
    await expect(
      history.readEvents("antigravity-local-v1-app-../escape", null, 20, workspace),
    ).rejects.toThrow("reference");
    expect(sources.runtime.events).not.toHaveBeenCalled();
    expect(sources.local.events).not.toHaveBeenCalled();
  });
  it("prefers verified native body over offline search text", async () => {
    const source = record("app");
    localRecords([source]);
    sources.runtime.events.mockResolvedValue(page("native body"));
    expect(
      await new AntigravityHistory({}).readEvents(
        antigravityLocalRef("app", ID),
        null,
        20,
        workspace,
      ),
    ).toEqual(page("native body"));
    expect(sources.runtime.events).toHaveBeenCalledWith(source, null, 20);
    expect(sources.local.events).not.toHaveBeenCalled();
  });
  it("uses offline FTS when no native daemon is running", async () => {
    localRecords([record("app")]);
    expect(
      await new AntigravityHistory({}).readEvents(
        antigravityLocalRef("app", ID),
        null,
        20,
        workspace,
      ),
    ).toEqual(page("offline preview"));
    expect(sources.local.events).toHaveBeenCalledWith("app", ID, workspace, null, 20);
  });
  it("falls back only on an initial native read failure and explicitly readable offline history", async () => {
    localRecords([record("app")]);
    sources.runtime.events.mockRejectedValue(new Error("daemon disappeared"));
    expect(
      await new AntigravityHistory({}).readEvents(
        antigravityLocalRef("app", ID),
        null,
        20,
        workspace,
      ),
    ).toEqual(page("offline preview"));
    localRecords([{ ...record("app"), availability: "metadata-only" }]);
    sources.local.events.mockClear();
    await expect(
      new AntigravityHistory({}).readEvents(antigravityLocalRef("app", ID), null, 20, workspace),
    ).rejects.toThrow();
    expect(sources.local.events).not.toHaveBeenCalled();
  });
  it("never retries a failed native cursor against offline FTS", async () => {
    localRecords([record("app")]);
    sources.runtime.events.mockRejectedValue(new Error("native cursor changed"));
    await expect(
      new AntigravityHistory({}).readEvents(
        antigravityLocalRef("app", ID),
        "native-cursor",
        20,
        workspace,
      ),
    ).rejects.toThrow();
    expect(sources.local.events).not.toHaveBeenCalled();
  });
  it("never changes pagination source when the native daemon disappears", async () => {
    localRecords([record("app")]);
    sources.runtime.events.mockResolvedValue(null);
    await expect(
      new AntigravityHistory({}).readEvents(
        antigravityLocalRef("app", ID),
        `antigravity-local-native-v1-${"a".repeat(24)}-10`,
        20,
        workspace,
      ),
    ).rejects.toThrow();
    expect(sources.local.events).not.toHaveBeenCalled();
  });
  it("keeps offline pagination on the search projection after the native daemon becomes available", async () => {
    localRecords([record("app")]);
    sources.runtime.available.mockReturnValue(true);
    sources.runtime.events.mockResolvedValue(page("new live native body"));
    const cursor = `antigravity-local-v1-${"b".repeat(64)}-10`;
    expect(
      await new AntigravityHistory({}).readEvents(
        antigravityLocalRef("app", ID),
        cursor,
        20,
        workspace,
      ),
    ).toEqual(page("offline preview"));
    expect(sources.runtime.events).not.toHaveBeenCalled();
    expect(sources.local.events).toHaveBeenCalledWith("app", ID, workspace, cursor, 20);
  });
  it("shows native IDE-only history that has no offline summary", async () => {
    sources.runtime.available.mockImplementation((surface) => surface === "ide");
    const source = record("ide");
    sources.runtime.list.mockImplementation(async (surface) => (surface === "ide" ? [source] : []));
    sources.runtime.events.mockResolvedValue(page("IDE native body"));
    const history = new AntigravityHistory({});
    expect(await history.list(workspace)).toMatchObject({
      incomplete: false,
      sessions: [{ native_ref: antigravityLocalRef("ide", ID), availability: "readable" }],
    });
    expect(await history.readEvents(antigravityLocalRef("ide", ID), null, 20, workspace)).toEqual(
      page("IDE native body"),
    );
    expect(sources.local.events).not.toHaveBeenCalled();
  });
  it("does not leak native runtime records belonging to a different workspace", async () => {
    sources.runtime.available.mockReturnValue(true);
    sources.runtime.list.mockResolvedValue([record("ide", ID, otherWorkspace)]);
    expect((await new AntigravityHistory({}).list(workspace)).sessions).toEqual([]);
    await expect(
      new AntigravityHistory({}).readEvents(antigravityLocalRef("ide", ID), null, 20, workspace),
    ).rejects.toThrow("workspace");
    expect(sources.runtime.events).not.toHaveBeenCalled();
  });
  it("rejects stale local workspace ownership when the live record has moved elsewhere", async () => {
    localRecords([record("app")]);
    sources.runtime.available.mockImplementation((surface) => surface === "app");
    sources.runtime.list.mockImplementation(async (surface) =>
      surface === "app" ? [record("app", ID, otherWorkspace)] : [],
    );
    sources.runtime.events.mockResolvedValue(page("moved private history"));
    const history = new AntigravityHistory({});
    expect((await history.list(workspace)).sessions).toEqual([]);
    await expect(
      history.readEvents(antigravityLocalRef("app", ID), null, 20, workspace),
    ).rejects.toThrow("workspace");
    expect(sources.runtime.events).not.toHaveBeenCalled();
    expect(sources.local.events).not.toHaveBeenCalled();
    expect((await history.list(otherWorkspace)).sessions[0]?.cwd).toBe(otherWorkspace);
  });
  it("retains local history when live directory discovery fails", async () => {
    localRecords([record("app")]);
    sources.runtime.available.mockReturnValue(true);
    sources.runtime.list.mockRejectedValue(new Error("runtime unavailable"));
    expect(await new AntigravityHistory({}).list(workspace)).toMatchObject({
      incomplete: true,
      sessions: [{ native_ref: antigravityLocalRef("app", ID) }],
    });
  });
  it("leaves ACP identity routing intact and closes its subprocess provider", async () => {
    sources.acp.readEvents.mockResolvedValue(page("ACP body"));
    const history = new AntigravityHistory({});
    expect(await history.readEvents("opaque-acp-session", null, 20, workspace)).toEqual(
      page("ACP body"),
    );
    expect(sources.acp.readEvents).toHaveBeenCalledWith("opaque-acp-session", null, 20);
    expect(sources.runtime.events).not.toHaveBeenCalled();
    history.close();
    expect(sources.acp.close).toHaveBeenCalledOnce();
  });
});
