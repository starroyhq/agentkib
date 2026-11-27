// @vitest-environment node
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as terminalEvidence from "../../../packages/backend/src/agents/claude/claude-terminal-turn-evidence";
import { verifyClaudeReadResult } from "../../../packages/backend/src/agents/claude/claude-read-reply";
import {
  ReadStateLedger,
  conversationReadKey,
} from "../../../packages/backend/src/read-state-ledger";
import { observeReadHistory } from "../../../packages/backend/src/read-state-history";
import { SessionPaging } from "../../../packages/backend/src/session-paging";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const rows = (...values: Record<string, unknown>[]) =>
  values.map((value) => JSON.stringify(value)).join("\n") + "\n";
const user = (uuid: string, content: unknown = "Real user prompt", extra = {}) => ({
  type: "user",
  uuid,
  message: { role: "user", content },
  ...extra,
});
const assistant = (uuid: string, content: unknown, extra = {}) => ({
  type: "assistant",
  uuid,
  message: { role: "assistant", content },
  ...extra,
});
const ended = (error = false) => ({
  type: "system",
  subtype: "turn_duration",
  ...(error ? { error: "Synthetic failure" } : {}),
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-claude-read-history-"));
  roots.push(root);
  const file = path.join(root, "history.jsonl"),
    ledger = new ReadStateLedger(root),
    key = conversationReadKey("claude-code", root, "native");
  writeFileSync(file, "");
  observeReadHistory(ledger, key, "claude-code", file);
  const scan = (reader = ledger) => observeReadHistory(reader, key, "claude-code", file);
  const nativeId = "native";
  const append = (...values: Record<string, unknown>[]) =>
    appendFileSync(file, rows(...values.map((value) => ({ sessionId: nativeId, ...value }))));
  const proof = (result: Parameters<ReadStateLedger["terminalReplyWindow"]>[1]) => {
    const window = ledger.terminalReplyWindow(key, result);
    return verifyClaudeReadResult(file, nativeId, result, window);
  };
  const nativeReply = async (result: Parameters<typeof proof>[0]) =>
    (await proof(result))?.itemId ?? undefined;
  const acknowledge = (reader = ledger) => {
    const state = reader.get(key, "owner");
    return reader.update(key, "owner", state.version!, state.latestResult!.id);
  };
  return { root, file, ledger, key, nativeId, append, scan, acknowledge, nativeReply, proof };
}
const bridge = {
  id: "turn:bridge",
  turnId: "bridge",
  itemId: null,
  outcome: "ended" as const,
  completedAt: "2026-11-01T00:00:05.100Z",
};
const startedAt = "2026-11-01T00:00:03.000Z";
const replyTime = "2026-11-01T00:00:03.500Z";
const nativeEnd = (parentUuid: string, timestamp = "2026-11-01T00:00:04.000Z") => ({
  ...ended(),
  uuid: randomUUID(),
  parentUuid,
  timestamp,
});
describe("Claude fallback read-state history identity", () => {
  it.each([
    "completion outside the bridge turn",
    "two completions of the same prompt",
    "overlapping bridge turns",
    "an unrelated parent chain",
  ])("does not infer a reply anchor from %s", async (scenario) => {
    const f = fixture();
    const prompt = randomUUID();
    const reply = randomUUID();
    f.ledger.record(f.key, bridge, false, startedAt);
    f.append(
      user(prompt),
      assistant(reply, "Native reply", { parentUuid: prompt, timestamp: replyTime }),
      nativeEnd(
        scenario === "an unrelated parent chain" ? randomUUID() : reply,
        scenario === "completion outside the bridge turn" ? "2026-11-01T00:00:06.000Z" : undefined,
      ),
    );
    if (scenario === "two completions of the same prompt") {
      const otherReply = randomUUID();
      f.append(
        assistant(otherReply, "Second native reply to this prompt", {
          parentUuid: prompt,
          timestamp: "2026-11-01T00:00:04.500Z",
        }),
        nativeEnd(otherReply, "2026-11-01T00:00:05.000Z"),
      );
    }
    if (scenario === "overlapping bridge turns")
      f.ledger.record(
        f.key,
        { ...bridge, id: "turn:other-bridge", turnId: "other-bridge" },
        false,
        startedAt,
      );
    f.scan();
    expect(await f.nativeReply(bridge)).toBeUndefined();
  });

  it("does not accept a new completion that still points to a reply from before the bridge turn", async () => {
    const f = fixture();
    const prompt = randomUUID(),
      reply = randomUUID();
    f.ledger.record(f.key, bridge, false, startedAt);
    f.append(
      user(prompt),
      assistant(reply, "Old native reply", {
        parentUuid: prompt,
        timestamp: "2026-11-01T00:00:01.000Z",
      }),
      nativeEnd(reply, "2026-11-01T00:00:02.000Z"),
      nativeEnd(reply),
    );
    f.scan();
    expect(await f.nativeReply(bridge)).toBeUndefined();
  });

  it.each(["replace", "rewrite"] as const)(
    "uses only the current transcript's links and completions after a %s",
    async (method) => {
      const f = fixture();
      const prompt = randomUUID(),
        answer = randomUUID();
      const legacyReport = user(
        prompt,
        [{ type: "text", text: "[AgentKib report] Work completed." }],
        {
          isMeta: true,
          origin: { kind: "plugin", name: "agentkib-bridge" },
        },
      );
      f.ledger.record(f.key, bridge, false, startedAt);
      const nativeReply = assistant(answer, "Visible native reply", {
        parentUuid: prompt,
        timestamp: replyTime,
      });
      const completion = nativeEnd(answer);
      f.append(legacyReport, nativeReply, completion);
      f.scan();
      expect(await f.nativeReply(bridge)).toBe(answer);
      const before = f.ledger.get(f.key, "account:fixture");
      const target = method === "replace" ? `${f.file}.next` : f.file;
      // Keep all IDs, offsets, and the total file length, but break the branch between the
      // completion and reply. A cached old position or an old reply cannot be reused.
      writeFileSync(target, "");
      writeFileSync(
        target,
        rows(
          { sessionId: f.nativeId, ...legacyReport },
          { sessionId: f.nativeId, ...nativeReply },
          { sessionId: f.nativeId, ...completion, parentUuid: randomUUID() },
        ),
      );
      if (method === "replace") renameSync(target, f.file);
      f.scan();
      expect(await f.nativeReply(bridge)).toBeUndefined();
      expect(f.ledger.get(f.key, "account:fixture").latestResult?.id).toBe(before.latestResult?.id);
    },
  );

  it("binds non-bridge and no-reply results to the current generation without changing their anchors", async () => {
    const f = fixture();
    const prompt = randomUUID(),
      answer = randomUUID();
    const recorded = { ...bridge, id: `turn:${prompt}`, turnId: prompt, itemId: answer };
    const cancelled = { ...recorded, itemId: null, outcome: "cancelled" as const };
    f.append(
      user(prompt),
      assistant(answer, "Visible native reply", { parentUuid: prompt, timestamp: replyTime }),
      nativeEnd(answer),
    );
    const original = await f.proof(recorded);
    const noReply = await f.proof(cancelled);
    expect(original).toMatchObject({
      itemId: answer,
      evidence: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(Object.isFrozen(original)).toBe(true);
    expect(await f.proof(recorded)).toEqual(original);
    expect(noReply).toMatchObject({
      itemId: null,
      evidence: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(noReply?.evidence).not.toBe(original?.evidence);
    utimesSync(f.file, new Date(0), new Date(0));
    expect(await f.proof(recorded)).toMatchObject({ itemId: answer });
    expect((await f.proof(recorded))?.evidence).not.toBe(original?.evidence);
    expect((await f.proof(cancelled))?.evidence).not.toBe(noReply?.evidence);
  });

  it("shares a cold tail scan by file generation and equivalent bridge window", async () => {
    const f = fixture();
    const prompt = randomUUID(),
      answer = randomUUID();
    const prefix = user(prompt);
    const reply = assistant(answer, "Original native reply", {
      parentUuid: prompt,
      timestamp: replyTime,
    });
    const completion = nativeEnd(answer);
    f.append(prefix, reply, completion);

    const release = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    const replaced = Promise.withResolvers<void>();
    const readTail = terminalEvidence.completeClaudeTail;
    const verifyTail = terminalEvidence.readVerifiedClaudeTail;
    let started = 0;
    vi.spyOn(terminalEvidence, "readVerifiedClaudeTail").mockImplementation((file, read) =>
      verifyTail(file, (log, version) => {
        const readResult = read(log, version);
        if (++started === 2) joined.resolve();
        if (started === 3) replaced.resolve();
        return readResult;
      }),
    );
    const reads = vi
      .spyOn(terminalEvidence, "completeClaudeTail")
      .mockImplementation(async function* (...args) {
        await release.promise;
        yield* readTail(...args);
      });

    const window = { startedAt, completedAt: bridge.completedAt };
    const get = (interval = window) => verifyClaudeReadResult(f.file, f.nativeId, bridge, interval);
    const first = get();
    const same = get({ ...window, startedAt: "2026-11-01T00:00:03.000+00:00" });
    let next: ReturnType<typeof get> | undefined;
    try {
      await joined.promise;
      expect(reads).toHaveBeenCalledTimes(1);
      writeFileSync(
        f.file,
        rows(
          ...[
            prefix,
            assistant(answer, "Replaced native reply", {
              parentUuid: prompt,
              timestamp: replyTime,
            }),
            completion,
          ].map((value) => ({ sessionId: f.nativeId, ...value })),
        ),
      );
      utimesSync(f.file, new Date(0), new Date(0));
      next = get();
      await replaced.promise;
      expect(reads).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await Promise.all([first, same, next]);
    }
    expect(await first).toBeUndefined();
    expect(await same).toBeUndefined();
    expect(await next).toMatchObject({ itemId: answer });
    expect(await get()).toEqual(await next);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("uses a legacy report as a new prompt without inheriting the previous turn's answer", () => {
    const f = fixture();
    f.append(user(randomUUID()), assistant(randomUUID(), "Old reply"), ended());
    f.scan();
    f.acknowledge();
    const report = randomUUID();
    f.append(
      user(report, [{ type: "text", text: "[AgentKib report] Worker completed." }], {
        isMeta: true,
        origin: { kind: "plugin", name: "agentkib-bridge" },
      }),
      nativeEnd(report),
    );
    f.scan();
    expect(f.ledger.get(f.key, "owner")).toMatchObject({
      status: "unread",
      latestResult: { id: `turn:${report}`, turnId: report, itemId: null },
    });
  });

  it.each([false, true])(
    "does not reuse the preceding reply when a new tool/thinking-only turn ends (failed=%s)",
    (error) => {
      const f = fixture(),
        first = randomUUID(),
        reply = randomUUID(),
        next = randomUUID();
      f.append(
        user(first),
        assistant(reply, [{ type: "text", text: "Previous visible reply" }]),
        ended(),
      );
      f.scan();
      expect(f.ledger.get(f.key, "owner").latestResult?.itemId).toBe(reply);
      f.acknowledge();
      f.append(
        user(next),
        assistant(randomUUID(), [{ type: "thinking", thinking: "Hidden reasoning" }]),
        assistant(randomUUID(), [{ type: "tool_use", id: "call", name: "Read", input: {} }]),
      );
      f.scan();
      const restarted = new ReadStateLedger(f.root);
      f.append(
        user(randomUUID(), [{ type: "tool_result", tool_use_id: "call", content: "Tool output" }]),
        ended(error),
      );
      f.scan(restarted);
      expect(restarted.get(f.key, "owner")).toMatchObject({
        status: "unread",
        latestResult: {
          id: `turn:${next}`,
          turnId: next,
          itemId: null,
          outcome: error ? "failed" : "ended",
        },
      });
      f.acknowledge(restarted);
      f.scan(restarted);
      expect(restarted.get(f.key, "owner").status).toBe("read");
    },
  );
  it("keeps the managed input UUID through tool results and internal rows, without reviving an acknowledged live result", () => {
    const f = fixture(),
      input = randomUUID();
    f.ledger.record(f.key, {
      id: `turn:${input}`,
      turnId: input,
      itemId: null,
      outcome: "ended",
      completedAt: null,
    });
    f.acknowledge();
    f.append(
      user(input),
      assistant(randomUUID(), [{ type: "tool_use", id: "call", name: "Read", input: {} }]),
      user(randomUUID(), [{ type: "tool_result", tool_use_id: "call", content: "Tool output" }]),
      user(randomUUID(), "Internal metadata", { isMeta: true }),
      user(randomUUID(), "Compaction summary", { isCompactSummary: true }),
      user(randomUUID(), "Sidechain prompt", { isSidechain: true }),
      ended(),
    );
    expect(f.scan().changed).toBe(false);
    expect(f.ledger.get(f.key, "owner")).toMatchObject({
      status: "read",
      latestResult: { id: `turn:${input}`, turnId: input, itemId: null },
    });
    f.append(
      user(randomUUID(), [
        { type: "tool_result", tool_use_id: "call", content: "Repeated result" },
      ]),
      ended(),
    );
    const restarted = new ReadStateLedger(f.root);
    expect(f.scan(restarted).changed).toBe(false);
    expect(f.scan(restarted).changed).toBe(false);
    expect(restarted.get(f.key, "owner").status).toBe("read");
  });
  it.each(["not-a-native-uuid", "msg_server_identifier"])(
    "uses the terminal marker when visible text has no history-stable message ID (%s)",
    (id) => {
      const f = fixture(),
        input = randomUUID();
      f.append(
        user(input),
        assistant(id, [{ type: "text", text: "Visible text without a stable UUID" }]),
        ended(),
      );
      f.scan();
      expect(f.ledger.get(f.key, "owner").latestResult).toMatchObject({
        id: `turn:${input}`,
        itemId: null,
      });
    },
  );
  it("anchors multi-block visible text to the same event ID as the real history parser", () => {
    const f = fixture(),
      input = randomUUID(),
      id = randomUUID();
    f.append(
      user(input),
      assistant(id, [
        { type: "thinking", thinking: "Hidden" },
        { type: "text", text: "First visible block" },
        { type: "text", text: "Last visible block" },
      ]),
      ended(),
    );
    f.scan();
    const state = f.ledger.get(f.key, "owner"),
      page = new SessionPaging().read(f.file, null, 50, "claude-code");
    expect(state.latestResult?.itemId).toBe(`${id}:text:2`);
    expect(page.events.find((event) => event.id === state.latestResult?.itemId)).toMatchObject({
      kind: "agent-message",
      content: "Last visible block",
    });
  });
  it("ignores compact/meta/sidechain assistant bodies and local command output as new user input", () => {
    const f = fixture(),
      input = randomUUID();
    f.append(
      user(input),
      assistant(randomUUID(), [{ type: "text", text: "Hidden compact summary" }], {
        isCompactSummary: true,
      }),
      assistant(randomUUID(), "Hidden metadata", { isMeta: true }),
      assistant(randomUUID(), "Hidden sidechain", { isSidechain: true }),
      user(randomUUID(), "<local-command-stdout>Compacted</local-command-stdout>"),
      ended(),
    );
    f.scan();
    expect(f.ledger.get(f.key, "owner").latestResult).toMatchObject({
      id: `turn:${input}`,
      turnId: input,
      itemId: null,
    });
  });
});
