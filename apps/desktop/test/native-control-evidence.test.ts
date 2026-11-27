// @vitest-environment node
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { REMOTE_ERROR_CODES, parseRemoteErrorCode } from "@agentkib/runtime-protocol";
import { codexControlReason } from "../../../packages/backend/src/agents/codex/control-reasons";
import {
  acceptNativeControlReceipt,
  isPendingNativeReceipt,
  readControlReceipt,
} from "../../../packages/backend/src/control-receipt";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
  replayManagedCommand,
} from "../../../packages/backend/src/managed-ledger";
import {
  claudePromptRecorded,
  codexPromptRecorded,
  codexStopRecorded,
} from "../../../packages/backend/src/native-control-evidence";

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "agentkib-native-evidence-"));
  onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, transcript: join(dataDir, "fixture.jsonl") };
}

it("only confirms a Claude prompt with its own UUID in a complete row of the parent transcript", () => {
  const { transcript } = fixture();
  const sessionId = randomUUID();
  const uuid = randomUUID();
  const prompt = {
    type: "user",
    sessionId,
    uuid,
    message: { role: "user", content: "Same input" },
  };
  const rows = [
    { ...prompt, uuid: randomUUID(), message: { ...prompt.message, content: uuid } },
    { ...prompt, sessionId: randomUUID() },
    { ...prompt, isSidechain: true },
    { ...prompt, isMeta: true },
    { ...prompt, message: { role: "user", content: [{ type: "tool_result" }] } },
  ];
  writeFileSync(transcript, [...rows, prompt].map((row) => JSON.stringify(row)).join("\n"));
  expect(claudePromptRecorded(transcript, sessionId, uuid)).toBe(false);
  appendFileSync(transcript, "\n");
  expect(claudePromptRecorded(transcript, sessionId, uuid)).toBe(true);
});

it("uses Codex native client and turn IDs without inferring from old user messages or natural completion", () => {
  const { transcript } = fixture();
  const threadId = randomUUID();
  const turnId = randomUUID();
  const requestId = randomUUID();
  const item = { type: "UserMessage", client_id: requestId };
  const prompt = { type: "item_completed", thread_id: threadId, turn_id: turnId, item };
  const append = (...rows: object[]) =>
    appendFileSync(
      transcript,
      rows.map((payload) => JSON.stringify({ type: "event_msg", payload }) + "\n").join(""),
    );
  append(
    { type: "user_message", message: requestId },
    { ...prompt, thread_id: randomUUID() },
    { ...prompt, item: { ...item, client_id: randomUUID(), content: requestId } },
    { ...prompt, type: "item_started" },
    { type: "task_complete", turn_id: turnId },
    { type: "turn_aborted", turn_id: turnId, reason: "replaced" },
    { type: "turn_aborted", turn_id: randomUUID(), reason: "interrupted" },
  );
  expect(codexPromptRecorded(transcript, threadId, requestId)).toBe(false);
  expect(codexStopRecorded(transcript, turnId)).toBe(false);
  append(prompt, { type: "turn_aborted", turn_id: turnId, reason: "interrupted" });
  expect(codexPromptRecorded(transcript, threadId, requestId)).toBe(true);
  expect(codexPromptRecorded(transcript, threadId, requestId, turnId)).toBe(true);
  expect(codexPromptRecorded(transcript, threadId, requestId, randomUUID())).toBe(false);
  expect(codexStopRecorded(transcript, turnId)).toBe(true);
});

it("settles only the matching dispatched claim and preserves a definite concurrent result", () => {
  const { dataDir } = fixture();
  const requestId = randomUUID();
  const deviceId = "device-a";
  const sessionId = "session-a";
  const params = { requestId, deviceId };
  const originalBootId = randomUUID();
  expect(readControlReceipt(dataDir, params)).toEqual({ found: false, requestId });
  claimManagedCommand(dataDir, requestId, sessionId, "fingerprint", deviceId, {
    operation: "send",
    workspaceId: "workspace-a",
    runtimeBootId: originalBootId,
  });
  const candidate = readControlReceipt(dataDir, params);
  if (!isPendingNativeReceipt(candidate)) throw new Error("expected a pending claim");
  expect(acceptNativeControlReceipt(dataDir, deviceId, candidate)).toMatchObject({
    status: "unknown",
  });
  dispatchManagedCommand(dataDir, requestId);
  expect(acceptNativeControlReceipt(dataDir, "device-b", candidate)).toEqual({
    found: false,
    requestId,
  });
  expect(readControlReceipt(dataDir, params)).toMatchObject({ status: "unknown" });
  expect(acceptNativeControlReceipt(dataDir, deviceId, candidate)).toMatchObject({
    status: "accepted",
    completionObserved: false,
    ack: {
      accepted: true,
      completed: false,
      reconciled: true,
      requestId,
      sessionId,
      runtimeBootId: originalBootId,
    },
  });
  const definite = { accepted: false, controlOutcome: "not-dispatched", reason: "native-refusal" };
  finishManagedCommand(dataDir, requestId, definite);
  expect(acceptNativeControlReceipt(dataDir, deviceId, candidate)).toMatchObject({
    status: "not-dispatched",
    ack: definite,
  });
});

it.each([
  {
    reason: "open /synthetic/private-path: permission denied",
    error: "Refused for /synthetic/private-path",
    publicReason: REMOTE_ERROR_CODES.requestFailed,
  },
  {
    // The retired local allowlist included this spelling; the registered HTTP code uses underscores.
    reason: "control-preflight-rejected",
    error: { message: "Refused for /synthetic/private-path" },
    publicReason: REMOTE_ERROR_CODES.requestFailed,
  },
  {
    reason: "native-session-unconfirmed",
    error: "wrapped exception",
    publicReason: REMOTE_ERROR_CODES.nativeSessionUnconfirmed,
  },
])(
  "projects a stored Codex rejection using only registered reasons",
  ({ reason, error, publicReason }) => {
    const { dataDir } = fixture();
    const requestId = randomUUID();
    const deviceId = "device-a";
    const sessionId = "session-a";
    const fingerprint = "fixture-codex-command";
    const evidence = {
      workspaceId: "workspace-a",
      operation: "send",
      runtimeBootId: "boot-a",
      expectedRevision: 14,
      executionMode: "codex-managed",
    };
    expect(
      claimManagedCommand(dataDir, requestId, sessionId, fingerprint, deviceId, evidence),
    ).toBeNull();
    finishManagedCommand(dataDir, requestId, {
      accepted: false,
      completed: false,
      controlOutcome: "not-dispatched",
      reason,
      error,
      requestId,
      sessionId,
      runtimeBootId: evidence.runtimeBootId,
    });
    const projected = {
      accepted: false,
      completed: false,
      controlOutcome: "not-dispatched",
      reason: publicReason,
      error: publicReason,
      requestId,
      sessionId,
      runtimeBootId: evidence.runtimeBootId,
    };

    expect(codexControlReason(new Error(reason))).toBe(publicReason);
    expect(parseRemoteErrorCode(publicReason)).toBe(publicReason);
    expect(readControlReceipt(dataDir, { requestId, deviceId })).toMatchObject({
      found: true,
      status: "not-dispatched",
      completionObserved: false,
      requestId,
      sessionId,
      ...evidence,
      ack: projected,
    });
    expect(readControlReceipt(dataDir, { requestId, deviceId: "device-b" })).toEqual({
      found: false,
      requestId,
    });
    expect(replayManagedCommand(dataDir, requestId, fingerprint)).toEqual(projected);
    expect(
      claimManagedCommand(dataDir, requestId, sessionId, fingerprint, deviceId, evidence),
    ).toEqual(projected);
  },
);
