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
import {
  assignmentCatalog,
  assertAssignmentWorkers,
  workerAssignmentProject,
} from "./worker-assignment";

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
  freshCatalog: () => Promise<unknown>;
  accessIdentity: () => string;
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
  const aliases = new Map<string, string[]>();
  for (const { id } of rows) {
    for (const alias of project.aliases.get(id) ?? []) {
      if (ids.length === 20_000) break;
      ids.push(alias);
      const linked = aliases.get(id) ?? [];
      linked.push(alias);
      aliases.set(id, linked);
    }
  }
  return { ids, rows, aliases, projectKey: project.projectKey };
}

function assignmentOptions(
  value: unknown,
  { rows, aliases, projectKey }: ReturnType<typeof assignmentProbe>,
  latest: ReturnType<typeof workerAssignmentProject>,
): ProjectAgentAssignmentOptions {
  if (latest.projectKey !== projectKey) throw HttpError.fromContract(errors.accessChanged);
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
  const workspaces = new Map(latest.candidates.map(({ id, workspace_id }) => [id, workspace_id]));
  return {
    capable: result.capable,
    remaining: result.remaining,
    ...(reason && { reason }),
    eligibility: result.eligibility,
    candidates: rows.flatMap(({ id, workspace_id }) => {
      if (workspaces.get(id) !== workspace_id) return [];
      const current = candidates.get(id);
      if (!current) return [];
      // Old assignments may still use the native index ID for this conversation.
      const assigned = (aliases.get(id) ?? [])
        .filter((alias) => latest.aliases.get(id)?.has(alias))
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

const leadState = (value: unknown) =>
  (snapshotField(value, "lead") as ProjectAgentState | undefined) ?? null;

function projectAgentView(value: unknown) {
  return {
    lead: leadState(value),
    capable: snapshotField(value, "capable") === true,
    eligibility: snapshotField(value, "eligibility"),
  };
}

function assignmentWorkers(selected: unknown, field: ProjectAgentRequests["field"]) {
  if (
    !Array.isArray(selected) ||
    selected.length < 1 ||
    selected.length > PROJECT_AGENT_MAX_WORKERS
  )
    throw HttpError.fromContract(errors.invalidInput);
  const workers = selected.map((value) => field(value));
  if (new Set(workers).size !== workers.length) throw HttpError.fromContract(errors.invalidInput);
  return workers;
}

async function requestAssignment(
  deps: ProjectAgentRequests,
  sessionId: string,
  operation: typeof assignment.optionsOperation | typeof assignment.assignOperation,
  selected: unknown,
  authorizedDevice: () => WebDevice,
) {
  const writing = operation === assignment.assignOperation;
  const workers = writing ? assignmentWorkers(selected, deps.field) : undefined;
  const device = authorizedDevice();
  const identity = deps.accessIdentity();
  const { workspaces, token } = await deps.scope();
  let sessionWorkspaceId: string | undefined;
  let probe: ReturnType<typeof assignmentProbe> | undefined;
  let visibleTargets: string[] | undefined;
  let approvedWorkers: Array<{ sessionId: string; workspaceId: string }> | undefined;

  const checkIdentity = () => {
    if (deps.accessIdentity() !== identity || authorizedDevice().id !== device.id)
      throw HttpError.fromContract(errors.accessChanged);
  };
  const checkScope = async () => {
    if ((await deps.scope()).token !== token) throw HttpError.fromContract(errors.accessChanged);
    checkIdentity();
  };
  const currentCatalog = async () => {
    await checkScope();
    // No in-flight catalog read can stand in for this check after the operation has settled.
    const latest = await deps.freshCatalog().catch(() => {
      throw HttpError.fromContract(errors.accessChanged);
    });
    const visible = assignmentCatalog(latest, workspaces);
    const workspace = visible.workspaceById.get(sessionId);
    if (!sessionWorkspaceId && !visible.visibleIds.has(sessionId))
      throw HttpError.fromContract(errors.workspaceNotAuthorized);
    // The submitted lead must remain a catalog session in the originally authorized workspace.
    if (
      !visible.visibleIds.has(sessionId) ||
      (sessionWorkspaceId && workspace !== sessionWorkspaceId) ||
      visibleTargets?.some((id) => !visible.visibleIds.has(id))
    )
      throw HttpError.fromContract(errors.accessChanged);
    checkIdentity();
    return { latest, visible };
  };

  let result: unknown;
  try {
    const session = await deps.session(sessionId);
    sessionWorkspaceId = session.workspace_id;
    if (!workspaces.includes(sessionWorkspaceId))
      throw HttpError.fromContract(errors.workspaceNotAuthorized);

    const project = workerAssignmentProject(await deps.catalog(), sessionId, workspaces);
    if (project.lead.workspace_id !== sessionWorkspaceId)
      throw HttpError.fromContract(errors.accessChanged);
    if (workers) {
      visibleTargets = workers.filter((id) => project.visibleIds.has(id));
      assertAssignmentWorkers(project, workers, true);
      const candidateWorkspaces = new Map(
        project.candidates.map((row) => [row.id, row.workspace_id]),
      );
      approvedWorkers = workers.map((id) => ({
        sessionId: id,
        workspaceId: candidateWorkspaces.get(id)!,
      }));
      const current = leadState(
        await deps.request({ operation: "lead-status", sessionId, deviceId: device.id }),
      );
      if (current?.scope?.workspaceIds.some((id) => !workspaces.includes(id)))
        throw HttpError.fromContract(errors.workspaceNotAuthorized);
      if (current?.scope?.approvals?.length) deps.grant("approve");
      await checkScope();
    } else {
      probe = assignmentProbe(project);
    }
    result = await deps.request({
      operation,
      sessionId,
      deviceId: device.id,
      authorizedWorkspaceIds: workspaces,
      ...(workers && {
        workers,
        assignmentProject: {
          leadWorkspaceId: sessionWorkspaceId,
          projectKey: project.projectKey,
          workers: approvedWorkers,
        },
        mayDelegateApprovals: device.approve === true,
      }),
      ...(probe && { candidateIds: probe.ids }),
    });
  } catch (error) {
    const { visible } = await currentCatalog();
    // A failed probe must not explain a candidate that has since left the authorized scope.
    if (probe?.ids.some((id) => !visible.workspaceById.has(id)))
      throw HttpError.fromContract(errors.accessChanged);
    throw assignmentRefusal(error);
  }

  const { latest, visible } = await currentCatalog();
  if (probe)
    return assignmentOptions(result, probe, workerAssignmentProject(latest, sessionId, workspaces));
  const view = projectAgentView(result);
  if (
    view.lead?.scope?.workspaceIds.some((id) => !workspaces.includes(id)) ||
    view.lead?.workers.some(({ sessionId }) => !visible.workspaceById.has(sessionId))
  )
    throw HttpError.fromContract(errors.accessChanged);
  const assigned = new Set(view.lead?.workers.map(({ sessionId }) => sessionId));
  if (view.lead?.sessionId !== sessionId || workers?.some((id) => !assigned.has(id)))
    throw HttpError.fromContract(errors.outcomeUnknown);
  return view;
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
  if (listing || assigning)
    return requestAssignment(
      deps,
      sessionId,
      assigning ? assignment.assignOperation : assignment.optionsOperation,
      body.workers,
      authorizedDevice,
    );

  const device = authorizedDevice();
  const session = await deps.session(sessionId);
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
  const statusScope = operation === "status" && !deps.local ? await deps.scope() : undefined;
  let authorizedWorkspaceIds = statusScope?.workspaces;
  if (statusScope && !statusScope.workspaces.includes(session.workspace_id))
    throw HttpError.fromContract(errors.workspaceNotAuthorized);
  if (spec.checkCurrent) {
    const current = leadState(
      await deps.request({ operation: "lead-status", sessionId, deviceId: device.id }),
    );
    if (!current) throw HttpError.fromContract(errors.leadUnavailable);
    authorizedWorkspaceIds = [];
    for (const id of current.scope?.workspaceIds ?? []) {
      if (typeof id !== "string" || !(await deps.workspaceAllowed(id, device)))
        throw HttpError.fromContract(errors.workspaceNotAuthorized);
      authorizedWorkspaceIds.push(id);
    }
    const approvals = Array.isArray(scope?.approvals) ? scope.approvals : current.scope?.approvals;
    if (approvals?.length) deps.grant("approve");
  } else if (Array.isArray(scope?.approvals) && scope.approvals.length) {
    deps.grant("approve");
  }

  const result = await deps
    .request({
      operation: spec.backend,
      sessionId,
      deviceId: device.id,
      ...(scope && { scope }),
      ...(authorizedWorkspaceIds && { authorizedWorkspaceIds }),
      ...(worker && { worker }),
      ...(editingRole && { role: body.role }),
    })
    .catch((error: unknown) => {
      const { status, code, reason } = projectAgentResponseError(error, editingRole);
      throw new HttpError(status, code, undefined, reason);
    });
  if (
    statusScope &&
    ((await deps.session(sessionId)).workspace_id !== session.workspace_id ||
      (await deps.scope()).token !== statusScope.token)
  )
    throw HttpError.fromContract(errors.accessChanged);
  if (deps.grant().id !== device.id) throw HttpError.fromContract(errors.accessEnded);
  return projectAgentView(result);
}
