// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REMOTE_ERROR_CODES as codes,
  REMOTE_ERROR_CONTRACT,
  REMOTE_CONTROL_OUTCOMES as outcomes,
  REMOTE_PROJECT_AGENT_ASSIGNMENT_CONTRACT as assignment,
} from "@agentkib/runtime-protocol";
import { RuntimeRequestError } from "../runtime-host";
import { WebAccessService, type WebAccessLevel } from "./service";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";

// A Project Agent set up, read and managed from Web or a phone: what each device may do, and
// that the backend hears it in that device's name.

describe("Project Agent from a paired device", () => {
  let service: WebAccessService;
  let directory: string;
  let origin: string;
  let port: number;
  let registered: string[];
  let indexedWorkerId: string | undefined;
  let workerWorkspace: string;
  let detachedAlias: string | undefined;
  const deferred = () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ready, release };
  };
  const lead = {
    sessionId: "claude-session",
    paused: false,
    reason: null,
    scope: {
      workspaceIds: ["first"],
      policies: [] as string[],
      maxLanes: 10,
      approvals: [] as string[],
    },
    workers: [] as { sessionId: string }[],
  };
  const worktree = (id: string, kind: string) => ({
    id,
    name: id,
    path: join(directory, id),
    checkout: { repository_group_id: "focus", kind, status: "present" },
  });
  const runtime = vi.fn(async (input: unknown): Promise<unknown> => {
    const params = input as { operation: string; sessionIds?: string[] };
    if (params.operation !== "catalog" && params.operation !== "assignment-reply-scope") return {};
    const sessions: {
      id: string;
      agent: string;
      workspace_id: string;
      indexedSessionIds?: string[];
      archived?: boolean;
    }[] = [
      { id: "claude-session", agent: "claude-code", workspace_id: "first" },
      { id: "devin-session", agent: "devin", workspace_id: "first" },
      { id: "antigravity-session", agent: "antigravity", workspace_id: "first" },
      {
        id: "codex-worker",
        agent: "codex",
        workspace_id: workerWorkspace,
        ...(indexedWorkerId && { indexedSessionIds: [indexedWorkerId] }),
      },
      { id: "cursor-session", agent: "cursor", workspace_id: "first" },
      { id: "second-worker", agent: "codex", workspace_id: "second" },
      { id: "other-worker", agent: "codex", workspace_id: "other" },
      { id: "archived-worker", agent: "codex", workspace_id: "first", archived: true },
      ...(detachedAlias ? [{ id: detachedAlias, agent: "codex", workspace_id: "other" }] : []),
    ];
    if (params.operation === "assignment-reply-scope") {
      const requested = new Set(params.sessionIds);
      return {
        workspaces: [...registered],
        sessions: sessions.filter(
          (session) =>
            requested.has(session.id) ||
            session.indexedSessionIds?.some((alias) => requested.has(alias)),
        ),
      };
    }
    return {
      workspaces: [
        worktree("first", "primary"),
        worktree("second", "worktree"),
        { id: "other", name: "Other", path: join(directory, "other") },
      ],
      sessions: sessions.map((session) => ({ ...session, availability: "readable" })),
    };
  });
  const managed = vi.fn(async (input: unknown): Promise<unknown> => {
    const params = input as { operation: string; sessionId: string };
    if (params.operation === "lead-status") return { lead: currentLead, capable: true };
    if (params.operation === "lead-designate")
      return { lead: { ...lead, sessionId: params.sessionId }, capable: true };
    return { lead: currentLead };
  });
  let currentLead: typeof lead | null = null;

  async function browser() {
    const initial = await fetch(`${origin}/api/web/v1/access`);
    const access = await initial.json();
    const cookie = initial.headers.get("set-cookie")!.split(";")[0]!;
    return {
      cookie,
      async api(path: string, body?: unknown) {
        const response = await fetch(`${origin}/api/web/v1/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "X-CSRF-Token": access.csrfToken,
            "X-AgentKib-Protocol": "2",
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, data: await response.json() };
      },
    };
  }
  async function scopedBrowser(controls = false) {
    const device = await browser();
    const id = await approveLegacyBrowser(service, device.cookie, {
      send: controls,
      approve: controls,
      manage: controls,
    });
    return { ...device, id };
  }
  async function phone(access?: WebAccessLevel) {
    const device = await browser();
    const code = (await service.request({ operation: "generate-code", access })).code!.value;
    const paired = await device.api("pair", { code, name: "Phone" });
    expect(paired.data.status).toBe("approved");
    return { ...device, id: String(paired.data.device.id) };
  }
  const leadCalls = () =>
    managed.mock.calls
      .map(([value]) => value as Record<string, unknown>)
      .filter((value) => String(value.operation).startsWith("lead-"));
  const invalidations = () =>
    managed.mock.calls
      .map(([value]) => value as Record<string, unknown>)
      .filter((value) => value.operation === "schedule-invalidate");

  async function startService(verifiedClaudeManaged = true) {
    directory = await mkdtemp(join(tmpdir(), "ak-project-agent-route-"));
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    service = new WebAccessService({
      dataDir: directory,
      staticDir: directory,
      runtimeRequest: runtime,
      claudeManagedRequest: managed,
      receiptRequest: async () => ({ found: false }),
      workspaceRequest: async () =>
        [
          { id: "first", name: "First", path: directory },
          { id: "second", name: "Second", path: join(directory, "second") },
          { id: "other", name: "Other", path: join(directory, "other") },
        ].filter(({ id }) => registered.includes(id)),
      verifiedClaudeManaged,
      verifiedDevinManaged: true,
      verifiedAntigravityManaged: true,
    });
    await service.initialize();
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: false,
      allowedWorkspaceIds: ["first"],
    });
  }
  beforeEach(() => {
    runtime.mockClear();
    managed.mockClear();
    currentLead = null;
    registered = ["first", "second"];
    indexedWorkerId = undefined;
    detachedAlias = undefined;
    workerWorkspace = "first";
  });
  afterEach(async () => {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  it("publishes independent Project Agent and Worker declarations in the paired catalog", async () => {
    await startService(false);
    const device = await phone();
    const result = await device.api("catalog");
    expect(result.status).toBe(200);
    expect(result.data.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "devin-session",
          projectAgent: { lead: true, worker: true },
        }),
        expect.objectContaining({
          id: "antigravity-session",
          projectAgent: { lead: true, worker: true },
        }),
        expect.objectContaining({
          id: "cursor-session",
          projectAgent: { lead: false, worker: false },
        }),
      ]),
    );
  });

  const assignmentPath = `managed/project-agent?sessionId=claude-session&operation=${assignment.optionsOperation}`;
  const assignWorkers = (workers: string[]) => ({
    sessionId: "claude-session",
    operation: assignment.assignOperation,
    workers,
  });
  const eligibility = {
    executionSide: "agentkib",
    availability: { available: true },
    toolsReady: null,
  };

  it("advertises assignment to paired readers and probes only their project sessions", async () => {
    await startService();
    const unpaired = await browser();
    expect((await unpaired.api("access")).data.projectAgentAssignmentVersion).toBeUndefined();
    const device = await scopedBrowser();
    expect((await device.api("access")).data.projectAgentAssignmentVersion).toBe(1);
    const candidate = {
      sessionId: "codex-worker",
      reason: null,
      eligibility: {
        executionSide: "agentkib",
        availability: { available: true },
        actions: { send: true },
      },
    };
    managed.mockResolvedValueOnce({
      capable: true,
      remaining: 4,
      reason: codes.delegationPaused,
      eligibility,
      candidates: [candidate, { sessionId: "second-worker", reason: null }],
    });

    expect(await device.api(assignmentPath)).toEqual({
      status: 200,
      data: {
        capable: true,
        remaining: 4,
        reason: codes.delegationPaused,
        eligibility,
        candidates: [candidate],
      },
    });
    const probe = leadCalls()[0]!;
    expect(probe).toMatchObject({
      operation: assignment.optionsOperation,
      sessionId: "claude-session",
      deviceId: device.id,
      authorizedWorkspaceIds: ["first"],
    });
    expect(new Set(probe.candidateIds as string[])).toEqual(
      new Set(["codex-worker", "devin-session", "antigravity-session", "cursor-session"]),
    );
    expect(await device.api("managed/project-agent", assignWorkers(["codex-worker"]))).toEqual({
      status: 403,
      data: { error: codes.permissionDenied, controlOutcome: outcomes.notDispatched },
    });
    const readToken = await phone("read");
    expect(
      await readToken.api("managed/project-agent", assignWorkers(["codex-worker"])),
    ).toMatchObject({
      status: 403,
      data: { error: codes.permissionDenied },
    });
    expect(leadCalls()).toHaveLength(1);
  });

  it("projects an older indexed Worker assignment onto its authorized catalog ID", async () => {
    await startService();
    indexedWorkerId = "old-codex-worker";
    const device = await phone();
    managed.mockResolvedValueOnce({
      capable: true,
      remaining: 6,
      eligibility,
      candidates: [
        { sessionId: "codex-worker", reason: null },
        { sessionId: indexedWorkerId, reason: codes.sessionIsAWorker, assigned: true },
      ],
    });
    expect(await device.api(assignmentPath)).toEqual({
      status: 200,
      data: {
        capable: true,
        remaining: 6,
        eligibility,
        candidates: [{ sessionId: "codex-worker", reason: codes.sessionIsAWorker, assigned: true }],
      },
    });
    expect(leadCalls()[0]).toMatchObject({
      candidateIds: expect.arrayContaining(["codex-worker", indexedWorkerId]),
    });
  });

  it("assigns in the paired device's name across authorized worktrees of the same project", async () => {
    await startService();
    registered.push("other");
    const device = await phone();
    const assigned = {
      ...lead,
      workers: [{ sessionId: "codex-worker" }, { sessionId: "second-worker" }],
    };
    managed
      .mockResolvedValueOnce({ lead: null })
      .mockResolvedValueOnce({ lead: assigned, capable: true, eligibility });
    expect(
      await device.api("managed/project-agent", assignWorkers(["codex-worker", "second-worker"])),
    ).toEqual({
      status: 200,
      data: {
        lead: assigned,
        capable: true,
        eligibility,
        controlOutcome: assignment.assignSuccessOutcome,
      },
    });
    expect(leadCalls()).toEqual([
      { operation: "lead-status", sessionId: "claude-session", deviceId: device.id },
      {
        ...assignWorkers(["codex-worker", "second-worker"]),
        deviceId: device.id,
        authorizedWorkspaceIds: ["first", "other", "second"],
        assignmentProject: {
          leadWorkspaceId: "first",
          projectKey: expect.any(String),
          workers: [
            { sessionId: "codex-worker", workspaceId: "first" },
            { sessionId: "second-worker", workspaceId: "second" },
          ],
        },
        mayDelegateApprovals: true,
      },
    ]);
  });

  it("rejects injected scopes, wrong methods, and Workers outside the authorized project", async () => {
    await startService();
    registered = ["first", "other"];
    const device = await phone();
    for (const body of [
      { ...assignWorkers(["codex-worker"]), authorizedWorkspaceIds: ["second"] },
      { ...assignWorkers(["codex-worker"]), assignmentProject: { leadWorkspaceId: "other" } },
      { ...assignWorkers(["codex-worker"]), deviceId: "agentkib-local-owner" },
      assignWorkers(["codex-worker", "codex-worker"]),
      { sessionId: "claude-session", operation: assignment.optionsOperation },
    ])
      expect((await device.api("managed/project-agent", body)).status).toBe(400);
    expect(
      (
        await device.api(
          `managed/project-agent?sessionId=claude-session&operation=${assignment.assignOperation}`,
        )
      ).status,
    ).toBe(400);
    expect(
      await device.api("managed/project-agent", assignWorkers(["second-worker"])),
    ).toMatchObject({
      status: 403,
      data: { error: codes.workspaceNotAuthorized },
    });
    expect(
      await device.api("managed/project-agent", assignWorkers(["other-worker"])),
    ).toMatchObject({
      status: 409,
      data: { error: codes.workerOutsideProject },
    });
    expect(leadCalls()).toHaveLength(0);
  });

  it("discards assignment options if the scope changes while probing candidates", async () => {
    await startService();
    const device = await phone();
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    managed.mockImplementationOnce(async () => {
      await blocked;
      return {
        capable: true,
        remaining: 2,
        eligibility,
        candidates: [{ sessionId: "second-worker", reason: null }],
      };
    });
    const result = device.api(assignmentPath);
    try {
      await vi.waitFor(() => expect(leadCalls()).toHaveLength(1));
      registered = ["first"];
    } finally {
      unblock();
    }
    expect(await result).toEqual({ status: 409, data: { error: codes.accessChanged } });
  });

  it("rechecks the write grant before dispatching the selected Workers", async () => {
    await startService();
    const device = await phone();
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    managed.mockImplementationOnce(async () => {
      await blocked;
      return { lead: null };
    });
    const result = device.api("managed/project-agent", assignWorkers(["codex-worker"]));
    try {
      await vi.waitFor(() => expect(leadCalls()).toHaveLength(1));
      await service.request({ operation: "set-access", id: device.id, access: "read" });
    } finally {
      unblock();
    }
    expect(await result).toMatchObject({
      status: 409,
      data: { error: codes.accessChanged, controlOutcome: outcomes.notDispatched },
    });
    expect(leadCalls().map(({ operation }) => operation)).toEqual(["lead-status"]);
  });

  it("returns the registered assignment refusal instead of private runtime text", async () => {
    await startService();
    const device = await phone();
    managed.mockResolvedValueOnce({ lead: null }).mockRejectedValueOnce(
      new RuntimeRequestError({
        code: -32000,
        message: "synthetic private text",
        data: {
          detail: codes.workerUnavailable,
          reason: codes.workerTerminalDisconnected,
          controlOutcome: outcomes.notDispatched,
        },
      }),
    );
    expect(await device.api("managed/project-agent", assignWorkers(["codex-worker"]))).toEqual({
      status: 409,
      data: {
        error: codes.workerTerminalDisconnected,
        reason: codes.workerTerminalDisconnected,
        controlOutcome: outcomes.notDispatched,
      },
    });
  });

  it.each(["catalog", "options", "status", "assign"] as const)(
    "withholds a qualification error if access changes during %s",
    async (stage) => {
      await startService();
      const device = await phone();
      const pending = deferred();
      const refusal = async () => {
        await pending.ready;
        throw new RuntimeRequestError({
          code: -32000,
          message: "private runtime detail",
          data: {
            reason: codes.workerTerminalDisconnected,
            controlOutcome: outcomes.notDispatched,
          },
        });
      };
      // The first catalog lookup locates the lead; fail the next call, which builds the candidates.
      if (stage === "catalog") {
        runtime.mockImplementationOnce(runtime.getMockImplementation()!);
        runtime.mockImplementationOnce(refusal);
      } else {
        if (stage === "assign") managed.mockResolvedValueOnce({ lead: null });
        managed.mockImplementationOnce(refusal);
      }
      const read = stage === "catalog" || stage === "options";
      const result = read
        ? device.api(assignmentPath)
        : device.api("managed/project-agent", assignWorkers(["codex-worker"]));
      try {
        await vi.waitFor(() => {
          if (stage === "catalog")
            expect(
              runtime.mock.calls.filter(
                ([input]) => (input as { operation?: string }).operation === "catalog",
              ),
            ).toHaveLength(2);
          else expect(leadCalls()).toHaveLength(stage === "assign" ? 2 : 1);
        });
        if (stage === "options") await service.request({ operation: "revoke", id: device.id });
        else registered = ["second"];
      } finally {
        pending.release();
      }
      const response = await result;
      expect([401, 409]).toContain(response.status);
      expect([codes.accessChanged, codes.accessEnded]).toContain(response.data.error);
      expect(response.data.reason).toBeUndefined();
      expect(JSON.stringify(response.data)).not.toContain(codes.workerTerminalDisconnected);
    },
  );

  it.each(["canonical", "alias"] as const)(
    "rechecks the %s candidate against a fresh catalog before replying",
    async (moved) => {
      await startService();
      indexedWorkerId = "old-codex-worker";
      registered.push("other");
      const device = await scopedBrowser();
      const pending = deferred();
      managed.mockImplementationOnce(async () => {
        await pending.ready;
        return {
          capable: true,
          remaining: 2,
          eligibility,
          candidates: [
            { sessionId: "codex-worker", reason: null },
            { sessionId: indexedWorkerId, reason: codes.sessionIsAWorker, assigned: true },
          ],
        };
      });
      const result = device.api(assignmentPath);
      try {
        await vi.waitFor(() => expect(leadCalls()[0]?.candidateIds).toContain(indexedWorkerId));
        if (moved === "canonical") workerWorkspace = "other";
        else detachedAlias = indexedWorkerId;
      } finally {
        pending.release();
      }
      expect(await result).toEqual({
        status: 200,
        data: {
          capable: true,
          remaining: 2,
          eligibility,
          candidates: moved === "canonical" ? [] : [{ sessionId: "codex-worker", reason: null }],
        },
      });
      expect(runtime).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "catalog", assignmentScopeCheck: true }),
      );
    },
  );

  it.each(["success", "failure"] as const)(
    "rechecks moved candidates after final workspace verification (%s)",
    async (result) => {
      await startService();
      indexedWorkerId = "old-codex-worker";
      registered.push("other");
      const device = await scopedBrowser();
      const workspaceVerificationStarted = deferred();
      const canFinishWorkspaceVerification = deferred();
      const request = runtime.getMockImplementation()!;
      runtime.mockImplementation(async (input) => {
        if ((input as { operation: string }).operation !== "assignment-reply-scope")
          return request(input);
        const workspaces = [...registered];
        workspaceVerificationStarted.release();
        await canFinishWorkspaceVerification.ready;
        const scope = (await request(input)) as { sessions: unknown };
        return { ...scope, workspaces };
      });
      if (result === "success")
        managed.mockResolvedValueOnce({
          capable: true,
          remaining: 2,
          eligibility,
          candidates: [
            { sessionId: "codex-worker", reason: null },
            { sessionId: indexedWorkerId, reason: codes.sessionIsAWorker, assigned: true },
            { sessionId: "devin-session", reason: null },
          ],
        });
      else
        managed.mockRejectedValueOnce(
          new RuntimeRequestError({
            code: -32000,
            message: "synthetic qualification failure",
            data: { reason: codes.workerTerminalDisconnected },
          }),
        );

      const pending = device.api(assignmentPath);
      try {
        await expect(
          Promise.race([workspaceVerificationStarted.ready, pending]),
        ).resolves.toBeUndefined();
        // The workspace grant set stays identical. Only this candidate's ownership changes.
        workerWorkspace = "other";
      } finally {
        canFinishWorkspaceVerification.release();
        runtime.mockImplementation(request);
      }
      expect(await pending).toEqual(
        result === "success"
          ? {
              status: 200,
              data: {
                capable: true,
                remaining: 2,
                eligibility,
                candidates: [{ sessionId: "devin-session", reason: null }],
              },
            }
          : { status: 409, data: { error: codes.accessChanged } },
      );
    },
  );

  it.each([
    { writing: false, accepted: true },
    { writing: false, accepted: false },
    { writing: true, accepted: true },
    { writing: true, accepted: false },
  ])(
    "withholds a stale final catalog response (writing=$writing, accepted=$accepted)",
    async ({ writing, accepted }) => {
      await startService();
      const device = await phone();
      const copiedCatalog = deferred();
      const pending = deferred();
      const readCatalog = runtime.getMockImplementation()!;
      runtime.mockImplementation(async (input) => {
        const snapshot = await readCatalog(input);
        // The runtime has already copied the old registration and session rows.
        if ((input as { assignmentScopeCheck?: boolean }).assignmentScopeCheck) {
          copiedCatalog.release();
          await pending.ready;
        }
        return snapshot;
      });
      if (writing) managed.mockResolvedValueOnce({ lead: null });
      if (accepted)
        managed.mockResolvedValueOnce(
          writing
            ? { lead: { ...lead, workers: [{ sessionId: "second-worker" }] }, capable: true }
            : {
                capable: true,
                remaining: 2,
                eligibility,
                candidates: [{ sessionId: "second-worker", reason: null }],
              },
        );
      else
        managed.mockRejectedValueOnce(
          new RuntimeRequestError({
            code: -32000,
            message: "synthetic qualification failure",
            data: {
              reason: codes.workerTerminalDisconnected,
              controlOutcome: outcomes.notDispatched,
            },
          }),
        );

      const result = writing
        ? device.api("managed/project-agent", assignWorkers(["second-worker"]))
        : device.api(assignmentPath);
      try {
        await expect(Promise.race([copiedCatalog.ready, result])).resolves.toBeUndefined();
        registered = ["first"];
      } finally {
        pending.release();
        runtime.mockImplementation(readCatalog);
      }
      expect(await result).toEqual({
        status: 409,
        data: {
          error: codes.accessChanged,
          ...(writing && { controlOutcome: accepted ? outcomes.unknown : outcomes.notDispatched }),
        },
      });
    },
  );

  it.each(["missing reply", "access changed"] as const)(
    "requires reconciliation when registration is followed by %s",
    async (failure) => {
      await startService();
      const device = await phone();
      const assigned = { ...lead, workers: [{ sessionId: "codex-worker" }] };
      managed.mockResolvedValueOnce({ lead: null }).mockImplementationOnce(async () => {
        currentLead = assigned;
        if (failure === "missing reply") throw new Error("transport disconnected");
        await service.request({ operation: "set-access", id: device.id, access: "read" });
        return { lead: assigned, capable: true, eligibility };
      });
      const response = await device.api(
        "managed/project-agent?operation=" + assignment.assignOperation,
        assignWorkers(["codex-worker"]),
      );
      expect(response.data.controlOutcome).toBe(outcomes.unknown);
      expect(response.data.lead).toBeUndefined();
      expect(leadCalls().map(({ operation }) => operation)).toEqual([
        "lead-status",
        assignment.assignOperation,
      ]);
      const readback = await device.api("managed/project-agent?sessionId=claude-session");
      expect(readback).toEqual({ status: 200, data: { lead: assigned, capable: true } });
    },
  );

  it("sets one up in the device's name and accepts legacy settings without forwarding them", async () => {
    await startService();
    const device = await phone();
    expect(await device.api("managed/project-agent?sessionId=claude-session")).toMatchObject({
      status: 200,
      data: { lead: null },
    });
    const scope = { maxAutoTurns: 10, approvals: ["command"], answers: true };
    const designated = await device.api("managed/project-agent", {
      sessionId: "claude-session",
      operation: "designate",
      scope: {
        ...scope,
        workspaceIds: ["nonexistent"],
        policies: ["workspace-write-auto-review"],
        maxLanes: 1,
        allowAutoReview: true,
        maxWorkers: 1,
      },
    });
    expect(designated).toMatchObject({
      status: 200,
      data: { lead: { sessionId: "claude-session" } },
    });
    expect(leadCalls().at(-1)).toEqual({
      operation: "lead-designate",
      sessionId: "claude-session",
      deviceId: device.id,
      scope,
    });
    currentLead = { ...lead, scope: { ...lead.scope, approvals: ["command"] } };
    for (const operation of ["pause", "resume", "release"])
      expect(
        (await device.api("managed/project-agent", { sessionId: "claude-session", operation }))
          .status,
      ).toBe(200);
    expect(leadCalls().map((call) => call.operation)).toEqual([
      "lead-status",
      "lead-designate",
      "lead-pause",
      // Resuming checks what it resumes first.
      "lead-status",
      "lead-resume",
      "lead-release",
    ]);
    expect(leadCalls().every((call) => call.deviceId === device.id)).toBe(true);
    expect(leadCalls().find((call) => call.operation === "lead-resume")).toMatchObject({
      authorizedWorkspaceIds: ["first"],
    });
  });

  it.each(["devin", "antigravity"])(
    "reads and designates a %s Project Agent without Claude Code",
    async (agent) => {
      await startService(false);
      const device = await phone();
      const sessionId = `${agent}-session`;
      const scope = { maxAutoTurns: 10, approvals: ["command"], answers: true };
      const designate = { sessionId, operation: "designate", scope };
      expect([
        await device.api(`managed/project-agent?sessionId=${sessionId}`),
        await device.api("managed/project-agent", designate),
      ]).toMatchObject([
        { status: 200, data: { lead: null, capable: true } },
        { status: 200, data: { lead: { sessionId }, capable: true } },
      ]);

      const restricted = await scopedBrowser(true);
      expect((await restricted.api("managed/project-agent", designate)).status).toBe(403);
      expect(leadCalls()).toEqual([
        {
          operation: "lead-status",
          sessionId,
          deviceId: device.id,
          authorizedWorkspaceIds: ["first", "second"],
        },
        { operation: "lead-designate", sessionId, deviceId: device.id, scope },
      ]);
    },
  );

  it("forwards role eligibility and preserves the existing error with a specific reason", async () => {
    await startService();
    const device = await phone();
    const eligibility = {
      executionSide: "terminal",
      availability: { available: false, reason: "lead-claude-terminal-disconnected" },
      toolsReady: null,
    };
    managed.mockResolvedValueOnce({ lead: null, capable: false, eligibility });
    expect(await device.api("managed/project-agent?sessionId=claude-session")).toMatchObject({
      status: 200,
      data: { lead: null, capable: false, eligibility },
    });
    managed.mockRejectedValueOnce(
      new RuntimeRequestError({
        code: -32000,
        message: "AgentKib command failed",
        data: {
          detail: "lead-requires-managed-claude",
          reason: "lead-claude-terminal-disconnected",
        },
      }),
    );
    expect(
      await device.api("managed/project-agent", {
        sessionId: "claude-session",
        operation: "designate",
        scope: {},
      }),
    ).toMatchObject({
      status: 409,
      data: { error: "lead-requires-managed-claude", reason: "lead-claude-terminal-disconnected" },
    });
  });

  it.each(["native-session-unconfirmed", "unverified-session-identity"])(
    "serves the same paired Codex designation conflict for %s",
    async (reason) => {
      await startService(false);
      const device = await phone();
      const sessionId = "codex-worker";
      managed.mockRejectedValueOnce(
        new RuntimeRequestError({
          code: REMOTE_ERROR_CONTRACT.rpcApplicationFailure.ipc.rpcCode,
          message: "AgentKib command failed",
          data: { detail: "lead-unavailable", reason },
        }),
      );
      expect(
        await device.api("managed/project-agent", { sessionId, operation: "designate", scope: {} }),
      ).toMatchObject({
        status: 409,
        data: { error: "lead-unavailable", reason },
      });
      expect(leadCalls().at(-1)).toMatchObject({
        operation: "lead-designate",
        sessionId,
        deviceId: device.id,
      });
    },
  );

  it("keeps the paired stop conflict when a worker live probe fails", async () => {
    await startService();
    const device = await phone();
    managed.mockRejectedValueOnce(
      new RuntimeRequestError({
        code: REMOTE_ERROR_CONTRACT.rpcApplicationFailure.ipc.rpcCode,
        message: "AgentKib command failed",
        data: { detail: "worker-not-running", reason: "worker-probe-failed" },
      }),
    );
    await expect(
      device.api("managed/project-agent", {
        sessionId: "claude-session",
        operation: "stop-worker",
        worker: "codex-worker",
      }),
    ).resolves.toMatchObject({
      status: 409,
      data: { error: "worker-not-running", reason: "worker-probe-failed" },
    });
  });

  it("still requires Claude Code verification for Claude Code Project Agents", async () => {
    await startService(false);
    const device = await phone();
    const unavailable = { status: 503, data: { error: "capability_unavailable" } };
    expect(await device.api("managed/project-agent?sessionId=claude-session")).toMatchObject(
      unavailable,
    );
    expect(
      await device.api("managed/project-agent", {
        sessionId: "claude-session",
        operation: "designate",
        scope: { maxAutoTurns: 10 },
      }),
    ).toMatchObject(unavailable);
    expect(leadCalls()).toEqual([]);
  });

  it("changes its settings, and lets one worker go or stops its turn, in the device's name", async () => {
    await startService();
    const device = await phone();
    currentLead = { ...lead, scope: { ...lead.scope, approvals: ["command"] } };
    const call = (body: Record<string, unknown>) =>
      device.api("managed/project-agent", { sessionId: "claude-session", ...body });
    // A change keeps what it does not name, and this device answers for all of it.
    expect(
      await call({
        operation: "update",
        scope: { maxLanes: 3, workspaceIds: ["elsewhere"], maxAutoTurns: 15, stallMinutes: 18 },
      }),
    ).toMatchObject({ status: 200, data: { lead: { scope: { maxLanes: 10 } } } });
    for (const operation of ["stop-worker", "remove-worker"])
      expect((await call({ operation, worker: "codex-worker" })).status).toBe(200);
    // A session this device cannot reach is no worker it acts on.
    expect((await call({ operation: "stop-worker", worker: "unknown" })).status).toBe(403);
    expect((await call({ operation: "remove-worker" })).status).toBe(400);
    expect(leadCalls()).toEqual([
      { operation: "lead-status", sessionId: "claude-session", deviceId: device.id },
      {
        operation: "lead-update",
        sessionId: "claude-session",
        deviceId: device.id,
        scope: { maxAutoTurns: 15, stallMinutes: 18 },
        authorizedWorkspaceIds: ["first"],
      },
      {
        operation: "lead-worker-stop",
        sessionId: "claude-session",
        deviceId: device.id,
        worker: "codex-worker",
      },
      {
        operation: "lead-worker-remove",
        sessionId: "claude-session",
        deviceId: device.id,
        worker: "codex-worker",
      },
    ]);
  });

  it("lets a fully authorized device update or clear a Worker role in its own name", async () => {
    await startService();
    const device = await phone();
    currentLead = lead;
    const base = { sessionId: "claude-session", operation: "worker-role", worker: "codex-worker" };
    const role = { label: "Validation", description: "Run checks." };
    for (const value of [role, null]) {
      expect(await device.api("managed/project-agent", { ...base, role: value })).toMatchObject({
        status: 200,
      });
      expect(leadCalls().at(-1)).toEqual({
        operation: "lead-worker-role",
        sessionId: "claude-session",
        deviceId: device.id,
        authorizedWorkspaceIds: ["first"],
        worker: "codex-worker",
        role: value,
      });
    }
    expect(await device.api("managed/project-agent", base)).toMatchObject({ status: 400 });
    expect(
      await device.api("managed/project-agent", { ...base, role, updatedBy: "project-agent" }),
    ).toMatchObject({ status: 400 });
    currentLead = { ...lead, scope: { ...lead.scope, workspaceIds: ["first", "elsewhere"] } };
    expect(await device.api("managed/project-agent", { ...base, role })).toMatchObject({
      status: 403,
    });
    expect(leadCalls().at(-1)).toMatchObject({ operation: "lead-status" });
  });

  it("does not let a device take responsibility for workers outside its reach", async () => {
    await startService();
    const device = await phone();
    currentLead = { ...lead, scope: { ...lead.scope, workspaceIds: ["first", "elsewhere"] } };
    for (const operation of ["update", "resume"]) {
      const result = await device.api("managed/project-agent", {
        sessionId: "claude-session",
        operation,
        ...(operation === "update" ? { scope: { workspaceIds: ["first"] } } : {}),
      });
      expect(result).toMatchObject({ status: 403 });
    }
    expect(leadCalls().map((call) => call.operation)).toEqual(["lead-status", "lead-status"]);
  });

  it("preserves device authorization through listener restart and labels application quit", async () => {
    await startService();
    service.setSharedRuntimePrimary(false);
    const device = await phone();
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: false,
      allowedWorkspaceIds: [],
    });
    expect(await device.api("access")).toMatchObject({ status: 200, data: { status: "approved" } });
    expect(invalidations()).toEqual([]);
    await service.dispose();
    expect(invalidations()).toEqual([
      { operation: "schedule-invalidate", deviceId: device.id, quitting: true },
    ]);
  });

  it("invalidates only the paired device whose access was downgraded or revoked", async () => {
    await startService();
    const downgraded = await phone();
    const revoked = await phone();
    const setReadOnly = () =>
      service.request({ operation: "set-access", id: downgraded.id, access: "read" });

    let savedSendGrant: boolean | undefined;
    managed.mockImplementationOnce(async () => {
      const { credentials } = JSON.parse(
        await readFile(join(directory, "web-access.json"), "utf8"),
      );
      savedSendGrant = credentials.find(
        ({ device }: { device: { id: string } }) => device.id === downgraded.id,
      )?.device.send;
      return {};
    });
    await setReadOnly();
    expect(savedSendGrant).toBe(true); // The runtime fences prepared work before the new save.
    await setReadOnly();
    await service.request({ operation: "revoke", id: revoked.id });
    await service.request({ operation: "revoke", id: "agentkib-local-owner" });
    expect(invalidations()).toEqual([
      {
        operation: "schedule-invalidate",
        deviceId: downgraded.id,
        authorizationSource: "access-downgraded",
      },
      {
        operation: "schedule-invalidate",
        deviceId: revoked.id,
        authorizationSource: "device-revoked",
      },
    ]);
  });

  it("lets a device without full access see one, and nothing more", async () => {
    await startService();
    const restricted = await scopedBrowser(true);
    expect((await restricted.api("managed/project-agent?sessionId=claude-session")).status).toBe(
      200,
    );
    for (const operation of [
      "designate",
      "update",
      "pause",
      "resume",
      "release",
      "remove-worker",
      "stop-worker",
      "worker-role",
    ])
      expect(
        (
          await restricted.api("managed/project-agent", {
            sessionId: "claude-session",
            operation,
            ...(operation === "designate" || operation === "update"
              ? { scope: { workspaceIds: ["first"] } }
              : {}),
            ...(operation.endsWith("-worker") ? { worker: "codex-worker" } : {}),
            ...(operation === "worker-role" ? { worker: "codex-worker", role: null } : {}),
          })
        ).status,
      ).toBe(403);
    expect(leadCalls().map((call) => call.operation)).toEqual(["lead-status"]);
    expect(leadCalls()[0]).toMatchObject({ authorizedWorkspaceIds: ["first"] });
    expect(
      (
        await restricted.api("managed/project-agent", {
          sessionId: "claude-session",
          operation: "everything",
        })
      ).status,
    ).toBe(400);
  });

  it("discards Project Agent status if a workspace is unregistered during its read", async () => {
    await startService();
    const device = await phone();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    managed.mockImplementationOnce(async () => {
      await blocked;
      return { lead, capable: true };
    });
    const result = device.api("managed/project-agent?sessionId=claude-session");
    try {
      await vi.waitFor(() => expect(leadCalls()).toHaveLength(1));
      registered = ["first"];
    } finally {
      release();
    }
    expect(await result).toEqual({ status: 409, data: { error: "access_changed" } });
  });
});
