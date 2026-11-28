import {
  REMOTE_ERROR_CODES,
  REMOTE_FEATURE_VERSIONS,
  type ProjectAgentRoleAvailability,
  type ProjectAgentRoleReason,
  type SessionControlAvailability,
  type SessionControlReason,
  type SessionControlRecovery,
  type SessionRecoveryAction,
  type SessionRecoverySignal,
  type SessionState,
  type SessionStateControls,
  type SessionStateExecution,
  type SessionStateRead,
  type SessionStateRole,
  type SessionStateTurn,
  type SessionUnknownCommandKind,
} from "@agentkib/runtime-protocol";

export type SessionControl = keyof SessionStateControls;
type ReceiptTarget = SessionUnknownCommandKind | "turn" | "ledger";
type InputPath = "ready" | "awaiting-ack" | "unavailable";
type QueuePauseReason = NonNullable<SessionState["queue"]["reason"]>;

export type SessionPendingCommand = {
  requestId: string;
  side: "agentkib" | "terminal" | "unknown";
  phase: "prepared" | "dispatched";
} & (
  | { kind: "lease"; direction: "takeover" | "handback" }
  | { kind: Exclude<SessionUnknownCommandKind, "lease"> }
);
type LeaseCommand = Extract<SessionPendingCommand, { kind: "lease" }>;

type MappedCommandKind = Exclude<SessionUnknownCommandKind, "lease" | "unclassified">;
const commandOperations: Record<MappedCommandKind, readonly string[]> = {
  send: ["create", "send", "resume", "compact", "usage-limit-continue"],
  steer: ["steer", "queue-steer"],
  stop: ["stop", "worker-restart"],
  settings: ["settings", "open-model-picker"],
  report: ["orchestration-report", "report"],
  interaction: ["approve", "answer"],
  other: [
    "rename",
    "fork",
    "archive",
    "unarchive",
    "goal-set",
    "goal-pause",
    "goal-resume",
    "goal-clear",
    "queue-update",
    "queue-reorder",
    "queue-pause",
    "queue-resume",
    "usage-limit-cancel",
    "reconcile",
  ],
};
const commandKinds = new Map(
  Object.entries(commandOperations).flatMap(([kind, operations]) =>
    operations.map((operation) => [operation, kind as MappedCommandKind] as const),
  ),
);

export function classifySessionCommand(
  operation: unknown,
  scope: Pick<SessionPendingCommand, "side" | "requestId" | "phase">,
): SessionPendingCommand {
  if (
    operation === "adopt-terminal" ||
    operation === "handover-terminal" ||
    operation === "release"
  )
    return {
      ...scope,
      kind: "lease",
      direction: operation === "release" ? "handback" : "takeover",
    };
  if (scope.side === "terminal" && (operation === "queue-add" || operation === "queue-delete"))
    return { ...scope, kind: "steer" };
  const kind = typeof operation === "string" ? commandKinds.get(operation) : undefined;
  return { ...scope, kind: kind ?? "unclassified" };
}

export interface SessionStateFacts {
  revision: number;
  execution:
    | SessionStateExecution
    | { owner: "native-app"; evidence: SessionStateExecution["evidence"] };
  managedRecord: "none" | "held" | "returned" | "invalid";
  managedWriter: "absent" | "starting" | "live" | "retiring" | "cleanup-unconfirmed";
  terminalConnection: "none" | "live" | "gap";
  terminalBinding: "none" | "retained" | "revoked";
  surface: "desktop" | "remote";
  /** Native turn evidence, before projecting ownership or receipt fences. */
  turn: SessionStateTurn;
  unknownCommands:
    | { knowledge: "known"; entries: readonly SessionPendingCommand[] }
    | { knowledge: "unknown" };
  queue:
    | { state: "running" | "unknown" }
    | { state: "paused"; reason: QueuePauseReason; cause: "present" | "absent" | "unknown" };
  role: SessionStateRole;
  projectAgentToolsReady: boolean | null;
  read: SessionStateRead;
  reachability: "available" | "disconnected" | "unavailable" | "unknown";
  unavailableDetail?: ProjectAgentRoleReason;
  supported: ReadonlySet<SessionControl>;
  permitted: ReadonlySet<SessionControl>;
  sendPath: InputPath;
  stopPath: InputPath;
  /** Session-local result from PA-5. The selected lead and final assignment are checked separately. */
  workerEligibility: ProjectAgentRoleAvailability | { available: null };
  reportRequestId?: string;
  compacting: boolean;
  canActivate: boolean;
  canStageSettings: boolean;
  terminalModelPicker: boolean;
  /** The policy is enabled and the requester is a verified new terminal instance. */
  automaticHandback: boolean;
  handover: "available" | "awaiting-owner" | "unavailable" | "wrong-workspace";
  recovery: {
    automaticReconcile: boolean;
    reconnect: boolean;
    turnUpdates: boolean;
    ownershipUpdates: boolean;
    leaseUpdates: boolean;
    connectionUpdates: boolean;
    queueUpdates: boolean;
    canEndProcess: boolean;
    canFork: boolean;
    canRestartWorker: boolean;
    inputPathUpdates: ReadonlySet<"send" | "stop">;
    receiptUpdates: ReadonlySet<ReceiptTarget>;
  };
}

const globalFences = ["lease", "unclassified"] as const;
const fencedBy: Record<SessionControl, readonly SessionUnknownCommandKind[]> = {
  send: ["send", "steer", ...globalFences],
  steer: globalFences,
  queue: globalFences,
  stop: ["stop", ...globalFences],
  settings: ["settings", ...globalFences],
  assign: ["send", "steer", "stop", ...globalFences],
  takeover: ["send", "steer", "report", "interaction", ...globalFences],
  handback: globalFences,
  reconcile: [],
  resumeQueue: globalFences,
  report: ["send", "report", ...globalFences],
  approve: ["interaction", ...globalFences],
  answer: ["interaction", ...globalFences],
};

const terminalReasons = new Set<SessionControlReason>([
  "permission-denied",
  "not-applicable",
  "no-active-turn",
  "owned-by-agentkib",
  "worker-ineligible",
  "session-unavailable",
  "handover-workspace-mismatch",
]);

function observation(facts: SessionStateFacts): SessionStateExecution {
  const { owner, evidence } = facts.execution;
  const { managedRecord, managedWriter, terminalConnection } = facts;
  if (
    managedRecord === "invalid" ||
    evidence === "unknown" ||
    owner === "unknown" ||
    (managedRecord !== "held" && (owner === "agentkib" || managedWriter !== "absent"))
  )
    return { owner: "unknown", evidence: "unknown" };
  if (terminalConnection !== "none") return { owner: "terminal", evidence };
  if (owner === "terminal" || owner === "native-app") return { owner: "external", evidence };
  if (owner === "none" && managedRecord === "held") return { owner: "agentkib", evidence };
  return { owner, evidence };
}

export function sessionStateWritersAbsent(facts: SessionStateFacts): boolean {
  const execution = observation(facts);
  return (
    facts.reachability === "available" &&
    (execution.owner === "none" || execution.owner === "agentkib") &&
    execution.evidence === "live" &&
    facts.managedWriter === "absent"
  );
}

function leaseFor(
  facts: SessionStateFacts,
  execution: SessionStateExecution,
  entries: readonly SessionPendingCommand[],
): SessionState["lease"] {
  const pending =
    entries.find(
      (entry): entry is LeaseCommand => entry.kind === "lease" && entry.direction === "handback",
    ) ?? entries.find((entry) => entry.kind === "lease");
  if (pending)
    return {
      state: "pending",
      reason: pending.direction === "takeover" ? "takeover-unconfirmed" : "handback-unconfirmed",
    };
  if (facts.managedWriter === "cleanup-unconfirmed")
    return { state: "pending", reason: "writer-unconfirmed" };
  if (facts.managedRecord === "held") {
    if (execution.owner === "external" || execution.owner === "terminal")
      return { state: "pending", reason: "contested" };
    return { state: "held", reason: null };
  }
  return { state: facts.managedRecord === "returned" ? "returned" : "none", reason: null };
}

function isTurnActive(phase: SessionStateTurn["phase"]): boolean {
  return phase === "running" || phase === "awaiting-approval" || phase === "awaiting-answer";
}

function turnFor(facts: SessionStateFacts, execution: SessionStateExecution): SessionStateTurn {
  const { owner } = execution;
  const { phase, turnId, cause } = facts.turn;
  if (owner === "unknown" || owner === "external" || phase === "unknown")
    return { phase: "unknown", turnId: null, cause: null };
  if (facts.managedWriter === "cleanup-unconfirmed" && owner === "agentkib")
    return { phase: "outcome-unknown", turnId, cause: "writer-unconfirmed" };
  if (phase === "outcome-unknown")
    return {
      phase,
      turnId,
      cause: owner === "terminal" ? "terminal-unconfirmed" : (cause ?? "runner-lost"),
    };
  if (
    (owner === "none" || (owner === "agentkib" && facts.managedWriter === "absent")) &&
    phase !== "idle"
  )
    return { phase: "outcome-unknown", turnId, cause: "runner-lost" };
  if (owner === "terminal" && phase === "starting")
    return { phase: "unknown", turnId: null, cause: null };
  return { phase, turnId, cause: null };
}

function queueFor(queue: SessionStateFacts["queue"]): SessionState["queue"] {
  if (queue.state !== "paused") return { state: queue.state, reason: null };
  if (queue.reason === "user-paused" || queue.cause === "present")
    return { state: "paused", reason: queue.reason };
  return { state: queue.cause === "absent" ? "running" : "unknown", reason: null };
}

type Context = {
  execution: SessionStateExecution;
  lease: SessionState["lease"];
  turn: SessionStateTurn;
  queue: SessionState["queue"];
  entries: readonly SessionPendingCommand[];
  writersAbsent: boolean;
};
type Blocker = {
  reason: SessionControlReason;
  detail?: ProjectAgentRoleReason;
  targets?: ReceiptTarget[];
};
const blocked = (reason: SessionControlReason, detail?: ProjectAgentRoleReason): Blocker => ({
  reason,
  ...(detail === undefined ? {} : { detail }),
});

function stopBlocker(facts: SessionStateFacts, turn: SessionStateTurn): Blocker | undefined {
  if (turn.phase === "starting") return blocked("turn-active");
  if (!isTurnActive(turn.phase)) return blocked("no-active-turn");
  if (!turn.turnId) return blocked("state-unknown");
  if (facts.stopPath === "awaiting-ack") return blocked("awaiting-stop-ack");
  if (facts.stopPath === "unavailable") return blocked("stop-path-unavailable");
}

/** The scheduler and the published recovery signal use the same admission rules. */
export function automaticSessionHandbackBlocker(
  facts: SessionStateFacts,
): SessionControlReason | "native-input-unconfirmed" | undefined {
  if (
    !facts.automaticHandback ||
    !facts.supported.has("handback") ||
    facts.managedRecord !== "held"
  )
    return "not-applicable";
  if (!facts.permitted.has("handback")) return "permission-denied";
  const { owner, evidence } = observation(facts);
  if (
    facts.reachability !== "available" ||
    evidence !== "live" ||
    (owner !== "external" && (owner !== "terminal" || facts.terminalConnection !== "live")) ||
    facts.unknownCommands.knowledge !== "known"
  )
    return "state-unknown";
  const { entries } = facts.unknownCommands;
  if (entries.some(({ kind }) => kind === "lease")) return "lease-pending";
  if (entries.some(({ kind }) => kind === "unclassified")) return "command-outcome-unknown";
  if (
    facts.turn.phase === "idle" &&
    entries.some(
      ({ kind, side, phase }) =>
        side !== "terminal" && phase === "dispatched" && (kind === "send" || kind === "steer"),
    )
  )
    return "native-input-unconfirmed";
}

function workerBlocker(facts: SessionStateFacts): Blocker | undefined {
  const codes = REMOTE_ERROR_CODES;
  if (facts.role.kind === "lead") return blocked("worker-ineligible", codes.sessionIsAProjectAgent);
  if (facts.role.kind === "worker") return blocked("worker-ineligible", codes.sessionIsAWorker);
  if (facts.role.kind === "unknown" || facts.workerEligibility.available === null)
    return blocked("state-unknown");
  if (facts.workerEligibility.available) return;
  const detail = facts.workerEligibility.reason;
  switch (detail) {
    case codes.sessionIsAProjectAgent:
    case codes.sessionIsAWorker:
      return blocked("worker-ineligible", detail);
    case codes.workerAgentUnsupported:
      return blocked("not-applicable", detail);
    case codes.sessionWorkspaceUnavailable:
    case codes.dshVersionUnsupported:
    case codes.antigravityAcpDisabled:
      return blocked("session-unavailable", detail);
    case codes.sessionBusy:
      return blocked("turn-active", detail);
    case codes.workerTerminalDisconnected:
      return blocked("connection-lost", detail);
    case codes.controlOutcomeUnconfirmed:
      return { ...blocked("outcome-unknown", detail), targets: ["turn"] };
    default:
      return blocked("state-unknown", detail);
  }
}

function stateBlocker(
  control: SessionControl,
  facts: SessionStateFacts,
  ctx: Context,
): Blocker | undefined {
  const {
    execution: { owner },
    lease,
    turn,
    queue,
    entries,
    writersAbsent,
  } = ctx;
  const active = isTurnActive(turn.phase);
  if (facts.reachability === "unavailable")
    return blocked("session-unavailable", facts.unavailableDetail);
  if (
    facts.reachability === "unknown" ||
    owner === "unknown" ||
    facts.unknownCommands.knowledge === "unknown"
  )
    return blocked("state-unknown");
  if (control === "reconcile") {
    const needed =
      turn.phase === "outcome-unknown" ||
      entries.length > 0 ||
      (facts.queue.state === "paused" &&
        facts.queue.reason !== "user-paused" &&
        facts.queue.cause === "absent");
    if (!needed) return blocked("not-applicable");
    if (writersAbsent) return;
    if (lease.reason === "writer-unconfirmed") return blocked("writer-unconfirmed");
    if (lease.reason === "contested") return blocked("lease-contested");
    if (owner === "external") return blocked("external-owner");
    if (owner === "terminal" && facts.terminalConnection === "gap")
      return blocked("connection-lost");
    return {
      reason: "outcome-unknown",
      targets: [
        ...entries.map((entry) => entry.kind),
        ...(turn.phase === "outcome-unknown" ? ["turn" as const] : []),
      ],
    };
  }
  if (lease.reason === "takeover-unconfirmed" || lease.reason === "handback-unconfirmed")
    return blocked("lease-pending");
  if (lease.reason === "writer-unconfirmed")
    return blocked(control === "takeover" ? "owned-by-agentkib" : "writer-unconfirmed");
  if (control === "takeover") {
    if (facts.managedRecord === "held") return blocked("owned-by-agentkib");
    if (facts.handover === "wrong-workspace") return blocked("handover-workspace-mismatch");
  }
  if (control === "handback") {
    if (facts.managedRecord !== "held") return blocked("not-applicable");
    if (facts.managedWriter === "starting" || facts.managedWriter === "retiring")
      return blocked("turn-active");
    if (facts.managedWriter === "live" && facts.turn.phase !== "idle")
      return blocked("turn-active");
  } else if (control !== "resumeQueue" && lease.reason === "contested") {
    if (control !== "stop" || facts.managedWriter !== "live") return blocked("lease-contested");
  } else if (
    control !== "resumeQueue" &&
    (owner === "external" ||
      facts.reachability === "disconnected" ||
      facts.terminalConnection === "gap")
  ) {
    return blocked(
      facts.terminalBinding === "retained" ||
        facts.terminalConnection === "gap" ||
        facts.reachability === "disconnected"
        ? "connection-lost"
        : "external-owner",
    );
  }

  const fences =
    writersAbsent && control !== "handback"
      ? []
      : entries.filter(
          (entry) =>
            fencedBy[control].includes(entry.kind) &&
            (entry.kind !== "report" ||
              control !== "report" ||
              entry.requestId === facts.reportRequestId) &&
            (entry.kind !== "steer" || control !== "send" || !active),
        );
  if (control === "takeover") {
    if (turn.phase === "outcome-unknown" && owner !== "terminal") return blocked("outcome-unknown");
    if (facts.handover !== "available" && !(owner === "none" && facts.canActivate))
      return blocked("handover-unavailable");
  }
  const worker = control === "assign" ? workerBlocker(facts) : undefined;
  if (worker) return worker;
  if (owner === "terminal" && control === "settings") return blocked("terminal-settings");
  if (fences.length)
    return { reason: "command-outcome-unknown", targets: fences.map((entry) => entry.kind) };

  if (control === "handback" || control === "takeover") return;
  if (control === "resumeQueue") {
    if (queue.state === "unknown") return blocked("state-unknown");
    return queue.state === "paused" ? undefined : blocked("not-applicable");
  }
  if (turn.phase === "outcome-unknown")
    return control === "stop" && owner !== "terminal"
      ? blocked("no-active-turn")
      : { reason: "outcome-unknown", targets: ["turn"] };
  if (lease.reason === "contested" && control === "stop") return stopBlocker(facts, facts.turn);
  if (turn.phase === "unknown") return blocked("state-unknown");
  if (control === "stop") return stopBlocker(facts, turn);
  if (control === "approve" || control === "answer") {
    const waiting = control === "approve" ? "awaiting-approval" : "awaiting-answer";
    return owner === "agentkib" && turn.phase === waiting && turn.turnId
      ? undefined
      : blocked("not-applicable");
  }
  if (control === "report" && queue.state !== "running")
    return blocked(queue.state === "paused" ? "queue-paused" : "state-unknown");
  if (owner === "none" && (control === "assign" || !facts.canActivate))
    return blocked("activation-required");
  const turnReason =
    turn.phase === "awaiting-approval" || turn.phase === "awaiting-answer"
      ? turn.phase
      : "turn-active";
  if (turn.phase === "starting") return blocked("turn-active");
  if (control === "send" || (control === "assign" && owner === "terminal")) {
    if (control === "send" && active) return blocked(facts.compacting ? "compacting" : turnReason);
    if (facts.sendPath === "awaiting-ack") return blocked("awaiting-send-ack");
    if (facts.sendPath === "unavailable") return blocked("send-path-unavailable");
  }
  if (control === "steer" || control === "queue")
    return facts.compacting
      ? blocked("compacting")
      : active
        ? undefined
        : blocked("not-applicable");
  if (control === "settings")
    return facts.compacting
      ? blocked("compacting")
      : active && !facts.canStageSettings
        ? blocked(turnReason)
        : undefined;
}

const action = (action: SessionRecoveryAction): SessionControlRecovery => ({
  kind: "action",
  action,
});
const automatic = (signal: SessionRecoverySignal): SessionControlRecovery => ({
  kind: "automatic",
  signal,
});

function recoveryFor(
  control: SessionControl,
  blocker: Blocker,
  facts: SessionStateFacts,
  ctx: Context,
  allowed: (control: SessionControl) => boolean,
): SessionControlRecovery | undefined {
  const hints = facts.recovery;
  switch (blocker.reason) {
    case "state-unknown":
      return action("retry");
    case "lease-pending":
      if (allowed("reconcile"))
        return hints.automaticReconcile ? automatic("receipt-reconciled") : action("reconcile");
      if (hints.leaseUpdates) return automatic("lease-change");
      break;
    case "lease-contested":
      if (ctx.lease.reason === "contested" && !automaticSessionHandbackBlocker(facts))
        return automatic("lease-change");
      if (allowed("handback")) return action("handback");
      break;
    case "writer-unconfirmed":
      if (hints.canEndProcess) return action("end-process");
      if (hints.canFork) return action("fork");
      return action("retry");
    case "connection-lost":
      if (facts.surface === "desktop" && hints.reconnect) return action("reconnect");
      if (hints.connectionUpdates) return automatic("connection-change");
      if (hints.ownershipUpdates) return automatic("ownership-change");
      break;
    case "external-owner":
      if (facts.surface === "desktop" && hints.reconnect) return action("reconnect");
      if (hints.ownershipUpdates) return automatic("ownership-change");
      break;
    case "handover-unavailable":
      if (facts.handover === "awaiting-owner" && hints.ownershipUpdates)
        return automatic("ownership-change");
      break;
    case "terminal-settings":
      if (
        facts.surface === "desktop" &&
        facts.terminalConnection === "live" &&
        facts.terminalModelPicker
      )
        return action("open-model-picker");
      if (allowed("takeover")) return action("takeover");
      break;
    case "activation-required":
    case "send-path-unavailable":
      if (allowed("takeover")) return action("takeover");
      if (blocker.reason !== "activation-required" && hints.inputPathUpdates.has("send"))
        return automatic("control-readiness");
      break;
    case "awaiting-send-ack":
    case "awaiting-stop-ack":
    case "stop-path-unavailable":
      if (hints.inputPathUpdates.has(blocker.reason === "awaiting-send-ack" ? "send" : "stop"))
        return automatic("control-readiness");
      break;
    case "awaiting-approval":
    case "awaiting-answer":
    case "turn-active":
    case "compacting":
      if (blocker.reason === "awaiting-approval" && allowed("approve")) return action("approve");
      if (blocker.reason === "awaiting-answer" && allowed("answer")) return action("answer");
      if (ctx.execution.owner === "terminal" && allowed("takeover")) return action("takeover");
      if (control === "send") {
        if (allowed("steer")) return action("steer");
        if (allowed("queue")) return action("queue");
      }
      if (allowed("stop")) return action("stop");
      if (hints.turnUpdates) return automatic("turn-change");
      break;
    case "outcome-unknown":
    case "command-outcome-unknown":
      if (allowed("reconcile"))
        return hints.automaticReconcile ? automatic("receipt-reconciled") : action("reconcile");
      if (
        blocker.targets?.length &&
        blocker.targets.every((kind) => hints.receiptUpdates.has(kind))
      )
        return automatic("receipt-reconciled");
      if (ctx.execution.owner === "terminal" && allowed("takeover")) return action("takeover");
      if (allowed("stop")) return action("stop");
      if (facts.role.kind === "worker" && hints.canRestartWorker) return action("restart-worker");
      if (allowed("handback")) return action("handback");
      break;
    case "queue-paused":
      if (
        facts.queue.state === "paused" &&
        facts.queue.reason === "user-paused" &&
        allowed("resumeQueue")
      )
        return action("resume-queue");
      if (hints.queueUpdates) return automatic("queue-change");
      break;
  }
  if (terminalReasons.has(blocker.reason)) return { kind: "terminal" };
}

export function deriveSessionStateWithDiagnostics(facts: SessionStateFacts) {
  const execution = observation(facts);
  const entries = facts.unknownCommands.knowledge === "known" ? facts.unknownCommands.entries : [];
  const ctx: Context = {
    execution,
    lease: leaseFor(facts, execution, entries),
    turn: turnFor(facts, execution),
    queue: queueFor(facts.queue),
    entries,
    writersAbsent: sessionStateWritersAbsent(facts),
  };
  const keys = Object.keys(fencedBy) as SessionControl[];
  const visible = (key: SessionControl) =>
    facts.supported.has(key) && !(facts.surface === "remote" && key === "handback");
  const blockers = new Map<SessionControl, Blocker>();
  for (const key of keys) {
    if (!visible(key)) continue;
    const blocker = facts.permitted.has(key)
      ? stateBlocker(key, facts, ctx)
      : blocked("permission-denied");
    if (blocker) blockers.set(key, blocker);
  }
  const allowed = (key: SessionControl) => visible(key) && !blockers.has(key);
  const missingRecovery: Array<{ control: SessionControl; reason: SessionControlReason }> = [];
  const controls = Object.fromEntries(
    keys.map((key): [SessionControl, SessionControlAvailability] => {
      if (!visible(key)) return [key, { state: "hidden" }];
      const blocker = blockers.get(key);
      if (!blocker) return [key, { state: "enabled" }];
      const { reason, detail } = blocker;
      const recovery = recoveryFor(key, blocker, facts, ctx, allowed);
      if (!recovery) missingRecovery.push({ control: key, reason });
      return [
        key,
        {
          state: "disabled",
          reason,
          ...(detail === undefined ? {} : { detail }),
          recovery: recovery ?? action("retry"),
        },
      ];
    }),
  ) as SessionStateControls;
  const modelEntry =
    execution.owner === "agentkib" || (execution.owner === "none" && facts.canActivate)
      ? "agentkib"
      : execution.owner === "terminal" &&
          facts.terminalConnection === "live" &&
          facts.terminalModelPicker &&
          facts.surface === "desktop"
        ? "terminal"
        : "display-only";

  const state: SessionState = {
    version: REMOTE_FEATURE_VERSIONS.sessionStateVersion,
    revision: facts.revision,
    execution,
    lease: ctx.lease,
    turn: ctx.turn,
    queue: ctx.queue,
    modelEntry,
    unknownCommands: {
      knowledge: facts.unknownCommands.knowledge,
      kinds: [...new Set(entries.map((entry) => entry.kind))].sort(),
    },
    controls,
    role: facts.role,
    projectAgentToolsReady: facts.projectAgentToolsReady,
    read: {
      status: facts.read.status,
      canAcknowledge: facts.read.status === "unread" && facts.read.canAcknowledge,
    },
  };
  return { state, missingRecovery };
}

/** Derive one state for every surface from the same scoped facts. */
export function deriveSessionState(facts: SessionStateFacts): SessionState {
  return deriveSessionStateWithDiagnostics(facts).state;
}
