import {
  PROJECT_AGENT_MAX_WORKERS,
  REMOTE_ERROR_CODES as codes,
  REMOTE_ERROR_CONTRACT as errors,
  REMOTE_PROJECT_AGENT_ASSIGNMENT_CONTRACT as assignment,
  REMOTE_WORKER_ROLE_CONTRACT,
  parseRemoteErrorCode,
  type ProjectAgentAssignmentOptions,
} from "@agentkib/runtime-protocol";
import type { ProjectAgentState } from "@agentkib/web-client";
import { RuntimeRequestError } from "../runtime-host";
import { snapshotField } from "./catalog-stream";
import { HttpError } from "./http-error";
import { projectAgentOperations } from "./project-agent-operations";
import { projectAgentResponseError } from "./project-agent-response-error";
import type { WebDevice } from "./service";
import { assertAssignmentWorkers, workerAssignmentProject } from "./worker-assignment";

type DeviceGrant = "send" | "manage" | "advancedControl" | "settings" | "approve";
type SessionScope = { workspace_id: string };
type ProjectAgentRequests = {
  request: (params: Record<string, unknown>) => Promise<unknown>;
  local: boolean;
  grant: (permission?: DeviceGrant) => WebDevice;
  fullAccess: () => WebDevice;
  workspaceAllowed: (id: string, device: WebDevice) => boolean | Promise<boolean>;
  scope: () => Promise<{ workspaces: string[]; token: string }>;
  catalog: () => Promise<unknown>;
  session: (id: string) => Promise<SessionScope>;
  worker: (id: string) => Promise<SessionScope>;
  field: (value: unknown, max?: number) => string;
};

function assignmentRefusal(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const data = error instanceof RuntimeRequestError ? error.data : undefined;
  const reason =
    parseRemoteErrorCode(snapshotField(data, "reason")) ??
    parseRemoteErrorCode(snapshotField(data, "detail")) ??
    parseRemoteErrorCode(error instanceof Error ? error.message : undefined) ??
    codes.projectAgentFailed;
  const registered = Object.values(errors).find((entry) => entry.code === reason);
  return registered && "http" in registered
    ? HttpError.fromContract(registered, reason)
    : HttpError.fromContract(errors.projectAgentFailed, reason);
}

function assignmentProbe(project: ReturnType<typeof workerAssignmentProject>) {
  const rows = project.candidates.slice(0, 20_000);
  const ids = rows.map(({ id }) => id);
  const usedIds = new Set(project.visibleIds);
  const aliases = new Map<string, string[]>();
  for (const { id, indexedSessionIds } of rows) {
    for (const alias of indexedSessionIds ?? []) {
      if (ids.length === 20_000) break;
      if (usedIds.has(alias)) continue;
      usedIds.add(alias);
      ids.push(alias);
      const linked = aliases.get(id) ?? [];
      linked.push(alias);
      aliases.set(id, linked);
    }
  }
  return { ids, rows, aliases };
}

function assignmentOptions(
  value: unknown,
  { rows, aliases }: ReturnType<typeof assignmentProbe>,
): ProjectAgentAssignmentOptions {
  const result = value as Partial<ProjectAgentAssignmentOptions> | undefined;
  if (
    typeof result?.capable !== "boolean" ||
    typeof result.remaining !== "number" ||
    !Number.isSafeInteger(result.remaining) ||
    result.remaining < 0 ||
    !result.eligibility ||
    !Array.isArray(result.candidates)
  )
    throw HttpError.fromContract(errors.projectAgentFailed);
  const candidates = new Map(
    result.candidates.map((candidate) => [candidate.sessionId, candidate]),
  );
  const reason = parseRemoteErrorCode(result.reason);
  return {
    capable: result.capable,
    remaining: result.remaining,
    ...(reason && { reason }),
    eligibility: result.eligibility,
    candidates: rows.flatMap(({ id }) => {
      const current = candidates.get(id);
      if (!current) return [];
      // Old assignments may still use the native index ID for this conversation.
      const assigned = (aliases.get(id) ?? [])
        .map((alias) => candidates.get(alias))
        .find(
          (candidate) =>
            candidate?.reason === codes.sessionIsAWorker ||
            candidate?.reason === codes.sessionIsAProjectAgent,
        );
      const view =
        current.reason === codes.sessionIsAWorker || current.reason === codes.sessionIsAProjectAgent
          ? current
          : (assigned ?? current);
      return [
        {
          sessionId: id,
          reason:
            view.reason === null
              ? null
              : (parseRemoteErrorCode(view.reason) ?? codes.workerProbeFailed),
          ...(view.assigned === true && { assigned: true as const }),
          ...(view.eligibility && { eligibility: view.eligibility }),
        },
      ];
    }),
  };
}

/** Paired reads are scoped by the current grants; assignment uses the same grants as settings. */
export async function requestProjectAgent(
  method: "GET" | "POST",
  body: Record<string, unknown>,
  deps: ProjectAgentRequests,
) {
  const listing = body.operation === assignment.optionsOperation;
  const assigning = body.operation === assignment.assignOperation;
  const fields = listing
    ? ["sessionId", "operation"]
    : assigning
      ? ["sessionId", "operation", "workers"]
      : ["sessionId", "operation", "scope", "worker", "role"];
  if (Object.keys(body).some((key) => !fields.includes(key)))
    throw HttpError.fromContract(errors.invalidInput);
  const sessionId = deps.field(body.sessionId);
  const operation = deps.field(body.operation, 32);
  const spec =
    Object.hasOwn(projectAgentOperations, operation) && projectAgentOperations[operation];
  if (
    !spec ||
    (listing && method !== "GET") ||
    (method === "GET" && !listing && operation !== "status")
  )
    throw HttpError.fromContract(errors.invalidOperation);
  const editingRole = operation === REMOTE_WORKER_ROLE_CONTRACT.operation;
  if (editingRole !== Object.hasOwn(body, "role"))
    throw HttpError.fromContract(errors.invalidInput);
  const authorizedDevice = () => {
    if (!spec.grants.length) return deps.grant();
    const device = deps.fullAccess();
    for (const permission of spec.grants) deps.grant(permission);
    return device;
  };
  const device = authorizedDevice();
  const session = await deps.session(sessionId);
  const lead = (value: unknown) =>
    (snapshotField(value, "lead") as ProjectAgentState | undefined) ?? null;
  const readScope =
    listing || assigning || (operation === "status" && !deps.local)
      ? await deps.scope()
      : undefined;
  let authorizedWorkspaceIds = readScope?.workspaces;
  if (readScope && !readScope.workspaces.includes(session.workspace_id))
    throw HttpError.fromContract(errors.workspaceNotAuthorized);

  const reportError = (error: unknown): never => {
    if (listing || assigning) throw assignmentRefusal(error);
    const { status, code, reason } = projectAgentResponseError(error, editingRole);
    throw new HttpError(status, code, undefined, reason);
  };
  let workers: string[] | undefined;
  let probe: ReturnType<typeof assignmentProbe> | undefined;
  if (assigning || listing) {
    if (assigning) {
      const selected = body.workers;
      if (
        !Array.isArray(selected) ||
        selected.length < 1 ||
        selected.length > PROJECT_AGENT_MAX_WORKERS
      )
        throw HttpError.fromContract(errors.invalidInput);
      workers = selected.map((value) => deps.field(value));
      if (new Set(workers).size !== workers.length)
        throw HttpError.fromContract(errors.invalidInput);
    }
    try {
      const project = workerAssignmentProject(
        await deps.catalog(),
        sessionId,
        authorizedWorkspaceIds,
      );
      if (workers) assertAssignmentWorkers(project, workers, true);
      else probe = assignmentProbe(project);
    } catch (error) {
      reportError(error);
    }
  }
  const worker = spec.needsWorker ? deps.field(body.worker) : undefined;
  if (worker) await deps.worker(worker);
  let scope: Record<string, unknown> | undefined;
  if (operation === "designate" || operation === "update") {
    if (!body.scope || typeof body.scope !== "object" || Array.isArray(body.scope))
      throw HttpError.fromContract(errors.invalidInput);
    scope = Object.fromEntries(
      Object.entries(body.scope).filter(([key]) =>
        ["approvals", "answers", "maxAutoTurns", "stallMinutes"].includes(key),
      ),
    );
  }
  if (spec.checkCurrent) {
    const lookup = deps.request({ operation: "lead-status", sessionId, deviceId: device.id });
    const current = lead(await (assigning ? lookup.catch(reportError) : lookup));
    if (!current && !assigning) throw HttpError.fromContract(errors.leadUnavailable);
    const currentWorkspaceIds: string[] = [];
    for (const id of current?.scope?.workspaceIds ?? []) {
      if (
        typeof id !== "string" ||
        !(readScope ? readScope.workspaces.includes(id) : await deps.workspaceAllowed(id, device))
      )
        throw HttpError.fromContract(errors.workspaceNotAuthorized);
      currentWorkspaceIds.push(id);
    }
    authorizedWorkspaceIds ??= currentWorkspaceIds;
    const approvals = Array.isArray(scope?.approvals) ? scope.approvals : current?.scope?.approvals;
    if (approvals?.length) deps.grant("approve");
  } else if (Array.isArray(scope?.approvals) && scope.approvals.length) {
    deps.grant("approve");
  }

  const checkScope = async () => {
    if (
      readScope &&
      ((await deps.session(sessionId)).workspace_id !== session.workspace_id ||
        (await deps.scope()).token !== readScope.token)
    )
      throw HttpError.fromContract(errors.accessChanged);
  };
  if (assigning) {
    await checkScope();
    if (authorizedDevice().id !== device.id) throw HttpError.fromContract(errors.accessEnded);
  }
  const result = await deps
    .request({
      operation: spec.backend,
      sessionId,
      deviceId: device.id,
      ...(scope ? { scope } : {}),
      ...(authorizedWorkspaceIds ? { authorizedWorkspaceIds } : {}),
      ...(worker ? { worker } : {}),
      ...(editingRole ? { role: body.role } : {}),
      ...(workers ? { workers, mayDelegateApprovals: device.approve === true } : {}),
      ...(probe ? { candidateIds: probe.ids } : {}),
    })
    .catch(reportError);
  await checkScope();
  if (deps.grant().id !== device.id) throw HttpError.fromContract(errors.accessEnded);
  if (probe) return assignmentOptions(result, probe);
  return {
    lead: lead(result),
    capable: snapshotField(result, "capable") === true,
    eligibility: snapshotField(result, "eligibility"),
  };
}
