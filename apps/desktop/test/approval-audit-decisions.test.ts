import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_METHODS, SESSION_COLLECTIONS } from "@agentkib/runtime-protocol";
import { CodexSessionProvider } from "../../../packages/backend/src/agents/codex/session-provider";
import { SessionApprovalAuditStore } from "../../../packages/backend/src/sessions/approval-audit";
import {
  approvalAuditDecision,
  approvalAuditEvidence,
  approvalAuditReceipt,
  recordApprovalDecision,
  recordExpiredApproval,
} from "../../../packages/backend/src/sessions/approval-audit-decisions";
import { BackendStore } from "../../../packages/backend/src/store";
import { startBackend } from "./session-baseline/harness";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(os.tmpdir(), "agentkib-approval-audit-routing-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("audited decision dispatch", () => {
  const target = { agent: "codex" as const, workspaceId: "workspace" };
  const request = { sessionId: "session", requestId: randomUUID(), deviceId: "device" };
  const source = { kind: "project-agent" as const };

  it("keeps unknown before dispatch and records correlated outcomes through either result envelope", async () => {
    const audit = new SessionApprovalAuditStore(root);
    const metadata = { source, decision: { kind: "deny", scope: "once" } as const };
    const ack = { ...request, accepted: true, stdout: "fixture private output" };
    const dispatch = vi.fn(async () => {
      expect((await audit.list()).entries).toMatchObject([{ result: "unknown" }]);
      return { operation: "approve", result: ack };
    });
    await expect(
      recordApprovalDecision(audit, "approve", request, target, metadata, dispatch),
    ).resolves.toEqual({ operation: "approve", result: ack });
    await recordApprovalDecision(audit, "approve", request, target, metadata, () => ack);
    expect(dispatch).toHaveBeenCalledOnce();
    const page = await audit.list();
    expect(page.entries).toMatchObject([
      {
        source: { kind: "project-agent", deviceId: "device" },
        decision: metadata.decision,
        result: "denied",
      },
    ]);
    expect(JSON.stringify(page)).not.toContain(ack.stdout);
  });

  it("distinguishes expired, definitive rejection, and unknown without changing the returned value", async () => {
    const audit = new SessionApprovalAuditStore(root);
    const one = { ...request, requestId: randomUUID() };
    const two = { ...request, requestId: randomUUID() };
    const three = { ...request, requestId: randomUUID() };
    const rejection = {
      ...one,
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "declined-by-policy",
    };
    const otherAck = { ...one, accepted: true };
    await expect(
      recordApprovalDecision(audit, "answer", one, target, { source }, () => rejection),
    ).resolves.toBe(rejection);
    await expect(
      recordApprovalDecision(audit, "answer", two, target, { source }, () => {
        throw new Error("stale Claude question");
      }),
    ).rejects.toThrow("stale Claude question");
    await expect(
      recordApprovalDecision(audit, "answer", three, target, { source }, () => otherAck),
    ).resolves.toBe(otherAck);
    expect((await audit.list()).entries.map((entry) => entry.result).sort()).toEqual([
      "denied",
      "expired",
      "unknown",
    ]);
  });

  it("leaves the original unknown on stale or conflicting retries until its own receipt arrives", async () => {
    const audit = new SessionApprovalAuditStore(root);
    await recordApprovalDecision(audit, "approve", request, target, { source }, () => ({
      ...request,
      controlOutcome: "unknown",
    }));
    await recordExpiredApproval(audit, "approve", request, target, { source });
    await recordApprovalDecision(audit, "approve", request, target, { source }, () => ({
      ...request,
      controlOutcome: "not-dispatched",
      reason: "request-id-conflict",
    }));
    expect((await audit.list()).entries).toMatchObject([{ result: "unknown" }]);
    await audit.finishReceipt({ ...request, agent: target.agent, result: "accepted" });
    expect((await audit.list()).entries).toMatchObject([{ result: "executed" }]);
  });

  it("keeps only a decision's meaning and scope from opaque provider options", () => {
    expect(
      approvalAuditDecision(
        "approve",
        { decision: "opaque-42" },
        {
          options: [{ optionId: "opaque-42", kind: "reject_always", name: "fixture native label" }],
        },
      ),
    ).toEqual({ kind: "deny", scope: "persistent" });
    expect(
      approvalAuditDecision("approve", {
        nativeDecision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { action: "deny", host: "fixture.private" },
          },
        },
      }),
    ).toEqual({ kind: "deny", scope: "persistent" });
    expect(
      approvalAuditDecision("answer", { answers: { selected: ["fixture private answer"] } }),
    ).toEqual({ kind: "answer", scope: "once" });
  });

  it("uses R25 native evidence and stays high for an opaque permission-style question", async () => {
    const context = { sessionId: request.sessionId, turnId: "turn" };
    const approval = {
      requestId: 2,
      turnId: context.turnId,
      method: "item/commandExecution/requestApproval",
      command: "git status",
      cwd: root,
      requestContext: { proposedExecpolicyAmendment: ["git", "push"] },
      agentDescription: "fixture private prose",
    };
    const snapshot = { ...context, executionMode: "codex-managed", approvals: [approval] };
    const decision = {
      ...context,
      operation: "approve",
      approvalId: 2,
      decision: "acceptForSession",
    };
    await expect(approvalAuditEvidence(snapshot, decision, root)).resolves.toEqual({
      risk: { level: "high", reason: "git-push" },
      decision: { kind: "allow", scope: "session" },
    });
    await expect(
      approvalAuditEvidence(snapshot, { ...decision, turnId: "foreign" }, root),
    ).resolves.toEqual({});
    await expect(
      approvalAuditEvidence({ ...snapshot, approvals: [approval, approval] }, decision, root),
    ).resolves.toEqual({});
    await expect(
      approvalAuditEvidence(
        {
          ...context,
          executionMode: "dsh-follower",
          questions: [{ requestId: 2, turnId: context.turnId, permissionIntent: true }],
        },
        { ...context, operation: "answer", questionId: 2 },
        root,
      ),
    ).resolves.toEqual({
      risk: { level: "high", reason: "unknown-operation" },
      decision: { kind: "answer", scope: "once" },
    });
  });

  it("only refines unknown from a definitive decision receipt", () => {
    const receipt = { ...request, found: true, operation: "approve" };
    expect(approvalAuditReceipt({ ...receipt, status: "accepted" })).toMatchObject({
      ...request,
      result: "accepted",
    });
    expect(
      approvalAuditReceipt({ ...receipt, status: "not-dispatched", ack: null }),
    ).toBeUndefined();
    expect(
      approvalAuditReceipt({
        ...receipt,
        status: "not-dispatched",
        ack: {
          requestId: request.requestId,
          controlOutcome: "not-dispatched",
          reason: "stale-state",
        },
      }),
    ).toMatchObject({ ...request, result: "expired" });
    expect(
      approvalAuditReceipt({ ...receipt, status: "accepted", operation: "send" }),
    ).toBeUndefined();
  });
});

it("converges trusted host, typed and legacy decisions into one authorized history", async () => {
  const data = join(root, "application");
  const workspace = join(root, "workspace");
  const otherWorkspace = join(root, "other");
  const home = join(root, "home");
  await Promise.all(
    [data, workspace, otherWorkspace, home].map((dir) => mkdir(dir, { recursive: true })),
  );
  const store = new BackendStore(join(data, "agentkib.db"));
  const session = (scope: string) => {
    const nativeId = randomUUID();
    store.sessions.sync(scope, "codex", [
      {
        agent: "codex",
        native_ref: nativeId,
        title: "Fixture session",
        origin: "interactive",
        archived: false,
        sidechain: false,
        availability: "metadata-only",
        message_count: null,
        created_at: null,
        updated_at: null,
        git_branch: null,
      },
    ]);
    return store.sessions.id("codex", nativeId);
  };
  let sessionId: string;
  let projectless: string;
  try {
    for (const [id, path] of [
      ["workspace", workspace],
      ["other", otherWorkspace],
    ]) {
      store.sql.run(
        "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
        id,
        path,
        id,
        "healthy",
        "2026-11-24T00:00:00Z",
      );
    }
    sessionId = session("workspace");
    projectless = session(SESSION_COLLECTIONS.projectless);
  } finally {
    store.close();
  }
  const control = vi
    .spyOn(CodexSessionProvider.prototype, "control")
    .mockImplementation(async (value) => {
      const params = value as Record<string, unknown>;
      expect(params).not.toHaveProperty("approvalAudit");
      return { accepted: true, sessionId: params.sessionId, requestId: params.requestId };
    });
  const runtime = await startBackend({
    data,
    workspace,
    environment: { HOME: home, PATH: home },
    reuseData: true,
  });
  try {
    const host = (request: Record<string, unknown>, source?: "phone" | "web") =>
      runtime.rpc(RUNTIME_METHODS.sessionRequest, {
        host: {
          request,
          ...(source ? { approvalAudit: { source: { kind: source } } } : {}),
        },
      });
    const reply = {
      operation: "approve",
      sessionId,
      requestId: randomUUID(),
      deviceId: "paired-phone",
      approvalId: 1,
      turnId: "turn",
      expectedRevision: 1,
      decision: "acceptForSession",
    };
    await host(reply, "phone");
    await host(reply, "phone");
    await runtime.rpc(RUNTIME_METHODS.webRequest, {
      ...reply,
      requestId: randomUUID(),
      deviceId: "desktop-local",
    });
    await runtime.rpc(RUNTIME_METHODS.sessionRequest, {
      ...reply,
      requestId: randomUUID(),
      sessionId: projectless,
      deviceId: "desktop-local",
    });
    const expired = {
      operation: "approval-audit-expired",
      sessionId,
      requestId: randomUUID(),
      deviceId: "paired-web",
      interactionKind: "approval",
      decision: "decline",
    };
    await expect(host(expired)).rejects.toThrow();
    await expect(
      runtime.rpc(RUNTIME_METHODS.webRequest, { operation: "approval-audit-list" }),
    ).rejects.toThrow("Method not found");
    await host(expired, "web");
    expect(control).toHaveBeenCalledTimes(4);
    const page = (workspaces?: { id: string; path: string }[]) =>
      host({
        operation: "approval-audit-list",
        ...(workspaces ? { workspaces } : {}),
      });
    await expect(page([{ id: "other", path: otherWorkspace }])).resolves.toEqual({ entries: [] });
    await expect(page([{ id: "workspace", path: workspace }])).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({
          result: "expired",
          source: { kind: "web", deviceId: "paired-web" },
        }),
        expect.objectContaining({
          result: "executed",
          source: { kind: "phone", deviceId: "paired-phone" },
        }),
        expect.objectContaining({
          result: "executed",
          source: { kind: "desktop", deviceId: "desktop-local" },
        }),
      ]),
    });
    await expect(page()).resolves.toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({ sessionId: projectless })]),
    });
    const restricted = (await page([{ id: "workspace", path: workspace }])) as {
      entries: unknown[];
    };
    expect(restricted.entries).toHaveLength(3);
  } finally {
    await runtime.close();
  }
});
