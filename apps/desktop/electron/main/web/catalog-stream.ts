import { projectCatalogSourceIssues, sessionProviderDeclaration } from "@agentkib/runtime-protocol";
import {
  conversationCatalogPatch,
  needsCatalogPatchV2,
  rememberConversationCatalogPatch,
  type ConversationCatalogPatch,
} from "@agentkib/web-client";

const MAX_CATALOG_UPDATES = 256;
// Leave room for the surrounding SSE frame and payload envelope.
const MAX_CATALOG_PATCH_BYTES = 4 * 1024 * 1024 - 1024;

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
    if (!rows) return undefined;
    const patch = { updates: [...rows.values()] };
    return Buffer.byteLength(JSON.stringify(patch)) <= MAX_CATALOG_PATCH_BYTES ? patch : undefined;
  }

  clear(): void {
    this.#changes = undefined;
  }
}

export function scopeCatalogPatch(
  patch: ConversationCatalogPatch,
  workspaceIds: readonly string[],
  trustedLocal: boolean,
  version: 1 | 2 = 1,
): ConversationCatalogPatch | undefined {
  const allowed = new Set(workspaceIds);
  const updates = patch.updates
    .filter(
      (update) => allowed.has(update.workspaceId) && (trustedLocal || update.auxiliary === false),
    )
    .map((update) =>
      !trustedLocal && update.row ? { ...update, row: projectRemoteRow(update.row) } : update,
    );
  const scoped = { updates };
  // Legacy catalog patch v1 cannot represent all directory changes.
  if (version === 1 && needsCatalogPatchV2(scoped)) return undefined;
  return scoped;
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
/** Scope source diagnostics, along with records that require fresh registration for full access. */
export function projectCatalogReadScope(
  catalog: unknown,
  workspaceIds: readonly string[],
  fullAccess: boolean,
): unknown {
  const visible = new Set(workspaceIds);
  const projection = {
    ...(catalog as {
      workspaces?: { id: string }[];
      sessions?: { workspace_id: string }[];
      complete?: boolean;
      sourceIssues?: unknown;
      incompleteSources?: unknown;
    }),
  };
  const sourceIssues = projectCatalogSourceIssues(projection.sourceIssues, visible);
  delete projection.sourceIssues;
  if (sourceIssues.length) projection.sourceIssues = sourceIssues;
  if (fullAccess) {
    projection.workspaces = projection.workspaces?.filter(({ id }) => visible.has(id));
    projection.sessions = projection.sessions?.filter(({ workspace_id }) =>
      visible.has(workspace_id),
    );
  }
  if (Array.isArray(projection.incompleteSources)) {
    const incompleteSources = projection.incompleteSources.flatMap((entry: unknown) => {
      const workspaceId = snapshotField(entry, "workspaceId");
      const agent = snapshotField(entry, "agent");
      return typeof workspaceId === "string" &&
        visible.has(workspaceId) &&
        typeof agent === "string"
        ? [{ workspaceId, agent }]
        : [];
    });
    projection.incompleteSources = incompleteSources;
    // With unknown managed coverage the provider omits the list and reports global incompleteness.
    if (projection.complete === false) projection.complete = incompleteSources.length === 0;
  }
  return projection;
}

function projectRemoteRow<T>(session: T): T {
  const agent = snapshotField(session, "agent");
  if (typeof agent !== "string") return session;
  const registration = sessionProviderDeclaration(agent);
  return {
    ...session,
    projectAgent: registration?.projectAgent ?? { lead: false, worker: false },
  };
}

/** Remote clients share Provider declarations and never receive auxiliary sessions. */
export function projectRemoteCatalog(catalog: unknown): unknown {
  const sessions = snapshotField(catalog, "sessions");
  if (!Array.isArray(sessions)) return catalog;
  return {
    ...(catalog as Record<string, unknown>),
    sessions: sessions
      .filter((session) => snapshotField(session, "origin") !== "auxiliary")
      .map(projectRemoteRow),
  };
}
