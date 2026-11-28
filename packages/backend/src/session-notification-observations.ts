import {
  SESSION_NOTIFICATION_INTERACTIONS_CHANGED,
  sessionNotificationInteractions,
  type SessionNotificationInteractions,
} from "@agentkib/runtime-protocol";
import { isDeepStrictEqual } from "node:util";

const MAX_PENDING_SESSIONS = 1024;

/** Keep notification observations independent of the catalog's coalesced status rows. */
export class SessionNotificationObservations {
  #waiting = new Map<string, SessionNotificationInteractions>();

  constructor(private readonly notify: (method: string, params: unknown) => void) {}

  clear(): void {
    this.#waiting.clear();
  }

  update(sessionId: string, live: unknown): void {
    const evidence = sessionNotificationInteractions(sessionId, live);
    if (!evidence) return;
    const before = this.#waiting.get(sessionId);
    const after = {
      sessionId,
      approval: evidence.approval ?? before?.approval,
      question: evidence.question ?? before?.question,
    };
    if (!before && !after.approval?.length && !after.question?.length) return;
    if (isDeepStrictEqual(before, after)) return;
    this.#waiting.delete(sessionId);
    if (after.approval?.length || after.question?.length) {
      this.#waiting.set(sessionId, after);
      if (this.#waiting.size > MAX_PENDING_SESSIONS)
        this.#waiting.delete(this.#waiting.keys().next().value!);
    }
    this.notify(SESSION_NOTIFICATION_INTERACTIONS_CHANGED, evidence);
  }
}
