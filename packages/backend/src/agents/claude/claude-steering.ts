import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { ClaudeProtocolError } from "./claude-frame-policy";

export const CLAUDE_STEERING_START_TIMEOUT_MS = 30_000;

type SteeringFrame = { user_message_uuid?: unknown; user_message_uuids?: unknown };

export type ClaudeSteeringSnapshot = {
  pendingSteeringIds?: string[];
  steeringRecovery?: { version: 1; inputIds: string[] };
};

export function projectClaudeSteeringRecovery(live: Record<string, unknown>): void {
  // The displayed reason changes once an explicit check can be attempted, prompting a capability read.
  if (live.steeringRecovery) live.reason = REMOTE_ERROR_CODES.controlOutcomeUnconfirmed;
  delete live.pendingSteeringIds;
  delete live.steeringRecovery;
}

/** Only loss of attribution for already sent inputs may be recovered after confirmed cleanup. */
export class ClaudeSteeringVerificationError extends ClaudeProtocolError {
  constructor(message: string) {
    super("claude-unrequested-turn", message);
  }
}

function knownSteeringIds(frame: SteeringFrame, expected: ReadonlySet<string>): string[] | null {
  const primary = frame.user_message_uuid;
  const ids = frame.user_message_uuids ?? (primary == null ? [] : [primary]);
  if (
    !Array.isArray(ids) ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== "string" || !expected.has(id)) ||
    (primary != null && !ids.includes(primary))
  )
    return null;
  return ids;
}

/** Native input IDs remain distinct even if Claude handles them in the same model turn. */
export class ClaudeSteeringInputs {
  readonly pending = new Set<string>();
  readonly started = new Set<string>();
  #cleanupConfirmed = false;

  snapshot(): ClaudeSteeringSnapshot {
    const pendingSteeringIds = [...this.pending, ...this.started];
    if (!pendingSteeringIds.length) return {};
    return {
      pendingSteeringIds,
      ...(this.#cleanupConfirmed
        ? { steeringRecovery: { version: 1, inputIds: pendingSteeringIds } }
        : {}),
    };
  }

  clear(): void {
    this.pending.clear();
    this.started.clear();
    this.#cleanupConfirmed = false;
  }

  confirmCleanup(): void {
    this.#cleanupConfirmed = true;
  }

  missingStart(
    frame: SteeringFrame & { type?: unknown; event?: { type?: unknown } },
    completedOpener: boolean,
  ): boolean {
    return (
      completedOpener &&
      this.started.size === 0 &&
      frame.type === "stream_event" &&
      frame.event?.type === "message_start" &&
      !!knownSteeringIds(frame, this.pending)?.length
    );
  }

  result(frame: SteeringFrame, hostTurnId: string | undefined): { steeringIds?: string[] } {
    if (!this.started.size) return {};
    const expected = new Set(this.started);
    // A CLI-originated turn has no host input UUID on the wire.
    if (hostTurnId) expected.add(hostTurnId);
    const ids = knownSteeringIds(frame, expected);
    if (!ids || (frame.user_message_uuids === null && ids.length !== expected.size))
      throw new ClaudeProtocolError(
        "claude-unrequested-turn",
        "Claude steering result omitted or changed inputs",
      );
    if (ids.length !== expected.size)
      throw new ClaudeSteeringVerificationError("Claude steering result omitted or changed inputs");

    const steeringIds = [...this.started].filter((id) => id !== hostTurnId);
    this.started.clear();
    return steeringIds.length ? { steeringIds } : {};
  }
}

/** A deadline can mark missing native evidence as uncertain, never as a completed turn. */
export class ClaudeSteeringDeadline {
  #timer?: NodeJS.Timeout;

  watch(waiting: boolean, onTimeout: () => void): void {
    if (!waiting) this.clear();
    else this.#timer ??= setTimeout(onTimeout, CLAUDE_STEERING_START_TIMEOUT_MS);
  }

  clear(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
