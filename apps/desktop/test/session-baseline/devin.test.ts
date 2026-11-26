// @vitest-environment node
import { randomUUID } from "node:crypto";
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
import { DatabaseSync } from "node:sqlite";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevinSessionProvider } from "../../../../packages/backend/src/agents/devin/session-provider";
import { OrchestrationService } from "../../../../packages/backend/src/orchestration-service";
import { DevinSessionSettings } from "../../../../packages/backend/src/agents/devin/devin-session-settings";
import { DevinSessions } from "../../../../packages/backend/src/agents/devin/devin-sessions";
import { BackendStore } from "../../../../packages/backend/src/store";
import { startBackend, startHost } from "./harness";

// Models and login use the native CLI commands. An ACP turn records the session it starts or
// loads, the options set on it and its prompt, and starts a synthetic SQLite session on the first
// turn. It stays running until the test releases or cancels it.
const syntheticDevin = String.raw`
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { basename } = require("node:path");
const args = process.argv.slice(2);
const log = (call) => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(call) + "\n");
if (args[0] === "auth") {
  log({ args });
  console.log("Logged in as fixture");
} else if (args[0] === "models") {
  log({ args });
  console.log(readFileSync(process.env.FIXTURE_MODELS, "utf8"));
} else if (args[0] === "acp") {
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  const options = () => [
    {
      id: "mode", type: "select", currentValue: turn.config.mode ?? "accept-edits",
      options: ["accept-edits", "ask", "smart", "bypass"].map((value) => ({ value, name: value })),
    },
    {
      id: "model", type: "select", currentValue: turn.config.model ?? "fixture-model",
      options: ["fixture-model", "fixture-alternate"].map((value) => ({ value, name: value })),
    },
  ];
  const turn = { cwd: process.cwd(), config: {} };
  let pending = null;
  let holdTimer;
  const storeNew = () => {
    const db = new DatabaseSync(process.env.FIXTURE_DB);
    const now = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO sessions (id, working_directory, title, model, created_at, last_activity_at, hidden) VALUES (?, ?, ?, ?, ?, ?, 0)").run(
      "new-otter", process.cwd(), "New fixture session", "fixture-alternate", now, now,
    );
    if (process.env.FIXTURE_STORE_AFTER_TURN) {
      const node = db.prepare("INSERT INTO message_nodes VALUES (?, ?, ?, ?, NULL, ?)");
      node.run("new-otter", 1, null, JSON.stringify({ role: "user", content: turn.prompt, metadata: { is_user_input: true } }), now);
      node.run("new-otter", 2, 1, JSON.stringify({ role: "assistant", content: "Persisted Devin reply" }), now);
      db.prepare("UPDATE sessions SET main_chain_id=2 WHERE id=?").run("new-otter");
    }
    db.close();
    if (process.env.FIXTURE_STORE_AFTER_TURN) log({ persisted: "new-otter" });
  };
  const finish = (stopReason) => {
    if (pending === null) return;
    clearInterval(holdTimer);
    if (stopReason === "end_turn" && turn.acp[0] === "session/new" && process.env.FIXTURE_STORE_AFTER_TURN) storeNew();
    send({ jsonrpc: "2.0", id: pending, result: { stopReason } });
    pending = null;
  };
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const { id, method, params = {} } = JSON.parse(line);
    if (method === "initialize")
      return send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    if (method === "session/new") {
      if (!process.env.FIXTURE_STORE_AFTER_TURN) storeNew();
      turn.acp = ["session/new"];
      return send({ jsonrpc: "2.0", id, result: { sessionId: "new-otter", configOptions: options() } });
    }
    if (method === "session/load") {
      turn.acp = ["session/load", params.sessionId];
      return send({ jsonrpc: "2.0", id, result: { configOptions: options() } });
    }
    if (method === "session/set_config_option") {
      turn.config[params.configId] = params.value;
      return send({ jsonrpc: "2.0", id, result: { configOptions: options() } });
    }
    if (method === "session/prompt") {
      turn.prompt = (params.prompt ?? []).map((block) => block.text ?? "").join("");
      log(turn);
      pending = id;
      // A held synthetic turn must not keep the CLI alive after stdin ends.
      clearInterval(holdTimer);
      holdTimer = setInterval(() => {
        if (existsSync(process.env.FIXTURE_HOLD)) return;
        finish("end_turn");
      }, 20).unref();
      return;
    }
    if (method === "session/cancel") {
      log({ cancel: true });
      finish("cancelled");
    }
  });
} else {
  log({ args });
  process.exitCode = 2;
}
`;

const workspaceId = "workspace";
const existing = "brisk-otter";
const baseModel = "fixture-model";
const alternateModel = "fixture-alternate";
const requestIds = {
  create: "10000000-0000-4000-8000-000000000001",
  settings: "10000000-0000-4000-8000-000000000002",
  send: "10000000-0000-4000-8000-000000000003",
  stop: "10000000-0000-4000-8000-000000000004",
  empty: "10000000-0000-4000-8000-000000000005",
  steer: "10000000-0000-4000-8000-000000000006",
  queue: "10000000-0000-4000-8000-000000000007",
  approve: "10000000-0000-4000-8000-000000000008",
  answer: "10000000-0000-4000-8000-000000000009",
};
const auth = { args: ["auth", "status"] };
const modelQuery = { args: ["models", "list", "--format", "json"] };
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture({ storeAfterTurn = false, sessionCount = 1 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentkib-baseline-devin-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const data = join(root, "backend");
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  const devin = join(home, "devin");
  const nativeDatabase = join(devin, "cli", "sessions.db");
  for (const directory of [bin, workspace, join(devin, "cli"), join(home, ".claude")])
    mkdirSync(directory, { recursive: true });
  writeFileSync(join(bin, "devin"), `#!${process.execPath}\n${syntheticDevin}`, { mode: 0o700 });
  const log = join(root, "calls.jsonl");
  const modelFile = join(root, "models.json");
  const hold = join(root, "hold-turn");
  writeFileSync(hold, "");
  writeFileSync(
    modelFile,
    JSON.stringify({
      families: [baseModel, alternateModel].map((id) => ({
        slug: id,
        variants: [{ model_uid: id, max_context_tokens: 200_000 }],
      })),
    }),
  );
  const native = new DatabaseSync(nativeDatabase);
  const nativeIds = [
    existing,
    ...Array.from({ length: sessionCount - 1 }, (_, index) => `coexisting-otter-${index}`),
  ];
  try {
    native.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL,
      title TEXT, model TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0);`);
    const insert = native.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, 0)");
    for (const id of nativeIds)
      insert.run(
        id,
        workspace,
        "Existing fixture session",
        baseModel,
        1_794_400_000,
        1_794_400_000,
      );
    if (storeAfterTurn)
      native.exec(`ALTER TABLE sessions ADD COLUMN main_chain_id INTEGER;
        CREATE TABLE message_nodes (session_id TEXT, node_id INTEGER, parent_node_id INTEGER,
          chat_message TEXT, metadata TEXT, created_at INTEGER);`);
  } finally {
    native.close();
  }
  const environment = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    DEVIN_SESSIONS_DIR: devin,
    PATH: `${bin}:/usr/bin:/bin`,
    FIXTURE_DB: nativeDatabase,
    FIXTURE_LOG: log,
    FIXTURE_MODELS: modelFile,
    FIXTURE_HOLD: hold,
    ...(storeAfterTurn ? { FIXTURE_STORE_AFTER_TURN: "1" } : {}),
  };
  const backend = await startBackend({ data, workspace, indexSessions: true, environment });
  cleanups.push(backend.close);
  const store = new BackendStore(join(data, "agentkib.db"));
  let sessionIds: string[];
  let createdId: string;
  try {
    // Seed only Devin's catalog so setup never probes other Agent installations.
    store.sessions.sync(
      workspaceId,
      "devin",
      new DevinSessions(environment).list(workspace).sessions,
    );
    sessionIds = nativeIds.map((id) => store.sessions.id("devin", id));
    createdId = store.sessions.id("devin", "new-otter");
  } finally {
    store.close();
  }
  const host = await startHost({ root, workspace, rpc: backend.rpc });
  cleanups.push(host.dispose);

  const sessionId = sessionIds[0]!;
  return {
    ...host,
    rpc: backend.rpc,
    sessionId,
    sessionIds,
    createdId,
    data,
    live: (id = sessionId) => host.http(`/live?sessionId=${id}`),
    receipt: (id: string) => host.http(`/requests/${id}`),
    runtimeReceipt: (requestId: string) =>
      backend.rpc("control.receipt", { requestId, deviceId: host.deviceId }),
    runtimeCalls: (): Array<Record<string, unknown>> =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const call = JSON.parse(line) as Record<string, unknown>;
              return call.cwd === workspace ? { ...call, cwd: "<workspace>" } : call;
            })
        : [],
    release: () => rmSync(hold),
  };
}

function liveBody(
  sessionId: string,
  runtimeBootId: unknown,
  revision: number,
  turn: { running?: string; completed?: string } = {},
) {
  return {
    executionMode: "devin-print",
    status: turn.running ? "running" : "idle",
    revision,
    turnId: turn.running ?? null,
    completedTurnId: turn.completed ?? null,
    planProgress: null,
    sendEnabled: !turn.running,
    stopEnabled: !!turn.running,
    cancelling: false,
    approvals: [],
    questions: [],
    reason: null,
    usageLimit: null,
    usage: { available: false, state: "unavailable" },
    sessionId,
    runtimeBootId,
    workspaceId,
  };
}

function acceptedReceipt(
  ack: unknown,
  operation: string,
  requestId: string,
  sessionId: string,
  runtimeBootId: unknown,
  expectedRevision: number | null,
  turnId: string | null = null,
) {
  return {
    status: 200,
    body: {
      found: true,
      requestId,
      sessionId,
      workspaceId,
      operation,
      executionMode: "devin-print",
      runtimeBootId,
      expectedRevision,
      turnId,
      status: "accepted",
      ack,
      completionObserved: false,
    },
  };
}

function refusal(error: string, status = 409) {
  return { status, body: { error, controlOutcome: "not-dispatched" } };
}

describe.skipIf(process.platform === "win32")("Devin session HTTP baseline", () => {
  it("starts a ninth resumed session while the earlier turns are still running", async () => {
    const f = await fixture({ sessionCount: 9 });
    for (const sessionId of f.sessionIds) {
      expect(
        await f.http("/send", {
          sessionId,
          bootId: f.bootId,
          expectedRevision: 0,
          requestId: randomUUID(),
          text: "Hold this turn open.",
        }),
      ).toMatchObject({ status: 200, body: { accepted: true } });
    }
    for (const sessionId of f.sessionIds) {
      expect(await f.live(sessionId)).toMatchObject({
        status: 200,
        body: { status: "running", turnId: expect.any(String) },
      });
    }
    f.release();
  });

  it("offers the native model catalog and reads capabilities, inspect, and idle live state", async () => {
    const f = await fixture();
    const modelCapabilities = await f.http("/managed/options?agent=devin&workspaceId=workspace");
    expect(modelCapabilities).toMatchObject({
      status: 200,
      body: {
        available: true,
        workspaces: [{ id: workspaceId, name: "Offline workspace" }],
        provider: {
          create: { mode: "with-first-message", catalogScope: "workspace" },
          models: { selection: "variants" },
          contextUsage: "last-request",
        },
        models: [baseModel, alternateModel].map((id) => ({
          id,
          efforts: [],
          serviceTierIds: [],
          maxContextTokens: 200_000,
          variants: [{ id, maxContextTokens: 200_000 }],
        })),
        permissionModes: ["auto", "accept-edits", "smart", "dangerous"].map((id) => ({ id })),
      },
    });
    const { sessionId } = f;
    const initial = await f.live();
    const { runtimeBootId } = initial.body;
    expect(runtimeBootId).toEqual(expect.any(String));
    expect(initial).toEqual({ status: 200, body: liveBody(sessionId, runtimeBootId, 0) });
    const base = {
      sessionId,
      runtimeBootId,
      executionMode: "devin-print",
      status: "idle",
      reason: null,
    };
    expect(await f.http(`/managed/capabilities?sessionId=${sessionId}`)).toMatchObject({
      status: 200,
      body: {
        ...base,
        planProgress: { live: true },
        features: {
          send: { available: true },
          stop: { available: false, reason: "session-not-running" },
          "settings-state": { available: true },
          settings: { available: true },
          resources: { available: true },
          files: { available: true },
          context: { available: false, reason: "unsupported-operation" },
          // Devin asks over ACP while a turn waits; nothing waits now.
          approve: { available: false, reason: "no-pending-approval" },
          answer: { available: false, reason: "unsupported-operation" },
          inspect: { available: true },
          resume: { available: false, reason: "permission_denied" },
          usage: { available: false, reason: "usage-not-reported" },
          "queue-list": { available: true },
          "queue-add": { available: true },
          "usage-limit-cancel": { available: false, reason: "usage-limit-continue-unavailable" },
          "usage-limit-continue": { available: false, reason: "usage-limit-continue-unavailable" },
        },
      },
    });
    expect(await f.http(`/managed/inspect?sessionId=${sessionId}`)).toEqual({
      status: 200,
      body: { ...base, revision: 0, turnId: null, approvals: [] },
    });
    expect(f.calls).toEqual(
      expect.arrayContaining([
        {
          method: "session.request",
          params: { operation: "provider-options", agent: "devin", workspaceId },
        },
        ...["live", "capabilities", "inspect"].map((operation) => ({
          method: "session.request",
          params: { operation, sessionId, experimentalEnabled: true },
        })),
      ]),
    );
    expect(f.calls.filter(({ method }) => method === "control.receipt")).toEqual([]);
    expect(f.runtimeCalls()).toEqual([modelQuery]);
  });

  it("creates only with a first prompt and exposes the new session ID in its HTTP receipt", async () => {
    const f = await fixture();
    const input = { agent: "devin", bootId: f.bootId, workspaceId };
    const empty = requestIds.empty;
    expect(await f.http("/managed/create", { ...input, requestId: empty })).toEqual(
      refusal("missing_prompt", 400),
    );
    expect(await f.receipt(empty)).toEqual({
      status: 200,
      body: { found: false, requestId: empty },
    });
    expect(f.runtimeCalls()).toEqual([]);

    const requestId = requestIds.create;
    const prompt = "First Devin message";
    const response = await f.http("/managed/create", {
      ...input,
      requestId,
      prompt,
      model: alternateModel,
      permissionMode: "auto",
    });
    const { runtimeBootId } = response.body;
    expect(runtimeBootId).toEqual(expect.any(String));
    const ack = {
      accepted: true,
      completed: true,
      requestId,
      runtimeBootId,
      executionMode: "devin-print",
      controlOutcome: "accepted",
      sessionId: f.createdId,
    };
    expect(response).toEqual({ status: 200, body: ack });
    expect(
      f.calls.filter(
        ({ params }) => (params as { operation?: string }).operation === "provider-create",
      ),
    ).toEqual([
      {
        method: "session.request",
        params: {
          operation: "provider-create",
          agent: "devin",
          requestId,
          prompt,
          workspaceId,
          model: alternateModel,
          permissionMode: "auto",
          deviceId: f.deviceId,
        },
      },
    ]);
    expect(await f.runtimeReceipt(requestId)).toEqual(
      acceptedReceipt(ack, "create", requestId, `devin-create:${requestId}`, runtimeBootId, null)
        .body,
    );
    const receipt = await f.receipt(requestId);
    expect(receipt).toEqual(
      acceptedReceipt(ack, "create", requestId, f.createdId, runtimeBootId, null),
    );
    const running = await f.live(receipt.body.sessionId as string);
    const turnId = running.body.turnId as string;
    expect(turnId).toEqual(expect.any(String));
    expect(running).toEqual({
      status: 200,
      body: liveBody(f.createdId, runtimeBootId, 1, { running: turnId }),
    });
    expect(new DevinSessionSettings(f.data).get("new-otter")).toEqual({
      model: alternateModel,
      permissionMode: "auto",
    });
    f.release();
    await expect
      .poll(() => f.live(f.createdId))
      .toEqual({
        status: 200,
        body: liveBody(f.createdId, runtimeBootId, 2, { completed: turnId }),
      });
    // The receipt confirms dispatch. The fixture writes its prompt log before completing the turn.
    expect(f.runtimeCalls()).toEqual([
      auth,
      modelQuery,
      {
        cwd: "<workspace>",
        acp: ["session/new"],
        // Read only is Devin's ACP "ask" mode, which answers without changing code.
        config: { model: alternateModel, mode: "ask" },
        prompt,
      },
    ]);
  });

  it("lists the session and its reply for a paired Web client when Devin persists after create acknowledges", async () => {
    const f = await fixture({ storeAfterTurn: true });
    const requestId = requestIds.create;
    const prompt = "Persist after acknowledging the start";
    const created = await f.http("/managed/create", {
      agent: "devin",
      bootId: f.bootId,
      workspaceId,
      requestId,
      model: alternateModel,
      prompt,
    });
    expect(created).toMatchObject({
      status: 200,
      body: { accepted: true, completed: true, sessionId: f.createdId },
    });
    expect(await f.receipt(requestId)).toMatchObject({
      status: 200,
      body: { status: "accepted", sessionId: f.createdId },
    });
    f.release();
    await expect.poll(f.runtimeCalls).toContainEqual({ persisted: "new-otter" });
    await expect
      .poll(() => f.http("/catalog"))
      .toMatchObject({
        status: 200,
        body: {
          sessions: expect.arrayContaining([
            expect.objectContaining({ id: f.createdId, agent: "devin", availability: "readable" }),
          ]),
        },
      });
    expect(await f.http(`/events?sessionId=${f.createdId}&limit=10`)).toMatchObject({
      status: 200,
      body: {
        events: expect.arrayContaining([
          expect.objectContaining({ content: "Persisted Devin reply" }),
        ]),
      },
    });
    expect(f.runtimeCalls().filter((call) => call.prompt === prompt)).toHaveLength(1);
  });

  it("stages model and permission for the next print turn, then sends and stops it", async () => {
    const f = await fixture();
    const { sessionId, deviceId, bootId } = f;
    const { runtimeBootId } = (await f.live()).body;
    const control = { bootId, sessionId };
    const settingsAck = {
      accepted: true,
      completed: true,
      appliesTo: "next-turn",
      sessionId,
      runtimeBootId,
      requestId: requestIds.settings,
    };
    expect(
      await f.http("/managed/action", {
        ...control,
        operation: "settings",
        requestId: requestIds.settings,
        expectedRevision: 0,
        model: alternateModel,
        permissionMode: "auto",
      }),
    ).toEqual({ status: 200, body: settingsAck });
    expect(await f.receipt(requestIds.settings)).toEqual(
      acceptedReceipt(settingsAck, "settings", requestIds.settings, sessionId, runtimeBootId, 0),
    );
    expect(new DevinSessionSettings(f.data).get(existing)).toEqual({
      model: alternateModel,
      permissionMode: "auto",
    });
    const choice = { modelId: alternateModel, permissionMode: "auto", maxContextTokens: 200_000 };
    expect(await f.http(`/managed/settings?sessionId=${sessionId}`)).toMatchObject({
      status: 200,
      body: {
        sessionId,
        available: true,
        revision: 1,
        current: choice,
        selected: choice,
        writable: { model: { available: true }, permissionMode: { available: true } },
      },
    });
    expect(f.runtimeCalls()).toEqual([modelQuery]);
    expect(await f.live()).toEqual({ status: 200, body: liveBody(sessionId, runtimeBootId, 1) });

    const text = "Resume the Devin fixture";
    const sendAck = {
      accepted: true,
      completed: false,
      sessionId,
      runtimeBootId,
      requestId: requestIds.send,
    };
    expect(
      await f.http("/send", { ...control, requestId: requestIds.send, expectedRevision: 1, text }),
    ).toEqual({ status: 200, body: sendAck });
    expect(await f.receipt(requestIds.send)).toEqual(
      acceptedReceipt(sendAck, "send", requestIds.send, sessionId, runtimeBootId, 1),
    );
    const runtimeCalls = [
      modelQuery,
      auth,
      {
        cwd: "<workspace>",
        acp: ["session/load", existing],
        config: { model: alternateModel, mode: "ask" },
        prompt: text,
      },
    ];
    await expect.poll(f.runtimeCalls).toEqual(runtimeCalls);
    const running = await f.live();
    const turnId = running.body.turnId as string;
    expect(turnId).toEqual(expect.any(String));
    expect(running).toEqual({
      status: 200,
      body: liveBody(sessionId, runtimeBootId, 2, { running: turnId }),
    });

    const stopAck = {
      accepted: true,
      completed: false,
      sessionId,
      runtimeBootId,
      requestId: requestIds.stop,
    };
    expect(
      await f.http("/stop", {
        ...control,
        requestId: requestIds.stop,
        expectedRevision: 2,
        turnId,
      }),
    ).toEqual({ status: 200, body: stopAck });
    await expect
      .poll(() => f.live())
      .toEqual({
        status: 200,
        body: liveBody(sessionId, runtimeBootId, 4, { completed: turnId }),
      });
    expect(await f.receipt(requestIds.stop)).toEqual(
      acceptedReceipt(stopAck, "stop", requestIds.stop, sessionId, runtimeBootId, 2, turnId),
    );
    expect(f.runtimeCalls()).toEqual([...runtimeCalls, { cancel: true }]);
    const rpcControl = { sessionId, deviceId, runtimeBootId, experimentalEnabled: true };
    const controls = f.calls.filter(({ params }) =>
      ["settings", "send", "stop"].includes((params as { operation: string }).operation),
    );
    expect(controls).toEqual([
      {
        method: "session.request",
        params: {
          ...rpcControl,
          operation: "settings",
          requestId: requestIds.settings,
          expectedRevision: 0,
          model: alternateModel,
          permissionMode: "auto",
        },
      },
      {
        method: "session.request",
        params: {
          ...rpcControl,
          operation: "send",
          requestId: requestIds.send,
          expectedRevision: 1,
          text,
        },
      },
      {
        method: "session.request",
        params: {
          ...rpcControl,
          operation: "stop",
          requestId: requestIds.stop,
          expectedRevision: 2,
          turnId,
        },
      },
    ]);
  });

  it("uses the typed Provider for first-message creation and the shared serial queue", async () => {
    const f = await fixture();
    const provider = vi.spyOn(DevinSessionProvider.prototype, "request");
    const interventions = vi.spyOn(OrchestrationService.prototype, "laneControlled");
    cleanups.push(() => {
      provider.mockRestore();
      interventions.mockRestore();
    });

    const deviceId = f.deviceId;
    const rpc = (operation: string, fields: Record<string, unknown>) =>
      f.rpc(RUNTIME_METHODS.sessionRequest, { operation, deviceId, ...fields });
    const prompt = "Start the typed Devin session";
    const { createdId: sessionId } = f;
    expect(
      await rpc("create", { agent: "devin", requestId: requestIds.create, workspaceId, prompt }),
    ).toMatchObject({
      operation: "create",
      result: { accepted: true, completed: true, sessionId },
    });
    const { body } = await f.live(sessionId);
    expect(body).toMatchObject({
      status: "running",
      revision: 1,
      sendEnabled: false,
      turnId: expect.any(String),
    });
    const scope = { sessionId, experimentalEnabled: true };
    expect(await rpc("capabilities", scope)).toMatchObject({
      operation: "capabilities",
      result: {
        execution: { owner: "agentkib" },
        features: { "queue-list": { available: true }, "queue-add": { available: true } },
      },
    });

    const control = { ...scope, runtimeBootId: body.runtimeBootId };
    const text = "Keep this message in the queue";
    await expect(
      rpc("queue-add", { ...control, requestId: requestIds.send, expectedRevision: 0, text }),
    ).rejects.toThrow("stale-or-disabled-control");
    expect(
      await rpc("queue-add", {
        ...control,
        requestId: requestIds.queue,
        expectedRevision: 1,
        text,
      }),
    ).toMatchObject({
      operation: "queue-add",
      result: { accepted: true, completed: false, sessionId, requestId: requestIds.queue },
    });
    const legacyQueue = (await f.rpc("web.request", { operation: "queue-list", sessionId })) as {
      data: Array<{ id: string }>;
    };
    expect(legacyQueue.data).toMatchObject([{ status: "pending", text }]);
    expect(await rpc("queue-list", scope)).toMatchObject({
      operation: "queue-list",
      result: { sessionId, data: [{ id: legacyQueue.data[0]!.id, status: "pending", text }] },
    });
    expect(provider.mock.calls.map(([value]) => value.operation)).toEqual([
      "create",
      "capabilities",
      "queue-add",
      "queue-add",
      "queue-list",
    ]);
    expect(interventions.mock.calls.filter(([id]) => id === sessionId)).toEqual([
      [sessionId, "queue-add"],
    ]);
    f.release();
    await expect
      .poll(() => f.live(sessionId))
      .toMatchObject({
        status: 200,
        body: { status: "idle", completedTurnId: body.turnId },
      });
    expect(f.runtimeCalls().filter((call) => typeof call.prompt === "string")).toMatchObject([
      { prompt },
    ]);
  });

  it("refuses native steering, approval and answers but shares the host queue for print turns", async () => {
    const f = await fixture();
    const { sessionId, bootId } = f;
    const activeTurn = await f.http("/send", {
      sessionId,
      bootId,
      expectedRevision: 0,
      requestId: requestIds.send,
      text: "Keep the turn active for unsupported controls",
    });
    expect(activeTurn).toMatchObject({ status: 200, body: { accepted: true } });
    await expect.poll(f.runtimeCalls).toHaveLength(2);
    const runtimeCalls = f.runtimeCalls();
    const running = await f.live();
    const { runtimeBootId } = running.body;
    const turnId = running.body.turnId as string;
    expect(turnId).toEqual(expect.any(String));
    const control = { agent: "devin", sessionId, bootId, expectedRevision: 1 };
    for (const { path, requestId, fields, error } of [
      {
        path: "/managed/action",
        requestId: requestIds.steer,
        fields: { operation: "steer", text: "Interrupt" },
        error: "capability_unavailable",
      },
      {
        path: "/approve",
        requestId: requestIds.approve,
        fields: { turnId, approvalId: "fixture-approval", decision: "accept" },
        error: "approval_unavailable",
      },
      {
        path: "/answer",
        requestId: requestIds.answer,
        fields: { turnId, questionId: "fixture-question", answers: { fixture: ["A"] } },
        error: "question_unavailable",
      },
    ]) {
      expect(await f.http(path, { ...control, requestId, ...fields })).toEqual(refusal(error));
      expect(await f.receipt(requestId)).toEqual({
        status: 200,
        body: { found: false, requestId },
      });
    }
    const dispatched = f.calls.filter(
      ({ method, params }) =>
        method === "session.request" &&
        ["steer", "approve", "answer"].includes((params as { operation: string }).operation),
    );
    expect(dispatched).toEqual([]);
    expect(f.runtimeCalls()).toEqual(runtimeCalls);
    expect(await f.live()).toEqual({ status: 200, body: running.body });
    const userQueue = {
      ...control,
      requestId: requestIds.queue,
      operation: "queue-add",
      text: "User queued this",
    };
    const accepted = await f.http("/managed/action", userQueue);
    expect(accepted).toMatchObject({ status: 200, body: { accepted: true } });
    expect(await f.http("/managed/action", userQueue)).toEqual(accepted);
    expect(
      await f.http("/managed/action", { ...userQueue, text: "Different message" }),
    ).toMatchObject({ status: 409, body: { error: "request_id_conflict" } });
    expect(await f.receipt(requestIds.queue)).toMatchObject({
      status: 200,
      body: { found: true, operation: "queue-add", sessionId, status: "accepted" },
    });
    // The Worker uses the same session-control entry as a user's queue action.
    const workerRequest = "10000000-0000-4000-8000-000000000010";
    const workerQueued = (await f.rpc("web.request", {
      sessionId,
      runtimeBootId,
      requestId: workerRequest,
      deviceId: "agentkib-local-owner",
      expectedRevision: 1,
      experimentalEnabled: true,
      operation: "queue-add",
      text: "Worker queued this",
    })) as { queuedSubmission: { id: string } };
    const path = `/managed/queue?sessionId=${sessionId}`;
    const queued = await f.http(path);
    expect(queued).toMatchObject({
      status: 200,
      body: {
        data: [
          { text: "User queued this", status: "pending" },
          { id: workerQueued.queuedSubmission.id, text: "Worker queued this", status: "pending" },
        ],
      },
    });
    const [userItem, workerItem] = queued.body.data as Array<{ id: string }>;
    expect(
      await f.http("/managed/action", {
        ...control,
        requestId: "10000000-0000-4000-8000-000000000011",
        operation: "queue-delete",
        queuedSubmissionId: userItem!.id,
      }),
    ).toMatchObject({ status: 200, body: { accepted: true } });
    expect(
      await f.http("/managed/action", {
        ...control,
        requestId: "10000000-0000-4000-8000-000000000012",
        operation: "queue-update",
        queuedSubmissionId: workerItem!.id,
        text: "Edited Worker message",
      }),
    ).toMatchObject({ status: 200, body: { accepted: true } });

    f.release();
    await expect
      .poll(() => f.live())
      .toMatchObject({
        status: 200,
        body: { status: "idle", completedTurnId: turnId },
      });
    const { sessions } = (await f.rpc("claude.managed", {
      operation: "schedule-list",
      serialOnly: true,
    })) as {
      sessions: Array<{
        sessionId: string;
        runtimeBootId: string;
        revision: number;
        next: {
          itemId: string;
          requestId: string;
          deviceId: string;
        };
      }>;
    };
    const scheduled = sessions.find((session) => session.sessionId === sessionId)!;
    expect(scheduled.next).toMatchObject({
      itemId: workerItem!.id,
      deviceId: "agentkib-local-owner",
    });
    const identity = {
      sessionId,
      itemId: scheduled.next.itemId,
      requestId: scheduled.next.requestId,
      deviceId: scheduled.next.deviceId,
      runtimeBootId: scheduled.runtimeBootId,
      expectedRevision: scheduled.revision,
    };
    const permit = (await f.rpc("claude.managed", {
      ...identity,
      operation: "schedule-prepare",
    })) as { permitId: string; expectedRevision: number };
    expect(
      await f.rpc("claude.managed", {
        ...identity,
        operation: "schedule-dispatch",
        permitId: permit.permitId,
        expectedRevision: permit.expectedRevision,
      }),
    ).toMatchObject({ accepted: true });
    await expect
      .poll(f.runtimeCalls)
      .toContainEqual(expect.objectContaining({ prompt: "Edited Worker message" }));
    expect(await f.http(path)).toMatchObject({ status: 200, body: { data: [] } });
  });
});
