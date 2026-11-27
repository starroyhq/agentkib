import {
  REMOTE_ERROR_CONTRACT,
  type RemoteErrorCode,
  type RemoteErrorRetry,
} from "./generated/remote-contract";

export type CatalogSourceReason = Exclude<RemoteErrorCode, "antigravity-acp-disabled">;

export interface ConversationCatalogSourceIssue {
  workspaceId: string;
  agent: string;
  reasons: CatalogSourceReason[];
}

const registeredReasons = new Map<string, RemoteErrorRetry>(
  Object.values(REMOTE_ERROR_CONTRACT).map(({ code, retry }) => [code, retry]),
);

export function isCatalogSourceReason(value: unknown): value is CatalogSourceReason {
  // ACP being off is a role eligibility reason, never a failed history read.
  return (
    typeof value === "string" &&
    value !== "antigravity-acp-disabled" &&
    registeredReasons.has(value)
  );
}

export function catalogSourceRetry(reason: string): RemoteErrorRetry | undefined {
  return isCatalogSourceReason(reason) ? registeredReasons.get(reason) : undefined;
}

/** Only project registered failure codes for workspaces in the caller's read scope. */
export function projectCatalogSourceIssues(
  entries: unknown,
  workspaces: ReadonlySet<string>,
): ConversationCatalogSourceIssue[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const { workspaceId, agent, reasons } = entry as Record<string, unknown>;
    if (
      typeof workspaceId !== "string" ||
      !workspaces.has(workspaceId) ||
      typeof agent !== "string" ||
      !agent ||
      !Array.isArray(reasons)
    )
      return [];
    const codes = [...new Set(reasons.filter(isCatalogSourceReason))];
    return codes.length ? [{ workspaceId, agent, reasons: codes }] : [];
  });
}
