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
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";
import { McpHub } from "../../../packages/backend/src/mcp-hub";
import { RemoteAgent } from "../../../packages/backend/src/remote-agent";
import { Commands } from "../../../packages/backend/src/commands";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
} from "../../../packages/backend/src/managed-ledger";
import { ClaudeSessionOwnerProbe } from "../../../packages/backend/src/agents/claude/claude-session-owner";
import { SessionCatalogStream } from "../../../packages/backend/src/session-catalog-stream";
import { WebAccessService, createWebControlState } from "../electron/main/web/service";
import { RuntimeRequestError } from "../electron/main/runtime-host";
import {
  CLAUDE_BRIDGE_PATHS,
  REMOTE_ERROR_CODES,
  REMOTE_ERROR_CONTRACT,
  RUNTIME_METHODS,
  SESSION_EVENT_NOTIFICATION,
  type ClaudeBridgeCommand,
  type ClaudeBridgeConnection,
  type ClaudeBridgeSnapshot,
  type ClaudeBridgeTicket,
  type SessionActivity,
  type SessionStreamEvent,
  type SessionSubscription,
} from "@agentkib/runtime-protocol";
import {
  applyConversationCatalogPatch,
  conversationCatalogPatch,
  type ConversationSessionSummary,
} from "@agentkib/web-client";

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
  activities?: readonly SessionActivity[];
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
    let beforeExplicitHandover: (() => void) | undefined;
    let onSessionEvent: ((event: SessionStreamEvent) => void) | undefined;
    const processScans: Array<Parameters<Commands["run"]>[2]> = [];

    async function rpc<T>(method: string, params: unknown = {}): Promise<T> {
      const reply = await backend.handleAsync({ jsonrpc: "2.0", id: randomUUID(), method, params });
      if (reply.error) throw new RuntimeRequestError(reply.error);
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
    function plugin<T>(
      path: string,
      body: unknown,
      authenticated = true,
      socketPath = ticket.socketPath,
    ): Promise<HttpResult<T>> {
      return new Promise((resolve, reject) => {
        const req = request(
          {
            socketPath,
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
    async function connect({ pluginVersion = "0.4.0", handover = false } = {}) {
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
        pluginVersion,
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
        pluginVersion,
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
        ...(handover ? { model: "loopback-model" } : {}),
        waiting: null,
        messages: [{ role: "user", text: "Synthetic original history" }],
        toolItems: [],
        streamText: "",
        usage: null,
        outbox: [],
        capabilities: {
          read: true,
          send: true,
          steer: true,
          queue: true,
          stop: true,
          ...(handover ? { handover: true } : {}),
          approve: false,
          answer: false,
        },
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
      beforeExplicitHandover = undefined;
      onSessionEvent = undefined;
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
      backend = new TypeScriptBackend(
        {
          HOME: home,
          USERPROFILE: home,
          CLAUDE_CONFIG_DIR: join(home, ".claude"),
          CODEX_HOME: join(home, ".codex"),
          PATH: bin,
          AGENTKIB_CLAUDE_PLUGIN_DIR: join(directory, "plugin"),
        },
        (method, params) => {
          if (method === SESSION_EVENT_NOTIFICATION) onSessionEvent?.(params as SessionStreamEvent);
        },
      );
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
        sessionRequest: (params) => {
          if (params.host.request.operation === "handover-terminal") beforeExplicitHandover?.();
          return rpc(RUNTIME_METHODS.sessionRequest, params);
        },
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

    it("distinguishes an unregistered workspace from an unindexed session during automatic pairing", async () => {
      const discovery = join(directory, "home", ".agentkib", "claude-bridge", "auto-v1.json");
      await vi.waitFor(() => expect(existsSync(discovery)).toBe(true));
      const { socketPath, autoKey } = JSON.parse(readFileSync(discovery, "utf8")) as {
        socketPath: string;
        autoKey: string;
      };
      const hello = {
        autoKey,
        protocol: 1,
        cliVersion: "2.1.301",
        pluginVersion: "0.4.0",
        nativeCapabilities: {
          version: 1,
          available: [
            "session-identity",
            "session-messages",
            "session-usage",
            "credential-store",
            "credential-read",
          ],
        },
        instanceId: randomUUID(),
      };
      const autoPair = (id: string, cwd: string) =>
        plugin(CLAUDE_BRIDGE_PATHS.autoPair, { ...hello, nativeId: id, cwd }, false, socketPath);

      const unregistered = await autoPair(nativeId, join(directory, "home"));
      expect(unregistered.status).toBe(409);
      expect(unregistered.body).toEqual({
        error: "bridge-auto-unavailable",
        reason: "workspace-not-registered",
      });
      const unindexed = await autoPair(randomUUID(), workspace);
      expect(unindexed.status).toBe(409);
      expect(unindexed.body).toEqual({
        error: "bridge-auto-unavailable",
        reason: "session-not-indexed",
      });
    });

    it("keeps indexed history while connecting the original execution host and denies Web bridge management", async () => {
      expect(await live()).toMatchObject({
        executionMode: "claude-managed",
        executionLocation: null,
        status: "idle",
        sendEnabled: true,
      });
      // This first live read loads the catalog to scope access, which samples terminal activity
      // for display. It also checks ownership separately before enabling send.
      expect(processScans).toHaveLength(2);
      for (const scan of processScans) {
        expect(scan).toMatchObject({
          timeout: 3000,
          limit: 4 * 1024 * 1024,
          strictOutput: true,
          env: { TZ: "UTC", LC_ALL: "C", LANG: "C" },
        });
      }
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

    it.each([
      {
        field: "updated_at" as const,
        statement: "UPDATE conversation_sessions SET updated_at=? WHERE id=?",
        status: 200,
      },
      {
        field: "created_at" as const,
        statement: "UPDATE conversation_sessions SET created_at=? WHERE id=?",
        status: 500,
      },
    ])(
      "checks indexed history ownership after $field changes during a read",
      async ({ field, statement, status }) => {
        await connect();
        const pageRead = Promise.withResolvers<void>();
        const returnPage = Promise.withResolvers<void>();
        const read = SessionReaders.prototype.claudeEventsForSession;
        vi.spyOn(SessionReaders.prototype, "claudeEventsForSession").mockImplementation(
          async function (this: SessionReaders, ...args) {
            const page = await read.apply(this, args);
            if (args[0] === sessionId && args[1] === null) {
              pageRead.resolve();
              await returnPage.promise;
            }
            return page;
          },
        );
        const pending = http<{ events: { content?: string }[] }>(`/events?sessionId=${sessionId}`);
        let history: Awaited<typeof pending>;
        try {
          await Promise.race([
            pageRead.promise,
            pending.then(({ status }) => {
              throw new Error(`History returned ${status} before reading the native transcript`);
            }),
          ]);
          const index = new BackendStore(join(directory, "data", "agentkib.db"));
          try {
            index.sql.run(statement, "2050-01-01T00:00:00+00:00", sessionId);
            expect(index.sessions.get(sessionId)?.[field]).toBe("2050-01-01T00:00:00Z");
          } finally {
            index.close();
          }
        } finally {
          returnPage.resolve();
          history = await pending;
        }
        expect(history.status).toBe(status);
        if (status === 200)
          expect(history.body.events.map((event) => event.content)).toContain(
            "Synthetic original history",
          );
      },
    );

    it("exposes terminal subagents through bridge live and the session stream", async () => {
      await connect();
      expect(await live()).not.toHaveProperty("activities");

      const id = randomUUID();
      await events({
        type: "snapshot",
        snapshot: {
          ...snapshot,
          revision: 2,
          terminalSubagents: [{ id, title: "Read the test report", status: "completed" }],
        },
      });
      const expected = [
        {
          id: expect.stringMatching(/^[a-f0-9]{64}$/),
          title: "Read the test report",
          kind: "subagent",
          status: "completed",
        },
      ];
      const current = await live();
      expect(current.activities).toEqual(expected);
      expect(JSON.stringify(current.activities)).not.toContain(id);
      const subscription = await rpc<SessionSubscription>(RUNTIME_METHODS.sessionsSubscribe, {
        sessionId,
      });
      try {
        expect(subscription.events[0]).toMatchObject({
          type: "snapshot",
          payload: { live: { activities: current.activities } },
        });
      } finally {
        await rpc(RUNTIME_METHODS.sessionsUnsubscribe, {
          subscriptionId: subscription.subscriptionId,
        });
      }
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

    it.each(["same turn", "new turn without its native prompt yet"])(
      "projects native completion only to its witnessed turn: %s",
      async (scenario) => {
        await connect({ pluginVersion: "0.5.12" });
        const view = async () => {
          const subscription = await rpc<SessionSubscription>(RUNTIME_METHODS.sessionsSubscribe, {
            sessionId,
          });
          await rpc(RUNTIME_METHODS.sessionsUnsubscribe, {
            subscriptionId: subscription.subscriptionId,
          });
          return subscription.events[0]?.payload;
        };
        const append = async (...rows: Record<string, unknown>[]) => {
          for (const row of rows)
            sourceBytes += JSON.stringify({ sessionId: nativeId, cwd: workspace, ...row }) + "\n";
          writeFileSync(source, sourceBytes);
          // Finish indexing this file version before opening a fresh snapshot.
          // This test checks turn evidence, independently of indexing races.
          await rpc(RUNTIME_METHODS.refreshWorkspaceSessions, {
            workspaceId: "workspace",
            force: true,
          });
        };
        const turnId = randomUUID();
        const promptId = randomUUID();
        const answerId = randomUUID();
        await append({
          type: "user",
          uuid: promptId,
          timestamp: "2026-10-16T00:01:00Z",
          message: { role: "user", content: "Finish probe" },
        });
        await events({ type: "turn-start", turnId, revision: 2 });
        expect(await view()).toMatchObject({
          live: { status: "running", turnId, stopEnabled: true },
        });
        const currentTurnId = scenario === "same turn" ? turnId : randomUUID();
        if (currentTurnId !== turnId) {
          await events({ type: "turn-start", turnId: currentTurnId, revision: 3 });
          expect(await view()).toMatchObject({
            live: { status: "running", turnId: currentTurnId },
          });
        }
        await append({
          type: "assistant",
          uuid: answerId,
          parentUuid: promptId,
          timestamp: "2026-10-16T00:01:01Z",
          message: { role: "assistant", content: "Native final reply", stop_reason: "end_turn" },
        });
        expect(await view()).toMatchObject({ live: { status: "running", turnId: currentTurnId } });
        await append({
          type: "system",
          subtype: "turn_duration",
          uuid: randomUUID(),
          parentUuid: answerId,
          timestamp: "2026-10-16T00:01:01Z",
          durationMs: 1_000,
        });
        const awaitingCompletion =
          currentTurnId === turnId
            ? {
                status: "idle",
                turnId: null,
                sendEnabled: false,
                steerEnabled: false,
                stopEnabled: false,
              }
            : { status: "running", turnId: currentTurnId, sendEnabled: false, stopEnabled: true };
        expect(await view()).toMatchObject({
          live: awaitingCompletion,
          items: expect.arrayContaining([
            expect.objectContaining({ id: answerId, content: "Native final reply" }),
          ]),
        });
        // The composer refreshes through /live when focused, separate from the stream.
        expect(await live()).toMatchObject(awaitingCompletion);
        // Control admission still sees the native lease.
        expect(
          await rpc(RUNTIME_METHODS.claudeManaged, {
            operation: "live",
            sessionId,
            experimentalEnabled: true,
          }),
        ).toMatchObject({
          status: "running",
          turnId: currentTurnId,
          sendEnabled: false,
          stopEnabled: true,
        });
        await events({
          type: "turn-complete",
          turnId,
          text: "Native final reply",
          aborted: false,
          revision: 4,
        });
        if (currentTurnId !== turnId) {
          expect(await live()).toMatchObject({ status: "running", turnId: currentTurnId });
          return;
        }
        const usage = { tokens: 20, window: 100, percent: 20, observedAt: 1 };
        const ready = { ...snapshot, revision: 4, usage };
        await events({ type: "snapshot", snapshot: ready });
        const readyLive = await live();
        expect(readyLive).toMatchObject({ status: "idle", sendEnabled: true });
        await events({
          type: "snapshot",
          snapshot: { ...ready, usage: { ...usage, observedAt: 2 } },
        });
        expect(await live()).toMatchObject({
          status: "idle",
          sendEnabled: true,
          revision: readyLive.revision,
          usage: { updatedAt: new Date(2).toISOString() },
        });
        await events({
          type: "snapshot",
          snapshot: { ...ready, capabilities: { ...ready.capabilities, send: false } },
        });
        expect(await live()).toMatchObject({
          status: "idle",
          sendEnabled: false,
          revision: readyLive.revision + 1,
        });
      },
    );

    it("keeps an unselected catalog row on the raw lease while detail settles from native history", async () => {
      await connect({ pluginVersion: "0.5.12" });
      const directory = await rpc<SessionSubscription>(RUNTIME_METHODS.sessionsSubscribe, {
        sessionId: "",
      });
      let rows = (directory.events[0]?.payload.live as { sessions: ConversationSessionSummary[] })
        .sessions;
      const row = () => rows.find((candidate) => candidate.id === sessionId);
      expect(row()?.continuation?.status).toBe("idle");
      const directoryUpdate = vi.spyOn(SessionCatalogStream.prototype, "update");
      const waiters = new Set<(event: SessionStreamEvent) => void>();
      const next = (accept: (event: SessionStreamEvent) => boolean) =>
        new Promise<SessionStreamEvent>((resolve) => {
          const inspect = (event: SessionStreamEvent) => {
            if (!accept(event)) return;
            waiters.delete(inspect);
            resolve(event);
          };
          waiters.add(inspect);
        });
      const catalogFrame = (event: SessionStreamEvent) =>
        event.subscriptionId === directory.subscriptionId && event.type === "invalidate";
      const catalogStatuses: Array<string | undefined> = [];
      onSessionEvent = (event) => {
        if (catalogFrame(event)) {
          const patch = conversationCatalogPatch(event.payload);
          if (patch) {
            rows = applyConversationCatalogPatch(rows, patch, (replacement) => replacement);
            catalogStatuses.push(row()?.continuation?.status);
          }
        }
        for (const waiter of waiters) waiter(event);
      };

      const append = (...records: Record<string, unknown>[]) => {
        for (const record of records)
          sourceBytes += JSON.stringify({ sessionId: nativeId, cwd: workspace, ...record }) + "\n";
        writeFileSync(source, sourceBytes);
      };
      const turnId = randomUUID();
      const promptId = randomUUID();
      const replyId = randomUUID();
      append({
        type: "user",
        uuid: promptId,
        timestamp: "2026-10-16T00:01:00Z",
        message: { role: "user", content: "Finish probe" },
      });
      const running = next(
        (event) => catalogFrame(event) && row()?.continuation?.status === "running",
      );
      await events({ type: "turn-start", turnId, revision: 2 });
      await running;
      const detail = await rpc<SessionSubscription>(RUNTIME_METHODS.sessionsSubscribe, {
        sessionId,
      });
      expect(detail.events[0]?.payload).toMatchObject({ live: { status: "running", turnId } });
      const detailFrame = (event: SessionStreamEvent) =>
        event.subscriptionId === detail.subscriptionId;
      const settled = next(
        (event) =>
          detailFrame(event) &&
          event.type === "snapshot" &&
          (event.payload.live as LiveState).status === "idle" &&
          Array.isArray(event.payload.items) &&
          event.payload.items.some((item) => item.id === replyId),
      );
      append(
        {
          type: "assistant",
          uuid: replyId,
          parentUuid: promptId,
          timestamp: "2026-10-16T00:01:01Z",
          message: { role: "assistant", content: "Native final reply", stop_reason: "end_turn" },
        },
        {
          type: "system",
          subtype: "turn_duration",
          uuid: randomUUID(),
          parentUuid: replyId,
          timestamp: "2026-10-16T00:01:01Z",
          durationMs: 1_000,
        },
      );
      await settled;

      const lateText = next((event) => detailFrame(event) && event.type === "state");
      await events({ type: "text", turnId, text: "Late stream text", revision: 3 });
      expect((await lateText).payload).toMatchObject({ status: "idle", sendEnabled: false });
      expect(directoryUpdate).toHaveBeenLastCalledWith(
        expect.anything(),
        sessionId,
        expect.objectContaining({ status: "running", turnId }),
      );

      const updated = next((event) => catalogFrame(event) && row()?.title === "Reconciled title");
      append({ type: "custom-title", customTitle: "Reconciled title" });
      await updated;
      expect(row()?.continuation?.status).toBe("running");
      expect(await live()).toMatchObject({ status: "idle", sendEnabled: false });

      const catalogRefresh = vi.spyOn(SessionCatalogStream.prototype, "invalidate");
      const completed = next(catalogFrame);
      const invalidated = next((event) => detailFrame(event) && event.type === "invalidate");
      await events({
        type: "turn-complete",
        turnId,
        text: "Native final reply",
        aborted: false,
        revision: 4,
      });
      expect((await invalidated).payload.domains).toEqual(["history", "catalog", "receipts"]);
      // Reader-scoped receipts still need the full catalog. The detail invalidation
      // must not separately queue another global refresh.
      expect((await completed).payload).toEqual({ domains: ["catalog"] });
      expect(catalogRefresh).toHaveBeenCalledTimes(1);
      const refreshed = await rpc<{ sessions: ConversationSessionSummary[] }>(
        RUNTIME_METHODS.sessionRequest,
        { host: { request: { operation: "catalog" } } },
      );
      rows = refreshed.sessions;
      catalogStatuses.push(row()?.continuation?.status);
      expect(row()?.continuation?.status).toBe("idle");
      expect(await live()).toMatchObject({ status: "idle" });
      expect(
        catalogStatuses.filter((status, index) => status !== catalogStatuses[index - 1]),
      ).toEqual(["running", "idle"]);
    }, 20_000);

    async function prepareTerminalHandover() {
      sourceBytes +=
        JSON.stringify({ type: "permission-mode", sessionId: nativeId, permissionMode: "plan" }) +
        "\n";
      writeFileSync(source, sourceBytes);
      const foreground = vi
        .spyOn(ClaudeSessionOwnerProbe.prototype, "foregroundProcess")
        .mockResolvedValue({ pid: process.pid, start: "2026-10-19 00:00:00" });
      await connect({ handover: true });
      const capabilities = await http<{ features: Record<string, { available: boolean }> }>(
        `/managed/capabilities?sessionId=${sessionId}&agent=claude-code`,
      );
      expect(capabilities.body.features).toMatchObject({
        "handover-terminal": { available: true },
      });
      return {
        foreground,
        body: {
          agent: "claude-code",
          operation: "handover-terminal",
          sessionId,
          bootId,
          expectedRevision: (await live()).revision,
          requestId: randomUUID(),
          handoffConfirmed: true,
        },
      };
    }

    async function replyToTerminalExit(
      body: Record<string, unknown>,
      status: "rejected" | "exit-initiated",
    ) {
      const polled = commands(2_000);
      const request = http("/managed/action", body);
      const offered = await polled;
      expect(offered).toEqual([expect.objectContaining({ kind: "handover-exit" })]);
      const result = await plugin(CLAUDE_BRIDGE_PATHS.results, {
        ...lease(),
        commandId: offered[0]!.commandId,
        status,
        revision: snapshot.revision,
      });
      expect(result).toMatchObject({ status: 200, body: { ok: true } });
      return request;
    }

    it("returns the foreground reason when native confirmation is lost before exit", async () => {
      const { body, foreground } = await prepareTerminalHandover();
      // The earlier public capability and live checks saw the process. Only the
      // native check inside the explicitly admitted handover loses that evidence.
      beforeExplicitHandover = () => foreground.mockResolvedValue(undefined);

      expect(await http("/managed/action", body)).toMatchObject({
        status: 409,
        body: {
          error: REMOTE_ERROR_CODES.claudeTerminalForegroundUnconfirmed,
          controlOutcome: "not-dispatched",
        },
      });
      expect(await commands()).toEqual([]);
      expect((await http(`/requests/${body.requestId}`)).body).toMatchObject({ found: false });
    });

    it("returns the exit refusal after the terminal bridge explicitly rejects it", async () => {
      const { body } = await prepareTerminalHandover();
      const result = await replyToTerminalExit(body, "rejected");
      expect(result).toMatchObject({
        status: 409,
        body: {
          error: REMOTE_ERROR_CODES.claudeTerminalExitRefused,
          controlOutcome: "not-dispatched",
        },
      });
      expect((await http(`/requests/${body.requestId}`)).body).toMatchObject({
        found: true,
        status: "not-dispatched",
      });
      expect(await commands()).toEqual([]);
    });

    it("keeps an initiated but unconfirmed terminal exit in receipt reconciliation", async () => {
      const { body } = await prepareTerminalHandover();
      const exitProbe = vi
        .spyOn(ClaudeSessionOwnerProbe.prototype, "foregroundProcessExited")
        .mockResolvedValue(false);
      expect(await replyToTerminalExit(body, "exit-initiated")).toMatchObject({
        status: REMOTE_ERROR_CONTRACT.outcomeUnknown.http.overrides.runtimeResponseUnconfirmed,
        body: { error: REMOTE_ERROR_CODES.outcomeUnknown, controlOutcome: "unknown" },
      });
      expect(exitProbe).toHaveBeenCalled();
      expect((await http(`/requests/${body.requestId}`)).body).toMatchObject({
        found: true,
        status: "unknown",
      });
      expect(await http("/managed/action", body)).toMatchObject({
        status: REMOTE_ERROR_CONTRACT.outcomeUnknown.http.status,
        body: { error: REMOTE_ERROR_CODES.outcomeUnknown, controlOutcome: "unknown" },
      });
      expect(await commands()).toEqual([]);
      expect(received.map(({ kind }) => kind)).toEqual(["handover-exit"]);
    }, 20_000);

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

    it("keeps a transferred session managed despite its old binding and restores its terminal eligibility on reconnect", async () => {
      const local = "agentkib-local-owner";
      const claude = <T>(operation: string, fields: Record<string, unknown> = {}) =>
        rpc<T>("claude.managed", { operation, deviceId: local, ...fields });
      const { sessionId: lead } = await claude<{ sessionId: string }>("create", {
        workspaceId: "workspace",
        requestId: randomUUID(),
      });
      const assignment = () =>
        claude("lead-assignment-options", { sessionId: lead, candidateIds: [sessionId] });
      const capabilities = () =>
        http(`/managed/capabilities?sessionId=${sessionId}&agent=claude-code`);
      const settings = () => http(`/managed/settings?sessionId=${sessionId}`);
      const reconcile = (requestId = randomUUID()) => claude("reconcile", { sessionId, requestId });
      const catalogRow = async () => {
        const { sessions } = await rpc<{ sessions: ConversationSessionSummary[] }>(
          RUNTIME_METHODS.sessionRequest,
          { host: { request: { operation: "catalog" } } },
        );
        return sessions.find((row) => row.id === sessionId);
      };
      const unconfirmed = {
        continuation: {
          status: "outcome-unknown",
          reason: REMOTE_ERROR_CODES.controlOutcomeUnconfirmed,
        },
      };
      const expectWorker = async (executionSide: "agentkib" | "terminal") =>
        expect(await assignment()).toMatchObject({
          capable: true,
          candidates: [
            {
              sessionId,
              reason: null,
              eligibility: { executionSide, availability: { available: true } },
            },
          ],
        });

      await connect({ pluginVersion: "0.5.12", handover: true });
      await expectWorker("terminal");
      const priorBinding = binding.bindingId;
      sourceBytes += [
        {
          type: "assistant",
          uuid: randomUUID(),
          parentUuid: JSON.parse(sourceBytes).uuid,
          message: {
            role: "assistant",
            model: "loopback-model",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Synthetic original reply" }],
          },
        },
        { type: "permission-mode", permissionMode: "plan" },
      ]
        .map(
          (row) =>
            JSON.stringify({
              ...row,
              sessionId: nativeId,
              cwd: workspace,
              timestamp: "2026-10-16T00:01:00Z",
            }) + "\n",
        )
        .join("");
      writeFileSync(source, sourceBytes);
      await events({ type: "invalidated", reason: "native-session-ended", revision: 2 });
      expect(await claude("bridge-status", { sessionId })).toMatchObject({
        connected: false,
        hasBinding: true,
      });
      expect(await assignment()).toMatchObject({
        candidates: [{ sessionId, reason: REMOTE_ERROR_CODES.workerTerminalDisconnected }],
      });

      const data = join(directory, "data");
      const pendingHandover = randomUUID();
      claimManagedCommand(data, pendingHandover, sessionId, "a".repeat(64), local, {
        operation: "adopt-terminal",
        executionMode: "claude-managed",
      });
      dispatchManagedCommand(data, pendingHandover);
      expect.soft(await catalogRow()).toMatchObject(unconfirmed);
      expect(await live()).toMatchObject({ status: "outcome-unknown", sendEnabled: false });
      expect(await assignment()).toMatchObject({
        candidates: [{ sessionId, reason: REMOTE_ERROR_CODES.controlOutcomeUnconfirmed }],
      });
      finishManagedCommand(data, pendingHandover, {
        accepted: false,
        controlOutcome: "not-dispatched",
      });

      const before = await live();
      expect(
        await claude("adopt-terminal", {
          sessionId,
          requestId: randomUUID(),
          runtimeBootId: before.runtimeBootId,
          expectedRevision: before.revision,
          experimentalEnabled: true,
        }),
      ).toMatchObject({ accepted: true });
      const managedRecord = join(data, "claude-managed", `${sessionId}.json`);
      expect(JSON.parse(readFileSync(managedRecord, "utf8"))).toMatchObject({
        adopted: true,
        released: false,
      });
      const saved = JSON.parse(
        readFileSync(join(data, "claude-bridge", "bindings-v1.json"), "utf8"),
      ) as {
        bindings: Array<{ bindingId: string; revoked: boolean }>;
      };
      expect(saved.bindings.some((row) => row.bindingId === priorBinding && !row.revoked)).toBe(
        true,
      );
      expect(await live()).toMatchObject({
        executionMode: "claude-managed",
        execution: { owner: "agentkib", observed: false },
        status: "idle",
      });
      expect(await capabilities()).toMatchObject({
        status: 200,
        body: {
          executionMode: "claude-managed",
          execution: { owner: "agentkib", observed: false },
          features: { settings: { available: true } },
        },
      });
      expect(await settings()).toMatchObject({
        status: 200,
        body: {
          executionMode: "claude-managed",
          selected: { modelId: "loopback-model", permissionMode: "plan" },
        },
      });
      expect(await catalogRow()).toMatchObject({
        executionMode: "claude-managed",
        continuation: { executionLocation: "agentkib", status: "idle" },
      });
      await expectWorker("agentkib");

      // A malformed managed target must not replace its readable native index row.
      const validRecord = readFileSync(managedRecord, "utf8");
      const otherWorkspace = join(directory, "wrong-workspace");
      mkdirSync(otherWorkspace);
      writeFileSync(
        managedRecord,
        JSON.stringify({ ...JSON.parse(validRecord), workspace: otherWorkspace }),
      );
      const nativeRow = await catalogRow();
      expect.soft(nativeRow).toMatchObject({ id: sessionId, workspace_id: "workspace" });
      expect.soft(nativeRow).not.toMatchObject({ continuation: { executionLocation: "agentkib" } });
      expect.soft(nativeRow?.executionMode).not.toBe("claude-managed");
      writeFileSync(managedRecord, validRecord);

      // A managed receipt is a fence for another writer, not evidence that the terminal is back.
      const pending = randomUUID();
      claimManagedCommand(data, pending, sessionId, "a".repeat(64), local, {
        operation: "send",
        executionMode: "claude-managed",
      });
      dispatchManagedCommand(data, pending);
      expect.soft(await catalogRow()).toMatchObject(unconfirmed);
      expect(await live()).toMatchObject({
        executionMode: "claude-managed",
        status: "outcome-unknown",
        sendEnabled: false,
      });
      expect(await capabilities()).toMatchObject({
        body: { executionMode: "claude-managed", features: { settings: { available: false } } },
      });
      expect(await assignment()).toMatchObject({
        candidates: [
          {
            sessionId,
            reason: REMOTE_ERROR_CODES.controlOutcomeUnconfirmed,
            eligibility: {
              availability: {
                available: false,
                reason: REMOTE_ERROR_CODES.controlOutcomeUnconfirmed,
              },
            },
          },
        ],
      });
      finishManagedCommand(data, pending, { accepted: false, controlOutcome: "not-dispatched" });
      expect.soft(await catalogRow()).toMatchObject({
        continuation: { executionLocation: "agentkib", status: "idle" },
      });
      expect(await live()).toMatchObject({ status: "idle" });

      // A restarted runtime can have an accepted send and a stored running turn without a runner.
      const idleBytes = readFileSync(managedRecord, "utf8");
      const cold = JSON.parse(idleBytes);
      cold.snapshot = { ...cold.snapshot, status: "running", turnOrigin: "host" };
      writeFileSync(managedRecord, JSON.stringify(cold));
      expect(await assignment()).toMatchObject({
        candidates: [{ sessionId, reason: REMOTE_ERROR_CODES.controlOutcomeUnconfirmed }],
      });
      expect(await catalogRow()).toMatchObject({
        continuation: {
          status: "outcome-unknown",
          reason: REMOTE_ERROR_CODES.controlOutcomeUnconfirmed,
        },
      });
      writeFileSync(managedRecord, idleBytes);

      // The original SDK prompt and final reply are durable, but the runner is gone.
      const finishedTurn = randomUUID();
      const attachment = randomUUID();
      const finishedReply = randomUUID();
      const sdkRows = (rows: Record<string, unknown>[]) =>
        rows
          .map(
            (row) =>
              JSON.stringify({
                sessionId: nativeId,
                cwd: workspace,
                entrypoint: "sdk-cli",
                ...row,
              }) + "\n",
          )
          .join("");
      const input = {
        type: "user",
        uuid: finishedTurn,
        message: { role: "user", content: "Synthetic managed request" },
      };
      const unknown = {
        ...cold,
        snapshot: { ...cold.snapshot, status: "outcome-unknown", turnId: finishedTurn },
      };
      writeFileSync(managedRecord, JSON.stringify(unknown));
      expect(await assignment()).toMatchObject({
        candidates: [{ sessionId, reason: REMOTE_ERROR_CODES.controlOutcomeUnconfirmed }],
      });
      sourceBytes += sdkRows([
        input,
        { type: "attachment", uuid: attachment, parentUuid: finishedTurn },
        {
          type: "assistant",
          uuid: finishedReply,
          parentUuid: attachment,
          message: {
            role: "assistant",
            model: "loopback-model",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Synthetic managed reply" }],
          },
        },
        {
          type: "system",
          subtype: "stop_hook_summary",
          uuid: randomUUID(),
          parentUuid: finishedReply,
        },
        { type: "api-request-blob", message: { role: "user", content: "Synthetic metadata" } },
        { type: "permission-mode", permissionMode: "plan" },
      ]);
      writeFileSync(
        source,
        sourceBytes + sdkRows([{ ...input, uuid: randomUUID(), parentUuid: finishedReply }]),
      );
      expect(await assignment()).toMatchObject({
        candidates: [{ sessionId, reason: REMOTE_ERROR_CODES.controlOutcomeUnconfirmed }],
      });
      writeFileSync(source, sourceBytes);
      claimManagedCommand(data, finishedTurn, sessionId, "c".repeat(64), local, {
        operation: "send",
        executionMode: "claude-managed",
        workspaceId: "workspace",
      });
      dispatchManagedCommand(data, finishedTurn);
      finishManagedCommand(data, finishedTurn, { accepted: true, completed: false });
      const unrelated = randomUUID();
      claimManagedCommand(data, unrelated, sessionId, "b".repeat(64), local, {
        operation: "stop",
        executionMode: "claude-managed",
      });
      expect(await assignment()).toMatchObject({
        candidates: [{ sessionId, reason: REMOTE_ERROR_CODES.controlOutcomeUnconfirmed }],
      });
      dispatchManagedCommand(data, unrelated);
      expect(await assignment()).toMatchObject({
        candidates: [{ sessionId, reason: REMOTE_ERROR_CODES.controlOutcomeUnconfirmed }],
      });
      finishManagedCommand(data, unrelated, { accepted: false, controlOutcome: "not-dispatched" });

      // The released build retained this settings command separately from the finished old turn.
      const settingsId = randomUUID();
      const claim = (id: string, operation: string, runtimeBootId: string) =>
        claimManagedCommand(data, id, sessionId, "e".repeat(64), local, {
          operation,
          executionMode: "claude-managed",
          workspaceId: "workspace",
          runtimeBootId,
        });
      claim(settingsId, "settings", "previous-runtime");
      dispatchManagedCommand(data, settingsId);
      writeFileSync(
        managedRecord,
        JSON.stringify({
          ...unknown,
          completedRequests: [finishedTurn],
          snapshot: {
            ...unknown.snapshot,
            reason: "claude-unrequested-turn: synthetic frame after completion",
            terminalResult: { turnId: finishedTurn, success: true },
          },
        }),
      );
      expect(await assignment()).toMatchObject({
        candidates: [{ sessionId, reason: REMOTE_ERROR_CODES.controlOutcomeUnconfirmed }],
      });
      expect(await live()).toMatchObject({ status: "outcome-unknown", sendEnabled: false });
      const receipt = (requestId: string) =>
        rpc(RUNTIME_METHODS.controlReceipt, { requestId, deviceId: local });
      expect(await receipt(settingsId)).toMatchObject({ status: "unknown", ack: null });
      expect(await capabilities()).toMatchObject({
        body: { features: { reconcile: { available: true } } },
      });
      writeFileSync(source, sourceBytes + sdkRows([{ ...input, uuid: randomUUID() }]));
      expect(await reconcile()).toMatchObject({ reconciled: false });
      expect(await receipt(settingsId)).toMatchObject({ status: "unknown", ack: null });
      writeFileSync(source, sourceBytes);
      const reconcileId = randomUUID();
      const reconciled = await reconcile(reconcileId);
      expect(reconciled).toMatchObject({ reconciled: true, live: { status: "idle" } });
      expect(await reconcile(reconcileId)).toEqual(reconciled);
      expect(await receipt(settingsId)).toMatchObject({
        status: "unknown",
        completionObserved: false,
        ack: { recovery: "orphaned-claude-command", controlOutcome: "unknown" },
      });
      expect(await live()).toMatchObject({ status: "idle", sendEnabled: true });
      await expectWorker("agentkib");
      expect(JSON.parse(readFileSync(managedRecord, "utf8"))).toMatchObject({
        adopted: true,
        released: false,
        terminalHandover: true,
        snapshot: { status: "idle", turnId: finishedTurn, lastOutcome: "succeeded" },
        completedRequests: [finishedTurn],
      });
      expect(
        await rpc(RUNTIME_METHODS.controlReceipt, { requestId: finishedTurn, deviceId: local }),
      ).toMatchObject({
        status: "accepted",
        completionObserved: true,
      });
      expect(
        await claude("lead-assign-workers", { sessionId: lead, workers: [sessionId] }),
      ).toMatchObject({
        lead: { workers: [expect.objectContaining({ sessionId })] },
      });
      await claude("lead-worker-remove", { sessionId: lead, worker: sessionId });

      // A different control can lose its acknowledgement without any native conclusion for it.
      const manualStop = randomUUID();
      claim(manualStop, "stop", (await live()).runtimeBootId);
      const unmatchedTurn = randomUUID();
      const unconfirmedStop = { ...unknown.snapshot, turnId: unmatchedTurn };
      writeFileSync(
        managedRecord,
        JSON.stringify({
          ...unknown,
          completedRequests: [finishedTurn],
          snapshot: unconfirmedStop,
        }),
      );
      expect(await reconcile()).toMatchObject({
        reconciled: false,
        reason: REMOTE_ERROR_CODES.controlOutcomeUnconfirmed,
      });
      dispatchManagedCommand(data, manualStop);
      writeFileSync(
        managedRecord,
        JSON.stringify({
          ...unknown,
          completedRequests: [finishedTurn],
          snapshot: { ...unconfirmedStop, reason: "Claude process cleanup unconfirmed: fixture" },
        }),
      );
      expect(await capabilities()).toMatchObject({
        body: {
          features: {
            reconcile: { available: false, reason: REMOTE_ERROR_CODES.claudeOwnerCheckUnavailable },
          },
        },
      });
      expect(await reconcile()).toMatchObject({ reconciled: false });
      expect(await live()).toMatchObject({ status: "outcome-unknown", sendEnabled: false });
      expect(await receipt(manualStop)).toMatchObject({ status: "unknown", ack: null });
      writeFileSync(
        managedRecord,
        JSON.stringify({
          ...unknown,
          completedRequests: [finishedTurn],
          snapshot: unconfirmedStop,
        }),
      );
      const check = vi.spyOn(ClaudeSessionOwnerProbe.prototype, "check").mockResolvedValue({
        kind: "interactive",
        pid: process.pid,
        source: "ps",
      });
      try {
        expect(await reconcile()).toMatchObject({
          reconciled: false,
          reason: REMOTE_ERROR_CODES.claudeOwnerBusy,
        });
        expect(await receipt(manualStop)).toMatchObject({ status: "unknown", ack: null });
      } finally {
        check.mockRestore();
      }
      expect(await reconcile()).toMatchObject({
        reconciled: true,
        live: { status: "idle", lastOutcome: null, turnId: null },
      });
      expect(await receipt(manualStop)).toMatchObject({
        status: "unknown",
        completionObserved: false,
        ack: { recovery: "orphaned-claude-command", controlOutcome: "unknown" },
      });
      expect(await live()).toMatchObject({ status: "idle", sendEnabled: true });
      expect(readFileSync(source, "utf8")).toBe(sourceBytes);
      const cliCalls = readFileSync(join(directory, "unexpected-cli"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(cliCalls.every((args) => args[0] === "--version" || args[0] === "agents")).toBe(true);

      const settled = await live();
      expect(
        await claude("release", {
          sessionId,
          requestId: randomUUID(),
          runtimeBootId: settled.runtimeBootId,
          expectedRevision: settled.revision,
        }),
      ).toMatchObject({ accepted: true });
      const reconnected = await plugin<ClaudeBridgeConnection>(CLAUDE_BRIDGE_PATHS.reconnect, {
        protocol: snapshot.protocol,
        nativeId,
        cwd: workspace,
        cliVersion: snapshot.cliVersion,
        pluginVersion: snapshot.pluginVersion,
        nativeCapabilities: snapshot.nativeCapabilities,
        instanceId,
        bindingId: priorBinding,
      });
      expect(reconnected.status).toBe(200);
      expect(reconnected.body.bindingId).toBe(priorBinding);
      binding = reconnected.body;
      seq = 0;
      await events({ type: "snapshot", snapshot });
      expect(await live()).toMatchObject({
        executionMode: "claude-follower",
        executionLocation: "terminal",
        execution: { owner: "terminal", observed: true },
        status: "idle",
      });
      expect(await capabilities()).toMatchObject({
        body: { executionMode: "claude-follower", features: { settings: { available: false } } },
      });
      expect(await settings()).toMatchObject({ body: { executionMode: "claude-follower" } });
      expect(await catalogRow()).toMatchObject({
        continuation: { executionLocation: "terminal", status: "idle" },
      });
      await expectWorker("terminal");
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
