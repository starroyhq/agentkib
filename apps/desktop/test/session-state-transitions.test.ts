import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  deriveSessionState,
  type SessionControl,
  type SessionPendingCommand,
  type SessionStateFacts,
} from "../../../packages/backend/src/sessions/session-state";
import {
  transitionSessionState,
  type SessionStateEvent,
  type SessionStateTransitionResult,
} from "../../../packages/backend/src/sessions/session-state-transitions";

const controls: readonly SessionControl[] = [
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
];
const idle = { phase: "idle", turnId: null, cause: null } as const;

function managed(overrides: Partial<SessionStateFacts> = {}): SessionStateFacts {
  return {
    revision: 12,
    execution: { owner: "agentkib", evidence: "live" },
    managedRecord: "held",
    managedWriter: "absent",
    terminalConnection: "none",
    terminalBinding: "retained",
    surface: "desktop",
    turn: idle,
    unknownCommands: pending(),
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
    compacting: false,
    canActivate: false,
    canStageSettings: false,
    terminalModelPicker: true,
    automaticHandback: false,
    handover: "unavailable",
    recovery: {
      automaticReconcile: false,
      reconnect: true,
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
    },
    ...overrides,
  };
}

function pending(...entries: SessionPendingCommand[]): SessionStateFacts["unknownCommands"] {
  return { knowledge: "known", entries };
}

function reconcile(
  facts: SessionStateFacts,
  completedRequests: readonly string[] = [],
): SessionStateEvent {
  return {
    kind: "reconcile",
    intent: "manual",
    expectedRevision: facts.revision,
    completedRequests: new Set(completedRequests),
  };
}

const observedTerminal = {
  owner: "terminal",
  connection: "live",
  turn: idle,
  toolsReady: null,
} as const;

function resume(facts: SessionStateFacts): SessionStateEvent {
  return {
    kind: "terminal-resumed",
    identity: "new",
    expectedRevision: facts.revision,
    observation: observedTerminal,
  };
}

function handback(facts: SessionStateFacts): SessionStateEvent {
  return {
    kind: "handback",
    intent: "manual",
    expectedRevision: facts.revision,
    confirmation: { writer: "absent", observation: observedTerminal },
  };
}

function clearScheduledPause(facts: SessionStateFacts): SessionStateEvent {
  return {
    kind: "queue-cause-observed",
    expectedRevision: facts.revision,
    reason: "scheduled-outcome-unknown",
    cause: "absent",
  };
}

function applied(result: SessionStateTransitionResult) {
  assert.equal(result.state, "applied");
  return result;
}

type EventProducer = (facts: SessionStateFacts) => SessionStateEvent;

function shortestPath(
  start: SessionStateFacts,
  goal: SessionControl,
  events: readonly EventProducer[],
): SessionStateEvent["kind"][] | undefined {
  const frontier = [{ facts: start, path: [] as SessionStateEvent["kind"][], events }];
  for (const node of frontier) {
    if (deriveSessionState(node.facts).controls[goal].state === "enabled") return node.path;
    for (const produce of node.events) {
      const event = produce(node.facts);
      const result = transitionSessionState(node.facts, event);
      if (result.state === "applied")
        frontier.push({
          facts: result.facts,
          path: [...node.path, event.kind],
          events: node.events.filter((candidate) => candidate !== produce),
        });
    }
  }
}

describe("session state transitions", () => {
  it.each([
    ["the result omitted a steer UUID", "later-steer"],
    ["the native start frame was absent but stream frames arrived", "original-turn"],
  ])("reconciles after %s without attributing opener proof to the steer", (_fault, turnId) => {
    const facts = managed({
      turn: { phase: "outcome-unknown", turnId, cause: "protocol-stop" },
      unknownCommands: pending(
        { kind: "send", requestId: "opener", side: "agentkib", phase: "dispatched" },
        { kind: "steer", requestId: "later-steer", side: "agentkib", phase: "dispatched" },
        { kind: "settings", requestId: "prepared", side: "agentkib", phase: "prepared" },
      ),
    });
    const state = deriveSessionState(facts);
    assert.deepEqual(state.controls.send, {
      state: "disabled",
      reason: "outcome-unknown",
      recovery: { kind: "action", action: "reconcile" },
    });
    assert.equal(state.controls.assign.state, "disabled");

    const resolveOpener = (facts: SessionStateFacts) => reconcile(facts, ["opener", "prepared"]);
    assert.equal(shortestPath(facts, "send", []), undefined);
    assert.deepEqual(shortestPath(facts, "send", [resolveOpener]), ["reconcile"]);
    const result = applied(transitionSessionState(facts, resolveOpener(facts)));
    assert.deepEqual(result.receipts, [
      { requestId: "opener", outcome: "completed" },
      { requestId: "later-steer", outcome: "unknown" },
      { requestId: "prepared", outcome: "not-dispatched" },
    ]);
    assert.deepEqual(result.facts.unknownCommands, pending());
    assert.equal(result.facts.revision, facts.revision + 1);
    assert.deepEqual(result.facts.turn, idle);
    assert.equal(deriveSessionState(result.facts).controls.assign.state, "enabled");
    assert.deepEqual(transitionSessionState(result.facts, resolveOpener(facts)), {
      state: "refused",
      facts: result.facts,
      reason: "stale-revision",
    });
  });

  it.each([
    {
      name: "running managed writer",
      overrides: { managedWriter: "live" },
      reason: "managed-writer-active",
    },
    {
      name: "retiring managed writer",
      overrides: { managedWriter: "retiring" },
      reason: "managed-writer-active",
    },
    {
      name: "unconfirmed managed cleanup",
      overrides: { managedWriter: "cleanup-unconfirmed" },
      reason: "writer-unconfirmed",
    },
    {
      name: "connected terminal",
      overrides: { terminalConnection: "live" },
      reason: "terminal-writer-active",
    },
    {
      name: "terminal gap",
      overrides: { terminalConnection: "gap" },
      reason: "terminal-writer-active",
    },
    {
      name: "external writer",
      overrides: { execution: { owner: "external", evidence: "live" } },
      reason: "external-owner",
    },
    {
      name: "unreadable receipt ledger",
      overrides: { unknownCommands: { knowledge: "unknown" } },
      reason: "state-unknown",
    },
  ] as const)("leaves all facts and receipts alone with $name", ({ overrides, reason }) => {
    const facts = managed({
      turn: { phase: "outcome-unknown", turnId: "stopped", cause: "protocol-stop" },
      unknownCommands: pending({
        kind: "steer",
        requestId: "steer",
        side: "agentkib",
        phase: "dispatched",
      }),
      ...overrides,
    });
    const result = transitionSessionState(facts, reconcile(facts, ["steer"]));
    assert.deepEqual(result, { state: "refused", facts, reason });
    assert.equal(result.facts, facts);
  });

  it("automatically reconciles a cold settings receipt without requiring turn completion", () => {
    const initial = managed();
    const facts = managed({
      turn: { phase: "outcome-unknown", turnId: "old-turn", cause: "runner-lost" },
      unknownCommands: pending({
        kind: "settings",
        requestId: "old-settings",
        side: "agentkib",
        phase: "dispatched",
      }),
      recovery: { ...initial.recovery, automaticReconcile: true },
    });
    assert.deepEqual(deriveSessionState(facts).controls.send, {
      state: "disabled",
      reason: "outcome-unknown",
      recovery: { kind: "automatic", signal: "receipt-reconciled" },
    });
    const result = applied(
      transitionSessionState(facts, {
        kind: "reconcile",
        intent: "automatic",
        expectedRevision: facts.revision,
        completedRequests: new Set(),
      }),
    );
    assert.deepEqual(result.receipts, [{ requestId: "old-settings", outcome: "unknown" }]);
    const state = deriveSessionState(result.facts);
    assert.equal(state.controls.send.state, "enabled");
    assert.equal(state.controls.settings.state, "enabled");
    assert.equal(state.controls.assign.state, "enabled");
  });

  it("reconciles a persisted starting turn when the original writer is confirmed absent", () => {
    const facts = managed({ turn: { phase: "starting", turnId: "old-start", cause: null } });
    assert.equal(deriveSessionState(facts).turn.cause, "runner-lost");
    const result = applied(transitionSessionState(facts, reconcile(facts)));
    assert.deepEqual(result.receipts, []);
    assert.deepEqual(result.facts.turn, idle);
    assert.equal(deriveSessionState(result.facts).controls.send.state, "enabled");
  });

  it("hands back the contested lead and clears a stale scheduler pause independently", () => {
    const facts = managed({
      role: { kind: "lead" },
      projectAgentToolsReady: true,
      recovery: { ...managed().recovery, queueUpdates: true },
      queue: { state: "paused", reason: "scheduled-outcome-unknown", cause: "present" },
      unknownCommands: pending(
        { kind: "report", requestId: "old-host-report", side: "agentkib", phase: "dispatched" },
        { kind: "settings", requestId: "terminal-settings", side: "terminal", phase: "dispatched" },
      ),
    });
    const resumed = applied(transitionSessionState(facts, resume(facts))).facts;
    const state = deriveSessionState(resumed);
    assert.equal(state.execution.owner, "external");
    assert.deepEqual(state.lease, { state: "pending", reason: "contested" });
    assert.deepEqual(state.controls.send, {
      state: "disabled",
      reason: "lease-contested",
      recovery: { kind: "action", action: "handback" },
    });
    assert.equal(resumed.terminalConnection, "none");
    assert.equal(state.projectAgentToolsReady, null);
    assert.deepEqual(state.queue, { state: "paused", reason: "scheduled-outcome-unknown" });
    assert.equal(shortestPath(resumed, "report", [handback]), undefined);
    assert.equal(shortestPath(resumed, "report", [clearScheduledPause]), undefined);
    assert.deepEqual(shortestPath(resumed, "report", [handback, clearScheduledPause]), [
      "handback",
      "queue-cause-observed",
    ]);

    const returned = applied(transitionSessionState(resumed, handback(resumed)));
    assert.deepEqual(returned.receipts, [{ requestId: "old-host-report", outcome: "unknown" }]);
    assert.deepEqual(
      returned.facts.unknownCommands,
      pending({
        kind: "settings",
        requestId: "terminal-settings",
        side: "terminal",
        phase: "dispatched",
      }),
    );
    assert.equal(returned.facts.managedWriter, "absent");
    assert.equal(returned.facts.terminalBinding, "retained");
    assert.equal(returned.facts.role, facts.role);
    assert.equal(returned.facts.projectAgentToolsReady, null);
    assert.deepEqual(deriveSessionState(returned.facts).lease, { state: "returned", reason: null });
    assert.equal(deriveSessionState(returned.facts).controls.send.state, "enabled");
    assert.deepEqual(deriveSessionState(returned.facts).controls.report, {
      state: "disabled",
      reason: "queue-paused",
      recovery: { kind: "automatic", signal: "queue-change" },
    });
    const recovered = applied(
      transitionSessionState(returned.facts, clearScheduledPause(returned.facts)),
    );
    assert.deepEqual(recovered.receipts, []);
    assert.equal(deriveSessionState(recovered.facts).controls.report.state, "enabled");
  });

  it("requires the new terminal instance and a known writer exit before returning a lease", () => {
    const facts = managed({ managedWriter: "live" });
    const previous = transitionSessionState(facts, {
      kind: "terminal-resumed",
      identity: "stale",
      expectedRevision: facts.revision,
      observation: observedTerminal,
    });
    assert.deepEqual(previous, { state: "refused", facts, reason: "stale-instance" });
    const resumed = applied(transitionSessionState(facts, resume(facts))).facts;
    const result = transitionSessionState(resumed, {
      kind: "handback",
      intent: "manual",
      expectedRevision: resumed.revision,
      confirmation: { writer: "cleanup-unconfirmed" },
    });
    assert.equal(result.state, "pending");
    assert.equal(result.facts.managedRecord, "held");
    assert.equal(result.facts.terminalConnection, "none");
    const state = deriveSessionState(result.facts);
    assert.deepEqual(state.lease, { state: "pending", reason: "writer-unconfirmed" });
    assert.equal(state.controls.send.state, "disabled");
  });

  it("allows an automatic handback only after a confirmed exit and under the explicit policy", () => {
    const active = (automaticHandback: boolean) =>
      managed({
        managedWriter: "live",
        automaticHandback,
        surface: "remote",
        turn: { phase: "running", turnId: "old-turn", cause: null },
      });
    const automatic = (
      facts: SessionStateFacts,
      writer: "absent" | "cleanup-unconfirmed",
    ): SessionStateEvent => ({
      kind: "handback",
      intent: "automatic",
      expectedRevision: facts.revision,
      confirmation: writer === "absent" ? { writer, observation: observedTerminal } : { writer },
    });
    const disabled = active(false);
    const external = applied(transitionSessionState(disabled, resume(disabled))).facts;
    assert.deepEqual(transitionSessionState(external, automatic(external, "absent")), {
      state: "refused",
      facts: external,
      reason: "not-applicable",
    });
    const running = active(true);
    const contested = applied(transitionSessionState(running, resume(running))).facts;
    assert.equal(deriveSessionState(contested).controls.handback.state, "hidden");
    const uncertain = transitionSessionState(
      contested,
      automatic(contested, "cleanup-unconfirmed"),
    );
    assert.equal(uncertain.state, "pending");
    assert.equal(uncertain.facts.managedRecord, "held");
    assert.equal(uncertain.facts.terminalConnection, "none");
    const returned = applied(
      transitionSessionState(uncertain.facts, automatic(uncertain.facts, "absent")),
    );
    assert.equal(returned.facts.managedRecord, "returned");
    assert.equal(returned.facts.managedWriter, "absent");
    assert.equal(returned.facts.execution.owner, "terminal");

    const cold = managed({
      automaticHandback: true,
      unknownCommands: pending({
        kind: "steer",
        requestId: "pending-input",
        side: "agentkib",
        phase: "dispatched",
      }),
    });
    const blocked = applied(transitionSessionState(cold, resume(cold))).facts;
    assert.deepEqual(transitionSessionState(blocked, automatic(blocked, "absent")), {
      state: "refused",
      facts: blocked,
      reason: "native-input-unconfirmed",
    });
  });

  it("does not turn a user pause into an automatic queue resume", () => {
    const facts = managed({ queue: { state: "paused", reason: "user-paused", cause: "present" } });
    const { facts: observed } = applied(
      transitionSessionState(facts, {
        kind: "queue-cause-observed",
        expectedRevision: facts.revision,
        reason: "user-paused",
        cause: "absent",
      }),
    );
    const result = applied(transitionSessionState(observed, handback(observed)));
    assert.deepEqual(deriveSessionState(result.facts).queue, {
      state: "paused",
      reason: "user-paused",
    });
    const { facts: resumed } = applied(
      transitionSessionState(result.facts, {
        kind: "resume-queue",
        expectedRevision: result.facts.revision,
      }),
    );
    assert.deepEqual(deriveSessionState(resumed).queue, { state: "running", reason: null });
    assert.deepEqual(deriveSessionState(resumed).lease, { state: "returned", reason: null });
  });

  it("restarts from the same public state when the persisted facts have not changed", () => {
    const facts = managed({
      turn: { phase: "outcome-unknown", turnId: "stopped", cause: "protocol-stop" },
      queue: { state: "paused", reason: "scheduled-outcome-unknown", cause: "unknown" },
      unknownCommands: pending({
        kind: "steer",
        requestId: "steer",
        side: "agentkib",
        phase: "dispatched",
      }),
    });
    const { supported, permitted, recovery, ...durable } = facts;
    const restarted = managed({
      ...JSON.parse(JSON.stringify(durable)),
      supported: new Set(supported),
      permitted: new Set(permitted),
      recovery: {
        ...recovery,
        inputPathUpdates: new Set(recovery.inputPathUpdates),
        receiptUpdates: new Set(recovery.receiptUpdates),
      },
    });
    assert.deepEqual(deriveSessionState(restarted), deriveSessionState(facts));
    assert.deepEqual(
      transitionSessionState(restarted, reconcile(restarted)),
      transitionSessionState(facts, reconcile(facts)),
    );
  });
});
