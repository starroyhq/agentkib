import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeBridgeFixture } from "./fixtures/claude-bridge";
import { codexTurnErrorEvent } from "../../../packages/backend/src/agents/codex/codex-turn-error";
import { projectAgentRoleAdapters } from "../../../packages/backend/src/agents/project-agent-role-adapters";
import { openManagedLedger } from "../../../packages/backend/src/managed-ledger";
import { LeadRegistry } from "../../../packages/backend/src/orchestration-registry";
import {
  LeadReportNotDispatched,
  LeadReportUsageLimit,
} from "../../../packages/backend/src/message-lead-reports";
import {
  LEAD_INSTRUCTIONS,
  leadInstructions,
  mergeMcpConfigs,
  OrchestrationService,
  workerReport,
  type LaneHost,
} from "../../../packages/backend/src/orchestration-service";

// A lead (a Claude Code session AgentKib runs) directing lanes (Codex sessions AgentKib runs)
// through its private tool endpoint. The Codex side is a stand-in that records what the
// service asks of it.

const requireBackend = createRequire(
  new URL("../../../packages/backend/package.json", import.meta.url),
);
const { Client } = requireBackend("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = requireBackend(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function directory() {
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-orchestration-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const LEAD = "lead-session";
const DEVICE = "desktop-local";
const WORKER = "codex-existing";
const OWNER = { sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1" };

async function assignWorker(orchestration: OrchestrationService, worker = WORKER) {
  await orchestration.assignWorkers({ ...OWNER, workers: [worker] });
  return worker;
}

function host(overrides: Partial<LaneHost> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const lives = new Map<string, Record<string, unknown>>();
  const idle = (sessionId: string) => ({
    sessionId,
    status: "idle",
    revision: 3,
    runtimeBootId: "boot",
    turnId: null,
    sendEnabled: true,
    stopEnabled: false,
    approvals: [],
    questions: [],
  });
  const lanes: LaneHost = {
    control: async (value) => {
      calls.push({ kind: "control", ...value });
      return { accepted: true, controlOutcome: "accepted" };
    },
    live: async (sessionId) => lives.get(sessionId) ?? idle(sessionId),
    events: async () => [
      { kind: "user-message", content: "brief", turn_id: "t1" },
      { kind: "agent-message", content: "first answer", turn_id: "t1" },
      { kind: "agent-message", content: "x".repeat(5000), turn_id: "t2" },
    ],
    session: (sessionId) =>
      sessionId === "codex-existing"
        ? { agent: "codex", workspaceId: "w1", title: "Existing" }
        : sessionId === "codex-branch"
          ? { agent: "codex", workspaceId: "w2", title: null }
          : sessionId === LEAD || sessionId === "claude-other"
            ? { agent: "claude-code", workspaceId: "w1", title: null }
            : sessionId === "codex-elsewhere"
              ? { agent: "codex", workspaceId: "w9", title: null }
              : null,
    managed: async (sessionId) => sessionId === "codex-existing",
    workspaces: () => [
      { id: "w1", name: "app" },
      { id: "w2", name: "worktrees" },
      { id: "w9", name: "other" },
    ],
    ...overrides,
  };
  return { lanes, calls, lives };
}

function service(
  lanes: LaneHost,
  root = directory(),
  bootId = "boot-1",
  sendReport: OrchestrationService["sendReport"] = () => false,
  isLeadCapable = (id: string) => id === LEAD,
) {
  const created = new OrchestrationService(root, bootId, lanes, isLeadCapable, sendReport);
  cleanups.push(() => created.close());
  return created;
}

const parse = (result: { text: string }) => JSON.parse(result.text);

describe("Project Agent workspace-scoped overview", () => {
  it("projects Worker metadata and attributed report counts to authorized assignments", async () => {
    const { lanes, lives } = host({ managed: async () => true });
    const sessions = new Map([
      [WORKER, { agent: "codex", workspaceId: "w1", title: "Visible title" }],
      ["foreign", { agent: "codex", workspaceId: "w2", title: "Other workspace title" }],
      ["moved", { agent: "codex", workspaceId: "w9", title: "Moved Worker title" }],
      ["stale-live", { agent: "codex", workspaceId: "w9", title: "Stale live title" }],
    ]);
    const indexedSession = lanes.session;
    lanes.session = (id) => sessions.get(id) ?? indexedSession(id);
    const live = vi.spyOn(lanes, "live");
    const orchestration = service(lanes);
    await orchestration.assignWorkers({ ...OWNER, workers: [...sessions.keys()] });
    sessions.get("foreign")!.workspaceId = "w1";
    sessions.get("moved")!.workspaceId = "w2";
    lives.set("stale-live", { status: "running", workspaceId: "w2" });
    orchestration.registry.update(LEAD, (lead) => {
      for (const lane of lead.lanes) lane.title = sessions.get(lane.sessionId)!.title;
      const [visible, foreign, moved] = lead.lanes;
      visible!.lastReport = { at: "2026-11-27T08:00:00Z", preview: "visible report" };
      lead.pendingReports = ["visible", "foreign", "old"];
      lead.pendingReportParts = [
        [{ text: "visible", sourceLaneIds: [visible!.id] }],
        [{ text: "foreign", sourceLaneIds: [foreign!.id] }],
        null,
      ];
      lead.reportDeliveries = [
        { reportId: "visible", text: "visible", sourceLaneIds: [visible!.id] },
        { reportId: "mixed", text: "mixed", sourceLaneIds: [visible!.id, foreign!.id] },
        { reportId: "moved", text: "moved", quitLaneId: moved!.id },
        { reportId: "old", text: "old" },
      ];
    });
    expect(await orchestration.overview(LEAD, "w1", ["w1", "w9"])).toMatchObject({
      scope: { workspaceIds: ["w1"] },
      workers: [
        { sessionId: WORKER, title: "Visible title", lastReportAt: "2026-11-27T08:00:00Z" },
      ],
      pendingReports: 2,
    });
    expect(live.mock.calls.map(([id]) => id)).toEqual([WORKER, "stale-live"]);
    expect(await orchestration.overview(LEAD, "w1")).toMatchObject({
      scope: { workspaceIds: ["w1", "w2", "w9"] },
      workers: [...sessions.keys()].map((sessionId) => expect.objectContaining({ sessionId })),
      pendingReports: 7,
    });
    live.mockClear();
    expect(await orchestration.overview(LEAD, "w1", ["w2"])).toBeNull();
    expect(live).not.toHaveBeenCalled();
  });

  it("drops a Worker reassigned while live state is being read", async () => {
    const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
    const { lanes } = host({ live: () => promise });
    const orchestration = service(lanes);
    await assignWorker(orchestration);
    const overview = orchestration.overview(LEAD, "w1", ["w1"]);
    await orchestration.removeWorker(LEAD, WORKER);
    await assignWorker(orchestration);
    resolve({ status: "running", workspaceId: "w1" });
    expect(await overview).toMatchObject({ workers: [] });
  });
});

describe("Worker roles", () => {
  const worker = { worker: "worker-1" };
  const role = { label: "Release", description: "Run checks. Leave publishing to the user." };

  it("persists role edits and exposes them across a restart without changing the task or device", async () => {
    const { lanes } = host();
    const root = directory();
    const before = service(lanes, root);
    await assignWorker(before);
    await before.call(LEAD, "worker_send", {
      ...worker,
      text: "Check the branch",
      title: "Checks",
    });
    expect(parse(await before.call(LEAD, "worker_read", worker))).not.toHaveProperty("role");
    expect(() => before.setWorkerRole(LEAD, WORKER, role, ["w2"], "w1")).toThrow(
      "workspace_not_authorized",
    );
    before.setWorkerRole(LEAD, WORKER, role, ["w1"], "w1");
    const userRole = { ...role, updatedBy: "user", updatedAt: expect.any(String) };
    expect(await before.overview(LEAD, "w1", ["w1"])).toMatchObject({
      workers: [{ sessionId: WORKER, title: "Checks", role: userRole }],
      roleChanges: [
        {
          workerSessionId: WORKER,
          roleLabel: role.label,
          updatedBy: "user",
          updatedAt: expect.any(String),
        },
      ],
    });
    await before.close();

    const after = service(lanes, root, "after-role-change");
    expect(parse(await after.call(LEAD, "worker_list", {})).workers).toMatchObject([
      { ...worker, title: "Checks", role: userRole },
    ]);
    expect(parse(await after.call(LEAD, "worker_read", worker))).toMatchObject({
      title: "Checks",
      role: userRole,
    });
    const changed = { ...role, label: "Validation" };
    expect(
      parse(await after.call(LEAD, "worker_settings", { ...worker, role: changed })),
    ).toMatchObject({ accepted: true, role: { ...changed, updatedBy: "project-agent" } });
    expect(after.status(LEAD)?.deviceId).toBe(DEVICE);
    expect(parse(await after.call(LEAD, "worker_settings", { ...worker, role: null }))).toEqual({
      accepted: true,
      role: null,
    });
    expect(await after.overview(LEAD, "w1", ["w1"])).toMatchObject({
      workers: [{ title: "Checks" }],
      roleChanges: [
        { updatedBy: "user", roleLabel: role.label },
        { updatedBy: "project-agent", roleLabel: changed.label },
        { updatedBy: "project-agent", roleLabel: null },
      ],
    });
    expect(parse(await after.call(LEAD, "worker_read", worker))).not.toHaveProperty("role");
  });

  it("keeps delegation guards and imports no actor or model settings with a role edit", async () => {
    const { lanes } = host();
    const orchestration = service(lanes);
    await assignWorker(orchestration);
    for (const extra of [
      { role: { ...role, updatedBy: "user" } },
      { role, modelId: "other" },
      { role: { ...role, label: "bad\nlabel" } },
    ])
      expect(
        parse(await orchestration.call(LEAD, "worker_settings", { ...worker, ...extra })),
      ).toMatchObject({ accepted: false, reason: "invalid_input" });
    expect(orchestration.status(LEAD)?.records.some(({ kind }) => kind === "worker-role")).toBe(
      false,
    );
    orchestration.pause(LEAD);
    expect(
      parse(await orchestration.call(LEAD, "worker_settings", { ...worker, role })),
    ).toMatchObject({ accepted: false, reason: "delegation-paused" });
    orchestration.setWorkerRole(LEAD, WORKER, role, ["w1"], "w1");
    expect(orchestration.status(LEAD)?.paused).toBe(true);
    expect(parse(await orchestration.call(LEAD, "worker_read", worker))).toMatchObject({
      role: { ...role, updatedBy: "user" },
    });
    const session = lanes.session;
    lanes.session = (id) => (id === WORKER ? { ...session(id)!, workspaceId: "w2" } : session(id));
    expect(() => orchestration.setWorkerRole(LEAD, WORKER, null, ["w1", "w2"], "w1")).toThrow(
      "workspace_not_authorized",
    );
  });

  it("adds current role details to each send, queued task and steer while staying inside the native budget", async () => {
    const { lanes, calls, lives } = host();
    const orchestration = service(lanes);
    await assignWorker(orchestration);
    orchestration.setWorkerRole(LEAD, WORKER, role);
    await orchestration.call(LEAD, "worker_send", { ...worker, text: "First task" });
    lives.set(WORKER, { status: "running", runtimeBootId: "boot", revision: 4, turnId: "t1" });
    orchestration.setWorkerRole(LEAD, WORKER, { ...role, label: "Validation" });
    await orchestration.call(LEAD, "worker_send", { ...worker, text: "Next task" });
    await orchestration.call(LEAD, "worker_send", { ...worker, text: "Note", mode: "steer" });
    const refused = await orchestration.call(LEAD, "worker_send", {
      ...worker,
      text: "x".repeat(16_000),
    });
    expect(parse(refused)).toMatchObject({ accepted: false, reason: "invalid-text" });
    expect(calls).toMatchObject([
      {
        operation: "send",
        text: `Worker role: "Release"\n${role.description}\n\nTask from your Project Agent:\nFirst task`,
      },
      {
        operation: "queue-add",
        text: expect.stringMatching(/^Worker role: "Validation".*Next task$/s),
      },
      { operation: "steer", text: expect.stringMatching(/^Worker role: "Validation".*Note$/s) },
    ]);
  });
});

describe("Project Agent worker settings", () => {
  const worker = { worker: "worker-1" };
  const fast = { id: "priority", name: "Fast from the provider" };
  const economy = { id: "economy", name: "Economy from the provider" };

  async function fixture(agent = "codex") {
    let revision = 3;
    const current = {
      model: "fixture-model-a",
      effort: "low",
      serviceTier: fast.id,
    };
    let selected: Record<string, unknown> = { ...current };
    const tiers = [fast, economy];
    const models = [
      { id: current.model, name: "Fixture A", efforts: ["low", "high"], serviceTiers: tiers },
      { id: "fixture-model-b", name: "Fixture B", efforts: ["high"], serviceTiers: tiers },
    ];
    const readSettings = () => ({
      available: true,
      revision,
      runtimeBootId: "boot",
      models,
      serviceTiers: tiers,
      settings: {
        selected,
        current,
        defaults: { ...current, serviceTier: null },
        writable: { model: true, effort: true, ...(tiers.length ? { serviceTier: true } : {}) },
      },
    });
    const writeSettings = vi.fn(async (value: Record<string, unknown>) => {
      expect(value).toMatchObject({
        operation: "settings",
        sessionId: WORKER,
        deviceId: DEVICE,
        runtimeBootId: "boot",
        expectedRevision: revision,
      });
      for (const key of ["model", "effort", "serviceTier"])
        if (Object.hasOwn(value, key)) selected = { ...selected, [key]: value[key] };
      revision++;
      return { accepted: true, requestId: value.requestId };
    });
    const { lanes, lives } = host({
      sessionSettings: async (value) =>
        value.operation === "settings-state" ? readSettings() : writeSettings(value),
    });
    const session = lanes.session;
    lanes.session = (id) =>
      id === WORKER ? { agent, workspaceId: "w1", title: "Settings Worker" } : session(id);
    const orchestration = service(lanes);
    orchestration.designate(OWNER);
    await assignWorker(orchestration);
    const call = async (name: string, input: Record<string, unknown> = worker) =>
      parse(await orchestration.call(LEAD, name, input));
    return { orchestration, lanes, lives, call, writeSettings };
  }

  it("shows the selected settings in list and read and obtains choices from the session provider", async () => {
    const f = await fixture();
    const settings = {
      model: { id: "fixture-model-a", label: "Fixture A" },
      reasoningEffort: "low",
      speed: { id: fast.id, label: fast.name },
      editable: true,
    };
    expect(await f.call("worker_list", {})).toMatchObject({
      workers: [{ ...worker, agent: "codex", settings }],
    });
    expect(await f.call("worker_read")).toMatchObject({ ...worker, agent: "codex", settings });
    expect(await f.call("worker_settings")).toMatchObject({
      agent: "codex",
      settings,
      writable: { modelId: true, reasoningEffort: true, serviceTierId: true },
      options: {
        models: [
          expect.objectContaining({ id: "fixture-model-a", efforts: ["low", "high"] }),
          expect.objectContaining({ id: "fixture-model-b", efforts: ["high"] }),
        ],
        serviceTiers: expect.arrayContaining([expect.objectContaining({ id: fast.id })]),
      },
    });
    expect(f.writeSettings).not.toHaveBeenCalled();
  });

  it("writes through the existing session control and shows its new selection in the session view", async () => {
    const f = await fixture();
    const saved = await f.call("worker_settings", {
      ...worker,
      modelId: "fixture-model-b",
      reasoningEffort: "high",
      serviceTierId: economy.id,
    });
    expect(saved).toMatchObject({ accepted: true, requestId: expect.any(String) });
    expect(f.writeSettings).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        model: "fixture-model-b",
        effort: "high",
        serviceTier: economy.id,
        requestId: saved.requestId,
      }),
    );
    expect(
      await f.lanes.sessionSettings!({ operation: "settings-state", sessionId: WORKER }),
    ).toMatchObject({
      settings: { selected: { model: "fixture-model-b", effort: "high", serviceTier: economy.id } },
    });
    expect(await f.call("worker_read")).toMatchObject({
      settings: {
        model: { id: "fixture-model-b", label: "Fixture B" },
        reasoningEffort: "high",
        speed: { id: economy.id, label: economy.name },
      },
    });
  });

  it("allows reads while busy or paused and refuses edits before dispatch", async () => {
    const f = await fixture();
    f.lives.set(WORKER, { status: "running", turnId: "fixture-turn" });
    expect(await f.call("worker_read")).toMatchObject({
      status: "running",
      settings: { editable: false, reason: "worker-running" },
    });
    expect(
      await f.call("worker_settings", { ...worker, modelId: "fixture-model-b" }),
    ).toMatchObject({
      accepted: false,
      reason: "worker-running",
    });
    f.lives.delete(WORKER);
    f.orchestration.pause(LEAD);
    expect(await f.call("worker_list", {})).toMatchObject({ paused: true, workers: [worker] });
    expect(await f.call("worker_read")).toMatchObject({ replies: expect.any(Array) });
    expect(await f.call("worker_settings")).toMatchObject({ agent: "codex" });
    expect(
      await f.call("worker_settings", { ...worker, modelId: "fixture-model-b" }),
    ).toMatchObject({
      accepted: false,
      reason: "delegation-paused",
    });
    expect(f.writeSettings).not.toHaveBeenCalled();
  });

  it("allows settings when idle Claude retains the previous turn ID", async () => {
    const f = await fixture("claude-code");
    const idle = { status: "idle", turnId: "completed-turn", runtimeBootId: "boot", revision: 3 };
    f.lives.set(WORKER, idle);
    expect(await f.call("worker_list", {})).toMatchObject({
      workers: [{ settings: { editable: true } }],
    });
    expect(await f.call("worker_read")).toMatchObject({ settings: { editable: true } });
    expect(await f.call("worker_settings")).toMatchObject({
      writable: { modelId: true, reasoningEffort: true, serviceTierId: false },
    });
    expect(await f.call("worker_settings", { ...worker, reasoningEffort: "high" })).toMatchObject({
      accepted: true,
    });
    expect(f.writeSettings).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ effort: "high" }),
    );
    f.lives.set(WORKER, { ...idle, status: "running", turnId: "active-turn", revision: 4 });
    expect(await f.call("worker_settings", { ...worker, reasoningEffort: "low" })).toMatchObject({
      accepted: false,
      reason: "worker-running",
    });
    expect(f.writeSettings).toHaveBeenCalledTimes(1);
  });

  it("shows the selected standard speed even when the previous turn used a faster tier", async () => {
    const f = await fixture();
    expect(await f.call("worker_settings", { ...worker, serviceTierId: null })).toMatchObject({
      accepted: true,
    });
    expect(f.writeSettings).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ serviceTier: null }),
    );
    expect(await f.call("worker_settings")).toMatchObject({ settings: { speed: { id: null } } });
  });

  it("rejects a speed assignment when the provider offers no speed setting", async () => {
    const f = await fixture("claude-code");
    expect(await f.call("worker_settings")).toMatchObject({
      agent: "claude-code",
      settings: { speed: null },
      writable: { serviceTierId: false },
      options: { serviceTiers: [] },
    });
    expect(await f.call("worker_settings", { ...worker, serviceTierId: fast.id })).toMatchObject({
      accepted: false,
      reason: "unsupported-service-tier",
    });
    expect(f.writeSettings).not.toHaveBeenCalled();
  });

  it("fences settings when the Worker is unassigned during the provider read", async () => {
    const f = await fixture();
    const reading = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const settings = f.lanes.sessionSettings!;
    f.lanes.sessionSettings = async (value) => {
      if (value.operation === "settings-state") {
        reading.resolve();
        await finish.promise;
      }
      return settings(value);
    };
    const pending = f.call("worker_settings", { ...worker, modelId: "fixture-model-b" });
    await Promise.race([
      reading.promise,
      pending.then(() => {
        throw new Error("settings read did not start");
      }),
    ]);
    try {
      f.orchestration.removeWorker(LEAD, WORKER);
    } finally {
      finish.resolve();
    }
    expect(await pending).toMatchObject({ accepted: false, reason: "worker-not-assigned" });
    expect(f.writeSettings).not.toHaveBeenCalled();
  });
});

it("includes host resources in the managed worker list and on request from the terminal", async () => {
  const resources = {
    load1m: 10.5,
    cpuCores: 8,
    memoryPressure: "unknown",
    backendStalls: { count: 2, longestMs: 4200 },
    runningSessions: 9,
    level: "strained",
  } as const;
  const hostResources = vi.fn(async () => resources);
  const orchestration = service(host({ hostResources }).lanes);
  orchestration.designate(OWNER);

  const endpoint = await orchestration.leadEndpoint(LEAD);
  const client = new Client({ name: "lead", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(
        (endpoint?.mcpConfig as { mcpServers: { agentkib_workers: { url: string } } }).mcpServers
          .agentkib_workers.url,
      ),
    ),
  );
  cleanups.push(() => client.close());
  expect(client.getInstructions()).toContain("Leave that decision and action to the user.");
  const result = await client.callTool({ name: "worker_list", arguments: {} });
  expect(parse(result.content[0])).toEqual({ paused: false, workers: [], host: resources });

  expect(
    parse(await orchestration.call(LEAD, "worker_list", {}, { hostResources: false })),
  ).toEqual({
    paused: false,
    workers: [],
  });
  expect(hostResources).toHaveBeenCalledTimes(1);
  expect(parse(await orchestration.call(LEAD, "worker_list", {}, { hostResources: true }))).toEqual(
    {
      paused: false,
      workers: [],
      host: resources,
    },
  );
});

describe("Codex Worker sends waiting for the desktop owner", () => {
  const occupied = {
    status: "idle",
    sendEnabled: false,
    ownershipReason: "codex-owner-busy",
    reason: "codex-desktop-ipc-unavailable",
    ownerWaitAvailable: true,
    workspaceId: "w1",
    runtimeBootId: "boot",
    revision: 3,
  };

  async function assigned(laneHost: LaneHost, delivered: string[] = []) {
    const orchestration = service(laneHost, directory(), "boot", (_session, _device, message) => {
      delivered.push(message);
      return false;
    });
    orchestration.designate(OWNER);
    await assignWorker(orchestration);
    return orchestration;
  }

  it("shows the waiting request and cancels it without stopping an intervening desktop turn", async () => {
    const submit = vi.fn<NonNullable<LaneHost["deferCodexSend"]>>();
    const cancel = vi.fn<NonNullable<LaneHost["cancelDeferredCodexSend"]>>();
    const { lanes, calls, lives } = host({
      deferCodexSend: submit,
      cancelDeferredCodexSend: cancel,
    });
    lives.set(WORKER, occupied);
    submit.mockImplementation(async (request, owner) => {
      lives.set(WORKER, {
        ...occupied,
        ownerWait: {
          requestId: request.requestId,
          status: "waiting-for-owner",
          source: "worker",
          laneId: owner.laneId,
        },
      });
      return { accepted: true, status: "waiting-for-owner", requestId: request.requestId };
    });
    cancel.mockImplementation(async () => {
      lives.set(WORKER, occupied);
      return true;
    });

    const orchestration = await assigned(lanes);
    const worker = { worker: "worker-1" };
    const result = parse(
      await orchestration.call(LEAD, "worker_send", { ...worker, text: "Finish the review" }),
    );
    const owner = {
      leadId: LEAD,
      laneId: orchestration.status(LEAD)!.lanes[0]!.id,
      sessionId: WORKER,
      workspaceId: "w1",
      deviceId: DEVICE,
    };
    expect(result).toMatchObject({
      accepted: true,
      status: "waiting-for-owner",
      reason: "codex-waiting-for-owner",
      operation: "send",
    });
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ requestId: result.requestId, text: "Finish the review" }),
      owner,
      false,
    );
    const waiting = { status: "waiting-for-owner", reason: "codex-waiting-for-owner" };
    expect(parse(await orchestration.call(LEAD, "worker_list", {})).workers).toMatchObject([
      waiting,
    ]);
    lives.set(WORKER, {
      ...lives.get(WORKER),
      status: "running",
      turnId: "external-turn",
      stopEnabled: true,
    });
    expect(parse(await orchestration.call(LEAD, "worker_read", worker))).toMatchObject(waiting);
    expect(
      parse(await orchestration.call(LEAD, "worker_send", { ...worker, text: "Duplicate" })),
    ).toMatchObject({ accepted: false, ...waiting, requestId: result.requestId });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(parse(await orchestration.call(LEAD, "worker_stop", worker))).toEqual({
      accepted: true,
      requestId: result.requestId,
      cancelled: true,
    });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(owner, result.requestId);
    expect(calls).toEqual([]);
    expect(parse(await orchestration.call(LEAD, "worker_read", worker))).toMatchObject({
      status: "busy",
    });
  });

  it("sends via the deferred entry even when idle, preserves handoff intent, and exposes an unknown outcome", async () => {
    const submit = vi.fn<NonNullable<LaneHost["deferCodexSend"]>>();
    const { lanes, calls, lives } = host({ deferCodexSend: submit });
    submit.mockResolvedValue({ accepted: false, controlOutcome: "unknown" });
    const orchestration = await assigned(lanes);
    const worker = { worker: "worker-1", text: "Do it once" };
    const result = await orchestration.call(LEAD, "worker_send", worker);
    expect(parse(result)).toMatchObject({ accepted: false, outcome: "unknown", operation: "send" });
    expect(result.isError).toBe(true);
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ operation: "send" }),
      expect.objectContaining({ sessionId: WORKER }),
      false,
    );
    expect(calls).toEqual([]);

    lives.set(WORKER, { ...occupied, ownerHandoff: true, sendEnabled: true });
    submit.mockResolvedValue({ accepted: true });
    expect(parse(await orchestration.call(LEAD, "worker_send", worker))).toMatchObject({
      accepted: true,
      operation: "send",
    });
    expect(submit).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "send" }),
      expect.objectContaining({ sessionId: WORKER }),
      true,
    );
  });

  it("lets a resumed Project Agent request the same paused send after rechecking its assignment", async () => {
    const original = "Continue when the session is free";
    const submit = vi.fn<NonNullable<LaneHost["deferCodexSend"]>>(async ({ text }) =>
      text === original
        ? { accepted: true, status: "waiting-for-owner" }
        : { accepted: false, reason: "codex-waiting-for-owner" },
    );
    const { lanes, lives } = host({ deferCodexSend: submit });
    const orchestration = await assigned(lanes);
    const lane = orchestration.status(LEAD)!.lanes[0]!;
    lives.set(WORKER, {
      ...occupied,
      ownerWaitAvailable: false,
      ownerWait: {
        requestId: "persisted-request",
        status: "paused",
        source: "worker",
        laneId: lane.id,
      },
    });
    const worker = { worker: "worker-1" };
    orchestration.pause(LEAD);
    expect(parse(await orchestration.call(LEAD, "worker_read", worker))).toMatchObject({
      status: "paused",
      reason: "codex-waiting-for-owner",
    });
    expect(
      parse(await orchestration.call(LEAD, "worker_send", { ...worker, text: original })),
    ).toMatchObject({ accepted: false, reason: "delegation-paused" });
    expect(submit).not.toHaveBeenCalled();

    orchestration.resume(LEAD, DEVICE);
    expect(
      parse(await orchestration.call(LEAD, "worker_send", { ...worker, text: "Other text" })),
    ).toMatchObject({ accepted: false, reason: "codex-waiting-for-owner" });
    expect(
      parse(await orchestration.call(LEAD, "worker_send", { ...worker, text: original })),
    ).toMatchObject({ accepted: true, status: "waiting-for-owner" });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "send", text: original }),
      expect.objectContaining({ laneId: lane.id, deviceId: DEVICE }),
      false,
    );
  });

  it("offers waiting even during an observed external Codex turn while retaining steer rules", async () => {
    const submit = vi
      .fn<NonNullable<LaneHost["deferCodexSend"]>>()
      .mockResolvedValue({ accepted: true, status: "waiting-for-owner" });
    const { lanes, lives } = host({ deferCodexSend: submit });
    lives.set(WORKER, {
      ...occupied,
      externalTurn: { status: "running", turnId: "external-turn" },
    });
    const orchestration = await assigned(lanes);
    const worker = { worker: "worker-1", text: "After the desktop user" };
    expect(
      parse(await orchestration.call(LEAD, "worker_send", { ...worker, mode: "steer" })),
    ).toMatchObject({ accepted: false, reason: "codex-desktop-ipc-unavailable" });
    expect(submit).not.toHaveBeenCalled();
    expect(parse(await orchestration.call(LEAD, "worker_send", worker))).toMatchObject({
      accepted: true,
      operation: "send",
      status: "waiting-for-owner",
    });
  });

  it("rechecks the original assignment and reports refused or delayed sends once", async () => {
    const { lanes } = host();
    const reports: string[] = [];
    const orchestration = await assigned(lanes, reports);
    const owner = {
      leadId: LEAD,
      laneId: orchestration.status(LEAD)!.lanes[0]!.id,
      sessionId: WORKER,
      workspaceId: "w1",
      deviceId: DEVICE,
    };
    expect(orchestration.checkDeferredCodexSend(owner)).toBe("ready");
    expect(orchestration.checkDeferredCodexSend({ ...owner, deviceId: "other-device" })).toBe(
      "revoked",
    );
    expect(orchestration.checkDeferredCodexSend({ ...owner, workspaceId: "w2" })).toBe("revoked");
    orchestration.pause(LEAD);
    expect(orchestration.checkDeferredCodexSend(owner)).toBe("paused");
    orchestration.deferredCodexSendResult(owner, "refused-request", {
      status: "refused",
      reason: "native-policy-unconfirmed",
    });
    expect(reports).toEqual([]);
    expect(orchestration.status(LEAD)?.pendingReports).toEqual([
      expect.stringContaining("native-policy-unconfirmed"),
    ]);
    orchestration.resume(LEAD, DEVICE);
    expect(orchestration.checkDeferredCodexSend(owner)).toBe("ready");
    expect(reports).toHaveLength(1);
    const sent = { status: "sent", interveningExternalTurns: true } as const;
    orchestration.deferredCodexSendResult(owner, "sent-request", sent);
    orchestration.deferredCodexSendResult(owner, "sent-request", sent);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toContain("ChatGPT ran other turns while it waited");
    await orchestration.laneTurnEnded(WORKER, "t1", "completed");
    expect(reports[2]).toContain("turn ended: completed");
    orchestration.removeWorker(LEAD, WORKER);
    await assignWorker(orchestration);
    expect(orchestration.checkDeferredCodexSend(owner)).toBe("revoked");
    orchestration.deferredCodexSendResult(owner, "stale-request", sent);
    expect(reports).toHaveLength(3);
  });
});

describe("Project Agent supervision", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");

  async function supervised(
    options: { agent?: string; scope?: Record<string, unknown> } & Partial<LaneHost> = {},
  ) {
    const { agent = "codex", scope, ...overrides } = options;
    const { lanes, lives, calls } = host(overrides);
    const session = lanes.session;
    lanes.session = (id) =>
      id === WORKER ? { agent, workspaceId: "w1", title: null } : session(id);
    const delivered: string[] = [];
    const orchestration = service(lanes, directory(), "boot", (_session, _device, message) => {
      delivered.push(message);
      return false;
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    cleanups.push(() => vi.useRealTimers());
    orchestration.designate({ ...OWNER, scope });
    await assignWorker(orchestration);
    const tick = (milliseconds: number) => {
      vi.setSystemTime(now + milliseconds);
      return orchestration.catchUp();
    };
    const list = async () => parse(await orchestration.call(LEAD, "worker_list", {})).workers[0];
    const read = async () =>
      parse(await orchestration.call(LEAD, "worker_read", { worker: "worker-1" }));
    return { orchestration, delivered, lives, calls, tick, list, read };
  }

  it("respects a user's delegation pause before and during terminal adoption", async () => {
    const adopt = vi.fn<NonNullable<LaneHost["autoAdoptTerminalLead"]>>();
    const { orchestration, lives, tick } = await supervised({ autoAdoptTerminalLead: adopt });
    lives.set(WORKER, { status: "running", turnId: "worker-turn" });
    orchestration.pause(LEAD);
    await tick(0);
    expect(adopt).not.toHaveBeenCalled();

    orchestration.resume(LEAD, DEVICE);
    adopt.mockImplementation(async (id, canAdopt) => {
      expect(id).toBe(LEAD);
      expect(canAdopt()).toBe(true);
      orchestration.pause(LEAD);
      expect(canAdopt()).toBe(false);
      return false;
    });
    await tick(20_000);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(orchestration.status(LEAD)).toMatchObject({ paused: true, reason: "user-paused" });
  });

  it("retries terminal adoption while idle workers have completions waiting to be batched", async () => {
    const adopt = vi.fn<NonNullable<LaneHost["autoAdoptTerminalLead"]>>();
    const { orchestration, delivered, tick } = await supervised({ autoAdoptTerminalLead: adopt });
    const second = await assignWorker(orchestration, "codex-branch");
    await tick(0);
    expect(adopt).not.toHaveBeenCalled();

    await orchestration.laneTurnEnded(WORKER, "t1", "completed", null, undefined, "First reply");
    await orchestration.laneTurnEnded(second, "t2", "completed", null, undefined, "Second reply");
    adopt.mockRejectedValueOnce(new Error("control-outcome-unconfirmed"));
    adopt.mockImplementationOnce(async (id, canAdopt) => id === LEAD && canAdopt());
    await tick(20_000);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual([]);
    await tick(40_000);
    expect(adopt).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual([]);

    await tick(60_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("First reply");
    expect(delivered[0]).toContain("Second reply");
    expect(orchestration.status(LEAD)?.autoTurns).toBe(1);
  });

  it("debounces a terminal disconnect and reports recovery only after a confirmed outage", async () => {
    const { orchestration, delivered, lives, tick, list, read } = await supervised({
      agent: "claude-code",
    });
    const offline = {
      executionMode: "claude-follower",
      status: "unsupported",
      reason: "claude-bridge-disconnected",
      executionLocation: null,
    };
    const online = {
      status: "idle",
      executionMode: "claude-follower",
      executionLocation: "terminal",
    };
    lives.set(WORKER, offline);
    await tick(0);
    await tick(60_000);
    lives.set(WORKER, online);
    await tick(60_001);
    expect(delivered).toEqual([]);

    lives.set(WORKER, offline);
    await tick(80_000);
    await tick(151_000);
    await tick(171_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("(claude-bridge-disconnected). Requires user action");
    expect(await list()).toMatchObject({
      offline: { durationMs: 91_000, reason: "claude-bridge-disconnected" },
    });
    expect(await read()).toHaveProperty("offline.reason", "claude-bridge-disconnected");
    expect(orchestration.roles().get(WORKER)).toHaveProperty("requiresUser", true);
    lives.set(WORKER, online);
    await tick(191_000);
    await tick(211_000);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toContain("connection recovered");
    expect(await list()).not.toHaveProperty("offline");
    expect(orchestration.roles().get(WORKER)).not.toHaveProperty("requiresUser");
  });

  it("reports unavailable live reads and leaves an event gap on a connected terminal alone", async () => {
    let disconnected = true;
    const { delivered, tick } = await supervised({
      observe: async () => {
        if (disconnected) throw new Error("private provider details");
        return {
          status: "unsupported",
          executionMode: "claude-follower",
          executionLocation: "terminal",
          reason: "claude-bridge-event-gap",
        };
      },
    });
    await tick(0);
    await tick(80_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("live-unavailable");
    expect(delivered[0]).not.toContain("private provider");
    disconnected = false;
    await tick(100_000);
    await tick(180_000);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toContain("connection recovered");
  });

  it("projects an automatic limit once, refuses delegation until reset and leaves retries in place", async () => {
    const { orchestration, delivered, lives, calls, tick, list, read } = await supervised();
    const usageLimit = {
      kind: "weekly",
      resetsAt: now + 60_000,
      continueAt: now + 90_000,
      manual: null,
    };
    lives.set(WORKER, {
      status: "idle",
      sendEnabled: true,
      usageLimit: { ...usageLimit, message: "native message", deviceId: "device" },
    });
    await tick(0);
    await tick(20_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("usage limit (weekly)");
    expect(delivered[0]).toContain(new Date(usageLimit.resetsAt).toISOString());
    expect(delivered[0]).toContain(new Date(usageLimit.continueAt).toISOString());
    expect((await read()).usageLimit).toEqual(usageLimit);
    expect((await list()).usageLimit).toEqual(usageLimit);
    const send = () =>
      orchestration.call(LEAD, "worker_send", { worker: "worker-1", text: "next" });
    expect(parse(await send())).toEqual({
      accepted: false,
      reason: "worker-usage-limited",
      resetsAt: usageLimit.resetsAt,
      continueAt: usageLimit.continueAt,
    });
    expect(calls).toEqual([]);
    await tick(60_000);
    expect(parse(await send())).toMatchObject({ accepted: true, operation: "send" });
    expect(calls).toHaveLength(1);
  });

  it("does not report the same weekly reset after unrelated reports fill the worker's history", async () => {
    const caughtUp = Array.from({ length: 64 }, (_, index) => ({
      turnId: `catch-up-${index}`,
      outcome: "completed",
      startedAt: new Date(now + 1000).toISOString(),
      endedAt: new Date(now + 2000 + index).toISOString(),
      replyText: "A separate task finished.",
    }));
    let history: typeof caughtUp = [];
    const { delivered, lives, orchestration, tick } = await supervised({
      endedTurns: async () => history,
    });
    const weekly = { kind: "weekly", resetsAt: now + 48 * 3600_000, manual: "reset-too-far" };
    const weeklyReports = () => delivered.filter((text) => text.includes("usage limit (weekly)"));
    lives.set(WORKER, { status: "idle", usageLimit: weekly });
    await tick(0);
    expect(weeklyReports()).toHaveLength(1);

    lives.set(WORKER, {
      status: "idle",
      usageLimit: { kind: "five-hour", resetsAt: now + 60_000 },
    });
    await tick(20_000);
    expect(delivered.some((text) => text.includes("usage limit (five-hour)"))).toBe(true);
    lives.set(WORKER, { status: "idle" });
    // The native reader only returns a short recent window on each sweep.
    for (let index = 0; index < caughtUp.length; index += 16) {
      history = caughtUp.slice(index, index + 16);
      await tick(80_000 + (index / 16) * 20_000);
    }
    expect(delivered.some((text) => text.includes("A separate task finished."))).toBe(true);
    expect(orchestration.status(LEAD)?.lanes[0]?.reportedTurns).toHaveLength(64);

    lives.set(WORKER, { status: "idle", usageLimit: weekly });
    await tick(160_000);
    expect(weeklyReports()).toHaveLength(1);
  });

  it.each([
    { name: "the account changed", cachedReset: 60_000, latestReset: null },
    { name: "the current account is still limited", cachedReset: 60_000, latestReset: 120_000 },
    { name: "the reset passed with a stale marker", cachedReset: -10_000, latestReset: null },
  ])(
    "refreshes account limits before a Worker send when $name",
    async ({ cachedReset, latestReset }) => {
      const refresh = vi.fn<NonNullable<LaneHost["refreshWorkerUsageLimit"]>>();
      const { orchestration, lives, calls, list } = await supervised({
        refreshWorkerUsageLimit: refresh,
      });
      const usageLimit = {
        kind: "weekly",
        resetsAt: now + cachedReset,
        continueAt: null,
        manual: null,
      };
      const limited = { status: "idle", sendEnabled: false, usageLimit, revision: 3 };
      lives.set(WORKER, limited);
      refresh.mockImplementation(async () => {
        lives.set(WORKER, {
          ...limited,
          revision: 4,
          sendEnabled: latestReset === null,
          usageLimit: latestReset === null ? null : { ...usageLimit, resetsAt: now + latestReset },
        });
        return true;
      });

      expect((await list()).usageLimit).toEqual(usageLimit);
      expect(refresh).not.toHaveBeenCalled();
      const result = parse(
        await orchestration.call(LEAD, "worker_send", { worker: "worker-1", text: "next" }),
      );
      expect(refresh).toHaveBeenCalledExactlyOnceWith(WORKER);
      if (latestReset === null) {
        expect(result).toMatchObject({ accepted: true, operation: "send" });
        expect(calls).toEqual([
          expect.objectContaining({ sessionId: WORKER, operation: "send", expectedRevision: 4 }),
        ]);
      } else {
        expect(result).toEqual({
          accepted: false,
          reason: "worker-usage-limited",
          resetsAt: now + latestReset,
          continueAt: null,
        });
        expect(calls).toEqual([]);
      }
    },
  );

  it("does not send on an expired marker when account limits cannot be verified", async () => {
    const refresh = vi.fn(async () => false);
    const { orchestration, lives, calls } = await supervised({ refreshWorkerUsageLimit: refresh });
    const resetsAt = now - 10_000;
    lives.set(WORKER, {
      status: "idle",
      sendEnabled: true,
      usageLimit: { kind: "weekly", resetsAt },
    });
    expect(
      parse(await orchestration.call(LEAD, "worker_send", { worker: "worker-1", text: "next" })),
    ).toMatchObject({ accepted: false, reason: "worker-usage-limited", resetsAt });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(WORKER);
    expect(calls).toEqual([]);
  });

  it("does not send when the Worker is unassigned during account limit refresh", async () => {
    const refresh = vi.fn<NonNullable<LaneHost["refreshWorkerUsageLimit"]>>();
    const { orchestration, lives, calls } = await supervised({ refreshWorkerUsageLimit: refresh });
    lives.set(WORKER, {
      status: "idle",
      sendEnabled: true,
      usageLimit: { kind: "weekly", resetsAt: now + 60_000 },
    });
    refresh.mockImplementation(async () => {
      orchestration.removeWorker(LEAD, WORKER);
      lives.delete(WORKER);
      return true;
    });
    expect(
      parse(await orchestration.call(LEAD, "worker_send", { worker: "worker-1", text: "next" })),
    ).toEqual({ accepted: false, reason: "worker-not-assigned" });
    expect(calls).toEqual([]);
  });

  it("rearms a stalled turn only after progress and skips waiting, truncated and missing signals", async () => {
    const { delivered, lives, tick, read } = await supervised({ scope: { stallMinutes: 3 } });
    const running = {
      status: "running",
      turnId: "turn",
      streamText: "started",
      workerProgress: "thinking-1",
      commands: [],
      revision: 1,
    };
    lives.set(WORKER, running);
    await tick(0);
    lives.set(WORKER, { ...running, revision: 2 });
    await tick(180_001);
    await tick(360_000);
    expect(delivered).toEqual([]);
    await tick(360_001);
    await tick(380_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("may be stalled");
    expect((await read()).noProgressForMs).toBe(380_000);
    lives.set(WORKER, { ...running, workerProgress: "thinking-2" });
    await tick(400_000);
    await tick(759_999);
    expect(delivered).toHaveLength(1);
    await tick(760_001);
    expect(delivered).toHaveLength(2);

    const states = [
      { ...running, status: "awaiting-approval" },
      { ...running, questions: [{ id: "question" }] },
      { ...running, streamTextTruncated: true, workerProgress: undefined },
      { ...running, streamText: undefined, workerProgress: undefined },
      { ...running, commands: undefined },
    ];
    for (const [index, state] of states.entries()) {
      lives.set(WORKER, state);
      await tick(800_000 + 400_000 * index);
      expect(await read()).not.toHaveProperty("noProgressForMs");
    }
    expect(delivered).toHaveLength(2);
  });

  it("observes a new dispatch after restart without inheriting the previous turn's silence", async () => {
    const { orchestration, delivered, lives, tick } = await supervised({
      scope: { stallMinutes: 3 },
    });
    const active = {
      status: "running",
      turnId: "before-restart",
      workerProgress: "1",
      commands: [],
    };
    lives.set(WORKER, active);
    await tick(0);
    await orchestration.close();
    vi.setSystemTime(now + 3_600_000);
    const resumed = service(
      orchestration.lanes,
      orchestration.registry.dataDir,
      "new-boot",
      (_id, _device, report) => {
        delivered.push(report);
        return false;
      },
    );
    const read = async () => parse(await resumed.call(LEAD, "worker_read", { worker: "worker-1" }));
    await resumed.catchUp();
    expect((await read()).noProgressForMs).toBe(0);
    vi.setSystemTime(now + 3_780_001);
    await resumed.catchUp();
    expect(delivered).toEqual([]);
    lives.set(WORKER, { status: "idle", sendEnabled: true });
    expect(
      parse(await resumed.call(LEAD, "worker_send", { worker: "worker-1", text: "new task" })),
    ).toMatchObject({ accepted: true, operation: "send" });

    // The first post-send read can still be the pre-dispatch observation.
    lives.set(WORKER, active);
    expect(await read()).not.toHaveProperty("noProgressForMs");
    lives.set(WORKER, { ...active, turnId: "after-restart" });
    await resumed.catchUp();
    expect((await read()).noProgressForMs).toBe(0);
    vi.setSystemTime(now + 4_140_002);
    await resumed.catchUp();
    expect(delivered).toEqual([expect.stringContaining("may be stalled")]);
  });

  it("hides an old silence timer as soon as output or a running command is observed", async () => {
    const { delivered, lives, tick, list, read } = await supervised({ scope: { stallMinutes: 3 } });
    const active = { status: "running", turnId: "busy", workerProgress: "1", commands: [] };
    lives.set(WORKER, active);
    await tick(0);
    await tick(180_001);
    expect((await read()).noProgressForMs).toBe(180_001);
    lives.set(WORKER, { ...active, workerProgress: "2" });
    expect(await read()).not.toHaveProperty("noProgressForMs");
    await tick(200_000);
    lives.set(WORKER, { ...active, workerProgress: "2", commands: [{ id: "watch" }] });
    expect(await list()).not.toHaveProperty("noProgressForMs");
    await tick(4_000_000);
    expect(await read()).not.toHaveProperty("noProgressForMs");
    expect(delivered).toEqual([]);
  });

  it("attaches an overdue command to the next report without waking for a tool wait", async () => {
    const { orchestration, delivered, lives, tick, read } = await supervised();
    const live = {
      executionMode: "codex-managed",
      status: "running",
      turnId: "working",
      streamText: "",
      commands: [{ id: "opaque-private-tool-id", startedAt: now }],
    };
    lives.set(WORKER, live);
    await tick(0);
    lives.set(WORKER, { ...live, revision: 25 });
    await tick(1_200_001);
    expect(delivered).toEqual([]);
    expect(await read()).not.toHaveProperty("noProgressForMs");
    await tick(3_620_000);
    expect(delivered).toEqual([]);
    lives.set(WORKER, { status: "idle" });
    await tick(3_640_000);
    await orchestration.laneTurnEnded(WORKER, "working", "completed");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("turn ended: completed");
    expect(delivered[0]).toContain("a command ran for at least 1h");
    expect(delivered[0]).not.toMatch(/stalled|opaque-private-tool-id/);
    await orchestration.laneTurnEnded(WORKER, "later", "completed");
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).not.toContain("a command ran");
  });

  it("batches Worker completions without postponing a question or a failure", async () => {
    const { orchestration, delivered, tick } = await supervised();
    const second = await assignWorker(orchestration, "codex-branch");
    await orchestration.laneTurnEnded(WORKER, "first", "completed");
    await tick(45_000);
    await orchestration.laneTurnEnded(second, "second", "completed");
    expect(delivered).toEqual([]);
    await tick(60_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('Worker "worker-1" (Codex) · turn ended: completed');
    expect(delivered[0]).toContain('Worker "worker-2" (Codex) · turn ended: completed');
    expect(orchestration.status(LEAD)?.autoTurns).toBe(1);

    await orchestration.laneTurnEnded(WORKER, "third", "completed");
    await orchestration.laneWaiting(second, "question", "waiting-input");
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toContain("an answer to its question");
    expect(delivered[1]).toContain("turn ended: completed");
    expect(delivered[1]!.indexOf("turn ended: completed")).toBeLessThan(
      delivered[1]!.indexOf("an answer to its question"),
    );

    await orchestration.laneTurnEnded(second, "failed-turn", "failed");
    expect(delivered).toHaveLength(3);
    expect(delivered[2]).toContain("turn ended: failed");
    await tick(140_000);
    expect(delivered).toHaveLength(3);
  });

  it("automatically delivers an unsent completion preserved across shutdown", async () => {
    const { orchestration, delivered } = await supervised();
    await assignWorker(orchestration, "codex-branch");
    await orchestration.laneTurnEnded(WORKER, "completed-at-shutdown", "completed");
    expect(delivered).toEqual([]);
    await orchestration.close();
    expect(delivered).toEqual([]);
    const resumed = service(
      orchestration.lanes,
      orchestration.registry.dataDir,
      "new-boot",
      (_session, _device, report) => {
        delivered.push(report);
        return false;
      },
    );
    expect(resumed.status(LEAD)).toMatchObject({
      paused: false,
      reportDeliveries: [
        { reportId: expect.any(String), text: expect.stringContaining("turn ended: completed") },
      ],
    });
    expect(await resumed.overview(LEAD)).toMatchObject({ paused: false, pendingReports: 1 });
    expect(
      parse(await resumed.call(LEAD, "worker_send", { worker: "worker-1", text: "next" })),
    ).toMatchObject({ accepted: true });
    await resumed.catchUp();
    expect(delivered).toHaveLength(1);
    expect(await resumed.overview(LEAD)).toMatchObject({ paused: false, pendingReports: 0 });
  });

  it("keeps an actionable approval in an oversized batch of completions", async () => {
    const { orchestration, delivered, lives } = await supervised({
      scope: { approvals: ["command"] },
    });
    const second = await assignWorker(orchestration, "codex-branch");
    for (let round = 0; round < 5; round++)
      await orchestration.laneTurnEnded(
        WORKER,
        `round-${round}`,
        "completed",
        null,
        undefined,
        ("reply from round " + round).repeat(250),
      );
    expect(delivered).toEqual([]);
    lives.set(second, {
      status: "awaiting-approval",
      approvals: [
        {
          requestId: "approval-id",
          supported: true,
          method: "item/commandExecution/requestApproval",
          availableDecisions: ["accept", "decline"],
          command: "check-result",
        },
      ],
    });
    await orchestration.laneWaiting(second, "needs-approval", "awaiting-approval");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("worker_approve");
    expect(delivered[0]).toMatch(/"command":\s*"check-result"/);
    expect(delivered[0]).toContain("Some report details were omitted");
    expect(Buffer.byteLength(delivered[0]!)).toBeLessThanOrEqual(16_000);
  });

  it("discards a stale stall sample when a Worker begins waiting during a history read", async () => {
    const reading = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let blocked = false;
    const { orchestration, delivered, lives, tick } = await supervised({
      scope: { stallMinutes: 3 },
      endedTurns: async () => {
        if (blocked) {
          reading.resolve();
          await finish.promise;
        }
        return [];
      },
    });
    lives.set(WORKER, { status: "running", turnId: "busy", workerProgress: "quiet", commands: [] });
    await tick(0);
    blocked = true;
    const checking = tick(400_000);
    await reading.promise;
    lives.set(WORKER, { status: "waiting-input", turnId: "busy" });
    await orchestration.laneWaiting(WORKER, "busy", "waiting-input");
    finish.resolve();
    await checking;
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("an answer to its question");
    expect(delivered[0]).not.toContain("stalled");
  });

  it("rechecks a possible stall if model output arrived during the history read", async () => {
    const reading = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let blocked = false;
    const { delivered, lives, tick, read } = await supervised({
      scope: { stallMinutes: 3 },
      endedTurns: async () => {
        if (blocked) {
          reading.resolve();
          await finish.promise;
        }
        return [];
      },
    });
    const active = { status: "running", turnId: "busy", workerProgress: "1", commands: [] };
    lives.set(WORKER, active);
    await tick(0);
    blocked = true;
    const checking = tick(400_000);
    await reading.promise;
    lives.set(WORKER, { ...active, workerProgress: "2" });
    finish.resolve();
    await checking;
    expect(delivered).toEqual([]);
    expect((await read()).noProgressForMs).toBe(0);
  });

  it("starts timing when a live observation is available, even if the scan began much earlier", async () => {
    const observe = vi.fn<NonNullable<LaneHost["observe"]>>();
    const { delivered, lives, tick, read } = await supervised({
      scope: { stallMinutes: 3 },
      observe,
    });
    const active = { status: "running", turnId: "new", workerProgress: "1", commands: [] };
    lives.set(WORKER, active);
    observe.mockImplementation(async () => {
      vi.setSystemTime(now + 3_600_000);
      return active;
    });
    await tick(0);
    expect((await read()).noProgressForMs).toBe(0);
    observe.mockResolvedValue(active);
    await tick(3_650_000);
    expect((await read()).noProgressForMs).toBe(50_000);
    expect(delivered).toEqual([]);
  });

  it("can attach a shorter model stall once and drops it if real activity resumes before a report", async () => {
    const { orchestration, delivered, lives, tick } = await supervised({
      scope: { stallMinutes: 3 },
    });
    const second = await assignWorker(orchestration, "codex-branch");
    const run = { status: "running", turnId: "turn", workerProgress: "thinking-1", commands: [] };
    lives.set(WORKER, run);
    await tick(0);
    await tick(180_001);
    expect(delivered).toEqual([]);
    await orchestration.laneWaiting(second, "approval", "awaiting-approval");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("may be stalled");
    await tick(380_000);
    expect(delivered).toHaveLength(1);

    lives.set(WORKER, { ...run, workerProgress: "thinking-2" });
    await tick(400_000);
    await tick(590_000);
    lives.set(WORKER, { ...run, workerProgress: "thinking-3" });
    await tick(600_000);
    await orchestration.laneWaiting(second, "question", "waiting-input");
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).not.toContain("stalled");
  });

  it("shows occupied Codex sessions without a proven running turn as busy", async () => {
    const { orchestration, lives, list, read, calls } = await supervised();
    lives.set(WORKER, {
      executionMode: "codex-managed",
      executionLocation: "external",
      ownershipReason: "codex-owner-busy",
      reason: "codex-owner-busy",
      status: "idle",
      sendEnabled: false,
    });
    expect(await list()).toMatchObject({ status: "busy", reason: "codex-owner-busy" });
    expect(await read()).toMatchObject({ status: "busy", reason: "codex-owner-busy" });
    expect(await read()).not.toHaveProperty("noProgressForMs");
    expect(
      parse(await orchestration.call(LEAD, "worker_send", { worker: "worker-1", text: "next" })),
    ).toMatchObject({ accepted: false, reason: "codex-owner-busy" });
    expect(calls).toHaveLength(0);
  });

  it("uses externalTurn for a followed Codex Worker and obeys the owner's queue capability", async () => {
    const { orchestration, lives, list, read, calls, delivered, tick } = await supervised({
      scope: { stallMinutes: 3 },
    });
    const followed = {
      executionMode: "codex-follower",
      executionLocation: "external",
      status: "idle",
      sendEnabled: true,
      queueEnabled: false,
      streamText: "",
      commands: [],
      externalTurn: {
        status: "running",
        turnId: "desktop-turn",
        startedAt: new Date(now).toISOString(),
      },
    };
    lives.set(WORKER, followed);
    await tick(0);
    await tick(370_000);
    expect(await list()).toMatchObject({ status: "running", noProgressForMs: 370_000 });
    expect(await read()).toMatchObject({ status: "running", noProgressForMs: 370_000 });
    expect(delivered).toHaveLength(1);
    const send = () =>
      orchestration.call(LEAD, "worker_send", { worker: "worker-1", text: "next" });
    expect(parse(await send())).toMatchObject({
      accepted: false,
      reason: "follower-operation-unverified",
    });
    expect(calls).toHaveLength(0);
    lives.set(WORKER, { ...followed, queueEnabled: true });
    expect(parse(await send())).toMatchObject({ accepted: true, operation: "queue-add" });
    expect(calls).toEqual([expect.objectContaining({ operation: "queue-add" })]);
  });

  it("starts a new clock when the followed owner advances before its rollout", async () => {
    const { lives, tick, delivered, read } = await supervised({ scope: { stallMinutes: 3 } });
    const followed = {
      executionMode: "codex-follower",
      status: "running",
      streamText: "",
      commands: [],
      externalTurn: { status: "running", turnId: "old-turn" },
    };
    lives.set(WORKER, { ...followed, turnId: "old-turn" });
    await tick(0);
    lives.set(WORKER, { ...followed, turnId: "new-turn" });
    await tick(180_001);
    expect(delivered).toHaveLength(0);
    expect((await read()).noProgressForMs).toBe(0);
  });

  it("gives Devin time to read a reset and never treats its runner revision as progress", async () => {
    const { delivered, lives, tick, read } = await supervised({ agent: "devin" });
    lives.set(WORKER, {
      status: "idle",
      usageLimitPending: true,
      usageLimit: { kind: "credits", resetsAt: null, continueAt: null, manual: "reset-unknown" },
    });
    await tick(20_000);
    expect(delivered).toEqual([]);
    lives.set(WORKER, {
      status: "idle",
      usageLimit: {
        kind: "credits",
        resetsAt: now + 60_000,
        continueAt: now + 90_000,
        manual: null,
      },
    });
    await tick(40_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("AgentKib will continue");
    lives.set(WORKER, { status: "running", turnId: "devin-turn", revision: 3 });
    await tick(100_000);
    await tick(800_000);
    expect(await read()).not.toHaveProperty("noProgressForMs");
    expect(delivered).toHaveLength(1);
  });

  it("silences only a superseded empty success and keeps the older reply and failure", async () => {
    const at = (offset: number) => new Date(now + offset).toISOString();
    const { orchestration, delivered, tick } = await supervised({
      events: async () => [
        { kind: "agent-message", turn_id: "with-reply", content: "An older useful reply." },
      ],
      endedTurns: async () => [
        {
          turnId: "empty",
          outcome: "completed",
          startedAt: at(1_000),
          endedAt: at(12_000),
        },
        {
          turnId: "with-reply",
          outcome: "completed",
          startedAt: at(13_000),
          endedAt: at(17_000),
        },
        {
          turnId: "failed",
          outcome: "failed",
          startedAt: at(18_000),
          endedAt: at(20_000),
        },
        {
          turnId: "recent",
          outcome: "completed",
          startedAt: at(85_000),
          endedAt: at(90_000),
        },
      ],
    });
    await tick(110_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).not.toContain("turn ended: completed after 11s");
    expect(delivered[0]).toContain("An older useful reply.");
    expect(delivered[0]).toContain("turn ended: failed after 2s");
    expect(delivered[0]).toContain("turn ended: completed after 5s");
    expect(orchestration.status(LEAD)?.lanes[0]?.reportedTurns).toEqual([
      "empty",
      "with-reply",
      "failed",
      "recent",
    ]);
    await tick(140_000);
    expect(delivered).toHaveLength(1);
  });

  it("retries a superseded completion when its history read fails", async () => {
    let canReadReply = false;
    const { orchestration, delivered, tick } = await supervised({
      events: async () => {
        if (!canReadReply) throw new Error("temporary history read failure");
        return [{ kind: "agent-message", turn_id: "older", content: "Recovered reply." }];
      },
      endedTurns: async () => [
        {
          turnId: "older",
          outcome: "completed",
          startedAt: new Date(now + 1_000).toISOString(),
          endedAt: new Date(now + 5_000).toISOString(),
          superseded: true,
        },
      ],
    });
    await tick(80_000);
    expect(delivered).toEqual([]);
    expect(orchestration.status(LEAD)?.lanes[0]?.reportedTurns).toEqual([]);
    canReadReply = true;
    await tick(100_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("Recovered reply.");
  });

  it("batches missed turns and health events into a single turn and preserves the budget and pause", async () => {
    const { delivered, lives, orchestration, tick } = await supervised({
      scope: { maxAutoTurns: 1 },
      endedTurns: async () => [
        {
          turnId: "missed",
          outcome: "completed",
          startedAt: new Date(now).toISOString(),
          endedAt: new Date(now + 1_000).toISOString(),
          replyText: "result",
        },
      ],
    });
    lives.set(WORKER, { status: "disconnected", reason: "codex-disconnected" });
    await tick(0);
    lives.set(WORKER, {
      status: "disconnected",
      reason: "codex-disconnected",
      usageLimit: { kind: "credits", resetsAt: null, continueAt: null, manual: "reset-unknown" },
    });
    await tick(80_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("turn ended");
    expect(delivered[0]).toContain("offline for");
    expect(delivered[0]).toContain("Requires user action (reset-unknown)");
    expect(orchestration.status(LEAD)?.autoTurns).toBe(1);
    lives.set(WORKER, { status: "idle" });
    await tick(100_000);
    expect(delivered).toHaveLength(1);
    expect(orchestration.status(LEAD)).toMatchObject({
      paused: true,
      reason: "auto-turn-limit",
      pendingReports: [expect.stringContaining("connection recovered")],
    });
    await tick(120_000);
    orchestration.resume(LEAD, DEVICE);
    expect(delivered).toHaveLength(2);
  });
});

describe("Worker interruptions during app quit", () => {
  it.each([
    ["continued", "AgentKib has started a continuation in the same session"],
    ["not-continued", "AgentKib did not start a continuation"],
    ["unknown", "AgentKib could not confirm whether a continuation started"],
  ] as const)("reports %s once without pausing delegation after restart", async (outcome, text) => {
    const root = directory();
    const { lanes } = host();
    const before = service(lanes, root, "before-quit");
    before.designate(OWNER);
    await assignWorker(before);
    const assignment = before.registry.leadOfLane(WORKER)!;
    const deliver = vi.fn((_lead: string, _device: string, _report: string) => false);
    const after = service(lanes, root, "after-quit", deliver);
    const captured = { leadId: assignment.lead.sessionId, laneId: assignment.lane.id };
    expect(after.status(LEAD)).toMatchObject({
      paused: false,
      reason: null,
    });
    after.workerInterruptedByQuit(WORKER, "t1", outcome, captured);
    after.workerInterruptedByQuit(WORKER, "t1", outcome, captured);
    await after.laneTurnEnded(WORKER, "t1", "cancelled");
    await vi.waitFor(() =>
      expect(deliver).toHaveBeenCalledExactlyOnceWith(
        LEAD,
        DEVICE,
        expect.stringContaining(text),
        expect.any(Function),
        expect.any(String),
      ),
    );
    expect(deliver.mock.calls[0]?.[2]).toContain("interrupted when AgentKib quit");
    expect(after.status(LEAD)).toMatchObject({
      paused: false,
      reason: null,
      autoTurns: 1,
    });
    expect(
      parse(await after.call(LEAD, "worker_send", { worker: "worker-1", text: "new" })),
    ).toMatchObject({ accepted: true });
  });

  it.each(["user-paused", "auto-turn-limit"])(
    "delivers while %s, then resumes without repeating the report",
    async (reason) => {
      const { lanes } = host();
      const root = directory();
      const before = service(lanes, root);
      before.designate(OWNER);
      await assignWorker(before);
      const assignment = before.registry.leadOfLane(WORKER)!;
      before.pause(LEAD, reason);
      const deliver = vi.fn((_lead: string, _device: string, _report: string) => false);
      const after = service(lanes, root, "after-quit", deliver);
      after.workerInterruptedByQuit(WORKER, "t1", "continued", { leadId: LEAD, laneId: "other" });
      expect(deliver).not.toHaveBeenCalled();
      after.workerInterruptedByQuit(WORKER, "t1", "continued", {
        leadId: LEAD,
        laneId: assignment.lane.id,
      });
      await vi.waitFor(() =>
        expect(deliver).toHaveBeenCalledExactlyOnceWith(
          LEAD,
          DEVICE,
          expect.stringContaining("interrupted when AgentKib quit"),
          expect.any(Function),
          expect.any(String),
        ),
      );
      expect(after.status(LEAD)).toMatchObject({
        paused: true,
        reason,
        pendingReports: [],
      });
      after.resume(LEAD, DEVICE);
      await after.catchUp();
      expect(after.status(LEAD)?.paused).toBe(false);
      expect(deliver).toHaveBeenCalledTimes(1);
    },
  );

  it("retains reports across restart at a provider limit, then delivers without lifting a manual pause", async () => {
    const root = directory();
    const { lanes } = host();
    const before = service(lanes, root);
    before.designate(OWNER);
    await assignWorker(before);
    before.pause(LEAD);
    const { lead, lane } = before.registry.leadOfLane(WORKER)!;
    const deliver = vi.fn((_lead: string, _device: string, _report: string) => false);
    let limited = true;
    const open = (boot: string) => {
      const owner = new OrchestrationService(
        root,
        boot,
        lanes,
        () => true,
        deliver,
        () => 0,
        () => limited,
      );
      cleanups.push(() => owner.close());
      return owner;
    };
    const after = open("after");
    after.workerInterruptedByQuit(WORKER, "t1", "continued", {
      leadId: lead.sessionId,
      laneId: lane.id,
    });
    await after.catchUp();
    expect(deliver).not.toHaveBeenCalled();
    await after.close();
    const reopened = open("again");
    await reopened.catchUp();
    expect(deliver).not.toHaveBeenCalled();
    // The usage limit can appear at send time, after the initial check.
    limited = false;
    deliver.mockImplementationOnce(() => {
      throw new LeadReportUsageLimit("usage-limit");
    });
    reopened.limitEnded(LEAD);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    reopened.limitEnded(LEAD);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[1]?.[2]).toContain("AgentKib has started a continuation");
    expect(reopened.status(LEAD)).toMatchObject({
      paused: true,
      reason: "user-paused",
      autoTurns: 1,
    });
  });

  it("holds quit reports if the device authorization changed while delegation was paused", async () => {
    const root = directory();
    const { lanes } = host();
    const before = service(lanes, root);
    before.designate(OWNER);
    await assignWorker(before);
    before.pause(LEAD);
    before.invalidateDevice(DEVICE);
    before.pause(LEAD);
    const { lane } = before.registry.leadOfLane(WORKER)!;
    const deliver = vi.fn((_lead: string, _device: string, _report: string) => false);
    const after = service(lanes, root, "after", deliver);
    after.workerInterruptedByQuit(WORKER, "t1", "not-continued", { leadId: LEAD, laneId: lane.id });
    await after.catchUp();
    expect(after.status(LEAD)?.reason).toBe("authorization-changed");
    expect(deliver).not.toHaveBeenCalled();
    after.resume(LEAD, "re-authorized");
    await vi.waitFor(() =>
      expect(deliver).toHaveBeenCalledExactlyOnceWith(
        LEAD,
        "re-authorized",
        expect.stringContaining("did not start a continuation"),
        expect.any(Function),
        expect.any(String),
      ),
    );
  });

  it.each(["in-flight", "unknown"])(
    "automatically retries a %s quit report after restart with its original ID",
    async (mode) => {
      const root = directory();
      const { lanes } = host();
      const before = service(lanes, root);
      before.designate(OWNER);
      await assignWorker(before);
      const { lane } = before.registry.leadOfLane(WORKER)!;
      const uncertain = vi.fn<OrchestrationService["sendReport"]>(() => {
        if (mode === "in-flight") return new Promise<boolean>(() => {});
        throw new Error("outcome_unknown");
      });
      const after = service(lanes, root, "after", uncertain);
      after.workerInterruptedByQuit(WORKER, "t1", "unknown", { leadId: LEAD, laneId: lane.id });
      await vi.waitFor(() => expect(uncertain).toHaveBeenCalledTimes(1));
      const [pending] = after.status(LEAD)!.reportDeliveries!;
      expect(pending!.reportId).toBe(uncertain.mock.calls[0]?.[4]);
      await after.close();
      const deliver = vi.fn<OrchestrationService["sendReport"]>(() => false);
      const reopened = service(lanes, root, "again", deliver);
      expect(parse(await reopened.call(LEAD, "worker_list", {}))).toMatchObject({
        paused: false,
      });
      if (pending!.retryAt !== undefined) {
        await reopened.catchUp(pending!.retryAt - 1);
        expect(deliver).not.toHaveBeenCalled();
      }
      await reopened.catchUp(pending!.retryAt);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      expect(deliver.mock.calls[0]?.[4]).toBe(pending!.reportId);
      await reopened.catchUp();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(reopened.status(LEAD)).toMatchObject({ paused: false, reason: null });
      expect(reopened.roles().get(LEAD)).not.toHaveProperty("recovering");
    },
  );

  it("retries a quit report that was definitely not dispatched", async () => {
    const root = directory();
    const { lanes } = host();
    const before = service(lanes, root);
    before.designate(OWNER);
    await assignWorker(before);
    const { lane } = before.registry.leadOfLane(WORKER)!;
    const deliver = vi
      .fn(() => false)
      .mockImplementationOnce(() => {
        throw new LeadReportNotDispatched("stale-revision");
      });
    const after = service(lanes, root, "after", deliver);
    after.workerInterruptedByQuit(WORKER, "t1", "unknown", { leadId: LEAD, laneId: lane.id });
    expect(deliver).toHaveBeenCalledTimes(1);
    await after.catchUp(after.status(LEAD)!.reportDeliveries![0]!.retryAt!);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(after.status(LEAD)).toMatchObject({
      paused: false,
      reason: null,
      autoTurns: 1,
    });
  });
});

describe("lead registry", () => {
  it("keeps active delegation across processes after a restart", () => {
    const root = directory();
    const first = new LeadRegistry(root, "boot-1");
    first.create({
      sessionId: LEAD,
      deviceId: DEVICE,
      createdAt: new Date().toISOString(),
      paused: false,
      reason: null,
      scope: {
        workspaceIds: ["w1"],
        policies: ["workspace-write-on-request"],
        maxLanes: 4,
        maxAutoTurns: 25,
      },
    });
    expect(first.get(LEAD)).toMatchObject({ paused: false, revision: 1 });
    const second = new LeadRegistry(root, "boot-2");
    expect(second.get(LEAD)).toMatchObject({
      paused: false,
      reason: null,
      bootId: "boot-2",
      scope: { maxLanes: 4 },
    });
    expect(() =>
      second.create({
        sessionId: LEAD,
        deviceId: DEVICE,
        createdAt: "",
        paused: false,
        reason: null,
        scope: {
          workspaceIds: ["w1"],
          policies: ["workspace-write-on-request"],
          maxLanes: 4,
          maxAutoTurns: 25,
        },
      }),
    ).toThrow("lead-exists");
    expect(second.remove(LEAD)).toBe(true);
    expect(second.get(LEAD)).toBeNull();
  });

  it.each(["old", "new"])(
    "lifts a legacy restart pause once, reading it in boot %s",
    async (bootId) => {
      const root = directory();
      const { lanes } = host();
      const before = service(lanes, root, "old");
      before.designate(OWNER);
      before.registry.update(LEAD, (lead) => {
        lead.paused = true;
        lead.reason = "restart-confirmation-required";
        lead.pendingReports = ["held during the old pause"];
      });

      const deliver = vi.fn<OrchestrationService["sendReport"]>(() => false);
      const after = service(lanes, root, bootId, deliver);
      expect(after.status(LEAD)).toMatchObject({ paused: false, reason: null });
      await after.catchUp();
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0]?.[2]).toBe("held during the old pause");
      expect(deliver.mock.calls[0]?.[4]).toEqual(expect.any(String));
      const reopened = service(lanes, root, "another-boot", deliver);
      await reopened.catchUp();
      expect(deliver).toHaveBeenCalledOnce();
      expect(
        reopened
          .status(LEAD)
          ?.records.filter((record) => record.outcome === "restart-confirmation-removed"),
      ).toEqual([expect.objectContaining({ kind: "resume" })]);
    },
  );

  it.each([true, false])(
    "lifts an old delivery pause and retries only confirmed unsent reports (confirmed %s)",
    async (confirmed) => {
      const root = directory();
      const { lanes } = host();
      const before = service(lanes, root, "old");
      before.designate(OWNER);
      await assignWorker(before);
      before.registry.update(LEAD, (lead) => {
        lead.paused = true;
        lead.reason = "report-undelivered";
        lead.pendingReports = ["previous pending report"];
        lead.deliveringReports = ["previous in-flight report"];
        if (confirmed) lead.reportRetryable = true;
      });

      const deliver = vi.fn<OrchestrationService["sendReport"]>(() => false);
      const after = service(lanes, root, "new", deliver);
      expect(after.status(LEAD)).toMatchObject({
        paused: false,
        reason: null,
        legacyUnconfirmedReports: confirmed
          ? ["previous in-flight report"]
          : ["previous in-flight report", "previous pending report"],
      });
      expect(
        parse(await after.call(LEAD, "worker_send", { worker: "worker-1", text: "new" })),
      ).toMatchObject({ accepted: true });
      await after.catchUp();
      expect(deliver.mock.calls.map((call) => call[2])).toEqual(
        confirmed ? ["previous pending report"] : [],
      );
    },
  );
});

describe("orchestration service", () => {
  it("requires a lead-capable session and ignores legacy settings on designation", () => {
    const orchestration = service(host().lanes);
    expect(() => orchestration.designate({ ...OWNER, sessionId: "claude-other" })).toThrow(
      "lead-not-controllable",
    );
    const legacyScope = {
      workspaceIds: ["unknown"],
      policies: ["workspace-write-auto-review" as const],
      maxLanes: 1,
      maxAutoTurns: 12,
    };
    expect(orchestration.designate({ ...OWNER, scope: legacyScope })).toMatchObject({
      paused: false,
      scope: { workspaceIds: ["w1"], policies: [], maxLanes: 10, maxAutoTurns: 12 },
    });
  });

  it("rejects Antigravity assignments before checking whether the Worker is reachable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanups.push(() => vi.useRealTimers());
    const { lanes } = host();
    const managed = vi.fn(async () => true);
    const session: LaneHost["session"] = (id) =>
      id === "agy-session"
        ? { agent: "antigravity", workspaceId: "w1", title: null }
        : lanes.session(id);
    const orchestration = service(
      { ...lanes, session, managed },
      directory(),
      "boot",
      undefined,
      () => true,
    );
    expect(await orchestration.assignmentOptions(LEAD, "w1", ["agy-session"])).toMatchObject({
      capable: true,
      candidates: [{ sessionId: "agy-session", reason: "antigravity-acp-disabled" }],
    });
    expect(await orchestration.assignmentOptions("agy-session", "w1", [])).toMatchObject({
      capable: false,
      remaining: 0,
    });
    await expect(assignWorker(orchestration, "agy-session")).rejects.toThrow(
      "antigravity-acp-disabled",
    );
    expect(() => orchestration.designate({ ...OWNER, sessionId: "agy-session" })).toThrow(
      "antigravity-acp-disabled",
    );
    await expect(
      orchestration.assignWorkers({ ...OWNER, sessionId: "agy-session", workers: [WORKER] }),
    ).rejects.toThrow("antigravity-acp-disabled");
    expect(managed).not.toHaveBeenCalled();
    expect(orchestration.registry.list()).toEqual([]);
  });

  it("keeps Antigravity assignments dormant and does not dispatch their saved reports after restart", async () => {
    const root = directory();
    const agyLead = "agy-lead";
    const agyWorker = "agy-worker";
    const { lanes, calls } = host();
    const session: LaneHost["session"] = (id) =>
      id === agyLead || id === agyWorker
        ? { agent: "antigravity", workspaceId: "w1", title: null }
        : lanes.session(id);
    const observe = vi.fn(lanes.live);
    const events = vi.fn(lanes.events);
    const hostWithAntigravity = { ...lanes, session, observe, events, managed: async () => true };
    const before = service(
      { ...hostWithAntigravity, antigravityAcpEnabled: true },
      root,
      "old",
      undefined,
      () => true,
    );
    await before.assignWorkers({ ...OWNER, workers: [agyWorker, WORKER] });
    await before.assignWorkers({ ...OWNER, sessionId: agyLead, workers: ["codex-branch"] });
    const activeLane = before.registry.get(LEAD)!.lanes[1]!;
    const agyLane = before.registry.get(LEAD)!.lanes[0]!;
    const delegatedLane = before.registry.get(agyLead)!.lanes[0]!;
    const activeReport = workerReport(activeLane, "active report");
    const oldAgyReport = workerReport(agyLane, "old Antigravity report");
    before.registry.update(LEAD, (lead) => {
      lead.reason = "usage-limit";
      lead.paused = true;
      lead.pendingReports = [oldAgyReport, activeReport];
      lead.reportDeliveries = [
        { reportId: "worker-report", sourceLaneIds: [agyLane.id], text: "dormant source" },
        { reportId: "quit-report", quitLaneId: agyLane.id, text: "dormant quit report" },
      ];
    });
    before.registry.update(agyLead, (lead) => {
      lead.pendingReports = ["report to dormant Project Agent"];
    });
    await before.close();

    const sendReport = vi.fn<OrchestrationService["sendReport"]>(() => false);
    const after = service(hostWithAntigravity, root, "new", sendReport, () => true);
    expect(after.roles().has(agyLead)).toBe(false);
    expect(after.roles().has(agyWorker)).toBe(false);
    expect(await after.overview(agyLead)).toMatchObject({
      paused: true,
      reason: "antigravity-acp-disabled",
      workers: [{ sessionId: "codex-branch", status: "unavailable", stopEnabled: false }],
    });
    expect(await after.leadEndpoint(agyLead)).toBeNull();
    expect(() => after.resume(agyLead, DEVICE)).toThrow("antigravity-acp-disabled");
    expect(
      parse(await after.call(agyLead, "worker_send", { worker: "worker-1", text: "old" })),
    ).toMatchObject({ reason: "not-a-project-agent" });
    expect(
      after.checkDeferredCodexSend({
        leadId: agyLead,
        laneId: delegatedLane.id,
        sessionId: delegatedLane.sessionId,
        workspaceId: delegatedLane.workspaceId,
        deviceId: DEVICE,
      }),
    ).toBe("revoked");
    await after.laneTurnEnded(agyWorker, "turn", "completed");
    await after.laneWaiting(agyWorker, "turn", "waiting-approval");
    after.workerInterruptedByQuit(agyWorker, "turn", "not-continued", {
      leadId: LEAD,
      laneId: agyLane.id,
    });
    after.limitEnded(agyLead);
    after.limitEnded(LEAD);
    await after.catchUp();
    expect(
      parse(await after.call(LEAD, "worker_send", { worker: "worker-1", text: "old" })),
    ).toMatchObject({ reason: "worker-agent-unsupported" });
    expect(sendReport.mock.calls.map(([id, , message]) => [id, message])).toEqual([
      [LEAD, activeReport],
    ]);
    expect(after.registry.get(LEAD)?.reportDeliveries?.map(({ text }) => text)).toEqual([
      "dormant source",
      "dormant quit report",
      oldAgyReport,
    ]);
    expect(after.registry.get(agyLead)?.reportDeliveries).toMatchObject([
      { text: "report to dormant Project Agent" },
    ]);
    expect(calls).toEqual([]);
    expect(observe.mock.calls.map(([id]) => id)).toEqual([WORKER]);
    expect(events).not.toHaveBeenCalled();
    expect(await after.release(agyLead)).toBe(true);
    expect(await after.assignmentOptions(LEAD, "w1", ["codex-branch"])).toMatchObject({
      candidates: [{ sessionId: "codex-branch", reason: null }],
    });
  });

  it("keeps legacy and new assignments, without exposing or losing a future Worker type", async () => {
    const root = directory();
    const agents = new Map([
      ["existing-codex", "codex"],
      ["existing-dsh", "deepseek-harness"],
      ["existing-claude", "claude-code"],
      ["existing-devin", "devin"],
      ["existing-antigravity", "antigravity"],
    ]);
    const { lanes } = host({
      antigravityAcpEnabled: true,
      session: (sessionId) => {
        const agent = agents.get(sessionId);
        return agent ? { agent, workspaceId: "w1", title: null } : null;
      },
      managed: async () => true,
    });
    const orchestration = service(lanes, root);
    await orchestration.assignWorkers({ ...OWNER, workers: [...agents.keys()] });
    const database = openManagedLedger(root, true)!;
    try {
      const row = database
        .prepare("SELECT record FROM orchestration_leads WHERE session_id=?")
        .get(LEAD) as { record: string };
      const stored = JSON.parse(row.record);
      expect(stored.version).toBe(1);
      expect(stored.lanes.map((lane: { agent: string }) => lane.agent)).toEqual([
        ...agents.values(),
      ]);
      delete stored.lanes[0].agent; // Older records used implicit Codex.
      stored.lanes.push({
        ...stored.lanes[0],
        id: "future",
        sessionId: "future",
        name: "worker-6",
        agent: "future-agent",
      });
      database
        .prepare("UPDATE orchestration_leads SET record=? WHERE session_id=?")
        .run(JSON.stringify(stored), LEAD);
      expect(orchestration.status(LEAD)?.lanes.map((lane) => lane.sessionId)).toEqual([
        ...agents.keys(),
      ]);
      expect(orchestration.roles().has("future")).toBe(false);
      expect(
        parse(await orchestration.call(LEAD, "worker_list", {})).workers.map(
          (lane: { agent: string }) => lane.agent,
        ),
      ).toEqual([...agents.values()]);
      agents.set("another-codex", "codex");
      await orchestration.assignWorkers({ ...OWNER, workers: ["another-codex"] });
      expect(orchestration.status(LEAD)?.lanes.at(-1)).toMatchObject({
        sessionId: "another-codex",
        name: "worker-7",
      });
      const saved = database
        .prepare("SELECT record FROM orchestration_leads WHERE session_id=?")
        .get(LEAD) as { record: string };
      expect(JSON.parse(saved.record).lanes.at(-1)).toMatchObject({
        agent: "future-agent",
        id: "future",
      });
    } finally {
      database.close();
    }
  });

  it.each(["devin", "antigravity"] as const)(
    "queues work without attempting a native steer for %s",
    async (agent) => {
      const { lanes, lives, calls } = host({
        antigravityAcpEnabled: agent === "antigravity",
        session: (sessionId) =>
          sessionId === WORKER ? { agent, workspaceId: "w1", title: null } : null,
        managed: async () => true,
      });
      const orchestration = service(lanes);
      await assignWorker(orchestration);
      lives.set(WORKER, {
        turnId: "turn",
        status: "waiting-approval",
        runtimeBootId: "boot",
        revision: 4,
      });
      expect(
        parse(await orchestration.call(LEAD, "worker_send", { worker: "worker-1", text: "later" })),
      ).toMatchObject({ accepted: true, operation: "queue-add" });
      expect(
        parse(
          await orchestration.call(LEAD, "worker_send", {
            worker: "worker-1",
            text: "now",
            mode: "steer",
          }),
        ),
      ).toMatchObject({ accepted: false, reason: "steer-unsupported" });
      expect(calls).toEqual([
        expect.objectContaining({ operation: "queue-add", sessionId: WORKER, text: "later" }),
      ]);
    },
  );

  it("reads legacy persisted settings while deriving capacity and workspace authority", async () => {
    const root = directory();
    const { lanes } = host();
    const first = service(lanes, root);
    await assignWorker(first, "codex-branch");
    first.registry.update(LEAD, (lead) => {
      lead.scope = {
        workspaceIds: ["w1", "w9"],
        policies: ["workspace-write-auto-review"],
        maxLanes: 1,
        maxAutoTurns: 14,
        approvals: ["file-change"],
        answers: true,
      };
    });

    const restored = service(lanes, root, "boot-2");
    expect(await restored.overview(LEAD)).toMatchObject({
      paused: false,
      scope: {
        workspaceIds: ["w1", "w2"],
        policies: [],
        maxLanes: 10,
        maxAutoTurns: 14,
        approvals: ["file-change"],
        answers: true,
      },
    });
    expect(() => restored.resume(LEAD, "other-device", ["w1", "w9"])).toThrow(
      "workspace_not_authorized",
    );
    await expect(
      restored.update({
        sessionId: LEAD,
        deviceId: "other-device",
        scope: { workspaceIds: ["w1", "w9"], maxAutoTurns: 1 },
        authorizedWorkspaceIds: ["w1", "w9"],
      }),
    ).rejects.toThrow("workspace_not_authorized");
    expect(restored.status(LEAD)).toMatchObject({
      paused: false,
      deviceId: DEVICE,
      scope: { maxAutoTurns: 14 },
    });
    restored.resume(LEAD, "other-device", ["w1", "w2"]);
    expect(await restored.assignmentOptions(LEAD, "w1", [])).toMatchObject({ remaining: 9 });
  });

  it.each([true, false])(
    "assigns an existing Codex worker with managed=%s and leaves execution preparation to send",
    async (managed) => {
      const { lanes, calls } = host({ managed: async () => managed });
      const orchestration = service(lanes);
      await assignWorker(orchestration);
      expect(calls).toEqual([]);
      expect(
        parse(
          await orchestration.call(LEAD, "worker_send", {
            worker: "worker-1",
            text: "Review this",
          }),
        ),
      ).toMatchObject({ accepted: true, operation: "send" });
      expect(calls).toEqual([
        expect.objectContaining({
          operation: "send",
          sessionId: WORKER,
          deviceId: DEVICE,
          runtimeBootId: "boot",
          expectedRevision: 3,
          text: "Review this",
        }),
      ]);
    },
  );

  describe("assigning existing sessions", () => {
    it("reports a disconnected Claude terminal only when its owner was observed", async () => {
      const terminal = vi.fn(async () => false);
      const roles = projectAgentRoleAdapters({
        session: () => ({ agent: "claude-code", workspaceId: "w1", title: null }),
        claude: {
          managedWorkspace: () => null,
          hasRunningNativeTerminal: terminal,
          projectAgentToolsReady: () => null,
          projectAgentControlRefusal: () => undefined,
          externalTurn: () => undefined,
        },
        web: () => {
          throw new Error("unexpected Web read");
        },
        antigravityEnabled: false,
      });
      expect(await roles("native-history", "worker")).toMatchObject({
        executionSide: null,
        reason: "worker-not-controllable",
      });
      terminal.mockResolvedValue(true);
      expect(await roles("native-history", "worker")).toMatchObject({
        executionSide: "terminal",
        reason: "worker-terminal-disconnected",
      });
    });

    it("uses provider eligibility at listing, confirmation and dispatch", async () => {
      let connected = false;
      const { lanes, calls } = host({
        projectAgentRole: async (id, role) =>
          id === LEAD
            ? { executionSide: "agentkib", toolsReady: false }
            : {
                executionSide: "terminal",
                reason: connected || role !== "worker" ? undefined : "worker-terminal-disconnected",
              },
      });
      const orchestration = service(lanes);
      expect(await orchestration.assignmentOptions(LEAD, "w1", [WORKER])).toMatchObject({
        capable: true,
        eligibility: { availability: { available: true }, toolsReady: false },
        candidates: [
          {
            sessionId: WORKER,
            reason: "worker-terminal-disconnected",
            eligibility: {
              executionSide: "terminal",
              availability: { available: false, reason: "worker-terminal-disconnected" },
            },
          },
        ],
      });
      await expect(assignWorker(orchestration)).rejects.toThrow("worker-terminal-disconnected");
      connected = true;
      await assignWorker(orchestration);
      expect(await orchestration.overview(LEAD)).toMatchObject({
        workers: [
          {
            eligibility: {
              executionSide: "terminal",
              availability: { available: true },
              actions: { send: true, stop: false, restart: false },
            },
          },
        ],
      });
      connected = false;
      expect(
        parse(
          await orchestration.call(LEAD, "worker_send", {
            worker: "worker-1",
            text: "Review the terminal fixture",
          }),
        ),
      ).toMatchObject({ accepted: false, reason: "worker-terminal-disconnected" });
      expect(calls).toEqual([]);
    });

    it("bounds both the candidate list and assignment when a reachability check stalls", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      cleanups.push(() => vi.useRealTimers());
      const stalled = "claude-other";
      const probe = Promise.withResolvers<boolean>();
      const { lanes } = host({ managed: () => probe.promise });
      const orchestration = service(lanes);
      const listed = vi.fn();
      const assigned = vi.fn();
      const refused = vi.fn();
      const options = orchestration.assignmentOptions(LEAD, "w1", [stalled, WORKER]).then(listed);
      const assignment = orchestration
        .assignWorkers({ ...OWNER, workers: [WORKER, stalled] })
        .then(assigned, refused);

      await vi.advanceTimersByTimeAsync(2_999);
      expect(listed).not.toHaveBeenCalled();
      expect(assigned).not.toHaveBeenCalled();
      expect(refused).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(listed).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          capable: true,
          remaining: 10,
          candidates: [
            expect.objectContaining({ sessionId: stalled, reason: "worker-probe-failed" }),
            expect.objectContaining({ sessionId: WORKER, reason: null }),
          ],
        }),
      );
      expect(refused).toHaveBeenCalledExactlyOnceWith(new Error("worker-probe-failed"));
      expect(orchestration.registry.list()).toEqual([]);

      probe.resolve(true);
      await Promise.all([options, assignment]);
      expect(assigned).not.toHaveBeenCalled();
      expect(orchestration.registry.list()).toEqual([]);
    });

    it("creates the lead and all selected relationships without starting a session or sending", async () => {
      const sessions: Record<string, NonNullable<ReturnType<LaneHost["session"]>>> = {
        [LEAD]: { agent: "claude-code", workspaceId: "w1", title: null },
        "existing-api": { agent: "codex", workspaceId: "w1", title: "API" },
        "existing-tests": { agent: "deepseek-harness", workspaceId: "w2", title: "Tests" },
        elsewhere: { agent: "codex", workspaceId: "w9", title: null },
        "claude-other": { agent: "claude-code", workspaceId: "w1", title: null },
      };
      const { lanes, calls } = host({
        session: (id) => sessions[id] ?? null,
        managed: async (id) => id === "existing-tests",
      });
      const orchestration = service(lanes);
      expect(
        await orchestration.assignWorkers({
          ...OWNER,
          workers: ["existing-api", "existing-tests"],
        }),
      ).toEqual({ designated: true });
      expect(orchestration.status(LEAD)).toMatchObject({
        scope: {
          workspaceIds: ["w1", "w2"],
          policies: [],
          approvals: [],
          answers: false,
        },
        lanes: [
          { sessionId: "existing-api", agent: "codex", name: "worker-1", policyId: null },
          {
            sessionId: "existing-tests",
            agent: "deepseek-harness",
            name: "worker-2",
            policyId: null,
          },
        ],
      });
      expect(
        await orchestration.assignmentOptions(LEAD, "w1", [
          "existing-api",
          "elsewhere",
          "claude-other",
        ]),
      ).toMatchObject({
        capable: true,
        remaining: 8,
        candidates: [
          { sessionId: "existing-api", reason: "session-is-a-worker", assigned: true },
          { sessionId: "elsewhere", reason: null },
          { sessionId: "claude-other", reason: "worker-not-controllable" },
        ],
      });
      await expect(
        orchestration.assignWorkers({ ...OWNER, workers: ["elsewhere"] }),
      ).resolves.toEqual({ designated: false });
      expect(orchestration.status(LEAD)?.scope.workspaceIds).toEqual(["w1", "w2", "w9"]);
      orchestration.removeWorker(LEAD, "elsewhere");
      expect(orchestration.status(LEAD)?.scope.workspaceIds).toEqual(["w1", "w2"]);
      orchestration.pause(LEAD);
      expect(await orchestration.assignmentOptions(LEAD, "w1", [])).toMatchObject({
        remaining: 0,
        reason: "delegation-paused",
      });
      expect(calls).toEqual([]);
    });

    it("allows ten workers in one assignment and refuses an eleventh without partial changes", async () => {
      const sessions = Array.from({ length: 11 }, (_, index) => `existing-${index + 1}`);
      const { lanes, calls } = host({
        session: (id) =>
          sessions.includes(id) ? { agent: "codex", workspaceId: "w1", title: null } : null,
      });
      const orchestration = service(lanes);
      expect(await orchestration.assignmentOptions(LEAD, "w1", [])).toMatchObject({
        capable: true,
        remaining: 10,
      });
      await expect(orchestration.assignWorkers({ ...OWNER, workers: sessions })).rejects.toThrow(
        "worker-limit-reached",
      );
      expect(orchestration.status(LEAD)).toBeNull();

      const workers = sessions.slice(0, 10);
      await expect(orchestration.assignWorkers({ ...OWNER, workers })).resolves.toEqual({
        designated: true,
      });
      const lead = orchestration.status(LEAD);
      expect(lead?.lanes.map((lane) => lane.sessionId)).toEqual(workers);
      expect(await orchestration.assignmentOptions(LEAD, "w1", [])).toMatchObject({
        remaining: 0,
      });
      await expect(
        orchestration.assignWorkers({ ...OWNER, workers: sessions.slice(10) }),
      ).rejects.toThrow("worker-limit-reached");
      expect(orchestration.status(LEAD)).toEqual(lead);
      expect(calls).toEqual([]);
    });

    it("rolls back the entire first assignment if a selected session already leads", async () => {
      const orchestration = service(host().lanes, directory(), "boot-1", undefined, () => true);
      orchestration.designate({
        sessionId: "codex-elsewhere",
        deviceId: DEVICE,
        workspaceId: "w9",
      });
      expect(
        await orchestration.assignmentOptions(LEAD, "w1", ["codex-existing", "codex-elsewhere"]),
      ).toMatchObject({
        candidates: [
          { sessionId: "codex-existing", reason: null },
          { sessionId: "codex-elsewhere", reason: "session-is-a-project-agent" },
        ],
      });
      await expect(
        orchestration.assignWorkers({
          ...OWNER,
          workers: ["codex-existing", "codex-elsewhere"],
        }),
      ).rejects.toThrow("session-is-a-project-agent");
      expect(orchestration.status(LEAD)).toBeNull();
      expect(orchestration.registry.leadOfLane("codex-existing")).toBeNull();
    });

    it("keeps a worker exclusive when two project agents receive concurrent assignments", async () => {
      const available = Promise.withResolvers<boolean>();
      const { lanes } = host({
        session: (id) =>
          id === "dsh-one" ? { agent: "deepseek-harness", workspaceId: "w1", title: null } : null,
        managed: () => available.promise,
      });
      const orchestration = service(lanes, directory(), "boot-1", undefined, () => true);
      orchestration.designate({
        sessionId: "other-lead",
        deviceId: DEVICE,
        workspaceId: "w1",
      });
      const assignments = Promise.allSettled([
        orchestration.assignWorkers({ ...OWNER, sessionId: "other-lead", workers: ["dsh-one"] }),
        orchestration.assignWorkers({ ...OWNER, workers: ["dsh-one"] }),
      ]);
      available.resolve(true);
      expect(await assignments).toEqual([
        { status: "fulfilled", value: { designated: false } },
        { status: "rejected", reason: new Error("session-is-a-worker") },
      ]);
      expect(orchestration.status(LEAD)).toBeNull();
      expect(orchestration.registry.leadOfLane("dsh-one")?.lead.sessionId).toBe("other-lead");
      expect(() =>
        orchestration.designate({ sessionId: "dsh-one", deviceId: DEVICE, workspaceId: "w1" }),
      ).toThrow("session-is-a-worker");
    });
  });

  it("uses assigned DeepSeek Harness workers, whose approvals stay the user's", async () => {
    const delivered: string[] = [];
    const { lanes, calls, lives } = host({
      session: (sessionId) =>
        sessionId.startsWith("dsh-")
          ? { agent: "deepseek-harness", workspaceId: "w1", title: null }
          : null,
      managed: async (sessionId) => sessionId !== "dsh-gone",
    });
    const orchestration = service(lanes, directory(), "boot-1", (_lead, _device, text) => {
      delivered.push(text);
      return false;
    });
    orchestration.designate({
      ...OWNER,
      scope: { approvals: ["command", "file-change"], answers: true },
    });
    await assignWorker(orchestration, "dsh-existing");
    await expect(assignWorker(orchestration, "dsh-gone")).rejects.toThrow(
      "worker-not-controllable",
    );
    expect(calls).toEqual([]);

    await orchestration.laneTurnEnded("dsh-existing", "dsh-turn-1", "completed", 5_000);
    expect(delivered.at(-1)).toMatch(
      /^\[AgentKib report\] Worker "worker-1" \(DeepSeek Harness\) · turn ended: completed after 5s\n/,
    );
    // A DSH approval is the user's, whatever the lead may decide for Codex workers.
    lives.set("dsh-existing", {
      sessionId: "dsh-existing",
      status: "awaiting-approval",
      revision: 7,
      runtimeBootId: "boot",
      turnId: "dsh-turn-2",
      approvals: [
        {
          requestId: "approval-1",
          turnId: "dsh-turn-2",
          method: "dsh/approval",
          command: { tool: "bash", arguments: { command: "rm -rf build" } },
          availableDecisions: ["accept", "decline"],
          supported: true,
        },
      ],
      questions: [],
    });
    await orchestration.laneWaiting("dsh-existing", "dsh-turn-2", "awaiting-approval");
    // Its own paragraph under the line that says which Worker waits.
    expect(delivered.at(-1)).toMatch(/approval\n\nThe user decides in AgentKib/);
    expect(
      parse(
        await orchestration.call(LEAD, "worker_approve", {
          worker: "worker-1",
          approval: "approval-1",
          decision: "accept",
        }),
      ),
    ).toMatchObject({ accepted: false, reason: "approval-not-delegated" });
    // A DSH card of fixed choices is a tool approval too; one that takes text is a question.
    const card = (id: string, allowCustom: boolean) => ({
      requestId: id,
      turnId: "dsh-turn-3",
      method: "dsh/question",
      supported: true,
      questions: [
        { id: "q1", question: "Which?", options: [{ label: "A" }, { label: "B" }], allowCustom },
      ],
    });
    lives.set("dsh-existing", {
      sessionId: "dsh-existing",
      status: "waiting-input",
      revision: 8,
      runtimeBootId: "boot",
      turnId: "dsh-turn-3",
      approvals: [],
      questions: [card("approval-card", false), card("question-1", true)],
    });
    const read = parse(await orchestration.call(LEAD, "worker_read", { worker: "worker-1" }));
    expect(
      read.waitingForUser.map((item: { id: string; youMayDecide: boolean }) => [
        item.id,
        item.youMayDecide,
      ]),
    ).toEqual([
      ["approval-card", false],
      ["question-1", true],
    ]);
    expect(
      parse(
        await orchestration.call(LEAD, "worker_answer", {
          worker: "worker-1",
          question: "approval-card",
          answers: { q1: "A" },
        }),
      ),
    ).toMatchObject({ accepted: false, reason: "question-not-delegated" });
    expect(
      parse(
        await orchestration.call(LEAD, "worker_answer", {
          worker: "worker-1",
          question: "question-1",
          answers: { q1: "B" },
        }),
      ),
    ).toMatchObject({ accepted: true });
    expect(calls.at(-1)).toMatchObject({
      operation: "answer",
      sessionId: "dsh-existing",
      questionId: "question-1",
      turnId: "dsh-turn-3",
      expectedRevision: 8,
      answers: { q1: ["B"] },
    });
    expect(
      parse(await orchestration.call(LEAD, "worker_list", {})).workers.map(
        (worker: { worker: string; agent: string }) => [worker.worker, worker.agent],
      ),
    ).toEqual([["worker-1", "deepseek-harness"]]);
  });

  it("sends a brief to an idle lane, queues or steers while it runs, and stops its turn", async () => {
    const { lanes, calls, lives } = host();
    const orchestration = service(lanes);
    orchestration.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1" });
    const session = await assignWorker(orchestration);
    const sent = parse(
      await orchestration.call(LEAD, "worker_send", {
        worker: "worker-1",
        text: "Read docs/brief.md",
        title: "Brief 1",
      }),
    );
    expect(sent).toMatchObject({ accepted: true, operation: "send" });
    expect(calls.at(-1)).toMatchObject({
      kind: "control",
      operation: "send",
      sessionId: session,
      requestId: sent.requestId,
      deviceId: DEVICE,
      runtimeBootId: "boot",
      expectedRevision: 3,
      experimentalEnabled: true,
      text: "Read docs/brief.md",
    });
    lives.set(session, {
      status: "running",
      revision: 5,
      runtimeBootId: "boot",
      turnId: "turn-1",
      sendEnabled: false,
      stopEnabled: true,
      approvals: [{}],
      questions: [],
    });
    expect(
      parse(
        await orchestration.call(LEAD, "worker_send", {
          worker: "worker-1",
          text: "Also check tests",
        }),
      ),
    ).toMatchObject({ operation: "queue-add" });
    expect(
      parse(
        await orchestration.call(LEAD, "worker_send", {
          worker: "worker-1",
          text: "Now",
          mode: "steer",
        }),
      ),
    ).toMatchObject({ operation: "steer" });
    expect(calls.at(-1)).toMatchObject({
      operation: "steer",
      turnId: "turn-1",
      expectedRevision: 5,
    });
    expect(
      parse(await orchestration.call(LEAD, "worker_stop", { worker: "worker-1" })),
    ).toMatchObject({
      accepted: true,
    });
    expect(calls.at(-1)).toMatchObject({ operation: "stop", turnId: "turn-1" });
    const read = parse(
      await orchestration.call(LEAD, "worker_read", { worker: "worker-1", limit: 2 }),
    );
    expect(read).toMatchObject({
      worker: "worker-1",
      status: "running",
      title: "Brief 1",
      waitingForUser: [{ kind: "approval", approval: "other", youMayDecide: false }],
    });
    expect(read.replies.map((reply: { text: string }) => reply.text.slice(0, 12))).toEqual([
      "first answer",
      "xxxxxxxxxxxx",
    ]);
    expect(read.replies[1].text).toContain("[truncated: 5000 characters]");
    const listed = parse(await orchestration.call(LEAD, "worker_list", {}));
    expect(listed).toMatchObject({
      paused: false,
      workers: [{ worker: "worker-1", status: "running", title: "Brief 1" }],
    });
    for (const key of ["workspaces", "models", "policies", "deepseekHarness"]) {
      expect(listed).not.toHaveProperty(key);
    }
    expect(
      orchestration.status(LEAD)!.records.map((record) => `${record.kind}:${record.outcome}`),
    ).toEqual([
      "open:accepted",
      "send:accepted",
      "send:accepted",
      "send:accepted",
      "stop:accepted",
    ]);
  });

  it("does not dispatch a send after the person removes its worker during the live read", async () => {
    const reading = Promise.withResolvers<void>();
    const live = Promise.withResolvers<Record<string, unknown>>();
    const { lanes, calls } = host({
      live: () => {
        reading.resolve();
        return live.promise;
      },
    });
    const orchestration = service(lanes);
    const session = await assignWorker(orchestration);
    const pending = orchestration.call(LEAD, "worker_send", { worker: "worker-1", text: "Go" });
    await reading.promise;
    orchestration.removeWorker(LEAD, session);
    live.resolve({ sessionId: session, status: "idle", sendEnabled: true });
    expect(parse(await pending)).toEqual({ accepted: false, reason: "worker-not-assigned" });
    expect(calls).toEqual([]);
  });

  it("reports a refused or unknown send without retrying it", async () => {
    let answer: unknown = {
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "codex-owner-busy",
    };
    const { lanes, calls } = host({
      control: async (value) => {
        calls.push({ kind: "control", ...value });
        return answer;
      },
    });
    const orchestration = service(lanes);
    orchestration.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1" });
    await assignWorker(orchestration);
    const refused = await orchestration.call(LEAD, "worker_send", {
      worker: "worker-1",
      text: "go",
    });
    expect(refused.isError).toBe(true);
    expect(parse(refused)).toMatchObject({ accepted: false, reason: "codex-owner-busy" });
    answer = { accepted: false, controlOutcome: "unknown" };
    expect(
      parse(await orchestration.call(LEAD, "worker_send", { worker: "worker-1", text: "go" })),
    ).toMatchObject({
      accepted: false,
      outcome: "unknown",
    });
    expect(calls.filter((call) => call.kind === "control")).toHaveLength(2);
  });

  it("stops acting while paused, also when the device that set it up loses its authorization", async () => {
    const { lanes, calls } = host();
    const orchestration = service(lanes);
    await assignWorker(orchestration);
    orchestration.resume(LEAD, "phone-1", ["w1"]);
    orchestration.invalidateDevice("phone-1");
    expect(orchestration.status(LEAD)).toMatchObject({
      paused: true,
      reason: "authorization-changed",
    });
    for (const [name, input] of [
      ["worker_send", { worker: "worker-1", text: "go" }],
      ["worker_stop", { worker: "worker-1" }],
    ] as const)
      expect(parse(await orchestration.call(LEAD, name, input))).toMatchObject({
        accepted: false,
        reason: "delegation-paused",
      });
    // Keep the reason visible so the lead can tell the user what happened.
    expect(parse(await orchestration.call(LEAD, "worker_list", {}))).toEqual({
      paused: true,
      reason: "authorization-changed",
      workers: [],
    });
    const before = calls.length;
    expect(orchestration.resume(LEAD, DEVICE)).toMatchObject({
      paused: false,
      deviceId: DEVICE,
      autoTurns: 0,
    });
    expect(
      parse(await orchestration.call(LEAD, "worker_send", { worker: "worker-1", text: "go" })),
    ).toMatchObject({ accepted: true });
    expect(calls.slice(before).at(-1)).toMatchObject({ deviceId: DEVICE });
  });

  it("stops reading worker data and host resources when authorization changes", async () => {
    const hostResources = vi.fn();
    const sessionSettings = vi.fn();
    const { lanes } = host({ hostResources, sessionSettings });
    const orchestration = service(lanes);
    await assignWorker(orchestration);
    orchestration.registry.update(LEAD, (lead) => {
      lead.lanes[0]!.lastReport = { at: new Date().toISOString(), preview: "fixture report" };
    });
    const live = vi.spyOn(lanes, "live");
    const events = vi.spyOn(lanes, "events");

    orchestration.invalidateDevice(DEVICE);
    for (const name of ["worker_read", "worker_settings"]) {
      const result = await orchestration.call(LEAD, name, { worker: "worker-1" });
      expect(parse(result)).toEqual({
        accepted: false,
        reason: "delegation-paused",
        why: "authorization-changed",
      });
    }
    expect(parse(await orchestration.call(LEAD, "worker_list", {}))).toEqual({
      paused: true,
      reason: "authorization-changed",
      workers: [],
    });
    expect(live).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(sessionSettings).not.toHaveBeenCalled();
    expect(hostResources).not.toHaveBeenCalled();
  });

  it.each([
    ["worker_list", "revoked"],
    ["worker_read", "revoked"],
    ["worker_settings", "revoked"],
    ["worker_read", "replaced"],
  ])("rechecks %s after an in-flight read with authorization %s", async (name, change) => {
    const reading = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const pauseRead = async <T>(result: T) => {
      reading.resolve();
      await finish.promise;
      return result;
    };
    const { lanes } = host();
    const live = lanes.live;
    const events = lanes.events;
    if (name === "worker_list") lanes.live = async (id) => pauseRead(await live(id));
    if (name === "worker_read") lanes.events = async (...args) => pauseRead(await events(...args));
    if (name === "worker_settings") lanes.sessionSettings = () => pauseRead({ available: false });
    const orchestration = service(lanes);
    await assignWorker(orchestration);

    const pending = orchestration.call(LEAD, name, { worker: "worker-1" });
    await Promise.race([
      reading.promise,
      pending.then(() => {
        throw new Error("worker read did not start");
      }),
    ]);
    try {
      if (change === "revoked") orchestration.invalidateDevice(DEVICE);
      else orchestration.resume(LEAD, "another-device", ["w1"]);
    } finally {
      finish.resolve();
    }
    expect(parse(await pending)).toEqual(
      name === "worker_list"
        ? { paused: true, reason: "authorization-changed", workers: [] }
        : {
            accepted: false,
            reason: "delegation-paused",
            ...(change === "revoked" ? { why: "authorization-changed" } : {}),
          },
    );
  });

  describe("workers the person manages", () => {
    it("only lets the person remove an assigned worker and free its place", async () => {
      const orchestration = service(host().lanes);
      const session = await assignWorker(orchestration);
      const before = await orchestration.assignmentOptions(LEAD, "w1", []);
      const refused = await orchestration.call(LEAD, "worker_close", { worker: "worker-1" });
      expect(refused.isError).toBe(true);
      expect(parse(refused)).toEqual({ accepted: false, reason: "tool-not-offered" });
      expect(orchestration.roles().get(session)).toMatchObject({ role: "worker" });

      orchestration.removeWorker(LEAD, session);
      expect(orchestration.roles().get(session)).toBeUndefined();
      expect((await orchestration.overview(LEAD))!.workers).toEqual([]);
      expect((await orchestration.assignmentOptions(LEAD, "w1", [])).remaining).toBe(
        before.remaining + 1,
      );
      expect(() => orchestration.removeWorker(LEAD, session)).toThrow("worker-not-assigned");
      expect(orchestration.status(LEAD)!.records.at(-1)).toMatchObject({
        kind: "close",
        outcome: "removed",
      });
    });

    it("lets the person stop a worker's turn in their own name, also while delegation is paused", async () => {
      const { lanes, calls, lives } = host();
      const orchestration = service(lanes);
      const session = await assignWorker(orchestration);
      orchestration.resume(LEAD, "phone-1", ["w1"]);
      expect(await orchestration.stopWorker(LEAD, session, DEVICE)).toEqual({
        accepted: false,
        reason: "worker-not-running",
      });
      expect((await orchestration.overview(LEAD))!.workers).toEqual([
        expect.objectContaining({ stopEnabled: false }),
      ]);
      lives.set(session, {
        status: "running",
        revision: 5,
        runtimeBootId: "boot",
        turnId: "turn-1",
        sendEnabled: false,
        stopEnabled: true,
        approvals: [],
        questions: [],
      });
      expect((await orchestration.overview(LEAD))!.workers).toEqual([
        expect.objectContaining({ stopEnabled: true }),
      ]);
      orchestration.pause(LEAD);
      // A stale lead tool remains rejected while paused; the person can still stop the worker.
      expect(
        parse(await orchestration.call(LEAD, "worker_close", { worker: "worker-1" })),
      ).toMatchObject({ accepted: false, reason: "tool-not-offered" });
      expect(await orchestration.stopWorker(LEAD, session, DEVICE)).toMatchObject({
        accepted: true,
      });
      expect(calls.at(-1)).toMatchObject({
        kind: "control",
        operation: "stop",
        sessionId: session,
        deviceId: DEVICE,
        turnId: "turn-1",
        expectedRevision: 5,
      });
      // The lead hears of it as of any stop the person makes; held while delegation is paused.
      expect(orchestration.status(LEAD)!.pendingReports.join("\n")).toContain(
        "the user stopped its turn directly",
      );
      await expect(orchestration.stopWorker(LEAD, "elsewhere", DEVICE)).rejects.toThrow(
        "worker-not-assigned",
      );
    });

    it("changes the scope in the name of the device that changes it; the next CLI gets changed tools", async () => {
      const { lanes, calls } = host();
      const orchestration = service(lanes);
      orchestration.designate({
        sessionId: LEAD,
        deviceId: "phone-1",
        workspaceId: "w1",
      });
      await assignWorker(orchestration, "codex-branch");
      expect(orchestration.status(LEAD)).toMatchObject({ deviceId: DEVICE });
      expect(orchestration.resume(LEAD, "phone-1", ["w1", "w2"])).toMatchObject({
        deviceId: "phone-1",
      });
      type Config = { mcpServers: Record<string, { url: string }> };
      const before = (await orchestration.leadTools(LEAD)) as Config;
      // A setting still in use is validated before the operation can transfer authority.
      await expect(
        orchestration.update({ sessionId: LEAD, deviceId: DEVICE, scope: { maxAutoTurns: 101 } }),
      ).rejects.toThrow("invalid-lead-turn-limit");
      await expect(
        orchestration.update({ sessionId: "elsewhere", deviceId: DEVICE, scope: {} }),
      ).rejects.toThrow("lead-unavailable");
      expect(orchestration.status(LEAD)).toMatchObject({ deviceId: "phone-1" });
      expect(
        await orchestration.update({
          sessionId: LEAD,
          deviceId: DEVICE,
          scope: { maxAutoTurns: 10 },
        }),
      ).toBe(false);
      expect(await orchestration.leadTools(LEAD)).toEqual(before);
      expect(orchestration.status(LEAD)).toMatchObject({
        deviceId: DEVICE,
        scope: { workspaceIds: ["w1", "w2"], maxLanes: 10, maxAutoTurns: 10, approvals: [] },
      });
      // Deciding approvals changes its tools. The CLI running now keeps its endpoint until the
      // next one asks for its tools.
      const running = new Client({ name: "running", version: "0" });
      await running.connect(
        new StreamableHTTPClientTransport(new URL(before.mcpServers.agentkib_workers!.url)),
      );
      cleanups.push(() => running.close());
      expect(
        await orchestration.update({
          sessionId: LEAD,
          deviceId: DEVICE,
          scope: {
            approvals: ["command"],
            workspaceIds: ["w1"],
            policies: ["workspace-write-auto-review"],
            maxLanes: 1,
          },
        }),
      ).toBe(true);
      const listed = await running.callTool({ name: "worker_list", arguments: {} });
      expect(JSON.parse(listed.content[0].text)).toMatchObject({ paused: false });
      const next = (await orchestration.leadTools(LEAD)) as Config;
      expect(next.mcpServers.agentkib_workers!.url).not.toBe(
        before.mcpServers.agentkib_workers!.url,
      );
      const client = new Client({ name: "next", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(next.mcpServers.agentkib_workers!.url)),
      );
      cleanups.push(() => client.close());
      expect(client.getInstructions()).toBe(leadInstructions({ approvals: ["command"] }));
      const names = (await client.listTools()).tools.map((tool: { name: string }) => tool.name);
      expect(names).toContain("worker_approve");
      expect((await orchestration.leadEndpoint(LEAD))?.toolNames).toEqual(names);
      expect(orchestration.status(LEAD)?.scope).toMatchObject({
        workspaceIds: ["w1", "w2"],
        policies: [],
        maxLanes: 10,
        maxAutoTurns: 10,
        approvals: ["command"],
      });
      // The legacy workspace request cannot remove authority for an assigned worker.
      expect(parse(await orchestration.call(LEAD, "worker_list", {})).workers).toEqual([
        expect.objectContaining({ worker: "worker-1", session: "codex-branch" }),
      ]);
      expect(
        parse(await orchestration.call(LEAD, "worker_send", { worker: "worker-1", text: "go" })),
      ).toMatchObject({ accepted: true });
      expect(calls.at(-1)).toMatchObject({ sessionId: "codex-branch", deviceId: DEVICE });
      expect(orchestration.status(LEAD)!.records.map((record) => record.kind)).toContain("update");
    });

    it("lets a deleted session's worker go, and ends a lead whose session is deleted", async () => {
      const { lanes } = host();
      const orchestration = service(lanes);
      orchestration.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1" });
      const session = await assignWorker(orchestration);
      await orchestration.sessionGone("unrelated");
      await orchestration.sessionGone(session);
      expect(orchestration.status(LEAD)!.lanes).toEqual([]);
      expect(orchestration.status(LEAD)!.records.at(-1)).toMatchObject({
        kind: "close",
        outcome: "session-deleted",
      });
      await orchestration.sessionGone(LEAD);
      expect(orchestration.status(LEAD)).toBeNull();
    });
  });

  it("serves the tools at a private endpoint to the lead only", async () => {
    const { lanes } = host();
    const orchestration = service(lanes);
    expect(await orchestration.leadTools(LEAD)).toBeNull();
    orchestration.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1" });
    const config = (await orchestration.leadTools(LEAD)) as {
      mcpServers: Record<string, { url: string }>;
    };
    expect(await orchestration.leadTools(LEAD)).toEqual(config);
    const url = config.mcpServers.agentkib_workers!.url;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/lead\/[0-9a-f]{64}$/);
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    cleanups.push(() => client.close());
    expect(client.getInstructions()).toBe(LEAD_INSTRUCTIONS);
    expect(LEAD_INSTRUCTIONS.length).toBeLessThan(2000);
    const tools = await client.listTools();
    const names = tools.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("worker_settings");
    const settingsTool = tools.tools.find(
      (tool: { name: string }) => tool.name === "worker_settings",
    );
    expect(settingsTool?.inputSchema.properties.role).toMatchObject({
      type: ["object", "null"],
      required: ["label", "description"],
    });
    expect(names.filter((name: string) => name !== "worker_settings")).toEqual([
      "worker_list",
      "worker_send",
      "worker_read",
      "worker_stop",
      "worker_restart",
    ]);
    expect(await orchestration.leadEndpoint(LEAD)).toMatchObject({
      url,
      serverName: "agentkib_workers",
      toolNames: names,
    });
    for (const [name, args] of [
      ["worker_open", { name: "api", workspace: "w1" }],
      ["worker_open", { name: "api", session: WORKER }],
      ["worker_close", { worker: "worker-1" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(parse(result.content[0])).toEqual({ accepted: false, reason: "tool-not-offered" });
    }
    expect(orchestration.status(LEAD)!.lanes).toEqual([]);
    const listed = await client.callTool({ name: "worker_list", arguments: {} });
    expect(JSON.parse(listed.content[0].text)).toMatchObject({ paused: false, workers: [] });
    // Anything but the capability path is refused.
    expect((await fetch(new URL("/lead/other", url), { method: "POST" })).status).toBe(404);
    expect(
      (await fetch(url, { method: "POST", headers: { origin: "http://example.com" }, body: "{}" }))
        .status,
    ).toBe(404);
    await orchestration.release(LEAD);
    expect(await orchestration.leadTools(LEAD)).toBeNull();
    await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow();
  });

  // The host ends a lead's CLI with SIGKILL (idle, stop, cleanup), so its session stays open.
  it("lets a new CLI in after ended ones filled the endpoint; the least recent gives way", async () => {
    const { lanes } = host();
    const orchestration = service(lanes);
    orchestration.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1" });
    const config = (await orchestration.leadTools(LEAD)) as {
      mcpServers: Record<string, { url: string }>;
    };
    const url = new URL(config.mcpServers.agentkib_workers!.url);
    const connect = async () => {
      const client = new Client({ name: "probe", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(url));
      cleanups.push(() => client.close());
      return client;
    };
    const ended = [];
    for (let index = 0; index < 4; index++) ended.push(await connect());
    // The second one is still in use; the first has been quiet longest.
    await ended[1].listTools();
    for (let index = 0; index < 2; index++) {
      const next = await connect();
      expect((await next.listTools()).tools).toHaveLength(6);
    }
    await expect(ended[0].listTools()).rejects.toThrow();
    await expect(ended[2].listTools()).rejects.toThrow();
    expect((await ended[1].listTools()).tools).toHaveLength(6);
  });

  describe("deciding for workers", () => {
    const approval = (requestId: unknown, extra: Record<string, unknown> = {}) => ({
      requestId,
      turnId: "t5",
      method: "item/commandExecution/requestApproval",
      command: "npm install --no-audit",
      cwd: "/work/app",
      changes: null,
      availableDecisions: ["accept", "decline", "cancel"],
      supported: true,
      ...extra,
    });
    const question = {
      requestId: "q1",
      turnId: "t5",
      supported: true,
      questions: [
        { id: "target", question: "Which target?", options: [{ label: "web" }, { label: "ios" }] },
      ],
    };
    async function deciding(scope: Record<string, unknown>) {
      const delivered: string[] = [];
      const { lanes, calls, lives } = host();
      const orchestration = service(lanes, directory(), "boot-1", (_lead, _device, text) => {
        delivered.push(text);
        return false;
      });
      orchestration.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1", scope });
      const session = await assignWorker(orchestration);
      const waiting = (approvals: unknown[], questions: unknown[] = []) =>
        lives.set(session, {
          sessionId: session,
          status: questions.length ? "waiting-input" : "awaiting-approval",
          revision: 9,
          runtimeBootId: "boot",
          turnId: "t5",
          sendEnabled: false,
          stopEnabled: true,
          approvals,
          questions,
        });
      return { orchestration, delivered, calls, session, waiting };
    }

    it("lets a lead decide only the plain approvals and the answers the user allowed", async () => {
      const { orchestration, delivered, calls, session, waiting } = await deciding({
        approvals: ["command"],
        answers: true,
      });
      waiting([
        approval(7),
        approval("files", { method: "item/fileChange/requestApproval", command: null }),
        // Asks for network access: only the user decides.
        approval("net", { availableDecisions: [], requiresExtendedApproval: true }),
      ]);
      await orchestration.laneWaiting(session, "t5", "awaiting-approval");
      expect(delivered[0]).toMatch(/approval\n\nYou may decide this yourself \(worker_approve\)/);
      // The approval itself, fenced so that the conversation shows it as it is.
      expect(delivered[0]).toMatch(/counts:\n\n```json\n\[\{.*"id":"7".*\}\]\n```$/);
      expect(delivered[0]).toContain("npm install --no-audit");
      expect(delivered[0]).not.toContain('"id":"files"');
      const read = parse(await orchestration.call(LEAD, "worker_read", { worker: "worker-1" }));
      expect(
        read.waitingForUser.map((item: Record<string, unknown>) => [item.id, item.youMayDecide]),
      ).toEqual([
        ["7", true],
        ["files", false],
        ["net", false],
      ]);
      for (const [id, reason] of [
        ["files", "approval-not-delegated"],
        ["net", "approval-not-delegated"],
        ["gone", "approval-not-waiting"],
      ])
        expect(
          parse(
            await orchestration.call(LEAD, "worker_approve", {
              worker: "worker-1",
              approval: id,
              decision: "accept",
            }),
          ),
        ).toMatchObject({ accepted: false, reason });
      expect(
        parse(
          await orchestration.call(LEAD, "worker_approve", {
            worker: "worker-1",
            approval: "7",
            decision: "accept",
          }),
        ),
      ).toMatchObject({ accepted: true });
      expect(calls.filter((call) => call.kind === "control").at(-1)).toMatchObject({
        operation: "approve",
        sessionId: session,
        deviceId: DEVICE,
        runtimeBootId: "boot",
        expectedRevision: 9,
        turnId: "t5",
        approvalId: 7,
        decision: "accept",
      });

      waiting([], [question]);
      await orchestration.laneWaiting(session, "t5", "waiting-input");
      expect(delivered[1]).toContain("worker_answer");
      expect(delivered[1]).toContain("Which target?");
      expect(
        parse(
          await orchestration.call(LEAD, "worker_answer", {
            worker: "worker-1",
            question: "q1",
            answers: { target: "web" },
          }),
        ),
      ).toMatchObject({ accepted: true });
      expect(calls.filter((call) => call.kind === "control").at(-1)).toMatchObject({
        operation: "answer",
        questionId: "q1",
        turnId: "t5",
        answers: { target: ["web"] },
      });
      expect(
        orchestration
          .status(LEAD)!
          .records.filter((record) => ["approve", "answer"].includes(record.kind))
          .map((record) => `${record.kind}:${record.outcome}`),
      ).toEqual(["approve:accept", "answer:answered"]);
      // Paused, it decides nothing.
      orchestration.pause(LEAD);
      expect(
        parse(
          await orchestration.call(LEAD, "worker_answer", {
            worker: "worker-1",
            question: "q1",
            answers: { target: "web" },
          }),
        ),
      ).toMatchObject({ accepted: false, reason: "delegation-paused" });
    });

    it("offers no deciding tools, and says the user decides, when nothing is allowed", async () => {
      const { orchestration, delivered, session, waiting } = await deciding({});
      expect(orchestration.tools().map((tool) => tool.name)).not.toContain("worker_approve");
      expect(
        orchestration
          .tools({ approvals: ["file-change"], answers: true })
          .map((tool) => tool.name)
          .slice(-2),
      ).toEqual(["worker_approve", "worker_answer"]);
      expect(LEAD_INSTRUCTIONS).toContain("You cannot answer a worker's approvals");
      const allowed = leadInstructions({ approvals: ["file-change", "command"], answers: true });
      expect(allowed).toContain("worker_approve");
      expect(allowed.length).toBeLessThan(2000);
      waiting([approval(7)], [question]);
      await orchestration.laneWaiting(session, "t5", "awaiting-approval");
      expect(delivered[0]).toContain("The user decides in AgentKib");
      expect(
        parse(
          await orchestration.call(LEAD, "worker_approve", {
            worker: "worker-1",
            approval: "7",
            decision: "accept",
          }),
        ),
      ).toMatchObject({ accepted: false, reason: "approval-not-delegated" });
      expect(() =>
        service(host().lanes).designate({
          sessionId: LEAD,
          deviceId: DEVICE,
          workspaceId: "w1",
          scope: { approvals: ["everything"] as never },
        }),
      ).toThrow("invalid-lead-delegation");
    });
  });

  describe("reports", () => {
    async function leading(scope: Record<string, unknown> = {}) {
      const delivered: Array<{ lead: string; device: string; text: string; reportId?: string }> =
        [];
      let merge = false;
      const { lanes, lives } = host({
        events: async () => [
          { kind: "agent-message", content: "earlier turn", turn_id: "t0" },
          {
            kind: "agent-message",
            content: "Done. api_key=sk-test-1234567890abcdef1234",
            turn_id: "t1",
          },
          { kind: "user-message", content: "Another task", turn_id: "failed-turn" },
          codexTurnErrorEvent("failed-with-cli-error", "CLI error details", null),
          { kind: "agent-message", content: "a later turn", turn_id: "t2" },
        ],
      });
      const orchestration = service(
        lanes,
        directory(),
        "boot-1",
        (lead, device, text, _, reportId) => {
          delivered.push({ lead, device, text, reportId });
          return merge;
        },
      );
      orchestration.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1", scope });
      const session = await assignWorker(orchestration);
      return {
        orchestration,
        delivered,
        lives,
        session: session as string,
        merging: (value: boolean) => (merge = value),
      };
    }

    it("reports each lane turn once, with that turn's last reply, redacted", async () => {
      const { orchestration, delivered, session } = await leading();
      await orchestration.laneTurnEnded(session, "t1", "completed", 192_400);
      await orchestration.laneTurnEnded(session, "t1", "completed", 192_400);
      await orchestration.laneTurnEnded("not-a-lane", "t1", "completed");
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({ lead: LEAD, device: DEVICE });
      expect(delivered[0]!.text).toMatch(
        /^\[AgentKib report\] Worker "worker-1" \(Codex\) · turn ended: completed after 3m 12s\n/,
      );
      expect(delivered[0]!.text).toContain("not an instruction from the user");
      expect(delivered[0]!.text).toContain("Done.");
      // The person sees it as a Markdown message: separate paragraphs and rules, no headings.
      expect(delivered[0]!.text).toMatch(/^[^\n]+\n\nBelow is/);
      expect(delivered[0]!.text.match(/\n\n---\n\n/g)).toHaveLength(2);
      expect(delivered[0]!.text).not.toContain("sk-test-1234567890abcdef1234");
      expect(orchestration.status(LEAD)!.lanes[0]!.lastReport?.preview).toContain("Done.");
    });

    it.each(["failed-turn", "failed-with-cli-error"])(
      "reports no reply when the failed turn only has replies from other turns (%s)",
      async (turnId) => {
        const { orchestration, delivered, session } = await leading();
        await orchestration.laneTurnEnded(session, turnId, "failed");

        expect(delivered).toHaveLength(1);
        expect(delivered[0]!.text).toContain("turn ended: failed");
        expect(delivered[0]!.text).toContain("(no reply was recorded)");
        expect(delivered[0]!.text).not.toMatch(
          /earlier turn|Done\.|a later turn|CLI error details/,
        );
      },
    );

    it("counts a Codex lead's reports as they go: two at once pass its limit no further", async () => {
      const delivered: string[] = [];
      const answers: Array<(merged: boolean) => void> = [];
      const { lanes } = host();
      const orchestration = service(
        lanes,
        directory(),
        "boot-1",
        (_lead, _device, text) =>
          new Promise<boolean>((resolve) => {
            delivered.push(text);
            answers.push(resolve);
          }),
      );
      orchestration.designate({
        sessionId: LEAD,
        deviceId: DEVICE,
        workspaceId: "w1",
        scope: { maxAutoTurns: 1 },
      });
      const session = await assignWorker(orchestration);
      await Promise.all([
        orchestration.laneTurnEnded(session, "t1", "completed"),
        orchestration.laneTurnEnded(session, "t2", "completed"),
      ]);
      expect(delivered).toHaveLength(1);
      expect(orchestration.status(LEAD)).toMatchObject({
        paused: false,
        autoTurns: 0,
        reportDeliveries: [expect.any(Object), expect.any(Object)],
      });
      // A merged delivery frees the reservation; the next waits for the real receipt.
      answers[0]!(true);
      await vi.waitFor(() => expect(delivered).toHaveLength(2));
      expect(orchestration.status(LEAD)!.autoTurns).toBe(0);
      answers[1]!(false);
      await expect.poll(() => orchestration.status(LEAD)!.autoTurns).toBe(1);
    });

    it("reports late the turns a worker ended while AgentKib did not watch it", async () => {
      const delivered: string[] = [];
      let ended: Array<{
        turnId: string;
        outcome: string;
        startedAt: string | null;
        endedAt: string | null;
      }> = [];
      const { lanes } = host({
        events: async () => [
          { kind: "agent-message", content: "Ran in the Codex app.", turn_id: "missed" },
        ],
        endedTurns: async () => ended,
      });
      const orchestration = service(lanes, directory(), "boot-1", (_lead, _device, text) => {
        delivered.push(text);
        return false;
      });
      orchestration.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1" });
      const session = await assignWorker(orchestration);
      const joined = Date.parse(orchestration.status(LEAD)!.lanes[0]!.createdAt);
      const at = (offset: number) => new Date(joined + offset).toISOString();
      ended = [
        // Before it was a worker: not the Project Agent's business.
        { turnId: "before", outcome: "completed", startedAt: at(-60_000), endedAt: at(-30_000) },
        { turnId: "missed", outcome: "completed", startedAt: at(1_000), endedAt: at(43_000) },
        { turnId: "stopped", outcome: "cancelled", startedAt: at(50_000), endedAt: at(55_000) },
        // Just ended: the live observers report it, with Codex's own measure.
        { turnId: "fresh", outcome: "completed", startedAt: at(100_000), endedAt: at(110_000) },
      ];
      // A live observer saw this one.
      await orchestration.laneTurnEnded(session, "stopped", "cancelled", 5_000);
      await orchestration.catchUp(joined + 120_000);
      await orchestration.catchUp(joined + 120_000);
      expect(delivered.map((text) => text.split("\n")[0])).toEqual([
        '[AgentKib report] Worker "worker-1" (Codex) · turn ended: cancelled after 5s',
        '[AgentKib report] Worker "worker-1" (Codex) · turn ended: completed after 42s',
      ]);
      expect(delivered[1]).toContain("Ran in the Codex app.");
    });

    it("tells the lead once that a lane waits for the user, and when the user steps in", async () => {
      const { orchestration, delivered, session } = await leading();
      await orchestration.laneWaiting(session, "t3", "awaiting-approval");
      await orchestration.laneWaiting(session, "t3", "awaiting-approval");
      orchestration.laneControlled(session, "send");
      orchestration.laneControlled(session, "stop");
      orchestration.laneControlled(session, "approve");
      expect(delivered.map((report) => report.text.split("\n")[0])).toEqual([
        '[AgentKib report] Worker "worker-1" (Codex) · waiting for the user\'s approval',
        '[AgentKib report] Worker "worker-1" (Codex) · the user sent it a message directly',
      ]);
    });

    it("holds reports while paused and sends them together on resume", async () => {
      const { orchestration, delivered, session } = await leading();
      orchestration.pause(LEAD);
      await orchestration.laneTurnEnded(session, "t1", "completed");
      await orchestration.laneWaiting(session, "t2", "waiting-input");
      expect(delivered).toEqual([]);
      expect(orchestration.status(LEAD)!.pendingReports).toHaveLength(2);
      orchestration.resume(LEAD, DEVICE);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.text).toContain("turn ended: completed");
      expect(delivered[0]!.text).toContain("an answer to its question");
      expect(orchestration.status(LEAD)!.pendingReports).toEqual([]);
    });

    it("records a resumed batch's human reply and waiting previews before dispatch", async () => {
      const { orchestration, delivered, lives, session } = await leading({
        approvals: ["command"],
      });
      orchestration.setWorkerRole(LEAD, session, {
        label: "Validation",
        description: "Run the checks.",
      });
      orchestration.pause(LEAD);
      await orchestration.laneTurnEnded(session, "t1", "completed", 192_400);
      orchestration.setWorkerRole(LEAD, session, {
        label: "Release",
        description: "Verify the bundle.",
      });
      lives.set(session, {
        status: "awaiting-approval",
        approvals: [
          {
            supported: true,
            requestId: "private-command-request",
            method: "item/commandExecution/requestApproval",
            command: "git status --short",
            availableDecisions: ["accept", "decline"],
          },
          {
            supported: true,
            requestId: "private-file-request",
            method: "item/fileChange/requestApproval",
            changes: [{ path: "note.md" }],
            availableDecisions: ["accept", "decline"],
          },
        ],
      });
      await orchestration.laneWaiting(session, "t2", "awaiting-approval");
      expect(delivered).toEqual([]);
      orchestration.resume(LEAD, DEVICE);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.text).toContain('Role: "Validation"');
      expect(delivered[0]!.text).toContain('Role: "Release"');
      expect(delivered[0]!.text).toContain("private-command-request");
      expect(delivered[0]!.text).toContain("Below is the worker's last reply");

      const database = openManagedLedger(orchestration.registry.dataDir)!;
      try {
        const stored = database
          .prepare("SELECT view FROM worker_report_deliveries WHERE session_id=? AND report_id=?")
          .get(LEAD, delivered[0]!.reportId!) as { view: string };
        expect(JSON.parse(stored.view)).toMatchObject({
          reportId: delivered[0]!.reportId,
          parts: [
            {
              kind: "turn-ended",
              workerSessionId: session,
              workerName: "worker-1",
              workerRoleLabel: "Validation",
              agent: "codex",
              occurredAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
              outcome: "completed",
              durationMs: 192_400,
              requiresUser: false,
              reply: expect.stringContaining("Done."),
            },
            {
              kind: "waiting-approval",
              workerRoleLabel: "Release",
              requiresUser: true,
              delegable: true,
              waitingItems: [
                { kind: "command", summary: "git status --short" },
                { kind: "file-change", summary: "note.md" },
              ],
            },
          ],
        });
        expect(stored.view).not.toMatch(
          /private-.*-request|Use worker_read|AgentKib report|sk-test-/,
        );
      } finally {
        database.close();
      }
    });

    it("stops starting the lead at its turn limit until the user speaks; merged reports start no turn", async () => {
      const { orchestration, delivered, session, merging } = await leading({ maxAutoTurns: 2 });
      await orchestration.laneTurnEnded(session, "t1", "completed");
      merging(true);
      await orchestration.laneTurnEnded(session, "t2", "completed");
      merging(false);
      await orchestration.laneTurnEnded(session, "t3", "completed");
      expect(orchestration.status(LEAD)).toMatchObject({ autoTurns: 2, paused: false });
      await orchestration.laneTurnEnded(session, "t4", "failed");
      expect(delivered).toHaveLength(3);
      expect(orchestration.status(LEAD)).toMatchObject({ paused: true, reason: "auto-turn-limit" });
      orchestration.userSpoke(LEAD);
      expect(orchestration.status(LEAD)).toMatchObject({
        paused: false,
        autoTurns: 1,
        pendingReports: [],
      });
      expect(delivered.at(-1)!.text).toContain("turn ended: failed");
    });

    it("counts turns the lead's CLI starts by itself; past the limit it pauses and refuses them", async () => {
      const { orchestration, delivered, session } = await leading({ maxAutoTurns: 2 });
      expect(orchestration.leadSelfTurn("not-a-lead")).toBe(true);
      expect(orchestration.leadSelfTurn(LEAD)).toBe(true);
      await orchestration.laneTurnEnded(session, "t1", "completed");
      expect(orchestration.status(LEAD)).toMatchObject({ autoTurns: 2, paused: false });
      expect(orchestration.leadSelfTurn(LEAD)).toBe(false);
      expect(orchestration.status(LEAD)).toMatchObject({ paused: true, reason: "auto-turn-limit" });
      await orchestration.laneTurnEnded(session, "t2", "completed");
      expect(delivered).toHaveLength(1);
      orchestration.userSpoke(LEAD);
      expect(delivered).toHaveLength(2);
      expect(orchestration.leadSelfTurn(LEAD)).toBe(true);
      expect(orchestration.status(LEAD)).toMatchObject({ autoTurns: 2, paused: false });
    });

    it("goes on after a restart and preserves manual and authorization pauses across another boot", async () => {
      const root = directory();
      const delivered: string[] = [];
      const deliver = (_lead: string, _device: string, text: string) => {
        delivered.push(text);
        return false;
      };
      const { lanes } = host({ events: async () => [] });
      const before = service(lanes, root, "boot-1", deliver);
      before.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1" });
      const session = await assignWorker(before);
      const after = service(lanes, root, "boot-2", deliver);
      await after.laneTurnEnded(session, "t1", "completed");
      expect(after.status(LEAD)).toMatchObject({
        paused: false,
        reason: null,
      });
      expect(delivered).toHaveLength(1);
      after.pause(LEAD);
      const manual = service(lanes, root, "boot-3", deliver);
      manual.userSpoke(LEAD);
      expect(manual.status(LEAD)).toMatchObject({ paused: true, reason: "user-paused" });
      manual.invalidateDevice(DEVICE);
      const unauthorized = service(lanes, root, "boot-4", deliver);
      unauthorized.userSpoke(LEAD);
      expect(unauthorized.status(LEAD)).toMatchObject({
        paused: true,
        reason: "authorization-changed",
      });
    });
  });

  it("merges MCP configurations, later servers winning", () => {
    expect(mergeMcpConfigs(undefined, null)).toBeUndefined();
    expect(
      mergeMcpConfigs(
        { mcpServers: { goal: { url: "a" } } },
        { mcpServers: { lanes: { url: "b" }, goal: { url: "c" } } },
      ),
    ).toEqual({ mcpServers: { goal: { url: "c" }, lanes: { url: "b" } } });
  });
});

describe("a lead that waits for its usage limit to reset", () => {
  it.skipIf(process.platform === "win32")(
    "releases an existing terminal outbox with the ordered recovery batch",
    async () => {
      const bridgeCleanups: Array<() => Promise<void>> = [];
      cleanups.push(async () => {
        for (const cleanup of bridgeCleanups.reverse()) await cleanup();
      });
      let orchestration: OrchestrationService;
      const f = await createClaudeBridgeFixture(bridgeCleanups)(1000, {
        tools: (id) => orchestration.leadToolSpecs(id),
        call: (id, name, input) => orchestration.call(id, name, input),
        paused: (id) => orchestration.status(id)?.reason ?? null,
        reportPauseChanged: (id, paused) => {
          if (paused) orchestration.pause(id, "usage-limit");
          else return orchestration.limitEnded(id);
        },
      });
      const lead = f.target.sessionId;
      const now = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      cleanups.push(() => vi.useRealTimers());
      const at = (offset: number) => new Date(now + offset).toISOString();
      const historyReady = Promise.withResolvers<void>();
      cleanups.push(() => historyReady.resolve());
      const { lanes } = host({
        endedTurns: async (sessionId) => {
          await historyReady.promise;
          const ordinal = sessionId === WORKER ? 2 : 1;
          return [
            {
              turnId: `backfill-${ordinal}`,
              outcome: "completed",
              startedAt: at(0),
              endedAt: at(ordinal * 1_000),
              replyText: `[result-${ordinal}]`,
            },
          ];
        },
      });
      orchestration = new OrchestrationService(
        directory(),
        "boot",
        lanes,
        (id) => id === lead,
        (id, _device, message, canSend, reportId) => {
          expect(canSend?.()).toBe(true);
          return f.bridge.queueReport(id, message, reportId);
        },
        (id) => f.bridge.queuedReports(id),
        (id) => f.bridge.leadReportsPaused(id),
      );
      cleanups.push(() => orchestration.close());
      const assignment = { ...OWNER, sessionId: lead };
      await orchestration.assignWorkers({ ...assignment, workers: [WORKER, "codex-branch"] });
      const poll = async (leadReportsPaused: boolean, reportAckIds: string[] = []) => {
        const response = await f.post("/v1/commands", {
          afterCommandId: null,
          waitMs: 0,
          leadTools: true,
          leadReportsPaused,
          reportAckIds,
        });
        expect(response.status).toBe(200);
        return response.body.lead.reports as Array<{ id: string; text: string }>;
      };
      const offered = randomUUID();
      f.bridge.queueReport(lead, "[previous-native-offer]", offered);
      expect(await poll(false)).toEqual([{ id: offered, text: "[previous-native-offer]" }]);
      expect(await poll(true)).toEqual([]);
      const queued = randomUUID();
      f.bridge.queueReport(lead, "[result-0]", queued);
      vi.setSystemTime(now + 3_000);
      await orchestration.laneTurnEnded(
        "codex-branch",
        "live-3",
        "failed",
        null,
        undefined,
        "[result-3]",
      );
      expect(await poll(true)).toEqual([]);
      vi.setSystemTime(now + 20_000);

      // The recovery scan only holds reports; a commands poll can complete before it finishes.
      expect(await poll(false, [offered])).toEqual([]);
      historyReady.resolve();
      await orchestration.catchUp();
      const recovered = await poll(false);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.id).toBe(queued);
      expect(recovered[0]?.text.match(/\[result-\d+\]/g)).toEqual([
        "[result-0]",
        "[result-1]",
        "[result-2]",
        "[result-3]",
      ]);
      expect(await poll(false)).toEqual([]);
      vi.setSystemTime(now + 24_000);
      expect(await poll(false)).toEqual(recovered);
      expect(await poll(false, [queued])).toEqual([]);
      expect(f.bridge.queuedReports(lead)).toBe(0);
    },
  );

  it("sends live and backfilled reports together in completion order after a usage hold", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    cleanups.push(() => vi.useRealTimers());
    const now = Date.parse("2026-01-01T12:00:00Z");
    vi.setSystemTime(now);
    const at = (seconds: number) => new Date(now + seconds * 1_000).toISOString();
    const delivered: string[] = [];
    const { lanes } = host({
      endedTurns: async (sessionId) =>
        (sessionId === WORKER ? [2, 4, 6] : [1, 3, 5]).map((index) => ({
          turnId: `report-${index}`,
          outcome: "completed",
          startedAt: at(0),
          endedAt: at(index * 10),
          replyText: `[result-${index}]`,
        })),
    });
    let limited = true;
    const orchestration = new OrchestrationService(
      directory(),
      "boot",
      lanes,
      () => true,
      (_lead, _device, report) => {
        delivered.push(report);
        return false;
      },
      () => 0,
      () => limited,
    );
    cleanups.push(() => orchestration.close());
    orchestration.designate(OWNER);
    await assignWorker(orchestration);
    const second = await assignWorker(orchestration, "codex-branch");
    vi.setSystemTime(now + 70_000);
    await orchestration.laneTurnEnded(second, "report-7", "failed", null, undefined, "[result-7]");
    vi.setSystemTime(now + 110_000);
    expect(delivered).toEqual([]);
    limited = false;
    orchestration.limitEnded(LEAD);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    await orchestration.catchUp();
    expect(delivered.join("\n").match(/\[result-\d+\]/g)).toEqual([
      "[result-1]",
      "[result-2]",
      "[result-3]",
      "[result-4]",
      "[result-5]",
      "[result-6]",
      "[result-7]",
    ]);
  });

  it("holds the reports until the limit is over, then sends them", async () => {
    const delivered: string[] = [];
    let limited = true;
    const { lanes } = host({
      events: async () => [{ kind: "agent-message", content: "Done.", turn_id: "t1" }],
    });
    const orchestration = new OrchestrationService(
      directory(),
      "boot-1",
      lanes,
      (id) => id === LEAD,
      (_lead, _device, text) => {
        delivered.push(text);
        return false;
      },
      () => 0,
      () => limited,
    );
    cleanups.push(() => orchestration.close());
    orchestration.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1", scope: {} });
    const session = await assignWorker(orchestration);
    await orchestration.laneTurnEnded(session, "t1", "completed");
    // Sent now, it would meet the limit again in place of the continue AgentKib armed.
    expect(delivered).toEqual([]);
    expect(orchestration.registry.get(LEAD)).toMatchObject({
      paused: true,
      reason: "usage-limit",
      autoTurns: 0,
    });
    expect(orchestration.registry.get(LEAD)!.reportDeliveries).toHaveLength(1);
    limited = false;
    orchestration.limitEnded(LEAD);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0]).toContain('Worker "worker-1"');
    expect(orchestration.registry.get(LEAD)).toMatchObject({ paused: false, reason: null });
    // Only a pause for the limit ends with it.
    orchestration.pause(LEAD, "user-paused");
    orchestration.limitEnded(LEAD);
    expect(orchestration.registry.get(LEAD)).toMatchObject({ paused: true, reason: "user-paused" });
  });
});
