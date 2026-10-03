import { dispatchClaude } from "./claude-dispatch";
import { AttachmentStore } from "./attachments";
import { replayClaudeAttachments, settleClaudeAttachments } from "./claude-attachment-receipts";

export const CLAUDE_LOCAL_OWNER = "agentkib-local-owner";
const OWNER = CLAUDE_LOCAL_OWNER;
export interface LocalClaudeDependencies {
  managed(params: unknown): Promise<unknown>;
  runtime(params: unknown): Promise<unknown>;
  receipt(params: { requestId: string; deviceId: string }): Promise<unknown>;
  attachments: AttachmentStore;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_request");
  return value as Record<string, unknown>;
};
const field = (value: unknown, max = 256): string => {
  if (typeof value !== "string" || !value || value.length > max) throw new Error("invalid_field");
  return value;
};
/** Trusted renderer only. Owner identity is assigned here, never accepted from IPC. */
export async function localClaudeRequest(
  deps: LocalClaudeDependencies,
  raw: unknown,
): Promise<unknown> {
  const input = record(raw);
  const mutation = [
    "create",
    "adopt",
    "release",
    "reconcile",
    "send",
    "stop",
    "approve",
    "answer",
  ].includes(String(input.operation));
  let dispatched = false;
  let priorUncertain = false;
  const tracked = {
    ...deps,
    receipt: async (params: { requestId: string; deviceId: string }) => {
      const checkingOriginal = mutation && params.requestId === input.requestId;
      const alreadyUncertain = priorUncertain;
      if (checkingOriginal) priorUncertain = true;
      const result = await deps.receipt(params);
      if (
        checkingOriginal &&
        result &&
        typeof result === "object" &&
        "found" in result &&
        result.found === false &&
        "requestId" in result &&
        result.requestId === params.requestId
      )
        priorUncertain = alreadyUncertain;
      return result;
    },
    managed: (params: unknown) => {
      if (mutation && record(params).operation === input.operation) dispatched = true;
      return mutation && record(params).operation === input.operation
        ? dispatchClaude(deps.managed, deps.receipt, record(params))
        : deps.managed(params);
    },
    runtime: (params: unknown) => {
      if (mutation && record(params).operation === input.operation) dispatched = true;
      return mutation && record(params).operation === input.operation
        ? dispatchClaude(deps.runtime, deps.receipt, record(params))
        : deps.runtime(params);
    },
  };
  try {
    if (mutation) await tracked.receipt({ requestId: field(input.requestId), deviceId: OWNER });
    return await localClaudeRequestInner(tracked, input);
  } catch (error) {
    if (!mutation || dispatched) throw error;
    return {
      accepted: false,
      completed: false,
      // Rejecting this replay does not prove the original request never ran.
      controlOutcome: priorUncertain ? "unknown" : "not-dispatched",
      requestId: input.requestId,
      error: error instanceof Error ? error.message : "invalid_request",
    };
  }
}
async function localClaudeRequestInner(
  deps: LocalClaudeDependencies,
  raw: unknown,
): Promise<unknown> {
  const input = record(raw);
  const operation = field(input.operation, 32);
  if (operation === "options") return deps.managed({ operation });
  if (operation === "receipt")
    return deps.receipt({ requestId: field(input.requestId), deviceId: OWNER });
  if (operation === "catalog") {
    const catalog = record(await deps.runtime({ operation: "catalog" }));
    return {
      ...catalog,
      sessions: Array.isArray(catalog.sessions)
        ? catalog.sessions.filter((value) => record(value).agent === "claude-code")
        : [],
    };
  }
  if (operation === "create")
    return deps.managed({
      operation,
      workspaceId: field(input.workspaceId),
      requestId: field(input.requestId),
      deviceId: OWNER,
    });
  const sessionId = field(input.sessionId);
  if (["adopt", "release", "reconcile"].includes(operation)) {
    const params: Record<string, unknown> = {
      operation,
      sessionId,
      requestId: field(input.requestId),
      deviceId: OWNER,
    };
    if (operation === "adopt") {
      if (input.handoffConfirmed !== true) throw new Error("handoff_confirmation_required");
      params.handoffConfirmed = true;
      params.handoffFingerprint = field(input.handoffFingerprint);
    }
    if (operation === "release") {
      if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0)
        throw new Error("invalid_revision");
      const live = record(
        await deps.managed({ operation: "live", sessionId, experimentalEnabled: true }),
      );
      params.runtimeBootId = field(live.runtimeBootId);
      params.expectedRevision = input.expectedRevision;
    }
    return deps.managed(params);
  }
  const catalog = record(await deps.runtime({ operation: "catalog" }));
  if (
    !Array.isArray(catalog.sessions) ||
    !catalog.sessions.some((value) => {
      const row = record(value);
      return row.id === sessionId && row.agent === "claude-code";
    })
  )
    throw new Error("claude_session_unavailable");
  if (["inspect", "capabilities"].includes(operation))
    return deps.managed({ operation, sessionId, experimentalEnabled: true });
  if (operation === "events")
    return deps.managed({
      operation,
      sessionId,
      limit: 50,
      ...(input.cursor ? { cursor: field(input.cursor, 4096) } : {}),
    });
  if (operation === "live") {
    const live = await deps.managed({ operation, sessionId, experimentalEnabled: true });
    await settleClaudeAttachments(deps.attachments, deps.receipt, sessionId);
    return live;
  }
  if (operation === "attachments")
    return { attachments: await deps.attachments.list(OWNER, sessionId) };
  if (operation === "upload") {
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > 25 * 1024 * 1024)
      throw new Error("invalid_upload");
    const caps = record(
      await deps.managed({ operation: "capabilities", sessionId, experimentalEnabled: true }),
    );
    if (record(record(caps.features).attachments).available !== true)
      throw new Error("attachments_unavailable");
    const bytes = input.bytes;
    return deps.attachments.upload(
      (async function* () {
        yield bytes;
      })(),
      { deviceId: OWNER, sessionId },
      field(input.name, 255),
      field(input.mime),
      () => undefined,
    );
  }
  if (operation === "remove-attachment") {
    await deps.attachments.remove(
      OWNER,
      sessionId,
      field(input.attachmentId),
      field(input.version),
    );
    return { ok: true };
  }
  if (!["send", "stop", "approve", "answer"].includes(operation))
    throw new Error("unsupported_operation");
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0)
    throw new Error("invalid_revision");
  const requestId = field(input.requestId);
  const live = record(
    await deps.managed({ operation: "live", sessionId, experimentalEnabled: true }),
  );
  const receipt = record(await deps.receipt({ requestId, deviceId: OWNER }));
  const replay = receipt.found === true && receipt.sessionId === sessionId;
  if (!replay && live.revision !== input.expectedRevision) throw new Error("stale_state");
  const params: Record<string, unknown> = {
    operation,
    sessionId,
    requestId,
    deviceId: OWNER,
    runtimeBootId: field(live.runtimeBootId),
    expectedRevision: input.expectedRevision,
    experimentalEnabled: true,
  };
  if (operation === "send") {
    if (input.resourceIds !== undefined) throw new Error("context_unavailable");
    if (!replay && live.sendEnabled !== true) throw new Error("control_unavailable");
    const text = typeof input.text === "string" ? input.text : "";
    if (Buffer.byteLength(text) > 16_384) throw new Error("invalid_text");
    if (Array.isArray(input.attachmentIds) && input.attachmentIds.length) {
      const previous = await replayClaudeAttachments(deps.attachments, receipt, {
        deviceId: OWNER,
        sessionId,
        requestId,
        expectedRevision: input.expectedRevision,
        attachmentIds: input.attachmentIds,
        text,
      });
      if (previous) return previous;
      params.input = await deps.attachments.inputForAgent(
        OWNER,
        sessionId,
        input.attachmentIds,
        text,
        "claude",
        requestId,
      );
    } else {
      if (!text.trim()) throw new Error("empty_input");
      params.text = text;
    }
  } else {
    params.turnId = field(input.turnId);
    if (!replay && params.turnId !== live.turnId) throw new Error("stale_turn");
    if (operation === "approve") {
      params.approvalId = input.approvalId;
      if (!["allow", "deny"].includes(String(input.decision))) throw new Error("invalid_decision");
      params.decision = input.decision;
    }
    if (operation === "answer") {
      if (!input.answers || JSON.stringify(input.answers).length > 16384)
        throw new Error("invalid_answers");
      params.questionId = input.questionId;
      params.answers = record(input.answers);
    }
  }
  const result = record(await deps.managed(params));
  if (result.requestId === requestId && result.controlOutcome === "not-dispatched")
    await deps.attachments.settle(OWNER, sessionId, requestId);
  return result;
}
