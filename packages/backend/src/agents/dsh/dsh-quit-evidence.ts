import { z } from "zod";
import { REMOTE_ERROR_CODES, type QuitWorkOutcome } from "@agentkib/runtime-protocol";
import type { DshLocalTurnCheckpoint } from "./dsh-local-history";
import type { DshWriterStatus } from "./dsh-writer";
import type { NoteQuitWorkReason } from "../../sessions/quit-work-result";

export const quitEvidenceSchema = z
  .object({
    turn: z.number().safe().int().positive(),
    interruptionId: z.uuid(),
    endSeq: z.number().safe().int().nonnegative(),
    settings: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    manualOnly: z.literal(true).optional(),
    cwd: z.string().min(1).max(4096),
  })
  .refine((evidence) => evidence.manualOnly === true || evidence.settings !== undefined);

type DshQuitWriter = {
  managed: boolean;
  states: ReadonlyMap<string, { live: boolean }>;
  summaries: ReadonlyMap<string, { live?: boolean }>;
  services: { sessionController?: boolean };
};

export function dshQuitHasOtherWriter(
  runtimes: readonly DshQuitWriter[],
  nativeId: string,
  manualOnly: boolean,
): boolean {
  return runtimes.some(
    (runtime) =>
      !runtime.managed &&
      (runtime.states.get(nativeId)?.live ||
        runtime.summaries.get(nativeId)?.live ||
        (!manualOnly && runtime.services.sessionController)),
  );
}

export function dshQuitWriterReason(
  status: DshWriterStatus | undefined,
  otherRuntime: () => boolean,
) {
  if (status === "held" || otherRuntime()) return REMOTE_ERROR_CODES.dshSessionInUse;
  if (status !== "free") return REMOTE_ERROR_CODES.dshNativeStatusUnknown;
}

export function matchesDshQuitEvidence(
  snapshot: DshLocalTurnCheckpoint | null | undefined,
  evidence: z.infer<typeof quitEvidenceSchema>,
  target: { nativeId: string; cwd: string },
  current: { nativeId: string; cwd: string } | null,
) {
  const interrupted = snapshot?.quitInterruption;
  return (
    interrupted?.turn === evidence.turn &&
    interrupted.interruptionId === evidence.interruptionId &&
    interrupted.endSeq === evidence.endSeq &&
    current?.nativeId === target.nativeId &&
    current.cwd === target.cwd
  );
}

export function dshQuitCandidate(value: unknown, note?: NoteQuitWorkReason) {
  const candidate = value as { turn?: number; manualOnly?: boolean } | null;
  const turn = candidate?.turn;
  if (typeof turn !== "number" || !Number.isSafeInteger(turn) || turn <= 0) return;
  if (candidate?.manualOnly === true) note?.(REMOTE_ERROR_CODES.quitWorkQueueUnconfirmed);
  return {
    turnId: `dsh-turn-${turn}`,
    ...(candidate?.manualOnly === true && { manualOnly: true as const }),
  };
}

export function dshQuitReceiptOutcome(result: Record<string, unknown>): QuitWorkOutcome {
  if (result.controlOutcome === "accepted") return "continued";
  if (result.controlOutcome === "not-dispatched") return "skipped";
  return "unknown";
}
