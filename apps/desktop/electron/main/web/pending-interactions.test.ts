import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describePendingInteractions,
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
  it("displays and classifies native terminal approvals without enabling any decision", async () => {
    root = await mkdtemp(join(tmpdir(), "agentkib-terminal-approval-"));
    const pending = {
      ...approval,
      requestId: "toolu_synthetic",
      method: "claude/can_use_tool",
      toolName: "Bash",
      cwd: root,
      input: { command: "git push origin main", description: "Publish the local branch" },
      availableDecisions: ["allow", "deny"],
      supported: false,
    };
    const result = await describePendingInteractions(
      { ...state, executionMode: "claude-follower", approvals: [pending] },
      { ...access, workspaceRoot: root },
    );
    expect(result).toHaveLength(1);
    const [item] = result!;
    expect(item).toMatchObject({
      summary: pending.input.description,
      command: pending.input.command,
      risk: { level: "high", reason: "git-push" },
      decisions: [
        { kind: "allow", available: false, lockScreen: false },
        { kind: "deny", available: false, lockScreen: false },
      ],
    });
    expect(resolvePendingInteractionDecision(item, pending, "choice:allow")).toBeUndefined();
  });

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
      available: true,
      lockScreen: true,
    });
    expect(resolvePendingInteractionDecision(item, pending, "choice:accept")).toMatchObject({
      nativeChoice: "accept",
    });
  });

  it("keeps the agent's words and high risk separate from the approved device's choices", async () => {
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
    const snapshot = { ...state, approvals: [pending] };
    const [item] = (await describePendingInteractions(snapshot, {
      ...access,
      workspaceRoot: root,
    }))!;
    expect(item.summary).toBe("This is only a harmless check.");
    expect(item.risk).toEqual({ level: "high", reason: "deletion" });
    expect(item.decisions.filter(({ kind }) => kind === "allow")).toEqual([
      {
        id: "choice:accept",
        kind: "allow",
        scope: "once",
        available: true,
        lockScreen: true,
      },
      {
        id: "native:grant-session",
        kind: "allow",
        scope: "session",
        available: true,
        lockScreen: false,
      },
    ]);
    expect(resolvePendingInteractionDecision(item, pending, "native:grant-session")).toMatchObject({
      nativeDecision: "acceptForSession",
    });
    const standardAccess = { ...access, extendedApproval: false, workspaceRoot: root };
    const [standard] = (await describePendingInteractions(snapshot, standardAccess))!;
    expect(standard.decisions.map(({ id }) => id)).toEqual(["choice:accept", "choice:decline"]);
    const [requiresExtended] = (await describePendingInteractions(
      {
        ...snapshot,
        approvals: [{ ...pending, requiresExtendedApproval: true }],
      },
      standardAccess,
    ))!;
    expect(requiresExtended.decisions).toEqual([]);
  });

  it("shows ACP choices under the same grants as their native option IDs", async () => {
    const pending = {
      ...approval,
      availableDecisions: ["allow", "reject", "open-settings"],
      options: [
        { optionId: "allow", kind: "allow_always", name: "Remember Allow" },
        { optionId: "reject", kind: "reject_always", name: "Remember Deny" },
        { optionId: "open-settings", kind: "configure", name: "Open settings" },
      ],
    };
    const [item] = (await describePendingInteractions(
      { ...state, executionMode: "acp-managed", approvals: [pending] },
      { ...access, extendedApproval: false },
    ))!;
    expect(item.decisions).toEqual([
      {
        id: "choice:allow",
        kind: "allow",
        scope: "persistent",
        available: true,
        lockScreen: false,
        label: "Remember Allow",
      },
      {
        id: "choice:reject",
        kind: "deny",
        scope: "persistent",
        available: true,
        lockScreen: false,
        label: "Remember Deny",
      },
      {
        id: "choice:open-settings",
        kind: "native",
        scope: "unknown",
        available: true,
        lockScreen: false,
        label: "Open settings",
      },
    ]);
    expect(resolvePendingInteractionDecision(item, pending, "choice:open-settings")).toMatchObject({
      nativeChoice: "open-settings",
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
    ).toEqual([]);
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
    expect(item.decisions).toContainEqual({
      id: "native:amend",
      kind: "allow",
      scope: "persistent",
      available: true,
      lockScreen: false,
    });
  });

  it("offers permission-style bridge answers to a device with send permission", async () => {
    const [item] = (await describePendingInteractions(
      {
        ...state,
        executionMode: "dsh-follower",
        questions: [{ ...question, permissionIntent: true }],
      },
      access,
    ))!;
    expect(item.risk.level).toBe("high");
    expect(item.decisions).toEqual([
      { id: "answer", kind: "answer", scope: "once", available: true, lockScreen: false },
    ]);
  });
});
