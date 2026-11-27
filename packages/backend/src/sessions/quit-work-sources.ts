import { REMOTE_ERROR_CODES as codes, type QuitWorkOutcome } from "@agentkib/runtime-protocol";
import { z } from "zod";
import { readControlReceipt } from "../control-receipt";
import { quitWorkReason, type NoteQuitWorkReason } from "./quit-work-result";
import { recordQuitQueueRestoreFailure } from "./quit-work-trace";

export function quitWorkSessions(catalog: unknown) {
  if (
    !catalog ||
    typeof catalog !== "object" ||
    !("sessions" in catalog) ||
    !Array.isArray(catalog.sessions)
  )
    throw new Error(codes.quitWorkPlanUnavailable);
  const locallyActive = z.object({
    id: z.string().min(1).max(256),
    agent: z.string().min(1).max(64),
    title: z.string().nullish(),
    archived: z.boolean().optional(),
    availability: z.literal("readable"),
    origin: z.string().optional(),
    remote: z.unknown().optional(),
    continuation: z.object({
      executionLocation: z.literal("agentkib"),
      status: z.string(),
      backgroundTasks: z.number().optional(),
    }),
  });
  const active = new Set(["starting", "running", "awaiting-approval", "waiting-input"]);
  return catalog.sessions.flatMap((row) => {
    const { data: session } = locallyActive.safeParse(row);
    if (
      !session ||
      session.remote ||
      session.archived ||
      session.origin === "auxiliary" ||
      session.origin === "execution" ||
      !(active.has(session.continuation.status) || (session.continuation.backgroundTasks ?? 0) > 0)
    )
      return [];
    return [
      { sessionId: session.id, title: session.title?.slice(0, 512) ?? "", agent: session.agent },
    ];
  });
}

const quitExecutionModes: ReadonlyMap<string, string> = new Map([
  ["codex", "codex-managed"],
  ["deepseek-harness", "dsh-follower"],
  ["claude-code", "claude-managed"],
]);

export function resolveQuitWorkReceipt(
  dataDir: string,
  { id, sessionId, agent }: { id: string; sessionId: string; agent: string },
  note: NoteQuitWorkReason,
  restoreQueue: () => void,
): QuitWorkOutcome {
  const receipt = readControlReceipt(dataDir, { requestId: id, deviceId: "desktop-local" });
  const mode = quitExecutionModes.get(agent);
  if (
    !mode ||
    !receipt.found ||
    !("sessionId" in receipt) ||
    receipt.sessionId !== sessionId ||
    receipt.operation !== "send" ||
    receipt.executionMode !== mode
  )
    return "unknown";
  if (receipt.status === "accepted") {
    if (mode === "claude-managed") {
      const started = performance.now();
      try {
        restoreQueue();
      } catch {
        // The receipt already proves acceptance even if the queue cannot be reconciled.
        recordQuitQueueRestoreFailure(started, note);
      }
    }
    return "continued";
  }
  if (receipt.status !== "not-dispatched") return "unknown";
  const ack = receipt.ack;
  const reason = quitWorkReason(ack && typeof ack === "object" && "reason" in ack && ack.reason);
  if (reason)
    note(reason === codes.quitWorkManualRequired ? codes.quitWorkQueueUnconfirmed : reason);
  return reason === codes.quitWorkManualRequired ? "manual-required" : "skipped";
}
