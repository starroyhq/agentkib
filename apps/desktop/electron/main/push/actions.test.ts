// @vitest-environment node
import type { SessionPendingInteraction } from "@agentkib/runtime-protocol";
import { describe, expect, it } from "vitest";
import {
  PUSH_APPROVAL_LIFETIME_MS,
  PushApprovalActions,
  type PushInteractionProjection,
} from "./actions";

const AT = 1_762_900_000_000;
const DEVICE = "paired-device-1";
const BOOT = "host-boot-1";
const ALLOW = "choice:allow";
const DENY = "choice:deny";
const SESSION = "native:allow-for-session";

function approval(): SessionPendingInteraction {
  return {
    version: 1,
    kind: "approval",
    binding: {
      sessionId: "session",
      runtimeBootId: "runtime-boot",
      turnId: "turn",
      revision: 42,
      requestId: 15,
    },
    summary: "Run a high-risk fixture command.",
    risk: { level: "high", reason: "git-push" },
    command: ["git", "push"],
    cwd: "/private/fixture",
    parameters: { payload: "private fixture data" },
    decisions: [
      { id: ALLOW, kind: "allow", scope: "once", available: true, lockScreen: true },
      { id: DENY, kind: "deny", scope: "once", available: true, lockScreen: true },
      { id: SESSION, kind: "allow", scope: "session", available: true, lockScreen: false },
      {
        id: "native:unavailable",
        kind: "native",
        scope: "unknown",
        available: false,
        lockScreen: false,
      },
    ],
  };
}

function body(projection: PushInteractionProjection, decision = ALLOW) {
  const { binding } = projection.interaction;
  const action = projection.action!;
  return {
    sessionId: binding.sessionId,
    approvalId: binding.requestId,
    turnId: binding.turnId,
    expectedRevision: binding.revision,
    interactionRuntimeBootId: binding.runtimeBootId,
    requestId: action.requestId,
    bootId: action.bootId,
    interactionDecisionId: decision,
    pushActionToken: action.choices[decision],
  };
}

describe("notification approval actions", () => {
  it("offers the current R25 decisions regardless of risk or scope and shares one receipt", () => {
    const actions = new PushApprovalActions({ now: () => AT });
    const projected = actions.project(approval(), DEVICE, BOOT)!;
    expect(projected.interaction).toMatchObject({
      risk: { level: "high", reason: "git-push" },
      command: ["git", "push"],
      summary: "Run a high-risk fixture command.",
    });
    expect(projected.interaction).not.toHaveProperty("parameters");
    expect(projected.interaction).not.toHaveProperty("cwd");
    expect(Object.keys(projected.action!.choices)).toEqual([ALLOW, DENY, SESSION]);
    expect(projected.action!.requestId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    for (const choice of Object.keys(projected.action!.choices)) {
      expect(body(projected, choice).requestId).toBe(projected.action!.requestId);
      expect(actions.verify(DEVICE, body(projected, choice))).toEqual({
        expiresAt: AT + PUSH_APPROVAL_LIFETIME_MS,
      });
    }
  });

  it("binds each token to the authenticated pairing, full native identity, boot, choice and expiry", () => {
    const actions = new PushApprovalActions({ now: () => AT });
    const projected = actions.project(approval(), DEVICE, BOOT)!;
    const request = body(projected);
    const reissued = actions.project(
      { ...approval(), binding: { ...approval().binding, revision: 43 } },
      DEVICE,
      BOOT,
    )!;
    expect(reissued.action!.requestId).toBe(request.requestId);
    expect(actions.verify(DEVICE, body(reissued))).toBeDefined();
    expect(actions.verify("paired-device-2", request)).toBeUndefined();
    expect(new PushApprovalActions().verify(DEVICE, request)).toBeUndefined();
    for (const changed of [
      { bootId: "another-host" },
      { sessionId: "another-session" },
      { approvalId: "15" },
      { turnId: "another-turn" },
      { interactionRuntimeBootId: "another-runtime" },
      { expectedRevision: 43 },
      { requestId: "00000000-0000-4000-8000-000000000000" },
      { interactionDecisionId: DENY },
      { interactionDecisionId: "native:unavailable" },
      { pushActionToken: request.pushActionToken!.replace(/^[^.]+/, "z") },
      { pushActionToken: request.pushActionToken + "==" },
    ])
      expect(actions.verify(DEVICE, { ...request, ...changed })).toBeUndefined();
  });

  it("keeps a receipt stable after a new notifier mints a new token for the same native request", () => {
    const original = new PushApprovalActions({ now: () => AT }).project(approval(), DEVICE, BOOT)!;
    const restarted = new PushApprovalActions({ now: () => AT + 1 }).project(
      approval(),
      DEVICE,
      "next-host-boot",
    )!;
    expect(restarted.action!.requestId).toBe(original.action!.requestId);
    expect(restarted.action!.choices[ALLOW]).not.toBe(original.action!.choices[ALLOW]);
  });

  it("invalidates tickets after subscription changes while preserving the original receipt ID", () => {
    const actions = new PushApprovalActions({ now: () => AT });
    const original = actions.project(approval(), DEVICE, BOOT, undefined, AT - 1)!;
    const changed = actions.project(approval(), DEVICE, BOOT, undefined, AT)!;
    expect(original.action!.requestId).toBe(changed.action!.requestId);
    expect(actions.verify(DEVICE, body(original), AT - 1)).toBeDefined();
    expect(actions.verify(DEVICE, body(original), AT)).toBeUndefined();
    expect(actions.verify(DEVICE, body(original))).toBeUndefined();
    expect(actions.verify(DEVICE, body(changed), AT)).toBeDefined();
  });

  it("reports a verified deadline even after expiry so callers can reconcile the original receipt", () => {
    let now = AT;
    const actions = new PushApprovalActions({ now: () => now });
    const projected = actions.project(approval(), DEVICE, BOOT)!;
    now += PUSH_APPROVAL_LIFETIME_MS + 1;
    expect(actions.verify(DEVICE, body(projected))).toEqual({ expiresAt: now - 1 });
  });

  it("includes bounded question details but never supplies or fabricates an answer", () => {
    const actions = new PushApprovalActions({ now: () => AT });
    const projected = actions.project(
      {
        ...approval(),
        kind: "question",
        command: undefined,
        questions: [
          {
            id: "q",
            question: "Which test target?",
            options: [{ label: "local" }],
            multiSelect: false,
            allowCustom: false,
          },
        ],
        decisions: [
          { id: "answer", kind: "answer", scope: "once", available: true, lockScreen: false },
        ],
      },
      DEVICE,
      BOOT,
    )!;
    expect(projected.interaction.questions).toMatchObject([
      { id: "q", options: [{ label: "local" }] },
    ]);
    expect(projected.action).toBeUndefined();
  });

  it("leaves read-only cards and large, unsafe details as a bounded preview", () => {
    const actions = new PushApprovalActions({ now: () => AT });
    const fixture = approval();
    const readonly = actions.project(
      {
        ...fixture,
        command: "a".repeat(400) + "; rm -rf example",
        summary: "示例".repeat(220) + "\u202e",
        decisions: fixture.decisions.map((decision) => ({ ...decision, available: false })),
      },
      DEVICE,
      BOOT,
      1_000,
    )!;
    expect(readonly.action).toBeUndefined();
    expect(readonly.interaction.command).toBeUndefined();
    expect(readonly.interaction.summary).toMatch(/…$/);
    expect(readonly.interaction.summary).not.toContain("\u202e");
    expect(Buffer.byteLength(JSON.stringify(readonly))).toBeLessThanOrEqual(1_000);
    expect(actions.project(fixture, DEVICE, BOOT, 0)).toBeUndefined();
  });

  it.each([
    { command: "x".repeat(320) },
    { command: "git push\nnext-command" },
    { command: "" },
    { command: [] },
  ])(
    "keeps approvals view-only when the reported command cannot be shown in full",
    ({ command }) => {
      const actions = new PushApprovalActions({ now: () => AT });
      const projection = actions.project({ ...approval(), command }, DEVICE, BOOT);
      expect(projection).toMatchObject({
        interaction: { kind: "approval", risk: approval().risk },
      });
      expect(projection?.interaction).not.toHaveProperty("command");
      expect(projection).not.toHaveProperty("action");
    },
  );
});
