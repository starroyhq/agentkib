import { setTimeout as delay } from "node:timers/promises";
import type { WorkerRestartRequest, WorkerRestartResult } from "../../orchestration-service";
import type { CodexAppServerSession } from "./codex-app-server";
import type { EndedTurn } from "./codex-external-turns";
import {
  MINIMUM_CODEX_WRITER_VERSION,
  codexReleaseSupportsWriterLock,
  codexServerVersion,
} from "./codex-runtime-preflight";
import { verifyCodexWorkerCompletion } from "./codex-worker-completion";
import type { ManagedCodexEventBridge } from "./managed-codex-event-bridge";

type WorkerInterrupt = Omit<WorkerRestartRequest, "workspaceId" | "turnId"> & {
  operation: "stop";
  turnId: string;
};

const unknown = {
  accepted: false,
  controlOutcome: "unknown",
  reason: "control-outcome-unconfirmed",
} as const;

export async function restartCodexWorker(
  { workspaceId: _workspaceId, turnId, ...input }: WorkerRestartRequest,
  beforeDispatch: () => void,
  run: (control: WorkerInterrupt, begin: () => void) => Promise<unknown>,
): Promise<WorkerRestartResult> {
  if (!turnId)
    return {
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "worker-restart-unsupported",
    };
  let dispatched = false;
  try {
    const result = await run({ ...input, operation: "stop", turnId }, () => {
      beforeDispatch();
      dispatched = true;
    });
    if (!result || typeof result !== "object") return unknown;
    const { accepted, controlOutcome, reason, error } = result as Record<string, unknown>;
    const detail = reason ?? error;
    return {
      accepted: accepted === true,
      controlOutcome:
        accepted === true
          ? "accepted"
          : controlOutcome === "unknown"
            ? "unknown"
            : "not-dispatched",
      ...(typeof detail === "string" ? { reason: detail } : {}),
    };
  } catch (error) {
    return dispatched
      ? unknown
      : {
          accepted: false,
          controlOutcome: "not-dispatched",
          reason: error instanceof Error ? error.message : "control-preflight-rejected",
        };
  }
}

export async function runExclusiveCodexWorkerRestart(
  active: Set<string>,
  sessionId: string,
  controls: ReadonlyMap<string, { count: number }>,
  run: () => Promise<unknown>,
) {
  if (active.has(sessionId) || controls.get(sessionId)?.count !== 1)
    throw new Error("worker-restart-in-progress");
  active.add(sessionId);
  try {
    return await run();
  } finally {
    active.delete(sessionId);
  }
}

/** A single bounded read verifies the native queue before resuming a thread. */
export async function readCodexRecoveryQueue(
  session: CodexAppServerSession,
  queueVerified: boolean | null,
  threadId: string | null | undefined,
  mode: string | null,
): Promise<string[] | undefined> {
  const release = codexServerVersion(session.userAgent);
  if (!queueVerified) {
    // The first writer-lock release predates native queued submissions.
    return release === MINIMUM_CODEX_WRITER_VERSION ? [] : undefined;
  }
  try {
    const queue = await session.request(
      "thread/queue/list",
      { threadId: threadId, limit: 100 },
      undefined,
      650,
    );
    if (
      !isObject(queue) ||
      !Array.isArray(queue.data) ||
      queue.nextCursor != null ||
      queue.data.length >= 100
    )
      return;
    const ids = queue.data.map((item: unknown) => (isObject(item) ? item.id : null));
    if (ids.some((id: unknown) => typeof id !== "string" || !id)) return;
    if (
      ids.length &&
      (!release ||
        release === MINIMUM_CODEX_WRITER_VERSION ||
        !codexReleaseSupportsWriterLock(release) ||
        // Queue start inherits the loaded settings and has no collaboration override.
        (mode ?? "default") !== "default")
    )
      return;
    if (new Set(ids).size === ids.length) return ids as string[];
  } catch {
    // An unreadable or unsupported queue has no safe automatic ordering.
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function confirmCodexWorkerInterrupted(
  bridge: ManagedCodexEventBridge,
  turnId: string,
  turnsBefore: number,
  current: () => boolean,
  endedTurns: (nativeId: string) => Promise<EndedTurn[]>,
  requireInterrupted: boolean,
): Promise<void> {
  const { state, session } = bridge;
  const safe = () =>
    current() && session.connected && !state.reason && state.turnsStarted === turnsBefore;
  const until = performance.now() + 2_000;
  const verifyAfter = performance.now() + 100;
  let verified = false;
  // The interrupt acknowledgment can precede the final event. A new turn on this writer
  // is never part of the restart, so stop before retiring if the engine starts one.
  while (performance.now() < until) {
    await bridge.flush();
    if (!safe()) break;
    if (!state.turnId && state.lastTurnId === turnId && state.status === "idle") {
      if (requireInterrupted && state.lastTurnOutcome !== "aborted") break;
      return;
    }
    if (state.turnId !== turnId) break;
    if (!verified && performance.now() >= verifyAfter) {
      verified = true;
      await verifyCodexWorkerCompletion(bridge, safe, endedTurns);
    }
    await delay(25);
  }
  throw new Error("control-outcome-unconfirmed");
}
