// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore } from "./attachments";
import { localClaudeRequest, type LocalClaudeDependencies } from "./local-claude";
import { settleClaudeAttachments } from "./claude-attachment-receipts";

describe("trusted Claude owner boundary", () => {
  let dir: string;
  let deps: LocalClaudeDependencies;
  let live: Record<string, unknown>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ak-local-claude-"));
    live = { revision: 1, runtimeBootId: "boot", sendEnabled: true, turnId: "turn" };
    deps = {
      managed: vi.fn(async (raw) => {
        const params = raw as Record<string, unknown>;
        if (params.operation === "live") return live;
        return { accepted: true, requestId: params.requestId, params };
      }),
      runtime: vi.fn(async (raw) => {
        const params = raw as Record<string, unknown>;
        if (params.operation === "catalog")
          return { sessions: [{ id: "session", agent: "claude-code" }] };
        throw new Error(`Unexpected runtime operation: ${String(params.operation)}`);
      }),
      receipt: vi.fn(async ({ requestId }) => ({ found: false, requestId })),
      attachments: new AttachmentStore(dir),
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const send = {
    operation: "send",
    sessionId: "session",
    requestId: "request",
    expectedRevision: 1,
    text: "hello",
  };
  it.each(["bridge-status", "bridge-challenge", "bridge-disconnect"])(
    "keeps %s on the local owner boundary and ignores caller paths and credentials",
    async (operation) => {
      await localClaudeRequest(deps, {
        operation,
        sessionId: "session",
        deviceId: "phone",
        token: "untrusted-token",
        socketPath: "/private/untrusted.sock",
      });
      expect(deps.managed).toHaveBeenCalledExactlyOnceWith({
        operation,
        sessionId: "session",
        deviceId: "agentkib-local-owner",
      });
      expect(deps.receipt).not.toHaveBeenCalled();
    },
  );
  it("reads and writes the background task setting as the local owner, and nothing else", async () => {
    await localClaudeRequest(deps, { operation: "background-tasks", deviceId: "phone" });
    await localClaudeRequest(deps, {
      operation: "background-tasks",
      enabled: false,
      sessionId: "session",
      deviceId: "phone",
    });
    await localClaudeRequest(deps, { operation: "background-tasks", enabled: "yes" });
    expect(vi.mocked(deps.managed).mock.calls.map(([params]) => params)).toEqual([
      { operation: "background-tasks", deviceId: "agentkib-local-owner" },
      { operation: "background-tasks", enabled: false, deviceId: "agentkib-local-owner" },
      // Anything but a boolean only reads.
      { operation: "background-tasks", deviceId: "agentkib-local-owner" },
    ]);
    expect(deps.receipt).not.toHaveBeenCalled();
  });
  it("rejects bridge management for a session outside the Claude catalog", async () => {
    await expect(
      localClaudeRequest(deps, {
        operation: "bridge-challenge",
        sessionId: "other",
      }),
    ).rejects.toThrow("claude_session_unavailable");
    expect(deps.managed).not.toHaveBeenCalled();
  });
  it("allows the owner to revoke an unavailable catalog source without reading its history", async () => {
    await localClaudeRequest(deps, {
      operation: "bridge-disconnect",
      sessionId: "removed-session",
      deviceId: "phone",
    });
    expect(deps.managed).toHaveBeenCalledExactlyOnceWith({
      operation: "bridge-disconnect",
      sessionId: "removed-session",
      deviceId: "agentkib-local-owner",
    });
    expect(deps.runtime).not.toHaveBeenCalled();
  });
  it("assigns the owner in the host and does not forward caller paths or device IDs", async () => {
    await localClaudeRequest(deps, { ...send, deviceId: "phone", path: "/private/secret" });
    expect(deps.managed).toHaveBeenLastCalledWith({
      ...send,
      deviceId: "agentkib-local-owner",
      experimentalEnabled: true,
      runtimeBootId: "boot",
    });
  });
  it("reports pre-dispatch validation definitively but leaves transport errors uncertain", async () => {
    expect(await localClaudeRequest(deps, { ...send, expectedRevision: 0 })).toMatchObject({
      controlOutcome: "not-dispatched",
      error: "stale_state",
    });
    const managed = deps.managed;
    deps.managed = async (params) => {
      if ((params as Record<string, unknown>).operation === "send") throw new Error("pipe_closed");
      return managed(params);
    };
    await expect(localClaudeRequest(deps, send)).rejects.toThrow("pipe_closed");
  });
  it("passes an existing request to the authoritative fingerprint check despite a newer revision", async () => {
    live = { ...live, revision: 3, sendEnabled: false };
    deps.receipt = vi.fn(async () => ({ found: true, sessionId: "session", requestId: "request" }));
    await localClaudeRequest(deps, send);
    expect(deps.managed).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "send", expectedRevision: 1 }),
    );
  });
  it("binds release to the displayed revision and current Runtime identity", async () => {
    await localClaudeRequest(deps, {
      operation: "release",
      sessionId: "session",
      requestId: "release",
      expectedRevision: 1,
    });
    expect(deps.managed).toHaveBeenLastCalledWith({
      operation: "release",
      sessionId: "session",
      requestId: "release",
      expectedRevision: 1,
      runtimeBootId: "boot",
      deviceId: "agentkib-local-owner",
    });
  });
  it("adopts without a manual confirmation while keeping the host owner boundary", async () => {
    expect(
      await localClaudeRequest(deps, {
        operation: "adopt",
        sessionId: "session",
        requestId: "adopt",
        deviceId: "spoofed",
        handoffConfirmed: false,
        path: "/untrusted",
      }),
    ).toMatchObject({ accepted: true });
    expect(deps.managed).toHaveBeenLastCalledWith({
      operation: "adopt",
      sessionId: "session",
      requestId: "adopt",
      deviceId: "agentkib-local-owner",
    });
  });
  it("preserves an explicitly supplied adoption fingerprint for the backend safety check", async () => {
    await localClaudeRequest(deps, {
      operation: "adopt",
      sessionId: "session",
      requestId: "adopt",
      handoffFingerprint: "fingerprint",
    });
    expect(deps.managed).toHaveBeenLastCalledWith({
      operation: "adopt",
      sessionId: "session",
      requestId: "adopt",
      deviceId: "agentkib-local-owner",
      handoffFingerprint: "fingerprint",
    });
  });
  it.each([
    "claude-owner-busy",
    "claude-background-session-running",
    "claude-owner-check-unavailable",
    "owner-opened-elsewhere",
    "claude-cli-unavailable",
    "platform-unsupported",
  ])("keeps the definitive %s reason when local send is unavailable", async (reason) => {
    live = { ...live, sendEnabled: false, ownershipReason: reason };
    expect(await localClaudeRequest(deps, send)).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      error: reason,
    });
    expect(deps.managed).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "send" }));
  });
  it("does not forward arbitrary internal disabled-send diagnostics", async () => {
    live = { ...live, sendEnabled: false, ownershipReason: "/private/internal-diagnostic" };
    expect(await localClaudeRequest(deps, send)).toMatchObject({
      controlOutcome: "not-dispatched",
      error: "control_unavailable",
    });
  });
  it.each(["send", "release", "adopt"])(
    "keeps %s replay preflight failures unknown and uses only the host owner",
    async (operation) => {
      deps.receipt = vi.fn(async ({ requestId }) => ({
        found: true,
        requestId,
        status: "unknown",
      }));
      expect(
        await localClaudeRequest(deps, {
          ...send,
          operation,
          expectedRevision: -1,
          ...(operation === "adopt" ? { handoffFingerprint: 42 } : {}),
          deviceId: "spoofed",
        }),
      ).toMatchObject({ accepted: false, controlOutcome: "unknown" });
      expect(deps.receipt).toHaveBeenCalledWith({
        requestId: "request",
        deviceId: "agentkib-local-owner",
      });
      expect(deps.managed).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(deps.runtime)
          .mock.calls.some(([value]) =>
            ["send", "stop", "approve", "answer"].includes(
              String((value as Record<string, unknown>).operation),
            ),
          ),
      ).toBe(false);
    },
  );
  it("does not classify a failed receipt lookup as proof of non-dispatch", async () => {
    deps.receipt = vi.fn(async () => {
      throw new Error("receipt_unavailable");
    });
    expect(await localClaudeRequest(deps, send)).toMatchObject({
      accepted: false,
      controlOutcome: "unknown",
      error: "receipt_unavailable",
    });
    expect(deps.runtime).not.toHaveBeenCalled();
  });
  it("keeps attachments pinned across restart until a matching completed receipt", async () => {
    const owner = { deviceId: "agentkib-local-owner", sessionId: "session" };
    const item = await deps.attachments.upload(
      (async function* () {
        yield Buffer.from("marker");
      })(),
      owner,
      "note.txt",
      "text/plain",
      () => {},
    );
    await localClaudeRequest(deps, { ...send, text: "", attachmentIds: [item.id] });
    deps.attachments = new AttachmentStore(dir);
    for (const receipt of [
      { found: false },
      {
        found: true,
        sessionId: "session",
        requestId: "request",
        status: "accepted",
        completionObserved: false,
      },
      {
        found: true,
        sessionId: "other",
        requestId: "request",
        status: "accepted",
        completionObserved: true,
      },
    ]) {
      await settleClaudeAttachments(deps.attachments, async () => receipt, "session");
      await expect(
        deps.attachments.remove(owner.deviceId, owner.sessionId, item.id, item.version),
      ).rejects.toThrow("attachment_in_use");
    }
    await settleClaudeAttachments(
      deps.attachments,
      async () => ({
        found: true,
        sessionId: "session",
        requestId: "request",
        status: "accepted",
        completionObserved: true,
      }),
      "session",
    );
    await deps.attachments.remove(owner.deviceId, owner.sessionId, item.id, item.version);
    expect(await deps.attachments.list(owner.deviceId, owner.sessionId)).toEqual([]);
  });
});
