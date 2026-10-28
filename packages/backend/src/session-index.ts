import { z } from "zod";
import { sessionCollection } from "@agentkib/runtime-protocol";
import { SessionStore } from "./session-store";
import { SESSION_AGENTS, type NativeListing, type SessionReaders } from "./session-readers";
import { parameters } from "./rpc";

/** Invalidate scans before clearing or changing preferences; no await occurs between validation and writes. */
export class SessionIndex {
  #epoch = 0n;
  #closed = false;
  #refreshes = new Map<string, Promise<void>>();
  constructor(
    readonly store: SessionStore,
    readonly readers: Pick<SessionReaders, "list">,
    readonly enabled: () => boolean,
    readonly refreshed: () => void = () => {},
  ) {}
  invalidate(): void {
    this.#epoch++;
  }
  generation(): bigint {
    return this.#epoch;
  }
  close(): void {
    this.#closed = true;
    this.invalidate();
  }
  clear(value: unknown): null {
    const { workspaceId } = parameters(
      z.object({ workspaceId: z.string().nullable().optional() }),
      value,
    );
    this.invalidate();
    this.store.clear(workspaceId ?? null);
    return null;
  }
  /** A deleted conversation leaves the index at once; scans already reading it are discarded. */
  forget(ids: readonly string[]): void {
    this.invalidate();
    this.store.forget(ids);
    this.refreshed();
  }
  read(workspaceId: string) {
    // A directory read only rescans the pending Codex classification, leaving
    // other providers and the normal refresh schedule unchanged.
    return this.store.codexClassificationPending(workspaceId)
      ? this.#queue(workspaceId, false, true)
      : Promise.resolve(this.store.list(workspaceId));
  }
  refresh(value: unknown) {
    const { workspaceId, force } = parameters(
      z.object({
        workspaceId: z.string(),
        force: z.boolean().default(false),
      }),
      value,
    );
    return this.#queue(workspaceId, force, false);
  }
  #queue(workspaceId: string, force: boolean, codexOnly: boolean) {
    const epoch = this.#epoch;
    const previous = this.#refreshes.get(workspaceId);
    const refresh = (previous ?? Promise.resolve()).then(() =>
      this.#scan(workspaceId, force || previous !== undefined, epoch, codexOnly),
    );
    const completed = refresh.then(
      () => undefined,
      () => undefined,
    );
    this.#refreshes.set(workspaceId, completed);
    void completed.then(() => {
      if (this.#refreshes.get(workspaceId) === completed) this.#refreshes.delete(workspaceId);
    });
    return refresh;
  }
  async #scan(workspaceId: string, force: boolean, epoch: bigint, codexOnly: boolean) {
    if (this.#closed || epoch !== this.#epoch || !this.enabled()) return [];
    const collection = sessionCollection(workspaceId);
    const pendingClassification = this.store.codexClassificationPending(workspaceId);
    if (codexOnly && !pendingClassification) return this.store.list(workspaceId);
    const agents = collection || codexOnly ? (["codex"] as const) : SESSION_AGENTS;
    if (!force && !pendingClassification) {
      const statuses = this.store.status(workspaceId);
      if (
        statuses.length === agents.length &&
        statuses.every((status) => status.freshness === "fresh")
      )
        return this.store.list(workspaceId);
    }
    const workspace = collection ? workspaceId : this.store.workspacePath(workspaceId);
    const current = () => !this.#closed && epoch === this.#epoch && this.enabled();
    let normalizedOwner: ReturnType<SessionStore["owner"]> | undefined;
    for (const agent of agents) {
      let listing: NativeListing;
      try {
        listing = await this.readers.list(agent, workspace);
      } catch {
        if (!current()) return [];
        this.store.failure(workspaceId, agent, "Conversation source could not be read");
        continue;
      }
      if (!current()) return [];
      const owner = ["open-claw", "hermes", "grok-build"].includes(agent)
        ? (normalizedOwner ??= this.store.owner(workspaceId))
        : undefined;
      this.store.sync(workspaceId, agent, listing.sessions, !listing.incomplete, owner);
      if (listing.incomplete)
        this.store.failure(
          workspaceId,
          agent,
          "Some conversation sources could not be read; previous records were retained",
        );
    }
    if (current()) {
      this.refreshed();
      return this.store.list(workspaceId);
    }
    return [];
  }
}
