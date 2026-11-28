import { isSessionVisible, type HomeSession } from "@agentkib/session-catalog";
import {
  REMOTE_ROUTE,
  sessionNotificationInteractions,
  type SessionNotificationInteractions,
} from "@agentkib/runtime-protocol";
import type { WebAccessService } from "../web/service";

type Observer = (
  sessionId: string,
  evidence: SessionNotificationInteractions,
  seed: boolean,
) => void;
const MAX_READS = 8;
const MAX_OBSERVATIONS = 1024;
type Observation = { approval?: readonly string[]; question?: readonly string[] };
function waiting(row: HomeSession): boolean {
  return ["awaiting-approval", "waiting-approval", "waiting-input"].includes(
    row.continuation?.status ?? "",
  );
}
function pending(evidence: Observation): boolean {
  return !!evidence.approval?.length || !!evidence.question?.length;
}
function eligible(row: HomeSession): boolean {
  return row.availability === "readable" && !row.archived && !row.remote && isSessionVisible(row);
}

function stateChanged(row: HomeSession, previous: HomeSession | undefined): boolean {
  return (
    !previous ||
    row.availability !== previous.availability ||
    row.workspace_id !== previous.workspace_id ||
    row.continuation?.status !== previous.continuation?.status ||
    row.continuation?.reason !== previous.continuation?.reason
  );
}

/** Runtime changes bypass catalog coalescing. A targeted read seeds missing observations. */
export class DesktopNotificationInteractionSource {
  #observed = new Map<string, Observation>();
  #revalidate = new Set<string>();
  #reads = new Map<string, symbol>();
  #activeReads = 0;
  #rows?: Map<string, HomeSession>;
  #initialized = false;

  constructor(
    private readonly remote: Pick<WebAccessService, "localRequest">,
    private readonly observe: Observer,
  ) {}

  invalidate(): void {
    for (const [id, evidence] of this.#observed) if (pending(evidence)) this.#revalidate.add(id);
    this.#observed.clear();
    this.#reads.clear();
    this.#rows = undefined;
  }

  disable(): void {
    this.#observed.clear();
    this.#revalidate.clear();
    this.#reads.clear();
    this.#rows = undefined;
    this.#initialized = false;
  }

  changed(sessionId: string, evidence: SessionNotificationInteractions, seed = false): void {
    this.#reads.delete(sessionId);
    const before = this.#observed.get(sessionId);
    this.#observed.delete(sessionId);
    this.#observed.set(sessionId, {
      approval: evidence.approval ?? before?.approval,
      question: evidence.question ?? before?.question,
    });
    if (this.#observed.size > MAX_OBSERVATIONS) {
      const oldest = this.#observed.keys().next().value!;
      this.#observed.delete(oldest);
      this.#revalidate.delete(oldest);
    }
    if (evidence.approval !== undefined && evidence.question !== undefined)
      this.#revalidate.delete(sessionId);
    this.observe(sessionId, evidence, seed);
  }

  update(sessions: readonly HomeSession[] | undefined): void {
    const previous = this.#rows;
    this.#rows = sessions && new Map(sessions.map((row) => [row.id, row]));
    if (!sessions) {
      for (const [id, evidence] of this.#observed) if (pending(evidence)) this.#revalidate.add(id);
      this.#reads.clear();
      return;
    }
    const seed = !this.#initialized;
    this.#initialized = true;
    for (const id of this.#reads.keys()) {
      const row = this.#rows?.get(id);
      if (!row || !eligible(row) || stateChanged(row, previous?.get(id))) this.#reads.delete(id);
    }
    for (const [id, evidence] of this.#observed) {
      const row = this.#rows?.get(id);
      if (pending(evidence)) {
        if (!row || !eligible(row) || stateChanged(row, previous?.get(id)))
          this.#revalidate.add(id);
      } else if (!row || !waiting(row)) this.#observed.delete(id);
    }
    for (const row of sessions) {
      if (this.#activeReads >= MAX_READS) break;
      if (
        eligible(row) &&
        !this.#reads.has(row.id) &&
        (!this.#observed.has(row.id) || this.#revalidate.has(row.id)) &&
        (waiting(row) || this.#revalidate.has(row.id))
      )
        this.#read(row, seed);
    }
  }

  #read(row: HomeSession, seed: boolean): void {
    const id = row.id;
    const token = Symbol();
    this.#reads.set(id, token);
    this.#activeReads++;
    const query = new URLSearchParams({ sessionId: id });
    void this.remote
      .localRequest(`${REMOTE_ROUTE.live}?${query}`)
      .then(({ status, body }) => {
        const current = this.#rows?.get(id);
        if (
          this.#reads.get(id) !== token ||
          !current ||
          !eligible(current) ||
          current.workspace_id !== row.workspace_id ||
          status !== 200 ||
          !body ||
          typeof body !== "object" ||
          !("workspaceId" in body) ||
          body.workspaceId !== row.workspace_id
        )
          return;
        const evidence = sessionNotificationInteractions(id, body);
        if (evidence) this.changed(id, evidence, seed);
      })
      .catch(() => undefined)
      .finally(() => {
        this.#activeReads--;
        if (this.#reads.get(id) === token) this.#reads.delete(id);
      });
  }
}
