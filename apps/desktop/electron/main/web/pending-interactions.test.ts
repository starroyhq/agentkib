import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describePendingInteractions,
  filterLegacyApproval,
  resolvePendingInteractionDecision,
} from "./pending-interactions";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const access = { approve: true, send: true, extendedApproval: true, enabled: true };
const state = {
  sessionId: "session",
  runtimeBootId: "backend",
  executionMode: "codex-managed",
  revision: 8,
};
const approval = {
  requestId: 23,
  turnId: "turn",
  method: "item/commandExecution/requestApproval",
  supported: true,
  availableDecisions: ["accept", "decline"],
};
const question = {
  requestId: "ask",
  turnId: "turn",
  supported: true,
  questions: [
    {
      id: "choice",
      question: "Which option?",
      options: [{ label: "A" }, { label: "B" }],
      multiSelect: false,
      allowCustom: false,
    },
  ],
};

describe("paired pending interaction descriptions", () => {
  it("binds a test command and exposes its one-time lock-screen choice", async () => {
    root = await mkdtemp(join(tmpdir(), "agentkib-r25-test-"));
    const pending = { ...approval, command: "flutter test", cwd: root };
    const [item] = (await describePendingInteractions(
      { ...state, approvals: [pending] },
      { ...access, workspaceRoot: root },
    ))!;
    expect(item.binding).toEqual({
      sessionId: "session",
      runtimeBootId: "backend",
      turnId: "turn",
      requestId: 23,
      revision: 8,
    });
    expect(item.risk).toEqual({ level: "low", reason: "test" });
    expect(item.command).toBe("flutter test");
    expect(item.decisions).toContainEqual({
      id: "choice:accept",
      kind: "allow",
      scope: "once",
      verification: "none",
      available: true,
      lockScreen: true,
    });
    expect(
      resolvePendingInteractionDecision(item, pending, { interactionDecisionId: "choice:accept" }),
    ).toMatchObject({ nativeChoice: "accept" });
  });

  it("keeps the agent's words separate from risk and does not offer broader high-risk decisions", async () => {
    root = await mkdtemp(join(tmpdir(), "agentkib-r25-delete-"));
    const pending = {
      ...approval,
      command: "rm -rf build",
      cwd: root,
      requestContext: { reason: "This is only a harmless check." },
      decisionOptions: [
        {
          id: "grant-session",
          label: "acceptForSession",
          scope: "session",
          decision: "acceptForSession",
        },
        { id: "reject", label: "decline", scope: "once", decision: "decline" },
      ],
    };
    const [item] = (await describePendingInteractions(
      { ...state, approvals: [pending] },
      { ...access, workspaceRoot: root },
    ))!;
    expect(item.summary).toBe("This is only a harmless check.");
    expect(item.risk).toEqual({ level: "high", reason: "deletion" });
    expect(item.decisions.filter(({ kind }) => kind === "allow")).toEqual([
      {
        id: "choice:accept",
        kind: "allow",
        scope: "once",
        available: false,
        verification: "device-user-verification",
        lockScreen: false,
        reason: "verification-unavailable",
      },
    ]);
    expect(
      resolvePendingInteractionDecision(item, pending, { nativeDecision: "acceptForSession" }),
    ).toBeUndefined();
    expect(filterLegacyApproval(item, pending)).toMatchObject({
      availableDecisions: ["decline"],
      supported: true,
    });
  });

  it("filters actions by device permissions and offers questions only for declared providers", async () => {
    const snapshot = { ...state, approvals: [approval], questions: [question] };
    const readOnly = (await describePendingInteractions(snapshot, {
      ...access,
      approve: false,
      send: false,
    }))!;
    expect(readOnly.map(({ decisions }) => decisions)).toEqual([[], []]);
    const [answer] = (await describePendingInteractions(
      { ...state, questions: [question] },
      access,
    ))!;
    expect(answer.questions).toEqual(question.questions);
    expect(answer.decisions).toEqual([
      {
        id: "answer",
        kind: "answer",
        scope: "once",
        available: true,
        verification: "none",
        lockScreen: false,
      },
    ]);
    expect(
      await describePendingInteractions(
        { ...snapshot, executionMode: "devin-print", approvals: [] },
        access,
      ),
    ).toEqual([]);
    expect(
      await describePendingInteractions({ ...snapshot, executionMode: "claude-follower" }, access),
    ).toBeUndefined();
  });

  it("includes a proposed command policy when determining risk", async () => {
    root = await mkdtemp(join(tmpdir(), "agentkib-r25-policy-"));
    const pending = {
      ...approval,
      command: "ls",
      cwd: root,
      proposedExecpolicyAmendment: ["git", "push"],
      decisionOptions: [
        {
          id: "amend",
          label: "acceptWithExecpolicyAmendment",
          scope: "persistent",
          decision: { acceptWithExecpolicyAmendment: { execpolicyAmendment: ["git", "push"] } },
        },
      ],
    };
    const [item] = (await describePendingInteractions(
      { ...state, approvals: [pending] },
      { ...access, workspaceRoot: root },
    ))!;
    expect(item.risk).toEqual({ level: "high", reason: "git-push" });
    expect(item.decisions.every(({ scope }) => scope === "once")).toBe(true);
  });

  it("keeps permission-style bridge questions out of the answer path", async () => {
    const [item] = (await describePendingInteractions(
      {
        ...state,
        executionMode: "dsh-follower",
        questions: [{ ...question, permissionIntent: true }],
      },
      access,
    ))!;
    expect(item.risk.level).toBe("high");
    expect(item.decisions).toEqual([]);
  });
});
