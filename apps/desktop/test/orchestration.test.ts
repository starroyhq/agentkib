import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexTurnErrorEvent } from "../../../packages/backend/src/codex-turn-error";
import { LeadRegistry } from "../../../packages/backend/src/orchestration-registry";
import {
  LEAD_INSTRUCTIONS,
  leadInstructions,
  mergeMcpConfigs,
  OrchestrationService,
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
    options: async () => ({ available: true, models: [{ value: "gpt-x" }] }),
    lifecycle: async (value) => {
      calls.push({ kind: "lifecycle", ...value });
      return {
        accepted: true,
        requestId: value.requestId,
        sessionId: createHash("sha256").update(`managed:${value.requestId}`).digest("hex"),
      };
    },
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
        : sessionId === "claude-other"
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
  sendReport: (lead: string, device: string, text: string) => boolean = () => false,
) {
  const created = new OrchestrationService(root, bootId, lanes, (id) => id === LEAD, sendReport);
  cleanups.push(() => created.close());
  return created;
}

const parse = (result: { text: string }) => JSON.parse(result.text);

describe("lead registry", () => {
  it("keeps a lead across processes and pauses it after a restart", () => {
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
      paused: true,
      reason: "restart-confirmation-required",
      bootId: "boot-2",
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
});

describe("orchestration service", () => {
  it("makes only a managed Claude session a lead, within the workspaces and presets it may use", () => {
    const { lanes } = host();
    const orchestration = service(lanes);
    expect(() =>
      orchestration.designate({ sessionId: "claude-other", deviceId: DEVICE, workspaceId: "w1" }),
    ).toThrow("lead-requires-managed-claude");
    expect(() =>
      orchestration.designate({
        sessionId: LEAD,
        deviceId: DEVICE,
        workspaceId: "w1",
        scope: { workspaceIds: ["nope"] },
      }),
    ).toThrow("invalid-lead-workspaces");
    expect(() =>
      orchestration.designate({
        sessionId: LEAD,
        deviceId: DEVICE,
        workspaceId: "w1",
        scope: { policies: ["full-access-on-request" as never] },
      }),
    ).toThrow("invalid-lead-policies");
    expect(
      orchestration.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1" }),
    ).toMatchObject({
      scope: {
        workspaceIds: ["w1"],
        policies: ["workspace-write-on-request"],
        maxLanes: 4,
        maxAutoTurns: 25,
      },
      paused: false,
    });
  });

  it.each([true, false])(
    "links an existing Codex worker with managed=%s and leaves execution preparation to send",
    async (managed) => {
      const { lanes, calls } = host({ managed: async () => managed });
      const orchestration = service(lanes);
      orchestration.designate({
        sessionId: LEAD,
        deviceId: DEVICE,
        workspaceId: "w1",
        scope: {
          workspaceIds: ["w1", "w2"],
          policies: ["workspace-write-on-request", "workspace-write-auto-review"],
          maxLanes: 2,
        },
      });
      const opened = parse(
        await orchestration.call(LEAD, "worker_open", {
          name: "api",
          workspace: "w2",
          policy: "workspace-write-auto-review",
        }),
      );
      const create = calls.find((call) => call.operation === "create")!;
      expect(create).toMatchObject({
        workspaceId: "w2",
        policyId: "workspace-write-auto-review",
        deviceId: DEVICE,
      });
      // The Codex session follows from the request id, as web-read derives it.
      expect(opened).toEqual({
        accepted: true,
        worker: "api",
        agent: "codex",
        session: createHash("sha256").update(`managed:${create.requestId}`).digest("hex"),
      });
      expect(
        parse(
          await orchestration.call(LEAD, "worker_open", { name: "old", session: "codex-existing" }),
        ),
      ).toMatchObject({
        accepted: true,
        session: "codex-existing",
      });
      expect(calls.filter((call) => call.kind === "lifecycle")).toEqual([create]);
      expect(
        parse(
          await orchestration.call(LEAD, "worker_send", { worker: "old", text: "Review this" }),
        ),
      ).toMatchObject({ accepted: true, operation: "send" });
      expect(calls.filter((call) => call.kind === "control")).toEqual([
        expect.objectContaining({
          operation: "send",
          sessionId: "codex-existing",
          deviceId: DEVICE,
          runtimeBootId: "boot",
          expectedRevision: 3,
          text: "Review this",
        }),
      ]);
      for (const [input, reason] of [
        [{ name: "third", workspace: "w1" }, "worker-limit-reached"],
        [{ name: "api", workspace: "w1" }, "worker-name-taken"],
      ] as const)
        expect(parse(await orchestration.call(LEAD, "worker_open", input))).toMatchObject({
          accepted: false,
          reason,
        });
      const narrow = service(lanes);
      narrow.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1" });
      for (const [input, reason] of [
        [{ name: "a", workspace: "w9" }, "workspace-not-allowed"],
        [
          { name: "a", workspace: "w1", policy: "workspace-write-auto-review" },
          "policy-not-allowed",
        ],
        [{ name: "a", session: "codex-elsewhere" }, "workspace-not-allowed"],
        [{ name: "a", session: "claude-other" }, "worker-requires-codex-or-dsh-session"],
        [{ name: "a", session: LEAD }, "session-is-a-project-agent"],
        [{ name: "a" }, "worker-needs-workspace-or-session"],
        [{ name: "-bad", workspace: "w1" }, "invalid-worker-name"],
      ] as const)
        expect(parse(await narrow.call(LEAD, "worker_open", input))).toMatchObject({
          accepted: false,
          reason,
        });
    },
  );

  it("creates only one session when concurrent opens compete for the last worker slot", async () => {
    const { lanes, calls } = host();
    const createStarted = Promise.withResolvers<void>();
    const secondCreateStarted = Promise.withResolvers<void>();
    const finishCreate = Promise.withResolvers<void>();
    const lifecycle = lanes.lifecycle;
    let creates = 0;
    lanes.lifecycle = async (input) => {
      if (++creates === 1) createStarted.resolve();
      else secondCreateStarted.resolve();
      await finishCreate.promise;
      return lifecycle(input);
    };
    const orchestration = service(lanes);
    orchestration.designate({
      sessionId: LEAD,
      deviceId: DEVICE,
      workspaceId: "w1",
      scope: { maxLanes: 1 },
    });
    const config = (await orchestration.leadTools(LEAD)) as {
      mcpServers: Record<string, { url: string }>;
    };
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.mcpServers.agentkib_workers!.url)),
    );
    cleanups.push(() => client.close());
    const open = (name: string) =>
      client.callTool({ name: "worker_open", arguments: { name, workspace: "w1" } });

    const first = open("api");
    await createStarted.promise;
    const second = open("web");
    // Release the first creation as soon as the competing request is refused or reaches the host.
    await Promise.race([second, secondCreateStarted.promise]).finally(finishCreate.resolve);
    const [opened, refused] = (await Promise.all([first, second])).map((result) =>
      parse(result.content[0]),
    );

    expect(opened).toMatchObject({ accepted: true, worker: "api" });
    expect(refused).toMatchObject({ accepted: false, reason: "worker-limit-reached" });
    expect(calls.filter((call) => call.operation === "create")).toHaveLength(1);
    expect(orchestration.status(LEAD)!.lanes).toEqual([
      expect.objectContaining({ name: "api", sessionId: opened.session }),
    ]);
  });

  it.each([
    ["refused", "codex-owner-busy"],
    ["unknown", "worker-open-unconfirmed"],
    ["wrong-session", "worker-open-failed"],
    ["wrong-request", "worker-open-failed"],
  ])("keeps a %s Codex create out of the worker registry", async (outcome, reason) => {
    let expectedSession = "";
    const { lanes } = host({
      lifecycle: async (value) => {
        expectedSession = createHash("sha256").update(`managed:${value.requestId}`).digest("hex");
        if (outcome === "refused")
          return {
            accepted: false,
            controlOutcome: "not-dispatched",
            reason: "codex-owner-busy",
            requestId: value.requestId,
            sessionId: expectedSession,
          };
        if (outcome === "unknown")
          return {
            accepted: false,
            controlOutcome: "unknown",
            requestId: value.requestId,
            sessionId: expectedSession,
          };
        return {
          accepted: true,
          requestId: outcome === "wrong-request" ? "another-request" : value.requestId,
          sessionId: outcome === "wrong-session" ? "another-session" : expectedSession,
        };
      },
    });
    const orchestration = service(lanes);
    orchestration.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1" });
    expect(
      parse(await orchestration.call(LEAD, "worker_open", { name: "api", workspace: "w1" })),
    ).toMatchObject({ accepted: false, reason, session: expectedSession });
    expect(orchestration.status(LEAD)!.lanes).toEqual([]);
    expect(orchestration.status(LEAD)!.records).toEqual([]);
  });

  it("opens DeepSeek Harness workers, whose approvals stay the user's", async () => {
    const created: Array<Record<string, unknown>> = [];
    let createAnswer: Record<string, unknown> = {
      accepted: true,
      controlOutcome: "accepted",
      sessionId: "dsh-new",
    };
    const delivered: string[] = [];
    const { lanes, calls, lives } = host({
      dshOptions: async () => ({
        available: true,
        models: [
          { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", group: "DeepSeek", efforts: [] },
          { id: "mock/think", name: "Think", group: "Mock", efforts: ["high", "max"] },
        ],
        defaults: { model: "deepseek/deepseek-chat", effort: null },
      }),
      lifecycle: async (value) => {
        created.push(value);
        return value.agent === "deepseek-harness" ? createAnswer : { accepted: true };
      },
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
      sessionId: LEAD,
      deviceId: DEVICE,
      workspaceId: "w1",
      scope: { approvals: ["command", "file-change"], answers: true },
    });
    expect(parse(await orchestration.call(LEAD, "worker_list", {}))).toMatchObject({
      deepseekHarness: {
        available: true,
        models: [
          { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
          { id: "mock/think", name: "Think", efforts: ["high", "max"] },
        ],
        defaultModel: "deepseek/deepseek-chat",
      },
    });
    expect(
      parse(
        await orchestration.call(LEAD, "worker_open", {
          name: "ds",
          agent: "deepseek-harness",
          workspace: "w1",
          model: "deepseek/deepseek-chat",
        }),
      ),
    ).toEqual({ accepted: true, worker: "ds", agent: "deepseek-harness", session: "dsh-new" });
    // DSH starts it in its own workspace-write preset; no Codex preset goes with it.
    expect(created).toEqual([
      expect.objectContaining({
        operation: "create",
        agent: "deepseek-harness",
        workspaceId: "w1",
        deviceId: DEVICE,
        model: "deepseek/deepseek-chat",
      }),
    ]);
    expect(created[0]).not.toHaveProperty("policyId");
    // An existing DSH worker stays in the runtime that serves it.
    expect(
      parse(
        await orchestration.call(LEAD, "worker_open", { name: "old", session: "dsh-existing" }),
      ),
    ).toEqual({
      accepted: true,
      worker: "old",
      agent: "deepseek-harness",
      session: "dsh-existing",
    });
    expect(created).toHaveLength(1);
    for (const [input, reason] of [
      [
        {
          name: "a",
          agent: "deepseek-harness",
          workspace: "w1",
          policy: "workspace-write-on-request",
        },
        "policy-is-codex-only",
      ],
      [{ name: "a", agent: "claude-code", workspace: "w1" }, "invalid-agent"],
      [{ name: "a", session: "dsh-gone" }, "worker-unavailable"],
      [{ name: "a", session: "dsh-other", agent: "codex" }, "session-is-another-agent"],
    ] as const)
      expect(parse(await orchestration.call(LEAD, "worker_open", input))).toMatchObject({
        accepted: false,
        reason,
      });
    for (const [answer, refusal] of [
      [
        { accepted: false, controlOutcome: "not-dispatched", reason: "dsh-runtime-offline" },
        { reason: "dsh-runtime-offline" },
      ],
      [
        { accepted: false, controlOutcome: "unknown", reason: "control-outcome-unconfirmed" },
        { reason: "worker-open-unconfirmed" },
      ],
      [
        { accepted: false, reason: "dsh-worker-preset-unavailable", sessionId: "dsh-loose" },
        { reason: "dsh-worker-preset-unavailable", session: "dsh-loose" },
      ],
    ] as const) {
      createAnswer = answer;
      expect(
        parse(
          await orchestration.call(LEAD, "worker_open", {
            name: "b",
            agent: "deepseek-harness",
            workspace: "w1",
          }),
        ),
      ).toMatchObject({ accepted: false, ...refusal });
    }
    expect(orchestration.status(LEAD)!.lanes.map((lane) => lane.name)).toEqual(["ds", "old"]);

    await orchestration.laneTurnEnded("dsh-new", "dsh-turn-1", "completed", 5_000);
    expect(delivered.at(-1)).toMatch(
      /^\[AgentKib report\] Worker "ds" \(DeepSeek Harness\) · turn ended: completed after 5s\n/,
    );
    // A DSH approval is the user's, whatever the lead may decide for Codex workers.
    lives.set("dsh-new", {
      sessionId: "dsh-new",
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
    await orchestration.laneWaiting("dsh-new", "dsh-turn-2", "awaiting-approval");
    // Its own paragraph under the line that says which Worker waits.
    expect(delivered.at(-1)).toMatch(/approval\n\nThe user decides in AgentKib/);
    expect(
      parse(
        await orchestration.call(LEAD, "worker_approve", {
          worker: "ds",
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
    lives.set("dsh-new", {
      sessionId: "dsh-new",
      status: "waiting-input",
      revision: 8,
      runtimeBootId: "boot",
      turnId: "dsh-turn-3",
      approvals: [],
      questions: [card("approval-card", false), card("question-1", true)],
    });
    const read = parse(await orchestration.call(LEAD, "worker_read", { worker: "ds" }));
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
          worker: "ds",
          question: "approval-card",
          answers: { q1: "A" },
        }),
      ),
    ).toMatchObject({ accepted: false, reason: "question-not-delegated" });
    expect(
      parse(
        await orchestration.call(LEAD, "worker_answer", {
          worker: "ds",
          question: "question-1",
          answers: { q1: "B" },
        }),
      ),
    ).toMatchObject({ accepted: true });
    expect(calls.at(-1)).toMatchObject({
      operation: "answer",
      sessionId: "dsh-new",
      questionId: "question-1",
      turnId: "dsh-turn-3",
      expectedRevision: 8,
      answers: { q1: ["B"] },
    });
    expect(
      parse(await orchestration.call(LEAD, "worker_list", {})).workers.map(
        (worker: { worker: string; agent: string }) => [worker.worker, worker.agent],
      ),
    ).toEqual([
      ["ds", "deepseek-harness"],
      ["old", "deepseek-harness"],
    ]);
  });

  it("sends a brief to an idle lane, queues or steers while it runs, and stops its turn", async () => {
    const { lanes, calls, lives } = host();
    const orchestration = service(lanes);
    orchestration.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1" });
    const { session } = parse(
      await orchestration.call(LEAD, "worker_open", { name: "api", workspace: "w1" }),
    );
    const sent = parse(
      await orchestration.call(LEAD, "worker_send", {
        worker: "api",
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
        await orchestration.call(LEAD, "worker_send", { worker: "api", text: "Also check tests" }),
      ),
    ).toMatchObject({ operation: "queue-add" });
    expect(
      parse(
        await orchestration.call(LEAD, "worker_send", {
          worker: "api",
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
    expect(parse(await orchestration.call(LEAD, "worker_stop", { worker: "api" }))).toMatchObject({
      accepted: true,
    });
    expect(calls.at(-1)).toMatchObject({ operation: "stop", turnId: "turn-1" });
    const read = parse(await orchestration.call(LEAD, "worker_read", { worker: "api", limit: 2 }));
    expect(read).toMatchObject({
      worker: "api",
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
      workers: [{ worker: "api", status: "running", title: "Brief 1" }],
      workspaces: [{ id: "w1", name: "app" }],
      models: [{ value: "gpt-x" }],
    });
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
    await orchestration.call(LEAD, "worker_open", { name: "api", workspace: "w1" });
    const refused = await orchestration.call(LEAD, "worker_send", { worker: "api", text: "go" });
    expect(refused.isError).toBe(true);
    expect(parse(refused)).toMatchObject({ accepted: false, reason: "codex-owner-busy" });
    answer = { accepted: false, controlOutcome: "unknown" };
    expect(
      parse(await orchestration.call(LEAD, "worker_send", { worker: "api", text: "go" })),
    ).toMatchObject({
      accepted: false,
      outcome: "unknown",
    });
    expect(calls.filter((call) => call.kind === "control")).toHaveLength(2);
  });

  it("stops acting while paused, also when the device that set it up loses its authorization", async () => {
    const { lanes, calls } = host();
    const orchestration = service(lanes);
    orchestration.designate({ sessionId: LEAD, deviceId: "phone-1", workspaceId: "w1" });
    await orchestration.call(LEAD, "worker_open", { name: "api", workspace: "w1" });
    orchestration.invalidateDevice("phone-1");
    expect(orchestration.status(LEAD)).toMatchObject({
      paused: true,
      reason: "authorization-changed",
    });
    for (const [name, input] of [
      ["worker_send", { worker: "api", text: "go" }],
      ["worker_stop", { worker: "api" }],
      ["worker_open", { name: "b", workspace: "w1" }],
    ] as const)
      expect(parse(await orchestration.call(LEAD, name, input))).toMatchObject({
        accepted: false,
        reason: "delegation-paused",
      });
    // Reading still works, so the lead can tell the user what is going on.
    expect(parse(await orchestration.call(LEAD, "worker_list", {}))).toMatchObject({
      paused: true,
      reason: "authorization-changed",
    });
    const before = calls.length;
    expect(orchestration.resume(LEAD, DEVICE)).toMatchObject({
      paused: false,
      deviceId: DEVICE,
      autoTurns: 0,
    });
    expect(
      parse(await orchestration.call(LEAD, "worker_send", { worker: "api", text: "go" })),
    ).toMatchObject({ accepted: true });
    expect(calls.slice(before).at(-1)).toMatchObject({ deviceId: DEVICE });
  });

  describe("workers the person manages", () => {
    it("lets a worker go, freeing its place, by the person or by the lead", async () => {
      const { lanes } = host();
      const orchestration = service(lanes);
      orchestration.designate({
        sessionId: LEAD,
        deviceId: DEVICE,
        workspaceId: "w1",
        scope: { maxLanes: 2 },
      });
      const first = parse(
        await orchestration.call(LEAD, "worker_open", { name: "a", workspace: "w1" }),
      );
      await orchestration.call(LEAD, "worker_open", { name: "b", workspace: "w1" });
      expect(
        parse(await orchestration.call(LEAD, "worker_open", { name: "c", workspace: "w1" })),
      ).toMatchObject({ accepted: false, reason: "worker-limit-reached" });
      orchestration.removeWorker(LEAD, first.session);
      expect(orchestration.roles().get(first.session)).toBeUndefined();
      expect(
        parse(await orchestration.call(LEAD, "worker_open", { name: "c", workspace: "w1" })),
      ).toMatchObject({ accepted: true });
      expect(parse(await orchestration.call(LEAD, "worker_close", { worker: "b" }))).toMatchObject({
        accepted: true,
        worker: "b",
      });
      expect((await orchestration.overview(LEAD))!.workers).toEqual([
        expect.objectContaining({ name: "c" }),
      ]);
      // One that is not there any more is a refusal like any other, not a failure.
      expect(parse(await orchestration.call(LEAD, "worker_close", { worker: "b" }))).toMatchObject({
        accepted: false,
        reason: "worker-unavailable",
      });
      expect(() => orchestration.removeWorker(LEAD, first.session)).toThrow("worker-unavailable");
      expect(
        orchestration
          .status(LEAD)!
          .records.filter((record) => record.kind === "close")
          .map((record) => record.outcome),
      ).toEqual(["removed", "closed"]);
    });

    it("lets the person stop a worker's turn in their own name, also while delegation is paused", async () => {
      const { lanes, calls, lives } = host();
      const orchestration = service(lanes);
      orchestration.designate({ sessionId: LEAD, deviceId: "phone-1", workspaceId: "w1" });
      const { session } = parse(
        await orchestration.call(LEAD, "worker_open", { name: "api", workspace: "w1" }),
      );
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
      // The lead cannot let it go while paused; the person can stop it.
      expect(
        parse(await orchestration.call(LEAD, "worker_close", { worker: "api" })),
      ).toMatchObject({ accepted: false, reason: "delegation-paused" });
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
        "worker-unavailable",
      );
    });

    it("changes the scope in the name of the device that changes it; the next CLI gets changed tools", async () => {
      const { lanes, calls } = host();
      const orchestration = service(lanes);
      orchestration.designate({
        sessionId: LEAD,
        deviceId: "phone-1",
        workspaceId: "w1",
        scope: { workspaceIds: ["w1", "w2"] },
      });
      await orchestration.call(LEAD, "worker_open", { name: "api", workspace: "w2" });
      type Config = { mcpServers: Record<string, { url: string }> };
      const before = (await orchestration.leadTools(LEAD)) as Config;
      // A scope that cannot be used is refused whole; the parts given replace those it had.
      await expect(
        orchestration.update({ sessionId: LEAD, deviceId: DEVICE, scope: { workspaceIds: [] } }),
      ).rejects.toThrow("invalid-lead-workspaces");
      await expect(
        orchestration.update({ sessionId: LEAD, deviceId: DEVICE, scope: { maxLanes: 9 } }),
      ).rejects.toThrow("invalid-lead-lane-limit");
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
        scope: { workspaceIds: ["w1", "w2"], maxLanes: 4, maxAutoTurns: 10, approvals: [] },
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
          scope: { approvals: ["command"], workspaceIds: ["w1"] },
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
      expect((await client.listTools()).tools.map((tool: { name: string }) => tool.name)).toContain(
        "worker_approve",
      );
      // The worker in w2, which the lead may no longer use, is only listed and let go.
      expect(parse(await orchestration.call(LEAD, "worker_list", {})).workers).toEqual([
        expect.objectContaining({ worker: "api", workspace: "no-longer-allowed" }),
      ]);
      const before2 = calls.length;
      expect(
        parse(await orchestration.call(LEAD, "worker_send", { worker: "api", text: "go" })),
      ).toMatchObject({ accepted: false, reason: "workspace-not-allowed" });
      expect(calls.length).toBe(before2);
      expect(
        parse(await orchestration.call(LEAD, "worker_close", { worker: "api" })),
      ).toMatchObject({ accepted: true });
      expect(orchestration.status(LEAD)!.records.map((record) => record.kind)).toContain("update");
    });

    it("lets a deleted session's worker go, and ends a lead whose session is deleted", async () => {
      const { lanes } = host();
      const orchestration = service(lanes);
      orchestration.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1" });
      const { session } = parse(
        await orchestration.call(LEAD, "worker_open", { name: "api", workspace: "w1" }),
      );
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
    expect(tools.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "worker_list",
      "worker_open",
      "worker_send",
      "worker_read",
      "worker_stop",
      "worker_close",
    ]);
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
      const { session } = parse(
        await orchestration.call(LEAD, "worker_open", { name: "api", workspace: "w1" }),
      );
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
      const read = parse(await orchestration.call(LEAD, "worker_read", { worker: "api" }));
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
              worker: "api",
              approval: id,
              decision: "accept",
            }),
          ),
        ).toMatchObject({ accepted: false, reason });
      expect(
        parse(
          await orchestration.call(LEAD, "worker_approve", {
            worker: "api",
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
            worker: "api",
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
            worker: "api",
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
          .slice(-3),
      ).toEqual(["worker_approve", "worker_answer", "worker_close"]);
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
            worker: "api",
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
      const delivered: Array<{ lead: string; device: string; text: string }> = [];
      let merge = false;
      const { lanes } = host({
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
      const orchestration = service(lanes, directory(), "boot-1", (lead, device, text) => {
        delivered.push({ lead, device, text });
        return merge;
      });
      orchestration.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1", scope });
      const { session } = parse(
        await orchestration.call(LEAD, "worker_open", { name: "api", workspace: "w1" }),
      );
      return {
        orchestration,
        delivered,
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
        /^\[AgentKib report\] Worker "api" \(Codex\) · turn ended: completed after 3m 12s\n/,
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
      const { session } = parse(
        await orchestration.call(LEAD, "worker_open", { name: "api", workspace: "w1" }),
      );
      await Promise.all([
        orchestration.laneTurnEnded(session, "t1", "completed"),
        orchestration.laneTurnEnded(session, "t2", "completed"),
      ]);
      expect(delivered).toHaveLength(1);
      expect(orchestration.status(LEAD)).toMatchObject({
        paused: true,
        reason: "auto-turn-limit",
        autoTurns: 1,
        pendingReports: [expect.stringContaining("turn ended")],
      });
      // One that joined a report still waiting gives its turn back.
      answers[0]!(true);
      await expect.poll(() => orchestration.status(LEAD)!.autoTurns).toBe(0);
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
      const { session } = parse(
        await orchestration.call(LEAD, "worker_open", { name: "api", workspace: "w1" }),
      );
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
        '[AgentKib report] Worker "api" (Codex) · turn ended: cancelled after 5s',
        '[AgentKib report] Worker "api" (Codex) · turn ended: completed after 42s',
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
        '[AgentKib report] Worker "api" (Codex) · waiting for the user\'s approval',
        '[AgentKib report] Worker "api" (Codex) · the user sent it a message directly',
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

    it("goes on after a restart once the user speaks to the lead; not after a pause they chose", async () => {
      const root = directory();
      const delivered: string[] = [];
      const deliver = (_lead: string, _device: string, text: string) => {
        delivered.push(text);
        return false;
      };
      const { lanes } = host({ events: async () => [] });
      const before = service(lanes, root, "boot-1", deliver);
      before.designate({ sessionId: LEAD, deviceId: DEVICE, workspaceId: "w1" });
      const { session } = parse(
        await before.call(LEAD, "worker_open", { name: "api", workspace: "w1" }),
      );
      const after = service(lanes, root, "boot-2", deliver);
      await after.laneTurnEnded(session, "t1", "completed");
      expect(after.status(LEAD)).toMatchObject({
        paused: true,
        reason: "restart-confirmation-required",
      });
      expect(delivered).toEqual([]);
      after.userSpoke(LEAD);
      expect(after.status(LEAD)).toMatchObject({ paused: false, reason: null, pendingReports: [] });
      expect(delivered).toHaveLength(1);
      for (const pause of [() => after.pause(LEAD), () => after.invalidateDevice(DEVICE)]) {
        pause();
        after.userSpoke(LEAD);
        expect(after.status(LEAD)!.paused).toBe(true);
        after.resume(LEAD, DEVICE);
      }
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
    const { session } = parse(
      await orchestration.call(LEAD, "worker_open", { name: "api", workspace: "w1" }),
    );
    await orchestration.laneTurnEnded(session, "t1", "completed");
    // Sent now, it would meet the limit again in place of the continue AgentKib armed.
    expect(delivered).toEqual([]);
    expect(orchestration.registry.get(LEAD)).toMatchObject({
      paused: true,
      reason: "usage-limit",
      autoTurns: 0,
    });
    expect(orchestration.registry.get(LEAD)!.pendingReports).toHaveLength(1);
    limited = false;
    orchestration.limitEnded(LEAD);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0]).toContain('Worker "api"');
    expect(orchestration.registry.get(LEAD)).toMatchObject({ paused: false, reason: null });
    // Only a pause for the limit ends with it.
    orchestration.pause(LEAD, "user-paused");
    orchestration.limitEnded(LEAD);
    expect(orchestration.registry.get(LEAD)).toMatchObject({ paused: true, reason: "user-paused" });
  });
});
