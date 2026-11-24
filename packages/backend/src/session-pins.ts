import { sessionProviderDeclaration } from "@agentkib/runtime-protocol";
import type { Sql } from "./sql";

type NativePin = { pinned: boolean; available: boolean };
export type NativePins = {
  states(sessionIds: readonly string[]): ReadonlyMap<string, NativePin>;
  set(sessionId: string, pinned: boolean): Promise<boolean>;
};

export type SessionPinRow = {
  id: string;
  agent: string;
  workspace_id: string;
  archived?: boolean;
  sidechain?: boolean;
  origin?: string | null;
  indexedSessionId?: unknown;
  indexedSessionIds?: unknown;
};

export function isSessionPinRow(row: unknown): row is SessionPinRow {
  return (
    row !== null &&
    typeof row === "object" &&
    "id" in row &&
    typeof row.id === "string" &&
    "agent" in row &&
    typeof row.agent === "string" &&
    "workspace_id" in row &&
    typeof row.workspace_id === "string"
  );
}

function identities(row: SessionPinRow): string[] {
  const aliases = Array.isArray(row.indexedSessionIds) ? row.indexedSessionIds : [];
  return [...new Set([row.id, row.indexedSessionId, ...aliases])].filter(
    (id): id is string => typeof id === "string" && !!id,
  );
}

function acceptsPin(row: SessionPinRow) {
  return (
    !row.archived && !row.sidechain && row.origin !== "auxiliary" && row.origin !== "execution"
  );
}

export class SessionPins {
  #pending = new Set<string>();
  constructor(
    private readonly sql: Sql,
    private readonly providers: Readonly<Record<string, NativePins>>,
  ) {}

  #nativeStates(adapter: NativePins | undefined, ids: readonly string[]) {
    if (!adapter || !ids.length) return new Map<string, NativePin>();
    try {
      return adapter.states(ids);
    } catch {
      // Loss of the native source is not evidence that it lacks pinning.
      return new Map(ids.map((id) => [id, { pinned: false, available: false }]));
    }
  }

  project<Row>(rows: readonly Row[]): Row[] {
    const visible = rows.filter((row): row is Row & SessionPinRow => isSessionPinRow(row));
    const native = new Map<string, ReadonlyMap<string, NativePin>>();
    for (const [agent, adapter] of Object.entries(this.providers)) {
      const ids = visible
        .filter((row) => row.agent === agent && acceptsPin(row))
        .map((row) => row.id);
      native.set(agent, this.#nativeStates(adapter, ids));
    }
    const ids = JSON.stringify([...new Set(visible.flatMap(identities))]);
    const local = new Set(
      this.sql
        .rows(
          "SELECT session_id FROM conversation_pins WHERE session_id IN (SELECT value FROM json_each(?))",
          ids,
        )
        .map((row) => row.session_id),
    );
    return rows.map((row) => {
      if (!isSessionPinRow(row)) return row;
      const eligible = acceptsPin(row);
      const state = native.get(row.agent)?.get(row.id);
      const useLocal = sessionProviderDeclaration(row.agent)?.pinning !== "native";
      return {
        ...row,
        pinned:
          eligible && (state?.pinned ?? (useLocal && identities(row).some((id) => local.has(id)))),
        pinningAvailable: eligible && (state?.available ?? useLocal),
      };
    });
  }

  async set(row: SessionPinRow, pinned: boolean): Promise<boolean> {
    if (!acceptsPin(row)) throw new Error("session-pin-unavailable");
    if (this.#pending.has(row.id)) throw new Error("session-pin-busy");
    this.#pending.add(row.id);
    try {
      const adapter = Object.hasOwn(this.providers, row.agent)
        ? this.providers[row.agent]
        : undefined;
      const native = this.#nativeStates(adapter, [row.id]).get(row.id);
      if (native) {
        if (!native.available || !adapter) throw new Error("session-pin-unavailable");
        const confirmed = await adapter.set(row.id, pinned);
        if (confirmed !== pinned) throw new Error("session-pin-unavailable");
        return confirmed;
      }
      if (sessionProviderDeclaration(row.agent)?.pinning === "native")
        throw new Error("session-pin-unavailable");
      if (pinned) this.sql.run("INSERT OR IGNORE INTO conversation_pins VALUES (?)", row.id);
      else {
        this.sql.run(
          "DELETE FROM conversation_pins WHERE session_id IN (SELECT value FROM json_each(?))",
          JSON.stringify(identities(row)),
        );
      }
      return pinned;
    } finally {
      this.#pending.delete(row.id);
    }
  }
}
