export interface QuitWorkEntry {
  id: string;
  title: string;
  agent: string;
  resumable: boolean;
}

export interface QuitWorkPreview {
  ticket: string;
  resumeByDefault: boolean;
  work: QuitWorkEntry[];
}

export interface QuitWorkDecision {
  ticket: string;
  resume: boolean;
}

export interface InterruptedQuitWork extends QuitWorkEntry {
  sessionId: string;
  status: "interrupted" | "unknown";
}

export type QuitWorkOutcome = "continued" | "skipped" | "unknown";
