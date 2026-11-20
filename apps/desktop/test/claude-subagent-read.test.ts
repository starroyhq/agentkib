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
import { withSessionActivities } from "../../../packages/backend/src/session-activities";
import type { SubagentCatalog } from "@agentkib/runtime-protocol";
import type { Live } from "@agentkib/web-client";
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

function fixture(backgroundTasks = false) {
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
  const publications: Live[] = [];
  const owner = new ClaudeManagedReadOwner(
    store,
    readers,
    commands,
    f.root,
    f.environment,
    undefined,
    {
      publish: (_sessionId, type, _payload, live) => {
        if (backgroundTasks && type === "state") publications.push(live as unknown as Live);
      },
      alias: () => {},
    },
    { backgroundTasks: () => backgroundTasks },
  );
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
  return {
    f,
    owner,
    readers,
    store,
    workers,
    publications,
    directory,
    nativeParent,
    create,
    send,
    list,
    page,
  };
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

    it("merges only proven background subagent pairs and keeps both legacy views", async () => {
      const f = fixture(true);
      const parent = await f.create();
      const paired = "private-tool-paired";
      const taskOnly = "private-tool-observed";
      const mismatchedTool = "private-tool-mismatched";
      const mismatchedTask = "private-task-mismatched";
      f.f.setPlan({
        lifecycle: true,
        onUser: [
          main([spawn(paired, "Paired child"), spawn(taskOnly, "Other child")]),
          { ...task(paired), description: "Paired background task" },
          { ...task(paired), task_id: mismatchedTask, description: "Only tool matches" },
          task(taskOnly),
          {
            ...task(mismatchedTool),
            task_id: task(taskOnly).task_id,
            description: "Only task matches",
          },
          childText(paired, "Paired child can be opened"),
        ],
      });
      await f.send(parent.id);
      f.nativeParent(parent.nativeId);
      const childDirectory = path.join(f.directory, parent.nativeId, "subagents");
      mkdirSync(childDirectory, { recursive: true, mode: 0o700 });
      const nativeAgentId = "private-child-catalog-only";
      writeFileSync(
        path.join(childDirectory, `agent-${nativeAgentId}.jsonl`),
        JSON.stringify({
          type: "assistant",
          uuid: randomUUID(),
          sessionId: parent.nativeId,
          agentId: nativeAgentId,
          cwd: f.f.workspace,
          isSidechain: true,
          timestamp: new Date().toISOString(),
          message: { content: [{ type: "text", text: "Synthetic historic child" }] },
        }) + "\n",
        { mode: 0o600 },
      );

      const catalog = await f.list(parent.id);
      const pairedChild = catalog.agents.find(({ name }) => name === "Paired child");
      const historicChild = catalog.agents.find(({ name }) => name === "Claude Code");
      expect(pairedChild).toMatchObject({ readable: true, status: "running" });
      expect(historicChild).toMatchObject({ readable: true, status: "unknown" });
      expect(catalog.agents).toHaveLength(3);

      const read = (await f.owner.live(parent.id, true)) as unknown as Live;
      const published = f.publications.findLast(({ status }) => status === "idle");
      expect(published).toBeDefined();
      expect(published?.subagents?.agents).toHaveLength(2);
      expect(read.subagents).toBeUndefined();
      for (const live of [read, published!]) {
        expect(live.backgroundTasks).toHaveLength(3);
        const pairedTask = live.backgroundTasks?.find(
          ({ description }) => description === "Paired background task",
        );
        expect(pairedTask?.startedAt).toEqual(expect.any(String));
        expect(live.activities).toHaveLength(4);
        expect(live.activities).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: pairedChild?.id,
              kind: "subagent",
              childId: pairedChild?.id,
              title: "Paired child",
              startedAt: pairedTask?.startedAt,
            }),
            expect.objectContaining({ kind: "subagent", title: "Other child" }),
            expect.objectContaining({ kind: "background-task", title: "Only tool matches" }),
            expect.objectContaining({ kind: "background-task", title: "Only task matches" }),
          ]),
        );
        const complete = withSessionActivities(
          live as unknown as Record<string, unknown>,
          catalog,
        ).activities;
        expect(complete).toHaveLength(5);
        expect(complete).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: pairedChild?.id, startedAt: pairedTask?.startedAt }),
            expect.objectContaining({ id: historicChild?.id, childId: historicChild?.id }),
          ]),
        );
        const wire = JSON.stringify([live, complete]);
        for (const native of [paired, taskOnly, mismatchedTool, mismatchedTask, nativeAgentId])
          expect(wire).not.toContain(native);
      }
      expect(read.activities?.map(({ id }) => id).sort()).toEqual(
        published?.activities?.map(({ id }) => id).sort(),
      );
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
