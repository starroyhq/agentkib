import {
  REMOTE_ERROR_CODES as codes,
  RUNTIME_METHODS,
  type QuitWorkResult,
} from "@agentkib/runtime-protocol";
import { recordLocalRuntimeTrace } from "../local-runtime-activity";
import type { LocalRuntimeTraceResult } from "../local-runtime-trace";
import type { NoteQuitWorkReason } from "./quit-work-result";

const { quitWorkPrepare, quitWorkResume } = RUNTIME_METHODS;

export function recordQuitWorkTrace(
  method: typeof quitWorkPrepare | typeof quitWorkResume,
  started: number,
  result: LocalRuntimeTraceResult,
) {
  recordLocalRuntimeTrace({
    kind: "request",
    method,
    durationMs: performance.now() - started,
    ...result,
  });
}

export function recordQuitWorkOutcome(
  stage: "quit-work-dispatch" | "quit-work-reconcile",
  started: number,
  result: QuitWorkResult,
) {
  recordQuitWorkTrace(
    quitWorkResume,
    started,
    result.outcome === "continued"
      ? { stage, outcome: "accepted" }
      : result.outcome === "unknown"
        ? { stage, outcome: "unknown", reason: codes.controlOutcomeUnconfirmed }
        : { stage, outcome: "refused", reason: result.reason ?? codes.quitWorkEvidenceChanged },
  );
  return result;
}

/** An unverified queue must not change the outcome of an already accepted continuation. */
export function restoreClaudeQuitQueue(
  restore: () => boolean | undefined,
  note?: NoteQuitWorkReason,
) {
  const started = performance.now();
  const stage = "quit-work-queue-restore";
  let restored: boolean | undefined;
  try {
    restored = restore();
  } catch {
    const reason = codes.quitWorkQueueRestoreFailed;
    note?.(reason);
    recordQuitWorkTrace(quitWorkResume, started, { stage, outcome: "failed", reason });
    return;
  }
  if (restored === undefined) {
    const reason = codes.quitWorkEvidenceChanged;
    note?.(reason);
    recordQuitWorkTrace(quitWorkResume, started, { stage, outcome: "refused", reason });
  } else if (restored) {
    recordQuitWorkTrace(quitWorkResume, started, { stage, outcome: "completed" });
  }
}
