import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeManagedRunnerProcess } from "../../../packages/backend/src/claude-managed-runner";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/claude-managed-read";
import { ClaudeTurnMetaStore, cleanTurnMeta } from "../../../packages/backend/src/claude-turn-meta";
import type { BackendStore } from "../../../packages/backend/src/store";
import type { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { Commands } from "../../../packages/backend/src/commands";
import { createFakeClaude, type FakeClaudePlan } from "./fixtures/claude-fake-cli";

// A print-mode transcript has no `system/turn_duration` (checked with CLI 2.1.311 against a local
// API stub), so managed sessions take the duration from `result.duration_ms`. Frames here are
// played by the scripted fake CLI; their shapes follow that stub run.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fake(plan: FakeClaudePlan) {
  const f = createFakeClaude("agentkib-claude-duration-");
  f.setPlan(plan);
  cleanups.push(() => rmSync(f.root, { recursive: true, force: true }));
  return f;
}
const assistant = (uuid: string, texts: string[], extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  parent_tool_use_id: null,
  uuid,
  message: {
    id: `msg_${uuid.slice(0, 8)}`,
    content: texts.map((text) => ({ type: "text", text })),
  },
  ...extra,
});
const result = (extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  terminal_reason: "completed",
  duration_ms: 4321,
  usage: { input_tokens: 19, output_tokens: 11 },
  modelUsage: { "fixture-model": { contextWindow: 100 } },
  ...extra,
});

async function runTurn(plan: FakeClaudePlan) {
  const f = fake({ ...plan, noResult: true });
  const events: Array<{ type: string; payload: Record<string, any> }> = [];
  const runner = new ClaudeManagedRunnerProcess(
    f.workspace,
    randomUUID(),
    true,
    0,
    f.environment,
    () => undefined,
    true,
    (type, payload) => events.push({ type, payload: structuredClone(payload) }),
    {},
  );
  cleanups.push(async () => {
    await runner.shutdown().catch(() => undefined);
  });
  const turnId = randomUUID();
  await runner.send(f.executable, "synthetic turn", turnId, runner.snapshot().revision);
  await expect.poll(() => runner.snapshot().status, { timeout: 15_000 }).toBe("idle");
  return { events, turnId };
}
const upserts = (events: Array<{ type: string; payload: Record<string, any> }>) =>
  events.filter(({ type }) => type === "item-upsert").map(({ payload }) => payload);

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "live managed Claude turn duration",
  () => {
    it("re-sends the turn's last agent message with the result's duration", async () => {
      const first = randomUUID();
      const last = randomUUID();
      const { events, turnId } = await runTurn({
        onUser: [assistant(first, ["Looking."]), assistant(last, ["Done."]), result()],
      });
      const ended = upserts(events).filter((item) => item.turn_meta);
      expect(ended).toEqual([
        {
          id: last,
          kind: "agent-message",
          turn_id: turnId,
          content: "Done.",
          attachment_count: 0,
          truncated: false,
          ephemeral: false,
          turn_meta: { outcome: "completed", duration_ms: 4321 },
        },
      ]);
      // It comes after the message itself, so it never replaces newer text.
      expect(events.findIndex(({ payload }) => payload.turn_meta)).toBe(events.length - 1);
    }, 30_000);

    it("uses the last text block of a message with several", async () => {
      const id = randomUUID();
      const { events } = await runTurn({ onUser: [assistant(id, ["one", "two"]), result()] });
      expect(upserts(events).filter((item) => item.turn_meta)).toMatchObject([
        { id: `${id}:text:1`, content: "two", turn_meta: { duration_ms: 4321 } },
      ]);
    }, 30_000);

    it("marks a turn that did not complete and keeps an unusable duration out", async () => {
      const id = randomUUID();
      const { events } = await runTurn({
        onUser: [
          assistant(id, ["Partial."]),
          result({ terminal_reason: "aborted", duration_ms: -1 }),
        ],
      });
      expect(upserts(events).filter((item) => item.turn_meta)).toMatchObject([
        { id, turn_meta: { outcome: "aborted" } },
      ]);
      expect(upserts(events).find((item) => item.turn_meta)?.turn_meta).not.toHaveProperty(
        "duration_ms",
      );
    }, 30_000);

    it("adds nothing to a turn without an agent message", async () => {
      const { events } = await runTurn({
        onUser: [
          {
            type: "assistant",
            parent_tool_use_id: null,
            uuid: randomUUID(),
            message: {
              content: [
                { type: "tool_use", id: "toolu_only", name: "Read", input: { file_path: "a" } },
              ],
            },
          },
          {
            type: "user",
            message: {
              content: [{ type: "tool_result", tool_use_id: "toolu_only", content: "x" }],
            },
          },
          result(),
        ],
      });
      expect(events.some(({ payload }) => payload.turn_meta)).toBe(false);
    }, 30_000);
  },
);

describe("stored Claude turn ends", () => {
  function store(maxPerSession?: number) {
    const root = mkdtempSync(path.join(tmpdir(), "agentkib-turn-meta-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return new ClaudeTurnMetaStore(root, maxPerSession);
  }
  const native = "0b6c3c55-0e0e-4f4e-9d36-1b8f0c1f9a10";
  const item = "4ffdce52-9a28-40f2-bf1f-48c6ca20bed0";

  it("reads back what it kept, for the requested items of that session only", () => {
    const meta = store();
    expect(meta.read(native, [item]).size).toBe(0);
    expect(meta.record(native, item, { outcome: "completed", duration_ms: 365 })).toBe(true);
    expect(meta.record(native, `${item}:text:2`, { duration_ms: 9 })).toBe(true);
    expect(Object.fromEntries(meta.read(native, [item, `${item}:text:2`, "missing"]))).toEqual({
      [item]: { outcome: "completed", duration_ms: 365 },
      [`${item}:text:2`]: { duration_ms: 9 },
    });
    expect(meta.read(randomUUID(), [item]).size).toBe(0);
    // A later end for the same item replaces the earlier one.
    meta.record(native, item, { outcome: "failed", duration_ms: 400 });
    expect(meta.read(native, [item]).get(item)).toEqual({ outcome: "failed", duration_ms: 400 });
  });

  it("refuses identities and values it cannot vouch for", () => {
    const meta = store();
    expect(meta.record("not-a-uuid", item, { duration_ms: 1 })).toBe(false);
    expect(meta.record(native, "live:turn:assistant:1", { duration_ms: 1 })).toBe(false);
    expect(meta.record(native, item, { duration_ms: 1.5, outcome: "maybe" })).toBe(false);
    expect(meta.read(native, [item]).size).toBe(0);
    expect(cleanTurnMeta({ outcome: "aborted", duration_ms: 3, extra: "x" })).toEqual({
      outcome: "aborted",
      duration_ms: 3,
    });
    expect(cleanTurnMeta([1])).toBeNull();
  });

  it("keeps the newest entries of a session (1000 by default)", () => {
    expect(new ClaudeTurnMetaStore("/unused").maxPerSession).toBe(1000);
    const meta = store(5);
    const other = randomUUID();
    meta.record(other, item, { duration_ms: 1 });
    const ids = Array.from({ length: 8 }, () => randomUUID());
    for (const [index, id] of ids.entries()) meta.record(native, id, { duration_ms: index });
    expect(meta.read(native, ids.slice(0, 3)).size).toBe(0);
    expect(meta.read(native, ids.slice(3)).size).toBe(5);
    expect(meta.read(native, [ids.at(-1)!]).get(ids.at(-1)!)).toEqual({ duration_ms: 7 });
    // Another session's entries are not counted against this one.
    expect(meta.read(other, [item]).size).toBe(1);
  });
});

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "managed Claude history after the live rows",
  () => {
    it("shows the stored duration and gives the history a new version", async () => {
      const reply = randomUUID();
      const f = fake({
        onUser: [assistant(reply, ["Synthetic reply."]), result({ duration_ms: 2750 })],
        noResult: true,
      });
      const published: Array<{ type: string; payload: Record<string, any> }> = [];
      const pages: Array<{ nativeId: string }> = [];
      const commands = {
        run: vi.fn(async (command: string, args: string[]) => {
          if (command === "/bin/ps") return { success: true, bytes: Buffer.from("") };
          if (args[0] === "agents") return { success: true, bytes: Buffer.from("[]\n") };
          return { success: true, bytes: Buffer.from("2.1.311 (Claude Code)\n") };
        }),
      } as unknown as Commands;
      const store = {
        workspacePath: () => f.workspace,
        sessions: { id: (_agent: string, id: string) => id, get: () => undefined },
      } as unknown as BackendStore;
      const sessions = {
        verifiedClaudeControlTarget: (id: string) => path.join(f.config, `${id}.jsonl`),
        // History as the transcript reader returns it: the reply without a duration.
        eventsForNative: async (_agent: string, nativeId: string) => {
          pages.push({ nativeId });
          return {
            events: [
              { id: "u-1", kind: "user-message", content: "synthetic turn" },
              { id: reply, kind: "agent-message", content: "Synthetic reply." },
              {
                id: "interactive-1",
                kind: "agent-message",
                content: "Kept as read.",
                turn_meta: { outcome: "completed", duration_ms: 1 },
              },
            ],
            next_cursor: null,
            warnings: [],
          };
        },
      } as unknown as SessionReaders;
      const owner = new ClaudeManagedReadOwner(
        store,
        sessions,
        commands,
        f.root,
        f.environment,
        randomUUID(),
        {
          publish: (_id, type, payload) =>
            published.push({ type, payload: structuredClone(payload) }),
          alias: () => undefined,
        },
      );
      cleanups.push(() => owner.shutdown());
      const created = (await owner.request({
        operation: "create",
        workspaceId: "workspace",
        requestId: randomUUID(),
        deviceId: "browser-device-a",
      })) as Record<string, any>;
      const id = created.sessionId as string;
      const live = (await owner.live(id, true)) as Record<string, any>;
      await owner.request({
        operation: "send",
        sessionId: id,
        deviceId: "browser-device-a",
        requestId: randomUUID(),
        runtimeBootId: owner.bootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        text: "synthetic turn",
      });
      await expect
        .poll(async () => ((await owner.live(id, true)) as Record<string, any>).status, {
          timeout: 15_000,
        })
        .toBe("idle");
      expect(published.filter(({ payload }) => payload.turn_meta)).toMatchObject([
        { type: "item-upsert", payload: { id: reply, turn_meta: { duration_ms: 2750 } } },
      ]);
      const nativeId = String(
        ((await owner.live(id, true)) as Record<string, any>).sourceSessionId,
      );
      writeFileSync(path.join(f.config, `${nativeId}.jsonl`), "");
      const page = (await owner.events(id, null, 50)) as { events: Array<Record<string, any>> };
      expect(pages.at(-1)).toEqual({ nativeId });
      expect(page.events.map((event) => [event.id, event.turn_meta ?? null])).toEqual([
        ["u-1", null],
        [reply, { outcome: "completed", duration_ms: 2750 }],
        ["interactive-1", { outcome: "completed", duration_ms: 1 }],
      ]);

      // A projection cached by version reads the history again once another end is stored.
      const before = await owner.historyVersion(id);
      expect(await owner.historyVersion(id)).toBe(before);
      const next = (await owner.live(id, true)) as Record<string, any>;
      f.setPlan({
        onUser: [assistant(randomUUID(), ["Again."]), result({ duration_ms: 10 })],
        noResult: true,
      });
      await owner.request({
        operation: "send",
        sessionId: id,
        deviceId: "browser-device-a",
        requestId: randomUUID(),
        runtimeBootId: owner.bootId,
        expectedRevision: next.revision,
        experimentalEnabled: true,
        text: "again",
      });
      await expect
        .poll(() => published.filter(({ payload }) => payload.turn_meta).length, {
          timeout: 15_000,
        })
        .toBe(2);
      expect(await owner.historyVersion(id)).not.toBe(before);
    }, 60_000);
  },
);
