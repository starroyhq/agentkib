/** Native, offline, two-process read receipt acceptance. Only a fresh temporary Codex home. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SharedRpcClient,
  SYNTHETIC_MODEL,
  createResponsesFixture,
} from "./verify-codex-shared-server.mjs";

export async function verifyReadState(binary = "codex", { keep = false } = {}) {
  if (!path.isAbsolute(binary)) {
    const located = spawnSync(process.platform === "win32" ? "where" : "which", [binary], {
      encoding: "utf8",
    });
    assert.equal(located.status, 0, "Codex executable is required for native acceptance");
    binary = located.stdout.trim().split(/\r?\n/)[0];
  }
  const directory = await mkdtemp(path.join(tmpdir(), "agentkib-native-read-state-"));
  const nativeHome = path.join(directory, "codex");
  const workspace = path.join(directory, "workspace");
  await Promise.all([
    mkdir(nativeHome, { mode: 0o700 }),
    mkdir(workspace),
    mkdir(path.join(directory, "app-profile")),
  ]);
  const fixture = await createResponsesFixture();
  const config = {
    model: SYNTHETIC_MODEL,
    model_provider: "agentkib-read-state-fixture",
    check_for_update_on_startup: false,
    cli_auth_credentials_store: "file",
    "model_providers.agentkib-read-state-fixture.name": "AgentKib offline receipt acceptance",
    "model_providers.agentkib-read-state-fixture.base_url": fixture.url,
    "model_providers.agentkib-read-state-fixture.env_key": "AGENTKIB_SYNTHETIC_KEY",
    "model_providers.agentkib-read-state-fixture.wire_api": "responses",
    "model_providers.agentkib-read-state-fixture.requires_openai_auth": false,
    "model_providers.agentkib-read-state-fixture.supports_websockets": false,
    "model_providers.agentkib-read-state-fixture.request_max_retries": 0,
    "model_providers.agentkib-read-state-fixture.stream_max_retries": 0,
    "features.shell_snapshot": false,
    "features.apps": false,
    "features.skills": false,
    "agents.enabled": false,
    web_search: "disabled",
    approval_policy: "never",
    sandbox_mode: "read-only",
  };
  const configArgs = Object.entries(config).flatMap(([key, value]) => [
    "-c",
    `${key}=${JSON.stringify(value)}`,
  ]);
  const environment = {
    PATH: process.env.PATH,
    LANG: "en_US.UTF-8",
    CODEX_HOME: nativeHome,
    AGENTKIB_SYNTHETIC_KEY: "offline-fixture-not-a-credential",
  };
  const clients = [];
  const children = [];
  const sandbox = `(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:${new URL(fixture.url).port}"))(allow network* (local unix-socket))(allow network* (remote unix-socket))`;
  function peer() {
    const args = [...configArgs, "app-server", "--stdio"];
    const child =
      process.platform === "darwin"
        ? spawn("/usr/bin/sandbox-exec", ["-p", sandbox, binary, ...args], {
            cwd: workspace,
            env: environment,
            stdio: ["pipe", "pipe", "pipe"],
          })
        : spawn(binary, args, {
            cwd: workspace,
            env: environment,
            stdio: ["pipe", "pipe", "pipe"],
          });
    children.push(child);
    const client = new SharedRpcClient(
      (frame) => child.stdin.write(frame + "\n"),
      () => child.kill("SIGTERM"),
    );
    clients.push(client);
    let pending = "";
    let diagnostics = "";
    child.stderr.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-4000);
    });
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line) client.receive(Buffer.from(line));
      }
    });
    child.on("error", (error) => client.fail(error));
    child.on("close", (code) =>
      client.fail(new Error(`native process exited ${code}: ${diagnostics}`)),
    );
    return client;
  }
  try {
    // Bootstrap the brand-new native schema once before a second independent process opens it.
    const first = peer();
    const a = await first.initialize("agentkib_receipt_a");
    const second = peer();
    const b = await second.initialize("agentkib_receipt_b");
    assert.notEqual(children[0].pid, children[1].pid);
    const { thread } = await first.request("thread/start", { cwd: workspace, ephemeral: false });
    fixture.enqueue({ text: "Synthetic result for native read receipt acceptance." });
    const turn = await first.request("turn/start", {
      threadId: thread.id,
      input: [
        {
          type: "text",
          text: "Offline read receipt acceptance fixture. Reply only with the fixture result.",
        },
      ],
    });
    await first.waitFor(
      (frame) =>
        frame.method === "turn/completed" &&
        frame.params?.threadId === thread.id &&
        frame.params?.turn?.id === turn.turn.id,
    );
    await first.request("thread/name/set", {
      threadId: thread.id,
      name: "AgentKib read-state acceptance (synthetic)",
    });
    const unread = (
      await second.request("thread/read", { threadId: thread.id, includeTurns: false })
    ).readState;
    assert(unread?.firstUnread, "A completed native result must be unread in another process");
    assert.equal(unread.firstUnread.type, "turn");
    assert.equal(unread.firstUnread.turnId, turn.turn.id);
    let arrived;
    const streaming = new Promise((resolve) => {
      arrived = resolve;
    });
    const held = fixture.enqueue({
      hold: true,
      text: "A later synthetic result.",
      received: arrived,
    });
    const subsequent = await first.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "Run a second offline fixture turn." }],
    });
    let streamDeadline;
    try {
      await Promise.race([
        streaming,
        new Promise((_, reject) => {
          streamDeadline = setTimeout(() => reject(new Error("synthetic stream timeout")), 15000);
        }),
      ]);
    } finally {
      clearTimeout(streamDeadline);
    }
    const whileRunning = (
      await second.request("thread/read", { threadId: thread.id, includeTurns: false })
    ).readState;
    assert.equal(
      whileRunning.firstUnread?.turnId,
      turn.turn.id,
      "Starting a new turn retains the older unread result",
    );
    const cleared = (
      await second.request("thread/readState/update", {
        threadId: thread.id,
        expectedRevision: whileRunning.revision,
        operation: { type: "read" },
      })
    ).readState;
    assert.equal(cleared.firstUnread, null);
    let sharedRead = (
      await first.request("thread/read", { threadId: thread.id, includeTurns: false })
    ).readState;
    assert.equal(
      sharedRead.firstUnread,
      null,
      "The writer process observes the other process's receipt",
    );
    held.release();
    await first.waitFor(
      (frame) =>
        frame.method === "turn/completed" &&
        frame.params?.threadId === thread.id &&
        frame.params?.turn?.id === subsequent.turn.id,
    );
    const later = (
      await second.request("thread/read", { threadId: thread.id, includeTurns: false })
    ).readState;
    assert.equal(
      later.firstUnread?.turnId,
      subsequent.turn.id,
      "A receipt during execution cannot consume its future completion",
    );
    sharedRead = (
      await second.request("thread/readState/update", {
        threadId: thread.id,
        expectedRevision: later.revision,
        operation: { type: "read" },
      })
    ).readState;
    const manual = (
      await first.request("thread/readState/update", {
        threadId: thread.id,
        expectedRevision: sharedRead.revision,
        operation: { type: "unread" },
      })
    ).readState;
    assert.deepEqual(manual.firstUnread, { type: "threadStart" });
    const fromSecond = (
      await second.request("thread/read", { threadId: thread.id, includeTurns: false })
    ).readState;
    assert.deepEqual(fromSecond.firstUnread, { type: "threadStart" });
    await assert.rejects(
      second.request("thread/readState/update", {
        threadId: thread.id,
        expectedRevision: unread.revision,
        operation: { type: "read" },
      }),
      "An old receipt cannot clear newer manual unread",
    );
    assert.deepEqual(
      (await second.request("thread/read", { threadId: thread.id, includeTurns: false })).readState
        .firstUnread,
      { type: "threadStart" },
    );
    const listing = await second.request("thread/list", { limit: 100 });
    assert.deepEqual(listing.readStates?.[thread.id]?.firstUnread, { type: "threadStart" });
    const report = {
      directory: keep ? directory : undefined,
      versions: [a.userAgent, b.userAgent],
      independentProcesses: true,
      terminalUnreadShared: true,
      readShared: true,
      manualUnreadShared: true,
      staleCasRejected: true,
      runningRetainsPreviousUnread: true,
      readingPriorResultDoesNotConsumeFutureCompletion: true,
      catalogReadState: true,
      threadId: thread.id,
      turnId: subsequent.turn.id,
    };
    if (keep) {
      // Native GUI can inspect this isolated, already finished thread without model/network calls.
      await writeFile(path.join(directory, "acceptance.json"), JSON.stringify(report, null, 2));
      await writeFile(
        path.join(nativeHome, "config.toml"),
        Object.entries(config)
          .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
          .join("\n") + "\n",
      );
    }
    return report;
  } finally {
    for (const client of clients) client.close();
    await Promise.all(
      children.map((child) =>
        child.exitCode === null
          ? new Promise((resolve) => {
              const timer = setTimeout(() => {
                child.kill("SIGKILL");
                resolve();
              }, 2000);
              child.once("close", () => {
                clearTimeout(timer);
                resolve();
              });
            })
          : Promise.resolve(),
      ),
    );
    await fixture.close();
    if (!keep) await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const binary = process.argv.find((value, index) => index > 1 && value !== "--keep") ?? "codex";
  console.log(
    JSON.stringify(
      await verifyReadState(binary, { keep: process.argv.includes("--keep") }),
      null,
      2,
    ),
  );
}
