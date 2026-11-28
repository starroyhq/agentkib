import type { SessionControlReason } from "@agentkib/runtime-protocol";
import {
  automaticSessionHandbackBlocker,
  deriveSessionState,
  sessionStateWritersAbsent,
  type SessionPendingCommand,
  type SessionStateFacts,
} from "./session-state";

type QueuePause = Extract<SessionStateFacts["queue"], { state: "paused" }>;
type QueueCauseObservation = Pick<QueuePause, "reason" | "cause">;
type TerminalConnection = SessionStateFacts["terminalConnection"];
type TerminalObservation =
  | {
      owner: "terminal";
      connection: Exclude<TerminalConnection, "none">;
      turn: SessionStateFacts["turn"];
      toolsReady: boolean | null;
    }
  | { owner: "external"; connection: "none" }
  | { owner: "none"; connection: "none" };

type SessionStateEventKind =
  | {
      kind: "terminal-resumed";
      identity: "new" | "stale" | "unknown";
      observation: Exclude<TerminalObservation, { owner: "none" }>;
    }
  | {
      kind: "reconcile";
      intent: "manual" | "automatic";
      completedRequests: ReadonlySet<string>;
      queueCause?: QueueCauseObservation;
    }
  | {
      kind: "handback";
      intent: "manual" | "automatic";
      confirmation:
        | { writer: "absent"; observation: TerminalObservation }
        | { writer: "cleanup-unconfirmed" };
    }
  | ({ kind: "queue-cause-observed" } & QueueCauseObservation)
  | { kind: "resume-queue" };

export type SessionStateEvent = SessionStateEventKind & { expectedRevision: number };

type ReceiptDisposition = {
  requestId: string;
  outcome: "completed" | "not-dispatched" | "unknown";
};

type Refusal =
  | SessionControlReason
  | "stale-instance"
  | "stale-revision"
  | "native-input-unconfirmed"
  | "managed-writer-active"
  | "terminal-writer-active";

export type SessionStateTransitionResult =
  | { state: "applied"; facts: SessionStateFacts; receipts: readonly ReceiptDisposition[] }
  | { state: "refused"; facts: SessionStateFacts; reason: Refusal }
  | { state: "pending"; facts: SessionStateFacts; reason: "writer-unconfirmed" };

const idle = { phase: "idle", turnId: null, cause: null } as const;
const unobserved = { phase: "unknown", turnId: null, cause: null } as const;

function advanced(facts: SessionStateFacts, change: Partial<SessionStateFacts>): SessionStateFacts {
  return { ...facts, ...change, revision: facts.revision + 1 };
}

function applied(
  facts: SessionStateFacts,
  change: Partial<SessionStateFacts>,
  receipts: readonly ReceiptDisposition[] = [],
): SessionStateTransitionResult {
  return { state: "applied", facts: advanced(facts, change), receipts };
}

function refused(facts: SessionStateFacts, reason: Refusal): SessionStateTransitionResult {
  return { state: "refused", facts, reason };
}

function observedTerminal(observation: TerminalObservation): Partial<SessionStateFacts> {
  return {
    execution: { owner: observation.owner, evidence: "live" },
    terminalConnection: observation.connection,
    projectAgentToolsReady: observation.owner === "terminal" ? observation.toolsReady : null,
    turn:
      observation.owner === "terminal"
        ? observation.turn
        : observation.owner === "none"
          ? idle
          : unobserved,
  };
}

function observeResume(
  facts: SessionStateFacts,
  event: Extract<SessionStateEvent, { kind: "terminal-resumed" }>,
): SessionStateTransitionResult {
  if (event.identity === "stale") return refused(facts, "stale-instance");
  if (event.identity === "unknown" || facts.managedRecord === "invalid")
    return refused(facts, "state-unknown");
  // A terminal attempting to connect does not acquire the lease. Keep the managed
  // turn as a private fact so an authorized caller can stop it while ownership is contested.
  if (facts.managedRecord === "held")
    return applied(facts, {
      execution: { owner: "external", evidence: "live" },
      terminalConnection: "none",
      projectAgentToolsReady: null,
    });
  return applied(facts, observedTerminal(event.observation));
}

function settleReceipts(
  entries: readonly SessionPendingCommand[],
  completedRequests?: ReadonlySet<string>,
): ReceiptDisposition[] {
  return entries.map(({ requestId, phase }) => ({
    requestId,
    outcome:
      phase === "prepared"
        ? "not-dispatched"
        : completedRequests?.has(requestId)
          ? "completed"
          : "unknown",
  }));
}

function writerRefusal(facts: SessionStateFacts): Refusal {
  if (facts.managedWriter === "cleanup-unconfirmed") return "writer-unconfirmed";
  if (facts.managedWriter !== "absent") return "managed-writer-active";
  if (facts.terminalConnection !== "none") return "terminal-writer-active";
  if (
    facts.execution.owner === "external" ||
    facts.execution.owner === "native-app" ||
    facts.execution.owner === "terminal"
  )
    return "external-owner";
  return "state-unknown";
}

function resumeStaleQueue(queue: SessionStateFacts["queue"]): SessionStateFacts["queue"] {
  return queue.state === "paused" && queue.reason !== "user-paused" && queue.cause === "absent"
    ? { state: "running" }
    : queue;
}

function observeQueueCause(
  queue: SessionStateFacts["queue"],
  observed: QueueCauseObservation | undefined,
): SessionStateFacts["queue"] {
  return queue.state === "paused" &&
    queue.reason !== "user-paused" &&
    observed?.reason === queue.reason &&
    observed.cause !== queue.cause
    ? { ...queue, cause: observed.cause }
    : queue;
}

function reconcile(
  facts: SessionStateFacts,
  event: Extract<SessionStateEvent, { kind: "reconcile" }>,
): SessionStateTransitionResult {
  if (!sessionStateWritersAbsent(facts)) return refused(facts, writerRefusal(facts));
  if (facts.unknownCommands.knowledge !== "known") return refused(facts, "state-unknown");
  const observedQueue = observeQueueCause(facts.queue, event.queueCause);
  const state = deriveSessionState({ ...facts, queue: observedQueue });
  if (event.intent === "automatic") {
    if (!facts.recovery.automaticReconcile) return refused(facts, "not-applicable");
  } else {
    const availability = state.controls.reconcile;
    if (availability.state === "hidden") return refused(facts, "not-applicable");
    if (availability.state !== "enabled") return refused(facts, availability.reason);
  }
  const { entries } = facts.unknownCommands;
  const queue = resumeStaleQueue(observedQueue);
  if (!entries.length && state.turn.phase !== "outcome-unknown" && queue === facts.queue)
    return refused(facts, "not-applicable");
  return applied(
    facts,
    {
      turn: state.turn.phase === "outcome-unknown" ? idle : facts.turn,
      unknownCommands: { knowledge: "known", entries: [] },
      queue,
    },
    settleReceipts(entries, event.completedRequests),
  );
}

function handback(
  facts: SessionStateFacts,
  event: Extract<SessionStateEvent, { kind: "handback" }>,
): SessionStateTransitionResult {
  const { confirmation } = event;
  if (event.intent === "automatic") {
    const blocker = automaticSessionHandbackBlocker(facts);
    if (blocker) return refused(facts, blocker);
    if (confirmation.writer === "absent") {
      const { observation } = confirmation;
      if (observation.owner === "none") return refused(facts, "not-applicable");
      if (observation.owner === "terminal" && observation.connection !== "live")
        return refused(facts, "connection-lost");
    }
  } else {
    const availability = deriveSessionState(facts).controls.handback;
    if (availability.state === "hidden") return refused(facts, "not-applicable");
    if (availability.state !== "enabled") return refused(facts, availability.reason);
  }
  if (facts.unknownCommands.knowledge !== "known") return refused(facts, "state-unknown");
  const { entries } = facts.unknownCommands;
  if (confirmation.writer === "cleanup-unconfirmed")
    return {
      state: "pending",
      facts: advanced(facts, { managedWriter: "cleanup-unconfirmed" }),
      reason: "writer-unconfirmed",
    };
  const retired = entries.filter(({ side }) => side === "agentkib");
  return applied(
    facts,
    {
      ...observedTerminal(confirmation.observation),
      managedRecord: "returned",
      managedWriter: "absent",
      unknownCommands: {
        knowledge: "known",
        entries: entries.filter(({ side }) => side !== "agentkib"),
      },
    },
    settleReceipts(retired),
  );
}

/** Pure application of trusted observations. No process, transport, or input dispatch occurs here. */
export function transitionSessionState(
  facts: SessionStateFacts,
  event: SessionStateEvent,
): SessionStateTransitionResult {
  if (event.expectedRevision !== facts.revision) return refused(facts, "stale-revision");
  switch (event.kind) {
    case "terminal-resumed":
      return observeResume(facts, event);
    case "reconcile":
      return reconcile(facts, event);
    case "handback":
      return handback(facts, event);
    case "queue-cause-observed":
      if (facts.queue.state !== "paused" || facts.queue.reason !== event.reason)
        return refused(facts, "not-applicable");
      return applied(facts, { queue: resumeStaleQueue(observeQueueCause(facts.queue, event)) });
    case "resume-queue": {
      const availability = deriveSessionState(facts).controls.resumeQueue;
      if (availability.state === "hidden") return refused(facts, "not-applicable");
      return availability.state === "enabled"
        ? applied(facts, { queue: { state: "running" } })
        : refused(facts, availability.reason);
    }
  }
}
