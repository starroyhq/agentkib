// @vitest-environment node
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RUNTIME_METHODS,
  type HistoryLocatedRecord,
  type HistoryReference,
  type HistorySearchResult,
} from "@agentkib/runtime-protocol";
import { BackendStore } from "../../../packages/backend/src/store";
import { acquirePortableFileLease } from "../../../packages/backend/src/managed-session-lock";
import { DesktopRuntimeHost } from "../electron/main/runtime-host";
import { RuntimeRouter } from "../electron/main/runtime-router";
import { createStdioTransport } from "../electron/main/runtime-transport";
import { WebAccessService } from "../electron/main/web/service";

const { createIsolatedWorkerEnvironment } = createRequire(import.meta.url)(
  "../scripts/backend-worker-smoke-environment.cjs",
) as { createIsolatedWorkerEnvironment(root: string): NodeJS.ProcessEnv };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Frame = {
  method: string;
  params: Record<string, unknown>;
  type?: string;
  uuid?: string;
  message?: { role: string; content: unknown };
};
type Live = { revision: number; runtimeBootId: string; turnId: string | null; status: string };
const sourceBody = "Historical decision native-marker-73ad: preserve the blue release channel. 🙂";

// Only the external CLI boundary is synthetic. The packaged Backend owns command
// admission, the durable ledger and native writes; references use its real Workers.
const appServer = String.raw`
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.147.0');
  process.exit(0);
}
const fs = require('node:fs');
const readline = require('node:readline');
const id = process.env.FIXTURE_NATIVE_ID;
const cwd = process.cwd();
const frame = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const thread = () => ({ id, cwd, turns: [], status: { type: 'idle' } });
const input = readline.createInterface({ input: process.stdin });
input.on('close', () => {
  if (process.env.FIXTURE_DELAY_EXIT === '1') setTimeout(() => {
    fs.writeFileSync(process.env.FIXTURE_EXIT_FILE, 'closed');
    process.exit(0);
  }, 150);
});
input.on('line', (line) => {
  const request = JSON.parse(line), p = request.params || {};
  fs.appendFileSync(process.env.FIXTURE_FRAMES, JSON.stringify(request) + '\n');
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case 'initialize': result = {}; break;
    case 'model/list': result = { data: [{ model: 'offline-model', isDefault: true, supportedReasoningEfforts: [] }] }; break;
    case 'thread/start':
    case 'thread/resume': result = { thread: thread(), cwd, model: 'offline-model', reasoningEffort: null, serviceTier: null,
      approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false,
        excludeTmpdirEnvVar: true, excludeSlashTmp: true } }; break;
    case 'thread/read': result = { thread: thread() }; break;
    case 'thread/goal/get': result = { goal: null }; break;
    case 'turn/start':
      // Close after recording the actual received native frame, before any ack.
      if (fs.readFileSync(process.env.FIXTURE_MODE, 'utf8') === 'disconnect') process.exit(0);
      result = { turn: { id: 'offline-turn', status: 'inProgress' } }; break;
    case 'turn/steer': result = { turnId: p.expectedTurnId }; break;
    case 'thread/queue/add': result = { queuedSubmission: { id: 'offline-queued', clientUserMessageId: p.clientUserMessageId, input: p.input } }; break;
    case 'thread/queue/list': result = { data: [], nextCursor: null }; break;
    case 'turn/interrupt': result = {}; break;
    default: frame({ id: request.id, error: { code: -32601, message: 'unexpected-offline-method' } }); return;
  }
  frame({ id: request.id, result });
});
`;

const claudeCli = String.raw`
if (process.argv.includes('--version')) {
  console.log('2.1.286 (Claude Code)');
  process.exit(0);
}
const fs = require('node:fs');
const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const value = JSON.parse(line);
  fs.appendFileSync(process.env.FIXTURE_FRAMES, JSON.stringify(value) + '\n');
  if (value.type === 'control_request')
    send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id } });
  else if (value.type === 'user') {
    send({ type: 'assistant', session_id: value.session_id, parent_tool_use_id: null,
      message: { id: value.uuid, model: 'offline-model', content: [{ type: 'text', text: 'Offline acknowledgement' }] } });
    send({ type: 'result', session_id: value.session_id, subtype: 'success' });
  }
});
`;

async function fixture(agent: "codex" | "claude-code" = "codex", delayExit = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "history-native-send-")));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data"),
    workspace = path.join(root, "project"),
    dist = path.join(root, "dist"),
    bin = path.join(root, "bin"),
    history = path.join(root, ".claude/projects/fixture");
  await Promise.all(
    [dataDir, workspace, dist, bin, history, path.join(root, ".codex"), path.join(root, "tmp")].map(
      (directory) => fs.mkdir(directory, { recursive: true }),
    ),
  );
  const sourceNative = randomUUID(),
    nativeId = randomUUID(),
    timestamp = "2026-10-08T00:00:00Z",
    sourceFile = path.join(history, `${sourceNative}.jsonl`),
    source = {
      type: "assistant",
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: sourceNative,
      cwd: workspace,
      timestamp,
      message: { role: "assistant", content: sourceBody },
    };
  await fs.writeFile(sourceFile, JSON.stringify(source) + "\n");
  const store = new BackendStore(path.join(dataDir, "agentkib.db"));
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
    "fixture",
    workspace,
    "Fixture",
    "fixture",
    "healthy",
    timestamp,
  );
  store.sessions.sync("fixture", "claude-code", [
    {
      native_ref: sourceNative,
      agent: "claude-code",
      title: "Source decision",
      created_at: timestamp,
      updated_at: timestamp,
      message_count: 1,
      git_branch: null,
      archived: false,
      sidechain: false,
      availability: "readable",
      origin: "interactive",
    },
  ]);
  store.close();

  const framesFile = path.join(root, "frames.jsonl"),
    modeFile = path.join(root, "mode"),
    exitFile = path.join(root, "native-closed"),
    script = path.join(bin, "app-server.cjs");
  await fs.writeFile(framesFile, "");
  await fs.writeFile(modeFile, "respond");
  await fs.writeFile(script, agent === "codex" ? appServer : claudeCli);
  const command = agent === "codex" ? "codex" : "claude";
  const executable = path.join(bin, process.platform === "win32" ? `${command}.CMD` : command);
  await fs.writeFile(
    executable,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`,
    { mode: 0o700 },
  );
  const environment = {
    ...createIsolatedWorkerEnvironment(root),
    PATH: bin,
    AGENTKIB_SEARCH_PASS_INTERVAL_MS: "0",
    AGENTKIB_SEARCH_RETRY_WAIT_MS: "0",
    FIXTURE_NATIVE_ID: nativeId,
    FIXTURE_FRAMES: framesFile,
    FIXTURE_MODE: modeFile,
    FIXTURE_DELAY_EXIT: delayExit ? "1" : "0",
    FIXTURE_EXIT_FILE: exitFile,
  };
  if (process.platform === "win32") {
    if (!environment.SystemRoot) throw new Error("Windows fixture requires SystemRoot");
    // Keep Agent discovery isolated while allowing the Windows command interpreter.
    environment.PATH += path.delimiter + path.join(environment.SystemRoot, "System32");
  }
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  await fs.writeFile(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({
      mcp_network: { port, lan_enabled: false, lan_risk_accepted: false },
      session_index_enabled: true,
    }),
  );
  for (const name of await fs.readdir("dist-electron"))
    if (name.startsWith("backend") && name.endsWith(".cjs"))
      await fs.copyFile(path.join("dist-electron", name), path.join(dist, name));
  await fs.cp("dist-electron/native", path.join(dist, "native"), { recursive: true });

  let router: RuntimeRouter;
  async function start() {
    router = new RuntimeRouter(
      new DesktopRuntimeHost({
        executablePath: process.execPath,
        args: [path.join(dist, "backend.cjs")],
        clientVersion: "0.15.1",
        maxRestarts: 0,
        createTransport: (options) => createStdioTransport({ ...options, environment }),
      }),
      dataDir,
    );
    await router.start();
  }
  cleanups.push(() => router.stop());
  await start();
  const request = <T = unknown>(method: string, params: unknown = {}) =>
    router.request<T>(method, params);
  const service = new WebAccessService({
    dataDir,
    staticDir: root,
    verifiedCodex: true,
    verifiedExperimental: true,
    verifiedClaudeManaged: true,
    runtimeRequest: (params) => request(RUNTIME_METHODS.webRequest, params),
    managedRequest: (params) => request(RUNTIME_METHODS.codexManaged, params),
    claudeManagedRequest: (params) => request(RUNTIME_METHODS.claudeManaged, params),
    historyRequest: (method, params) => request(method, params),
    receiptRequest: (params) => request(RUNTIME_METHODS.controlReceipt, params),
    workspaceRequest: () => request(RUNTIME_METHODS.listWorkspaces),
  });
  cleanups.push(() => service.shutdown());
  await service.initialize();
  const local = async <T = Record<string, unknown>>(route: string, body?: unknown) => {
    const response = await service.localRequest(route, body);
    return { status: response.status, body: response.body as T };
  };
  const access = await local<{ bootId: string }>("/access"),
    bootId = access.body.bootId;
  expect(await local("/history/configure", { enabled: true })).toMatchObject({ status: 200 });
  const found = await vi.waitFor(
    async () => {
      const response = await local<HistorySearchResult>("/history/search", {
        query: "native-marker-73ad",
      });
      expect(response.status).toBe(200);
      expect(response.body.hits).toHaveLength(1);
      return response.body.hits[0]!;
    },
    { timeout: 10_000, interval: 25 },
  );
  const located = await local<HistoryLocatedRecord>("/history/locate", found.location);
  expect(located).toMatchObject({ status: 200, body: { content: sourceBody } });
  const reference: HistoryReference = {
    ...found.location,
    start: 0,
    end: sourceBody.length,
    contentHash: located.body.contentHash,
  };
  const preview = await local<{ text: string }>("/history/references", { references: [reference] });
  expect(preview.status).toBe(200);
  expect(preview.body.text).toContain(
    "[History reference: Source decision · claude-code · assistant]",
  );
  expect(preview.body.text).toContain(sourceBody);
  const created =
    agent === "codex"
      ? await local<{ sessionId: string }>("/managed/create", {
          workspaceId: "fixture",
          requestId: randomUUID(),
          bootId,
        })
      : {
          status: 200,
          body: (await service.localClaude({
            operation: "create",
            workspaceId: "fixture",
            requestId: randomUUID(),
          })) as { sessionId: string },
        };
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  expect(created.body.sessionId).toEqual(expect.any(String));
  const sessionId = created.body.sessionId;
  const live = async () => {
    if (agent === "claude-code")
      return (await service.localClaude({ operation: "live", sessionId })) as Live;
    const result = await local<Live>(`/live?sessionId=${sessionId}`);
    expect(result.status).toBe(200);
    return result.body;
  };
  const input = async (text = "") => ({
    sessionId,
    requestId: randomUUID(),
    bootId,
    expectedRevision: (await live()).revision,
    text,
    historyReferences: [reference],
  });
  const frames = async () =>
    (await fs.readFile(framesFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Frame);
  const mutationFrames = async () =>
    (await frames()).filter((row) =>
      ["turn/start", "turn/steer", "thread/queue/add"].includes(row.method),
    );
  const receipt = (requestId: string) => local(`/requests/${requestId}`);
  const rewriteSource = async () => {
    source.message.content = "rewritten source must never replace frozen accepted input";
    await fs.writeFile(sourceFile, JSON.stringify(source) + "\n");
  };
  return {
    root,
    dataDir,
    nativeId,
    reference,
    preview: preview.body.text,
    local,
    input,
    live,
    frames,
    mutationFrames,
    receipt,
    rewriteSource,
    stop: () => router.stop(),
    exitFile,
    claude: (value: unknown) => service.localClaude(value),
    disconnect: () => fs.writeFile(modeFile, "disconnect"),
    restart: async () => {
      await router.stop();
      await start();
    },
  };
}

describe("history references through the real Backend and native protocol", () => {
  it("waits for the managed native process to close before Runtime shutdown completes", async () => {
    const f = await fixture("codex", true);
    expect(await f.local("/send", await f.input())).toMatchObject({
      status: 200,
      body: { accepted: true },
    });
    await f.stop();
    // A native CLI can still hold its cwd after stdin ends. Runtime shutdown
    // must await it before callers can remove the workspace on Windows.
    expect(await fs.readFile(f.exitFile, "utf8")).toBe("closed");
  }, 25_000);

  it("sends only references once, freezes accepted text across source changes and rejects conflicting reuse", async () => {
    const f = await fixture(),
      body = await f.input();
    const sent = await f.local("/send", body);
    expect(sent).toMatchObject({
      status: 200,
      body: { accepted: true, requestId: body.requestId },
    });
    expect(await f.mutationFrames()).toEqual([
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({
          threadId: f.nativeId,
          clientUserMessageId: body.requestId,
          input: [{ type: "text", text: f.preview }],
        }),
      }),
    ]);
    const receipt = await f.receipt(body.requestId);
    expect(receipt).toMatchObject({
      status: 200,
      body: {
        status: "accepted",
        operation: "send",
        historyInputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    await f.rewriteSource();
    expect(await f.local("/send", body)).toEqual(sent);
    expect(await f.local("/send", { ...body, text: "different request" })).toMatchObject({
      status: 409,
      body: { error: "request_id_conflict" },
    });
    expect(await f.mutationFrames()).toHaveLength(1);
    // Restart must read the accepted receipt without resolving the now-stale source or re-importing/sending.
    await f.restart();
    expect(await f.local("/send", body)).toEqual(sent);
    expect(await f.mutationFrames()).toHaveLength(1);
  }, 25_000);

  it("expands references for native steer and queue-add while preserving their distinct receipts", async () => {
    const f = await fixture(),
      first = await f.input("Continue from the decision");
    expect(await f.local("/send", first)).toMatchObject({ status: 200, body: { accepted: true } });
    const running = await f.live();
    expect(running).toMatchObject({ status: "running", turnId: "offline-turn" });
    for (const [route, method] of [
      ["steer", "turn/steer"],
      ["queue-add", "thread/queue/add"],
    ]) {
      const body = { ...(await f.input()), turnId: running.turnId };
      const result = await f.local(`/codex/${route}`, body);
      expect(result).toMatchObject({
        status: 200,
        body: { accepted: true, requestId: body.requestId },
      });
      const rows = (await f.mutationFrames()).filter((row) => row.method === method);
      expect(rows).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({
            clientUserMessageId: body.requestId,
            input: [{ type: "text", text: f.preview }],
          }),
        }),
      ]);
      if (route === "steer") expect(rows[0]!.params.expectedTurnId).toBe("offline-turn");
      expect(await f.receipt(body.requestId)).toMatchObject({
        status: 200,
        body: { status: "accepted", operation: route, historyInputHash: expect.any(String) },
      });
      expect(await f.local(`/codex/${route}`, body)).toEqual(result);
      expect((await f.mutationFrames()).filter((row) => row.method === method)).toHaveLength(1);
    }
    const frames = await f.mutationFrames();
    expect(frames.map((row) => row.method)).toEqual([
      "turn/start",
      "turn/steer",
      "thread/queue/add",
    ]);
    expect(frames[0]!.params.input).toEqual([
      { type: "text", text: `Continue from the decision\n\n${f.preview}` },
    ]);
  }, 25_000);

  it("rejects steer and queue-add on an idle target before dispatching native input", async () => {
    const f = await fixture();
    for (const operation of ["steer", "queue-add"]) {
      const body = { ...(await f.input()), turnId: "stale-turn" };
      expect(await f.local(`/codex/${operation}`, body)).toMatchObject({
        status: 409,
        body: { error: "capability_unavailable", controlOutcome: "not-dispatched" },
      });
      expect(await f.receipt(body.requestId)).toMatchObject({
        status: 200,
        body: { found: false },
      });
    }
    expect(await f.mutationFrames()).toEqual([]);
  }, 25_000);

  it("keeps a received native write with a lost acknowledgement unknown across duplicates and Runtime restart", async () => {
    const f = await fixture(),
      body = await f.input();
    await f.disconnect();
    expect(await f.local("/send", body)).toMatchObject({
      status: 502,
      body: { error: "outcome_unknown", controlOutcome: "unknown" },
    });
    expect(await f.mutationFrames()).toEqual([
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({
          clientUserMessageId: body.requestId,
          input: [{ type: "text", text: f.preview }],
        }),
      }),
    ]);
    expect(await f.receipt(body.requestId)).toMatchObject({
      status: 200,
      body: { status: "unknown", historyInputHash: expect.any(String) },
    });
    expect(await f.local("/send", await f.input())).toMatchObject({
      status: 409,
      body: { error: "outcome_unknown", controlOutcome: "unknown" },
    });
    await f.rewriteSource();
    expect(await f.local("/send", body)).toMatchObject({
      status: 409,
      body: { error: "outcome_unknown", controlOutcome: "unknown" },
    });
    await f.restart();
    expect(await f.receipt(body.requestId)).toMatchObject({
      status: 200,
      body: { status: "unknown" },
    });
    expect(await f.local("/send", body)).toMatchObject({
      status: 409,
      body: { error: "outcome_unknown", controlOutcome: "unknown" },
    });
    expect(await f.mutationFrames()).toHaveLength(1);
  }, 25_000);

  // The managed Claude process transport explicitly requires Unix; Windows
  // remains capability-gated, while Codex native protocol tests run on all OSes.
  it.skipIf(!["darwin", "linux"].includes(process.platform))(
    "dispatches only references through the real Claude runner and replays its frozen receipt without another native user frame",
    async () => {
      const f = await fixture("claude-code"),
        body = { ...(await f.input()), operation: "send" };
      expect((await f.frames()).filter((frame) => frame.type === "user")).toEqual([]);
      // This Vitest process competes with the real Backend process's lease.
      const competingLease = () => {
        const release = acquirePortableFileLease(
          path.join(f.dataDir, "claude-managed", `${body.sessionId}.lock`),
        );
        release();
      };
      expect(competingLease).toThrow("session-managed-by-another-runtime");
      const accepted = await f.claude(body).catch((cause: unknown) => {
        throw new Error("Claude initial reference send failed", { cause });
      });
      expect(accepted).toMatchObject({ accepted: true, requestId: body.requestId });
      expect(competingLease).toThrow("session-managed-by-another-runtime");
      await vi.waitFor(async () => expect((await f.live()).status).toBe("idle"), {
        timeout: 5000,
        interval: 20,
      });
      const users = (await f.frames()).filter((frame) => frame.type === "user");
      expect(users).toEqual([
        expect.objectContaining({
          uuid: body.requestId,
          message: { role: "user", content: f.preview },
        }),
      ]);
      const receipt = await f.claude({ operation: "receipt", requestId: body.requestId });
      expect(receipt).toMatchObject({
        status: "accepted",
        operation: "send",
        historyInputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      await f.rewriteSource();
      expect(await f.claude(body)).toEqual(accepted);
      expect(await f.claude({ ...body, text: "different request" })).toMatchObject({
        accepted: false,
        error: "request_id_conflict",
      });
      await f.restart();
      expect(await f.claude(body)).toEqual(accepted);
      expect((await f.frames()).filter((frame) => frame.type === "user")).toEqual(users);
    },
    25_000,
  );
});
