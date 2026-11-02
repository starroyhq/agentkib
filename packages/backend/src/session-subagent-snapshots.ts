import type { SubagentCatalog, SubagentStatus, SubagentSummary } from "@agentkib/runtime-protocol";

type Json = Record<string, unknown>;
export type SubagentSnapshot = SubagentCatalog & { available?: false; partial?: true };
const record = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const states: ReadonlySet<string> = new Set([
  "starting",
  "running",
  "waiting-input",
  "waiting-approval",
  "completed",
  "failed",
  "stopped",
  "unknown",
]);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const unavailable = (sessionId: string): SubagentSnapshot => ({
  version: 1,
  sessionId,
  agents: [],
  truncated: false,
  available: false,
});
const scope = (live: Json) =>
  JSON.stringify([
    live.sourceSessionId ?? null,
    live.workspaceId ?? null,
    live.runtimeBootId ?? null,
  ]);

/** Defensively whitelist a publication; runner arrays/native identifiers must never seed this cache. */
function project(sessionId: string, input: unknown): SubagentSnapshot | null {
  if (
    !record(input) ||
    input.version !== 1 ||
    input.sessionId !== sessionId ||
    !Array.isArray(input.agents) ||
    input.agents.length > 128 ||
    typeof input.truncated !== "boolean" ||
    (input.partial !== undefined && typeof input.partial !== "boolean")
  )
    return null;
  const agents: SubagentSummary[] = [];
  for (const child of input.agents) {
    if (
      !record(child) ||
      !identifier(child.id) ||
      typeof child.name !== "string" ||
      child.name.length > 640 ||
      !["codex", "claude-code"].includes(String(child.agent)) ||
      typeof child.status !== "string" ||
      !states.has(child.status) ||
      typeof child.readable !== "boolean" ||
      (child.parentId !== undefined && !identifier(child.parentId))
    )
      return null;
    agents.push({
      id: child.id,
      name: child.name,
      agent: child.agent as SubagentSummary["agent"],
      status: child.status as SubagentStatus,
      readable: child.readable,
      ...(typeof child.parentId === "string" ? { parentId: child.parentId } : {}),
      ...(typeof child.updatedAt === "string" && child.updatedAt.length <= 128
        ? { updatedAt: child.updatedAt }
        : {}),
    });
  }
  return {
    version: 1,
    sessionId,
    agents,
    truncated: input.truncated,
    ...(input.available === false ? { available: false as const } : {}),
    ...(input.partial === true ? { partial: true as const } : {}),
  };
}

function overlay(base: SubagentSnapshot | undefined, patch: SubagentSnapshot): SubagentSnapshot {
  const incoming = new Set(patch.agents.map((child) => child.id));
  const agents = [
    ...patch.agents,
    ...(base?.agents.filter((child) => !incoming.has(child.id)) ?? []),
  ];
  return {
    ...patch,
    agents: agents.slice(0, 128),
    truncated: patch.truncated || base?.truncated === true || agents.length > 128,
    partial: true,
  };
}

/** Short read cache fenced by synchronous native publications, independently of parent control revision. */
export class SessionSubagentSnapshots {
  #entries = new Map<
    string,
    { scope: string; at: number; value: SubagentSnapshot; publication?: SubagentSnapshot }
  >();
  #tokens = new Map<string, { scope: string; token: object }>();
  #flights = new Map<
    string,
    { scope: string; token: object; promise: Promise<SubagentSnapshot> }
  >();
  constructor(readonly ttlMs = 2_000) {}

  invalidate(sessionId?: string): void {
    if (sessionId === undefined) {
      this.#entries.clear();
      this.#tokens.clear();
      this.#flights.clear();
    } else {
      this.#entries.delete(sessionId);
      this.#tokens.delete(sessionId);
      this.#flights.delete(sessionId);
    }
  }

  publish(sessionId: string, live: Json): void {
    if (!Object.hasOwn(live, "subagents")) return;
    const identity = scope(live);
    this.#tokens.set(sessionId, { scope: identity, token: {} });
    this.#flights.delete(sessionId);
    const value = project(sessionId, live.subagents);
    const previous = this.#entries.get(sessionId);
    if (value?.partial) {
      const baseline = previous?.scope === identity ? previous : undefined;
      this.#entries.set(sessionId, {
        scope: identity,
        at: baseline?.at ?? -Infinity,
        value: overlay(baseline?.value, value),
        publication: overlay(baseline?.publication?.partial ? baseline.publication : undefined, value),
      });
    } else if (value)
      this.#entries.set(sessionId, { scope: identity, at: Date.now(), value, publication: value });
    else this.#entries.delete(sessionId);
    this.#trim();
  }

  async read(
    sessionId: string,
    live: Json,
    load: () => Promise<unknown>,
  ): Promise<SubagentSnapshot> {
    const identity = scope(live);
    let generation = this.#tokens.get(sessionId);
    if (!generation || generation.scope !== identity) {
      generation = { scope: identity, token: {} };
      this.#tokens.set(sessionId, generation);
      this.#entries.delete(sessionId);
      this.#flights.delete(sessionId);
      this.#trim();
    }
    const token = generation.token;
    const cached = this.#entries.get(sessionId);
    if (cached?.scope === identity && Date.now() - cached.at < this.ttlMs)
      return structuredClone(cached.value);
    const previous = this.#flights.get(sessionId);
    if (previous?.scope === identity && previous.token === token)
      return structuredClone(await previous.promise);
    const latest = () => {
      const entry = this.#entries.get(sessionId);
      return structuredClone(entry?.scope === identity ? entry.value : unavailable(sessionId));
    };
    const promise = Promise.resolve().then(async () => {
      try {
        const input = await load();
        // A child state can change while its parent control revision stays unchanged.
        if (this.#tokens.get(sessionId)?.token !== token) {
          const published = this.#entries.get(sessionId);
          const baseline = project(sessionId, input);
          if (
            published?.scope === identity &&
            published.publication?.partial &&
            baseline?.available !== false &&
            baseline
          ) {
            const value = overlay(baseline, published.publication);
            this.#entries.set(sessionId, { ...published, at: Date.now(), value });
            return structuredClone(value);
          }
          return latest();
        }
        const value = project(sessionId, input) ?? unavailable(sessionId);
        this.#entries.set(sessionId, { scope: identity, at: Date.now(), value });
        return structuredClone(value);
      } catch {
        if (this.#tokens.get(sessionId)?.token !== token) return latest();
        this.#entries.delete(sessionId);
        return unavailable(sessionId);
      } finally {
        if (this.#flights.get(sessionId)?.token === token) this.#flights.delete(sessionId);
      }
    });
    this.#flights.set(sessionId, { scope: identity, token, promise });
    return promise;
  }

  #trim(): void {
    while (this.#tokens.size > 64) {
      const id = this.#tokens.keys().next().value!;
      this.#tokens.delete(id);
      this.#entries.delete(id);
      this.#flights.delete(id);
    }
  }
}
