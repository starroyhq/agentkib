import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  needsDurableReceipt,
  replyToInteraction,
  settledReceipt,
  stopSessionTurn,
  type Access,
  type Approval,
  type Live,
  type UserQuestionRequest,
  type WebClient,
} from "@agentkib/web-client";
import { answerRequestBody } from "@agentkib/session-ui";

const approval: Approval = {
  requestId: 7,
  turnId: "turn",
  method: "item/commandExecution/requestApproval",
  command: "pnpm test",
  availableDecisions: ["accept", "decline"],
  supported: true,
};
const question: UserQuestionRequest = {
  requestId: "q1",
  turnId: "turn",
  supported: true,
  questions: [
    { id: "scope", question: "Which part?", options: [], multiSelect: false, allowCustom: true },
  ],
};
const access = (device: Partial<NonNullable<Access["device"]>> = {}): Access => ({
  status: "approved",
  csrfToken: "csrf",
  bootId: "boot",
  experimentalEnabled: true,
  device: { id: "device", name: "Browser", send: true, approve: true, ...device },
});
const live = (fields: Partial<Live> = {}): Live => ({
  sessionId: "s1",
  status: "waiting-approval",
  revision: 4,
  sendEnabled: false,
  approvals: [approval],
  questions: [question],
  ...fields,
});

function client({
  device,
  state = live(),
  send = async () => ({}),
}: {
  device?: Partial<NonNullable<Access["device"]>>;
  state?: Live;
  send?: () => Promise<unknown>;
} = {}) {
  const request = vi.fn(send);
  return {
    request,
    value: {
      access: vi.fn(async () => access(device)),
      live: vi.fn(async () => state),
      request,
    } as unknown as WebClient,
  };
}
function store() {
  const log: string[] = [];
  return {
    log,
    pending: {
      remember: vi.fn((entry: { requestId: string; kind: string }) => {
        log.push(`remember:${entry.kind}`);
      }),
      forget: vi.fn(() => {
        log.push("forget");
      }),
    },
  };
}

describe("needsDurableReceipt", () => {
  it("keeps receipts for managed Agents and owner modes that report them", () => {
    expect(needsDurableReceipt("codex")).toBe(true);
    expect(needsDurableReceipt("deepseek-harness")).toBe(true);
    expect(needsDurableReceipt("opencode", "acp-managed")).toBe(false);
    expect(needsDurableReceipt("opencode", "codex-follower")).toBe(true);
    expect(needsDurableReceipt(undefined, "dsh-follower")).toBe(true);
  });
});

describe("replyToInteraction", () => {
  it("keeps the identity, sends against the current revision and forgets it once accepted", async () => {
    const { value, request } = client();
    const { log, pending } = store();
    request.mockImplementation(async () => {
      log.push("request");
      return {};
    });
    const result = await replyToInteraction(
      value,
      { id: "s1", agent: "codex" },
      { kind: "approve", approval, decision: "accept" },
      pending,
    );
    expect(result).toEqual({ status: "accepted", requestId: expect.any(String) });
    expect(log).toEqual(["remember:approve", "request", "forget"]);
    expect(request).toHaveBeenCalledWith("approve", {
      sessionId: "s1",
      bootId: "boot",
      expectedRevision: 4,
      requestId: (result as { requestId: string }).requestId,
      turnId: "turn",
      approvalId: 7,
      decision: "accept",
    });
  });

  it("sends nothing for a request that no longer waits as the card showed it", async () => {
    const { value, request } = client({
      state: live({ approvals: [{ ...approval, command: "pnpm build" }] }),
    });
    const result = await replyToInteraction(
      value,
      { id: "s1", agent: "codex" },
      { kind: "approve", approval, decision: "accept" },
      store().pending,
    );
    expect(result).toEqual({ status: "gone" });
    expect(request).not.toHaveBeenCalled();
  });

  it("sends nothing this device may not decide", async () => {
    const noApprove = client({ device: { approve: false } });
    expect(
      await replyToInteraction(
        noApprove.value,
        { id: "s1", agent: "codex" },
        { kind: "approve", approval, decision: "accept" },
        store().pending,
      ),
    ).toEqual({ status: "refused", reason: "approve_not_permitted" });
    const native = client();
    expect(
      await replyToInteraction(
        native.value,
        { id: "s1", agent: "codex" },
        { kind: "approve", approval, nativeDecision: { acceptWithExecpolicyAmendment: {} } },
        store().pending,
      ),
    ).toEqual({ status: "refused", reason: "decision_unavailable" });
    const noSend = client({ device: { send: false } });
    expect(
      await replyToInteraction(
        noSend.value,
        { id: "s1", agent: "claude-code" },
        { kind: "answer", question, body: () => ({}) },
        store().pending,
      ),
    ).toEqual({ status: "refused", reason: "send_not_permitted" });
    expect(noApprove.request).not.toHaveBeenCalled();
    expect(native.request).not.toHaveBeenCalled();
    expect(noSend.request).not.toHaveBeenCalled();
  });

  it("sends nothing when the identity cannot be kept", async () => {
    const { value, request } = client();
    const pending = {
      remember: vi.fn(() => {
        throw new Error("control_outcome_unconfirmed");
      }),
      forget: vi.fn(),
    };
    expect(
      await replyToInteraction(
        value,
        { id: "s1", agent: "codex" },
        { kind: "approve", approval, decision: "accept" },
        pending,
      ),
    ).toEqual({ status: "not-dispatched", reason: "pending_storage_unavailable" });
    expect(request).not.toHaveBeenCalled();
  });

  it("forgets a decision the host did not run and keeps one that may have run", async () => {
    const refused = client({
      send: async () => {
        throw new ApiError(409, "stale_revision", "not-dispatched");
      },
    });
    const kept = store();
    expect(
      await replyToInteraction(
        refused.value,
        { id: "s1", agent: "codex" },
        { kind: "approve", approval, decision: "decline" },
        kept.pending,
      ),
    ).toEqual({ status: "not-dispatched", reason: "stale_revision" });
    expect(kept.log).toEqual(["remember:approve", "forget"]);

    const lost = client({
      send: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const unknown = store();
    expect(
      await replyToInteraction(
        lost.value,
        { id: "s1", agent: "codex" },
        { kind: "approve", approval, decision: "accept" },
        unknown.pending,
      ),
    ).toEqual({ status: "unknown", requestId: expect.any(String), durable: true });
    expect(unknown.log).toEqual(["remember:approve"]);
  });

  it("builds answers with the shared body and keeps no identity for Agents without receipts", async () => {
    const { value, request } = client({
      state: live({ executionMode: "acp-managed" }),
      send: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const { log, pending } = store();
    const answers = { scope: ["Only the API"] };
    const result = await replyToInteraction(
      value,
      { id: "s1", agent: "opencode" },
      {
        kind: "answer",
        question,
        body: (context, requestId) => answerRequestBody(question, answers, context, requestId),
      },
      pending,
    );
    expect(result).toEqual({ status: "unknown", requestId: expect.any(String), durable: false });
    expect(log).toEqual([]);
    expect(request).toHaveBeenCalledWith("answer", {
      sessionId: "s1",
      bootId: "boot",
      expectedRevision: 4,
      requestId: (result as { requestId: string }).requestId,
      turnId: "turn",
      questionId: "q1",
      answers,
    });
  });

  it("reports ended access without sending", async () => {
    const value = {
      access: vi.fn(async () => ({ ...access(), status: "ended" })),
      live: vi.fn(),
      request: vi.fn(),
    } as unknown as WebClient;
    expect(
      await replyToInteraction(
        value,
        { id: "s1", agent: "codex" },
        { kind: "approve", approval, decision: "accept" },
        store().pending,
      ),
    ).toEqual({ status: "access-ended" });
  });
});

describe("stopSessionTurn", () => {
  const running = live({ status: "running", turnId: "turn-2", stopEnabled: true, approvals: [] });

  it("stops the turn that runs now, keeping its identity until the host answers", async () => {
    const { value, request } = client({ state: running });
    const { log, pending } = store();
    const result = await stopSessionTurn(value, { id: "s1", agent: "codex" }, pending);
    expect(result).toMatchObject({ status: "accepted" });
    expect(request).toHaveBeenCalledWith("stop", {
      sessionId: "s1",
      requestId: expect.any(String),
      bootId: "boot",
      expectedRevision: 4,
      turnId: "turn-2",
    });
    expect(log).toEqual(["remember:stop", "forget"]);
  });

  it("sends nothing when the turn no longer runs here or this device may not send", async () => {
    const ended = client({ state: live({ status: "idle", stopEnabled: false }) });
    expect(
      await stopSessionTurn(ended.value, { id: "s1", agent: "codex" }, store().pending),
    ).toEqual({ status: "gone" });
    const readOnly = client({ state: running, device: { send: false } });
    expect(
      await stopSessionTurn(readOnly.value, { id: "s1", agent: "codex" }, store().pending),
    ).toEqual({ status: "refused", reason: "send_not_permitted" });
    expect(ended.request).not.toHaveBeenCalled();
    expect(readOnly.request).not.toHaveBeenCalled();
  });

  it("never sends a stop whose outcome is unknown again", async () => {
    const { value } = client({
      state: running,
      send: async () => {
        throw new ApiError(504, "request_timeout", "unknown");
      },
    });
    const { log, pending } = store();
    expect(await stopSessionTurn(value, { id: "s1", agent: "codex" }, pending)).toMatchObject({
      status: "unknown",
      durable: true,
    });
    expect(log).toEqual(["remember:stop"]);
  });
});

describe("settledReceipt", () => {
  const entry = { requestId: "r1", sessionId: "s1", kind: "approve" };
  const receipt = {
    found: true as const,
    requestId: "r1",
    sessionId: "s1",
    operation: "approve",
    status: "accepted" as const,
    completionObserved: false,
  };
  it("settles only a receipt for exactly this request, session and operation", () => {
    expect(settledReceipt(receipt, entry)).toBe("accepted");
    expect(settledReceipt({ ...receipt, status: "not-dispatched" }, entry)).toBe("not-dispatched");
    expect(settledReceipt({ ...receipt, status: "unknown" }, entry)).toBeUndefined();
    expect(settledReceipt({ ...receipt, sessionId: "s2" }, entry)).toBeUndefined();
    expect(settledReceipt({ ...receipt, operation: "answer" }, entry)).toBeUndefined();
    expect(settledReceipt({ found: false, requestId: "r1" }, entry)).toBeUndefined();
  });
});
