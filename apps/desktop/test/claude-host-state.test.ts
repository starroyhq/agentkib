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
} from "../../../packages/backend/src/claude-host-state";
import { openManagedLedger } from "../../../packages/backend/src/managed-ledger";

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
