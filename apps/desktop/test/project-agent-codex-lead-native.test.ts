// @vitest-environment node
// Opt in on macOS with AGENTKIB_CODEX_WORKER_NATIVE=1 (AGENTKIB_CODEX_EXECUTABLE for a CLI other
// than /opt/homebrew/bin/codex). A Codex session AgentKib runs is the Project Agent: its thread
// gets the worker tools as an MCP server in its configuration, it opens and briefs a worker (a
// second Codex session) through them, and the worker's report comes back as a turn of its own.
// Both are the real Codex CLI against a loopback Responses provider, logged in with a fake API key
// in a throwaway HOME and confined by sandbox-exec to loopback. No account or user data is read.
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexLeadReports } from "../../../packages/backend/src/codex-lead-reports";
import { Commands } from "../../../packages/backend/src/commands";
import type { CursorBridge } from "../../../packages/backend/src/cursor-bridge";
import {
  OrchestrationService,
  type LaneHost,
} from "../../../packages/backend/src/orchestration-service";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";
import { WebReadRequests } from "../../../packages/backend/src/web-read";

type Json = Record<string, any>;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The text of the last message the person (or AgentKib) sent in a Responses input. */
function lastUser(input: Json[]): { text: string; answered: boolean } {
  let index = -1;
  input.forEach((item, at) => {
    if (item.type === "message" && item.role === "user") index = at;
  });
  const item = input[index];
  const text = Array.isArray(item?.content)
    ? item.content.map((part: Json) => String(part.text ?? "")).join("\n")
    : String(item?.content ?? "");
  const answered = input
    .slice(index + 1)
    .some((later) => later.type === "custom_tool_call_output");
  return { text, answered };
}

/**
 * A model that plays both parts. The lead calls its worker tools from `exec` (Codex 0.167.0 gives
 * MCP tools to the model as a deferred namespace reached from code), the worker answers its brief.
 */
async function provider() {
  const asked: string[] = [];
  const outputs: string[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      if (request.method !== "POST" || !request.url?.includes("/responses")) {
        response.writeHead(404);
        response.end();
        return;
      }
      const input: Json[] = JSON.parse(raw).input ?? [];
      const { text, answered } = lastUser(input);
      asked.push(text);
      for (const item of input)
        if (item.type === "custom_tool_call_output") outputs.push(JSON.stringify(item.output));
      const exec = (code: string) => ({
        type: "custom_tool_call",
        id: `ctc_${randomUUID().slice(0, 8)}`,
        call_id: `call_${randomUUID().slice(0, 8)}`,
        name: "exec",
        input: code,
      });
      const say = (words: string) => ({
        type: "message",
        role: "assistant",
        id: `msg_${randomUUID().slice(0, 8)}`,
        content: [{ type: "output_text", text: words }],
      });
      const item =
        text.includes("LEAD-PLAN") && !answered
          ? exec(
              'const opened = await tools.mcp__agentkib_workers__worker_open({ name: "api", workspace: "w1" });\ntext(JSON.stringify(opened));',
            )
          : text.includes("LEAD-SEND") && !answered
            ? exec(
                'const sent = await tools.mcp__agentkib_workers__worker_send({ worker: "api", text: "BRIEF: write the summary", title: "Summary" });\ntext(JSON.stringify(sent));',
              )
            : text.includes("[AgentKib report]")
              ? say("LEAD-NOTED")
              : text.includes("BRIEF:")
                ? say("WORKER-DONE: summary written.")
                : say("lead ok");
      const event = (type: string, data: Json) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        event("response.created", { response: { id: "resp_lead" } }) +
          event("response.output_item.done", { item }) +
          event("response.completed", {
            response: {
              id: "resp_lead",
              usage: {
                input_tokens: 10,
                input_tokens_details: null,
                output_tokens: 5,
                output_tokens_details: null,
                total_tokens: 15,
              },
            },
          }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, asked, outputs };
}

describe.skipIf(process.platform !== "darwin" || process.env.AGENTKIB_CODEX_WORKER_NATIVE !== "1")(
  "a Codex session as a Project Agent, on the real Codex CLI",
  () => {
    it("opens and briefs a worker through its tools, and takes the worker's report as a turn", async () => {
      const codex = realpathSync(
        process.env.AGENTKIB_CODEX_EXECUTABLE ?? "/opt/homebrew/bin/codex",
      );
      const model = await provider();
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-codex-lead-")));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const home = path.join(root, "home"),
        codexHome = path.join(home, ".codex"),
        workspace = path.join(root, "project"),
        bin = path.join(root, "bin"),
        temporary = path.join(root, "tmp");
      for (const directory of [codexHome, workspace, bin, temporary])
        mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(codexHome, "config.toml"),
        [
          'model_provider = "mock"',
          "check_for_update_on_startup = false",
          'web_search = "disabled"',
          "",
          "[model_providers.mock]",
          'name = "mock"',
          `base_url = "http://127.0.0.1:${model.port}/v1"`,
          'wire_api = "responses"',
          "requires_openai_auth = true",
          "supports_websockets = false",
          "",
        ].join("\n"),
      );
      // Loopback only: the provider, AgentKib's worker endpoint and the CLI's own sockets.
      const profile = path.join(root, "codex-network.sb");
      writeFileSync(
        profile,
        '(version 1)(allow default)(deny network*)(allow network* (local ip "localhost:*"))' +
          '(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))\n',
      );
      const wrapper = path.join(bin, "codex");
      writeFileSync(
        wrapper,
        `#!/bin/sh\nexec /usr/bin/sandbox-exec -f '${profile}' '${codex}' "$@"\n`,
      );
      chmodSync(wrapper, 0o700);
      const environment = {
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        PATH: `${bin}:/usr/bin:/bin`,
        TMPDIR: temporary,
      };
      expect(
        spawnSync(wrapper, ["login", "--with-api-key"], {
          env: environment,
          input: "sk-offline-fixture-not-a-key\n",
        }).status,
      ).toBe(0);

      const store = new BackendStore(path.join(root, "agentkib.db"));
      cleanups.push(() => store.close());
      store.sql.run(
        "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
        "w1",
        workspace,
        "Project",
        "healthy",
        new Date().toISOString(),
      );
      const commands = new Commands();
      cleanups.push(() => commands.close());
      const readers = new SessionReaders(store.sessions, commands, environment, {} as CursorBridge);
      cleanups.push(() => readers.close());
      const web = new WebReadRequests(store, readers, root, () => 0n, environment);
      cleanups.push(() => web.closeAsync());
      // What AgentKib's backend wires (`index.ts`): the lane host, the Codex lead's reports and
      // its thread's worker tools.
      const lanes: LaneHost = {
        options: () => web.managedOptions() as Promise<Record<string, unknown>>,
        lifecycle: (value) => web.managedLifecycle(value),
        control: (value) => web.managedControl(value),
        live: (sessionId) =>
          web.request({ operation: "live", sessionId, experimentalEnabled: true }) as Promise<Json>,
        events: async (sessionId, limit) =>
          (
            (await web.request({ operation: "events", sessionId, limit, retainCursor: false })) as {
              events?: Json[];
            }
          ).events ?? [],
        session: () => null,
        managed: async (sessionId) => web.isManagedSession(sessionId),
        workspaces: () => [{ id: "w1", name: "Project" }],
      };
      const reports = new CodexLeadReports({
        live: (sessionId) => lanes.live(sessionId),
        control: (value) => web.managedControl(value) as Promise<Json>,
        queue: (sessionId) => web.managedQueueList({ sessionId, limit: 100 }) as Promise<Json>,
      });
      const orchestration = new OrchestrationService(
        path.join(root, "data"),
        "boot",
        lanes,
        (id) => web.codexLeadCapable(id),
        (id, device, text) => reports.send(id, device, text),
      );
      cleanups.push(() => orchestration.close());
      web.leadEndpoints(async (sessionId) => {
        const config = (await orchestration.leadTools(sessionId)) as Json | null;
        return config?.mcpServers?.agentkib_workers?.url ?? null;
      });
      web.observeLanes({
        turnEnded: (sessionId, turnId, outcome, durationMs) =>
          void orchestration.laneTurnEnded(sessionId, turnId, outcome, durationMs),
        waiting: (sessionId, turnId, status) =>
          void orchestration.laneWaiting(sessionId, turnId, status),
      });
      const wait = { timeout: 60_000, interval: 200 };

      // The lead: a Codex session AgentKib creates and runs.
      const created = randomUUID();
      await web.managedLifecycle({
        operation: "create",
        requestId: created,
        deviceId: "desktop-local",
        workspaceId: "w1",
        policyId: "workspace-write-on-request",
      });
      const lead = createHash("sha256").update(`managed:${created}`).digest("hex");
      await expect.poll(async () => (await lanes.live(lead)).sendEnabled, wait).toBe(true);
      expect(web.codexLeadCapable(lead)).toBe(true);
      orchestration.designate({ sessionId: lead, deviceId: "desktop-local", workspaceId: "w1" });
      // Codex has not written a thread without a turn, so it cannot be restarted yet: the first
      // turn goes without the worker tools, and the thread starts again with them after it.
      await web.restartManagedRunner(lead);
      expect(web.runnerHasLeadTools(lead)).toBe(false);
      const say = async (text: string) => {
        const live = await lanes.live(lead);
        return web.managedControl({
          operation: "send",
          sessionId: lead,
          requestId: randomUUID(),
          deviceId: "desktop-local",
          runtimeBootId: live.runtimeBootId,
          expectedRevision: live.revision,
          experimentalEnabled: true,
          text,
        });
      };

      expect(await say("LEAD-HELLO")).toMatchObject({ accepted: true });
      await expect.poll(() => web.runnerHasLeadTools(lead), wait).toBeNull();
      const planned = await say("LEAD-PLAN: open a worker named api");
      expect(web.runnerHasLeadTools(lead)).toBe(true);
      expect(planned, JSON.stringify({ planned, live: await lanes.live(lead) })).toMatchObject({
        accepted: true,
      });
      await expect.poll(() => orchestration.status(lead)?.lanes.length, wait).toBe(1);
      const worker = orchestration.status(lead)!.lanes[0]!.sessionId;
      await expect.poll(async () => (await lanes.live(lead)).status, wait).toBe("idle");
      await expect.poll(async () => (await lanes.live(worker)).sendEnabled, wait).toBe(true);
      // The tool's answer, as the lead's code got it back (encoded twice on the way).
      expect(
        model.outputs.some((output) => /accepted\W*:true/.test(output) && output.includes("api")),
      ).toBe(true);

      expect(await say("LEAD-SEND: brief the worker")).toMatchObject({ accepted: true });
      // The worker did the work, and its report reached the lead as a turn of its own.
      await expect
        .poll(
          () =>
            model.asked.some((text) =>
              text.startsWith('[AgentKib report] Worker "api" (Codex) · turn ended: completed'),
            ),
          wait,
        )
        .toBe(true);
      expect(model.asked.some((text) => text.includes("BRIEF: write the summary"))).toBe(true);
      await expect.poll(async () => (await lanes.live(lead)).status, wait).toBe("idle");
      expect(orchestration.status(lead)).toMatchObject({ paused: false, autoTurns: 1 });
      // Its worker tools ran without asking anyone.
      expect((await lanes.live(lead)).approvals ?? []).toEqual([]);
    }, 240_000);
  },
);
