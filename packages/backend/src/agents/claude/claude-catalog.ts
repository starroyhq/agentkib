import { readUnknownManagedCommandsBySession } from "../../managed-ledger";
import { isCatalogRecord } from "../../session-catalog-stream";
import type { ClaudeBridge } from "./claude-bridge";
import { claudeExecutionSource } from "./claude-execution";
import type { ClaudeManagedReadOwner } from "./claude-managed-read";

export function readClaudeCatalog(managed: ClaudeManagedReadOwner, bridge?: ClaudeBridge) {
  const unknown = readUnknownManagedCommandsBySession(managed.dataDir);
  const owners = new Set<string>();
  const records = managed.catalog(undefined, true, { owners, commands: unknown ?? new Map() });
  const managedIds = new Set(records.map((record) => record.id));

  function project(row: Record<string, unknown>, id: string) {
    if (!unknown)
      return {
        ...row,
        continuation: {
          status: "outcome-unknown",
          executionLocation: null,
          reason: "control-outcome-unconfirmed",
        },
      };
    const commands = unknown.get(id) ?? [];
    const owned = owners.has(id);
    const projection = row.continuation;
    let live = managedIds.has(id)
      ? isCatalogRecord(projection)
        ? projection
        : undefined
      : managed.catalogContinuation(id, undefined, commands.length > 0);
    if (!owned && live?.executionLocation === "agentkib")
      live = live.status === "outcome-unknown" ? { ...live, executionLocation: null } : undefined;
    let source;
    try {
      source = claudeExecutionSource(id, undefined, bridge, { owned, commands });
      if (source === "terminal") live = bridge?.live(id, false, commands);
    } catch {
      // A broken connection registry must not prevent read-only catalog access.
      if (live?.status !== "outcome-unknown")
        live = {
          status: "unsupported",
          executionLocation: null,
          reason: "claude-bridge-registry-invalid",
        };
    }
    const externalTurn =
      live?.status !== "outcome-unknown" &&
      !["terminal", "agentkib"].includes(String(live?.executionLocation))
        ? managed.externalTurn(id)
        : undefined;
    if (source === "agentkib" && !live && !externalTurn)
      live = { status: "idle", executionLocation: "agentkib" };
    const observed = externalTurn ? { ...row, externalTurn } : row;
    if (!live) return observed;
    const { status, executionLocation, ownershipReason, reason, backgroundTasks } = live;
    return {
      ...observed,
      continuation: {
        status,
        executionLocation,
        ownershipReason,
        reason,
        ...(typeof backgroundTasks === "number" && { backgroundTasks }),
      },
    };
  }
  return { records, project };
}
