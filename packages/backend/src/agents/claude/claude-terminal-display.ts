import { isDeepStrictEqual } from "node:util";
import type { ClaudeBridgeIdentity, ClaudeBridgeSnapshot } from "@agentkib/runtime-protocol";
import { readClaudeTerminalTurnEvidence } from "./claude-terminal-turn-evidence";

export function unchangedTerminalSnapshot(
  previous: ClaudeBridgeSnapshot | null,
  incoming: ClaudeBridgeSnapshot,
): boolean {
  return isDeepStrictEqual(previous, {
    ...incoming,
    usage: incoming.usage && { ...incoming.usage, observedAt: previous?.usage?.observedAt },
  });
}

type Lease = {
  identity: ClaudeBridgeIdentity;
  leaseId: string;
  snapshot: ClaudeBridgeSnapshot | null;
  gap: boolean;
};

type ObservedTurn = NonNullable<Awaited<ReturnType<typeof readClaudeTerminalTurnEvidence>>> & {
  turnId: string;
  current: boolean;
};

function activeTurn(lease: Lease) {
  const snapshot = lease.snapshot;
  return !lease.gap && snapshot?.status === "running" && !snapshot.compacting && !snapshot.waiting
    ? snapshot.currentTurnId
    : null;
}

/** Native history can settle the display while the terminal is still delivering its completion. */
export class ClaudeTerminalDisplay {
  #observed = new WeakMap<Lease, ObservedTurn>();
  #reading = new WeakMap<Lease, Promise<void>>();

  async observe(
    lease: Lease | undefined,
    verifiedTranscript: () => string | void,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!lease || !isCurrent()) return;
    const turnId = activeTurn(lease);
    if (!turnId) return;
    const pending = this.#reading.get(lease);
    if (pending) return pending;
    const reading = this.#read(lease, turnId, verifiedTranscript, isCurrent);
    this.#reading.set(lease, reading);
    try {
      await reading;
    } finally {
      this.#reading.delete(lease);
    }
  }

  async #read(
    lease: Lease,
    turnId: string,
    verifiedTranscript: () => string | void,
    isCurrent: () => boolean,
  ) {
    let evidence: Awaited<ReturnType<typeof readClaudeTerminalTurnEvidence>>;
    try {
      const transcript = verifiedTranscript();
      if (transcript)
        evidence = await readClaudeTerminalTurnEvidence(transcript, lease.identity.nativeId);
    } catch {
      // Ignore observation errors. Bridge events can still settle the turn.
    }
    if (!isCurrent() || activeTurn(lease) !== turnId) return;
    const previous = this.#observed.get(lease);
    // Native completion fallback requires the same file and the prompt
    // that was witnessed open under this live turn. Their UUIDs differ.
    const samePrompt =
      evidence?.promptId === previous?.promptId &&
      evidence?.transcriptIdentity === previous?.transcriptIdentity;
    const sameTurn = previous?.turnId === turnId;
    if (
      evidence &&
      ((sameTurn && samePrompt) || (!evidence.completed && !sameTurn && !samePrompt))
    ) {
      this.#observed.set(lease, { ...evidence, turnId, current: true });
    } else if (previous?.current) {
      // Keep the start witness so a newer hook can't claim the older prompt
      // while we wait for its new prompt to appear on disk.
      this.#observed.set(lease, { ...previous, completed: false, current: false });
    }
  }

  live(lease: Lease | undefined, live: Record<string, unknown>): Record<string, unknown> {
    const observed =
      lease &&
      !lease.gap &&
      live.connectionGeneration === lease.leaseId &&
      lease.snapshot?.currentTurnId === live.turnId
        ? this.#observed.get(lease)
        : undefined;
    const proof = observed?.current && observed.turnId === live.turnId ? observed : undefined;
    if (
      live.status !== "running" ||
      !lease ||
      !proof?.completed ||
      proof.turnId !== activeTurn(lease)
    )
      return { ...live, transcriptTurnId: proof?.promptId ?? null };
    // The plugin still owns writing, receipts and Worker completion.
    return {
      ...live,
      status: "idle",
      reason: "claude-follower-send-unverified",
      turnId: null,
      transcriptTurnId: null,
      streamText: "",
      sendEnabled: false,
      steerEnabled: false,
      stopEnabled: false,
    };
  }
}
