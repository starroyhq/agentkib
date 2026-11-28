import {
  REMOTE_FEATURE_VERSIONS,
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

export interface SessionStateFacts {
  revision: number;
  execution: SessionStateExecution;
  /** The native turn observation, before any ledger-based write restrictions. */
  turn: SessionStateTurn;
  unknownCommands:
    | { knowledge: "known"; kinds: ReadonlySet<SessionUnknownCommandKind> }
    | { knowledge: "unknown" };
  role: SessionStateRole;
  read: SessionStateRead;
  reachability: "available" | "disconnected" | "unavailable" | "unknown";
  supported: ReadonlySet<SessionControl>;
  permitted: ReadonlySet<SessionControl>;
  /** Independent of native idle: a live writer may still be awaiting its send fence release. */
  sendPath: InputPath;
  stopPath: InputPath;
  workerEligibility: "eligible" | "ineligible" | "unknown";
  compacting: boolean;
  canActivate: boolean;
  canStageSettings: boolean;
  /** An available handover is an exclusive, explicitly supported path on this surface. */
  handover: "available" | "awaiting-owner" | "unavailable";
  /** Only verified paths available to this caller. A retry refreshes observations only. */
  recovery: {
    reconcile: ReadonlySet<ReceiptTarget>;
    reconnect: boolean;
    retry: boolean;
    approve: boolean;
    answer: boolean;
    turnUpdates: boolean;
    ownershipUpdates: boolean;
    inputPathUpdates: ReadonlySet<"send" | "stop">;
    receiptUpdates: ReadonlySet<ReceiptTarget>;
  };
}

type Blocker = { reason: SessionControlReason } & (
  | { recover?: "connection" | "observation" | "ownership" | "turn" }
  | { recover: "input-path"; control: "send" | "stop" }
  | { recover: "receipt"; targets: readonly ReceiptTarget[] }
);

/** An unresolved command fences only operations that could conflict with its effects. */
const fencedBy: Record<SessionControl, readonly SessionUnknownCommandKind[]> = {
  send: ["send", "takeover", "unclassified"],
  stop: ["stop", "takeover", "unclassified"],
  settings: ["settings", "takeover", "unclassified"],
  assign: ["send", "takeover", "unclassified"],
  takeover: ["send", "stop", "takeover", "unclassified"],
};

function controlBlocker(control: SessionControl, facts: SessionStateFacts): Blocker | undefined {
  if (!facts.supported.has(control)) return { reason: "unsupported" };
  if (!facts.permitted.has(control)) return { reason: "permission-denied" };
  const { owner } = facts.execution;
  const { phase, turnId } = facts.turn;

  if (facts.reachability === "unavailable") return { reason: "session-unavailable" };
  // These known states cannot be changed by recovering any original receipt.
  if (control === "stop" && phase === "idle") return { reason: "no-active-turn" };
  if (control === "assign" && facts.workerEligibility === "ineligible")
    return { reason: "worker-ineligible" };
  if (control === "takeover") {
    if (owner === "agentkib" && facts.execution.evidence !== "unknown")
      return { reason: "owned-by-agentkib" };
    if (facts.handover === "unavailable") return { reason: "handover-unavailable" };
  }
  if (facts.reachability === "disconnected" && control !== "takeover")
    return { reason: "connection-lost", recover: "connection" };
  const { unknownCommands } = facts;
  const targets: ReceiptTarget[] =
    unknownCommands.knowledge === "unknown"
      ? ["ledger"]
      : fencedBy[control].filter((kind) => unknownCommands.kinds.has(kind));
  if (phase === "outcome-unknown") {
    targets.push("turn");
    return { reason: "outcome-unknown", recover: "receipt", targets };
  }
  if (targets.length) {
    return {
      reason: unknownCommands.knowledge === "unknown" ? "state-unknown" : "command-outcome-unknown",
      recover: "receipt",
      targets,
    };
  }

  if (facts.reachability === "unknown") return { reason: "state-unknown", recover: "observation" };
  if (
    owner === "unknown" ||
    facts.execution.evidence === "unknown" ||
    phase === "unknown" ||
    (owner === "none" && phase !== "idle")
  )
    return { reason: "state-unknown", recover: "observation" };
  if (control === "takeover") {
    if (facts.handover === "awaiting-owner")
      return { reason: "handover-unavailable", recover: "ownership" };
  } else if (owner === "external" || owner === "native-app") {
    return { reason: "external-owner", recover: "ownership" };
  } else if (
    owner === "none" &&
    control !== "stop" &&
    (!facts.canActivate || control === "assign")
  ) {
    return { reason: "activation-required", recover: "ownership" };
  }

  if (control === "stop") {
    if (owner === "none") return { reason: "no-active-turn" };
    if (phase === "starting") return { reason: "turn-active", recover: "turn" };
    if (!turnId) return { reason: "state-unknown", recover: "observation" };
    if (facts.stopPath === "awaiting-ack")
      return { reason: "awaiting-stop-ack", recover: "input-path", control };
    return facts.stopPath === "ready"
      ? undefined
      : { reason: "stop-path-unavailable", recover: "observation" };
  }
  if (control === "assign") {
    if (facts.workerEligibility === "unknown")
      return { reason: "state-unknown", recover: "observation" };
    if (phase !== "starting") return;
  }
  if (facts.compacting && (control === "send" || control === "settings"))
    return { reason: "compacting", recover: "turn" };
  if (control === "send" && phase === "idle") {
    if (facts.sendPath === "awaiting-ack")
      return { reason: "awaiting-send-ack", recover: "input-path", control };
    if (facts.sendPath === "unavailable")
      return { reason: "send-path-unavailable", recover: "observation" };
  }
  if (
    control === "takeover" ||
    phase === "idle" ||
    (control === "settings" && phase === "running" && facts.canStageSettings)
  )
    return;

  return {
    reason: phase === "awaiting-approval" || phase === "awaiting-answer" ? phase : "turn-active",
    recover: "turn",
  };
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
  blocker: Blocker,
  facts: SessionStateFacts,
  allowed: (control: SessionControl) => boolean,
): SessionControlRecovery {
  const { recovery, turn } = facts;
  switch (blocker.recover) {
    case "connection":
      if (allowed("takeover")) return action("takeover");
      if (recovery.reconnect) return action("reconnect");
      if (recovery.ownershipUpdates) return automatic("ownership-change");
      break;
    case "observation":
      if (recovery.retry) return action("retry");
      if (recovery.turnUpdates) return automatic("turn-change");
      if (recovery.ownershipUpdates) return automatic("ownership-change");
      break;
    case "ownership":
      if (allowed("takeover")) return action("takeover");
      if (recovery.ownershipUpdates) return automatic("ownership-change");
      break;
    case "turn":
      if (turn.phase === "awaiting-approval" && turn.turnId && recovery.approve)
        return action("approve");
      if (turn.phase === "awaiting-answer" && turn.turnId && recovery.answer)
        return action("answer");
      if (allowed("stop")) return action("stop");
      if (recovery.turnUpdates) return automatic("turn-change");
      break;
    case "input-path":
      if (recovery.inputPathUpdates.has(blocker.control)) return automatic("control-readiness");
      break;
    case "receipt":
      if (
        blocker.targets.every(
          (target) => recovery.reconcile.has(target) || recovery.receiptUpdates.has(target),
        )
      )
        return blocker.targets.some((target) => recovery.reconcile.has(target))
          ? action("reconcile")
          : automatic("receipt-reconciled");
      break;
  }
  return { kind: "terminal" };
}

/** Derive one state for every session surface from the same scoped, normalized facts. */
export function deriveSessionState(facts: SessionStateFacts): SessionState {
  const blockers = {
    send: controlBlocker("send", facts),
    stop: controlBlocker("stop", facts),
    settings: controlBlocker("settings", facts),
    assign: controlBlocker("assign", facts),
    takeover: controlBlocker("takeover", facts),
  };
  const allowed = (control: SessionControl) => blockers[control] === undefined;
  const control = (key: SessionControl): SessionControlAvailability => {
    const blocker = blockers[key];
    return blocker
      ? {
          state: "disabled",
          reason: blocker.reason,
          recovery: recoveryFor(blocker, facts, allowed),
        }
      : { state: "enabled" };
  };
  const { unknownCommands, execution } = facts;
  return {
    version: REMOTE_FEATURE_VERSIONS.sessionStateVersion,
    revision: facts.revision,
    execution:
      execution.owner === "unknown" || execution.evidence === "unknown"
        ? { owner: "unknown", evidence: "unknown" }
        : { owner: execution.owner, evidence: execution.evidence },
    turn: { phase: facts.turn.phase, turnId: facts.turn.turnId },
    unknownCommands: {
      knowledge: unknownCommands.knowledge,
      kinds: unknownCommands.knowledge === "known" ? [...unknownCommands.kinds].sort() : [],
    },
    controls: {
      send: control("send"),
      stop: control("stop"),
      settings: control("settings"),
      assign: control("assign"),
      takeover: control("takeover"),
    },
    role:
      facts.role.kind === "worker"
        ? { kind: "worker", leadId: facts.role.leadId }
        : { kind: facts.role.kind },
    read: {
      status: facts.read.status,
      canAcknowledge: facts.read.status === "unread" && facts.read.canAcknowledge,
    },
  };
}
