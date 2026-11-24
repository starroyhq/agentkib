import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_METHODS, SESSION_COLLECTIONS } from "@agentkib/runtime-protocol";
import { BackendStore } from "../../../packages/backend/src/store";
import { SessionPins } from "../../../packages/backend/src/session-pins";
import { startBackend } from "./session-baseline/harness";

const local = {
  id: "indexed",
  agent: "claude-code",
  workspace_id: "workspace",
  archived: false,
  sidechain: false,
};
const codex = { ...local, id: "codex", agent: "codex" };
const dsh = { ...local, id: "dsh", agent: "deepseek-harness" };
let directory: string;
let database: string;
let store: BackendStore;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "agentkib-session-pins-"));
  database = path.join(directory, "agentkib.db");
  store = new BackendStore(database);
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("session pins", () => {
  it("keeps local pins after reopening and clears a pin through its managed identity", async () => {
    await expect(new SessionPins(store.sql, {}).set(local, true)).resolves.toBe(true);
    store.close();
    store = new BackendStore(database);
    const pins = new SessionPins(store.sql, {});
    const managed = { ...local, id: "managed", indexedSessionIds: ["indexed"] };
    expect(pins.project([managed])).toEqual([{ ...managed, pinned: true, pinningAvailable: true }]);
    await expect(pins.set(managed, false)).resolves.toBe(false);
    expect(pins.project([local])).toEqual([{ ...local, pinned: false, pinningAvailable: true }]);
  });

  it("uses local pins on older Codex and prefers a verified native state when available", async () => {
    const states = new Map<string, { pinned: boolean; available: boolean }>();
    const change = vi.fn(async (_id, pinned: boolean) => {
      states.set(codex.id, { pinned, available: true });
      return pinned;
    });
    const pins = new SessionPins(store.sql, { codex: { states: () => states, set: change } });
    await expect(pins.set(codex, true)).resolves.toBe(true);
    expect(change).not.toHaveBeenCalled();
    states.set(codex.id, { pinned: false, available: true });
    expect(pins.project([codex])[0]).toMatchObject({ pinned: false, pinningAvailable: true });
    await expect(pins.set(codex, true)).resolves.toBe(true);
    expect(change).toHaveBeenCalledExactlyOnceWith(codex.id, true);
    states.set(codex.id, { pinned: false, available: false });
    await expect(pins.set(codex, true)).rejects.toThrow("session-pin-unavailable");
    expect(pins.project([codex])[0]).toMatchObject({ pinned: false, pinningAvailable: false });
  });

  it("keeps the last native state read-only while DSH's connection is unavailable", async () => {
    const pins = new SessionPins(store.sql, {
      "deepseek-harness": {
        states: () => new Map([[dsh.id, { pinned: true, available: false }]]),
        set: vi.fn(),
      },
    });
    const unavailable = new SessionPins(store.sql, {});
    expect(unavailable.project([dsh])[0]).toMatchObject({ pinned: false, pinningAvailable: false });
    await expect(unavailable.set(dsh, true)).rejects.toThrow("session-pin-unavailable");
    expect(pins.project([dsh])[0]).toMatchObject({ pinned: true, pinningAvailable: false });
    await expect(pins.set(dsh, false)).rejects.toThrow("session-pin-unavailable");
    expect(pins.project([{ ...local, sidechain: true }])[0]).toMatchObject({
      pinned: false,
      pinningAvailable: false,
    });
  });

  it("rejects an overlapping write until the native result is confirmed", async () => {
    let finish!: (pinned: boolean) => void;
    const change = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const pins = new SessionPins(store.sql, {
      "deepseek-harness": {
        states: () => new Map([[dsh.id, { pinned: false, available: true }]]),
        set: change,
      },
    });
    const pending = pins.set(dsh, true);
    await expect(pins.set(dsh, false)).rejects.toThrow("session-pin-busy");
    finish(false);
    await expect(pending).rejects.toThrow("session-pin-unavailable");
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("pins a desktop collection via the private scope and surfaces it in the index", async () => {
    const workspace = path.join(directory, "workspace");
    const home = path.join(directory, "home");
    mkdirSync(workspace);
    mkdirSync(home);
    writeFileSync(
      path.join(directory, "preferences.json"),
      JSON.stringify({ session_index_enabled: true }),
    );
    const workspaceId = SESSION_COLLECTIONS.projectless;
    const nativeId = "01973f2a-4fd1-7731-8f54-56bc3c3a6129";
    store.sessions.sync(workspaceId, "codex", [
      {
        native_ref: nativeId,
        title: "Fixture collection session",
        agent: "codex",
        origin: "interactive",
        archived: false,
        sidechain: false,
        availability: "metadata-only",
        message_count: null,
        created_at: null,
        updated_at: null,
        git_branch: null,
      },
    ]);
    const sessionId = store.sessions.id("codex", nativeId);
    const runtime = await startBackend({
      data: directory,
      workspace,
      environment: { HOME: home, PATH: home },
      reuseData: true,
    });
    try {
      const pin = { operation: "session-pin", sessionId, pinned: true };
      await expect(
        runtime.rpc(RUNTIME_METHODS.webRequest, { ...pin, workspaceId }),
      ).rejects.toThrow();
      await expect(runtime.rpc(RUNTIME_METHODS.webRequest, pin)).resolves.toEqual({ pinned: true });
      await expect(
        runtime.rpc(RUNTIME_METHODS.workspaceSessions, { workspaceId }),
      ).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: sessionId, pinned: true })]),
      );
    } finally {
      await runtime.close();
    }
  });
});
