import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  deriveSessionState,
  type SessionStateFacts,
} from "../../../packages/backend/src/sessions/session-state";

const controls = ["send", "stop", "settings", "assign", "takeover"] as const;
const kinds = ["send", "stop", "settings", "takeover", "other", "unclassified"] as const;
const owners = ["agentkib", "terminal", "native-app", "external", "none", "unknown"] as const;
const phases = [
  "unknown",
  "idle",
  "starting",
  "running",
  "awaiting-approval",
  "awaiting-answer",
  "outcome-unknown",
] as const;
type Control = (typeof controls)[number];
type ReceiptKind = (typeof kinds)[number];
type Proof = ReceiptKind | "ledger" | "turn";

const receiptFences: Record<Control, readonly ReceiptKind[]> = {
  send: ["send", "takeover", "unclassified"],
  stop: ["stop", "takeover", "unclassified"],
  settings: ["settings", "takeover", "unclassified"],
  assign: ["send", "takeover", "unclassified"],
  takeover: ["send", "stop", "takeover", "unclassified"],
};

function recovery(overrides: Partial<SessionStateFacts["recovery"]> = {}) {
  return {
    reconcile: new Set<Proof>(),
    reconnect: false,
    retry: false,
    approve: false,
    answer: false,
    turnUpdates: false,
    ownershipUpdates: false,
    inputPathUpdates: new Set<"send" | "stop">(),
    receiptUpdates: new Set<Proof>(),
    ...overrides,
  };
}

function facts(overrides: Partial<SessionStateFacts> = {}): SessionStateFacts {
  return {
    revision: 12,
    execution: { owner: "agentkib", evidence: "live" },
    turn: { phase: "idle", turnId: null },
    unknownCommands: { knowledge: "known", kinds: new Set<ReceiptKind>() },
    role: { kind: "none" },
    read: { status: "unknown", canAcknowledge: false },
    reachability: "available",
    supported: new Set(controls),
    permitted: new Set(controls),
    workerEligibility: "eligible",
    canActivate: false,
    canStageSettings: false,
    compacting: false,
    sendPath: "ready",
    stopPath: "ready",
    handover: "unavailable",
    recovery: recovery(),
    ...overrides,
  };
}

function unknownCommands(...items: ReceiptKind[]): SessionStateFacts["unknownCommands"] {
  return { knowledge: "known", kinds: new Set(items) };
}

function blockersFor(input: SessionStateFacts, control: Control): Proof[] {
  const unknown = input.unknownCommands;
  if (unknown.knowledge === "unknown") return ["ledger"];
  return receiptFences[control].filter((receipt) => unknown.kinds.has(receipt));
}

function enabledFacts(control: Control): SessionStateFacts {
  if (control === "stop") return facts({ turn: { phase: "running", turnId: "running-turn" } });
  if (control === "takeover") {
    return facts({ execution: { owner: "terminal", evidence: "live" }, handover: "available" });
  }
  return facts();
}

function checkRecovery(
  input: SessionStateFacts,
  state: ReturnType<typeof deriveSessionState>,
  control: Control,
  blockers: readonly Proof[],
  label: string,
): void {
  const availability = state.controls[control];
  if (availability.state === "enabled") return;
  assert(availability.reason, label);
  const resolution = availability.recovery;
  const verify = input.recovery;
  switch (resolution.kind) {
    case "terminal":
      return;
    case "action":
      switch (resolution.action) {
        case "reconcile":
          assert(verify.reconcile.size > 0, label);
          assert(
            blockers.every((item) => verify.reconcile.has(item) || verify.receiptUpdates.has(item)),
            label,
          );
          if (availability.reason === "outcome-unknown")
            assert(verify.reconcile.has("turn") || verify.receiptUpdates.has("turn"), label);
          if (availability.reason === "command-outcome-unknown") assert(blockers.length > 0, label);
          return;
        case "reconnect":
          assert(verify.reconnect, label);
          return;
        case "retry":
          assert(
            verify.retry && blockers.length === 0 && input.turn.phase !== "outcome-unknown",
            label,
          );
          return;
        case "approve":
          assert(verify.approve && input.turn.phase === "awaiting-approval", label);
          return;
        case "answer":
          assert(verify.answer && input.turn.phase === "awaiting-answer", label);
          return;
        case "takeover":
        case "stop":
          assert.equal(state.controls[resolution.action].state, "enabled", label);
          return;
        default: {
          const unexpected: never = resolution.action;
          assert.fail(`Unknown recovery action ${unexpected}: ${label}`);
        }
      }
    case "automatic":
      switch (resolution.signal) {
        case "turn-change":
          assert(verify.turnUpdates, label);
          return;
        case "control-readiness":
          assert(
            (control === "send" || control === "stop") && verify.inputPathUpdates.has(control),
            label,
          );
          return;
        case "ownership-change":
          assert(verify.ownershipUpdates, label);
          return;
        case "receipt-reconciled":
          assert(verify.receiptUpdates.size > 0, label);
          assert(
            blockers.every((item) => verify.receiptUpdates.has(item)),
            label,
          );
          if (availability.reason === "outcome-unknown")
            assert(verify.receiptUpdates.has("turn"), label);
          if (availability.reason === "command-outcome-unknown") assert(blockers.length > 0, label);
          return;
        default: {
          const unexpected: never = resolution.signal;
          assert.fail(`Unknown recovery signal ${unexpected}: ${label}`);
        }
      }
    default: {
      const unexpected: never = resolution;
      assert.fail(`Unknown recovery descriptor ${JSON.stringify(unexpected)}: ${label}`);
    }
  }
}

describe("session state derivation", () => {
  it("always explains a disabled operation across receipt, turn, ownership, grant, and route combinations", () => {
    const allProofs = new Set<Proof>([...kinds, "turn", "ledger"]);
    const routes: readonly {
      name: string;
      facts: Partial<SessionStateFacts>;
    }[] = [
      {
        name: "full routes",
        facts: {
          handover: "available",
          recovery: recovery({
            reconcile: allProofs,
            reconnect: true,
            retry: true,
            approve: true,
            answer: true,
            turnUpdates: true,
            ownershipUpdates: true,
            inputPathUpdates: new Set(["send", "stop"]),
            receiptUpdates: allProofs,
          }),
        },
      },
      {
        name: "limited grant and proof",
        facts: {
          permitted: new Set(["send", "settings", "takeover"]),
          canActivate: true,
          canStageSettings: true,
          sendPath: "awaiting-ack",
          workerEligibility: "unknown",
          handover: "awaiting-owner",
          recovery: recovery({
            reconcile: new Set(["settings", "send"]),
            receiptUpdates: new Set(["send", "stop"]),
            ownershipUpdates: true,
            retry: true,
          }),
        },
      },
      {
        name: "limited provider support",
        facts: { supported: new Set(["send", "stop", "assign"]), workerEligibility: "ineligible" },
      },
      {
        name: "disconnected",
        facts: { reachability: "disconnected", recovery: recovery({ reconnect: true }) },
      },
      { name: "unavailable", facts: { reachability: "unavailable" } },
      {
        name: "unknown route",
        facts: { reachability: "unknown", recovery: recovery({ retry: true }) },
      },
    ];
    const ledger = Array.from({ length: 2 ** kinds.length }, (_, mask) =>
      unknownCommands(...kinds.filter((_, bit) => (mask & (1 << bit)) !== 0)),
    );
    ledger.push({ knowledge: "unknown" });

    for (const unknown of ledger) {
      const receipts = unknown.knowledge === "known" ? [...unknown.kinds].join(",") : "unread";
      for (const phase of phases) {
        for (const owner of owners) {
          for (const route of routes) {
            const input = facts({
              ...route.facts,
              execution: { owner, evidence: owner === "unknown" ? "unknown" : "live" },
              turn: { phase, turnId: phase === "unknown" || phase === "idle" ? null : "turn" },
              unknownCommands: unknown,
            });
            const state = deriveSessionState(input);
            for (const control of controls) {
              const label = `${control}, ${owner}, ${phase}, ${route.name}, receipts=[${receipts}]`;
              const blockers = blockersFor(input, control);
              const supported = input.supported.has(control);
              const permitted = input.permitted.has(control);
              if (
                blockers.length ||
                !supported ||
                !permitted ||
                input.reachability === "unavailable"
              ) {
                assert.equal(state.controls[control].state, "disabled", label);
              }
              if (!supported || !permitted || input.reachability === "unavailable") {
                const item = state.controls[control];
                assert.deepEqual(
                  item,
                  {
                    state: "disabled",
                    reason: !supported
                      ? "unsupported"
                      : !permitted
                        ? "permission-denied"
                        : "session-unavailable",
                    recovery: { kind: "terminal" },
                  },
                  label,
                );
              }
              checkRecovery(input, state, control, blockers, label);
            }
          }
        }
      }
    }
  });

  it("fences each command type only for the operations it could have changed", () => {
    for (const control of controls) {
      const base = enabledFacts(control);
      assert.equal(deriveSessionState(base).controls[control].state, "enabled", control);
      for (const kind of kinds) {
        const input = { ...base, unknownCommands: unknownCommands(kind) };
        const blocked = receiptFences[control].includes(kind);
        const label = `${control} with an unknown ${kind} receipt`;
        const result = deriveSessionState(input).controls[control];
        if (blocked) {
          assert.deepEqual(
            result,
            {
              state: "disabled",
              reason: "command-outcome-unknown",
              recovery: { kind: "terminal" },
            },
            label,
          );
          for (const available of [
            recovery({ reconcile: new Set([kind]) }),
            recovery({ receiptUpdates: new Set([kind]) }),
          ]) {
            const observed = deriveSessionState({ ...input, recovery: available }).controls[
              control
            ];
            assert(observed.state === "disabled" && observed.recovery.kind !== "terminal", label);
          }
        } else {
          assert.deepEqual(result, { state: "enabled" }, label);
        }
      }
    }
  });

  it("keeps send and worker assignment available with only an orphaned settings receipt", () => {
    const state = deriveSessionState(
      facts({
        unknownCommands: unknownCommands("settings"),
        recovery: recovery({ reconcile: new Set(["settings"]) }),
      }),
    );
    assert.equal(state.turn.phase, "idle");
    assert.deepEqual(state.controls.send, { state: "enabled" });
    assert.deepEqual(state.controls.assign, { state: "enabled" });
    assert.deepEqual(state.controls.settings, {
      state: "disabled",
      reason: "command-outcome-unknown",
      recovery: { kind: "action", action: "reconcile" },
    });
  });

  it("keeps a known unknown turn distinct from known empty receipts and awaits matching evidence", () => {
    const base = facts({ turn: { phase: "outcome-unknown", turnId: "unconfirmed-turn" } });
    const terminal = deriveSessionState({ ...base, recovery: recovery({ retry: true }) });
    assert.deepEqual(terminal.unknownCommands, { knowledge: "known", kinds: [] });
    assert.deepEqual(terminal.turn, base.turn);
    for (const control of ["send", "assign"] as const) {
      assert.deepEqual(terminal.controls[control], {
        state: "disabled",
        reason: "outcome-unknown",
        recovery: { kind: "terminal" },
      });
      const candidate = deriveSessionState({
        ...base,
        recovery: recovery({ reconcile: new Set(["turn"]) }),
      });
      assert.deepEqual(candidate.controls[control], {
        state: "disabled",
        reason: "outcome-unknown",
        recovery: { kind: "action", action: "reconcile" },
      });
    }
  });

  it("does not recover a command fence with proof for only one of several outstanding receipts", () => {
    const base = facts({ unknownCommands: unknownCommands("send", "takeover") });
    const incomplete = deriveSessionState({
      ...base,
      recovery: recovery({
        reconcile: new Set(["send"]),
        receiptUpdates: new Set(["settings"]),
        retry: true,
      }),
    });
    assert.deepEqual(incomplete.controls.send, {
      state: "disabled",
      reason: "command-outcome-unknown",
      recovery: { kind: "terminal" },
    });
    const mixed = deriveSessionState({
      ...base,
      recovery: recovery({
        reconcile: new Set(["send"]),
        receiptUpdates: new Set(["takeover"]),
      }),
    });
    assert.deepEqual(mixed.controls.send, {
      state: "disabled",
      reason: "command-outcome-unknown",
      recovery: { kind: "action", action: "reconcile" },
    });
    const waiting = deriveSessionState({
      ...base,
      recovery: recovery({ receiptUpdates: new Set(["send", "takeover"]) }),
    });
    assert.deepEqual(waiting.controls.send, {
      state: "disabled",
      reason: "command-outcome-unknown",
      recovery: { kind: "automatic", signal: "receipt-reconciled" },
    });
  });

  it("offers reconnect for an old disconnected terminal without an available handoff", () => {
    const disconnected = facts({
      execution: { owner: "terminal", evidence: "inferred" },
      reachability: "disconnected",
      recovery: recovery({ reconnect: true }),
    });
    const state = deriveSessionState(disconnected);
    assert.deepEqual(state.controls.send, {
      state: "disabled",
      reason: "connection-lost",
      recovery: { kind: "action", action: "reconnect" },
    });
    assert.equal(state.controls.takeover.state, "disabled");
    const unreachable = deriveSessionState({ ...disconnected, recovery: recovery() });
    assert.deepEqual(unreachable.controls.send, {
      state: "disabled",
      reason: "connection-lost",
      recovery: { kind: "terminal" },
    });
  });

  it("shows native idle while an old bridge waits for its send acknowledgement", () => {
    const base = facts({
      execution: { owner: "terminal", evidence: "live" },
      sendPath: "awaiting-ack",
    });
    const state = deriveSessionState({
      ...base,
      recovery: recovery({ inputPathUpdates: new Set(["send"]) }),
    });
    assert.equal(state.turn.phase, "idle");
    assert.deepEqual(state.controls.send, {
      state: "disabled",
      reason: "awaiting-send-ack",
      recovery: { kind: "automatic", signal: "control-readiness" },
    });
    const ready = deriveSessionState({
      ...base,
      sendPath: "ready",
      recovery: recovery({ inputPathUpdates: new Set(["send"]) }),
    });
    assert.deepEqual(state.controls.assign, ready.controls.assign);
    assert.deepEqual(state.controls.stop, ready.controls.stop);
    assert.deepEqual(
      deriveSessionState({ ...base, recovery: recovery({ turnUpdates: true }) }).controls.send,
      {
        state: "disabled",
        reason: "awaiting-send-ack",
        recovery: { kind: "terminal" },
      },
    );
    assert.deepEqual(ready.controls.send, { state: "enabled" });
  });

  it("does not offer stopping as a recovery when a bridge write is still in flight", () => {
    const state = deriveSessionState(
      facts({
        execution: { owner: "terminal", evidence: "live" },
        turn: { phase: "running", turnId: "active" },
        stopPath: "awaiting-ack",
        recovery: recovery({ inputPathUpdates: new Set(["stop"]), turnUpdates: true }),
      }),
    );
    assert.deepEqual(state.controls.stop, {
      state: "disabled",
      reason: "awaiting-stop-ack",
      recovery: { kind: "automatic", signal: "control-readiness" },
    });
    assert.deepEqual(state.controls.send, {
      state: "disabled",
      reason: "turn-active",
      recovery: { kind: "automatic", signal: "turn-change" },
    });
  });

  it("does not ask to reconcile an operation that would still be terminal", () => {
    const state = deriveSessionState(
      facts({
        workerEligibility: "ineligible",
        unknownCommands: unknownCommands("send", "stop", "takeover"),
        recovery: recovery({ reconcile: new Set(["send", "stop", "takeover"]) }),
      }),
    );
    assert.deepEqual(state.controls.takeover, {
      state: "disabled",
      reason: "owned-by-agentkib",
      recovery: { kind: "terminal" },
    });
    assert.deepEqual(state.controls.stop, {
      state: "disabled",
      reason: "no-active-turn",
      recovery: { kind: "terminal" },
    });
    assert.deepEqual(state.controls.assign, {
      state: "disabled",
      reason: "worker-ineligible",
      recovery: { kind: "terminal" },
    });
  });

  it("keeps compaction separate from the native turn and unrelated controls", () => {
    const base = facts({ recovery: recovery({ turnUpdates: true }) });
    const stable = deriveSessionState(base);
    const compacting = deriveSessionState({ ...base, compacting: true });
    assert.deepEqual(compacting.turn, stable.turn);
    for (const control of ["send", "settings"] as const) {
      assert.deepEqual(compacting.controls[control], {
        state: "disabled",
        reason: "compacting",
        recovery: { kind: "automatic", signal: "turn-change" },
      });
    }
    for (const control of ["assign", "stop", "takeover"] as const) {
      assert.deepEqual(compacting.controls[control], stable.controls[control]);
    }
  });

  it("keeps stale assignment and read facts unknown until there is current evidence", () => {
    const state = deriveSessionState(
      facts({
        role: { kind: "unknown" },
        workerEligibility: "unknown",
        recovery: recovery({ retry: true }),
      }),
    );
    assert.deepEqual(state.role, { kind: "unknown" });
    assert.deepEqual(state.read, { status: "unknown", canAcknowledge: false });
    assert.equal(state.controls.send.state, "enabled");
    assert.equal(state.controls.assign.state, "disabled");
  });

  it("projects only stable public fields and never promotes unverified ownership", () => {
    const execution = {
      owner: "agentkib",
      evidence: "unknown",
      transcript: "private-source",
    } as const;
    const turn = { phase: "idle", turnId: null, nativeProcessId: 123 } as const;
    const role = { kind: "worker", leadId: "lead", remoteCredential: "private-source" } as const;
    const state = deriveSessionState(
      facts({
        execution,
        turn,
        role,
        read: { status: "unknown", canAcknowledge: true },
      }),
    );
    assert.deepEqual(state.execution, { owner: "unknown", evidence: "unknown" });
    assert.deepEqual(state.turn, { phase: "idle", turnId: null });
    assert.deepEqual(state.role, { kind: "worker", leadId: "lead" });
    assert.deepEqual(state.read, { status: "unknown", canAcknowledge: false });
    assert.equal(state.controls.send.state, "disabled");
  });

  it("preserves normalized facts deterministically through a JSON round trip", () => {
    const base = facts({
      revision: 42,
      role: { kind: "worker", leadId: "lead" },
      read: { status: "unread", canAcknowledge: true },
      unknownCommands: unknownCommands("settings", "other"),
      recovery: recovery({ reconcile: new Set(["settings"]) }),
    });
    const state = deriveSessionState(base);
    assert.equal(state.version, 1);
    assert.equal(state.revision, 42);
    assert.deepEqual(state.execution, base.execution);
    assert.deepEqual(state.role, base.role);
    assert.deepEqual(state.read, base.read);
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
    assert.deepEqual(
      deriveSessionState({ ...base, unknownCommands: unknownCommands("other", "settings") }),
      state,
    );
    assert.deepEqual(deriveSessionState(base), state);
  });
});
