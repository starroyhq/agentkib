import type { EndedTurn } from "./codex-external-turns";
import type { ManagedCodexEventBridge } from "./managed-codex-event-bridge";

const QUIET_MS = 20_000;

type QuietWorker = {
  turnId: string;
  progress: string;
  nextCheck: number;
  checking?: Promise<void>;
};
const quietWorkers = new WeakMap<ManagedCodexEventBridge, QuietWorker>();

/** Verify a native terminal record through the bounded rollout reader. */
export async function verifyCodexWorkerCompletion(
  bridge: ManagedCodexEventBridge,
  current: () => boolean,
  endedTurns: (nativeId: string) => Promise<EndedTurn[]>,
): Promise<void> {
  const { nativeId, turnId } = bridge.state;
  if (!bridge.session.connected || !nativeId || !turnId || !current()) return;
  const ended = (await endedTurns(nativeId)).find((turn) => turn.turnId === turnId);
  if (!ended?.endedAt || ended.superseded) return;
  const completedAt = Date.parse(ended.endedAt);
  if (!Number.isFinite(completedAt)) return;
  const startedAt = ended.startedAt === null ? Number.NaN : Date.parse(ended.startedAt);
  await bridge.acceptVerifiedCompletion(
    nativeId,
    {
      id: turnId,
      status: ended.outcome === "cancelled" ? "interrupted" : ended.outcome,
      completedAt: completedAt / 1000,
      ...(completedAt >= startedAt && { durationMs: completedAt - startedAt }),
    },
    current,
    ended.replyText,
  );
}

/** Unattended observation never starts, interrupts or resumes a native process. */
export async function workerCompletionSnapshot(
  bridge: ManagedCodexEventBridge,
  runtimeBootId: string,
  current: () => boolean,
  endedTurns: (nativeId: string) => Promise<EndedTurn[]>,
  now = performance.now(),
) {
  const { state } = bridge;
  const observation = state.workerObservation();
  const progress = "workerProgress" in observation ? observation.workerProgress : undefined;
  const { turnId } = state;
  if (state.status !== "running" || !turnId || typeof progress !== "string") {
    quietWorkers.delete(bridge);
  } else {
    const previous = quietWorkers.get(bridge);
    if (!previous || previous.turnId !== turnId || previous.progress !== progress) {
      quietWorkers.set(bridge, {
        turnId,
        progress,
        nextCheck: now + QUIET_MS,
      });
    } else if (previous.checking) {
      await previous.checking;
    } else if (now >= previous.nextCheck) {
      previous.nextCheck = now + QUIET_MS;
      previous.checking = verifyCodexWorkerCompletion(bridge, current, endedTurns).finally(() => {
        previous.checking = undefined;
      });
      await previous.checking;
    }
  }
  return { ...state.snapshot(runtimeBootId, false), ...state.workerObservation() };
}
