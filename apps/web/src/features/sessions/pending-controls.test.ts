import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetPending,
  pendingScope,
  readPending,
  rememberPending,
} from "@/features/conversation/features/sessions/pending-controls";

beforeEach(() => sessionStorage.clear());
describe("pending Codex identities", () => {
  it.each(["goal-set", "goal-pause", "goal-resume", "goal-clear"] as const)(
    "round trips %s and clears it after receipt reconciliation",
    (kind) => {
      const scope = pendingScope("", "device");
      const identity = { requestId: crypto.randomUUID(), sessionId: "session", kind };
      rememberPending(scope, identity);
      expect(readPending(scope)).toEqual([identity]);
      expect(() => rememberPending(scope, { ...identity, requestId: crypto.randomUUID() })).toThrow(
        "control_outcome_unconfirmed",
      );
      forgetPending(scope, identity.requestId);
      expect(readPending(scope)).toEqual([]);
      rememberPending(scope, { ...identity, kind: "send" });
      expect(readPending(scope)[0].kind).toBe("send");
    },
  );
  it("recovers an existing Goal identity without migration and rejects unknown actions", () => {
    const scope = pendingScope("", "device");
    const identity = { requestId: crypto.randomUUID(), sessionId: "session", kind: "goal-set" };
    sessionStorage.setItem(scope, JSON.stringify([identity]));
    expect(readPending(scope)).toEqual([identity]);
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
      expect(readPending(scope)).toEqual([identity]);
      forgetPending(scope, identity.requestId);
      expect(readPending(scope)).toEqual([]);
    },
  );
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
