// @vitest-environment node
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReadStateLedger,
  conversationReadKey,
} from "../../../packages/backend/src/read-state-ledger";
import { observeReadHistory } from "../../../packages/backend/src/read-state-history";
import { readClaudeBridgeReply } from "../../../packages/backend/src/agents/claude/claude-read-reply";
import { SessionPaging } from "../../../packages/backend/src/session-paging";

const roots: string[] = [];
afterEach(() => {
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
  const nativeReply = async (result: Parameters<ReadStateLedger["terminalReplyWindow"]>[1]) => {
    const window = ledger.terminalReplyWindow(key, result);
    return window && readClaudeBridgeReply(file, nativeId, window);
  };
  const acknowledge = (reader = ledger) => {
    const state = reader.get(key, "owner");
    return reader.update(key, "owner", state.version!, state.latestResult!.id);
  };
  return { root, file, ledger, key, nativeId, append, scan, acknowledge, nativeReply };
}
const bridge = {
  id: "turn:bridge",
  turnId: "bridge",
  itemId: null,
  outcome: "ended" as const,
  completedAt: "2026-11-01T00:00:05.100Z",
};
const startedAt = "2026-11-01T00:00:03.000Z";
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
      assistant(reply, "Native reply", { parentUuid: prompt }),
      nativeEnd(
        scenario === "an unrelated parent chain" ? randomUUID() : reply,
        scenario === "completion outside the bridge turn" ? "2026-11-01T00:00:06.000Z" : undefined,
      ),
    );
    if (scenario === "two completions of the same prompt") {
      const otherReply = randomUUID();
      f.append(
        assistant(otherReply, "Second native reply to this prompt", { parentUuid: prompt }),
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
      f.append(
        legacyReport,
        assistant(answer, "Visible native reply", { parentUuid: prompt }),
        nativeEnd(answer),
      );
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
          {
            sessionId: f.nativeId,
            ...assistant(answer, "Visible native reply", { parentUuid: prompt }),
          },
          { sessionId: f.nativeId, ...nativeEnd(randomUUID()) },
        ),
      );
      if (method === "replace") renameSync(target, f.file);
      f.scan();
      expect(await f.nativeReply(bridge)).toBeUndefined();
      expect(f.ledger.get(f.key, "account:fixture").latestResult?.id).toBe(before.latestResult?.id);
    },
  );

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
