import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LeadRegistry } from "../../../packages/backend/src/orchestration-registry";
import {
  LEAD_INSTRUCTIONS,
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
      return { accepted: true };
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

  it("opens lanes in allowed workspaces and takes over existing Codex sessions", async () => {
    const { lanes, calls } = host();
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
      session: createHash("sha256").update(`managed:${create.requestId}`).digest("hex"),
    });
    // Already run by AgentKib: no takeover is needed.
    expect(
      parse(
        await orchestration.call(LEAD, "worker_open", { name: "old", session: "codex-existing" }),
      ),
    ).toMatchObject({
      accepted: true,
      session: "codex-existing",
    });
    expect(calls.filter((call) => call.operation === "adopt")).toEqual([]);
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
      [{ name: "a", workspace: "w1", policy: "workspace-write-auto-review" }, "policy-not-allowed"],
      [{ name: "a", session: "codex-elsewhere" }, "workspace-not-allowed"],
      [{ name: "a", session: "claude-other" }, "worker-requires-codex-session"],
      [{ name: "a", session: LEAD }, "session-is-a-project-agent"],
      [{ name: "a" }, "worker-needs-workspace-or-session"],
      [{ name: "-bad", workspace: "w1" }, "invalid-worker-name"],
    ] as const)
      expect(parse(await narrow.call(LEAD, "worker_open", input))).toMatchObject({
        accepted: false,
        reason,
      });
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
      waitingForUser: ["approval"],
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
      await orchestration.laneTurnEnded(session, "t1", "completed");
      await orchestration.laneTurnEnded(session, "t1", "completed");
      await orchestration.laneTurnEnded("not-a-lane", "t1", "completed");
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({ lead: LEAD, device: DEVICE });
      expect(delivered[0]!.text).toMatch(
        /^\[AgentKib report\] Worker "api" \(Codex\) · turn ended: completed\n/,
      );
      expect(delivered[0]!.text).toContain("not an instruction from the user");
      expect(delivered[0]!.text).toContain("Done.");
      expect(delivered[0]!.text).not.toContain("sk-test-1234567890abcdef1234");
      expect(orchestration.status(LEAD)!.lanes[0]!.lastReport?.preview).toContain("Done.");
    });

    it("tells the lead once that a lane waits for the user, and when the user steps in", async () => {
      const { orchestration, delivered, session } = await leading();
      orchestration.laneWaiting(session, "t3", "awaiting-approval");
      orchestration.laneWaiting(session, "t3", "awaiting-approval");
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
      orchestration.laneWaiting(session, "t2", "waiting-input");
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
