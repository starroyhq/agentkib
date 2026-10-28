import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionIndex } from "../../../packages/backend/src/session-index";
import type { NativeSession } from "../../../packages/backend/src/session-store";
import { BackendStore } from "../../../packages/backend/src/store";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-session-forget-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Fixture",
    "healthy",
    "2026-10-28T00:00:00Z",
  );
  const session = (nativeRef: string): NativeSession => ({
    native_ref: nativeRef,
    agent: "codex",
    title: nativeRef,
    created_at: "2026-10-28T00:00:00Z",
    updated_at: "2026-10-28T00:00:00Z",
    message_count: 2,
    git_branch: null,
    archived: false,
    sidechain: false,
    availability: "readable",
    origin: "interactive",
  });
  store.sessions.sync("workspace", "codex", [session("kept"), session("deleted")]);
  return {
    store,
    kept: store.sessions.id("codex", "kept"),
    deleted: store.sessions.id("codex", "deleted"),
  };
}

describe("Forgetting a deleted conversation", () => {
  it("drops only its index row and recounts the workspace", () => {
    const f = fixture();
    expect(f.store.sessions.status("workspace")[0]).toMatchObject({ session_count: 2 });
    f.store.sessions.forget([f.deleted, "never-indexed"]);
    expect(f.store.sessions.get(f.deleted)).toBeNull();
    expect(f.store.sessions.get(f.kept)).toMatchObject({ title: "kept" });
    expect(f.store.sessions.list("workspace").map((row) => row.id)).toEqual([f.kept]);
    expect(f.store.sessions.status("workspace")[0]).toMatchObject({ session_count: 1 });
  });

  it("discards scans already reading it and refreshes what depends on the index", () => {
    const f = fixture();
    const refreshed = vi.fn();
    const index = new SessionIndex(f.store.sessions, { list: vi.fn() }, () => true, refreshed);
    const before = index.generation();
    index.forget([f.deleted]);
    expect(index.generation()).toBe(before + 1n);
    expect(refreshed).toHaveBeenCalledOnce();
    expect(f.store.sessions.get(f.deleted)).toBeNull();
  });
});
