// @vitest-environment node
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

// Models and login use the native CLI commands. A print turn records its prompt and starts a
// synthetic SQLite session on the first turn. It stays running until the test releases or stops it.
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
} else if (args[0] === "-p") {
  const promptIndex = args.indexOf("--prompt-file") + 1;
  const promptFile = args[promptIndex];
  const prompt = readFileSync(promptFile, "utf8");
  args[promptIndex] = "<temp>/" + basename(promptFile);
  if (!args.includes("-r")) {
    const db = new DatabaseSync(process.env.FIXTURE_DB);
    const now = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, 0)").run(
      "new-otter", process.cwd(), "New fixture session", "fixture-alternate", now, now,
    );
    db.close();
  }
  process.on("SIGINT", () => {
    log({ signal: "SIGINT" });
    process.exit(130);
  });
  log({ args, prompt, cwd: process.cwd() });
  setInterval(() => {
    if (!existsSync(process.env.FIXTURE_HOLD)) process.exit(0);
  }, 20);
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

async function fixture() {
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
  try {
    native.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL,
      title TEXT, model TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0);`);
    native
      .prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, 0)")
      .run(
        existing,
        workspace,
        "Existing fixture session",
        baseModel,
        1_794_400_000,
        1_794_400_000,
      );
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
  };
  const backend = await startBackend({ data, workspace, indexSessions: true, environment });
  cleanups.push(backend.close);
  const store = new BackendStore(join(data, "agentkib.db"));
  let sessionId: string;
  let createdId: string;
  try {
    // Seed only Devin's catalog so setup never probes other Agent installations.
    store.sessions.sync(
      workspaceId,
      "devin",
      new DevinSessions(environment).list(workspace).sessions,
    );
    sessionId = store.sessions.id("devin", existing);
    createdId = store.sessions.id("devin", "new-otter");
  } finally {
    store.close();
  }
  const host = await startHost({ root, workspace, rpc: backend.rpc });
  cleanups.push(host.dispose);

  return {
    ...host,
    rpc: backend.rpc,
    sessionId,
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
        features: {
          send: { available: true },
          stop: { available: false, reason: "session-not-running" },
          "settings-state": { available: true },
          settings: { available: true },
          resources: { available: true },
          files: { available: true },
          context: { available: false, reason: "unsupported-operation" },
          approve: { available: false, reason: "unsupported-operation" },
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
    expect(f.runtimeCalls()).toEqual([
      auth,
      {
        cwd: "<workspace>",
        args: [
          "-p",
          "--prompt-file",
          "<temp>/prompt.md",
          "--model",
          alternateModel,
          "--permission-mode",
          "auto",
        ],
        prompt,
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
        args: [
          "-p",
          "--prompt-file",
          "<temp>/prompt.md",
          "-r",
          existing,
          "--model",
          alternateModel,
          "--permission-mode",
          "auto",
        ],
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
    expect(f.runtimeCalls()).toEqual([...runtimeCalls, { signal: "SIGINT" }]);
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
    expect(body).toMatchObject({ status: "running", revision: 1, sendEnabled: false });
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
    expect(
      f.runtimeCalls().filter((call) => Array.isArray(call.args) && call.args[0] === "-p"),
    ).toMatchObject([{ prompt }]);
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
