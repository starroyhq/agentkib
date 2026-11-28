import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  REMOTE_ERROR_CODES,
  parseSessionState,
  type SessionUnknownCommandKind,
} from "@agentkib/runtime-protocol";
import {
  classifySessionCommand,
  deriveSessionState,
  deriveSessionStateWithDiagnostics,
  type SessionControl,
  type SessionPendingCommand,
  type SessionStateFacts,
} from "../../../packages/backend/src/sessions/session-state";

const controls = [
  "send",
  "steer",
  "queue",
  "stop",
  "settings",
  "assign",
  "takeover",
  "handback",
  "reconcile",
  "resumeQueue",
  "report",
  "approve",
  "answer",
] as const satisfies readonly SessionControl[];
const kinds = [
  "send",
  "steer",
  "stop",
  "settings",
  "report",
  "lease",
  "interaction",
  "other",
  "unclassified",
] as const;
const owners = ["agentkib", "terminal", "external", "native-app", "none", "unknown"] as const;
const evidence = ["live", "inferred", "unknown"] as const;
const records = ["none", "held", "returned", "invalid"] as const;
const phases = [
  "unknown",
  "idle",
  "starting",
  "running",
  "awaiting-approval",
  "awaiting-answer",
  "outcome-unknown",
] as const;
const terminalReasons = new Set([
  "permission-denied",
  "not-applicable",
  "no-active-turn",
  "owned-by-agentkib",
  "worker-ineligible",
  "session-unavailable",
  "handover-workspace-mismatch",
]);

function rawTurn(phase: SessionStateFacts["turn"]["phase"]): SessionStateFacts["turn"] {
  return {
    phase,
    turnId: phase === "idle" || phase === "unknown" ? null : "turn",
    cause: phase === "outcome-unknown" ? "input-unconfirmed" : null,
  };
}

function commands(
  kinds: readonly SessionUnknownCommandKind[],
  side: SessionPendingCommand["side"] = "agentkib",
): SessionStateFacts["unknownCommands"] {
  return {
    knowledge: "known",
    entries: kinds.map((kind, index) => ({
      requestId: "request-" + index,
      side,
      phase: "dispatched",
      ...(kind === "lease" ? { kind, direction: "takeover" } : { kind }),
    })),
  };
}

function hints(
  overrides: Partial<SessionStateFacts["recovery"]> = {},
): SessionStateFacts["recovery"] {
  return {
    automaticReconcile: false,
    reconnect: false,
    turnUpdates: false,
    ownershipUpdates: false,
    leaseUpdates: false,
    connectionUpdates: false,
    queueUpdates: false,
    canEndProcess: false,
    canFork: false,
    canRestartWorker: false,
    inputPathUpdates: new Set(),
    receiptUpdates: new Set(),
    ...overrides,
  };
}

function facts(overrides: Partial<SessionStateFacts> = {}): SessionStateFacts {
  return {
    revision: 12,
    execution: { owner: "agentkib", evidence: "live" },
    managedRecord: "held",
    managedWriter: "live",
    terminalConnection: "none",
    terminalBinding: "none",
    surface: "desktop",
    turn: rawTurn("idle"),
    unknownCommands: commands([]),
    queue: { state: "running" },
    role: { kind: "none" },
    projectAgentToolsReady: null,
    read: { status: "unknown", canAcknowledge: false },
    reachability: "available",
    supported: new Set(controls),
    permitted: new Set(controls),
    sendPath: "ready",
    stopPath: "ready",
    workerEligibility: { available: true },
    canActivate: false,
    canStageSettings: true,
    terminalModelPicker: false,
    automaticHandback: false,
    compacting: false,
    handover: "unavailable",
    recovery: hints(),
    ...overrides,
  };
}

function enabledFacts(control: SessionControl): SessionStateFacts {
  if (control === "takeover") {
    return facts({
      execution: { owner: "terminal", evidence: "live" },
      managedRecord: "none",
      managedWriter: "absent",
      terminalConnection: "live",
      handover: "available",
    });
  }
  if (control === "resumeQueue")
    return facts({ queue: { state: "paused", reason: "user-paused", cause: "present" } });
  if (control === "answer") return facts({ turn: rawTurn("awaiting-answer") });
  if (control === "approve") return facts({ turn: rawTurn("awaiting-approval") });
  if (control === "steer" || control === "queue" || control === "stop")
    return facts({ turn: rawTurn("running") });
  return facts();
}

const alwaysFenced = ["lease", "unclassified"] as const;
const expectedFences: Record<
  Exclude<SessionControl, "reconcile">,
  readonly SessionUnknownCommandKind[]
> = {
  send: ["send", "steer", ...alwaysFenced],
  steer: alwaysFenced,
  queue: alwaysFenced,
  stop: ["stop", ...alwaysFenced],
  settings: ["settings", ...alwaysFenced],
  assign: ["send", "steer", "stop", ...alwaysFenced],
  takeover: ["send", "steer", "report", "interaction", ...alwaysFenced],
  handback: alwaysFenced,
  report: ["send", "report", ...alwaysFenced],
  resumeQueue: alwaysFenced,
  answer: ["interaction", ...alwaysFenced],
  approve: ["interaction", ...alwaysFenced],
};

describe("session state v1", () => {
  it("does not allow an unrelated turn update to recover unknown ownership", () => {
    const state = deriveSessionState(
      facts({
        execution: { owner: "agentkib", evidence: "unknown" },
        recovery: hints({ turnUpdates: true }),
      }),
    );
    expect(state.execution).toEqual({ owner: "unknown", evidence: "unknown" });
    expect(state.controls.send).toEqual({
      state: "disabled",
      reason: "state-unknown",
      recovery: { kind: "action", action: "retry" },
    });
  });

  it("falls back to a read retry and surfaces a diagnostic instead of turning missing proof into terminal", () => {
    const outcome = deriveSessionStateWithDiagnostics(
      facts({
        turn: rawTurn("outcome-unknown"),
        unknownCommands: commands(["steer", "send"]),
        recovery: hints({ receiptUpdates: new Set(["settings"]), turnUpdates: true }),
        supported: new Set(["send"]),
      }),
    );
    expect(outcome.state.controls.send).toEqual({
      state: "disabled",
      reason: "command-outcome-unknown",
      recovery: { kind: "action", action: "retry" },
    });
    expect(outcome.missingRecovery).toEqual([
      { control: "send", reason: "command-outcome-unknown" },
    ]);
    expect(outcome.state.controls.reconcile).toEqual({ state: "hidden" });
  });

  it("fences each command type in both directions and only blocks the same report", () => {
    for (const [control, blocked] of Object.entries(expectedFences) as Array<
      [Exclude<SessionControl, "reconcile">, readonly SessionUnknownCommandKind[]]
    >) {
      const base = enabledFacts(control);
      assert.equal(deriveSessionState(base).controls[control].state, "enabled", control);
      for (const kind of kinds) {
        const state = deriveSessionState({
          ...base,
          reportRequestId: "request-0",
          unknownCommands: commands([kind], control === "takeover" ? "terminal" : "agentkib"),
        });
        assert.equal(
          state.controls[control].state,
          blocked.includes(kind) ? "disabled" : "enabled",
          control + ":" + kind,
        );
      }
    }
    expect(
      deriveSessionState(
        facts({
          reportRequestId: "different",
          unknownCommands: commands(["report"]),
        }),
      ).controls.report.state,
    ).toBe("enabled");
  });

  it("only fences an orphaned settings receipt while a writer may remain", () => {
    const base = facts({ unknownCommands: commands(["settings"]) });
    const live = deriveSessionState(base);
    expect(live.controls.settings.state).toBe("disabled");
    expect(live.controls.send.state).toBe("enabled");
    expect(live.controls.assign.state).toBe("enabled");
    expect(live.controls.handback.state).toBe("enabled");
    const cold = deriveSessionState({ ...base, managedWriter: "absent" });
    expect(cold.controls.settings.state).toBe("enabled");
    expect(cold.controls.reconcile.state).toBe("enabled");
  });

  it("requires verified writer absence to allow reconciliation and returns the correct recovery", () => {
    const base = facts({ turn: rawTurn("outcome-unknown"), unknownCommands: commands(["steer"]) });
    const absent = deriveSessionState({ ...base, managedWriter: "absent" });
    expect(absent.controls.reconcile.state).toBe("enabled");
    expect(absent.controls.send).toMatchObject({
      reason: "outcome-unknown",
      recovery: { kind: "action", action: "reconcile" },
    });
    expect(absent.controls.handback.state).toBe("enabled");
    const automatic = deriveSessionState({
      ...base,
      managedWriter: "absent",
      recovery: hints({ automaticReconcile: true }),
    });
    expect(automatic.controls.send).toMatchObject({
      recovery: { kind: "automatic", signal: "receipt-reconciled" },
    });
    const unverified = deriveSessionState({
      ...base,
      managedWriter: "absent",
      execution: { owner: "agentkib", evidence: "inferred" },
      permitted: new Set(["reconcile", "send"]),
    });
    expect(unverified.controls.reconcile.state).toBe("disabled");
    expect(unverified.controls.send).toMatchObject({
      recovery: { kind: "action", action: "retry" },
    });
    expect(
      deriveSessionState({
        ...base,
        managedWriter: "cleanup-unconfirmed",
        recovery: hints({ canEndProcess: true }),
      }).controls.send,
    ).toMatchObject({
      reason: "writer-unconfirmed",
      recovery: { kind: "action", action: "end-process" },
    });
  });

  it("preserves PA-5 local candidate refusals and independent tool readiness", () => {
    for (const [role, detail] of [
      [{ kind: "lead" }, REMOTE_ERROR_CODES.sessionIsAProjectAgent],
      [{ kind: "worker", leadId: "own-lead" }, REMOTE_ERROR_CODES.sessionIsAWorker],
    ] as const) {
      const state = deriveSessionState(
        facts({ role, workerEligibility: { available: null }, projectAgentToolsReady: false }),
      );
      expect(state.controls.assign).toMatchObject({ reason: "worker-ineligible", detail });
      expect(state.projectAgentToolsReady).toBe(false);
    }
    const unknown = deriveSessionState(
      facts({ role: { kind: "unknown" }, projectAgentToolsReady: null }),
    );
    expect(unknown.controls.assign).toMatchObject({ reason: "state-unknown" });
    const refused = deriveSessionState(
      facts({
        workerEligibility: { available: false, reason: REMOTE_ERROR_CODES.workerProbeFailed },
      }),
    );
    expect(refused.controls.assign).toEqual({
      state: "disabled",
      reason: "state-unknown",
      detail: REMOTE_ERROR_CODES.workerProbeFailed,
      recovery: { kind: "action", action: "retry" },
    });
    expect(deriveSessionState(facts({ projectAgentToolsReady: false })).controls.assign.state).toBe(
      "enabled",
    );
  });

  it("keeps the stop path recoverable while the runner is starting", () => {
    const state = deriveSessionState(
      facts({
        managedWriter: "starting",
        turn: rawTurn("starting"),
        recovery: hints({ turnUpdates: true }),
      }),
    );
    expect(state.controls.stop).toEqual({
      state: "disabled",
      reason: "turn-active",
      recovery: { kind: "automatic", signal: "turn-change" },
    });
  });

  it("projects model ownership and desktop-only recovery without mixing terminal and managed controls", () => {
    const terminal = enabledFacts("takeover");
    const local = deriveSessionState({ ...terminal, terminalModelPicker: true });
    expect(local.modelEntry).toBe("terminal");
    expect(local.controls.settings).toMatchObject({
      reason: "terminal-settings",
      recovery: { kind: "action", action: "open-model-picker" },
    });
    const remote = deriveSessionState({
      ...terminal,
      terminalModelPicker: true,
      surface: "remote",
    });
    expect(remote.modelEntry).toBe("display-only");
    expect(remote.controls.settings).toMatchObject({
      recovery: { kind: "action", action: "takeover" },
    });
    expect(remote.controls.handback.state).toBe("hidden");
    const gap = deriveSessionState({
      ...terminal,
      terminalConnection: "gap",
      terminalModelPicker: true,
    });
    expect(gap.modelEntry).toBe("display-only");
    expect(deriveSessionState(facts({ terminalModelPicker: true })).modelEntry).toBe("agentkib");
  });

  it("requires a send-readiness signal even if the terminal turn already fell idle", () => {
    const base = { ...enabledFacts("takeover"), sendPath: "awaiting-ack" as const };
    const state = deriveSessionState({
      ...base,
      recovery: hints({ inputPathUpdates: new Set(["send"]) }),
    });
    expect(state.turn.phase).toBe("idle");
    expect(state.controls.send).toMatchObject({
      reason: "awaiting-send-ack",
      recovery: { kind: "automatic", signal: "control-readiness" },
    });
    expect(
      deriveSessionState({ ...base, recovery: hints({ turnUpdates: true }) }).controls.send,
    ).toMatchObject({
      recovery: { kind: "action", action: "retry" },
    });
  });

  it("classifies only known operations and determines lease direction from the operation", () => {
    const scope = { requestId: "request", side: "agentkib", phase: "dispatched" } as const;
    expect(classifySessionCommand("release", scope)).toMatchObject({
      kind: "lease",
      direction: "handback",
    });
    expect(classifySessionCommand("adopt-terminal", scope)).toMatchObject({
      kind: "lease",
      direction: "takeover",
    });
    for (const [operation, kind] of [
      ["queue-steer", "steer"],
      ["send", "send"],
      ["orchestration-report", "report"],
      ["settings", "settings"],
      ["approve", "interaction"],
      ["stop", "stop"],
      ["goal-clear", "other"],
      ["delete", "unclassified"],
      [undefined, "unclassified"],
      ["goal-unknown", "unclassified"],
    ])
      expect(classifySessionCommand(operation, scope).kind).toBe(kind);
    expect(classifySessionCommand("queue-add", { ...scope, side: "terminal" }).kind).toBe("steer");
    expect(classifySessionCommand("queue-add", scope).kind).toBe("unclassified");
  });

  it("allows a terminal recovery only for named reasons across every fenced subset and ownership shape", () => {
    const ledger = Array.from({ length: 2 ** kinds.length }, (_, mask) =>
      commands(kinds.filter((_, bit) => (mask & (1 << bit)) !== 0)),
    );
    ledger.push({ knowledge: "unknown" });
    let count = 0;
    for (const unknownCommands of ledger)
      for (const phase of phases)
        for (const owner of owners)
          for (const level of evidence)
            for (const managedRecord of records) {
              const state = deriveSessionState(
                facts({
                  execution: { owner, evidence: level },
                  managedRecord,
                  managedWriter:
                    managedRecord === "held" && phase !== "idle" && phase !== "outcome-unknown"
                      ? "live"
                      : "absent",
                  terminalConnection: owner === "terminal" ? "live" : "none",
                  turn: rawTurn(phase),
                  unknownCommands,
                }),
              );
              for (const entry of Object.values(state.controls)) {
                if (entry.state !== "disabled") continue;
                assert.equal(entry.recovery.kind === "terminal", terminalReasons.has(entry.reason));
              }
              if (state.execution.owner === "unknown" || unknownCommands.knowledge === "unknown")
                assert.notEqual(state.controls.send.state, "enabled");
              if (count++ % 4096 === 0) assert(parseSessionState(state));
            }
    expect(count).toBe(258552);
  }, 30_000);
});
