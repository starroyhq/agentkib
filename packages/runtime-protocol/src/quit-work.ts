import type { RemoteErrorCode } from "./generated/remote-contract";

export const QUIT_WORK_RESULTS_CHANGED = "quitWork.resultsChanged";

export interface QuitWorkEntry {
  id: string;
  title: string;
  agent: string;
  resumable: boolean;
  reason?: RemoteErrorCode;
}

export interface QuitWorkPreview {
  ticket: string;
  resumeByDefault: boolean;
  work: QuitWorkEntry[];
  reason?: RemoteErrorCode;
}

export interface QuitWorkDecision {
  ticket: string;
  resume: boolean;
}

export interface InterruptedQuitWork extends QuitWorkEntry {
  sessionId: string;
  status: "interrupted" | "unknown" | "skipped" | "continued";
  queueRestoreReason?: RemoteErrorCode;
  bookkeepingReason?: RemoteErrorCode;
  openSession?: true;
}

export type QuitWorkOutcome = "continued" | "skipped" | "unknown" | "manual-required";

export type QuitWorkResult = (
  | { outcome: "continued"; queueRestoreReason?: RemoteErrorCode }
  | { outcome: Exclude<QuitWorkOutcome, "continued">; reason?: RemoteErrorCode }
) & { bookkeepingReason?: RemoteErrorCode };
