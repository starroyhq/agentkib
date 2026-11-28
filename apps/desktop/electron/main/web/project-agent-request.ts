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
  replyScope: (ids: string[]) => Promise<unknown>;
  scopeAllows: (id: string, device: WebDevice) => boolean;
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

type AssignmentScope = Awaited<ReturnType<ProjectAgentRequests["scope"]>>;
type AssignmentContext = {
  sessionId: string;
  admission?: { device: WebDevice; scope: AssignmentScope };
  sessionWorkspaceId?: string;
  probe?: ReturnType<typeof assignmentProbe>;
  targets?: Map<string, string>;
  workers?: string[];
};
type AssignmentOutcome = { ok: true; value: unknown } | { ok: false; error: unknown };

async function finishAssignmentReply(
  deps: ProjectAgentRequests,
  context: AssignmentContext,
  outcome: AssignmentOutcome,
  checkIdentity: () => void,
) {
  const { admission, sessionId, sessionWorkspaceId, probe, targets, workers } = context;
  if (!admission) {
    // Parsing, initial grants and registration lookup cannot have observed any qualification.
    if (!outcome.ok) throw assignmentRefusal(outcome.error);
    throw HttpError.fromContract(errors.accessChanged);
  }
  const {
    device,
    scope: { workspaces },
  } = admission;
  const accessChanged = () => HttpError.fromContract(errors.accessChanged);
  checkIdentity();
  const latest = await deps.freshCatalog().catch(() => {
    throw accessChanged();
  });
  const visible = assignmentCatalog(latest, workspaces);
  const view = outcome.ok && workers ? projectAgentView(outcome.value) : undefined;
  const ids = new Set([
    sessionId,
    ...(probe?.ids ?? []),
    ...(targets?.keys() ?? []),
    ...(view?.lead?.workers.map((worker) => worker.sessionId) ?? []),
    ...(view?.lead?.roleChanges?.map((change) => change.workerSessionId) ?? []),
  ]);
  // The last asynchronous read returns registration and ownership together. Device
  // grants are host state and can be checked synchronously before projecting either outcome.
  const scope = await deps.replyScope([...ids]).catch(() => {
    throw accessChanged();
  });
  checkIdentity();
  const registered = snapshotField(scope, "workspaces");
  if (!Array.isArray(registered)) throw accessChanged();
  const allowed = new Set(
    registered.filter((id) => typeof id === "string" && deps.scopeAllows(id, device)),
  );
  if (allowed.size !== workspaces.length || workspaces.some((id) => !allowed.has(id)))
    throw accessChanged();
  const current = assignmentCatalog(
    {
      workspaces: registered.map((id) => ({ id })),
      sessions: snapshotField(scope, "sessions"),
    },
    workspaces,
  );
  const survives = (id: string) =>
    visible.workspaceById.has(id) &&
    current.workspaceById.get(id) === visible.workspaceById.get(id);
  const sessions = visible.sessions
    .filter(({ id }) => current.visibleIds.has(id) && survives(id))
    .map((row) => ({
      ...row,
      indexedSessionId: undefined,
      indexedSessionIds: [...(visible.aliases.get(row.id) ?? [])].filter(
        (alias) => current.aliases.get(row.id)?.has(alias) && survives(alias),
      ),
    }));
  const verifiedCatalog = { sessions, workspaces: visible.workspaces };
  const verified = assignmentCatalog(verifiedCatalog, workspaces);
  if (!sessionWorkspaceId && !verified.visibleIds.has(sessionId))
    throw HttpError.fromContract(errors.workspaceNotAuthorized);
  if (
    !verified.visibleIds.has(sessionId) ||
    (sessionWorkspaceId && verified.workspaceById.get(sessionId) !== sessionWorkspaceId) ||
    [...(targets ?? [])].some(([id, workspace]) => verified.workspaceById.get(id) !== workspace)
  )
    throw accessChanged();

  if (!outcome.ok) {
    // A qualification failure can refer to any candidate or its native alias.
    if (
      probe?.rows.some(
        ({ id, workspace_id }) =>
          verified.workspaceById.get(id) !== workspace_id ||
          probe.aliases.get(id)?.some((alias) => !verified.aliases.get(id)?.has(alias)),
      )
    )
      throw accessChanged();
    throw assignmentRefusal(outcome.error);
  }
  if (probe)
    return assignmentOptions(
      outcome.value,
      probe,
      workerAssignmentProject(verifiedCatalog, sessionId, workspaces),
    );
  if (
    !view ||
    view.lead?.scope?.workspaceIds.some((id) => !allowed.has(id)) ||
    view.lead?.workers.some(({ sessionId }) => !verified.workspaceById.has(sessionId))
  )
    throw accessChanged();
  const assigned = new Set(view.lead?.workers.map(({ sessionId }) => sessionId));
  if (view.lead?.sessionId !== sessionId || workers?.some((id) => !assigned.has(id)))
    throw HttpError.fromContract(errors.outcomeUnknown);
  const roleChanges = view.lead.roleChanges?.filter(({ workerSessionId }) =>
    verified.workspaceById.has(workerSessionId),
  );
  return { ...view, lead: { ...view.lead, ...(roleChanges && { roleChanges }) } };
}

async function requestAssignment(
  deps: ProjectAgentRequests,
  sessionId: string,
  operation: typeof assignment.optionsOperation | typeof assignment.assignOperation,
  selected: unknown,
  authorizedDevice: () => WebDevice,
) {
  const context: AssignmentContext = { sessionId };
  let identity: string | undefined;
  const checkIdentity = () => {
    if (
      deps.accessIdentity() !== identity ||
      authorizedDevice().id !== context.admission?.device.id
    )
      throw HttpError.fromContract(errors.accessChanged);
  };

  let outcome: AssignmentOutcome;
  try {
    const workers =
      operation === assignment.assignOperation
        ? assignmentWorkers(selected, deps.field)
        : undefined;
    context.workers = workers;
    const device = authorizedDevice();
    identity = deps.accessIdentity();
    const scope = await deps.scope();
    context.admission = { device, scope };
    const { workspaces, token } = scope;
    const session = await deps.session(sessionId);
    const sessionWorkspaceId = session.workspace_id;
    context.sessionWorkspaceId = sessionWorkspaceId;
    if (!workspaces.includes(sessionWorkspaceId))
      throw HttpError.fromContract(errors.workspaceNotAuthorized);

    const catalog = await deps.catalog();
    const project = workerAssignmentProject(catalog, sessionId, workspaces);
    if (project.lead.workspace_id !== sessionWorkspaceId)
      throw HttpError.fromContract(errors.accessChanged);
    let approvedWorkers: Array<{ sessionId: string; workspaceId: string }> | undefined;
    if (workers) {
      const { workspaceById } = assignmentCatalog(catalog, workspaces);
      context.targets = new Map(
        workers.flatMap((id) => (project.visibleIds.has(id) ? [[id, workspaceById.get(id)!]] : [])),
      );
      assertAssignmentWorkers(project, workers, true);
      approvedWorkers = workers.map((id) => ({
        sessionId: id,
        workspaceId: context.targets!.get(id)!,
      }));
      const current = leadState(
        await deps.request({ operation: "lead-status", sessionId, deviceId: device.id }),
      );
      if (current?.scope?.workspaceIds.some((id) => !workspaces.includes(id)))
        throw HttpError.fromContract(errors.workspaceNotAuthorized);
      if (current?.scope?.approvals?.length) deps.grant("approve");
      if ((await deps.scope()).token !== token) throw HttpError.fromContract(errors.accessChanged);
      checkIdentity();
    } else {
      context.probe = assignmentProbe(project);
    }
    const value = await deps.request({
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
      ...(context.probe && { candidateIds: context.probe.ids }),
    });
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error };
  }
  return finishAssignmentReply(deps, context, outcome, checkIdentity);
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
