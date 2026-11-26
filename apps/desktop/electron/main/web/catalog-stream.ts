import { sessionProviderDeclaration } from "@agentkib/runtime-protocol";
import {
  conversationCatalogPatch,
  rememberConversationCatalogPatch,
  type ConversationCatalogPatch,
} from "@agentkib/web-client";

const MAX_CATALOG_UPDATES = 256;

/** Retain only the latest change for each row while the subscriber is backpressured. */
export class CatalogChanges {
  #changes: Map<string, ConversationCatalogPatch["updates"][number]> | null | undefined;

  get pending(): boolean {
    return this.#changes !== undefined;
  }

  add(payload?: unknown): void {
    if (this.#changes === null) return;
    const patch = conversationCatalogPatch(payload);
    if (!patch) {
      this.#changes = null;
      return;
    }
    const rows = (this.#changes ??= new Map());
    rememberConversationCatalogPatch(rows, patch);
    if (rows.size > MAX_CATALOG_UPDATES) this.#changes = null;
  }

  take(): ConversationCatalogPatch | undefined {
    const rows = this.#changes;
    this.clear();
    return rows ? { updates: [...rows.values()] } : undefined;
  }

  clear(): void {
    this.#changes = undefined;
  }
}

export function scopeCatalogPatch(
  patch: ConversationCatalogPatch,
  workspaceIds: readonly string[],
  trustedLocal: boolean,
): ConversationCatalogPatch {
  const allowed = new Set(workspaceIds);
  return {
    updates: patch.updates.filter(
      (row) => allowed.has(row.workspaceId) && (trustedLocal || row.auxiliary === false),
    ),
  };
}

/** 读取 runtime 快照上的字段；快照不是对象或缺少该字段时返回 undefined。 */
export function snapshotField(snapshot: unknown, key: string): unknown {
  return snapshot !== null && typeof snapshot === "object" && key in snapshot
    ? (snapshot as Record<string, unknown>)[key]
    : undefined;
}

/** 客户端是否接受 gzip；显式的 `gzip;q=0` 视为拒绝。 */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  let wildcard = false;
  for (const entry of (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",")) {
    const [name = "", ...parameters] = entry.split(";").map((part) => part.trim().toLowerCase());
    const quality = parameters.find((part) => part.startsWith("q="));
    const accepted = quality === undefined || Number(quality.slice(2)) > 0;
    if (name === "gzip") return accepted;
    if (name === "*") wildcard = accepted;
  }
  return wildcard;
}
/** Remote clients share Provider declarations and never receive auxiliary sessions. */
export function projectRemoteCatalog(catalog: unknown): unknown {
  const sessions = snapshotField(catalog, "sessions");
  if (!Array.isArray(sessions)) return catalog;
  return {
    ...(catalog as Record<string, unknown>),
    sessions: sessions
      .filter((session) => snapshotField(session, "origin") !== "auxiliary")
      .map((session) => {
        if (!session || typeof session !== "object" || Array.isArray(session)) return session;
        const agent = snapshotField(session, "agent");
        if (typeof agent !== "string") return session;
        const registration = sessionProviderDeclaration(agent);
        return {
          ...session,
          projectAgent: registration?.projectAgent ?? { lead: false, worker: false },
        };
      }),
  };
}
