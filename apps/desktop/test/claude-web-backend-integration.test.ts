// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { once } from "node:events";
import { AttachmentStore } from "../electron/main/web/attachments";
import { WebAccessService, createWebControlState } from "../electron/main/web/service";
import { TypeScriptBackend } from "../../../packages/backend/src/index";
import { ClaudeHostStateStore } from "../../../packages/backend/src/claude-host-state";
import { ClaudeSessionOwnerProbe } from "../../../packages/backend/src/claude-session-owner";
import { Commands } from "../../../packages/backend/src/commands";
import { BackendStore } from "../../../packages/backend/src/store";
import { McpHub } from "../../../packages/backend/src/mcp-hub";
import { RemoteAgent } from "../../../packages/backend/src/remote-agent";
import { HistorySearch } from "../../../packages/backend/src/history-search";
import { claudeRelayEnabled, startClaudeRelay } from "./fixtures/claude-relay-harness";

// The real backend starts this offline executable. No runner/owner/control method is mocked.
const syntheticCli = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.286 (Claude Code)'); process.exit(0); }
if (args[0] === 'agents' && args[1] === '--json') { console.log('[]'); process.exit(0); }
const log = value => fs.appendFileSync(process.env.PARITY_LOG, JSON.stringify(value) + '\n');
log({ args });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const nativeId = (args.find(a=>a.startsWith('--session-id=')) || args.find(a=>a.startsWith('--resume='))).split('=')[1];
const folder = path.join(process.env.CLAUDE_CONFIG_DIR,'projects',process.cwd().replace(/[^a-zA-Z0-9]/g,'-'));
fs.mkdirSync(folder,{recursive:true});
const transcript = path.join(folder,nativeId+'.jsonl');
let first, pending;
const mode = () => fs.readFileSync(process.env.PARITY_MODE,'utf8');
const append = row => fs.appendFileSync(transcript,JSON.stringify({sessionId:nativeId,cwd:process.cwd(),timestamp:new Date().toISOString(),...row})+'\n');
const finish = async () => {
  const m = mode();
  const configArg = args[args.indexOf('--mcp-config')+1];
  if (args.includes('--mcp-config') && !m.includes('no-report')) {
    const config = JSON.parse(configArg);
    const server = Object.values(config.mcpServers)[0];
    const headers = {'Content-Type':'application/json', Accept:'application/json, text/event-stream'};
    const init = await fetch(server.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'offline-fixture',version:'1'}}})});
    const sid = init.headers.get('mcp-session-id'); await init.text(); headers['mcp-session-id']=sid;
    await fetch(server.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
    const result = await fetch(server.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'report_goal_step',arguments:{reportId:crypto.randomUUID(),outcome:m.includes('continue')?'continue':'complete',summary:'Synthetic verified work',evidence:['offline fixture assertion'],remainingWork:m.includes('continue')?['next fixture step']:[]}}})});
    const text = await result.text(); log({report:JSON.parse(text)});
  }
  const uuid=crypto.randomUUID();
  append({type:'assistant',uuid,parentUuid:first,message:{id:uuid,role:'assistant',model:'fixture-model',stop_reason:'end_turn',content:[{type:'text',text:'Offline response'}],usage:{input_tokens:3,output_tokens:2}}});
  send({type:'assistant',uuid,parent_tool_use_id:null,message:{id:uuid,role:'assistant',model:'fixture-model',stop_reason:'end_turn',content:[{type:'text',text:'Offline response'}],usage:{input_tokens:3,output_tokens:2}}});
  if (m === 'terminal-lost') { process.exit(0); return; }
  send({type:'result',subtype:m.includes('error')?'error_during_execution':'success',is_error:m.includes('error'),usage:m.includes('missing-usage')?undefined:{input_tokens:11,output_tokens:7,cache_read_input_tokens:2},terminal_reason:'completed'});
  first=undefined;
};
let chain=Promise.resolve();
require('node:readline').createInterface({input:process.stdin}).on('line', line => { chain=chain.then(async()=>{
  const frame=JSON.parse(line); log(frame);
  if(frame.type==='control_request') {
    // Keep the owned root alive so real tree cleanup can be confirmed after stdout closes.
    if(frame.request.subtype==='initialize' && mode()==='close-initialize') { fs.closeSync(1); return; }
    if(frame.request.subtype==='initialize' && mode()==='inherited-plan') send({type:'system',subtype:'init',model:'fixture-model',permissionMode:'plan'});
    if(frame.request.subtype==='initialize' && mode()==='inherited-alias') send({type:'system',subtype:'init',model:'fixture-resolved-model',permissionMode:'plan'});
    if(frame.request.subtype==='interrupt') {send({type:'result',subtype:'error_during_execution',is_error:true,terminal_reason:'aborted_tools'});return;}
    if(mode()==='settings-rejected' && frame.request.subtype!=='initialize') {send({type:'control_response',response:{subtype:'error',request_id:frame.request_id,error:'fixture rejection'}});return;}
    send({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:frame.request.subtype==='initialize'?{models:[{value:'fixture-model',resolvedModel:'fixture-resolved-model',displayName:'Fixture',supportedEffortLevels:['low','high']},{value:'low-model',displayName:'Low effort model',supportedEffortLevels:['low']},{value:'no-effort-model',displayName:'Model without effort',supportedEffortLevels:[]}],commands:[]}:{}}});
  } else if(frame.type==='user') {
    first ||= frame.uuid; pending=frame;
    for (const block of Array.isArray(frame.message.content)?frame.message.content:[]) {
      const match = block.type === 'text' && /^User attached file .*: (.+)$/.exec(block.text);
      if (match) log({attachmentBytes:fs.readFileSync(match[1],'utf8')});
    }
    append({type:'user',uuid:frame.uuid,message:{role:'user',content:frame.message.content}});
    if(mode()==='hold' && !frame.priority) return;
    if(mode()==='approval' || mode()==='question') {
      const question=mode()==='question';
      send({type:'control_request',request_id:question?'question-native':'approval-native',request:{subtype:'can_use_tool',tool_name:question?'AskUserQuestion':'Read',input:question?{questions:[{question:'Choose fixture?',header:'Fixture',options:[{label:'A',description:'First'},{label:'B',description:'Second'}],multiSelect:false}]}:{file_path:path.join(process.cwd(),'notes.txt')}}}); return;
    }
    await finish();
  } else if(frame.type==='control_response') {
    await finish();
  }
}).catch(error=>{log({fixtureError:String(error)});process.exit(98);}); });
`;

describe.skipIf(process.platform !== "darwin")(
  "real WebAccessService → TypeScript Backend → synthetic Claude",
  () => {
    let directory: string;
    let data: string;
    let workspace: string;
    let modeFile: string;
    let backend: TypeScriptBackend;
    let service: WebAccessService;
    let shared: ReturnType<typeof createWebControlState>;
    let port: number;
    let cookie: string;
    let csrf: string;
    let bootId: string;
    let deviceId: string;
    let environment: NodeJS.ProcessEnv;
    let expectUnknownCleanup: boolean;
    let sessionNotifications: ((event: unknown) => void) | undefined;

    async function rpc(method: string, params: unknown = {}): Promise<any> {
      const result = await backend.handleAsync({
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.result;
    }
    async function http(path: string, body?: Record<string, unknown>, identity = cookie) {
      return new Promise<{ status: number; body: any; cookies?: string[] }>((resolve, reject) => {
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
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            res.on("end", () =>
              resolve({
                status: res.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString()),
                cookies: res.headers["set-cookie"],
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
    }
    function frames(): any[] {
      const file = join(directory, "frames.jsonl");
      return existsSync(file)
        ? readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    }
    async function startBackend() {
      backend = new TypeScriptBackend(environment, (method, params) => {
        if (method === "sessions.event") sessionNotifications?.(params);
      });
      await rpc("backend.initialize", { dataDir: data });
    }
    async function startService() {
      shared = createWebControlState();
      service = new WebAccessService({
        dataDir: join(directory, "host"),
        staticDir: directory,
        desktopOrigin: "app://bundle",
        runtimeRequest: (params) => rpc("web.request", params),
        claudeManagedRequest: (params) => rpc("claude.managed", params),
        managedRequest: (params) => rpc("codex.managed", params),
        receiptRequest: (params) => rpc("control.receipt", params),
        workspaceRequest: async () => [
          { id: "workspace", name: "Offline workspace", path: workspace },
        ],
        verifiedClaudeManaged: true,
        enableClaudeScheduler: true,
        sharedControl: shared,
      });
      await service.initialize();
      // Use explicit ticks so failure tests can place races between prepare and dispatch.
      const scheduler = shared.claudeScheduler as unknown as {
        timer?: ReturnType<typeof setInterval>;
      };
      clearInterval(scheduler.timer);
      await service.request({
        operation: "configure",
        enabled: true,
        port,
        externalOrigin: "",
        experimentalEnabled: true,
        allowedWorkspaceIds: ["workspace"],
      });
    }
    async function create() {
      const result = await http("/managed/create", {
        agent: "claude-code",
        bootId,
        workspaceId: "workspace",
        requestId: randomUUID(),
        deviceId: "browser-spoof",
      });
      expect(result.status, result.body.error).toBe(200);
      expect(result.body.accepted).toBe(true);
      return result.body.sessionId as string;
    }
    async function live(sessionId: string) {
      const result = await http(`/live?sessionId=${sessionId}`);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      return result.body;
    }
    async function prepareSettings(sessionId: string) {
      return http("/managed/settings-prepare", {
        sessionId,
        bootId,
        expectedRevision: (await live(sessionId)).revision,
      });
    }
    async function action(
      sessionId: string,
      operation: string,
      payload: Record<string, unknown> = {},
    ) {
      const state = await live(sessionId);
      return http("/managed/action", {
        sessionId,
        operation,
        agent: "claude-code",
        bootId,
        expectedRevision: state.revision,
        requestId: randomUUID(),
        ...payload,
      });
    }
    async function send(
      sessionId: string,
      text = "offline input",
      payload: Record<string, unknown> = {},
    ) {
      return http("/send", {
        sessionId,
        bootId,
        expectedRevision: (await live(sessionId)).revision,
        requestId: randomUUID(),
        text,
        ...payload,
      });
    }
    async function idle(sessionId: string) {
      await expect.poll(async () => (await live(sessionId)).status).toBe("idle");
    }
    async function socket() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/web/v1/socket`, {
        headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` },
      });
      await once(ws, "open");
      return {
        ws,
        async call(path: string, body?: Record<string, unknown>) {
          const result = once(ws, "message");
          ws.send(
            JSON.stringify({ id: randomUUID(), path, body, csrfToken: csrf, protocolVersion: 2 }),
          );
          return JSON.parse(String((await result)[0])) as { status: number; body: any };
        },
      };
    }
    async function upload(sessionId: string) {
      const bytes = Buffer.from("persistent attachment");
      return new Promise<any>((resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            path: `/api/web/v1/attachments?sessionId=${sessionId}&name=offline.txt&mime=text/plain`,
            method: "POST",
            headers: {
              Cookie: cookie,
              Origin: `http://127.0.0.1:${port}`,
              "X-CSRF-Token": csrf,
              "Content-Length": bytes.length,
              "Content-Type": "text/plain",
              "X-AgentKib-Protocol": "2",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            res.on("end", () => {
              const body = JSON.parse(Buffer.concat(chunks).toString());
              if (res.statusCode !== 201) reject(new Error(JSON.stringify(body)));
              else resolve(body);
            });
          },
        );
        req.on("error", reject);
        req.end(bytes);
      });
    }
    beforeEach(async () => {
      expectUnknownCleanup = false;
      sessionNotifications = undefined;
      const commandRun = Commands.prototype.run;
      vi.spyOn(Commands.prototype, "run").mockImplementation(
        async function (this: Commands, program, args, options) {
          if (program === "/bin/ps" && args.join(" ") === "-axo pid=,pgid=,lstart=,command=")
            return {
              success: true,
              bytes: Buffer.from(""),
              error: "",
              truncated: false,
              exitCode: 0,
            };
          // Ownership-source coverage is separate; keep repeated idle probes from spawning Node.
          if (
            program === join(directory, "bin", "claude") &&
            args.length === 2 &&
            args[0] === "agents" &&
            args[1] === "--json"
          )
            return {
              success: true,
              bytes: Buffer.from("[]\n"),
              error: "",
              truncated: false,
              exitCode: 0,
            };
          return commandRun.call(this, program, args, options);
        },
      );
      directory = realpathSync(mkdtempSync(join(tmpdir(), "agentkib-real-claude-")));
      data = join(directory, "backend");
      workspace = join(directory, "workspace");
      modeFile = join(directory, "mode");
      for (const dir of [
        data,
        workspace,
        join(directory, "home"),
        join(directory, "home", ".claude"),
        join(directory, "bin"),
        join(directory, "host"),
      ])
        mkdirSync(dir);
      writeFileSync(modeFile, "ordinary");
      writeFileSync(join(workspace, "notes.txt"), "workspace reference");
      writeFileSync(join(directory, "bin", "claude"), `#!${process.execPath}\n${syntheticCli}`, {
        mode: 0o700,
      });
      writeFileSync(
        join(data, "preferences.json"),
        JSON.stringify({ session_index_enabled: false }),
      );
      environment = {
        HOME: join(directory, "home"),
        USERPROFILE: join(directory, "home"),
        CLAUDE_CONFIG_DIR: join(directory, "home", ".claude"),
        CODEX_HOME: join(directory, "home", ".codex"),
        PATH: `${join(directory, "bin")}:/usr/bin:/bin`,
        PARITY_LOG: join(directory, "frames.jsonl"),
        PARITY_MODE: modeFile,
      };
      vi.spyOn(McpHub.prototype, "start").mockResolvedValue();
      vi.spyOn(RemoteAgent.prototype, "start").mockResolvedValue();
      vi.spyOn(HistorySearch.prototype, "refresh").mockImplementation(() => {});
      vi.spyOn(HistorySearch.prototype, "clear").mockResolvedValue();
      const store = new BackendStore(join(data, "agentkib.db"));
      store.sql.run(
        "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
        "workspace",
        workspace,
        "Offline",
        "healthy",
        new Date().toISOString(),
      );
      store.close();
      const listener = createServer();
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      port = (listener.address() as { port: number }).port;
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await startBackend();
      await startService();
      cookie = csrf = bootId = "";
      const access = await http("/access");
      cookie = access.cookies![0]!.split(";")[0]!;
      csrf = access.body.csrfToken;
      bootId = access.body.bootId;
      const code = (await service.request({ operation: "generate-code", access: "full" })).code!
        .value;
      const paired = await http("/pair", { code, name: "Offline phone" });
      expect(paired.status).toBe(200);
      deviceId = paired.body.device.id;
    });
    afterEach(async () => {
      try {
        await service?.dispose();
        if (expectUnknownCleanup)
          await expect(backend.close()).rejects.toMatchObject({
            message: "Claude managed runner shutdown failed",
            errors: [
              expect.objectContaining({ message: expect.stringContaining("cleanup unconfirmed") }),
            ],
          });
        else await backend?.close();
      } finally {
        vi.restoreAllMocks();
        if (directory) rmSync(directory, { recursive: true, force: true });
      }
    });

    it("persists the original send rejection and releases the host fence when ownership races its live preflight", async () => {
      const sessionId = await create();
      const state = await live(sessionId);
      let appeared = false;
      let raced = false;
      const originalCheck = ClaudeSessionOwnerProbe.prototype.check;
      vi.spyOn(ClaudeSessionOwnerProbe.prototype, "check").mockImplementation(
        async function (this: ClaudeSessionOwnerProbe, nativeId, ownedPid) {
          const observation = await originalCheck.call(this, nativeId, ownedPid);
          return appeared && nativeId === state.sourceSessionId
            ? { kind: "interactive" as const, pid: process.pid, source: "agents" as const }
            : observation;
        },
      );
      const originalHandle = backend.handleAsync.bind(backend);
      vi.spyOn(backend, "handleAsync").mockImplementation(async (request) => {
        if (
          !raced &&
          request.method === "web.request" &&
          (request.params as { operation?: string })?.operation === "send"
        ) {
          raced = true;
          appeared = true;
        }
        return originalHandle(request);
      });
      const requestId = randomUUID();
      const rejected = await send(sessionId, "Original draft", { requestId });
      expect(rejected).toMatchObject({
        status: 409,
        body: { error: "claude-owner-busy", controlOutcome: "not-dispatched" },
      });
      expect(frames().filter((row) => row.type === "user")).toEqual([]);
      expect(await rpc("control.receipt", { requestId, deviceId })).toMatchObject({
        found: true,
        requestId,
        status: "not-dispatched",
        sessionId,
        ack: { accepted: false, completed: false, requestId, controlOutcome: "not-dispatched" },
      });
      appeared = false;
      await expect
        .poll(() => live(sessionId), { timeout: 5000, interval: 100 })
        .toMatchObject({
          sendEnabled: true,
          ownershipReason: null,
        });
      const retry = await send(sessionId, "Retry after the native owner exits");
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      await idle(sessionId);
      expect(frames().filter((row) => row.type === "user")).toHaveLength(1);
    }, 10_000);

    it("creates with the true device and routes fresh Claude reads, send and receipts through the actual owner", async () => {
      const sessionId = await create();
      const state = await live(sessionId);
      expect(state.executionMode).toBe("claude-managed");
      const requestId = randomUUID();
      const first = await send(sessionId, "offline input", { requestId });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      await idle(sessionId);
      const receipt = await http(`/requests/${requestId}`);
      expect(receipt.body).toMatchObject({
        found: true,
        executionMode: "claude-managed",
        completionObserved: true,
      });
      expect(await rpc("control.receipt", { deviceId: "browser-spoof", requestId })).toMatchObject({
        found: false,
      });
      expect(await rpc("control.receipt", { deviceId, requestId })).toMatchObject({ found: true });
      const retry = await http("/send", {
        bootId,
        sessionId,
        requestId,
        expectedRevision: state.revision,
        text: "offline input",
      });
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect(frames().filter((row) => row.type === "user")).toHaveLength(1);
      const conflict = await http("/send", {
        bootId,
        sessionId,
        requestId,
        expectedRevision: state.revision,
        text: "different",
      });
      expect(conflict.status).not.toBe(200);
    });

    it.each([false, true])(
      "preserves an explicitly named Claude task after its first native turn (legacy=%s)",
      async (legacy) => {
        // Name is an existing backend create field; the Web create API intentionally has no
        // name field. Exercise that backend contract, then use the actual HTTP send/catalog.
        const created = await rpc("claude.managed", {
          operation: "create",
          workspaceId: "workspace",
          requestId: randomUUID(),
          deviceId,
          name: "Chosen managed title",
        });
        const sessionId = created.sessionId;
        if (legacy)
          new ClaudeHostStateStore(data).update(sessionId, (host) => {
            host.title = null;
          });
        expect((await send(sessionId, "A different first prompt")).status).toBe(200);
        await idle(sessionId);
        const catalog = await http("/catalog");
        expect(catalog.status, JSON.stringify(catalog.body)).toBe(200);
        expect(catalog.body.sessions.find((row: any) => row.id === sessionId)?.title).toBe(
          "Chosen managed title",
        );
        if (legacy) {
          const released = await http("/managed/release", {
            agent: "claude-code",
            bootId,
            sessionId,
            requestId: randomUUID(),
            expectedRevision: (await live(sessionId)).revision,
          });
          expect(released.status, JSON.stringify(released.body)).toBe(200);
          await rpc("claude.managed", {
            operation: "adopt",
            sessionId,
            requestId: randomUUID(),
            deviceId,
          });
          const resumedCatalog = await http("/catalog");
          expect(resumedCatalog.status, JSON.stringify(resumedCatalog.body)).toBe(200);
          expect(resumedCatalog.body.sessions.find((row: any) => row.id === sessionId)?.title).toBe(
            "Chosen managed title",
          );
        }
      },
    );

    it.skipIf(!claudeRelayEnabled)(
      "cross-repository real broker/frp WSS → RelayManager TLS → real Claude owner: HTTP, WebSocket, pairing and replay",
      async () => {
        const relay = await startClaudeRelay(join(directory, "relay"), port);
        try {
          await service.setRelayOrigins(relay.origin, relay.previewOrigin);
          let remoteCookie = "";
          let remoteCsrf = "";
          async function remote(
            path: string,
            body?: Record<string, unknown>,
            headers: Record<string, string> = {},
          ) {
            const result = await relay.http(`/api/web/v1${path}`, body, {
              Cookie: remoteCookie,
              "X-CSRF-Token": remoteCsrf,
              "X-AgentKib-Protocol": "2",
              ...headers,
            });
            return { ...result, body: JSON.parse(result.text) };
          }
          const access = await remote("/access");
          expect(access.status).toBe(200);
          remoteCookie = access.cookies![0]!.split(";")[0]!;
          remoteCsrf = access.body.csrfToken;
          const remoteBoot = access.body.bootId;
          const code = (await service.request({ operation: "generate-code", access: "full" })).code!
            .value;
          const paired = await remote("/pair", { code, name: "Offline relay phone" });
          expect(paired.status, paired.text).toBe(200);

          async function deniedSocket(headers: Record<string, string>) {
            const ws = relay.socket(headers);
            const [, response] = await once(ws, "unexpected-response");
            response.resume();
            ws.terminate();
            return response.statusCode;
          }
          expect(
            await deniedSocket({ Cookie: remoteCookie, Origin: "https://untrusted.example.org" }),
          ).toBe(403);
          expect(await deniedSocket({})).toBe(403);
          const unpaired = await remote(
            "/managed/create",
            {
              agent: "claude-code",
              bootId: remoteBoot,
              workspaceId: "workspace",
              requestId: randomUUID(),
            },
            { Cookie: "" },
          );
          expect(unpaired.status).toBe(401);

          const created = await remote("/managed/create", {
            agent: "claude-code",
            bootId: remoteBoot,
            workspaceId: "workspace",
            requestId: randomUUID(),
            deviceId: "spoofed-relay-device",
          });
          expect(created.status, created.text).toBe(200);
          const sessionId = created.body.sessionId as string;
          const state = await remote(`/live?sessionId=${sessionId}`);
          const requestId = randomUUID();
          const body = {
            sessionId,
            bootId: remoteBoot,
            requestId,
            expectedRevision: state.body.revision,
            text: "real relay offline input",
          };
          expect((await remote("/send", body)).status).toBe(200);
          await expect
            .poll(async () => (await remote(`/live?sessionId=${sessionId}`)).body.status)
            .toBe("idle");
          expect((await remote(`/requests/${requestId}`)).body).toMatchObject({
            found: true,
            completionObserved: true,
            executionMode: "claude-managed",
          });
          expect(
            await rpc("control.receipt", { deviceId: paired.body.device.id, requestId }),
          ).toMatchObject({ found: true });
          expect(
            await rpc("control.receipt", { deviceId: "spoofed-relay-device", requestId }),
          ).toMatchObject({ found: false });
          expect((await remote("/send", body)).status).toBe(200);
          expect(frames().filter((frame) => frame.type === "user")).toHaveLength(1);

          async function openSocket() {
            const ws = relay.socket({ Cookie: remoteCookie });
            await once(ws, "open");
            return {
              ws,
              async call(path: string, payload?: Record<string, unknown>, csrfToken = remoteCsrf) {
                const response = once(ws, "message");
                ws.send(
                  JSON.stringify({
                    id: randomUUID(),
                    path,
                    body: payload,
                    csrfToken,
                    protocolVersion: 2,
                  }),
                );
                return JSON.parse(String((await response)[0]));
              },
            };
          }
          const client = await openSocket();
          const options = await client.call(`/managed/settings?sessionId=${sessionId}`);
          expect(options.status).toBe(200);
          expect(options.body.options.models).toContainEqual(
            expect.objectContaining({ id: "fixture-model" }),
          );
          const beforeSettings = await remote(`/live?sessionId=${sessionId}`);
          expect(beforeSettings.status, beforeSettings.text).toBe(200);
          expect(Number.isSafeInteger(beforeSettings.body.revision), beforeSettings.text).toBe(
            true,
          );
          const settingsBody = {
            sessionId,
            bootId: remoteBoot,
            requestId: randomUUID(),
            expectedRevision: beforeSettings.body.revision,
            operation: "settings",
            permissionMode: "plan",
            effort: "high",
            model: "fixture-model",
          };
          expect(
            (await client.call("/managed/action", settingsBody, "incorrect-csrf")).status,
          ).toBe(403);
          const changed = await client.call("/managed/action", settingsBody);
          expect(changed.status, JSON.stringify(changed.body)).toBe(200);
          const settingsControls = frames().filter(
            (frame) => frame.type === "control_request",
          ).length;
          const closed = once(client.ws, "close");
          client.ws.close();
          await closed;
          const reconnect = await openSocket();
          expect((await reconnect.call(`/requests/${settingsBody.requestId}`)).body).toMatchObject({
            found: true,
          });
          expect((await reconnect.call(`/requests/${requestId}`)).body).toMatchObject({
            found: true,
            completionObserved: true,
          });
          expect(frames().filter((frame) => frame.type === "control_request")).toHaveLength(
            settingsControls,
          );
          expect((await reconnect.call("/managed/action", settingsBody)).status).toBe(200);
          expect((await reconnect.call("/send", body)).status).toBe(200);
          expect(frames().filter((frame) => frame.type === "control_request")).toHaveLength(
            settingsControls,
          );
          expect(frames().filter((frame) => frame.type === "user")).toHaveLength(1);
          const confirmed = await reconnect.call(`/managed/settings?sessionId=${sessionId}`);
          expect(confirmed.body.current).toMatchObject({
            modelId: "fixture-model",
            effort: "high",
            permissionMode: "plan",
          });
          // A conflicting control request conservatively freezes the current host
          // projection, so verify rejection after the successful continuation path.
          expect((await remote("/send", { ...body, text: "conflicting payload" })).status).not.toBe(
            200,
          );
          expect(frames().filter((frame) => frame.type === "user")).toHaveLength(1);
          await service.request({ operation: "revoke", id: paired.body.device.id });
          expect((await reconnect.call(`/requests/${requestId}`)).status).toBe(401);
          const reconnectedClosed = once(reconnect.ws, "close");
          reconnect.ws.close();
          await reconnectedClosed;
        } finally {
          await relay.close();
        }
      },
      45_000,
    );

    it("keeps ordinary settings reads passive and explicitly prepares settings without dispatching a command", async () => {
      const sessionId = await create();
      for (let i = 0; i < 3; i++) {
        const cached = await http(`/managed/settings?sessionId=${sessionId}`);
        expect(cached.status).toBe(200);
        expect(cached.body.options.models).toEqual([]);
      }
      expect(frames()).toEqual([]);
      const prepared = await prepareSettings(sessionId);
      expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
      expect(prepared.body.options.models[0].id).toBe("fixture-model");
      expect(frames().filter((row) => row.type === "control_request")).toHaveLength(1);
      expect(frames().filter((row) => row.type === "user")).toEqual([]);
      expect((await send(sessionId, "after explicit preparation")).status).toBe(200);
      await idle(sessionId);
    });

    it("publishes completed settings preparation to the actual subscriber without a live refresh or user turn", async () => {
      const sessionId = await create();
      const subscription = await rpc("sessions.subscribe", { sessionId });
      const states: Array<Record<string, unknown>> = [];
      sessionNotifications = (event) => {
        if (!event || typeof event !== "object") return;
        const value = event as {
          sessionId?: unknown;
          type?: unknown;
          payload?: Record<string, unknown>;
        };
        if (value.sessionId === sessionId && value.type === "state" && value.payload)
          states.push(structuredClone(value.payload));
      };
      try {
        const prepared = await prepareSettings(sessionId);
        expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
        expect(prepared.body.options.models[0].id).toBe("fixture-model");
        expect(states.some((state) => state.status === "starting")).toBe(true);
        expect(states.at(-1)).toMatchObject({
          status: "idle",
          sendEnabled: true,
          stopEnabled: false,
        });
        expect(frames().filter((row) => row.type === "control_request")).toHaveLength(1);
        expect(frames().filter((row) => row.type === "user")).toEqual([]);
      } finally {
        sessionNotifications = undefined;
        await rpc("sessions.unsubscribe", { subscriptionId: subscription.subscriptionId });
      }
    });

    it("publishes recovered idle to the actual subscriber while the settings startup request still reports failure", async () => {
      const sessionId = await create();
      const subscription = await rpc("sessions.subscribe", { sessionId });
      const states: Array<Record<string, unknown>> = [];
      sessionNotifications = (event) => {
        if (!event || typeof event !== "object") return;
        const value = event as {
          sessionId?: unknown;
          type?: unknown;
          payload?: Record<string, unknown>;
        };
        if (value.sessionId === sessionId && value.type === "state" && value.payload)
          states.push(structuredClone(value.payload));
      };
      try {
        writeFileSync(modeFile, "close-initialize");
        const prepared = await prepareSettings(sessionId);
        expect(prepared.status).toBeGreaterThanOrEqual(400);
        expect(prepared.body.error).toBeTruthy();
        expect(states.some((state) => state.status === "starting")).toBe(true);
        expect(states.at(-1)).toMatchObject({
          status: "idle",
          sendEnabled: true,
          executionLocation: null,
        });
        expect(frames().filter((row) => row.type === "control_request")).toHaveLength(1);
        expect(frames().filter((row) => row.type === "user")).toEqual([]);
      } finally {
        sessionNotifications = undefined;
        await rpc("sessions.unsubscribe", { subscriptionId: subscription.subscriptionId });
      }
    });

    it("rejects stale boot and unexpected fields before explicit settings preparation", async () => {
      const sessionId = await create();
      const body = { sessionId, bootId, expectedRevision: (await live(sessionId)).revision };
      expect((await http("/managed/settings-prepare", { ...body, bootId: "stale" })).status).toBe(
        409,
      );
      expect(
        (await http("/managed/settings-prepare", { ...body, permissionMode: "plan" })).status,
      ).toBe(400);
      expect(frames()).toEqual([]);
      expect((await prepareSettings(sessionId)).status).toBe(200);
    });

    it("requires CSRF and settings authorization before explicit preparation", async () => {
      const sessionId = await create();
      const originalCsrf = csrf;
      csrf = "incorrect-csrf";
      expect((await prepareSettings(sessionId)).status).toBe(403);
      csrf = originalCsrf;
      await service.request({ operation: "set-access", id: deviceId, access: "read" });
      expect(
        (
          await http("/managed/settings-prepare", {
            sessionId,
            bootId,
            expectedRevision: 0,
          })
        ).status,
      ).toBe(403);
      expect(frames()).toEqual([]);
    });

    it("applies actual discovered settings and next-priority input; replays advanced receipts without a second dispatch", async () => {
      const sessionId = await create();
      const options = await prepareSettings(sessionId);
      expect(options.status, JSON.stringify(options.body)).toBe(200);
      expect(options.body.options.models).toContainEqual(
        expect.objectContaining({ id: "fixture-model" }),
      );
      const requestId = randomUUID();
      const revision = (await live(sessionId)).revision;
      const body = {
        bootId,
        sessionId,
        operation: "settings",
        requestId,
        expectedRevision: revision,
        model: "fixture-model",
        effort: "high",
        permissionMode: "plan",
      };
      const changed = await http("/managed/action", body);
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect((await http("/managed/action", body)).status).toBe(200);
      expect((await http("/managed/action", { ...body, effort: "low" })).status).toBe(409);
      writeFileSync(modeFile, "hold");
      expect((await send(sessionId)).status).toBe(200);
      const running = await live(sessionId);
      const steer = await action(sessionId, "steer", { turnId: running.turnId, text: "follow up" });
      expect(steer.status, JSON.stringify(steer.body)).toBe(200);
      await idle(sessionId);
      expect(frames().filter((row) => row.type === "user")).toMatchObject([
        { uuid: running.turnId },
        { priority: "next", message: { content: "follow up" } },
      ]);
    });

    it("preserves the inherited native permission mode when HTTP changes only the model", async () => {
      writeFileSync(modeFile, "inherited-plan");
      const sessionId = await create();
      const options = await prepareSettings(sessionId);
      expect(options.status, JSON.stringify(options.body)).toBe(200);
      expect(options.body.current.permissionMode).toBe("plan");
      expect(options.body.selected.permissionMode ?? null).toBeNull();
      const changed = await action(sessionId, "settings", { model: "fixture-model" });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect(frames().filter((row) => row.request?.subtype === "set_permission_mode")).toEqual([]);
      const client = await socket();
      try {
        const refreshed = await client.call(`/managed/settings?sessionId=${sessionId}`);
        expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
        expect(refreshed.body.current.permissionMode).toBe("plan");
        expect(refreshed.body.selected.permissionMode ?? null).toBeNull();
        expect(refreshed.body.selected.modelId).toBe("fixture-model");
      } finally {
        client.ws.close();
        await once(client.ws, "close");
      }
    });

    it("takes /model's name in any case or as a full model ID and refuses an unlisted model or effort", async () => {
      const sessionId = await create();
      await prepareSettings(sessionId);
      const selected = async () =>
        (await http(`/managed/settings?sessionId=${sessionId}`)).body.selected;
      // `/model` sends the name as typed; the listed alias is what is kept.
      const byCase = await action(sessionId, "settings", { model: "LOW-MODEL" });
      expect(byCase.status, JSON.stringify(byCase.body)).toBe(200);
      expect(await selected()).toMatchObject({ modelId: "low-model" });
      const byId = await action(sessionId, "settings", {
        model: "Fixture-Resolved-Model",
        effort: "high",
      });
      expect(byId.status, JSON.stringify(byId.body)).toBe(200);
      expect(await selected()).toMatchObject({ modelId: "fixture-model", effort: "high" });
      const controls = frames().filter((row) => row.type === "control_request").length;
      for (const [payload, error] of [
        [{ model: "no-such-model" }, "unsupported_model"],
        [{ model: "low-model", effort: "high" }, "unsupported_effort"],
        [{ effort: "max" }, "unsupported_effort"],
      ] as const) {
        const refused = await action(sessionId, "settings", payload);
        expect(refused.status, JSON.stringify(refused.body)).toBe(400);
        expect(refused.body).toMatchObject({ error, controlOutcome: "not-dispatched" });
      }
      expect(frames().filter((row) => row.type === "control_request")).toHaveLength(controls);
      expect(await selected()).toMatchObject({ modelId: "fixture-model", effort: "high" });
    });

    it.each(["inherited-plan", "inherited-alias"])(
      "applies effort alone for a native inherited model (%s)",
      async (mode) => {
        writeFileSync(modeFile, mode);
        const sessionId = await create();
        const options = await prepareSettings(sessionId);
        expect(options.status).toBe(200);
        expect(options.body.selected.modelId).toBeUndefined();
        expect(options.body.current.modelId).toBe(
          mode === "inherited-alias" ? "fixture-resolved-model" : "fixture-model",
        );
        expect(options.body.options.models[0].resolvedModel).toBe("fixture-resolved-model");
        const changed = await action(sessionId, "settings", { effort: "high" });
        expect(changed.status, JSON.stringify(changed.body)).toBe(200);
        expect(
          frames().filter((row) =>
            ["set_model", "set_permission_mode"].includes(row.request?.subtype),
          ),
        ).toEqual([]);
        expect(
          frames().filter((row) => row.request?.subtype === "apply_flag_settings"),
        ).toMatchObject([{ request: { settings: { effortLevel: "high" } } }]);
      },
    );

    it.each(["low-model", "no-effort-model"])(
      "clears an incompatible effort when selecting %s without resetting permissions",
      async (model) => {
        const sessionId = await create();
        await prepareSettings(sessionId);
        const configured = await action(sessionId, "settings", {
          model: "fixture-model",
          effort: "high",
          permissionMode: "plan",
        });
        expect(configured.status, JSON.stringify(configured.body)).toBe(200);
        const changed = await action(sessionId, "settings", { model, effort: null });
        expect(changed.status, JSON.stringify(changed.body)).toBe(200);
        const state = (await http(`/managed/settings?sessionId=${sessionId}`)).body;
        expect(state.applicationStatus).toBe("confirmed");
        expect(state.selected).toEqual({ modelId: model, permissionMode: "plan" });
        const args = frames()
          .filter((row) => row.args)
          .at(-1).args;
        expect(args).toEqual(
          expect.arrayContaining(["--model", model, "--permission-mode", "plan"]),
        );
        expect(args).not.toContain("--effort");
        expect(frames().filter((row) => row.type === "user")).toEqual([]);
      },
    );

    it("clears only effort through WebSocket with an idempotent durable receipt", async () => {
      const sessionId = await create();
      await prepareSettings(sessionId);
      expect(
        (
          await action(sessionId, "settings", {
            model: "fixture-model",
            effort: "high",
            permissionMode: "plan",
          })
        ).status,
      ).toBe(200);
      const client = await socket();
      try {
        const body = {
          sessionId,
          operation: "settings",
          bootId,
          expectedRevision: (await live(sessionId)).revision,
          requestId: randomUUID(),
          effort: null,
        };
        const cleared = await client.call("/managed/action", body);
        expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
        const launches = frames().filter((row) => row.args).length;
        expect((await client.call("/managed/action", body)).status).toBe(200);
        expect(frames().filter((row) => row.args)).toHaveLength(launches);
        const conflict = { ...body } as Record<string, unknown>;
        delete conflict.effort;
        expect((await client.call("/managed/action", conflict)).status).toBe(409);
        const settings = await client.call(`/managed/settings?sessionId=${sessionId}`);
        expect(settings.body.selected).toEqual({
          modelId: "fixture-model",
          permissionMode: "plan",
        });
        expect(settings.body.current.effort).toBeUndefined();
      } finally {
        client.ws.close();
        await once(client.ws, "close");
      }
    });

    it("persists queue order, resumes after restart without confirmation, and consumes one item at a time", async () => {
      const sessionId = await create();
      expect((await action(sessionId, "queue-add", { text: "first" })).status).toBe(200);
      expect((await action(sessionId, "queue-add", { text: "second" })).status).toBe(200);
      const queue = (await http(`/managed/queue?sessionId=${sessionId}`)).body.data;
      expect(queue.map((item: any) => item.text)).toEqual(["first", "second"]);
      expect(
        (
          await action(sessionId, "queue-reorder", {
            queuedSubmissionIds: queue.map((item: any) => item.id).reverse(),
          })
        ).status,
      ).toBe(200);
      await backend.close();
      await startBackend();
      service.runtimeUnavailable();
      bootId = (await http("/access")).body.bootId;
      await shared.claudeScheduler!.tick();
      expect(frames().filter((row) => row.type === "user")).toHaveLength(0);
      expect((await http(`/managed/queue?sessionId=${sessionId}`)).body.requiresResume).toBe(true);
      const resume = await action(sessionId, "queue-resume");
      expect(resume.status, JSON.stringify(resume.body)).toBe(200);
      await shared.claudeScheduler!.tick();
      await idle(sessionId);
      await shared.claudeScheduler!.tick();
      await idle(sessionId);
      expect(
        frames()
          .filter((row) => row.type === "user")
          .map((row) => row.message.content),
      ).toEqual(["second", "first"]);
    });

    it("keeps goal completion pending until a bound MCP report and native success both exist", async () => {
      const sessionId = await create();
      expect(
        (await action(sessionId, "goal-set", { objective: "verify synthetic outcome" })).status,
      ).toBe(200);
      await shared.claudeScheduler!.tick();
      await idle(sessionId);
      const goal = await http(`/managed/goals?sessionId=${sessionId}`);
      expect(goal.body.goal, JSON.stringify(goal.body)).toMatchObject({ status: "completed" });
      expect(
        frames().some(
          (row) => row.report?.result?.isError === false || row.report?.result?.content,
        ),
      ).toBe(true);
      await shared.claudeScheduler!.tick();
      expect(frames().filter((row) => row.type === "user")).toHaveLength(1);
    });

    it.each(["no-report", "missing-usage", "continue"])(
      "pauses or exhausts goal automation for %s",
      async (mode) => {
        writeFileSync(modeFile, mode);
        const sessionId = await create();
        expect(
          (
            await action(sessionId, "goal-set", {
              objective: "bounded fixture",
              tokenBudget: mode === "continue" ? 10 : 100,
            })
          ).status,
        ).toBe(200);
        await shared.claudeScheduler!.tick();
        await idle(sessionId);
        const result = await rpc("web.request", { operation: "goal", sessionId });
        expect(result.goal.status).toBe(mode === "continue" ? "budget-exhausted" : "paused");
        await shared.claudeScheduler!.tick();
        expect(frames().filter((row) => row.type === "user")).toHaveLength(1);
        if (mode === "missing-usage") {
          expect((await action(sessionId, "goal-resume")).status).toBe(409);
          expect(
            (
              await action(sessionId, "goal-set", {
                intent: "update",
                objective: "updated bounded fixture",
              })
            ).status,
          ).toBe(200);
          expect((await rpc("web.request", { operation: "goal", sessionId })).goal).toMatchObject({
            tokenBudget: 100,
            usageIncomplete: true,
          });
          expect((await action(sessionId, "goal-resume")).status).toBe(409);
          await shared.claudeScheduler!.tick();
          expect(frames().filter((row) => row.type === "user")).toHaveLength(1);
          expect(
            (
              await action(sessionId, "goal-set", {
                intent: "update",
                objective: "explicitly unbounded fixture",
                tokenBudget: null,
              })
            ).status,
          ).toBe(200);
          expect((await action(sessionId, "goal-resume")).status).toBe(200);
          writeFileSync(modeFile, "ordinary");
          await shared.claudeScheduler!.tick();
          await idle(sessionId);
          expect(frames().filter((row) => row.type === "user")).toHaveLength(2);
        }
      },
    );

    it("does not dispatch queued work after the originating device is revoked", async () => {
      const sessionId = await create();
      expect((await action(sessionId, "queue-add", { text: "never execute" })).status).toBe(200);
      await service.request({ operation: "revoke", id: deviceId });
      await shared.claudeScheduler!.tick();
      expect(frames().filter((row) => row.type === "user")).toHaveLength(0);
      const state = await rpc("claude.managed", { operation: "schedule-list", sessionId });
      expect(state.sessions[0].paused).toBe(true);
    });

    it.each(["approval", "question"])(
      "keeps native %s correlated with the actual turn and device",
      async (mode) => {
        writeFileSync(modeFile, mode);
        const sessionId = await create();
        expect((await send(sessionId)).status).toBe(200);
        await expect
          .poll(async () => (await live(sessionId)).status)
          .toBe(mode === "approval" ? "waiting-approval" : "waiting-input");
        const state = await live(sessionId);
        const route = mode === "approval" ? "/approve" : "/answer";
        const body = {
          bootId,
          sessionId,
          requestId: randomUUID(),
          expectedRevision: state.revision,
          turnId: state.turnId,
          ...(mode === "approval"
            ? { approvalId: "approval-native", decision: "allow" }
            : { questionId: "question-native", answers: { "Choose fixture?": ["A"] } }),
        };
        const response = await http(route, body);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        await idle(sessionId);
        const native = frames().find((row) => row.type === "control_response");
        expect(native.response.request_id).toBe(
          mode === "approval" ? "approval-native" : "question-native",
        );
        expect((await http(route, { ...body, requestId: randomUUID() })).status).toBe(409);
      },
    );

    it("stops a running turn and pauses subsequent queued automation", async () => {
      writeFileSync(modeFile, "hold");
      const sessionId = await create();
      expect((await send(sessionId)).status).toBe(200);
      expect((await action(sessionId, "queue-add", { text: "wait for confirmation" })).status).toBe(
        200,
      );
      const state = await live(sessionId);
      const stopped = await http("/stop", {
        bootId,
        sessionId,
        requestId: randomUUID(),
        expectedRevision: state.revision,
        turnId: state.turnId,
      });
      expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
      await shared.claudeScheduler!.tick();
      expect(frames().filter((row) => row.type === "user")).toHaveLength(1);
      expect((await http(`/managed/queue?sessionId=${sessionId}`)).body.paused).toBe(true);
    });

    it("freezes attachments in a queue entry while another turn is running", async () => {
      writeFileSync(modeFile, "hold");
      const sessionId = await create();
      expect((await send(sessionId)).status).toBe(200);
      const attachment = await upload(sessionId);
      const queued = await action(sessionId, "queue-add", {
        text: "after this turn",
        attachmentIds: [attachment.id],
      });
      expect(queued.status, JSON.stringify(queued.body)).toBe(200);
      const queue = (await http(`/managed/queue?sessionId=${sessionId}`)).body.data;
      expect(queue).toHaveLength(1);
      expect(queue[0].hasAttachments).toBe(true);
      expect(
        (
          await action(sessionId, "queue-update", {
            queuedSubmissionId: queue[0].id,
            text: "replace attachment",
          })
        ).status,
      ).toBe(409);
      const running = await live(sessionId);
      expect(
        (
          await action(sessionId, "steer", {
            turnId: running.turnId,
            text: "finish this turn",
            attachmentIds: [attachment.id],
          })
        ).status,
      ).toBe(200);
      await idle(sessionId);
      writeFileSync(modeFile, "ordinary");
      await shared.claudeScheduler!.tick();
      await idle(sessionId);
      expect(frames()).toContainEqual({ attachmentBytes: "persistent attachment" });
      const store = new AttachmentStore(join(directory, "host", "attachments"));
      expect(await store.pendingRequests(sessionId)).toHaveLength(0);
    });

    it("rejects adding attachments while editing a text queue entry without pinning them", async () => {
      const sessionId = await create();
      await action(sessionId, "queue-add", { text: "original text" });
      const queued = (await http(`/managed/queue?sessionId=${sessionId}`)).body.data[0];
      const attachment = await upload(sessionId);
      const changed = await action(sessionId, "queue-update", {
        queuedSubmissionId: queued.id,
        text: "replacement",
        attachmentIds: [attachment.id],
      });
      expect(changed.status).toBe(409);
      expect(changed.body.error).toBe("queue_attachments_edit_unsupported");
      const store = new AttachmentStore(join(directory, "host", "attachments"));
      expect(await store.pendingRequests(sessionId)).toHaveLength(0);
      const queue = (await http(`/managed/queue?sessionId=${sessionId}`)).body.data;
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({ text: "original text", hasAttachments: false });
      expect(frames().filter((row) => row.type === "user")).toHaveLength(0);
    });

    it("persists rejected queue mutations as not-dispatched without blocking later controls", async () => {
      const sessionId = await create();
      await action(sessionId, "queue-add", { text: "keep this pending" });
      const state = await live(sessionId);
      const rejected = {
        bootId,
        sessionId,
        operation: "queue-reorder",
        requestId: randomUUID(),
        expectedRevision: state.revision,
        queuedSubmissionIds: [],
      };
      const first = await http("/managed/action", rejected);
      expect(first.status, JSON.stringify(first.body)).toBe(409);
      expect(first.body.controlOutcome).toBe("not-dispatched");
      const receipt = await http(`/requests/${rejected.requestId}`);
      expect(receipt.body).toMatchObject({ found: true, status: "not-dispatched" });
      const replay = await http("/managed/action", rejected);
      expect(replay.status).toBe(409);
      expect(replay.body.controlOutcome).toBe("not-dispatched");
      const queue = (await http(`/managed/queue?sessionId=${sessionId}`)).body.data;
      const changed = await http("/managed/action", {
        ...rejected,
        queuedSubmissionIds: [queue[0].id],
      });
      expect(changed.body.error).toBe("request_id_conflict");
      expect(
        (await action(sessionId, "queue-reorder", { queuedSubmissionIds: [queue[0].id] })).status,
      ).toBe(200);
      expect(frames().filter((row) => row.type === "user")).toHaveLength(0);
    });

    it("keeps dispatched queue entries immutable while reordering the remaining pending work", async () => {
      const sessionId = await create();
      for (const text of ["first", "second", "third"])
        expect((await action(sessionId, "queue-add", { text })).status).toBe(200);
      writeFileSync(modeFile, "hold");
      await shared.claudeScheduler!.tick();
      const queued = (await http(`/managed/queue?sessionId=${sessionId}`)).body.data;
      expect(queued.map((item: any) => item.status)).toEqual(["dispatched", "pending", "pending"]);
      expect(
        (
          await action(sessionId, "queue-reorder", {
            queuedSubmissionIds: [queued[2].id, queued[1].id],
          })
        ).status,
      ).toBe(200);
      const reordered = (await http(`/managed/queue?sessionId=${sessionId}`)).body.data;
      expect(reordered.map((item: any) => item.text)).toEqual(["first", "third", "second"]);
      for (const operation of ["queue-update", "queue-delete"])
        expect(
          (
            await action(sessionId, operation, {
              queuedSubmissionId: queued[0].id,
              ...(operation === "queue-update" ? { text: "cannot replace running input" } : {}),
            })
          ).status,
        ).toBe(409);
      const state = await live(sessionId);
      expect(
        (
          await http("/stop", {
            bootId,
            sessionId,
            requestId: randomUUID(),
            expectedRevision: state.revision,
            turnId: state.turnId,
          })
        ).status,
      ).toBe(200);
    });

    it("uses the same real owner, receipts and revocation on WebSocket frames and reconnect", async () => {
      const sessionId = await create();
      const client = await socket();
      const settings = await client.call("/managed/settings-prepare", {
        sessionId,
        bootId,
        expectedRevision: (await live(sessionId)).revision,
      });
      expect(settings.status).toBe(200);
      expect(settings.body.options.models[0].id).toBe("fixture-model");
      const queued = await client.call("/managed/action", {
        bootId,
        sessionId,
        requestId: randomUUID(),
        expectedRevision: (await live(sessionId)).revision,
        operation: "queue-add",
        text: "websocket queued input",
      });
      expect(queued.status, JSON.stringify(queued.body)).toBe(200);
      const list = await client.call(`/managed/queue?sessionId=${sessionId}`);
      expect(list.body.data[0].text).toBe("websocket queued input");
      expect(
        (
          await client.call("/managed/action", {
            bootId,
            sessionId,
            requestId: randomUUID(),
            expectedRevision: (await live(sessionId)).revision,
            operation: "queue-delete",
            queuedSubmissionId: list.body.data[0].id,
          })
        ).status,
      ).toBe(200);
      const requestId = randomUUID();
      const state = await live(sessionId);
      const body = {
        bootId,
        sessionId,
        requestId,
        expectedRevision: state.revision,
        text: "websocket input",
      };
      const result = await client.call("/send", body);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      await idle(sessionId);
      client.ws.close();
      await once(client.ws, "close");
      const reconnect = await socket();
      const receipt = await reconnect.call(`/requests/${requestId}`);
      expect(receipt.body).toMatchObject({ found: true, completionObserved: true });
      expect((await reconnect.call("/send", body)).status).toBe(200);
      expect(frames().filter((row) => row.type === "user")).toHaveLength(1);
      await service.request({ operation: "revoke", id: deviceId });
      const denied = await reconnect.call("/managed/action", {
        bootId,
        sessionId,
        requestId: randomUUID(),
        expectedRevision: state.revision,
        operation: "queue-add",
        text: "revoked",
      });
      expect(denied.status).toBe(401);
      reconnect.ws.close();
      await once(reconnect.ws, "close");
    });

    it("keeps a rejected native settings acknowledgement unknown and never replays its controls", async () => {
      const sessionId = await create();
      await prepareSettings(sessionId);
      writeFileSync(modeFile, "settings-rejected");
      const requestId = randomUUID();
      const body = {
        bootId,
        sessionId,
        requestId,
        operation: "settings",
        expectedRevision: (await live(sessionId)).revision,
        permissionMode: "plan",
      };
      const result = await http("/managed/action", body);
      expect(result.body.controlOutcome).toBe("unknown");
      const receipt = await http(`/requests/${requestId}`);
      expect(receipt.body).toMatchObject({
        found: true,
        status: "unknown",
        completionObserved: false,
      });
      const controls = frames().filter((row) => row.type === "control_request").length;
      expect((await http("/managed/action", body)).body.controlOutcome).toBe("unknown");
      await shared.claudeScheduler!.tick();
      expect(frames().filter((row) => row.type === "control_request")).toHaveLength(controls);
      expect(frames().filter((row) => row.type === "user")).toHaveLength(0);
    });

    it("filters sensitive resources and rejects changed file and directory references before dispatch", async () => {
      const sessionId = await create();
      for (const name of [".env", "credentials", "id_rsa"])
        writeFileSync(join(workspace, name), "SYNTHETIC_PRIVATE_CONTENT");
      linkSync(join(workspace, ".env"), join(workspace, "public-alias.txt"));
      symlinkSync(join(workspace, ".env"), join(workspace, "public-link.txt"));
      mkdirSync(join(workspace, "context"));
      writeFileSync(join(workspace, "context", "file.txt"), "safe nested content");
      const resources = await http(`/managed/resources?sessionId=${sessionId}`);
      expect(resources.status, JSON.stringify(resources.body)).toBe(200);
      expect(resources.body.resources.map((item: any) => item.name).sort()).toEqual([
        "context",
        "notes.txt",
      ]);
      const file = resources.body.resources.find((item: any) => item.name === "notes.txt");
      writeFileSync(join(workspace, "notes.txt"), "changed since selection");
      const changed = await send(sessionId, "use selected file", { resourceIds: [file.id] });
      expect(changed.status, JSON.stringify(changed.body)).toBe(409);
      const folder = resources.body.resources.find((item: any) => item.name === "context");
      rmSync(join(workspace, "context"), { recursive: true });
      symlinkSync(directory, join(workspace, "context"));
      const replaced = await send(sessionId, "use selected directory", {
        resourceIds: [folder.id],
      });
      expect([403, 409]).toContain(replaced.status);
      expect(frames().filter((row) => row.type === "user")).toHaveLength(0);
    });

    it("references actual workspace files, renames native history, forks lazily and keeps archive scheduling paused", async () => {
      const sessionId = await create();
      const resources = await http(`/managed/resources?sessionId=${sessionId}`);
      expect(resources.status, JSON.stringify(resources.body)).toBe(200);
      const reference = resources.body.resources.find((item: any) => item.name === "notes.txt");
      expect(reference).toBeDefined();
      const sent = await send(sessionId, "read the reference", { resourceIds: [reference.id] });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      await idle(sessionId);
      expect(JSON.stringify(frames().find((row) => row.type === "user").message.content)).toContain(
        "workspace reference",
      );
      const rename = await action(sessionId, "rename", { name: "Renamed fixture" });
      expect(rename.status, JSON.stringify(rename.body)).toBe(200);
      const nativeId = (await live(sessionId)).sourceSessionId;
      const transcript = join(
        environment.CLAUDE_CONFIG_DIR!,
        "projects",
        workspace.replace(/[^a-zA-Z0-9]/g, "-"),
        `${nativeId}.jsonl`,
      );
      expect(readFileSync(transcript, "utf8")).toContain('"customTitle":"Renamed fixture"');
      const before = frames().filter((row) => row.type === "user").length;
      const fork = await action(sessionId, "fork");
      expect(fork.status, JSON.stringify(fork.body)).toBe(200);
      expect(frames().filter((row) => row.type === "user")).toHaveLength(before);
      const child = fork.body.sessionId;
      expect(child).not.toBe(sessionId);
      // A fresh fork has no child transcript yet. All normal page/settings reads remain
      // available and passive; a read failure must not be hidden by the conversation banner.
      const beforeReads = frames().length;
      for (const endpoint of [
        "live",
        "events",
        "managed/capabilities",
        "managed/inspect",
        "managed/context",
        "managed/settings",
        "managed/queue",
        "managed/goals",
        "managed/resources",
      ]) {
        const response = await http(
          `/${endpoint}?sessionId=${child}${endpoint.startsWith("managed/") ? "&agent=claude-code" : ""}`,
        );
        expect(response.status, `${endpoint}: ${JSON.stringify(response.body)}`).toBe(200);
      }
      expect(frames()).toHaveLength(beforeReads);
      const forkCatalog = await http("/catalog");
      expect(forkCatalog.status, JSON.stringify(forkCatalog.body)).toBe(200);
      expect(forkCatalog.body.sessions.find((row: any) => row.id === child)).toMatchObject({
        title: "Renamed fixture",
        forked_from_session_id: sessionId,
      });
      const forkRecord = JSON.parse(
        readFileSync(join(data, "claude-managed", `${child}.json`), "utf8"),
      );
      expect(forkRecord.nativeTitle).toBeUndefined();
      expect((await send(child, "fork continuation")).status).toBe(200);
      await idle(child);
      const completedCatalog = await http("/catalog");
      expect(completedCatalog.status, JSON.stringify(completedCatalog.body)).toBe(200);
      expect(completedCatalog.body.sessions.find((row: any) => row.id === child)).toMatchObject({
        title: "Renamed fixture",
        forked_from_session_id: sessionId,
      });
      expect(
        frames()
          .filter((row) => row.args)
          .at(-1).args,
      ).toEqual(expect.arrayContaining([`--resume=${nativeId}`, "--fork-session"]));
      // A parent's already-persisted rename must not suppress writing the same title to its child.
      expect((await action(child, "rename", { name: "Renamed fixture" })).status).toBe(200);
      const childTranscript = join(
        environment.CLAUDE_CONFIG_DIR!,
        "projects",
        workspace.replace(/[^a-zA-Z0-9]/g, "-"),
        `${fork.body.sourceSessionId}.jsonl`,
      );
      expect(readFileSync(childTranscript, "utf8")).toContain('"customTitle":"Renamed fixture"');
      expect((await action(sessionId, "archive")).status).toBe(200);
      expect((await live(sessionId)).status).toBe("archived");
      expect((await action(sessionId, "unarchive")).status).toBe(200);
      expect((await http(`/managed/queue?sessionId=${sessionId}`)).body.requiresResume).toBe(true);
      expect(existsSync(transcript)).toBe(true);
    });

    it("preserves the native fork boundary when the first child send automatically resumes after release", async () => {
      const sessionId = await create();
      expect((await send(sessionId, "parent turn")).status).toBe(200);
      await idle(sessionId);
      const nativeId = (await live(sessionId)).sourceSessionId;
      const transcript = join(
        environment.CLAUDE_CONFIG_DIR!,
        "projects",
        workspace.replace(/[^a-zA-Z0-9]/g, "-"),
        `${nativeId}.jsonl`,
      );
      const cutoff = readFileSync(transcript, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .findLast((row) => row.type === "assistant").uuid;
      const fork = await action(sessionId, "fork");
      expect(fork.status, JSON.stringify(fork.body)).toBe(200);
      const child = fork.body.sessionId;
      const childState = await live(child);
      const release = await http("/managed/release", {
        agent: "claude-code",
        sessionId: child,
        bootId,
        expectedRevision: childState.revision,
        requestId: randomUUID(),
      });
      expect(release.status, JSON.stringify(release.body)).toBe(200);
      expect((await live(child)).sourceSessionId).toBe(childState.sourceSessionId);
      expect(frames().filter((row) => row.type === "user")).toHaveLength(1);
      expect((await send(child, "fork continuation after automatic resume")).status).toBe(200);
      await idle(child);
      expect(
        frames()
          .filter((row) => row.args)
          .at(-1).args,
      ).toEqual(
        expect.arrayContaining([
          `--resume=${nativeId}`,
          "--fork-session",
          `--session-id=${childState.sourceSessionId}`,
          `--resume-session-at=${cutoff}`,
        ]),
      );
    });

    it("keeps queued attachment pins across both host and backend restart, then settles the original receipt", async () => {
      const sessionId = await create();
      const attachment = await upload(sessionId);
      const requestId = randomUUID();
      const queued = await action(sessionId, "queue-add", {
        text: "attached",
        attachmentIds: [attachment.id],
        requestId,
      });
      expect(queued.status, JSON.stringify(queued.body)).toBe(200);
      const store = new AttachmentStore(join(directory, "host", "attachments"));
      expect(await store.pendingRequests(sessionId)).toEqual([
        expect.objectContaining({ deviceId, requestId }),
      ]);
      await service.dispose();
      await backend.close();
      await startBackend();
      await startService();
      const access = await http("/access");
      csrf = access.body.csrfToken;
      bootId = access.body.bootId;
      expect(await store.pendingRequests(sessionId)).toHaveLength(1);
      await shared.claudeScheduler!.tick();
      expect(frames().filter((row) => row.type === "user")).toHaveLength(0);
      const resumed = await action(sessionId, "queue-resume");
      expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
      await shared.claudeScheduler!.tick();
      await idle(sessionId);
      await shared.claudeScheduler!.tick();
      expect((await http(`/requests/${requestId}`)).body.completionObserved).toBe(true);
      expect(await store.pendingRequests(sessionId)).toHaveLength(0);
      expect(frames()).toContainEqual({ attachmentBytes: "persistent attachment" });
    });

    it("stops queue consumption when the native terminal is lost after input dispatch", async () => {
      expectUnknownCleanup = true;
      const sessionId = await create();
      writeFileSync(modeFile, "terminal-lost");
      expect((await action(sessionId, "queue-add", { text: "uncertain" })).status).toBe(200);
      expect((await action(sessionId, "queue-add", { text: "must wait" })).status).toBe(200);
      await shared.claudeScheduler!.tick();
      await expect.poll(async () => (await live(sessionId)).status).toBe("outcome-unknown");
      await shared.claudeScheduler!.tick();
      expect(frames().filter((row) => row.type === "user")).toHaveLength(1);
      expect((await http(`/managed/queue?sessionId=${sessionId}`)).body.paused).toBe(true);
    });
  },
);
