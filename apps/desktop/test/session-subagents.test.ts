// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import { codexRollouts } from "../../../packages/backend/src/codex-rollout-files";
import {
  SessionSubagents,
  projectSubagentObservations,
  type SubagentParent,
  type SubagentObservation,
} from "../../../packages/backend/src/session-subagents";

const folders: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function fixture(agent: "codex" | "claude-code" = "codex") {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-subagents-")));
  folders.push(directory);
  const nativeId = randomUUID(),
    sessionId = "opaque-parent",
    transcript = path.join(directory, `${nativeId}.jsonl`);
  writeFileSync(transcript, "");
  return {
    directory,
    reader: new SessionSubagents("synthetic-salt"),
    parent: {
      sessionId,
      nativeId,
      workspace: directory,
      transcript,
      agent,
    } satisfies SubagentParent,
  };
}
const write = (file: string, rows: unknown[]) =>
  writeFileSync(file, rows.map((value) => JSON.stringify(value)).join("\n") + "\n");
const stamp = "2026-11-02T00:00:00Z";
function codexChild(
  f: ReturnType<typeof fixture>,
  body: unknown[] = [],
  parentId = f.parent.nativeId,
) {
  const nativeId = randomUUID(),
    transcript = path.join(f.directory, `${nativeId}.jsonl`);
  write(transcript, [
    {
      type: "session_meta",
      payload: {
        id: nativeId,
        cwd: f.directory,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId } } },
      },
    },
    ...body,
  ]);
  return { nativeId, parentNativeId: parentId, transcript, name: "Reviewer" };
}
function claudeChild(f: ReturnType<typeof fixture>, agentId = "test-worker") {
  const folder = path.join(f.directory, f.parent.nativeId, "subagents");
  mkdirSync(folder, { recursive: true });
  const transcript = path.join(folder, `agent-${agentId}.jsonl`);
  write(transcript, [
    {
      type: "user",
      uuid: randomUUID(),
      sessionId: f.parent.nativeId,
      agentId,
      isSidechain: true,
      cwd: f.directory,
      timestamp: stamp,
      message: { role: "user", content: "Synthetic child task" },
    },
    {
      type: "assistant",
      uuid: randomUUID(),
      sessionId: f.parent.nativeId,
      agentId,
      isSidechain: true,
      cwd: f.directory,
      timestamp: stamp,
      message: { role: "assistant", content: [{ type: "text", text: "Synthetic child result" }] },
    },
  ]);
  return { agentId, transcript, folder };
}
describe("parent-scoped subagent reads", () => {
  it("reads Codex child messages and confirms activity only in the resident parent's current turn", async () => {
    const f = fixture(),
      child = codexChild(f, [
        { type: "event_msg", payload: { type: "task_started", turn_id: "child-turn" } },
        {
          type: "event_msg",
          timestamp: stamp,
          payload: { type: "agent_message", message: "Synthetic Codex result" },
        },
      ]);
    write(f.parent.transcript, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "parent-turn" } },
      {
        type: "response_item",
        payload: { type: "SubAgentActivity", kind: "started", agent_thread_id: child.nativeId },
      },
    ]);
    const parent = {
      ...f.parent,
      running: true,
      turnId: "parent-turn",
      connected: true,
      observerId: "connection-1",
    };
    const catalog = await f.reader.list(parent, [child]);
    expect(catalog.agents).toHaveLength(1);
    expect(catalog.agents[0]).toMatchObject({
      name: "Reviewer",
      status: "running",
      readable: true,
      agent: "codex",
    });
    const page = await f.reader.events(parent, catalog.agents[0].id, null, 50, [child]);
    expect(page.events.some((value) => value.content === "Synthetic Codex result")).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain(child.nativeId);
    expect(JSON.stringify(catalog)).not.toContain(f.directory);
    expect(
      (await f.reader.list({ ...parent, running: false, connected: false }, [child])).agents[0]
        .status,
    ).toBe("unknown");
    expect(
      (
        await f.reader.list(
          { ...parent, turnId: "later-parent-turn", observerId: "connection-2" },
          [child],
        )
      ).agents[0].status,
    ).toBe("unknown");
  });
  it("keeps completed status on historical Codex children without claiming process liveness", async () => {
    const f = fixture(),
      child = codexChild(f, [
        { type: "event_msg", payload: { type: "task_complete", turn_id: "done" } },
      ]);
    expect((await f.reader.list(f.parent, [child])).agents[0].status).toBe("completed");
  });
  it("reports an explicitly failed Codex child turn separately from successful completion", async () => {
    const f = fixture(),
      child = codexChild(f, [
        {
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "failed",
            error: { message: "Synthetic failed child", codexErrorInfo: "other" },
          },
        },
      ]);
    expect((await f.reader.list(f.parent, [child])).agents[0].status).toBe("failed");
  });
  it("verifies compressed Codex children from a bounded prefix and materializes only the selected history", async () => {
    const f = fixture(),
      child = codexChild(f, [
        {
          type: "event_msg",
          timestamp: stamp,
          payload: { type: "agent_message", message: "Synthetic compressed child" },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "x".repeat(2 * 1024 * 1024) }],
          },
        },
      ]);
    const compressed = child.transcript + ".zst";
    writeFileSync(compressed, zstdCompressSync(readFileSync(child.transcript)));
    rmSync(child.transcript);
    child.transcript = compressed;
    const plain = vi.spyOn(codexRollouts, "plain");
    const catalog = await f.reader.list(f.parent, [child]);
    expect(catalog.agents).toHaveLength(1);
    expect(catalog.agents[0]).toMatchObject({ readable: true, status: "unknown" });
    expect(plain).not.toHaveBeenCalled();
    const page = await f.reader.events(f.parent, catalog.agents[0].id, null, 50, [child]);
    expect(plain).toHaveBeenCalledTimes(1);
    expect(page.events.some((value) => value.content === "Synthetic compressed child")).toBe(true);
  });
  it("keeps a proven background Codex child active after the parent goes idle or starts a new turn", async () => {
    const f = fixture(),
      child = codexChild(f, [
        { type: "event_msg", payload: { type: "task_started", turn_id: "child-turn" } },
      ]);
    write(f.parent.transcript, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "parent-turn" } },
      {
        type: "response_item",
        payload: { type: "SubAgentActivity", kind: "started", agent_thread_id: child.nativeId },
      },
    ]);
    const parent = {
      ...f.parent,
      running: true,
      connected: true,
      observerId: "connection-1",
      turnId: "parent-turn",
    };
    expect((await f.reader.list(parent, [child])).agents[0].status).toBe("running");
    expect(
      (await f.reader.list({ ...parent, running: false, turnId: null }, [child])).agents[0].status,
    ).toBe("running");
    expect(
      (await f.reader.list({ ...parent, turnId: "new-parent-turn" }, [child])).agents[0].status,
    ).toBe("running");
    appendFileSync(
      child.transcript,
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "child-turn" },
      }) + "\n",
    );
    expect((await f.reader.list({ ...parent, running: false }, [child])).agents[0].status).toBe(
      "completed",
    );
  });
  it("drops previously active Codex observations when the native connection changes", async () => {
    const f = fixture(),
      child = codexChild(f, [
        { type: "event_msg", payload: { type: "task_started", turn_id: "child-turn" } },
      ]);
    write(f.parent.transcript, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "parent-turn" } },
      {
        type: "response_item",
        payload: { type: "SubAgentActivity", kind: "started", agent_thread_id: child.nativeId },
      },
    ]);
    const parent = {
      ...f.parent,
      running: true,
      connected: true,
      observerId: "connection-1",
      turnId: "parent-turn",
    };
    expect((await f.reader.list(parent, [child])).agents[0].status).toBe("running");
    expect(
      (await f.reader.list({ ...parent, running: false, observerId: "connection-2" }, [child]))
        .agents[0].status,
    ).toBe("unknown");
    expect((await f.reader.list({ ...parent, running: false }, [child])).agents[0].status).toBe(
      "unknown",
    );
  });
  it("forgets live evidence for Codex children that disappear from verified discovery", async () => {
    const f = fixture(),
      child = codexChild(f, [
        { type: "event_msg", payload: { type: "task_started", turn_id: "child-turn" } },
      ]);
    write(f.parent.transcript, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "parent-turn" } },
      {
        type: "response_item",
        payload: { type: "SubAgentActivity", kind: "started", agent_thread_id: child.nativeId },
      },
    ]);
    const parent = {
      ...f.parent,
      connected: true,
      observerId: "connection-1",
      running: true,
      turnId: "parent-turn",
    };
    expect((await f.reader.list(parent, [child])).agents[0].status).toBe("running");
    expect((await f.reader.list({ ...parent, running: false }, [])).agents).toEqual([]);
    expect((await f.reader.list({ ...parent, running: false }, [child])).agents[0].status).toBe(
      "unknown",
    );
  });
  it("does not attach an old uncompleted Codex child to a later parent turn", async () => {
    const f = fixture(),
      child = codexChild(f, [
        { type: "event_msg", payload: { type: "task_started", turn_id: "child-turn" } },
      ]);
    write(f.parent.transcript, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "old-turn" } },
      {
        type: "response_item",
        payload: { type: "SubAgentActivity", kind: "started", agent_thread_id: child.nativeId },
      },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "old-turn" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "current-turn" } },
    ]);
    expect(
      (
        await f.reader.list(
          {
            ...f.parent,
            connected: true,
            observerId: "new-connection",
            running: true,
            turnId: "current-turn",
          },
          [child],
        )
      ).agents[0].status,
    ).toBe("unknown");
  });
  it("reads explicit CollabAgentToolCall child state instead of the spawn call's completion", async () => {
    const f = fixture(),
      child = codexChild(f, [
        { type: "event_msg", payload: { type: "task_started", turn_id: "child-turn" } },
      ]);
    write(f.parent.transcript, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "parent-turn" } },
      {
        type: "response_item",
        payload: {
          type: "CollabAgentToolCall",
          tool: "spawn_agent",
          status: "completed",
          agents_states: { [child.nativeId]: { status: "running" } },
        },
      },
    ]);
    const parent = {
      ...f.parent,
      running: true,
      connected: true,
      observerId: "connection-1",
      turnId: "parent-turn",
    };
    expect((await f.reader.list(parent, [child])).agents[0].status).toBe("running");
    appendFileSync(
      f.parent.transcript,
      JSON.stringify({
        type: "response_item",
        turn_id: "parent-turn",
        payload: {
          type: "CollabAgentToolCall",
          tool: "wait",
          status: "completed",
          agentsStates: { [child.nativeId]: { status: "completed" } },
        },
      }) + "\n",
    );
    expect((await f.reader.list(parent, [child])).agents[0].status).toBe("completed");
  });
  it("rejects Codex metadata whose verified header names another parent", async () => {
    const f = fixture(),
      child = codexChild(f, [], randomUUID());
    child.parentNativeId = f.parent.nativeId;
    expect((await f.reader.list(f.parent, [child])).agents).toEqual([]);
  });
  it("binds child ids and pagination cursors to their verified parent", async () => {
    const f = fixture(),
      child = codexChild(
        f,
        Array.from({ length: 6 }, (_, i) => ({
          type: "event_msg",
          timestamp: stamp,
          payload: { type: "agent_message", message: `Synthetic ${i}` },
        })),
      );
    const catalog = await f.reader.list(f.parent, [child]),
      id = catalog.agents[0].id;
    const page = await f.reader.events(f.parent, id, null, 2, [child]);
    expect(page.events).toHaveLength(2);
    expect(page.next_cursor).not.toBeNull();
    const another = { ...f.parent, sessionId: "other-parent" };
    const otherId = (await f.reader.list(another, [child])).agents[0].id;
    expect(otherId).not.toBe(id);
    await expect(f.reader.events(another, id, null, 2, [child])).rejects.toThrow(
      "subagent-unavailable",
    );
    await expect(f.reader.events(another, otherId, page.next_cursor, 2, [child])).rejects.toThrow(
      "TRANSCRIPT_CURSOR_INVALID",
    );
    expect((await f.reader.events(f.parent, id, page.next_cursor, 2, [child])).events).toHaveLength(
      2,
    );
  });
  it("uses Claude's native parent id, reads its independent transcript, and recognizes explicit completion", async () => {
    const f = fixture("claude-code"),
      child = claudeChild(f);
    write(f.parent.transcript, [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "spawn-1",
              name: "Agent",
              input: { description: "Review synthetic fixture" },
            },
          ],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "spawn-1", content: "done" }] },
        toolUseResult: { agentId: child.agentId, status: "completed" },
      },
    ]);
    const catalog = await f.reader.list(f.parent);
    expect(catalog.agents).toHaveLength(1);
    expect(catalog.agents[0]).toMatchObject({
      name: "Review synthetic fixture",
      status: "completed",
      readable: true,
    });
    const page = await f.reader.events(f.parent, catalog.agents[0].id, null, 50);
    expect(page.events.map((value) => value.content)).toContain("Synthetic child result");
    expect(page.events.map((value) => value.content)).toContain("Synthetic child task");
  });
  it("never treats a background Claude dispatch or an unclosed file as a live worker", async () => {
    const f = fixture("claude-code"),
      child = claudeChild(f);
    write(f.parent.transcript, [
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "spawn-1", content: "launched" }],
        },
        toolUseResult: { agentId: child.agentId, status: "async_launched" },
      },
    ]);
    expect((await f.reader.list(f.parent)).agents[0].status).toBe("unknown");
  });
  it("keeps a runtime child's opaque identity stable as its native file arrives", async () => {
    const f = fixture("claude-code");
    const observed: SubagentObservation[] = [
      {
        id: "spawn-1",
        name: "Runtime worker",
        status: "running",
        readable: true,
        nativeAgentId: "worker-1",
      },
    ];
    const initial = await f.reader.list(f.parent, [], observed);
    claudeChild(f, "worker-1");
    const after = await f.reader.list(f.parent, [], observed);
    expect(after.agents).toHaveLength(1);
    expect(after.agents[0]).toEqual(initial.agents[0]);
    expect(
      (await f.reader.events(f.parent, after.agents[0].id, null, 50, [], observed)).events,
    ).not.toEqual([]);
  });
  it("rejects linked Claude files and mismatched session identities", async () => {
    const f = fixture("claude-code"),
      child = claudeChild(f);
    write(child.transcript, [
      {
        type: "assistant",
        sessionId: "other-native-parent",
        agentId: child.agentId,
        isSidechain: true,
        message: { role: "assistant", content: "not authorized" },
      },
    ]);
    expect((await f.reader.list(f.parent)).agents).toEqual([]);
    const outside = path.join(f.directory, "outside.jsonl");
    write(outside, [{ sessionId: f.parent.nativeId, agentId: "linked", isSidechain: true }]);
    symlinkSync(outside, path.join(child.folder, "agent-linked.jsonl"));
    expect((await f.reader.list(f.parent)).agents).toEqual([]);
  });
  it("rejects symlinked subagent directories rather than following them", async () => {
    const f = fixture("claude-code"),
      outside = path.join(f.directory, "outside");
    mkdirSync(outside);
    const parentFolder = path.join(f.directory, f.parent.nativeId);
    mkdirSync(parentFolder);
    symlinkSync(outside, path.join(parentFolder, "subagents"));
    await expect(f.reader.list(f.parent)).rejects.toThrow("subagent-source-unsafe");
  });
  it("invalidates cached parsing when a previously read child completes", async () => {
    const f = fixture(),
      child = codexChild(f, [
        { type: "event_msg", payload: { type: "task_started", turn_id: "t" } },
      ]);
    expect((await f.reader.list(f.parent, [child])).agents[0].status).toBe("unknown");
    appendFileSync(
      child.transcript,
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t" } }) +
        "\n",
    );
    expect((await f.reader.list(f.parent, [child])).agents[0].status).toBe("completed");
  });
  it("keeps a history epoch across appends and changes it after source truncation", async () => {
    const f = fixture(),
      child = codexChild(
        f,
        Array.from({ length: 8 }, (_, i) => ({
          type: "event_msg",
          timestamp: stamp,
          payload: { type: "agent_message", message: `Synthetic ${i}` },
        })),
      );
    const id = (await f.reader.list(f.parent, [child])).agents[0].id;
    const first = await f.reader.events(f.parent, id, null, 2, [child]);
    appendFileSync(
      child.transcript,
      JSON.stringify({
        type: "event_msg",
        timestamp: stamp,
        payload: { type: "agent_message", message: "Synthetic appended" },
      }) + "\n",
    );
    const appended = await f.reader.events(f.parent, id, null, 2, [child]);
    expect(appended.epoch).toBe(first.epoch);
    write(child.transcript, [
      {
        type: "session_meta",
        payload: {
          id: child.nativeId,
          cwd: f.directory,
          source: { subagent: { thread_spawn: { parent_thread_id: f.parent.nativeId } } },
        },
      },
      {
        type: "event_msg",
        timestamp: stamp,
        payload: { type: "agent_message", message: "Synthetic replaced" },
      },
    ]);
    const replaced = await f.reader.events(f.parent, id, null, 2, [child]);
    expect(replaced.epoch).not.toBe(first.epoch);
    await expect(f.reader.events(f.parent, id, first.next_cursor, 2, [child])).rejects.toThrow(
      "TRANSCRIPT_CURSOR_STALE",
    );
  });
  it("bounds discovery while reading only small metadata windows of large children", async () => {
    const f = fixture(),
      children = Array.from({ length: 129 }, () =>
        codexChild(f, [
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "x".repeat(128 * 1024) }],
            },
          },
          { type: "event_msg", payload: { type: "task_complete", turn_id: "finished" } },
        ]),
      );
    const catalog = await f.reader.list(f.parent, children);
    expect(catalog.agents).toHaveLength(128);
    expect(catalog.truncated).toBe(true);
    expect(catalog.agents.every((value) => value.status === "completed" && value.readable)).toBe(
      true,
    );
    expect(JSON.stringify(catalog).length).toBeLessThan(40 * 1024);
    expect(await f.reader.list(f.parent, children)).toEqual(catalog);
  });
  it("never reads Claude children whose recorded working directory escapes the parent workspace", async () => {
    const f = fixture("claude-code"),
      child = claudeChild(f);
    write(child.transcript, [
      {
        type: "assistant",
        sessionId: f.parent.nativeId,
        agentId: child.agentId,
        isSidechain: true,
        cwd: path.dirname(f.directory),
        message: { role: "assistant", content: "Outside workspace" },
      },
    ]);
    expect((await f.reader.list(f.parent)).agents).toEqual([]);
  });
  it("projects nested runtime children without exposing private ids or depending on array order", () => {
    const f = fixture("claude-code"),
      observed: SubagentObservation[] = [
        {
          id: "spawn-child",
          parentId: "spawn-parent",
          name: "Nested",
          status: "running",
          nativeAgentId: "native-secret",
        },
        { id: "spawn-parent", name: "Parent", status: "waiting-input" },
      ];
    const projected = projectSubagentObservations(f.parent, "synthetic-salt", observed);
    expect(projected.agents[0].parentId).toBe(projected.agents[1].id);
    expect(JSON.stringify(projected)).not.toContain("native-secret");
    expect(JSON.stringify(projected)).not.toContain("spawn-parent");
  });
});
