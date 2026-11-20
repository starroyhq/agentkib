// @vitest-environment node
// Opt in on macOS with AGENTKIB_CODEX_WORKER_NATIVE=1 (AGENTKIB_CODEX_EXECUTABLE for a CLI other
// than /opt/homebrew/bin/codex). A Project Agent's worker is a real Codex CLI that AgentKib runs
// (`web-read.ts`), against a loopback Responses provider, logged in with a fake API key in a
// throwaway HOME, and confined by sandbox-exec to loopback. No account or user data is read.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

/** A Responses provider that answers every turn with one message, and records what it got. */
async function provider() {
  const inputs: string[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      if (request.method !== "POST" || !request.url?.includes("/responses")) {
        response.writeHead(404);
        response.end();
        return;
      }
      inputs.push(raw);
      const event = (type: string, data: Json) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        event("response.created", { response: { id: "resp_worker" } }) +
          event("response.output_item.done", {
            item: {
              type: "message",
              role: "assistant",
              id: "msg_worker",
              content: [{ type: "output_text", text: "WORKER-DONE: summary written." }],
            },
          }) +
          event("response.completed", {
            response: {
              id: "resp_worker",
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
  return { port: (server.address() as AddressInfo).port, inputs };
}

describe.skipIf(process.platform !== "darwin" || process.env.AGENTKIB_CODEX_WORKER_NATIVE !== "1")(
  "a Project Agent's worker on the real Codex CLI",
  () => {
    it("assigns an existing worker, sends it a task and reports its turn with its reply and time", async () => {
      const codex = realpathSync(
        process.env.AGENTKIB_CODEX_EXECUTABLE ?? "/opt/homebrew/bin/codex",
      );
      const model = await provider();
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-codex-worker-")));
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
      // Loopback only: the provider, and the CLI's own local sockets.
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
      const login = spawnSync(wrapper, ["login", "--with-api-key"], {
        env: environment,
        input: "sk-offline-fixture-not-a-key\n",
      });
      expect(login.status).toBe(0);
      expect(existsSync(path.join(codexHome, "auth.json"))).toBe(true);

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
      // The AgentKib the lanes go through; a later one stands in after a restart.
      let reader = web;
      // What AgentKib's backend gives the orchestration service (`index.ts`, `#laneHost`).
      const created = await reader.managedLifecycle({
        operation: "create",
        requestId: crypto.randomUUID(),
        deviceId: "desktop-local",
        workspaceId: "w1",
        policyId: "workspace-write-on-request",
      });
      expect(created).toMatchObject({ accepted: true, sessionId: expect.any(String) });
      const workerSessionId = String(created.sessionId);
      const lanes: LaneHost = {
        control: (value) => reader.managedControl(value),
        live: (sessionId) =>
          reader.request({
            operation: "live",
            sessionId,
            experimentalEnabled: true,
          }) as Promise<Json>,
        events: async (sessionId, limit) =>
          (
            (await reader.request({
              operation: "events",
              sessionId,
              limit,
              retainCursor: false,
            })) as {
              events?: Json[];
            }
          ).events ?? [],
        endedTurns: async (sessionId) => reader.endedTurns(sessionId),
        session: (sessionId) =>
          sessionId === workerSessionId ? { agent: "codex", workspaceId: "w1", title: null } : null,
        managed: async (sessionId) => reader.isManagedSession(sessionId),
        workspaces: () => [{ id: "w1", name: "Project" }],
      };
      const reports: string[] = [];
      const lead = "lead-session";
      const orchestration = new OrchestrationService(
        path.join(root, "data"),
        "boot",
        lanes,
        (id) => id === lead,
        (_lead, _device, text) => {
          reports.push(text);
          return false;
        },
      );
      cleanups.push(() => orchestration.close());
      web.observeLanes({
        turnEnded: (sessionId, turnId, outcome, durationMs) =>
          void orchestration.laneTurnEnded(sessionId, turnId, outcome, durationMs),
        waiting: (sessionId, turnId, status) =>
          void orchestration.laneWaiting(sessionId, turnId, status),
      });
      await orchestration.assignWorkers({
        sessionId: lead,
        deviceId: "desktop-local",
        workspaceId: "w1",
        workers: [workerSessionId],
      });
      const call = async (name: string, input: Json) =>
        JSON.parse((await orchestration.call(lead, name, input)).text) as Json;
      const wait = { timeout: 60_000, interval: 200 };

      await expect
        .poll(async () => (await lanes.live(workerSessionId)).sendEnabled, wait)
        .toBe(true);
      const sent = await call("worker_send", {
        worker: "worker-1",
        text: "BRIEF: write the summary into notes.md",
        title: "Summary",
      });
      expect(sent).toMatchObject({ accepted: true, operation: "send" });
      await expect.poll(() => reports.length, wait).toBe(1);
      expect(reports[0]).toMatch(
        /^\[AgentKib report\] Worker "worker-1" \(Codex\) · turn ended: completed after \d+s\n/,
      );
      expect(reports[0]).toContain("WORKER-DONE: summary written.");
      expect(model.inputs.some((input) => input.includes("BRIEF: write the summary"))).toBe(true);
      const read = await call("worker_read", { worker: "worker-1" });
      expect(read).toMatchObject({ worker: "worker-1", status: "idle", title: "Summary" });
      expect(JSON.stringify(read.replies)).toContain("WORKER-DONE");
      const listed = await call("worker_list", {});
      expect(listed.workers).toMatchObject([
        {
          worker: "worker-1",
          status: "idle",
          title: "Summary",
          lastReport: { preview: expect.any(String) },
        },
      ]);

      // Codex's rollout records that turn under the ID the live report used: never told twice.
      const [recorded] = await lanes.endedTurns!(workerSessionId);
      expect(orchestration.status(lead)!.lanes[0]!.reportedTurns).toContain(recorded!.turnId);
      await orchestration.catchUp(Date.now() + 60_000);
      expect(reports).toHaveLength(1);

      // AgentKib stops watching, and the Codex CLI runs a turn of the worker by itself: the
      // Project Agent hears of it late, once.
      await web.closeAsync();
      reader = new WebReadRequests(store, readers, root, () => 0n, environment);
      cleanups.push(() => reader.closeAsync());
      // Not spawnSync: the provider answering it runs in this process.
      const resumed = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(
          wrapper,
          ["exec", "--skip-git-repo-check", "resume", "--last", "BRIEF-2: add a second line"],
          { env: environment, cwd: workspace, stdio: ["ignore", "ignore", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        const timer = setTimeout(() => child.kill("SIGTERM"), 90_000);
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve({ code, stderr });
        });
      });
      expect(resumed.code, resumed.stderr.slice(-2000)).toBe(0);
      expect(model.inputs.some((input) => input.includes("BRIEF-2"))).toBe(true);
      await orchestration.catchUp(Date.now() + 60_000);
      await orchestration.catchUp(Date.now() + 60_000);
      expect(reports).toHaveLength(2);
      expect(reports[1]).toMatch(
        /^\[AgentKib report\] Worker "worker-1" \(Codex\) · turn ended: completed after \d+s\n/,
      );
    }, 180_000);
  },
);
