// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { homeSessionGroups, workStoppedByQuit, type HomeSession } from "@agentkib/session-catalog";
import { AntigravityManagedRunner } from "../../../packages/backend/src/antigravity-managed-runner";
import { Commands } from "../../../packages/backend/src/commands";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { NativeSession } from "../../../packages/backend/src/session-store";
import { BackendStore } from "../../../packages/backend/src/store";
import { WebReadRequests } from "../../../packages/backend/src/web-read";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

/** An Antigravity ACP session whose runner reports `status`, as the runner's snapshot does. */
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-antigravity-turn-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Fixture",
    "healthy",
    "2026-11-16T00:00:00Z",
  );
  const native: NativeSession = {
    native_ref: "synthetic-acp-session",
    agent: "antigravity",
    title: "Synthetic ACP session",
    origin: "interactive",
    created_at: null,
    updated_at: null,
    message_count: 2,
    git_branch: null,
    archived: false,
    sidechain: false,
    availability: "readable",
  };
  store.sessions.sync("workspace", "antigravity", [native]);
  const id = store.sessions.id("antigravity", native.native_ref);
  const environment = { HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, "codex") };
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const readers = new SessionReaders(store.sessions, commands, environment, { profiles: () => [] });
  cleanups.push(() => readers.close());
  vi.spyOn(readers, "resolve").mockResolvedValue({
    summary: store.sessions.get(id)!,
    native,
    workspace,
  });
  vi.spyOn(readers, "antigravityControlExecutable").mockReturnValue("/synthetic/acp");
  const state = { status: "idle", reason: null as string | null };
  vi.spyOn(AntigravityManagedRunner, "connect").mockResolvedValue({
    connected: true,
    snapshot: () => ({
      executionMode: "acp-managed",
      status: state.status,
      revision: 1,
      turnId: state.status === "idle" ? null : "turn",
      sendEnabled: state.status === "idle",
      stopEnabled: state.status !== "idle",
      approvals: [],
      reason: state.reason,
    }),
    close: () => undefined,
  } as unknown as AntigravityManagedRunner);
  const web = new WebReadRequests(store, readers, root, () => 0n, environment);
  cleanups.push(() => web.closeAsync());
  const row = async () =>
    (
      (await web.request({ operation: "catalog" })) as {
        sessions: Array<HomeSession & { continuation?: Record<string, unknown> }>;
      }
    ).sessions.find((session) => session.id === id)!;
  return { web, id, state, row };
}

describe("Antigravity sessions run by AgentKib", () => {
  it("show a running turn and a permission it waits for in the catalog, as Devin's do", async () => {
    const f = fixture();
    // Before AgentKib holds a runner the row says nothing about a turn.
    expect((await f.row()).continuation).toBeUndefined();
    await f.web.request({ operation: "live", sessionId: f.id, experimentalEnabled: true });
    expect((await f.row()).continuation).toEqual({
      status: "idle",
      executionLocation: "agentkib",
      ownershipReason: null,
      reason: null,
    });
    f.state.status = "running";
    const running = await f.row();
    expect(running.continuation).toMatchObject({
      status: "running",
      executionLocation: "agentkib",
    });
    expect(homeSessionGroups([running]).running).toHaveLength(1);
    // Quitting AgentKib ends the ACP process its turn runs in.
    expect(workStoppedByQuit([running]).map((session) => session.id)).toEqual([f.id]);
    f.state.status = "waiting-approval";
    const waiting = await f.row();
    expect(homeSessionGroups([waiting]).needsYou).toEqual([{ session: waiting, need: "approval" }]);
    expect(workStoppedByQuit([waiting])).toHaveLength(1);
    f.state.status = "outcome-unknown";
    expect(homeSessionGroups([await f.row()]).needsYou).toEqual([
      expect.objectContaining({ need: "verify" }),
    ]);
    f.state.status = "idle";
    expect(workStoppedByQuit([await f.row()])).toEqual([]);
  });
});
