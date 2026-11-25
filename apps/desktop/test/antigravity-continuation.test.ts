// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { homeSessionGroups, workStoppedByQuit, type HomeSession } from "@agentkib/session-catalog";
import { AntigravityManagedRunner } from "../../../packages/backend/src/agents/antigravity/antigravity-managed-runner";
import { Commands } from "../../../packages/backend/src/commands";
import {
  claimManagedCommand,
  dispatchManagedCommand,
} from "../../../packages/backend/src/managed-ledger";
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
  const environment = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"),
    AGENTKIB_ENABLE_ANTIGRAVITY_ACP: "1",
  };
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
  const state = { status: "idle", reason: null as string | null, revision: 0, connected: false };
  const runner = {
    get connected() {
      return state.connected;
    },
    snapshot: () => ({
      executionMode: "acp-managed",
      status: state.status,
      revision: state.revision,
      turnId: state.status === "idle" ? null : "turn",
      sendEnabled: state.status === "idle",
      stopEnabled: state.status !== "idle",
      approvals: [],
      reason: state.reason,
    }),
    send: vi.fn(async (_text: string, revision: number, beforeDispatch?: () => void) => {
      if (revision !== state.revision) throw new Error("stale Antigravity revision");
      beforeDispatch?.();
      state.revision++;
    }),
    close: () => {
      state.connected = false;
    },
  } as unknown as AntigravityManagedRunner;
  const connect = vi
    .spyOn(AntigravityManagedRunner, "connect")
    .mockImplementation(
      async (_executable, _workspace, _nativeId, _env, _publish, _recover, initialRevision = 0) => {
        Object.assign(state, {
          connected: true,
          status: "idle",
          reason: null,
          revision: initialRevision,
        });
        return runner;
      },
    );
  const web = new WebReadRequests(store, readers, root, () => 0n, environment);
  cleanups.push(() => web.closeAsync());
  const row = async () =>
    (
      (await web.request({ operation: "catalog" })) as {
        sessions: Array<HomeSession & { continuation?: Record<string, unknown> }>;
      }
    ).sessions.find((session) => session.id === id)!;
  const live = async () =>
    (await web.request({
      operation: "live",
      sessionId: id,
      experimentalEnabled: true,
    })) as { runtimeBootId: string; revision: number };
  return { web, id, state, row, connect, live, root };
}

describe("Antigravity sessions run by AgentKib", () => {
  it("keeps a newer revision when a disconnected transport is prepared by a subsequent send", async () => {
    const f = fixture();
    const first = await f.live();
    await f.web.managedControl({
      operation: "send",
      sessionId: f.id,
      requestId: randomUUID(),
      runtimeBootId: first.runtimeBootId,
      expectedRevision: first.revision,
      experimentalEnabled: true,
      text: "First message",
    });
    const previous = await f.live();
    Object.assign(f.state, { connected: false, status: "failed", revision: previous.revision + 1 });
    const inactive = await f.live();
    expect(inactive).toMatchObject({ status: "idle", sendEnabled: true });
    expect(inactive.revision).toBeGreaterThan(f.state.revision);
    const send = (revision: number) =>
      f.web.managedControl({
        operation: "send",
        sessionId: f.id,
        requestId: randomUUID(),
        runtimeBootId: inactive.runtimeBootId,
        expectedRevision: revision,
        experimentalEnabled: true,
        text: "A subsequent message",
      });
    expect(f.connect).toHaveBeenCalledOnce();
    await expect(send(previous.revision)).rejects.toThrow("stale-or-disabled-control");
    expect(f.connect).toHaveBeenCalledOnce();
    await expect(send(inactive.revision)).resolves.toMatchObject({ accepted: true });
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect((await f.live()).revision).toBeGreaterThan(inactive.revision);
  });

  it("blocks controls on cached and disconnected transports while an original receipt is unknown", async () => {
    const f = fixture();
    const first = await f.live();
    await f.web.managedControl({
      operation: "send",
      sessionId: f.id,
      requestId: randomUUID(),
      runtimeBootId: first.runtimeBootId,
      expectedRevision: first.revision,
      experimentalEnabled: true,
      text: "First message",
    });
    const requestId = randomUUID();
    claimManagedCommand(f.root, requestId, f.id, "unknown-message", "fixture", {
      operation: "send",
      executionMode: "antigravity-acp-managed",
    });
    dispatchManagedCommand(f.root, requestId);
    for (const connected of [true, false]) {
      f.state.connected = connected;
      const live = await f.live();
      expect(live).toMatchObject({
        status: "outcome-unknown",
        sendEnabled: false,
        stopEnabled: false,
      });
      await expect(
        f.web.managedControl({
          operation: "send",
          sessionId: f.id,
          requestId: randomUUID(),
          runtimeBootId: live.runtimeBootId,
          expectedRevision: live.revision,
          experimentalEnabled: true,
          text: "Must not dispatch",
        }),
      ).rejects.toThrow("control-outcome-unconfirmed");
    }
    expect(f.connect).toHaveBeenCalledOnce();
  });

  it("show a running turn and a permission it waits for in the catalog, as Devin's do", async () => {
    const f = fixture();
    // Before AgentKib holds a runner the row says nothing about a turn.
    expect((await f.row()).continuation).toBeUndefined();
    const live = (await f.web.request({
      operation: "live",
      sessionId: f.id,
      experimentalEnabled: true,
    })) as { runtimeBootId: string; revision: number };
    expect((await f.row()).continuation).toBeUndefined();
    expect(f.connect).not.toHaveBeenCalled();
    await f.web.managedControl({
      operation: "send",
      sessionId: f.id,
      requestId: randomUUID(),
      runtimeBootId: live.runtimeBootId,
      expectedRevision: live.revision,
      experimentalEnabled: true,
      text: "Continue the original session",
    });
    expect(f.connect).toHaveBeenCalledOnce();
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
