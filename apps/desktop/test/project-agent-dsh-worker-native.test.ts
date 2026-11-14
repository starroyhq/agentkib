// @vitest-environment node
// Opt in on macOS with AGENTKIB_DSH_WORKER_NATIVE=1 (AGENTKIB_DSH_EXECUTABLE for a launcher other
// than DSH Desktop's). A Project Agent's worker is a real DeepSeek Harness that AgentKib starts in
// the background (`DshManagedRuntime`) with AgentKib's plugin, against a loopback chat-completions
// provider with a fake key, in a throwaway HOME and DSH data directory, confined by sandbox-exec to
// loopback. No account or user data is read.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DshBridge } from "../../../packages/backend/src/dsh-bridge";
import { createDshWorker, DshLaneWatch } from "../../../packages/backend/src/dsh-lanes";
import { DshManagedRuntime } from "../../../packages/backend/src/dsh-managed-runtime";
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

/** An OpenAI-style chat-completions provider that answers every request with one message. */
async function provider() {
  const requests: Json[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      if (request.method !== "POST" || !request.url?.includes("/chat/completions")) {
        response.writeHead(404);
        response.end();
        return;
      }
      requests.push(JSON.parse(raw));
      const chunk = (value: Json) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-worker",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock-model",
          ...value,
        })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }) +
          chunk({ choices: [{ index: 0, delta: { content: REPLY } }] }) +
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
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

describe.skipIf(process.platform !== "darwin" || process.env.AGENTKIB_DSH_WORKER_NATIVE !== "1")(
  "a Project Agent's worker on a real DeepSeek Harness",
  () => {
    it("opens a DSH worker in workspace-write, sends it a task and reports its turn", async () => {
      const launcher = realpathSync(process.env.AGENTKIB_DSH_EXECUTABLE ?? DSH_LAUNCHER);
      const model = await provider();
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-dsh-worker-")));
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
      // DSH Desktop's settings, which AgentKib layers over the web profile: the loopback model as
      // the default, and full access as the default preset, as a user may have set it.
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
          `        baseURL: http://127.0.0.1:${model.port}/v1`,
          "        retryPolicy:",
          "          mode: normal",
          "          maxRetries: 0",
          "        models:",
          "          - id: mock-model",
          "            name: Mock Model",
          "            contextWindow: 128000",
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

      // What AgentKib's backend sets up (`index.ts`): the background DSH, the bridge, the lanes.
      let watch: DshLaneWatch | undefined;
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
          if (type === "state") watch?.observe(id, live);
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
        dshOptions: () => bridge.createOptions(true, { start: false }),
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
          (await bridge.events(bridge.nativeId(sessionId)!, null, limit))
            .events as unknown as Json[],
        endedTurns: (sessionId) => bridge.endedTurns(sessionId),
        session: () => null,
        managed: async (sessionId) => bridge.handles(sessionId),
        workspaces: () => [{ id: "w1", name: "Project" }],
      };
      const reports: string[] = [];
      const lead = "lead-session";
      const orchestration = new OrchestrationService(
        path.join(root, "orchestration"),
        "boot-1",
        lanes,
        (id) => id === lead,
        (_lead, _device, text) => {
          reports.push(text);
          return false;
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
      orchestration.designate({ sessionId: lead, deviceId: "desktop-local", workspaceId: "w1" });
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
  },
);
