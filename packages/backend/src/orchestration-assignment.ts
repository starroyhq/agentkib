import {
  PROJECT_AGENT_MAX_WORKERS,
  REMOTE_ERROR_CODES as codes,
  projectAgentRoleReason,
  type ProjectAgentAssignmentCandidate,
  type ProjectAgentAssignmentOptions,
  type ProjectAgentLeadEligibility,
  type ProjectAgentWorkerEligibility,
} from "@agentkib/runtime-protocol";
import { effectiveLeadScope, type Lead } from "./orchestration-registry";

/** A device revocation invalidates its in-flight assignments even before it owns a lead. */
export class ActiveAssignmentAdmissions {
  readonly #devices = new Map<string, Set<AbortController>>();

  track(deviceId: string) {
    const controller = new AbortController();
    const active = this.#devices.get(deviceId) ?? new Set<AbortController>();
    active.add(controller);
    this.#devices.set(deviceId, active);
    return {
      signal: controller.signal,
      release: () => {
        if (active.delete(controller) && !active.size) this.#devices.delete(deviceId);
      },
    };
  }

  invalidate(deviceId: string): void {
    for (const controller of this.#devices.get(deviceId) ?? [])
      controller.abort(new Error(codes.accessChanged));
  }
}

type WorkspaceOf = (sessionId: string) => string | undefined;

export function assignmentWorkspaceAccess(
  authorizedWorkspaceIds: readonly string[] | undefined,
  workspaceOf: WorkspaceOf,
) {
  const scope = authorizedWorkspaceIds && new Set(authorizedWorkspaceIds);
  const permits = (id: string, expected?: string) => {
    if (!scope) return true;
    const workspace = workspaceOf(id);
    return (
      !!workspace && scope.has(workspace) && (expected === undefined || workspace === expected)
    );
  };
  return {
    permits,
    require(id: string, expected?: string) {
      if (!permits(id, expected)) throw new Error(codes.workspaceNotAuthorized);
    },
  };
}

export async function projectAssignmentOptions(input: {
  sessionId: string;
  workspaceId: string;
  candidateIds: string[];
  authorizedWorkspaceIds?: readonly string[];
  workspaceOf: WorkspaceOf;
  leads: () => Lead[];
  leadEligibility: () => Promise<ProjectAgentLeadEligibility>;
  workerEligibility: (id: string) => Promise<ProjectAgentWorkerEligibility>;
}): Promise<ProjectAgentAssignmentOptions> {
  const { sessionId, workspaceId, authorizedWorkspaceIds } = input;
  const access = assignmentWorkspaceAccess(authorizedWorkspaceIds, input.workspaceOf);
  access.require(sessionId, workspaceId);
  const leads = input.leads();
  const lead = leads.find((item) => item.sessionId === sessionId);
  const leadIds = new Set(leads.map((item) => item.sessionId));
  const workerOwners = new Map(
    leads.flatMap((item) => item.lanes.map((lane) => [lane.sessionId, item.sessionId] as const)),
  );
  const eligibility = await input.leadEligibility();
  const candidates = await Promise.all(
    input.candidateIds
      .filter((id) => access.permits(id))
      .map(async (id): Promise<ProjectAgentAssignmentCandidate> => {
        if (id === sessionId || leadIds.has(id))
          return { sessionId: id, reason: codes.sessionIsAProjectAgent };
        const owner = workerOwners.get(id);
        if (owner)
          return {
            sessionId: id,
            reason: codes.sessionIsAWorker,
            ...(owner === sessionId ? { assigned: true as const } : {}),
          };
        try {
          const candidate = await input.workerEligibility(id);
          return {
            sessionId: id,
            reason: candidate.availability.available ? null : candidate.availability.reason,
            eligibility: candidate,
          };
        } catch (error) {
          return {
            sessionId: id,
            reason:
              projectAgentRoleReason(error instanceof Error ? error.message : undefined) ??
              codes.workerProbeFailed,
          };
        }
      }),
  );
  access.require(sessionId, workspaceId);
  const scopeDenied =
    lead &&
    authorizedWorkspaceIds &&
    (effectiveLeadScope(lead, workspaceId, []).workspaceIds.some(
      (id) => !authorizedWorkspaceIds.includes(id),
    ) ||
      lead.lanes.some((lane) => !access.permits(lane.sessionId, lane.workspaceId)));
  const capable = eligibility.availability.available;
  const reason = scopeDenied
    ? codes.workspaceNotAuthorized
    : lead?.paused
      ? codes.delegationPaused
      : eligibility.availability.available
        ? undefined
        : eligibility.availability.reason;
  return {
    capable,
    eligibility,
    remaining:
      capable && !lead?.paused && !scopeDenied
        ? Math.max(0, PROJECT_AGENT_MAX_WORKERS - (lead?.lanes.length ?? 0))
        : 0,
    ...(reason ? { reason } : {}),
    candidates: candidates.filter(({ sessionId }) => access.permits(sessionId)),
  };
}
