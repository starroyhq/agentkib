import { REMOTE_ERROR_CODES } from "./generated/remote-contract";

export type CatalogSourceReason = (typeof REMOTE_ERROR_CODES)[keyof typeof REMOTE_ERROR_CODES];

export interface ConversationCatalogSourceIssue {
  workspaceId: string;
  agent: string;
  reasons: CatalogSourceReason[];
}

const registeredReasons = new Set<string>(Object.values(REMOTE_ERROR_CODES));

export function isCatalogSourceReason(value: unknown): value is CatalogSourceReason {
  return typeof value === "string" && registeredReasons.has(value);
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
