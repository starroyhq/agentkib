import { z } from "zod";
import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import type { DshLocalTurnCheckpoint } from "./dsh-local-history";
import type { DshWriterStatus } from "./dsh-writer";

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
