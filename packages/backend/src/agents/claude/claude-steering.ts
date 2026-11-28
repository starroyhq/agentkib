import { ClaudeProtocolError } from "./claude-frame-policy";

export const CLAUDE_STEERING_START_TIMEOUT_MS = 30_000;

/** Native input IDs remain distinct even if Claude handles them in the same model turn. */
export class ClaudeSteeringInputs {
  readonly pending = new Set<string>();
  readonly started = new Set<string>();

  snapshot(): { pendingSteeringIds?: string[] } {
    const pendingSteeringIds = [...this.pending, ...this.started];
    return pendingSteeringIds.length ? { pendingSteeringIds } : {};
  }

  clear(): void {
    this.pending.clear();
    this.started.clear();
  }

  result(
    frame: { user_message_uuid?: unknown; user_message_uuids?: unknown },
    hostTurnId: string | undefined,
  ): { steeringIds?: string[] } {
    if (!this.started.size) return {};
    const expected = new Set(this.started);
    // A CLI-originated turn has no host input UUID on the wire.
    if (hostTurnId) expected.add(hostTurnId);
    const ids = frame.user_message_uuids ?? [frame.user_message_uuid];
    if (
      !Array.isArray(ids) ||
      ids.length !== expected.size ||
      new Set(ids).size !== expected.size ||
      ids.some((id) => typeof id !== "string" || !expected.has(id)) ||
      (frame.user_message_uuid != null &&
        (typeof frame.user_message_uuid !== "string" || !expected.has(frame.user_message_uuid)))
    )
      throw new ClaudeProtocolError(
        "claude-unrequested-turn",
        "Claude steering result omitted or changed inputs",
      );

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
