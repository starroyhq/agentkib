// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeScriptBackend } from "../../../packages/backend/src/index";
import { BackendStore } from "../../../packages/backend/src/store";
import { McpHub } from "../../../packages/backend/src/mcp-hub";
import { RemoteAgent } from "../../../packages/backend/src/remote-agent";
import { Commands } from "../../../packages/backend/src/commands";
import { WebAccessService, createWebControlState } from "../electron/main/web/service";
import {
  CLAUDE_BRIDGE_PATHS,
  type ClaudeBridgeCommand,
  type ClaudeBridgeConnection,
  type ClaudeBridgeSnapshot,
  type ClaudeBridgeTicket,
} from "@agentkib/runtime-protocol";

interface HttpResult<T> {
  status: number;
  body: T;
  cookies?: string[];
}
interface LiveState {
  executionMode: string;
  status: string;
  revision: number;
  runtimeBootId: string;
  sendEnabled: boolean;
  stopEnabled: boolean;
  turnId?: string;
}

describe.skipIf(process.platform !== "darwin")(
  "real Backend and Web original Claude bridge",
  () => {
    let directory: string;
    let backend: TypeScriptBackend;
    let service: WebAccessService;
    let port: number;
    let sessionId: string;
    let nativeId: string;
    let workspace: string;
    let source: string;
    let sourceBytes: string;
    let cookie = "";
    let csrf = "";
    let bootId = "";
    let deviceId: string;
    let ticket: ClaudeBridgeTicket;
    let binding: ClaudeBridgeConnection;
    let instanceId: string;
    let seq: number;
    let snapshot: ClaudeBridgeSnapshot;
    let received: ClaudeBridgeCommand[];
    const processScans: Array<Parameters<Commands["run"]>[2]> = [];

    async function rpc<T>(method: string, params: unknown = {}): Promise<T> {
      const reply = await backend.handleAsync({ jsonrpc: "2.0", id: randomUUID(), method, params });
      if (reply.error) throw new Error(JSON.stringify(reply.error));
      return reply.result as T;
    }
    function http<T>(
      path: string,
      body?: Record<string, unknown>,
      identity = cookie,
    ): Promise<HttpResult<T>> {
      return new Promise((resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            path: `/api/web/v1${path}`,
            method: body ? "POST" : "GET",
            headers: {
              Connection: "close",
              ...(identity ? { Cookie: identity } : {}),
              ...(body
                ? {
                    "Content-Type": "application/json",
                    Origin: `http://127.0.0.1:${port}`,
                    "X-CSRF-Token": csrf,
                    "X-AgentKib-Protocol": "2",
                  }
                : {}),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("end", () =>
              resolve({
                status: response.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString()) as T,
                cookies: response.headers["set-cookie"],
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
    }
    function plugin<T>(path: string, body: unknown, authenticated = true): Promise<HttpResult<T>> {
      return new Promise((resolve, reject) => {
        const req = request(
          {
            socketPath: ticket.socketPath,
            path,
            method: "POST",
            headers: {
              Host: "localhost",
              "Content-Type": "application/json",
              Connection: "close",
              ...(authenticated ? { Authorization: `Bearer ${binding.token}` } : {}),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("end", () =>
              resolve({
                status: response.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString()) as T,
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(body));
      });
    }
    const lease = () => ({
      bindingId: binding.bindingId,
      leaseId: binding.leaseId,
      nativeId,
      cwd: workspace,
      instanceId,
    });
    async function events(event: Record<string, unknown>) {
      const result = await plugin(CLAUDE_BRIDGE_PATHS.events, {
        ...lease(),
        events: [{ seq: ++seq, event }],
      });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
    }
    async function connect() {
      const result = await rpc<{ challenge: string }>("claude.managed", {
        operation: "bridge-challenge",
        sessionId,
        deviceId: "agentkib-local-owner",
      });
      ticket = JSON.parse(
        Buffer.from(result.challenge, "base64url").toString(),
      ) as ClaudeBridgeTicket;
      instanceId = randomUUID();
      const identity = {
        protocol: 1,
        nativeId,
        cwd: workspace,
        cliVersion: "2.1.301",
        pluginVersion: "0.3.0",
        nativeCapabilities: {
          version: 1 as const,
          available: [
            "session-identity",
            "session-messages",
            "session-usage",
            "credential-store",
            "credential-read",
          ],
        },
        instanceId,
      };
      const paired = await plugin<ClaudeBridgeConnection>(
        CLAUDE_BRIDGE_PATHS.pair,
        { ...identity, ticket: ticket.ticket },
        false,
      );
      expect(paired.status).toBe(200);
      binding = paired.body;
      snapshot = {
        ...identity,
        protocol: 1,
        cliVersion: "2.1.301",
        pluginVersion: "0.3.0",
        nativeCapabilities: {
          version: 1 as const,
          available: [
            "session-identity",
            "session-messages",
            "session-usage",
            "credential-store",
            "credential-read",
          ],
        },
        revision: 1,
        currentTurnId: null,
        status: "idle",
        waiting: null,
        messages: [{ role: "user", text: "Synthetic original history" }],
        toolItems: [],
        streamText: "",
        usage: null,
        capabilities: { read: true, send: true, stop: true, approve: false, answer: false },
      };
      seq = 0;
      await events({ type: "snapshot", snapshot });
    }
    async function live() {
      const result = await http<LiveState>(`/live?sessionId=${sessionId}`);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      return result.body;
    }
    async function commands(waitMs = 0) {
      const result = await plugin<{ commands: ClaudeBridgeCommand[] }>(
        CLAUDE_BRIDGE_PATHS.commands,
        { ...lease(), afterCommandId: null, waitMs },
      );
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      received.push(...result.body.commands);
      return result.body.commands;
    }
    async function accept(command: ClaudeBridgeCommand, turnId: string, revision: number) {
      const result = await plugin(CLAUDE_BRIDGE_PATHS.results, {
        ...lease(),
        commandId: command.commandId,
        status: "accepted",
        turnId,
        revision,
      });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
    }
    beforeEach(async () => {
      processScans.length = 0;
      const run = Commands.prototype.run;
      vi.spyOn(Commands.prototype, "run").mockImplementation(
        function (this: Commands, program, args, options) {
          if (
            program === "/bin/ps" &&
            args.length === 2 &&
            args[0] === "-axo" &&
            args[1] === "pid=,pgid=,lstart=,command="
          ) {
            // This fixture starts no execution worker. A global process scan can exceed
            // its test budget during startup or exit; ownership parsing has separate tests.
            processScans.push(options);
            return Promise.resolve({
              success: true,
              bytes: Buffer.alloc(0),
              error: "",
              truncated: false,
              exitCode: 0,
            });
          }
          return run.call(this, program, args, options);
        },
      );
      directory = realpathSync(mkdtempSync(join(tmpdir(), "ak-claude-bridge-runtime-")));
      const data = join(directory, "data");
      workspace = join(directory, "workspace");
      const home = join(directory, "home");
      const history = join(home, ".claude", "projects", "synthetic");
      const bin = join(directory, "bin");
      for (const value of [data, workspace, home, history, bin, join(directory, "host")])
        mkdirSync(value, { recursive: true });
      nativeId = randomUUID();
      source = join(history, `${nativeId}.jsonl`);
      sourceBytes =
        JSON.stringify({
          type: "user",
          uuid: randomUUID(),
          parentUuid: null,
          sessionId: nativeId,
          cwd: workspace,
          timestamp: "2026-10-16T00:00:00Z",
          message: { role: "user", content: "Synthetic original history" },
        }) + "\n";
      writeFileSync(source, sourceBytes);
      writeFileSync(
        join(bin, "claude"),
        `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(join(directory, "unexpected-cli"))}, JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[2]==='--version'){console.log('2.1.301 (Claude Code)');process.exit(0);}if(process.argv[2]==='agents'&&process.argv[3]==='--json'){console.log('[]');process.exit(0);}process.exit(99);\n`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(data, "preferences.json"),
        JSON.stringify({ session_index_enabled: true, session_content_search_enabled: false }),
      );
      const store = new BackendStore(join(data, "agentkib.db"));
      store.sql.run(
        "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
        "workspace",
        workspace,
        "Isolated",
        "healthy",
        "2026-10-16T00:00:00Z",
      );
      store.sessions.sync("workspace", "claude-code", [
        {
          native_ref: nativeId,
          agent: "claude-code",
          title: "Bridge fixture",
          created_at: "2026-10-16T00:00:00Z",
          updated_at: "2026-10-16T00:00:00Z",
          message_count: 1,
          git_branch: null,
          archived: false,
          sidechain: false,
          availability: "readable",
          origin: "interactive",
        },
      ]);
      sessionId = store.sessions.id("claude-code", nativeId);
      store.close();
      vi.spyOn(McpHub.prototype, "start").mockResolvedValue();
      vi.spyOn(RemoteAgent.prototype, "start").mockResolvedValue();
      backend = new TypeScriptBackend({
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CODEX_HOME: join(home, ".codex"),
        PATH: bin,
        AGENTKIB_CLAUDE_PLUGIN_DIR: join(directory, "plugin"),
      });
      await rpc("backend.initialize", { dataDir: data });
      const listener = createServer();
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      port = (listener.address() as { port: number }).port;
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      const shared = createWebControlState();
      service = new WebAccessService({
        dataDir: join(directory, "host"),
        staticDir: directory,
        desktopOrigin: "app://bundle",
        runtimeRequest: (params) => rpc("web.request", params),
        claudeManagedRequest: (params) => rpc("claude.managed", params),
        managedRequest: (params) => rpc("codex.managed", params),
        receiptRequest: (params) => rpc("control.receipt", params),
        workspaceRequest: async () => [{ id: "workspace", name: "Isolated", path: workspace }],
        verifiedClaudeManaged: true,
        enableClaudeScheduler: true,
        sharedControl: shared,
      });
      await service.initialize();
      clearInterval(
        (shared.claudeScheduler as unknown as { timer?: ReturnType<typeof setInterval> }).timer,
      );
      await service.request({
        operation: "configure",
        enabled: true,
        port,
        externalOrigin: "",
        experimentalEnabled: true,
        allowedWorkspaceIds: ["workspace"],
      });
      cookie = csrf = bootId = "";
      const access = await http<{ csrfToken: string; bootId: string }>("/access");
      cookie = access.cookies![0]!.split(";")[0]!;
      csrf = access.body.csrfToken;
      bootId = access.body.bootId;
      const code = (await service.request({ operation: "generate-code", access: "full" })).code!
        .value;
      const paired = await http<{ device: { id: string } }>("/pair", {
        code,
        name: "Bridge test phone",
      });
      expect(paired.status).toBe(200);
      deviceId = paired.body.device.id;
      received = [];
    });
    afterEach(async () => {
      // A timed-out hook can finish after the next fixture has replaced these bindings.
      const fixture = { service, backend, directory, source, sourceBytes };
      vi.restoreAllMocks();
      try {
        await fixture.service?.dispose();
        await fixture.backend?.close();
        if (fixture.source) expect(readFileSync(fixture.source, "utf8")).toBe(fixture.sourceBytes);
        if (existsSync(join(fixture.directory, "unexpected-cli"))) {
          const frames = readFileSync(join(fixture.directory, "unexpected-cli"), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[]);
          expect(
            frames.every(
              (args) =>
                (args.length === 1 && args[0] === "--version") ||
                (args.length === 2 && args[0] === "agents" && args[1] === "--json"),
            ),
          ).toBe(true);
        }
      } finally {
        if (fixture.directory) rmSync(fixture.directory, { recursive: true, force: true });
      }
    });

    it("keeps indexed history while connecting the original execution host and denies Web bridge management", async () => {
      expect(await live()).toMatchObject({
        executionMode: "claude-managed",
        executionLocation: null,
        status: "idle",
        sendEnabled: true,
      });
      expect(processScans).toHaveLength(1);
      expect(processScans[0]).toMatchObject({
        timeout: 3000,
        limit: 4 * 1024 * 1024,
        strictOutput: true,
        env: { TZ: "UTC", LC_ALL: "C", LANG: "C" },
      });
      expect(
        readFileSync(join(directory, "unexpected-cli"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([["--version"], ["agents", "--json"]]);
      await connect();
      expect(await live()).toMatchObject({
        executionMode: "claude-follower",
        status: "idle",
        sendEnabled: true,
      });
      const catalog = await http<{ sessions: { id: string }[] }>("/catalog");
      expect(catalog.body.sessions.map((row) => row.id)).toContain(sessionId);
      const history = await http<{ events: { content?: string }[] }>(
        `/events?sessionId=${sessionId}`,
      );
      expect(history.body.events.map((row) => row.content)).toContain("Synthetic original history");
      const capabilities = await http<{ features: Record<string, { available: boolean }> }>(
        `/managed/capabilities?sessionId=${sessionId}&agent=claude-code`,
      );
      expect(capabilities.body.features).toMatchObject({
        send: { available: true },
        attachments: { available: false },
        approve: { available: false },
        answer: { available: false },
      });
      expect(
        JSON.stringify([catalog.body, history.body, capabilities.body, await live()]),
      ).not.toContain(binding.token);
      for (const operation of ["bridge-status", "bridge-challenge", "bridge-disconnect"]) {
        expect((await http(`/managed/${operation}`, { bootId, sessionId })).status).not.toBe(200);
      }
      expect(await commands()).toEqual([]);
    });

    it("dispatches one original-terminal send, replays its receipt, and cancels that exact turn", async () => {
      await connect();
      const initial = await live();
      const requestId = randomUUID();
      const body = {
        sessionId,
        bootId,
        expectedRevision: initial.revision,
        requestId,
        text: "One native bridge send",
      };
      const pendingCommands = commands(2_000);
      const sent = http("/send", body);
      const [command] = await pendingCommands;
      expect(command).toMatchObject({ kind: "send", text: body.text, requestId });
      const turnId = randomUUID();
      await events({ type: "turn-start", turnId, revision: 2 });
      await accept(command!, turnId, 2);
      expect((await sent).status).toBe(200);
      const receipt = await http(`/requests/${requestId}`);
      expect(receipt.body).toMatchObject({
        found: true,
        executionMode: "claude-follower",
        status: "accepted",
      });
      expect((await http("/send", body)).status).toBe(200);
      expect(await commands()).toEqual([]);
      const running = await live();
      expect(running).toMatchObject({
        status: "running",
        sendEnabled: false,
        stopEnabled: true,
        turnId,
      });
      const nextCommands = commands(2_000);
      const stopped = http("/stop", {
        sessionId,
        bootId,
        expectedRevision: running.revision,
        requestId: randomUUID(),
        turnId,
      });
      const [stop] = await nextCommands;
      expect(stop).toMatchObject({ kind: "stop", turnId });
      await events({ type: "turn-complete", turnId, text: "", aborted: true, revision: 3 });
      await accept(stop!, turnId, 3);
      expect((await stopped).status).toBe(200);
      expect((await live()).status).toBe("idle");
      expect(received.map((row) => row.kind)).toEqual(["send", "stop"]);
      expect((await http(`/requests/${requestId}`)).body).toMatchObject({
        completionObserved: true,
      });
    });

    it("retains the original offline binding through history growth and a real backend restart", async () => {
      const manage = (operation: string) =>
        rpc<Record<string, unknown>>("claude.managed", {
          operation,
          sessionId,
          deviceId: "agentkib-local-owner",
        });
      expect(await manage("bridge-status")).toMatchObject({ connected: false, hasBinding: false });
      await connect();
      expect(await manage("bridge-status")).toMatchObject({ connected: true, hasBinding: true });
      sourceBytes +=
        JSON.stringify({
          type: "assistant",
          uuid: randomUUID(),
          sessionId: nativeId,
          cwd: workspace,
          timestamp: "2026-10-16T00:01:00Z",
          message: { role: "assistant", content: "Synthetic appended history" },
        }) + "\n";
      writeFileSync(source, sourceBytes);
      await events({ type: "invalidated", reason: "synthetic-terminal-exit", revision: 2 });
      expect(await manage("bridge-status")).toMatchObject({ connected: false, hasBinding: true });
      const environment = backend.environment;
      await backend.close();
      backend = new TypeScriptBackend(environment);
      await rpc("backend.initialize", { dataDir: join(directory, "data") });
      const status = await manage("bridge-status");
      expect(status).toMatchObject({ connected: false, hasBinding: true });
      expect(JSON.stringify(status)).not.toContain(binding.token);
      expect(JSON.stringify(status)).not.toContain(binding.bindingId);
      expect(JSON.stringify(status)).not.toContain(binding.credentialPath);
      await expect.poll(() => existsSync(ticket.socketPath)).toBe(true);
      const identity = {
        protocol: snapshot.protocol,
        nativeId,
        cwd: workspace,
        cliVersion: snapshot.cliVersion,
        pluginVersion: snapshot.pluginVersion,
        nativeCapabilities: snapshot.nativeCapabilities,
        instanceId,
        bindingId: binding.bindingId,
      };
      const reconnected = await plugin<ClaudeBridgeConnection>(
        CLAUDE_BRIDGE_PATHS.reconnect,
        identity,
      );
      expect(reconnected.status).toBe(200);
      binding = reconnected.body;
      seq = 0;
      expect(await manage("bridge-status")).toMatchObject({ connected: false, hasBinding: true });
      await events({ type: "snapshot", snapshot });
      expect(await manage("bridge-status")).toMatchObject({ connected: true, hasBinding: true });
      await manage("bridge-disconnect");
      expect(await manage("bridge-status")).toMatchObject({ connected: false, hasBinding: false });
      expect(await plugin(CLAUDE_BRIDGE_PATHS.reconnect, identity)).toMatchObject({
        status: 410,
        body: { error: "bridge-binding-revoked" },
      });
    });

    it("keeps unknown command outcomes fenced when binding status cannot validate the current target", async () => {
      await connect();
      const initial = await live();
      const requestId = randomUUID();
      const pending = http("/send", {
        sessionId,
        bootId,
        expectedRevision: initial.revision,
        requestId,
        text: "Synthetic unconfirmed native command",
      });
      expect(await commands(2_000)).toHaveLength(1);
      await events({ type: "invalidated", reason: "synthetic-terminal-exit", revision: 2 });
      expect((await pending).body).toMatchObject({ controlOutcome: "unknown" });
      const manage = (operation: string) =>
        rpc<Record<string, unknown>>("claude.managed", {
          operation,
          sessionId,
          deviceId: "agentkib-local-owner",
        });
      expect(await manage("bridge-status")).toMatchObject({
        connected: false,
        hasBinding: false,
        reason: "claude-bridge-session-unavailable",
      });
      await expect(manage("bridge-challenge")).rejects.toThrow("claude-bridge-session-unavailable");
      expect((await http(`/requests/${requestId}`)).body).toMatchObject({ status: "unknown" });
      await manage("bridge-disconnect");
      expect((await http(`/requests/${requestId}`)).body).toMatchObject({ status: "unknown" });
    });

    it("revokes a queued Web command before plugin dispatch", async () => {
      await connect();
      const initial = await live();
      const sent = http("/send", {
        sessionId,
        bootId,
        expectedRevision: initial.revision,
        requestId: randomUUID(),
        text: "Must remain undispatched",
      });
      await expect
        .poll(
          async () =>
            (
              await rpc<LiveState>("claude.managed", {
                operation: "live",
                sessionId,
                experimentalEnabled: true,
              })
            ).status,
        )
        .toBe("outcome-unknown");
      await service.request({ operation: "revoke", id: deviceId });
      expect(await commands()).toEqual([]);
      const response = await sent;
      expect(response.body).not.toMatchObject({ accepted: true });
      expect(received).toEqual([]);
      expect((await http(`/live?sessionId=${sessionId}`)).status).not.toBe(200);
    });
  },
);
