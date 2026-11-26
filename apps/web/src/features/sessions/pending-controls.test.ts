import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ABANDONED_PENDING_TTL_MS,
  abandonPending,
  forgetPending,
  pendingScope,
  readPending,
  rememberPending,
  subscribePending,
} from "@agentkib/session-ui";

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.useRealTimers();
});
describe("pending Codex identities", () => {
  it.each(["goal-set", "goal-pause", "goal-resume", "goal-clear"] as const)(
    "round trips %s and clears it after receipt reconciliation",
    (kind) => {
      const scope = pendingScope("", "device");
      const identity = { requestId: crypto.randomUUID(), sessionId: "session", kind };
      rememberPending(scope, identity);
      expect(readPending(scope)).toEqual([{ ...identity, createdAt: expect.any(Number) }]);
      expect(() => rememberPending(scope, { ...identity, requestId: crypto.randomUUID() })).toThrow(
        "control_outcome_unconfirmed",
      );
      forgetPending(scope, identity.requestId);
      expect(readPending(scope)).toEqual([]);
      rememberPending(scope, { ...identity, kind: "send" });
      expect(readPending(scope)[0].kind).toBe("send");
    },
  );
  it("timestamps an existing Goal identity once and rejects unknown actions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const scope = pendingScope("", "device");
    const identity = { requestId: crypto.randomUUID(), sessionId: "session", kind: "goal-set" };
    sessionStorage.setItem(scope, JSON.stringify([identity]));
    expect(readPending(scope)).toEqual([{ ...identity, createdAt: 1_000 }]);
    vi.setSystemTime(2_000);
    expect(readPending(scope)).toEqual([{ ...identity, createdAt: 1_000 }]);
    for (const kind of ["unknown-action", "toString", "__proto__"]) {
      sessionStorage.setItem(scope, JSON.stringify([{ ...identity, kind }]));
      expect(() => readPending(scope)).toThrow("pending_control_storage_invalid");
    }
  });
  it("isolates host and device and stores only identity fields", () => {
    const scope = pendingScope("http://192.168.1.2:1422", "device-a");
    const identity = {
      requestId: crypto.randomUUID(),
      sessionId: "session",
      kind: "send" as const,
      text: "never store this",
    };
    rememberPending(scope, identity);
    expect(sessionStorage.getItem(scope)).not.toContain("never store");
    expect(readPending(pendingScope("http://192.168.1.3:1422", "device-a"))).toEqual([]);
    expect(readPending(pendingScope("http://192.168.1.2:1422", "device-b"))).toEqual([]);
    expect(() => rememberPending(scope, { ...identity, requestId: crypto.randomUUID() })).toThrow();
    forgetPending(scope, identity.requestId);
    expect(readPending(scope)).toEqual([]);
  });
  it("permits native reconciliation while preserving an unknown send identity", () => {
    const scope = pendingScope("", "device");
    rememberPending(scope, { requestId: crypto.randomUUID(), sessionId: "session", kind: "send" });
    rememberPending(scope, {
      requestId: crypto.randomUUID(),
      sessionId: "session",
      kind: "reconcile",
    });
    expect(readPending(scope)).toHaveLength(2);
  });
  it("fences only the same operation in the same session", () => {
    const scope = pendingScope("", "device");
    const send = { requestId: crypto.randomUUID(), sessionId: "session", kind: "send" as const };
    rememberPending(scope, send);
    rememberPending(scope, { ...send, requestId: crypto.randomUUID(), kind: "stop" });
    rememberPending(scope, {
      ...send,
      requestId: crypto.randomUUID(),
      sessionId: "other-session",
    });
    expect(readPending(scope)).toHaveLength(3);
    expect(() => rememberPending(scope, { ...send, requestId: crypto.randomUUID() })).toThrow(
      "control_outcome_unconfirmed",
    );
    expect(() => rememberPending(scope, { ...send, kind: "approve" })).toThrow(
      "control_outcome_unconfirmed",
    );
  });
  it("removes orphaned identities but still recovers workspace-scoped creations", () => {
    const scope = pendingScope("", "device");
    const orphan = { requestId: crypto.randomUUID(), kind: "send", workspaceId: "workspace" };
    const creation = { requestId: crypto.randomUUID(), kind: "create", workspaceId: "workspace" };
    sessionStorage.setItem(scope, JSON.stringify([orphan, creation]));
    expect(readPending(scope)).toMatchObject([creation]);
    expect(sessionStorage.getItem(scope)).not.toContain(orphan.requestId);
  });
  it("expires abandoned markers without unlocking unresolved operations", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const scope = pendingScope("", "device");
    const discarded = {
      requestId: crypto.randomUUID(),
      sessionId: "session",
      kind: "send" as const,
    };
    const retained = { requestId: crypto.randomUUID(), sessionId: "other", kind: "stop" as const };
    rememberPending(scope, discarded);
    rememberPending(scope, retained);
    const changed = vi.fn();
    const unsubscribe = subscribePending(changed);
    try {
      expect(abandonPending(scope, discarded.requestId)).toBe(true);
      expect(abandonPending(scope, discarded.requestId)).toBe(false);
      forgetPending(scope, discarded.requestId);
      expect(changed).toHaveBeenCalledOnce();
      expect(readPending(scope)).toMatchObject([retained]);
      expect(() => rememberPending(scope, discarded)).toThrow("control_outcome_unconfirmed");
      const next = { ...discarded, requestId: crypto.randomUUID() };
      rememberPending(scope, next);
      expect(readPending(scope)).toMatchObject([retained, next]);

      vi.setSystemTime(1_000 + ABANDONED_PENDING_TTL_MS);
      expect(readPending(scope)).toMatchObject([retained, next]);
      expect(sessionStorage.getItem(scope)).not.toContain(discarded.requestId);
      expect(() => rememberPending(scope, { ...retained, requestId: crypto.randomUUID() })).toThrow(
        "control_outcome_unconfirmed",
      );
    } finally {
      unsubscribe();
    }
  });
  it("fails closed on malformed storage instead of silently erasing pending state", () => {
    const scope = pendingScope("", "device");
    sessionStorage.setItem(scope, "broken json");
    expect(() => readPending(scope)).toThrow();
    expect(() =>
      rememberPending(scope, {
        requestId: crypto.randomUUID(),
        sessionId: "session",
        kind: "send",
      }),
    ).toThrow();
    expect(sessionStorage.getItem(scope)).toBe("broken json");
  });
  it.each(["codex", "claude-code", "deepseek-harness"] as const)(
    "keeps a %s create and still reads the store afterwards",
    (agent) => {
      // A name the store rejects would make every later read throw and block all controls.
      const scope = pendingScope("", "device");
      const identity = {
        requestId: crypto.randomUUID(),
        workspaceId: "workspace",
        kind: "create" as const,
        agent,
      };
      rememberPending(scope, identity);
      expect(readPending(scope)).toEqual([{ ...identity, createdAt: expect.any(Number) }]);
      forgetPending(scope, identity.requestId);
      expect(readPending(scope)).toEqual([]);
    },
  );
  it("can register other creates without replacing an unresolved create for the same target", () => {
    const scope = pendingScope("", "device");
    const legacy = { requestId: crypto.randomUUID(), kind: "create" as const, workspaceId: "one" };
    sessionStorage.setItem(scope, JSON.stringify([legacy]));
    expect(() =>
      rememberPending(scope, { ...legacy, requestId: crypto.randomUUID(), agent: "codex" }),
    ).toThrow("control_outcome_unconfirmed");
    const otherAgent = { ...legacy, requestId: crypto.randomUUID(), agent: "claude-code" as const };
    const otherWorkspace = {
      ...legacy,
      requestId: crypto.randomUUID(),
      agent: "codex" as const,
      workspaceId: "two",
    };
    rememberPending(scope, otherAgent);
    rememberPending(scope, otherWorkspace);
    expect(() => rememberPending(scope, { ...otherAgent, requestId: crypto.randomUUID() })).toThrow(
      "control_outcome_unconfirmed",
    );
    forgetPending(scope, otherAgent.requestId);
    expect(readPending(scope)).toMatchObject([legacy, otherWorkspace]);
  });
  it("rejects an agent no control can name", () => {
    const scope = pendingScope("", "device");
    sessionStorage.setItem(
      scope,
      JSON.stringify([
        { requestId: crypto.randomUUID(), workspaceId: "w", kind: "create", agent: "unknown" },
      ]),
    );
    expect(() => readPending(scope)).toThrow("pending_control_storage_invalid");
  });
});
