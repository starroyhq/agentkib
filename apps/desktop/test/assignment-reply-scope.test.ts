// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { assignmentReplyScope } from "../../../packages/backend/src/assignment-reply-scope";
import { Commands } from "../../../packages/backend/src/commands";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";

it("sees an indexed session change owning workspaces before the catalog is invalidated", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentkib-assignment-reply-scope-"));
  const store = new BackendStore(":memory:");
  const commands = new Commands();
  const readers = new SessionReaders(
    store.sessions,
    commands,
    { HOME: directory, USERPROFILE: directory, CODEX_HOME: directory, PATH: "" },
    { profiles: () => [] },
  );
  try {
    const at = "2026-11-28T00:00:00Z";
    for (const id of ["first", "outside"])
      store.sql.run(
        `INSERT INTO workspaces(id, canonical_path, name, status, last_discovered_at)
         VALUES(?, ?, ?, 'healthy', ?)`,
        id,
        join(directory, id),
        id,
        at,
      );
    const id = store.sessions.id("codex", "fixture-native-thread");
    store.sql.run(
      `INSERT INTO conversation_sessions(id, workspace_id, agent, availability, last_indexed_at)
       VALUES(?, 'first', 'codex', 'readable', ?)`,
      id,
      at,
    );
    const read = () =>
      assignmentReplyScope(
        { operation: "assignment-reply-scope", sessionIds: [id] },
        store,
        readers,
        directory,
        { catalog: () => [] },
        true,
      );

    expect(read()).toEqual({
      workspaces: ["first", "outside"],
      sessions: [{ id, workspace_id: "first", indexedSessionIds: [] }],
    });
    // Commit a new owner for the same opaque ID without changing the workspace set
    // or sending the catalog invalidation that normally follows the index write.
    store.sql.run("UPDATE conversation_sessions SET workspace_id = 'outside' WHERE id = ?", id);
    expect(read()).toEqual({
      workspaces: ["first", "outside"],
      sessions: [{ id, workspace_id: "outside", indexedSessionIds: [] }],
    });
  } finally {
    readers.close();
    commands.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
