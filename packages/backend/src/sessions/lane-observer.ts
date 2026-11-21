/** Notifications from session execution to Project Agent orchestration. */
export type LaneObserver = {
  turnEnded(
    sessionId: string,
    turnId: string,
    outcome: string,
    durationMs: number | null,
    historyTurnId?: string,
    replyText?: string | null,
  ): void;
  waiting(sessionId: string, turnId: string | null, status: string): void;
  /**
   * A turn Codex started by itself, as a goal continues (`CodexLeadTurns`), told for any session
   * AgentKib runs; the observer counts it when the session is a Project Agent.
   */
  ownTurn?(sessionId: string, turnId: string): void;
  /** The session's usage limit is over: AgentKib's continue, or a later turn, went through. */
  limitEnded?(sessionId: string): void;
};
