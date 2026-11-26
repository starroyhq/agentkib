import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeHostStateStore,
  claudeTurnTokens,
  type ClaudeHostGoal,
  type ClaudeHostWork,
} from "../../../packages/backend/src/agents/claude/claude-host-state";
import { openManagedLedger } from "../../../packages/backend/src/managed-ledger";
import {
  projectWorkerReports,
  rememberWorkerReport,
} from "../../../packages/backend/src/worker-report-ledger";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentkib-claude-host-"));
  directories.push(directory);
  const sessionId = randomUUID();
  const store = new ClaudeHostStateStore(directory, randomUUID());
  return { directory, sessionId, store };
}
function goal(overrides: Partial<ClaudeHostGoal> = {}): ClaudeHostGoal {
  return {
    id: randomUUID(),
    generation: randomUUID(),
    objective: "Complete the synthetic check",
    status: "active",
    deviceId: "device-a",
    tokenBudget: null,
    tokensUsed: 0,
    reason: null,
    lastReport: null,
    ...overrides,
  };
}
function queued(overrides: Partial<ClaudeHostWork> = {}): ClaudeHostWork {
  return {
    id: randomUUID(),
    requestId: randomUUID(),
    deviceId: "device-a",
    originDeviceId: "device-a",
    kind: "queue",
    status: "pending",
    input: "Synthetic queued input",
    requiresAttachments: false,
    createdAt: new Date().toISOString(),
    report: null,
    usage: null,
    ...overrides,
  };
}
function dispatch(store: ClaudeHostStateStore, sessionId: string): ClaudeHostWork {
  const work = store.next(sessionId)!;
  expect(work).not.toBeNull();
  store.claim(sessionId, work.id, work.deviceId);
  store.dispatched(sessionId, work.id);
  return work;
}
function pendingReport(stepId: string, outcome: "continue" | "complete" | "blocked" = "complete") {
  return {
    stepId,
    reportId: randomUUID(),
    outcome,
    summary: "Synthetic check passed",
    evidence: ["Checked output in fixture"],
    remainingWork: outcome === "complete" ? [] : ["Next check"],
  };
}

describe("terminal Project Agent report import", () => {
  it("binds each imported report to the managed user message that receives its text", async () => {
    const { directory, sessionId, store } = await fixture();
    const recorded = ["first", "second", "third"].map((text) => ({
      reportId: randomUUID(),
      text,
      parts: [
        {
          text,
          meta: {
            kind: "turn-ended" as const,
            agent: "codex",
            workerSessionId: text,
            workerName: text,
            occurredAt: "2026-11-26T12:00:00.000Z",
            requiresUser: false,
          },
        },
      ],
    }));
    for (const delivery of recorded) rememberWorkerReport(directory, sessionId, delivery);
    const [first, second, third] = recorded;
    store.addReport(sessionId, "device-a", first.text, first.reportId);
    store.importTerminalHandover(
      sessionId,
      {},
      [{ id: second.reportId, text: second.text }],
      "device-a",
    );
    const original = dispatch(store, sessionId);
    store.complete(sessionId, original.requestId, { success: true, usage: null });
    store.importTerminalHandover(
      sessionId,
      {},
      [{ id: second.reportId, text: "second\n\nthird", mergedIds: [third.reportId] }],
      "device-a",
    );
    const suffix = dispatch(store, sessionId);

    const project = ({ requestId, input }: ClaudeHostWork) =>
      projectWorkerReports(directory, sessionId, {
        kind: "user-message",
        id: requestId,
        content: input,
      });
    expect(project(original)).toMatchObject({
      content: "first\n\nsecond",
      worker_reports: {
        reportId: first.reportId,
        parts: [first.parts[0].meta, second.parts[0].meta],
      },
    });
    expect(project(suffix)).toMatchObject({
      content: "third",
      worker_reports: { reportId: third.reportId, parts: [third.parts[0].meta] },
    });
  });

  it("joins waiting reports and recognizes retries after delivery, restart, and work pruning", async () => {
    const { directory, sessionId, store } = await fixture();
    const primary = randomUUID();
    const merged = randomUUID();
    const secondBatch = randomUUID();
    const reports = [
      { id: primary, text: "one\n\ntwo", mergedIds: [merged] },
      { id: secondBatch, text: "three" },
    ];
    store.addReport(sessionId, "device-a", "already waiting");
    store.importTerminalHandover(sessionId, {}, reports, "device-a");
    store.importTerminalHandover(sessionId, {}, reports, "device-a");
    const work = dispatch(store, sessionId);
    expect(work.input).toBe("already waiting\n\none\n\ntwo\n\nthree");
    store.complete(sessionId, work.requestId, { success: true, usage: null });
    // Like retained-history pruning, remove the settled work, keeping the source receipts.
    store.update(sessionId, (state) => (state.work = []));

    const restarted = new ClaudeHostStateStore(directory, randomUUID());
    restarted.importTerminalHandover(sessionId, {}, reports, "device-a");
    expect(restarted.addReport(sessionId, "device-a", "one", primary)).toBe(false);
    expect(restarted.addReport(sessionId, "device-a", "two", merged)).toBe(true);
    expect(restarted.addReport(sessionId, "device-a", "three", secondBatch)).toBe(false);
    expect(() => restarted.addReport(sessionId, "device-b", "one", primary)).toThrow(
      "request-id-reused-with-different-input",
    );
    expect(restarted.next(sessionId)).toBeNull();
  });

  it("imports only newly appended text when a prior handover could not acknowledge the bridge", async () => {
    const { directory, sessionId, store } = await fixture();
    const id = randomUUID();
    const appended = randomUUID();
    store.importTerminalHandover(sessionId, {}, [{ id, text: "first" }], "device-a");

    const restarted = new ClaudeHostStateStore(directory, randomUUID());
    const reports = [{ id, text: "first\n\nsecond", mergedIds: [appended] }];
    restarted.importTerminalHandover(sessionId, {}, reports, "device-a");
    restarted.importTerminalHandover(sessionId, {}, reports, "device-a");
    expect(restarted.addReport(sessionId, "device-a", "second", appended)).toBe(true);
    expect(restarted.read(sessionId).work.map(({ input }) => input)).toEqual(["first\n\nsecond"]);
    expect(() =>
      restarted.importTerminalHandover(sessionId, {}, [{ id, text: "unrelated" }], "device-a"),
    ).toThrow("claude-terminal-report-unconfirmed");
  });

  it("keeps separate batches at the managed merge limit and recognizes previously imported work", async () => {
    const { sessionId, store } = await fixture();
    const known = randomUUID();
    const merged = randomUUID();
    const prior = "a".repeat(16_000);
    const next = "b".repeat(16_000);
    store.update(sessionId, (state) => {
      state.work.push(queued({ id: known, requestId: known, kind: "report", input: prior }));
    });
    store.importTerminalHandover(
      sessionId,
      {},
      [
        { id: known, text: prior, mergedIds: [merged] },
        { id: randomUUID(), text: next },
      ],
      "device-a",
    );
    expect(store.addReport(sessionId, "device-a", "already imported", merged)).toBe(true);
    expect(store.read(sessionId).work.map(({ input }) => input)).toEqual([prior, next]);
  });
});

describe("Claude sessions an earlier release archived in AgentKib", () => {
  function legacy(directory: string, sessionId: string, state: Record<string, unknown>) {
    const database = openManagedLedger(directory, true)!;
    try {
      database.exec(
        "CREATE TABLE IF NOT EXISTS claude_host_states(session_id TEXT PRIMARY KEY, record TEXT NOT NULL)",
      );
      database
        .prepare("INSERT INTO claude_host_states(session_id,record) VALUES(?,?)")
        .run(sessionId, JSON.stringify(state));
    } finally {
      database.close();
    }
  }
  // Archive always paused; the flag alone is enough to stay paused.
  const archived = (bootId: string) => ({
    version: 1,
    bootId,
    revision: 4,
    title: null,
    archived: true,
    settings: {},
    paused: false,
    reason: "archived",
    goal: goal({ status: "paused", reason: "archived" }),
    work: [queued()],
    settledRequests: [],
  });

  it("come back as unarchive left them: paused until the user resumes", async () => {
    const { directory, sessionId } = await fixture();
    const bootId = randomUUID();
    legacy(directory, sessionId, archived(bootId));
    const store = new ClaudeHostStateStore(directory, bootId);
    // A catalog peek sees the same, without writing.
    expect(store.peek(sessionId)).not.toHaveProperty("archived");
    const state = store.read(sessionId);
    expect(state).not.toHaveProperty("archived");
    expect(state).toMatchObject({
      paused: true,
      reason: "resume-confirmation-required",
      goal: { status: "paused", reason: "resume-confirmation-required" },
      revision: 5,
    });
    // Nothing runs until the user resumes.
    expect(store.next(sessionId)).toBeNull();
    expect(store.read(sessionId).revision).toBe(5);
  });

  it("are left as they were when they were not archived", async () => {
    const { directory, sessionId } = await fixture();
    const bootId = randomUUID();
    legacy(directory, sessionId, {
      ...archived(bootId),
      archived: false,
      paused: false,
      reason: null,
      goal: null,
    });
    const state = new ClaudeHostStateStore(directory, bootId).read(sessionId);
    expect(state).not.toHaveProperty("archived");
    expect(state).toMatchObject({ paused: false, reason: null, revision: 4 });
  });

  it("forget a deleted session's state", async () => {
    const { store, sessionId } = await fixture();
    store.pause(sessionId, "delete-requested");
    expect(store.peek(sessionId)).toMatchObject({ paused: true });
    store.forget(sessionId);
    expect(store.peek(sessionId)).toBeNull();
  });
});

describe("Claude host orchestration persistence", () => {
  it("commits receipts with mutations and rejects cross-device request ID reuse", async () => {
    const { store, sessionId, directory } = await fixture();
    const command = {
      requestId: randomUUID(),
      deviceId: "device-a",
      operation: "rename",
      title: "Title",
      runtimeBootId: store.bootId,
    };
    let writes = 0;
    const mutate = (state: ReturnType<typeof store.read>) => {
      writes++;
      state.title = "Title";
      return { title: state.title };
    };
    const first = store.command(sessionId, command, "workspace", mutate);
    const reloaded = new ClaudeHostStateStore(directory, randomUUID());
    expect(
      reloaded.command(
        sessionId,
        { ...command, runtimeBootId: reloaded.bootId },
        "workspace",
        mutate,
      ),
    ).toEqual(first);
    expect(writes).toBe(1);
    expect(reloaded.read(sessionId).title).toBe("Title");
    expect(() =>
      reloaded.command(sessionId, { ...command, deviceId: "device-b" }, "workspace", mutate),
    ).toThrow("request-id-reused-with-different-input");
    expect(() =>
      reloaded.command(sessionId, { ...command, title: "Different" }, "workspace", mutate),
    ).toThrow("request-id-reused-with-different-input");
    expect(writes).toBe(1);
  });

  it("claims the oldest queue item before any goal and keeps exactly one dispatched item", async () => {
    const { store, sessionId } = await fixture();
    const first = queued();
    const second = queued({ deviceId: "device-b", originDeviceId: "device-b" });
    store.update(sessionId, (state) => {
      state.goal = goal();
      state.work.push(first, second);
    });
    expect(store.next(sessionId)?.id).toBe(first.id);
    expect(() => store.claim(sessionId, second.id, second.deviceId)).toThrow("stale-queue-order");
    expect(() => store.claim(sessionId, first.id, "device-b")).toThrow("stale-schedule-item");
    store.claim(sessionId, first.id, first.deviceId);
    expect(store.next(sessionId)).toBeNull();
    expect(() => store.claim(sessionId, second.id, second.deviceId)).toThrow("schedule-paused");
    store.dispatched(sessionId, first.id);
    store.complete(sessionId, first.requestId, { success: true, usage: null });
    expect(dispatch(store, sessionId).id).toBe(second.id);
    store.complete(sessionId, second.requestId, { success: true, usage: null });
    expect(store.next(sessionId)?.kind).toBe("goal");
  });

  it("sends a lead's reports after the person's queued messages and before the goal, as one message while they wait", async () => {
    const { store, sessionId } = await fixture();
    const message = queued();
    store.update(sessionId, (state) => {
      state.goal = goal();
      state.work.push(message);
    });
    expect(store.addReport(sessionId, "device-a", '[AgentKib report] Lane "a" · turn ended')).toBe(
      false,
    );
    expect(store.addReport(sessionId, "device-a", '[AgentKib report] Lane "b" · turn ended')).toBe(
      true,
    );
    expect(store.next(sessionId)?.id).toBe(message.id);
    const report = store.read(sessionId).work.find((work) => work.kind === "report")!;
    expect(() => store.claim(sessionId, report.id, "device-a")).toThrow("stale-queue-order");
    store.claim(sessionId, message.id, message.deviceId);
    store.dispatched(sessionId, message.id);
    store.complete(sessionId, message.requestId, { success: true, usage: null });
    expect(store.next(sessionId)).toMatchObject({
      kind: "report",
      deviceId: "device-a",
      input: '[AgentKib report] Lane "a" · turn ended\n\n[AgentKib report] Lane "b" · turn ended',
    });
    store.claim(sessionId, report.id, "device-a");
    // Claimed: a later report waits for a turn of its own.
    expect(store.addReport(sessionId, "device-a", "later")).toBe(false);
    store.dispatched(sessionId, report.id);
    store.complete(sessionId, report.requestId, { success: true, usage: null });
    expect(store.next(sessionId)).toMatchObject({ kind: "report", input: "later" });
    expect(() => store.addReport(sessionId, "device a", "x")).toThrow("invalid-report");
  });

  it("replays a report ID without requeueing or remerging even after its turn completed", async () => {
    const { store, sessionId, directory } = await fixture();
    const first = randomUUID();
    const merged = randomUUID();
    expect(store.addReport(sessionId, "device-a", "one", first)).toBe(false);
    expect(store.addReport(sessionId, "device-a", "two", merged)).toBe(true);
    expect(store.addReport(sessionId, "device-a", "two", merged)).toBe(true);
    const report = dispatch(store, sessionId);
    expect(report.input).toBe("one\n\ntwo");
    store.complete(sessionId, report.requestId, { success: true, usage: null });

    const restarted = new ClaudeHostStateStore(directory, "new-boot");
    expect(restarted.addReport(sessionId, "device-a", "one", first)).toBe(false);
    expect(restarted.addReport(sessionId, "device-a", "two", merged)).toBe(true);
    expect(() => restarted.addReport(sessionId, "device-a", "other", merged)).toThrow(
      "request-id-reused-with-different-input",
    );
    expect(restarted.next(sessionId)).toBeNull();
  });

  it("does not merge a small new report ahead of an older batch that could not fit", async () => {
    const { store, sessionId } = await fixture();
    const first = `first ${"a".repeat(19_000)}`;
    const second = `second ${"b".repeat(19_000)}`;
    expect(store.addReport(sessionId, "device-a", first, randomUUID())).toBe(false);
    expect(store.addReport(sessionId, "device-a", second, randomUUID())).toBe(false);
    const thirdId = randomUUID();
    expect(store.addReport(sessionId, "device-a", "third", thirdId)).toBe(true);
    expect(store.addReport(sessionId, "device-a", "third", thirdId)).toBe(true);

    let work = dispatch(store, sessionId);
    expect(work.input).toBe(first);
    store.complete(sessionId, work.requestId, { success: true, usage: null });
    work = dispatch(store, sessionId);
    expect(work.input).toBe(`${second}\n\nthird`);
    store.complete(sessionId, work.requestId, { success: true, usage: null });
    expect(store.next(sessionId)).toBeNull();
  });

  it("returns pre-dispatch claims to pending but requires confirmation after restart", async () => {
    const { store, sessionId, directory } = await fixture();
    const item = queued();
    store.update(sessionId, (state) => {
      state.goal = goal();
      state.work.push(item);
    });
    store.claim(sessionId, item.id, item.deviceId);
    const restarted = new ClaudeHostStateStore(directory, randomUUID());
    const recovered = restarted.read(sessionId);
    expect(recovered.work[0]?.status).toBe("pending");
    expect(recovered.paused).toBe(true);
    expect(recovered.reason).toBe("restart-confirmation-required");
    expect(recovered.goal?.status).toBe("paused");
    expect(recovered.bootId).toBe(restarted.bootId);
    expect(restarted.next(sessionId)).toBeNull();
    expect(restarted.read(sessionId).revision).toBe(recovered.revision);
  });

  it("never resends dispatched work after restart without explicit resolution", async () => {
    const { store, sessionId, directory } = await fixture();
    const item = queued();
    store.update(sessionId, (state) => state.work.push(item));
    dispatch(store, sessionId);
    const restarted = new ClaudeHostStateStore(directory, randomUUID());
    expect(restarted.read(sessionId).work[0]?.status).toBe("unknown");
    restarted.update(sessionId, (state) => {
      state.paused = false;
      state.reason = null;
    });
    expect(restarted.next(sessionId)).toBeNull();
    expect(() => restarted.claim(sessionId, item.id, item.deviceId)).toThrow("schedule-paused");
  });

  it("requires a pending report and a successful native result to complete a goal", async () => {
    const { store, sessionId } = await fixture();
    store.update(sessionId, (state) => {
      state.goal = goal();
    });
    const work = dispatch(store, sessionId);
    const report = pendingReport(work.id);
    store.report(sessionId, work.id, report);
    store.report(sessionId, work.id, report);
    expect(store.read(sessionId).goal?.status).toBe("active");
    expect(() => store.report(sessionId, work.id, { ...report, summary: "Changed" })).toThrow(
      "goal-report-conflict",
    );
    store.complete(sessionId, work.requestId, {
      success: true,
      usage: { input_tokens: 2, output_tokens: 3 },
    });
    expect(store.read(sessionId).goal).toMatchObject({
      status: "completed",
      tokensUsed: 5,
      lastReport: report,
    });
    expect(() => store.report(sessionId, work.id, report)).toThrow("stale-goal-report");
    store.complete(sessionId, work.requestId, {
      success: true,
      usage: { input_tokens: 2, output_tokens: 3 },
    });
    expect(store.read(sessionId).goal?.tokensUsed).toBe(5);
  });

  it("pauses a result without a report and rejects reports from an obsolete goal generation", async () => {
    const { store, sessionId } = await fixture();
    store.update(sessionId, (state) => {
      state.goal = goal();
    });
    const work = dispatch(store, sessionId);
    store.update(sessionId, (state) => {
      state.goal!.generation = randomUUID();
    });
    expect(() => store.report(sessionId, work.id, pendingReport(work.id))).toThrow(
      "stale-goal-report",
    );
    store.update(sessionId, (state) => {
      state.goal!.generation = work.goalGeneration!;
    });
    store.complete(sessionId, work.requestId, { success: true, usage: null });
    expect(store.read(sessionId).goal).toMatchObject({
      status: "paused",
      reason: "report-required",
    });
    expect(store.next(sessionId)).toBeNull();
  });

  it("does not resume a user-paused goal when its already-reported native turn finishes", async () => {
    const { store, sessionId } = await fixture();
    store.update(sessionId, (state) => {
      state.goal = goal();
    });
    const work = dispatch(store, sessionId);
    store.report(sessionId, work.id, pendingReport(work.id, "continue"));
    store.update(sessionId, (state) => {
      state.goal!.status = "paused";
      state.goal!.reason = "user-paused";
    });
    store.complete(sessionId, work.requestId, {
      success: true,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(store.read(sessionId).goal).toMatchObject({ status: "paused", reason: "user-paused" });
    expect(store.next(sessionId)).toBeNull();
  });

  it("accounts aggregate native usage once and stops at the token budget", async () => {
    const { store, sessionId } = await fixture();
    store.update(sessionId, (state) => {
      state.goal = goal({ tokenBudget: 20 });
    });
    const work = dispatch(store, sessionId);
    store.report(sessionId, work.id, pendingReport(work.id, "continue"));
    const result = {
      success: true,
      usage: {
        input_tokens: 5,
        output_tokens: 4,
        cache_creation_input_tokens: 6,
        cache_read_input_tokens: 7,
      },
    };
    store.complete(sessionId, work.requestId, result);
    store.complete(sessionId, work.requestId, result);
    expect(store.read(sessionId).goal).toMatchObject({
      tokensUsed: 22,
      status: "budget-exhausted",
    });
    expect(store.next(sessionId)).toBeNull();
  });

  it("does not consume unknown outcome usage or settle the originating request until resolved", async () => {
    const { store, sessionId } = await fixture();
    const originRequestId = randomUUID();
    store.update(sessionId, (state) => {
      state.goal = goal({ tokenBudget: 20 });
    });
    const work = dispatch(store, sessionId);
    store.update(sessionId, (state) => {
      state.work[0]!.originRequestId = originRequestId;
    });
    const usage = { input_tokens: 3, output_tokens: 4 };
    store.complete(sessionId, work.requestId, { success: false, unknown: true, usage });
    store.complete(sessionId, work.requestId, { success: false, unknown: true, usage });
    expect(store.read(sessionId).goal).toMatchObject({ tokensUsed: 0, status: "paused" });
    expect(store.read(sessionId).settledRequests).toEqual([]);
    expect(store.read(sessionId).work[0]?.status).toBe("unknown");
    store.complete(sessionId, work.requestId, { success: false, cancelled: true, usage });
    store.complete(sessionId, work.requestId, { success: false, cancelled: true, usage });
    expect(store.read(sessionId).goal?.tokensUsed).toBe(7);
    expect(store.read(sessionId).settledRequests).toEqual([originRequestId]);
  });

  it("pauses queue failures and goals with missing bounded usage", async () => {
    const { store, sessionId } = await fixture();
    const item = queued();
    store.update(sessionId, (state) => state.work.push(item));
    dispatch(store, sessionId);
    store.complete(sessionId, item.requestId, { success: false, usage: null });
    expect(store.read(sessionId)).toMatchObject({ paused: true, reason: "turn-failed" });
    store.update(sessionId, (state) => {
      state.paused = false;
      state.reason = null;
      state.goal = goal({ tokenBudget: 20 });
    });
    const work = dispatch(store, sessionId);
    store.report(sessionId, work.id, pendingReport(work.id));
    store.complete(sessionId, work.requestId, { success: true, usage: null });
    expect(store.read(sessionId).goal).toMatchObject({
      status: "paused",
      reason: "usage-unavailable",
      tokensUsed: 0,
    });
    expect(store.next(sessionId)).toBeNull();
  });

  it("blocks repeated reports that offer no new evidence after three steps", async () => {
    const { store, sessionId } = await fixture();
    store.update(sessionId, (state) => {
      state.goal = goal();
    });
    for (let count = 0; count < 4; count++) {
      const work = dispatch(store, sessionId);
      store.report(sessionId, work.id, pendingReport(work.id, "continue"));
      store.complete(sessionId, work.requestId, {
        success: true,
        usage: { input_tokens: 0, output_tokens: 1 },
      });
    }
    expect(store.read(sessionId).goal).toMatchObject({
      status: "blocked",
      reason: "no-progress",
      noProgressCount: 3,
      tokensUsed: 4,
    });
    expect(store.next(sessionId)).toBeNull();
  });

  it("keeps a verified completed goal complete even when its final turn reaches the budget", async () => {
    const { store, sessionId } = await fixture();
    store.update(sessionId, (state) => {
      state.goal = goal({ tokenBudget: 10 });
    });
    const work = dispatch(store, sessionId);
    store.report(sessionId, work.id, pendingReport(work.id, "complete"));
    store.complete(sessionId, work.requestId, {
      success: true,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(store.read(sessionId).goal).toMatchObject({ status: "completed", tokensUsed: 15 });
    expect(store.next(sessionId)).toBeNull();
  });

  it("rejects invalid native token accounting instead of manufacturing a zero budget charge", () => {
    expect(claudeTurnTokens({ input_tokens: 0, output_tokens: 0 })).toBe(0);
    expect(claudeTurnTokens(null)).toBeNull();
    expect(claudeTurnTokens({ input_tokens: 1 })).toBeNull();
    expect(claudeTurnTokens({ input_tokens: -1, output_tokens: 1 })).toBeNull();
    expect(
      claudeTurnTokens({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: "2" }),
    ).toBeNull();
    expect(
      claudeTurnTokens({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }),
    ).toBeNull();
  });

  it.each(["succeeded", "cancelled"] as const)(
    "recovers a legacy %s usage gap and blocks bounded scheduling",
    async (status) => {
      const { store, sessionId } = await fixture();
      const legacyGoal = goal({ tokenBudget: 100, tokensUsed: 9 });
      const missing = queued({
        kind: "goal",
        status,
        goalGeneration: legacyGoal.generation,
        usage: null,
      });
      const pending = queued({ kind: "goal", goalGeneration: legacyGoal.generation });
      store.update(sessionId, (state) => {
        state.goal = legacyGoal;
        state.work.push(missing, pending);
      });
      expect(store.read(sessionId).goal).toMatchObject({
        usageIncomplete: true,
        missingUsageStepIds: [missing.id],
        tokensUsed: 9,
      });
      expect(() => store.claim(sessionId, pending.id, pending.deviceId)).toThrow(
        "usage-unavailable",
      );
      expect(store.next(sessionId)).toBeNull();
      expect(store.read(sessionId).goal).toMatchObject({
        status: "paused",
        reason: "usage-unavailable",
        tokensUsed: 9,
      });
      store.update(sessionId, (state) => {
        state.goal!.generation = randomUUID();
        state.goal!.status = "active";
      });
      expect(store.next(sessionId)).toBeNull();
      expect(store.read(sessionId).goal).toMatchObject({ usageIncomplete: true, tokensUsed: 9 });
    },
  );

  it("repairs a missing native usage record exactly once across a goal update without resuming or losing elapsed evidence", async () => {
    const { store, sessionId } = await fixture();
    store.update(sessionId, (state) => {
      state.goal = goal({ tokenBudget: 100 });
    });
    const work = dispatch(store, sessionId);
    store.report(sessionId, work.id, pendingReport(work.id, "continue"));
    store.complete(sessionId, work.requestId, { success: true, usage: null });
    const missing = store.read(sessionId).goal!;
    store.update(sessionId, (state) => {
      state.goal!.generation = randomUUID();
      state.goal!.objective = "Updated objective";
    });
    store.complete(sessionId, work.requestId, {
      success: true,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(store.read(sessionId).goal).toMatchObject({
      tokensUsed: 15,
      usageIncomplete: false,
      missingUsageStepIds: [],
      elapsedMs: missing.elapsedMs,
      status: "paused",
      reason: "usage-reconciled-requires-resume",
    });
    store.complete(sessionId, work.requestId, {
      success: true,
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    expect(store.read(sessionId).goal?.tokensUsed).toBe(15);
    expect(store.next(sessionId)).toBeNull();
  });

  it("keeps cancelled turn consumption unknown until its actual native usage is available", async () => {
    const { store, sessionId } = await fixture();
    store.update(sessionId, (state) => {
      state.goal = goal({ tokenBudget: 100 });
    });
    const work = dispatch(store, sessionId);
    store.complete(sessionId, work.requestId, { success: false, usage: null, cancelled: true });
    expect(store.read(sessionId).goal).toMatchObject({
      tokensUsed: 0,
      usageIncomplete: true,
      missingUsageStepIds: [work.id],
    });
    store.complete(sessionId, work.requestId, {
      success: false,
      usage: { input_tokens: 7, output_tokens: 3 },
      cancelled: true,
    });
    expect(store.read(sessionId).goal).toMatchObject({
      tokensUsed: 10,
      usageIncomplete: false,
      status: "paused",
    });
    expect(store.read(sessionId).work.find((item) => item.id === work.id)?.status).toBe(
      "cancelled",
    );
  });
});
