import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conversationReadKey,
  ReadStateLedger,
} from "../../../packages/backend/src/read-state-ledger";
import { observeReadHistory } from "../../../packages/backend/src/read-state-history";
import { managedSessionHasUnknownCommands } from "../../../packages/backend/src/managed-ledger";
import type { ConversationReadResult, ConversationReadState } from "@agentkib/runtime-protocol";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-read-ledger-"));
  roots.push(root);
  return {
    root,
    ledger: new ReadStateLedger(root),
    key: conversationReadKey("claude-code", root, "native"),
  };
}
const result = (
  id: string,
  outcome: ConversationReadResult["outcome"] = "completed",
): ConversationReadResult => ({
  id: `turn:${id}`,
  turnId: id,
  itemId: null,
  outcome,
  completedAt: null,
});
const rows = (turn: string, error = false) =>
  [
    { type: "user", uuid: turn, message: { role: "user", content: "fixture" } },
    { type: "system", subtype: "turn_duration", ...(error ? { error: "fixture failure" } : {}) },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n") + "\n";

describe("durable AgentKib read states", () => {
  it("does not create a database from a pure catalog read or claim unsupported history read", () => {
    const { root, ledger, key } = fixture();
    expect(ledger.catalogStates(new Map([[key, true]]), "a").size).toBe(0);
    expect(ledger.get(key, "a")).toMatchObject({
      status: "unknown",
      freshness: "stale",
      version: null,
    });
    expect(existsSync(path.join(root, "codex-managed"))).toBe(false);
    expect(() =>
      observeReadHistory(ledger, key, "claude-code", path.join(root, "absent")),
    ).toThrow();
    expect(ledger.get(key, "a").status).toBe("unknown");
  });

  it("does not write again when a transcript has not grown", () => {
    const { root, ledger, key } = fixture();
    const transcript = path.join(root, "transcript.jsonl");
    writeFileSync(transcript, rows("one"));
    expect(observeReadHistory(ledger, key, "claude-code", transcript)).toMatchObject({
      complete: true,
    });
    const database = path.join(root, "codex-managed", "executions.sqlite");
    // Another connection sees a commit as a changed data version.
    const reader = new DatabaseSync(database, { readOnly: true });
    try {
      const version = () => Number(reader.prepare("PRAGMA data_version").get()!.data_version);
      const before = version();
      for (let poll = 0; poll < 5; poll++)
        expect(observeReadHistory(ledger, key, "claude-code", transcript).changed).toBe(false);
      expect(version()).toBe(before);
      // A new turn is still recorded.
      appendFileSync(transcript, rows("two"));
      expect(observeReadHistory(ledger, key, "claude-code", transcript).changed).toBe(true);
      expect(version()).not.toBe(before);
    } finally {
      reader.close();
    }
    expect(ledger.get(key, "a").latestResult?.turnId).toBe("two");
  });

  it("uses one canonical source across aliases, but isolates reader scopes and execution receipts", () => {
    const { root, ledger, key } = fixture();
    mkdirSync(path.join(root, "profile"));
    symlinkSync(path.join(root, "profile"), path.join(root, "alias"));
    expect(conversationReadKey("codex", path.join(root, "profile"), "id")).toBe(
      conversationReadKey("codex", path.join(root, "alias"), "id"),
    );
    ledger.observe(key, [], null, true);
    ledger.record(key, result("one", "failed"));
    const state = ledger.get(key, "a");
    expect(state).toMatchObject({ status: "unread", latestResult: { outcome: "failed" } });
    expect(ledger.update(key, "a", state.version!, "turn:one").status).toBe("read");
    expect(ledger.get(key, "b").status).toBe("unread");
    expect(managedSessionHasUnknownCommands(root, "native")).toBe(false);
  });

  it("rejects an ACK when another result completed, survives restart, and deduplicates terminal delivery", () => {
    const { root, ledger, key } = fixture();
    ledger.observe(key, [], null, true);
    ledger.record(key, result("one"));
    const seen = ledger.get(key, "a");
    ledger.record(key, result("two", "cancelled"));
    expect(() => ledger.update(key, "a", seen.version!, seen.latestResult!.id)).toThrow(
      "read-state-conflict",
    );
    const current = ledger.get(key, "a");
    ledger.update(key, "a", current.version!, current.latestResult!.id);
    const restarted = new ReadStateLedger(root);
    expect(restarted.get(key, "a").status).toBe("read");
    expect(restarted.record(key, result("two", "cancelled"))).toBe(false);
    expect(restarted.get(key, "a").status).toBe("read");
  });

  it("baselines old explicit outcomes only, persists checkpoints and notices results appended after restart", () => {
    const { root, ledger, key } = fixture(),
      file = path.join(root, "history.jsonl");
    writeFileSync(file, rows("old"));
    expect(observeReadHistory(ledger, key, "claude-code", file).complete).toBe(true);
    expect(ledger.get(key, "a")).toMatchObject({
      status: "read",
      latestResult: { id: "turn:old", outcome: "ended" },
    });
    appendFileSync(file, rows("new", true));
    const restarted = new ReadStateLedger(root);
    observeReadHistory(restarted, key, "claude-code", file);
    expect(restarted.get(key, "a")).toMatchObject({
      status: "unread",
      firstUnread: { resultId: "turn:new" },
      latestResult: { outcome: "failed", itemId: null },
    });
  });

  it("does not swallow a live completion during the initial history baseline", () => {
    const { root, ledger, key } = fixture(),
      file = path.join(root, "history.jsonl");
    ledger.record(key, result("live", "cancelled"));
    writeFileSync(file, rows("old") + rows("live"));
    observeReadHistory(ledger, key, "claude-code", file);
    expect(ledger.get(key, "a")).toMatchObject({
      status: "unread",
      latestResult: { id: "turn:live", outcome: "cancelled" },
    });
  });

  it("cannot seed a baseline from corrupt or incomplete trailing records", () => {
    const { root, ledger, key } = fixture(),
      file = path.join(root, "history.jsonl");
    writeFileSync(file, "{broken}\n");
    expect(() => observeReadHistory(ledger, key, "claude-code", file)).toThrow();
    expect(ledger.checkpoint(key).complete).toBe(false);
    writeFileSync(file, rows("old") + '{"type":');
    expect(observeReadHistory(ledger, key, "claude-code", file).complete).toBe(false);
    expect(ledger.checkpoint(key).complete).toBe(false);
  });

  it("preserves native manual unread and known unread during a supported-to-fallback handoff", () => {
    const { ledger, key } = fixture();
    ledger.observe(key, [{ result: result("old"), baseline: true }], null, true);
    const native: ConversationReadState = {
      source: "codex-native",
      status: "unread",
      freshness: "current",
      version: "native:one",
      firstUnread: { type: "threadStart" },
      latestResult: result("old"),
    };
    ledger.handoff(key, "a", native);
    const state = ledger.get(key, "a");
    expect(state).toMatchObject({
      source: "agentkib",
      status: "unread",
      firstUnread: { type: "threadStart" },
    });
    expect(ledger.update(key, "a", state.version!, "turn:old").status).toBe("read");
    ledger.handoff(key, "a", {
      ...native,
      firstUnread: { type: "result", resultId: "turn:old", turnId: "old" },
    });
    expect(ledger.get(key, "a").status).toBe("unread");
  });

  it("keeps the latest result distinct from an earlier first-unread and persists handoff consumption", () => {
    const { root, ledger, key } = fixture();
    ledger.observe(
      key,
      [
        { result: result("one"), baseline: true, position: 1 },
        { result: result("two", "failed"), baseline: true, position: 2 },
      ],
      null,
      true,
    );
    const state: ConversationReadState = {
      source: "codex-native",
      status: "unread",
      freshness: "current",
      version: "native",
      firstUnread: { type: "result", resultId: "turn:one", turnId: "one" },
      latestResult: result("two", "failed"),
    };
    ledger.saveNative(key, state, "native-revision");
    const persisted = new ReadStateLedger(root).nativeSnapshot(key)!;
    ledger.handoff(key, "a", persisted.state, persisted.fingerprint);
    const current = ledger.get(key, "a");
    expect(current).toMatchObject({
      firstUnread: { resultId: "turn:one" },
      latestResult: { id: "turn:two", outcome: "failed" },
    });
    ledger.update(key, "a", current.version!, "turn:two");
    const restarted = new ReadStateLedger(root);
    restarted.handoff(key, "a", persisted.state, persisted.fingerprint);
    expect(restarted.get(key, "a").status).toBe("read");
  });

  it("projects catalog rows in bounded queries and preserves scope-specific native handoff evidence", () => {
    const { root, ledger, key } = fixture();
    const nativeKey = conversationReadKey("codex", root, "native");
    const missingKey = conversationReadKey("claude-code", root, "missing");
    ledger.observe(key, [{ result: result("old"), baseline: true }], null, true);
    ledger.record(key, result("new", "failed"));
    const newResult = ledger.get(key, "a");
    ledger.update(key, "a", newResult.version!, newResult.latestResult!.id);
    const native: ConversationReadState = {
      source: "codex-native",
      status: "unread",
      freshness: "current",
      version: "native",
      firstUnread: { type: "threadStart" },
      latestResult: result("native"),
    };
    ledger.saveNative(nativeKey, native, "native-revision");
    const receipt = ledger.nativeSnapshot(nativeKey)!;
    ledger.handoff(nativeKey, "a", receipt.state, receipt.fingerprint);
    const viewed = ledger.get(nativeKey, "a");
    ledger.update(nativeKey, "a", viewed.version!, viewed.latestResult!.id);
    const expectedA = new Map([
      [key, ledger.get(key, "a")],
      [nativeKey, ledger.get(nativeKey, "a")],
    ]);
    const expectedB = new Map([
      [key, ledger.get(key, "b")],
      [nativeKey, { ...native, source: "agentkib", freshness: "stale", version: null }],
    ]);
    const candidates = new Map([
      [key, false],
      [nativeKey, true],
      [missingKey, false],
    ]);
    for (let n = 0; n < 100; n++) candidates.set(`missing-${n}`, true);

    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    expect(ledger.catalogStates(candidates, "a")).toEqual(expectedA);
    expect(ledger.catalogStates(candidates, "b")).toEqual(expectedB);
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("never clears a result that appeared after the last verified native read snapshot", () => {
    const { ledger, key } = fixture();
    ledger.observe(
      key,
      [
        { result: result("one"), baseline: true, position: 1 },
        { result: result("two"), baseline: true, position: 2 },
      ],
      null,
      true,
    );
    ledger.handoff(key, "a", {
      source: "codex-native",
      status: "read",
      freshness: "current",
      version: "native",
      firstUnread: null,
      latestResult: result("one"),
    });
    expect(ledger.get(key, "a")).toMatchObject({
      status: "unread",
      latestResult: { id: "turn:two" },
    });
  });

  it("makes auxiliary persistence failure nonfatal, exposes stale state and recovers observation without a client write", () => {
    const { ledger, key } = fixture();
    ledger.observe(key, [], null, true);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const observe = vi.spyOn(ledger, "observe").mockImplementationOnce(() => {
      throw new Error("synthetic disk failure");
    });
    let businessFinished = false;
    ledger.record(key, result("completed"));
    businessFinished = true;
    expect(businessFinished).toBe(true);
    expect(ledger.get(key, "a").freshness).toBe("stale");
    expect(ledger.catalogStates(new Map([[key, false]]), "a").get(key)?.freshness).toBe("stale");
    expect(warning).toHaveBeenCalledWith(
      "Conversation read-state observation could not be persisted",
    );
    observe.mockRestore();
    ledger.retryObservations(key);
    expect(ledger.get(key, "a")).toMatchObject({
      status: "unread",
      freshness: "current",
      latestResult: { id: "turn:completed" },
    });
  });
});
