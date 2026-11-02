// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendStore } from "../../../packages/backend/src/store";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { Commands, type CommandOutput } from "../../../packages/backend/src/commands";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/claude-managed-read";
import { ClaudeManagedRunnerProcess } from "../../../packages/backend/src/claude-managed-runner";
import { claudeProjectKey } from "../../../packages/backend/src/claude-project-path";
import type { ConversationEvent } from "../../../packages/backend/src/session-events";
import type { SubagentCatalog } from "@agentkib/runtime-protocol";
import { createFakeClaude, type FakeClaudePlan } from "./fixtures/claude-fake-cli";

// The CLI is an offline protocol fixture. Native ownership and child reads use real temporary
// BackendStore / SessionReaders paths; no user history, real credentials or model calls are used.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
const deviceId = "synthetic-browser";
const main = (content: unknown[]) => ({
  type: "assistant",
  parent_tool_use_id: null,
  uuid: randomUUID(),
  message: { content },
});
const childText = (id: string, text: string) => ({
  type: "assistant",
  parent_tool_use_id: id,
  uuid: randomUUID(),
  message: { content: [{ type: "text", text }] },
});
const spawn = (id: string, description: string) => ({
  type: "tool_use",
  id,
  name: "Agent",
  input: { description, run_in_background: true },
});
const task = (id: string) => ({
  type: "system",
  subtype: "task_started",
  task_type: "local_agent",
  tool_use_id: id,
  task_id: `task-${id}`,
  is_backgrounded: true,
});
const initialPlan = (): FakeClaudePlan => ({
  onUser: [
    main([spawn("spawn-one", "Synthetic one"), spawn("spawn-two", "Synthetic two")]),
    task("spawn-one"),
    task("spawn-two"),
    childText("spawn-one", "First child older message"),
    childText("spawn-one", "First child latest message"),
    childText("spawn-two", "Other child older message"),
    childText("spawn-two", "Other child latest message"),
  ],
});
type ReadPage = {
  version: number;
  sessionId: string;
  subagentId: string;
  epoch: string;
  events: ConversationEvent[];
  next_cursor: string | null;
  warnings: string[];
};

function fixture() {
  const f = createFakeClaude("agentkib-child-owner-read-");
  cleanups.push(() => rmSync(f.root, { recursive: true, force: true }));
  f.setPlan(initialPlan());
  const store = new BackendStore(path.join(f.root, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    f.workspace,
    "Synthetic workspace",
    "healthy",
    new Date().toISOString(),
  );
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const empty = (text = ""): CommandOutput => ({
    success: true,
    bytes: Buffer.from(text),
    error: "",
    truncated: false,
    exitCode: 0,
  });
  vi.spyOn(commands, "run").mockImplementation(async (_program, args) => {
    if (args.length === 1 && args[0] === "--version") return empty("2.1.311 (Claude Code)\n");
    if (args[0] === "agents") return empty("[]\n");
    return empty();
  });
  const readers = new SessionReaders(store.sessions, commands, f.environment, {
    profiles: () => [],
  });
  cleanups.push(() => readers.close());
  const owner = new ClaudeManagedReadOwner(store, readers, commands, f.root, f.environment);
  cleanups.push(() => owner.shutdown());
  const workers: ClaudeManagedRunnerProcess[] = [];
  const originalSend = ClaudeManagedRunnerProcess.prototype.send;
  vi.spyOn(ClaudeManagedRunnerProcess.prototype, "send").mockImplementation(function (
    this: ClaudeManagedRunnerProcess,
    ...args: Parameters<ClaudeManagedRunnerProcess["send"]>
  ) {
    if (!workers.includes(this)) workers.push(this);
    return originalSend.apply(this, args);
  });
  const project = claudeProjectKey(f.workspace);
  if (!project.ok) throw new Error("Synthetic project key is unsupported");
  const directory = path.join(f.config, "projects", project.key);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  function nativeParent(nativeId: string) {
    const transcript = path.join(directory, `${nativeId}.jsonl`);
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "user",
        uuid: randomUUID(),
        parentUuid: null,
        sessionId: nativeId,
        cwd: f.workspace,
        isSidechain: false,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Synthetic parent record" },
      }) + "\n",
      { mode: 0o600 },
    );
    return transcript;
  }
  async function create() {
    const created = (await owner.request({
      operation: "create",
      workspaceId: "workspace",
      deviceId,
      requestId: randomUUID(),
    })) as { sessionId: string; sourceSessionId: string };
    return { id: created.sessionId, nativeId: created.sourceSessionId };
  }
  async function send(id: string, content = "Synthetic child read test") {
    const live = (await owner.live(id, true)) as { revision: number };
    const result = (await owner.request({
      operation: "send",
      sessionId: id,
      deviceId,
      requestId: randomUUID(),
      runtimeBootId: owner.bootId,
      expectedRevision: live.revision,
      experimentalEnabled: true,
      text: content,
    })) as { accepted: boolean; error?: string };
    expect(result, result.error).toMatchObject({ accepted: true });
    await expect
      .poll(async () => ((await owner.live(id, true)) as { status: string }).status, {
        timeout: 15_000,
      })
      .toBe("idle");
  }
  const list = (id: string) =>
    owner.request({ operation: "subagents", sessionId: id }) as Promise<SubagentCatalog>;
  const page = (id: string, subagentId: string, cursor: string | null = null, limit = 1) =>
    owner.request({
      operation: "subagent-events",
      sessionId: id,
      subagentId,
      cursor,
      limit,
    }) as Promise<ReadPage>;
  return { f, owner, readers, store, workers, directory, nativeParent, create, send, list, page };
}

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Claude parent-scoped child read route",
  () => {
    it("reads memory through the real owner with stable epoch and anchored older pages after append", async () => {
      const f = fixture(),
        parent = await f.create();
      await f.send(parent.id);
      f.nativeParent(parent.nativeId);
      const list = await f.list(parent.id),
        child = list.agents.find((value) => value.name === "Synthetic one")!;
      expect(child).toMatchObject({ readable: true, agent: "claude-code", status: "running" });
      const first = await f.page(parent.id, child.id);
      expect(first.epoch).toMatch(/^[a-f0-9]{64}$/);
      expect(first.next_cursor).toContain(first.epoch);
      expect(first.events.map((value) => value.content)).toEqual(["First child latest message"]);
      f.f.setPlan({ onUser: [childText("spawn-one", "First child appended message")] });
      await f.send(parent.id, "Synthetic append");
      const latest = await f.page(parent.id, child.id);
      expect(latest.epoch).toBe(first.epoch);
      expect(latest.events.map((value) => value.content)).toEqual(["First child appended message"]);
      const older = await f.page(parent.id, child.id, first.next_cursor);
      expect(older.epoch).toBe(first.epoch);
      expect(older.events.map((value) => value.content)).toEqual(["First child older message"]);
    }, 30_000);

    it("rejects a memory cursor used for another child or another authorized parent", async () => {
      const f = fixture(),
        parent = await f.create();
      await f.send(parent.id);
      f.nativeParent(parent.nativeId);
      const list = await f.list(parent.id),
        first = list.agents.find((value) => value.name === "Synthetic one")!,
        second = list.agents.find((value) => value.name === "Synthetic two")!;
      const page = await f.page(parent.id, first.id);
      await expect(f.page(parent.id, second.id, page.next_cursor)).rejects.toThrow(
        "TRANSCRIPT_CURSOR_STALE",
      );
      const other = await f.create();
      await f.send(other.id);
      f.nativeParent(other.nativeId);
      const otherFirst = (await f.list(other.id)).agents.find(
        (value) => value.name === "Synthetic one",
      )!;
      expect(otherFirst.id).not.toBe(first.id);
      await expect(f.page(other.id, otherFirst.id, page.next_cursor)).rejects.toThrow(
        "TRANSCRIPT_CURSOR_STALE",
      );
      await expect(f.page(other.id, first.id, null)).rejects.toThrow("subagent-unavailable");
    }, 30_000);

    it("changes memory epoch when the same runner object starts a replacement worker", async () => {
      const f = fixture(),
        parent = await f.create();
      await f.send(parent.id);
      f.nativeParent(parent.nativeId);
      const child = (await f.list(parent.id)).agents.find(
        (value) => value.name === "Synthetic one",
      )!;
      const before = await f.page(parent.id, child.id),
        runner = f.workers[0],
        previousEpoch = runner.subagentEpoch;
      const retired = runner.retireIfInactive();
      expect(retired).not.toBeNull();
      await retired;
      expect(runner.hasWorker).toBe(false);
      f.f.setPlan({ onUser: [childText("spawn-one", "Replacement worker child message")] });
      await f.send(parent.id, "Synthetic worker restart");
      expect(f.workers).toHaveLength(1);
      expect(runner.subagentEpoch).not.toBe(previousEpoch);
      const after = await f.page(parent.id, child.id);
      expect(after.epoch).not.toBe(before.epoch);
      await expect(f.page(parent.id, child.id, before.next_cursor)).rejects.toThrow(
        "TRANSCRIPT_CURSOR_STALE",
      );
    }, 30_000);

    it("switches to verified native history with a distinct epoch once its file is available", async () => {
      const f = fixture(),
        parent = await f.create();
      await f.send(parent.id);
      f.nativeParent(parent.nativeId);
      const child = (await f.list(parent.id)).agents.find(
        (value) => value.name === "Synthetic one",
      )!;
      const memory = await f.page(parent.id, child.id);
      f.f.setPlan({
        onUser: [
          {
            type: "user",
            parent_tool_use_id: null,
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "spawn-one",
                  content: "Synthetic background dispatch",
                },
              ],
            },
            tool_use_result: { agentId: "native-child-one", status: "async_launched" },
          },
        ],
      });
      await f.send(parent.id, "Synthetic native mapping");
      const childDirectory = path.join(f.directory, parent.nativeId, "subagents");
      mkdirSync(childDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(
        path.join(childDirectory, "agent-native-child-one.jsonl"),
        JSON.stringify({
          type: "assistant",
          uuid: randomUUID(),
          sessionId: parent.nativeId,
          agentId: "native-child-one",
          cwd: f.f.workspace,
          isSidechain: true,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Synthetic complete native history" }],
          },
        }) + "\n",
        { mode: 0o600 },
      );
      const native = await f.page(parent.id, child.id, null, 50);
      expect(native.epoch).not.toBe(memory.epoch);
      expect(native.events.map((value) => value.content)).toContain(
        "Synthetic complete native history",
      );
      expect(native.warnings).not.toContain("SUBAGENT_LIVE_WINDOW");
      expect(
        (await f.list(parent.id)).agents.find((value) => value.name === "Synthetic one")?.id,
      ).toBe(child.id);
    }, 30_000);
  },
);
