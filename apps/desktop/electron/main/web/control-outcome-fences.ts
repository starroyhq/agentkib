export type ControlOutcomeFence = {
  requestId: string;
  sessionId: string;
  operation: string;
  deviceId: string;
  createdAt: number;
};

/** Transport uncertainty fences one operation. The Provider still owns native authority. */
export class ControlOutcomeFences {
  readonly sessions = new Set<string>();
  readonly #requests = new Map<string, ControlOutcomeFence>();
  readonly #bySession = new Map<string, Set<ControlOutcomeFence>>();

  record(entry: Omit<ControlOutcomeFence, "createdAt">): void {
    if (this.#requests.has(entry.requestId)) return;
    const fence = { ...entry, createdAt: Date.now() };
    const entries = this.#bySession.get(entry.sessionId) ?? new Set<ControlOutcomeFence>();
    entries.add(fence);
    this.#bySession.set(entry.sessionId, entries);
    this.#requests.set(entry.requestId, fence);
    this.sessions.add(entry.sessionId);
  }

  get(requestId: string): ControlOutcomeFence | undefined {
    return this.#requests.get(requestId);
  }

  forSession(sessionId: string): ReadonlySet<ControlOutcomeFence> | undefined {
    return this.#bySession.get(sessionId);
  }

  blocks(sessionId: string, operation: string, exceptRequestId?: string): boolean {
    const entries = this.#bySession.get(sessionId);
    if (!entries) return false;
    for (const entry of entries) {
      if (entry.requestId === exceptRequestId) continue;
      if (entry.operation === operation) return true;
    }
    return false;
  }

  settle(sessionId: string, requestId: string): boolean {
    const fence = this.#requests.get(requestId);
    if (fence?.sessionId !== sessionId) return false;
    this.#requests.delete(requestId);
    const entries = this.#bySession.get(sessionId);
    entries?.delete(fence);
    if (!entries?.size) {
      this.#bySession.delete(sessionId);
      this.sessions.delete(sessionId);
    }
    return true;
  }
}
