import type { RemoteErrorCode } from "./generated/remote-contract";

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
  status: "interrupted" | "unknown";
  openSession?: true;
}

export type QuitWorkOutcome = "continued" | "skipped" | "unknown" | "manual-required";

export type QuitWorkResult =
  | { outcome: "continued"; queueRestoreReason?: RemoteErrorCode }
  | { outcome: Exclude<QuitWorkOutcome, "continued">; reason?: RemoteErrorCode };
