import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeManagedRunnerProcess,
  ClaudeRunnerState,
} from "../../../packages/backend/src/claude-managed-runner";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/claude-managed-read";
import { ClaudeTurnFailure } from "../../../packages/backend/src/claude-frame-policy";
import type { BackendStore } from "../../../packages/backend/src/store";
import type { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { Commands } from "../../../packages/backend/src/commands";
import { createFakeClaude, type FakeClaudePlan } from "./fixtures/claude-fake-cli";

// Frames follow what CLI 2.1.311 sent against a local Anthropic API stub (sandboxed to
// localhost, fake key): with ANTHROPIC_API_KEY rejected by a 401 it reported ten
// `system/api_retry` frames over about three minutes, then a synthetic assistant message and an
// error result; with no login at all it failed at once. Played here by the scripted fake CLI.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const init = (apiKeySource: unknown) => ({
  type: "system",
  subtype: "init",
  model: "claude-haiku-5-5",
  permissionMode: "default",
  apiKeySource,
});
const retry = (attempt: number, extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "api_retry",
  attempt,
  max_retries: 10,
  retry_delay_ms: 500 * attempt,
  error_status: 401,
  error: "authentication_failed",
  ...extra,
});
const rejection = (text: string, status: number | null, parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  uuid: randomUUID(),
  error: "authentication_failed",
  is_api_error_message: true,
  ...(status === null ? {} : { api_error_status: status }),
  message: {
    id: randomUUID(),
    model: "<synthetic>",
    role: "assistant",
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [{ type: "text", text }],
  },
});
const failedResult = (text: string, status: number | null, duration = 40) => ({
  type: "result",
  subtype: "success",
  is_error: true,
  terminal_reason: "api_error",
  api_error_status: status,
  result: text,
  duration_ms: duration,
  num_turns: 1,
  total_cost_usd: 0,
  modelUsage: {},
});
const invalidKey = "Invalid API key · Fix external API key";
const notLoggedIn = "Not logged in · Please run /login";

function running(apiKeySource: unknown = "ANTHROPIC_API_KEY") {
  const state = new ClaudeRunnerState(randomUUID());
  state.initialized = true;
  state.frame(init(apiKeySource));
  state.begin("synthetic turn", randomUUID());
  return state;
}

describe("managed Claude authentication failures", () => {
  it("shows the retries, then ends the turn as failed and leaves the session usable", () => {
    const state = running();
    state.frame(retry(1));
    expect(state.snapshot().apiRetry).toEqual({
      attempt: 1,
      maxRetries: 10,
      status: 401,
      error: "authentication_failed",
    });
    state.frame(retry(2));
    expect(state.snapshot().apiRetry?.attempt).toBe(2);
    state.frame(rejection(invalidKey, 401));
    expect(state.snapshot().apiRetry).toBeNull();
    expect(state.frame(failedResult(invalidKey, 401, 184_500))).toBeNull();
    expect(state.snapshot()).toMatchObject({
      status: "idle",
      lastOutcome: "failed",
      sendEnabled: true,
      stopEnabled: false,
      apiRetry: null,
      reason: `claude-auth-failed: ${invalidKey} (HTTP 401); key source: ANTHROPIC_API_KEY`,
      terminalResult: { success: false, terminalReason: "api_error" },
    });
    expect(state.retireRequested).toBe(true);
    // The next turn starts clean.
    state.begin("again", randomUUID());
    expect(state.snapshot()).toMatchObject({ status: "running", reason: null, apiRetry: null });
    expect(state.retireRequested).toBe(false);
  });

  it("classifies the missing login, which reports no HTTP status", () => {
    const state = running("none");
    state.frame(rejection(notLoggedIn, null));
    state.frame(failedResult(notLoggedIn, null));
    expect(state.snapshot().reason).toBe(`claude-auth-failed: ${notLoggedIn}; key source: none`);
    expect(state.retireRequested).toBe(true);
  });

  it("classifies a 401 result even without the assistant's error flag", () => {
    // No key source reported either.
    const state = running(null);
    state.frame(failedResult(invalidKey, 401));
    const { status, reason } = state.snapshot();
    expect({ status, reason }).toEqual({
      status: "idle",
      reason: `claude-auth-failed: ${invalidKey} (HTTP 401)`,
    });
  });

  it("keeps every other failed result on the path that stops the session", () => {
    const other = running();
    expect(() => other.frame(failedResult("API Error: 500 overloaded", 500))).toThrow(
      ClaudeTurnFailure,
    );
    // A sub-agent's rejected request does not make the main turn's failure an auth failure.
    const sub = running();
    sub.frame(rejection(invalidKey, 401, "toolu_agent"));
    expect(() => sub.frame(failedResult("API Error: 500", 500))).toThrow(
      "Claude turn failed: API Error: 500",
    );
    expect(sub.retireRequested).toBe(false);
  });

  it("ignores a retry outside a turn and bounds what a retry reports", () => {
    const state = new ClaudeRunnerState(randomUUID());
    state.initialized = true;
    state.frame(init("key with spaces"));
    expect(state.apiKeySource).toBeNull();
    state.frame(retry(1));
    expect(state.snapshot().apiRetry).toBeNull();
    state.begin("synthetic turn", randomUUID());
    state.frame(retry(0, { max_retries: "10", error_status: 9000, error: "Not An Enum <script>" }));
    expect(state.snapshot().apiRetry).toEqual({
      attempt: 1,
      maxRetries: null,
      status: null,
      error: null,
    });
    // A response that streams again ends the retry.
    state.frame({ type: "stream_event", event: { type: "message_start", message: {} } });
    expect(state.snapshot().apiRetry).toBeNull();
  });
});

function fake(plan: FakeClaudePlan) {
  const f = createFakeClaude("agentkib-claude-auth-");
  f.setPlan(plan);
  cleanups.push(() => rmSync(f.root, { recursive: true, force: true }));
  return f;
}
const authPlan: FakeClaudePlan = {
  afterInitialize: [init("none")],
  onUser: [rejection(notLoggedIn, null), failedResult(notLoggedIn, null, 40)],
  noResult: true,
};

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "a managed Claude worker after an authentication failure",
  () => {
    it("asks to be retired, and the next worker resumes the same session", async () => {
      const f = fake(authPlan);
      const events: Array<{ type: string; payload: Record<string, any> }> = [];
      const sessionId = randomUUID();
      const runner = new ClaudeManagedRunnerProcess(
        f.workspace,
        sessionId,
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
      await runner.send(f.executable, "synthetic turn", randomUUID(), runner.snapshot().revision);
      await expect.poll(() => runner.snapshot().status, { timeout: 15_000 }).toBe("idle");
      expect(runner.snapshot()).toMatchObject({
        lastOutcome: "failed",
        reason: `claude-auth-failed: ${notLoggedIn}; key source: none`,
      });
      expect(runner.retireRequested).toBe(true);
      expect(runner.hasWorker).toBe(true);
      // The CLI's message stays in the conversation and carries the turn end.
      expect(
        events.filter(({ payload }) => payload.turn_meta).map(({ payload }) => payload),
      ).toMatchObject([
        {
          content: notLoggedIn,
          // Claude Code wrote it, not the model; clients show it as written.
          cli_output: true,
          turn_meta: { outcome: "failed", duration_ms: 40 },
        },
      ]);
      await expect(runner.retireIfInactive()).resolves.toBe(true);
      expect(runner.hasWorker).toBe(false);
      expect(runner.retireRequested).toBe(false);
      f.setPlan({});
      await runner.send(f.executable, "again", randomUUID(), runner.snapshot().revision);
      await expect.poll(() => runner.snapshot().lastOutcome, { timeout: 15_000 }).toBe("succeeded");
      expect(runner.snapshot().reason).toBeNull();
      const starts = f.frames().filter((frame) => frame.args);
      expect(starts).toHaveLength(2);
      expect(starts[0]!.args).toContain(`--session-id=${sessionId}`);
      expect(starts[1]!.args).toContain(`--resume=${sessionId}`);
    }, 40_000);

    it("is retired by the host without waiting for the idle timeout, and sending works again", async () => {
      const f = fake(authPlan);
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
      } as unknown as SessionReaders;
      const owner = new ClaudeManagedReadOwner(
        store,
        sessions,
        commands,
        f.root,
        f.environment,
        randomUUID(),
        { publish: () => undefined, alias: () => undefined },
        { maintenanceIntervalMs: 50 },
      );
      cleanups.push(() => owner.shutdown());
      const deviceId = "browser-device-a";
      const created = (await owner.request({
        operation: "create",
        workspaceId: "workspace",
        requestId: randomUUID(),
        deviceId,
      })) as Record<string, any>;
      const id = created.sessionId as string;
      const liveOf = async () => (await owner.live(id, true)) as Record<string, any>;
      const send = async (text: string) =>
        owner.request({
          operation: "send",
          sessionId: id,
          deviceId,
          requestId: randomUUID(),
          runtimeBootId: owner.bootId,
          expectedRevision: (await liveOf()).revision,
          experimentalEnabled: true,
          text,
        });
      await send("synthetic turn");
      await expect
        .poll(async () => (await liveOf()).lastOutcome, { timeout: 15_000 })
        .toBe("failed");
      // The worker goes well before the 10-minute idle timeout; the session stays usable.
      await expect
        .poll(async () => (await liveOf()).executionLocation, { timeout: 10_000 })
        .toBeNull();
      const failed = await liveOf();
      expect(failed).toMatchObject({ status: "idle", sendEnabled: true });
      expect(failed.reason).toMatch(/^claude-auth-failed: Not logged in/);
      const capabilities = (await owner.capabilities(id, true)) as Record<string, any>;
      expect(capabilities.features.send.available).toBe(true);
      // The real CLI has written the transcript by now; resuming checks it.
      writeFileSync(path.join(f.config, `${failed.sourceSessionId}.jsonl`), "");
      f.setPlan({});
      await send("again");
      await expect
        .poll(async () => (await liveOf()).lastOutcome, { timeout: 15_000 })
        .toBe("succeeded");
      expect((await liveOf()).reason).toBeNull();
      expect(f.frames().filter((frame) => frame.args)).toHaveLength(2);
    }, 60_000);
  },
);
