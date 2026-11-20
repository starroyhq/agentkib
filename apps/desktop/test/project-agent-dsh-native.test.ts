// @vitest-environment node
// Opt in on macOS with AGENTKIB_DSH_PROJECT_AGENT_NATIVE=1 (AGENTKIB_DSH_EXECUTABLE for a launcher
// other than DSH Desktop's). Project Agents and workers on a real DeepSeek Harness that AgentKib
// starts in the background (`DshManagedRuntime`) with AgentKib's plugin, against a loopback
// chat-completions provider with a fake key, in a throwaway HOME and DSH data directory, confined
// by sandbox-exec to loopback. No account or user data is read.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DshBridge } from "../../../packages/backend/src/dsh-bridge";
import {
  createDshWorker,
  DshLaneWatch,
  DshLeadWatch,
} from "../../../packages/backend/src/dsh-lanes";
import { haltOwnTurns } from "../../../packages/backend/src/lead-turn-origin";
import { DshManagedRuntime } from "../../../packages/backend/src/dsh-managed-runtime";
import { MessageLeadReports } from "../../../packages/backend/src/message-lead-reports";
import {
  OrchestrationService,
  type LaneHost,
} from "../../../packages/backend/src/orchestration-service";

type Json = Record<string, any>;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DSH_LAUNCHER = "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
const PLUGIN = fileURLToPath(new URL("../../../packages/dsh-bridge-plugin", import.meta.url));
const REPLY = "WORKER-DONE: summary written.";
const DEVICE = "desktop-local";

async function until<T>(
  read: () => T | undefined | false | Promise<T | undefined | false>,
  ms: number,
) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** What the model answers: text, or one tool call. */
type Answer = { text: string } | { tool: { name: string; arguments: Json } };

/** An OpenAI-style chat-completions provider that answers each request as `script` says. */
async function provider(
  script: (body: Json) => Answer | Promise<Answer> = () => ({ text: REPLY }),
) {
  const requests: Json[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", async () => {
      if (request.method !== "POST" || !request.url?.includes("/chat/completions")) {
        response.writeHead(404);
        response.end();
        return;
      }
      const body = JSON.parse(raw) as Json;
      requests.push(body);
      const answer = await script(body);
      if (response.destroyed) return;
      const chunk = (value: Json) =>
        `data: ${JSON.stringify({
          id: `chatcmpl-${requests.length}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "mock-model",
          ...value,
        })}\n\n`;
      const delta = (value: Json, finish: string | null = null) =>
        chunk({ choices: [{ index: 0, delta: value, finish_reason: finish }] });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        ("text" in answer
          ? delta({ role: "assistant", content: "" }) +
            delta({ content: answer.text }) +
            delta({}, "stop")
          : delta({
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: `call_${requests.length}`,
                  type: "function",
                  function: { name: answer.tool.name, arguments: "" },
                },
              ],
            }) +
            delta({
              tool_calls: [
                { index: 0, function: { arguments: JSON.stringify(answer.tool.arguments) } },
              ],
            }) +
            delta({}, "tool_calls")) +
          chunk({
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }) +
          "data: [DONE]\n\n",
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, requests };
}

/**
 * AgentKib's backend around a real DSH (`index.ts`): the background DSH, the bridge with its
 * Project Agents, the lanes and their reports. DSH's default preset here is full access, as a user
 * may have set it, and the loopback model is DSH's default model.
 */
async function sandbox(port: number) {
  const launcher = realpathSync(process.env.AGENTKIB_DSH_EXECUTABLE ?? DSH_LAUNCHER);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-dsh-native-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    dshHome = path.join(home, ".dsh"),
    workspace = path.join(root, "project"),
    bin = path.join(root, "bin"),
    temporary = path.join(root, "tmp"),
    agentkibHome = path.join(root, "agentkib-home"),
    data = path.join(root, "data");
  for (const directory of [
    path.join(dshHome, "profiles", "desktop"),
    workspace,
    bin,
    temporary,
    agentkibHome,
  ])
    mkdirSync(directory, { recursive: true });
  // DSH Desktop's settings, which AgentKib layers over the web profile.
  writeFileSync(
    path.join(dshHome, "profiles", "desktop", "cordis.patch.yml"),
    [
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      "      mock:",
      "        displayName: Mock",
      "        apiKeyEnv: MOCK_MODEL_KEY",
      "        api: openai-completions",
      `        baseURL: http://127.0.0.1:${port}/v1`,
      "        retryPolicy:",
      "          mode: normal",
      "          maxRetries: 0",
      "        models:",
      "          - id: mock-model",
      "            name: Mock Model",
      "            contextWindow: 128000",
      "          - id: mock-reasoning",
      "            name: Mock Reasoning",
      "            contextWindow: 128000",
      "            reasoningEfforts: { low: low, high: high }",
      "            compat: { supportsReasoningEffort: true }",
      "- id: agent-default-model",
      "  config:",
      "    provider: mock",
      "    model: mock-model",
      "- id: permission",
      "  config:",
      "    presets:",
      "      read-only: { sandbox: read-only, approval: ask }",
      "      workspace-write: { sandbox: workspace-write, approval: ask }",
      "      danger-full-access: { sandbox: danger-full-access, approval: never }",
      "    defaultPreset: danger-full-access",
      "",
    ].join("\n"),
  );
  // Loopback only: the provider, AgentKib's socket and DSH's own web port.
  const profile = path.join(root, "dsh-network.sb");
  writeFileSync(
    profile,
    '(version 1)(allow default)(deny network*)(allow network* (local ip "localhost:*"))' +
      '(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))\n',
  );
  const wrapper = path.join(bin, "dsh");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec /usr/bin/sandbox-exec -f '${profile}' '${launcher}' "$@"\n`,
  );
  chmodSync(wrapper, 0o700);
  const environment = {
    HOME: home,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: "1",
    PATH: `${bin}:/usr/bin:/bin`,
    TMPDIR: temporary,
    MOCK_MODEL_KEY: "sk-offline-fixture-not-a-key",
    AGENTKIB_DSH_LAUNCHER: wrapper,
  };

  let watch: DshLaneWatch | undefined;
  let leads: DshLeadWatch | undefined;
  let orchestration!: OrchestrationService;
  let bridge!: DshBridge;
  const runtime = new DshManagedRuntime({
    dataDir: data,
    agentkibHome,
    pluginDirectory: PLUGIN,
    env: environment,
    onExit: (pid) => bridge.managedExited(pid),
  });
  bridge = new DshBridge({
    dataDir: data,
    bootId: randomUUID(),
    pluginDirectory: PLUGIN,
    discoveryFile: path.join(agentkibHome, "dsh-bridge", "discovery-v1.json"),
    managed: { runtime, enabled: () => true },
    sessionId: (nativeId) => `ak-${nativeId}`,
    workspaceFor: (cwd) =>
      cwd === workspace || cwd.startsWith(`${workspace}${path.sep}`)
        ? { id: "w1", path: workspace }
        : null,
    workspacePath: (id) => (id === "w1" ? workspace : null),
    sessionsChanged: () => undefined,
    publish: (id, type, _payload, live) => {
      if (type === "state") {
        watch?.observe(id, live);
        leads?.observe(id, live);
      }
    },
    lead: {
      sessions: () =>
        orchestration.registry
          .list()
          .map((lead) => lead.sessionId)
          .filter((id) => bridge.handles(id)),
      tools: (id) => orchestration.leadToolSpecs(id),
      call: (id, name, input) => orchestration.call(id, name, input),
    },
  });
  bridge.initialize();
  cleanups.push(async () => {
    await bridge.close();
    await runtime.stop();
  });
  // What a new worker's preset took: read, changed, read back.
  const presetSteps: string[] = [];
  const lanes: LaneHost = {
    options: async () => ({ available: false }),
    dshOptions: () => bridge.createOptions(true),
    lifecycle: async ({ agent: _agent, ...value }) =>
      createDshWorker(
        {
          create: (request) => bridge.create(request),
          request: (request) => {
            presetSteps.push(String(request.operation));
            return bridge.request(request);
          },
          live: (id, controls) => bridge.live(id, controls),
        },
        value,
      ),
    control: (value) => bridge.request(value),
    live: async (sessionId) => bridge.live(sessionId, true),
    events: async (sessionId, limit) =>
      (await bridge.events(bridge.nativeId(sessionId)!, null, limit)).events as unknown as Json[],
    endedTurns: (sessionId) => bridge.endedTurns(sessionId),
    session: () => null,
    managed: async (sessionId) => bridge.handles(sessionId),
    workspaces: () => [{ id: "w1", name: "Project" }],
  };
  // A DSH Project Agent hears its reports as messages, as `index.ts` sends them.
  const leadReports = new MessageLeadReports({
    live: async (id) => bridge.live(id, true),
    control: async (value) => (await bridge.request(value)) as Json,
    queue: async (id) =>
      (await bridge.request({ operation: "queue-list", sessionId: id })) as { data?: Json[] },
  });
  const reports: string[] = [];
  orchestration = new OrchestrationService(
    path.join(root, "orchestration"),
    "boot-1",
    lanes,
    (id) => id === "lead-session" || bridge.leadCapable(id),
    async (lead, device, text) => {
      reports.push(text);
      return bridge.handles(lead) ? leadReports.send(lead, device, text) : false;
    },
  );
  cleanups.push(() => orchestration.close());
  watch = new DshLaneWatch({
    isLane: (id) => !!orchestration.registry.leadOfLane(id),
    endedTurns: (id) => bridge.endedTurns(id),
    turnEnded: (...args) => orchestration.laneTurnEnded(...args),
    waiting: (...args) => orchestration.laneWaiting(...args),
  });
  cleanups.push(() => watch?.close());
  // A lead's own turns count; past the limit the round stops (`index.ts`, `#leadOwnTurn`).
  leads = new DshLeadWatch({
    isLead: (id) => !!orchestration.status(id),
    turnOrigin: (id, turnId) => bridge.turnOrigin(id, turnId),
    userSpoke: (id) => orchestration.userSpoke(id),
    ownTurn: async (id, turnId) => {
      const status = orchestration.status(id);
      if (!status || orchestration.leadSelfTurn(id)) return;
      await haltOwnTurns(
        {
          live: async (session) => bridge.live(session, true),
          control: (value) => bridge.request(value),
        },
        id,
        turnId,
        status.deviceId,
        "deepseek-harness",
      );
    },
  });
  cleanups.push(() => leads?.close());
  const history = async (sessionId: string) =>
    (await bridge.events(bridge.nativeId(sessionId)!, null, 50)).events as unknown as Json[];
  return { bridge, runtime, orchestration, reports, presetSteps, history };
}

describe.skipIf(
  process.platform !== "darwin" || process.env.AGENTKIB_DSH_PROJECT_AGENT_NATIVE !== "1",
)("Project Agents and workers on a real DeepSeek Harness", () => {
  it("stops only the requested native turn and runs the retained queued prompt once", async () => {
    const firstPrompt = "active first prompt";
    const queuedPrompt = "queued second prompt";
    const wakePrompt = "start the next turn";
    const prompts = [firstPrompt, queuedPrompt, wakePrompt];
    const first = Promise.withResolvers<Answer>();
    const second = Promise.withResolvers<Answer>();
    const turnRequests: string[] = [];
    const model = await provider((body) => {
      // DSH can inject reminders after the user message and generate a title in a separate call.
      const prompt = (body.messages as Json[]).findLast(
        ({ role, content }) => role === "user" && prompts.includes(content),
      )?.content;
      if (!prompt) return { text: "Stop test" };
      turnRequests.push(prompt);
      if (prompt === wakePrompt) return { text: "NEW-PROMPT-COMPLETED" };
      return prompt === firstPrompt ? first.promise : second.promise;
    });
    const { bridge, history } = await sandbox(model.port);
    const created = await bridge.create({
      requestId: randomUUID(),
      deviceId: DEVICE,
      workspaceId: "w1",
    });
    expect(created).toMatchObject({ accepted: true });
    const sessionId = created.sessionId as string;
    const live = () => bridge.live(sessionId, true);
    const control = (operation: string, fields: Json) =>
      bridge.request({
        operation,
        sessionId,
        requestId: randomUUID(),
        deviceId: DEVICE,
        runtimeBootId: live().runtimeBootId,
        expectedRevision: live().revision,
        experimentalEnabled: true,
        ...fields,
      });

    await until(() => live().sendEnabled === true, 30_000);
    expect(await control("send", { text: firstPrompt })).toMatchObject({ accepted: true });
    await until(() => turnRequests.includes(firstPrompt) && live().turnId === "dsh-turn-1", 30_000);
    expect(live()).toMatchObject({ status: "running", stopEnabled: true });
    expect(await control("queue-add", { text: queuedPrompt })).toMatchObject({ accepted: true });
    await until(() => live().queuedCount === 1, 30_000);

    const target = "dsh-turn-1";
    expect(await control("stop", { turnId: target })).toMatchObject({
      accepted: true,
      turnId: target,
    });
    await until(() => live().status === "idle" && live().queuedCount === 1, 30_000);
    expect(await bridge.endedTurns(sessionId)).toMatchObject([
      { turnId: target, outcome: "cancelled" },
    ]);
    expect(turnRequests).toEqual([firstPrompt]);
    expect(await control("send", { text: wakePrompt })).toMatchObject({ accepted: true });
    await until(
      () => turnRequests.includes(queuedPrompt) && live().turnId === "dsh-turn-2",
      30_000,
    );
    expect(await control("stop", { turnId: target })).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "stale-turn",
    });
    expect(live()).toMatchObject({ status: "running", turnId: "dsh-turn-2" });
    first.resolve({ text: "FIRST-SHOULD-NOT-COMPLETE" });
    second.resolve({ text: "QUEUED-SECOND-COMPLETED" });
    await until(async () => (await bridge.endedTurns(sessionId)).length === 3, 30_000);
    await until(() => live().status === "idle", 30_000);
    expect(await bridge.endedTurns(sessionId)).toMatchObject([
      { turnId: target, outcome: "cancelled" },
      { turnId: "dsh-turn-2", outcome: "completed" },
      { turnId: "dsh-turn-3", outcome: "completed" },
    ]);
    expect(turnRequests).toEqual(prompts);
    expect(
      (await history(sessionId))
        .filter((event) => event.kind === "user-message")
        .map((event) => event.content),
    ).toEqual(prompts);
  }, 180_000);

  it("keeps the real native context count and capacity when DSH disconnects and the host restarts", async () => {
    const model = await provider();
    const { bridge, runtime } = await sandbox(model.port);
    const created = await bridge.create({
      requestId: randomUUID(),
      deviceId: DEVICE,
      workspaceId: "w1",
    });
    expect(created).toMatchObject({ accepted: true });
    const sessionId = created.sessionId as string;
    const nativeId = bridge.nativeId(sessionId)!;
    const live = bridge.live(sessionId, true);
    await bridge.request({ operation: "usage", sessionId });
    expect(
      await bridge.request({
        operation: "send",
        sessionId,
        requestId: randomUUID(),
        deviceId: DEVICE,
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        text: "Respond with one line.",
      }),
    ).toMatchObject({ accepted: true });
    const reading = await until(() => {
      const usage = bridge.live(sessionId, true).usage as Json;
      return usage.state === "ready" ? usage : undefined;
    }, 30_000);
    expect(reading.contextWindow).toBe(128000);
    expect(reading.usedTokens).toBeGreaterThanOrEqual(10);
    expect(reading.percent).toBeCloseTo((reading.usedTokens / 128000) * 100, 8);
    const delivered = () =>
      model.requests.filter((request) =>
        (request.messages as Json[]).some(
          (message) => message.role === "user" && message.content === "Respond with one line.",
        ),
      );
    expect(delivered()).toHaveLength(1);

    await runtime.stop();
    const cached = {
      available: true,
      state: "stale",
      historical: true,
      usedTokens: reading.usedTokens,
      contextWindow: 128000,
      updatedAt: reading.updatedAt,
    };
    await until(() => (bridge.live(sessionId, true).usage as Json).state === "stale", 10_000);
    expect(await bridge.request({ operation: "usage", sessionId })).toMatchObject(cached);

    await bridge.close();
    const restarted = new DshBridge({
      ...bridge.options,
      bootId: randomUUID(),
      managed: undefined,
    });
    cleanups.push(() => restarted.close());
    restarted.initialize();
    expect(restarted.nativeId(sessionId)).toBe(nativeId);
    expect(restarted.live(sessionId, true).usage).toMatchObject(cached);
    expect(await restarted.request({ operation: "usage", sessionId })).toMatchObject(cached);
    expect(delivered()).toHaveLength(1);
  }, 100_000);

  it("opens a DSH worker in workspace-write, sends it a task and reports its turn", async () => {
    const model = await provider();
    const { bridge, runtime, orchestration, reports, presetSteps } = await sandbox(model.port);
    const lead = "lead-session";
    orchestration.designate({ sessionId: lead, deviceId: DEVICE, workspaceId: "w1" });
    const call = async (name: string, input: Json) =>
      JSON.parse((await orchestration.call(lead, name, input)).text) as Json;

    // Listing workers does not start DSH.
    expect((await call("worker_list", {})).deepseekHarness).toEqual({ available: true });
    expect(runtime.phase).toBe("stopped");

    const opened = await call("worker_open", {
      name: "ds",
      agent: "deepseek-harness",
      workspace: "w1",
    });
    expect(opened).toMatchObject({ accepted: true, worker: "ds", agent: "deepseek-harness" });
    expect(runtime.phase).toBe("running");
    // DSH's default here is full access; the worker was moved to workspace-write.
    const settings = (await bridge.request({
      operation: "settings-state",
      sessionId: opened.session,
      experimentalEnabled: true,
    })) as Json;
    expect(settings.current.policyId).toBe("workspace-write");
    expect(presetSteps).toEqual(["settings-state", "settings", "settings-state"]);
    expect(
      ((await call("worker_list", {})).deepseekHarness.models as Json[]).map((entry) => entry.id),
    ).toContain("mock/mock-model");

    expect(
      await call("worker_send", {
        worker: "ds",
        text: "BRIEF-1: write the summary.",
        title: "Summary",
      }),
    ).toMatchObject({ accepted: true, operation: "send" });
    await until(() => reports.length > 0, 120_000);
    expect(reports[0]).toMatch(
      /^\[AgentKib report\] Worker "ds" \(DeepSeek Harness\) · turn ended: completed after \d+s\n/,
    );
    expect(reports[0]).toContain(REPLY);
    expect(JSON.stringify(model.requests)).toContain("BRIEF-1: write the summary.");
    expect(await call("worker_read", { worker: "ds" })).toMatchObject({
      status: "idle",
      title: "Summary",
      replies: [expect.objectContaining({ text: REPLY })],
    });
    // The catch-up reads the same history and reports nothing twice.
    await orchestration.catchUp(Date.now() + 60_000);
    expect(reports).toHaveLength(1);
  }, 240_000);

  it("lets a DSH session lead: it opens a DSH worker with its own tools and hears the report", async () => {
    // The lead calls worker_open, then worker_send, then answers; a report gets an answer too.
    const model = await provider((body) => {
      const tools = ((body.tools ?? []) as Json[]).map((tool) => tool.function?.name);
      const messages = body.messages as Json[];
      const last = messages.map((message) => message.role).lastIndexOf("user");
      const asked = JSON.stringify(messages[last]?.content ?? "");
      const results = messages.slice(last + 1).filter((message) => message.role === "tool").length;
      if (!tools.includes("worker_open")) return { text: REPLY };
      if (asked.includes("[AgentKib report]")) return { text: "LEAD-ACK" };
      if (results === 0)
        return {
          tool: {
            name: "worker_open",
            arguments: { name: "ds", agent: "deepseek-harness", workspace: "w1" },
          },
        };
      if (results === 1)
        return {
          tool: {
            name: "worker_send",
            arguments: { worker: "ds", text: "BRIEF-2: write the summary.", title: "Summary" },
          },
        };
      return { text: "LEAD-SENT" };
    });
    const { bridge, orchestration, reports, history } = await sandbox(model.port);
    // The lead: a new DSH session, made a Project Agent once its DSH can give it the tools.
    const created = await bridge.create({
      requestId: randomUUID(),
      deviceId: DEVICE,
      workspaceId: "w1",
    });
    expect(created).toMatchObject({ accepted: true });
    const lead = created.sessionId as string;
    await until(() => bridge.leadCapable(lead), 30_000);
    orchestration.designate({ sessionId: lead, deviceId: DEVICE, workspaceId: "w1" });
    bridge.leadChanged();

    // The person asks the lead to delegate.
    const live = bridge.live(lead, true);
    expect(
      await bridge.request({
        operation: "send",
        sessionId: lead,
        requestId: randomUUID(),
        deviceId: DEVICE,
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        text: "LEAD-PLAN: delegate the summary to a DeepSeek Harness worker.",
      }),
    ).toMatchObject({ accepted: true });

    // Its report comes back as a message, and the lead answers it.
    await until(async () => {
      const events = await history(lead);
      return events.some((event) => event.kind === "agent-message" && event.content === "LEAD-ACK");
    }, 150_000);
    const status = orchestration.status(lead)!;
    expect(status.lanes).toMatchObject([{ name: "ds", agent: "deepseek-harness" }]);
    expect(status.autoTurns).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(
      /^\[AgentKib report\] Worker "ds" \(DeepSeek Harness\) · turn ended: completed/,
    );
    const events = await history(lead);
    expect(
      events.some(
        (event) =>
          event.kind === "user-message" && String(event.content).startsWith("[AgentKib report]"),
      ),
    ).toBe(true);
    expect(
      events.some((event) => event.kind === "agent-message" && event.content === "LEAD-SENT"),
    ).toBe(true);
    // Only the lead's own agent had the worker tools: the worker's requests carried none.
    const named = (body: Json) => ((body.tools ?? []) as Json[]).map((tool) => tool.function?.name);
    const workerRequests = model.requests.filter((body) =>
      JSON.stringify(body.messages).includes("BRIEF-2: write the summary."),
    );
    const leadRequests = model.requests.filter((body) => named(body).includes("worker_open"));
    expect(workerRequests.length).toBeGreaterThan(0);
    expect(leadRequests.length).toBeGreaterThan(0);
    for (const body of workerRequests.filter((item) => !named(item).includes("worker_open")))
      expect(named(body).some((name) => String(name).startsWith("worker_"))).toBe(false);
    // The worker's own requests are the ones where BRIEF-2 is the user's message.
    expect(
      workerRequests.some(
        (body) =>
          !named(body).includes("worker_open") &&
          JSON.stringify((body.messages as Json[]).at(-1)).includes("BRIEF-2"),
      ),
    ).toBe(true);
  }, 300_000);
  it("counts a DSH lead's goal rounds, and at the limit stops the round; DSH pauses the goal", async () => {
    // A tool record lets the host classify the round as DSH-initiated while it is still active.
    // Hold the following model step until the host counts it or stops it at the limit.
    const rounds = Array.from({ length: 3 }, () => Promise.withResolvers<Answer>());
    let goalRequests = 0;
    const model = await provider((body) => {
      if (!body.tools?.length) return { text: REPLY };
      const step = goalRequests++;
      if (step % 2 === 0) return { tool: { name: "worker_list", arguments: {} } };
      return rounds[Math.floor(step / 2)]?.promise ?? { text: REPLY };
    });
    const { bridge, orchestration } = await sandbox(model.port);
    const created = await bridge.create({
      requestId: randomUUID(),
      deviceId: DEVICE,
      workspaceId: "w1",
    });
    expect(created).toMatchObject({ accepted: true });
    const lead = created.sessionId as string;
    await until(() => bridge.leadCapable(lead), 30_000);
    orchestration.designate({
      sessionId: lead,
      deviceId: DEVICE,
      workspaceId: "w1",
      scope: { maxAutoTurns: 2 },
    });
    bridge.leadChanged();
    // The person sets a goal; DSH goes on with it by itself, round after round.
    await until(() => bridge.live(lead, true).queueEditEnabled === true, 30_000);
    const live = bridge.live(lead, true);
    expect(
      await bridge.request({
        operation: "goal-set",
        sessionId: lead,
        requestId: randomUUID(),
        deviceId: DEVICE,
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        goal: { objective: "Keep checking the project." },
      }),
    ).toMatchObject({ accepted: true });
    for (let index = 0; index < 2; index++) {
      await until(() => (orchestration.status(lead)?.autoTurns ?? 0) > index, 30_000);
      rounds[index]!.resolve({ text: REPLY });
    }
    // Two rounds count; the next pauses delegation and is stopped, and DSH pauses its goal.
    await until(() => orchestration.status(lead)?.paused, 150_000);
    expect(orchestration.status(lead)).toMatchObject({ reason: "auto-turn-limit", autoTurns: 2 });
    await until(async () => {
      const state = (await bridge.request({ operation: "goal", sessionId: lead })) as Json;
      return state.goal?.status === "paused";
    }, 60_000);
    await until(() => bridge.live(lead, true).status === "idle", 60_000);
    const asked = model.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(model.requests.length).toBe(asked);
  }, 300_000);

  it("changes the model and effort of an existing session while preserving the profile default", async () => {
    const model = await provider();
    const { bridge } = await sandbox(model.port);
    const create = async () => {
      const result = await bridge.create({
        requestId: randomUUID(),
        deviceId: DEVICE,
        workspaceId: "w1",
      });
      expect(result).toMatchObject({ accepted: true });
      return String(result.sessionId);
    };
    const target = await create();
    const settings = (sessionId: string) =>
      bridge.request({ operation: "settings-state", sessionId });
    const control = (sessionId: string, operation: string, value: Json) => {
      const live = bridge.live(sessionId, true);
      return bridge.request({
        operation,
        sessionId,
        requestId: randomUUID(),
        deviceId: DEVICE,
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        ...value,
      });
    };
    const defaultSelection = { model: "mock/mock-model", effort: null };
    expect(await settings(target)).toMatchObject({ current: defaultSelection });
    expect(
      await control(target, "settings", { model: "mock/mock-reasoning", effort: "low" }),
    ).toMatchObject({ accepted: true });
    expect(await settings(target)).toMatchObject({
      current: { model: "mock/mock-reasoning", effort: "low" },
      defaults: defaultSelection,
    });
    expect(await control(target, "settings", { effort: "high" })).toMatchObject({ accepted: true });
    expect(await settings(target)).toMatchObject({
      current: { model: "mock/mock-reasoning", effort: "high" },
      defaults: defaultSelection,
    });
    expect(model.requests).toHaveLength(0);

    const next = await create();
    expect(await settings(next)).toMatchObject({ current: defaultSelection });
    // Ignore the separate title request and reminders injected after the user's message.
    const sentPrompt = (request: Json, prompt: string) =>
      (request.messages as Json[]).some(
        ({ role, content }) => role === "user" && content === prompt,
      );
    expect(await control(target, "send", { text: "SESSION-MODEL-CHECK" })).toMatchObject({
      accepted: true,
    });
    const sent = await until(
      () => model.requests.find((request) => sentPrompt(request, "SESSION-MODEL-CHECK")),
      15_000,
    );
    expect(sent).toMatchObject({ model: "mock-reasoning", reasoning_effort: "high" });
    expect(await control(next, "send", { text: "PROFILE-DEFAULT-CHECK" })).toMatchObject({
      accepted: true,
    });
    const untouched = await until(
      () => model.requests.find((request) => sentPrompt(request, "PROFILE-DEFAULT-CHECK")),
      15_000,
    );
    expect(untouched.model).toBe("mock-model");
    expect(untouched).not.toHaveProperty("reasoning_effort");
  }, 60_000);
});
