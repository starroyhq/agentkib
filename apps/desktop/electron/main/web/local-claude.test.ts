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
  it("passes Project Agent requests on as the local owner, whatever device they name", async () => {
    const scope = { workspaceIds: ["w1"], maxLanes: 2 };
    await localClaudeRequest(deps, {
      operation: "lead-status",
      sessionId: "session",
      deviceId: "phone",
    });
    await localClaudeRequest(deps, { operation: "lead-designate", sessionId: "session", scope });
    await localClaudeRequest(deps, { operation: "lead-update", sessionId: "session", scope });
    await localClaudeRequest(deps, {
      operation: "lead-pause",
      sessionId: "session",
      scope,
      worker: "lane",
    });
    for (const operation of ["lead-worker-stop", "lead-worker-remove"])
      await localClaudeRequest(deps, { operation, sessionId: "session", worker: "lane", scope });
    expect(vi.mocked(deps.managed).mock.calls.map(([params]) => params)).toEqual([
      { operation: "lead-status", sessionId: "session", deviceId: "agentkib-local-owner" },
      {
        operation: "lead-designate",
        sessionId: "session",
        scope,
        deviceId: "agentkib-local-owner",
      },
      { operation: "lead-update", sessionId: "session", scope, deviceId: "agentkib-local-owner" },
      // Only setting up and changing carry a scope, and only acting on one worker names it.
      { operation: "lead-pause", sessionId: "session", deviceId: "agentkib-local-owner" },
      {
        operation: "lead-worker-stop",
        sessionId: "session",
        worker: "lane",
        deviceId: "agentkib-local-owner",
      },
      {
        operation: "lead-worker-remove",
        sessionId: "session",
        worker: "lane",
        deviceId: "agentkib-local-owner",
      },
    ]);
    expect(deps.receipt).not.toHaveBeenCalled();
  });
  it("checks the current local project group against the trusted catalog on assignment", async () => {
    const workspace = (id: string, kind: "primary" | "worktree") => ({
      id,
      name: id,
      path: `/test/${id}`,
      checkout: {
        repository_group_id: "repository",
        primary_path: "/test/project",
        kind,
        status: "present",
      },
    });
    const session = (id: string, workspace_id: string, fields = {}) => ({
      id,
      workspace_id,
      agent: "codex",
      availability: "readable",
      ...fields,
    });
    vi.mocked(deps.runtime).mockResolvedValue({
      workspaces: [
        workspace("project", "primary"),
        workspace("branch", "worktree"),
        { id: "unrelated", name: "project", path: "/another/project" },
      ],
      sessions: [
        session("lead", "project", { agent: "claude-code" }),
        session("api", "branch", { origin: "execution" }),
        session("other-workspace", "unrelated"),
        session("already-worker", "project", {
          orchestration: { role: "worker", leadId: "another-lead" },
        }),
        session("archived", "project", { archived: true }),
        session("remote", "project", { remote: { host_id: "another-host" } }),
      ],
    });
    for (const [worker, reason] of [
      ["other-workspace", "worker-outside-project"],
      ["archived", "worker-outside-project"],
      ["remote", "worker-outside-project"],
      ["already-worker", "session-is-a-worker"],
    ])
      await expect(
        localClaudeRequest(deps, {
          operation: "lead-assign-workers",
          sessionId: "lead",
          workers: [worker],
        }),
      ).rejects.toThrow(reason);
    expect(deps.managed).not.toHaveBeenCalled();

    await localClaudeRequest(deps, {
      operation: "lead-assign-workers",
      sessionId: "lead",
      workers: ["api"],
      deviceId: "phone",
      scope: { workspaceIds: ["unrelated"] },
    });
    expect(deps.managed).toHaveBeenCalledExactlyOnceWith({
      operation: "lead-assign-workers",
      sessionId: "lead",
      workers: ["api"],
      deviceId: "agentkib-local-owner",
    });
    expect(vi.mocked(deps.runtime).mock.calls).toEqual(
      Array.from({ length: 5 }, () => [{ operation: "catalog" }]),
    );
  });

  it("forwards a batch of ten Workers and rejects eleven", async () => {
    const workers = Array.from({ length: 11 }, (_, index) => `worker-${index + 1}`);
    vi.mocked(deps.runtime).mockResolvedValue({
      workspaces: [{ id: "project", name: "Project", path: "/test/project" }],
      sessions: [
        { id: "lead", workspace_id: "project", agent: "claude-code", availability: "readable" },
        ...workers.map((id) => ({
          id,
          workspace_id: "project",
          agent: "codex",
          availability: "readable",
        })),
      ],
    });
    const request = { operation: "lead-assign-workers", sessionId: "lead" };
    const selected = workers.slice(0, 10);
    await localClaudeRequest(deps, { ...request, workers: selected });
    expect(deps.managed).toHaveBeenCalledExactlyOnceWith({
      ...request,
      workers: selected,
      deviceId: "agentkib-local-owner",
    });
    await expect(localClaudeRequest(deps, { ...request, workers })).rejects.toThrow(
      "invalid-lead-request",
    );
    expect(deps.managed).toHaveBeenCalledTimes(1);
  });

  it("checks the sidebar's unique candidate IDs and aliases without rereading the catalog", async () => {
    const request = { operation: "lead-assignment-options", sessionId: "lead" };
    const assigned = {
      sessionId: "native",
      reason: "session-is-a-worker",
      assigned: true,
    };
    const options = {
      capable: true,
      remaining: 10,
      candidates: [{ sessionId: "managed", reason: null }, assigned],
    };
    vi.mocked(deps.managed).mockResolvedValueOnce(options);
    await expect(
      localClaudeRequest(deps, {
        ...request,
        candidateIds: ["managed", "native", "managed"],
        deviceId: "phone",
      }),
    ).resolves.toEqual(options);
    expect(deps.managed).toHaveBeenCalledExactlyOnceWith({
      ...request,
      candidateIds: ["managed", "native"],
      deviceId: "agentkib-local-owner",
    });
    expect(deps.runtime).not.toHaveBeenCalled();
  });

  it("reads available slots when the sidebar has no Worker candidates", async () => {
    const request = {
      operation: "lead-assignment-options",
      sessionId: "lead",
      candidateIds: [],
    };
    await localClaudeRequest(deps, request);
    expect(deps.managed).toHaveBeenCalledExactlyOnceWith({
      ...request,
      deviceId: "agentkib-local-owner",
    });
    expect(deps.runtime).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, "invalid-lead-request"],
    ["worker", "invalid-lead-request"],
    [Array<string>(20_001).fill("worker"), "invalid-lead-request"],
    [Array<string>(1), "invalid_field"],
    [[""], "invalid_field"],
    [[42], "invalid_field"],
    [["x".repeat(257)], "invalid_field"],
  ])("rejects malformed Worker candidate IDs (%#)", async (candidateIds, reason) => {
    await expect(
      localClaudeRequest(deps, {
        operation: "lead-assignment-options",
        sessionId: "lead",
        candidateIds,
      }),
    ).rejects.toThrow(reason);
    expect(deps.managed).not.toHaveBeenCalled();
    expect(deps.runtime).not.toHaveBeenCalled();
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
  it("rejects the removed adoption operation without dispatching it", async () => {
    await expect(
      localClaudeRequest(deps, {
        operation: "adopt",
        sessionId: "session",
        requestId: "adopt",
        deviceId: "spoofed",
        path: "/untrusted",
      }),
    ).rejects.toThrow("unsupported_operation");
    expect(deps.managed).not.toHaveBeenCalled();
    expect(deps.receipt).not.toHaveBeenCalled();
  });
  it("does not revive adoption when an old request has an unknown receipt", async () => {
    deps.receipt = vi.fn(async ({ requestId }) => ({ found: true, requestId, status: "unknown" }));
    await expect(
      localClaudeRequest(deps, {
        operation: "adopt",
        sessionId: "session",
        requestId: "adopt",
      }),
    ).rejects.toThrow("unsupported_operation");
    expect(deps.managed).not.toHaveBeenCalled();
    expect(deps.receipt).not.toHaveBeenCalled();
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
  it.each(["send", "release", "reconcile"])(
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
          sessionId: operation === "reconcile" ? "" : send.sessionId,
          expectedRevision: -1,
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
