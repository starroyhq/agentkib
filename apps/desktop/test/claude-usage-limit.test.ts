// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeHostStateStore,
  type ClaudeHostWork,
} from "../../../packages/backend/src/agents/claude/claude-host-state";
import { ClaudeRunnerState } from "../../../packages/backend/src/agents/claude/claude-managed-runner";
import { ClaudeTurnFailure } from "../../../packages/backend/src/agents/claude/claude-frame-policy";
import {
  AUTO_CONTINUE_TEXT,
  armUsageLimit,
  claudeUsageLimitHit,
  codexUsageLimitHit,
  usageLimitArmable,
  usageLimitAutoContinue,
  holdUsageLimit,
  isAutoContinueText,
  usageLimitContinue,
  usageLimitView,
  type UsageLimitHit,
} from "../../../packages/backend/src/usage-limit";

// The frames follow Claude Code 2.1.323 as read from its binary: a request the account's limits
// refuse becomes an assistant message with `error: "rate_limit"`, `api_error:
// "usage_limit_reached"` and the limit in `api_error_params.rate_limit_info` (`resetsAt` in
// seconds), then a `success` result with `is_error` and HTTP 429. 2.1.263 names the limit only in
// its `rate_limit_event`.

const HOUR = 60 * 60_000;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const text = "You've hit your 5-hour limit · resets 3pm";
const info = (resetsAt: number, rateLimitType = "five_hour", status = "rejected") => ({
  status,
  resetsAt,
  rateLimitType,
  utilization: 1,
  overageStatus: "rejected",
  isUsingOverage: false,
});
const rejection = (rateLimitInfo: unknown, parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  uuid: randomUUID(),
  error: "rate_limit",
  ...(rateLimitInfo
    ? {
        api_error: "usage_limit_reached",
        api_error_status: 429,
        api_error_params: { rate_limit_info: rateLimitInfo },
      }
    : {}),
  message: {
    id: randomUUID(),
    model: "<synthetic>",
    role: "assistant",
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [{ type: "text", text }],
  },
});
const limitedResult = (extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 429,
  result: text,
  duration_ms: 30,
  num_turns: 1,
  total_cost_usd: 0,
  modelUsage: {},
  ...extra,
});

function running() {
  const state = new ClaudeRunnerState(randomUUID());
  state.initialized = true;
  state.frame({ type: "system", subtype: "init", model: "claude-haiku-5-5", apiKeySource: "none" });
  state.begin("synthetic turn", randomUUID());
  return state;
}

describe("when AgentKib continues after a usage limit", () => {
  const now = Date.UTC(2026, 10, 16, 6, 0);
  const hit = (resetsAt: number | null): UsageLimitHit => ({
    resetsAt,
    kind: "five-hour",
    scope: null,
    message: text,
  });
  const hold = (resetsAt: number | null, previous?: ReturnType<typeof holdUsageLimit>) =>
    holdUsageLimit("claude-code", hit(resetsAt), {
      deviceId: "device-a",
      bootId: "boot-1",
      previous,
      now,
      random: () => 0.5,
    });

  it("arms 30–90 s after a reset at most a day away, as Claude Code does", () => {
    expect(hold(now + 2 * HOUR)).toMatchObject({ continueAt: now + 2 * HOUR + 60_000, manual: null });
    const early = holdUsageLimit("claude-code", hit(now + HOUR), {
      deviceId: "d",
      bootId: "b",
      now,
      random: () => 0,
    });
    const late = holdUsageLimit("claude-code", hit(now + HOUR), {
      deviceId: "d",
      bootId: "b",
      now,
      random: () => 0.999,
    });
    expect(early.continueAt! - (now + HOUR)).toBe(30_000);
    expect(late.continueAt! - (now + HOUR)).toBeLessThan(90_000);
    expect(hold(now + 25 * HOUR)).toMatchObject({ continueAt: null, manual: "reset-too-far" });
    expect(hold(null)).toMatchObject({ continueAt: null, manual: "reset-unknown" });
    // DeepSeek Harness has no reset time to wait for.
    expect(
      holdUsageLimit("deepseek-harness", { ...hit(null), kind: "quota" }, {
        deviceId: "d",
        bootId: "b",
      }),
    ).toMatchObject({ continueAt: null, manual: "reset-unknown" });
  });

  it("backs off while the limit outlasts its time, and stops after three continues", () => {
    let limit = hold(now + HOUR);
    limit = { ...limit, autoContinues: 1 };
    // The continue met the limit again at a time already past.
    expect(hold(now - 1_000, limit)).toMatchObject({ continueAt: now + 60_000 });
    expect(hold(now - 1_000, { ...limit, autoContinues: 2 })).toMatchObject({
      continueAt: now + 300_000,
    });
    expect(hold(now + HOUR, { ...limit, autoContinues: 3 })).toMatchObject({
      continueAt: null,
      manual: "repeated",
    });
  });

  it("is due at its time, stale long after it, and never in a later run", () => {
    const limit = hold(now + HOUR);
    expect(usageLimitContinue(limit, "boot-1", now)).toBe("wait");
    expect(usageLimitContinue(limit, "boot-1", limit.continueAt!)).toBe("due");
    expect(usageLimitContinue(limit, "boot-1", limit.continueAt! + 31 * 60_000)).toBe("stale");
    expect(usageLimitContinue(limit, "boot-2", limit.continueAt!)).toBe("never");
    // Clients see no device or run, and a hold from an earlier run as one the person continues.
    expect(usageLimitView(limit, "boot-2")).toEqual({
      resetsAt: now + HOUR,
      kind: "five-hour",
      scope: null,
      message: text,
      agent: "claude-code",
      continueAt: null,
      manual: "restarted",
      autoContinues: 0,
    });
    expect(usageLimitView(limit, "boot-1")).not.toHaveProperty("deviceId");
  });

  it("reads Claude Code's limit names and reset times", () => {
    expect(claudeUsageLimitHit(info(1_800_000_000), text)).toEqual({
      resetsAt: 1_800_000_000_000,
      kind: "five-hour",
      scope: null,
      message: text,
    });
    expect(claudeUsageLimitHit(info(1_800_000_000, "seven_day"), "").kind).toBe("weekly");
    expect(claudeUsageLimitHit(info(1_800_000_000, "seven_day_opus"), "")).toMatchObject({
      kind: "model",
      scope: "Opus",
    });
    expect(
      claudeUsageLimitHit({ rateLimitType: "overage", resetsAt: 1, overageResetsAt: 2 }, ""),
    ).toMatchObject({ kind: "credits", resetsAt: 2000 });
    expect(claudeUsageLimitHit(null, "x")).toEqual({
      resetsAt: null,
      kind: null,
      scope: null,
      message: "x",
    });
    expect(isAutoContinueText(` ${AUTO_CONTINUE_TEXT["claude-code"]}\n`)).toBe(true);
    expect(isAutoContinueText("Continue")).toBe(false);
  });
});

describe("a managed Claude turn that meets the usage limit", () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;

  it("ends as failed with the limit, and the session stays usable", () => {
    const state = running();
    state.frame({ type: "rate_limit_event", rate_limit_info: info(resetsAt), uuid: randomUUID() });
    state.frame(rejection(info(resetsAt)));
    expect(state.frame(limitedResult({ api_error: "usage_limit_reached" }))).toBeNull();
    expect(state.snapshot()).toMatchObject({
      status: "idle",
      lastOutcome: "failed",
      sendEnabled: true,
      reason: `claude-usage-limit: ${text}`,
    });
    expect(state.usageLimit).toEqual({
      resetsAt: resetsAt * 1000,
      kind: "five-hour",
      scope: null,
      message: text,
    });
    // Unlike a rejected login, the worker is not retired.
    expect(state.retireRequested).toBe(false);
    // The next turn starts without it; the account's limits are kept.
    state.begin("again", randomUUID());
    expect(state.usageLimit).toBeNull();
    expect(state.rateLimitInfo).toMatchObject({ resetsAt });
  });

  it("takes the reset time from the rate-limit event when the message has none (2.1.263)", () => {
    const state = running();
    state.frame({ type: "rate_limit_event", rate_limit_info: info(resetsAt, "seven_day") });
    state.frame(rejection(null));
    state.frame(limitedResult());
    expect(state.usageLimit).toMatchObject({ resetsAt: resetsAt * 1000, kind: "weekly" });
  });

  it("keeps a sub-agent's limit and every other failure as they were", () => {
    const sub = running();
    sub.frame(rejection(info(resetsAt), "toolu_agent"));
    expect(() => sub.frame(limitedResult({ api_error_status: 500, result: "API Error: 500" }))).toThrow(
      ClaudeTurnFailure,
    );
    const other = running();
    // An allowed event says nothing about this turn.
    other.frame({ type: "rate_limit_event", rate_limit_info: info(resetsAt, "five_hour", "allowed") });
    expect(() => other.frame(limitedResult({ api_error_status: 500, result: "API Error: 500" }))).toThrow(
      "Claude turn failed: API Error: 500",
    );
  });
});

describe("the host state of a session its usage limit holds", () => {
  async function fixture() {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agentkib-claude-limit-"));
    directories.push(directory);
    const bootId = randomUUID();
    return { directory, bootId, sessionId: randomUUID(), store: new ClaudeHostStateStore(directory, bootId) };
  }
  const limit = (resetsAt: number): UsageLimitHit => ({
    resetsAt,
    kind: "five-hour",
    scope: null,
    message: text,
  });
  const queued = (overrides: Partial<ClaudeHostWork> = {}): ClaudeHostWork => ({
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
  });

  it("holds the queue after the person's message meets the limit, then continues in their name", async () => {
    const { store, sessionId } = await fixture();
    const resetsAt = Date.now() + HOUR;
    // The person's own message is no work item.
    store.complete(sessionId, randomUUID(), {
      success: false,
      usage: null,
      usageLimit: limit(resetsAt),
      deviceId: "phone-1",
    });
    let state = store.read(sessionId);
    expect(state).toMatchObject({ paused: true, reason: "usage-limit" });
    expect(state.usageLimit).toMatchObject({ deviceId: "phone-1", autoContinues: 0, manual: null });
    const continueAt = state.usageLimit!.continueAt!;
    expect(continueAt).toBeGreaterThanOrEqual(resetsAt + 30_000);
    expect(store.next(sessionId)).toBeNull();
    expect(store.continueAfterLimit(sessionId, AUTO_CONTINUE_TEXT["claude-code"], continueAt - 1)).toBe(
      "wait",
    );
    expect(store.continueAfterLimit(sessionId, AUTO_CONTINUE_TEXT["claude-code"], continueAt)).toBe(
      "continued",
    );
    state = store.read(sessionId);
    expect(state).toMatchObject({ paused: false, reason: null });
    expect(state.usageLimit).toMatchObject({ continueAt: null, manual: null, autoContinues: 1 });
    const work = store.next(sessionId)!;
    expect(work).toMatchObject({
      kind: "continue",
      deviceId: "phone-1",
      input: AUTO_CONTINUE_TEXT["claude-code"],
    });
    store.claim(sessionId, work.id, work.deviceId);
    store.dispatched(sessionId, work.id);
    // The continue went through: the limit is over.
    store.complete(sessionId, work.requestId, { success: true, usage: null });
    expect(store.read(sessionId).usageLimit).toBeNull();
  });

  it("sends what was waiting instead of a continue, and counts AgentKib's own turns", async () => {
    const { store, sessionId } = await fixture();
    store.update(sessionId, (state) => {
      state.work.push(queued({ kind: "report", input: "A Worker's report" }));
    });
    store.complete(sessionId, randomUUID(), {
      success: false,
      usage: null,
      usageLimit: limit(Date.now() + HOUR),
      deviceId: "device-a",
    });
    const due = store.read(sessionId).usageLimit!.continueAt!;
    expect(store.continueAfterLimit(sessionId, "continue", due)).toBe("continued");
    const report = store.next(sessionId)!;
    expect(report.kind).toBe("report");
    expect(store.read(sessionId).work.some((work) => work.kind === "continue")).toBe(false);
    store.claim(sessionId, report.id, report.deviceId);
    store.dispatched(sessionId, report.id);
    // The report met the limit again: AgentKib's own turn, so the count goes on.
    store.complete(sessionId, report.requestId, {
      success: false,
      usage: null,
      usageLimit: limit(Date.now() + HOUR),
    });
    expect(store.read(sessionId)).toMatchObject({
      paused: true,
      reason: "usage-limit",
      usageLimit: { autoContinues: 1 },
    });
  });

  it("gives way to the person, waits for them when the time passed long ago or AgentKib restarted", async () => {
    const { store, sessionId, directory } = await fixture();
    store.complete(sessionId, randomUUID(), {
      success: false,
      usage: null,
      usageLimit: limit(Date.now() + HOUR),
      deviceId: "device-a",
    });
    store.personSent(sessionId);
    expect(store.read(sessionId)).toMatchObject({ paused: false, reason: null, usageLimit: null });

    store.complete(sessionId, randomUUID(), {
      success: false,
      usage: null,
      usageLimit: limit(Date.now() + HOUR),
      deviceId: "device-a",
    });
    const due = store.read(sessionId).usageLimit!.continueAt!;
    expect(store.continueAfterLimit(sessionId, "continue", due + 31 * 60_000)).toBe("stale");
    expect(store.read(sessionId)).toMatchObject({
      paused: true,
      usageLimit: { continueAt: null, manual: "stale" },
    });

    const other = randomUUID();
    store.complete(other, randomUUID(), {
      success: false,
      usage: null,
      usageLimit: limit(Date.now() + HOUR),
      deviceId: "device-a",
    });
    const later = new ClaudeHostStateStore(directory, randomUUID());
    const armed = later.read(other).usageLimit!;
    expect(later.continueAfterLimit(other, "continue", armed.continueAt!)).toBe("never");
    expect(usageLimitView(armed, later.bootId)).toMatchObject({ continueAt: null, manual: "restarted" });
  });
});

describe("reading Codex's account limits for the reset time", () => {
  // `account/rateLimits/read` as Codex 0.167.0's schema describes it; `resetsAt` in seconds.
  const window = (usedPercent: number, windowDurationMins: number, resetsAt: number) => ({
    usedPercent,
    windowDurationMins,
    resetsAt,
  });
  it("takes the used-up window that resets last", () => {
    expect(
      codexUsageLimitHit(
        { rateLimits: { primary: window(100, 300, 1_000), secondary: window(60, 10_080, 9_000) } },
        "m",
      ),
    ).toEqual({ resetsAt: 1_000_000, kind: "five-hour", scope: null, message: "m" });
    // Both used up: nothing runs until the weekly one resets.
    expect(
      codexUsageLimitHit(
        { rateLimits: { primary: window(100, 300, 1_000), secondary: window(100, 10_080, 9_000) } },
        "m",
      ),
    ).toMatchObject({ resetsAt: 9_000_000, kind: "weekly" });
    // A model's own limit, by its limit name.
    expect(
      codexUsageLimitHit(
        {
          rateLimits: { primary: window(10, 300, 1_000) },
          rateLimitsByLimitId: {
            codex_other: { limitName: "GPT-6.1-Sol", primary: window(100, 10_080, 5_000) },
          },
        },
        "m",
      ),
    ).toMatchObject({ resetsAt: 5_000_000, kind: "model", scope: "GPT-6.1-Sol" });
  });
  it("leaves the time unknown when nothing is used up or nothing could be read", () => {
    expect(codexUsageLimitHit({ rateLimits: { primary: window(80, 300, 1_000) } }, "m")).toEqual({
      resetsAt: null,
      kind: null,
      scope: null,
      message: "m",
    });
    expect(
      codexUsageLimitHit(
        { rateLimits: { rateLimitReachedType: "workspace_member_credits_depleted" } },
        "m",
      ).kind,
    ).toBe("credits");
    expect(codexUsageLimitHit(null, "m").resetsAt).toBeNull();
  });
});

describe("the person's choice about continuing after a reset", () => {
  const now = Date.UTC(2026, 10, 16, 6, 0);
  const hit: UsageLimitHit = { resetsAt: now + HOUR, kind: "five-hour", scope: null, message: text };
  const context = { deviceId: "d", bootId: "boot-1", now, random: () => 0.5 };

  it("is on unless turned off for this computer", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agentkib-limit-pref-"));
    directories.push(directory);
    expect(usageLimitAutoContinue(directory)).toBe(true);
    const { writePreference } = await import("../../../packages/backend/src/preferences");
    writePreference(directory, "usage_limit_auto_continue", false);
    expect(usageLimitAutoContinue(directory)).toBe(false);
    expect(holdUsageLimit("claude-code", hit, { ...context, autoContinue: false })).toMatchObject({
      continueAt: null,
      manual: "off",
    });
    // Without a reset time there is nothing to choose.
    expect(
      holdUsageLimit("codex", { ...hit, resetsAt: null }, { ...context, autoContinue: false }),
    ).toMatchObject({ manual: "reset-unknown" });
  });

  it("can be asked for this time after all, while the reset is still ahead", () => {
    const off = holdUsageLimit("claude-code", hit, { ...context, autoContinue: false });
    expect(usageLimitArmable(off, "boot-1", now)).toBe(true);
    expect(armUsageLimit({ ...off, autoContinues: 3 }, { bootId: "boot-2", now, random: () => 0 })).toMatchObject({
      continueAt: now + HOUR + 30_000,
      manual: null,
      autoContinues: 0,
      bootId: "boot-2",
    });
    const far = holdUsageLimit("claude-code", { ...hit, resetsAt: now + 30 * HOUR }, context);
    expect(usageLimitArmable(far, "boot-1", now)).toBe(true);
    // Armed already, reset passed, or no reset time: nothing to ask for.
    const armed = holdUsageLimit("claude-code", hit, context);
    expect(usageLimitArmable(armed, "boot-1", now)).toBe(false);
    expect(usageLimitArmable(off, "boot-1", now + 2 * HOUR)).toBe(false);
    expect(
      usageLimitArmable(holdUsageLimit("codex", { ...hit, resetsAt: null }, context), "boot-1", now),
    ).toBe(false);
    // Armed by an earlier run of AgentKib, which no longer fires it.
    expect(usageLimitArmable(armed, "boot-2", now)).toBe(true);
    expect(armUsageLimit(armed, { bootId: "boot-1", now })).toBeNull();
  });
});
