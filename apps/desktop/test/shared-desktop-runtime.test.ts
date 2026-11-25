// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
  createLocalRuntimeServer,
  LOCAL_RUNTIME_IDENTITY,
  LOCAL_RUNTIME_PRESENCE,
  LOCAL_RUNTIME_PRESENCE_CHANGED,
  localRuntimePaths,
  type LocalRuntimePresence,
} from "@agentkib/backend/local-runtime-ipc";
import {
  RUNTIME_METHODS,
  SESSION_EVENT_NOTIFICATION,
  type SessionStreamEvent,
  type SessionSubscription,
} from "@agentkib/runtime-protocol";
import { afterEach, expect, it } from "vitest";
import {
  acquirePortableFileLease,
  existingFileLeaseBusy,
} from "../../../packages/backend/src/managed-session-lock";
import { BackendStore } from "../../../packages/backend/src/store";
import { resolveDesktopRuntimeProfile } from "../electron/main/application-data-dir";
import { createLocalRuntimeTransport } from "../electron/main/local-runtime-transport";
import { DesktopRuntimeHost } from "../electron/main/runtime-host";
import { RuntimeRouter } from "../electron/main/runtime-router";
import {
  assistantRecord,
  jsonl,
  userRecord,
  writeTranscript,
} from "./fixtures/claude-native-session";

const require = createRequire(import.meta.url);
const electronPath: string = require("electron");
const { createIsolatedWorkerEnvironment } =
  require("../scripts/backend-worker-smoke-environment.cjs") as {
    createIsolatedWorkerEnvironment(root: string): NodeJS.ProcessEnv;
  };

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function runtimeFixture() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-desktop-runtime-")));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "tmp"));
  const environment = createIsolatedWorkerEnvironment(directory);
  const formal = await resolveDesktopRuntimeProfile(
    environment,
    process.platform,
    false,
    directory,
  );
  const dev = await resolveDesktopRuntimeProfile(environment, process.platform, true, directory);
  if (!formal.shared || !dev.shared) throw new Error("Fixture requires the shared runtime");
  const { dataDir, shared } = formal;
  cleanups.push(() => rmSync(shared.root, { recursive: true, force: true }));

  const portProbe = createServer().listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const address = portProbe.address();
  if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  writeFileSync(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({
      mcp_network: { port: address.port, lan_enabled: false, lan_risk_accepted: false },
      session_content_search_enabled: false,
    }),
  );

  const children: ChildProcess[] = [];
  const previousOwnerAtLaunch: boolean[] = [];
  cleanups.push(async () => {
    await Promise.all(
      children.map(async (child) => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.kill("SIGTERM");
        try {
          await exited;
        } finally {
          clearTimeout(kill);
        }
      }),
    );
  });

  const spawnDaemon: typeof spawn = (...args: Parameters<typeof spawn>) => {
    previousOwnerAtLaunch.push(existingFileLeaseBusy(localRuntimePaths(shared.root).lock));
    const child = spawn(...args);
    children.push(child);
    return child;
  };
  async function attach(flavor: "dev" | "formal", version = "0.34.0") {
    const profile = flavor === "dev" ? dev : formal;
    const { shared } = profile;
    if (!shared) throw new Error("Fixture requires the shared runtime");
    const host = new DesktopRuntimeHost({
      executablePath:
        process.env.AGENTKIB_TEST_BACKEND_BUNDLE ?? path.resolve("dist-electron/backend.cjs"),
      maxRestarts: 0,
      clientVersion: version,
      environment: {
        ...environment,
        AGENTKIB_APP_FLAVOR: "ai.agentkib",
        AGENTKIB_APP_VERSION: version,
        AGENTKIB_LEGACY_DEV_DATA_DIR: shared.legacyDevDataDir,
      },
      createTransport: (options) =>
        createLocalRuntimeTransport(options, {
          dataDir: profile.dataDir,
          root: shared.root,
          electronPath,
          spawnProcess: spawnDaemon,
        }),
    });
    const router = new RuntimeRouter(host, profile.dataDir);
    const presence: LocalRuntimePresence[] = [];
    const events: SessionStreamEvent[] = [];
    router.on("notification", (method, payload) => {
      if (method === LOCAL_RUNTIME_PRESENCE_CHANGED) presence.push(payload);
      if (method === SESSION_EVENT_NOTIFICATION) events.push(payload);
    });
    cleanups.push(() => router.stop());
    const handshake = await router.start();
    return {
      events,
      handshake,
      presence,
      currentPresence: () => host.request<LocalRuntimePresence>(LOCAL_RUNTIME_PRESENCE, {}),
      subscribe: (sessionId = "") =>
        router.request<SessionSubscription>(RUNTIME_METHODS.sessionsSubscribe, { sessionId }),
      router,
    };
  }
  return { attach, children, dataDir, dev, directory, formal, previousOwnerAtLaunch, shared };
}

it.each([
  ["dev", "formal"],
  ["formal", "dev"],
] as const)(
  "starts from %s and shares one live runtime with %s",
  async (firstFlavor, secondFlavor) => {
    const runtime = await runtimeFixture();
    expect(runtime.dev).toEqual(runtime.formal);
    expect(path.basename(runtime.dataDir)).toBe("ai.agentkib");

    const first = await runtime.attach(firstFlavor);
    expect(first.handshake.pid).toBe(runtime.children[0]?.pid);
    expect(first.handshake.runtime.version).toBe("0.34.0");
    await expect(first.currentPresence()).resolves.toEqual({ peers: 0, primary: true });
    const firstCatalog = await first.subscribe();

    const second = await runtime.attach(secondFlavor);
    expect(second.handshake.pid).toBe(first.handshake.pid);
    expect(runtime.children).toHaveLength(1);
    await expect(second.currentPresence()).resolves.toEqual({ peers: 1, primary: false });
    const secondCatalog = await second.subscribe();
    expect(secondCatalog.subscriptionId).not.toBe(firstCatalog.subscriptionId);
    expect(secondCatalog.events[0]).toMatchObject({
      runtimeBootId: firstCatalog.events[0]?.runtimeBootId,
      epoch: firstCatalog.events[0]?.epoch,
    });

    await first.router.stop();
    await expect.poll(() => second.presence.at(-1)).toEqual({ peers: 0, primary: true });
    await expect(second.router.request(RUNTIME_METHODS.runtimeInfo, {})).resolves.toMatchObject({
      data_dir: runtime.dataDir,
    });

    const reopened = await runtime.attach(firstFlavor);
    expect(reopened.handshake.pid).toBe(first.handshake.pid);
    expect((await reopened.subscribe()).events[0]?.runtimeBootId).toBe(
      firstCatalog.events[0]?.runtimeBootId,
    );

    await second.router.stop();
    await reopened.router.stop();
    const reopenedDuringIdle = await runtime.attach(secondFlavor);
    expect(reopenedDuringIdle.handshake.pid).toBe(first.handshake.pid);
    expect(runtime.children).toHaveLength(1);
  },
  30_000,
);

it("retires the previous version and starts a single replacement for concurrent desktops", async () => {
  const runtime = await runtimeFixture();
  const first = await runtime.attach("formal", "0.34.0");
  const firstBoot = (await first.subscribe()).events[0]?.runtimeBootId;
  const oldProcess = runtime.children[0]!;
  const exited = once(oldProcess, "exit");
  await first.router.stop();
  expect(oldProcess.exitCode).toBeNull();
  expect(existingFileLeaseBusy(localRuntimePaths(runtime.shared.root).lock)).toBe(true);

  const [formal, dev] = await Promise.all([
    runtime.attach("formal", "0.35.0"),
    runtime.attach("dev", "0.35.0"),
  ]);

  await expect(exited).resolves.toEqual([0, null]);
  expect(runtime.previousOwnerAtLaunch).toEqual([false, false]);
  expect(runtime.children).toHaveLength(2);
  expect(formal.handshake.runtime.version).toBe("0.35.0");
  expect(formal.handshake.pid).not.toBe(first.handshake.pid);
  expect(formal.handshake.pid).toBe(runtime.children[1]?.pid);
  expect(dev.handshake.pid).toBe(formal.handshake.pid);
  const replacementBoot = (await formal.subscribe()).events[0]?.runtimeBootId;
  expect(replacementBoot).not.toBe(firstBoot);
  expect((await dev.subscribe()).events[0]?.runtimeBootId).toBe(replacementBoot);
}, 60_000);

it("leaves a legacy runtime unjoined and waits for its lease after the endpoint closes", async () => {
  const runtime = await runtimeFixture();
  const paths = localRuntimePaths(runtime.shared.root);
  mkdirSync(paths.root, { mode: 0o700 });
  const releaseLease = acquirePortableFileLease(paths.lock);
  cleanups.push(releaseLease);
  const key = randomBytes(32);
  const methods: string[] = [];
  const clients = new Set<Socket>();
  const legacy = createLocalRuntimeServer(key, (socket) => {
    clients.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => clients.delete(socket));
    createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
      const { id, method } = JSON.parse(line) as { id: number; method: string };
      methods.push(method);
      socket.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32001, message: "Local runtime is unavailable for this client" },
        })}\n`,
      );
    });
  });
  const closeLegacyEndpoint = async () => {
    if (!legacy.listening) return;
    const closed = new Promise<void>((resolve) => legacy.close(() => resolve()));
    for (const client of clients) client.destroy();
    await closed;
    rmSync(paths.key, { force: true });
  };
  cleanups.push(closeLegacyEndpoint);
  const listening = once(legacy, "listening");
  legacy.listen(paths.endpoint);
  await listening;
  if (process.platform !== "win32") chmodSync(paths.endpoint, 0o600);
  writeFileSync(paths.key, key, { mode: 0o600 });

  const opening = runtime.attach("formal", "0.35.0");
  void opening.catch(() => undefined);
  await expect.poll(() => methods).toEqual([LOCAL_RUNTIME_IDENTITY]);
  await expect.poll(() => clients.size).toBe(0);
  await closeLegacyEndpoint();
  // The pipe or socket disappearing precedes final cleanup and release of the lease.
  await delay(350);
  expect(runtime.children).toHaveLength(0);
  expect(methods).toEqual([LOCAL_RUNTIME_IDENTITY]);

  releaseLease();
  const reopened = await opening;
  expect(runtime.previousOwnerAtLaunch).toEqual([false]);
  expect(runtime.children).toHaveLength(1);
  expect(reopened.handshake.runtime.version).toBe("0.35.0");
  expect(reopened.handshake.pid).toBe(runtime.children[0]?.pid);
}, 30_000);

it("retains the benchmark data override as an isolated worker", async () => {
  const directory = path.join(tmpdir(), "unused-agentkib-benchmark-override");
  await expect(
    resolveDesktopRuntimeProfile(
      { AGENTKIB_BENCHMARK_DATA_DIR: directory },
      process.platform,
      true,
    ),
  ).resolves.toEqual({
    dataDir: path.resolve(directory),
  });
});

function olderDevBinding(fixture: Awaited<ReturnType<typeof runtimeFixture>>) {
  const nativeId = randomUUID();
  const bindingId = randomUUID();
  const token = "d".repeat(64);
  const workspace = path.join(fixture.directory, "project");
  const workspaceId = "registered";
  const timestamp = new Date().toISOString();
  const claudeProject = path.join(
    fixture.directory,
    ".claude",
    "projects",
    workspace.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  mkdirSync(workspace);
  const user = userRecord(nativeId, { cwd: workspace, timestamp });
  const assistant = assistantRecord(nativeId, user.uuid, { cwd: workspace, timestamp });
  writeTranscript(claudeProject, jsonl([user, assistant]), { name: `${nativeId}.jsonl` });

  const store = new BackendStore(path.join(fixture.dataDir, "agentkib.db"));
  const sessionId = store.sessions.id("claude-code", nativeId);
  try {
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
      workspaceId,
      workspace,
      "Fixture",
      "healthy",
      timestamp,
    );
    store.sessions.sync(workspaceId, "claude-code", [
      {
        native_ref: nativeId,
        agent: "claude-code",
        title: "Terminal fixture",
        created_at: timestamp,
        updated_at: timestamp,
        message_count: 2,
        git_branch: null,
        archived: false,
        sidechain: false,
        availability: "readable",
        origin: "interactive",
      },
    ]);
  } finally {
    store.close();
  }

  const oldBridge = path.join(fixture.shared.legacyDevDataDir, "claude-bridge");
  mkdirSync(oldBridge, { recursive: true, mode: 0o700 });
  const target = {
    sessionId: randomUUID(),
    nativeId,
    workspaceId: "old-registration",
    workspace,
    registeredWorkspace: workspace,
  };
  writeFileSync(
    path.join(oldBridge, "bindings-v1.json"),
    JSON.stringify({
      version: 1,
      bindings: [
        {
          version: 1,
          bindingId,
          token,
          target,
          revoked: false,
          inflight: null,
        },
      ],
    }),
    { mode: 0o600 },
  );
  const oldSocket = "/tmp/unused-agentkib-old-dev-bridge.sock";
  const credential = path.join(oldBridge, `${bindingId}.credential.json`);
  writeFileSync(
    credential,
    JSON.stringify({
      protocol: 1,
      nativeId,
      cwd: workspace,
      bindingId,
      token,
      socketPath: oldSocket,
    }),
    { mode: 0o600 },
  );

  return { bindingId, credential, nativeId, oldSocket, sessionId, token, workspace };
}

function bridgeRequest<T>(
  socketPath: string,
  token: string,
  endpoint: string,
  body: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: endpoint,
        method: "POST",
        headers: { Host: "localhost", Authorization: `Bearer ${token}`, Connection: "close" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const data = Buffer.concat(chunks).toString();
          if (response.statusCode !== 200) {
            reject(
              new Error(`Fixture terminal ${endpoint} returned ${response.statusCode}: ${data}`),
            );
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(3_000, () => req.destroy(new Error(`Fixture terminal ${endpoint} timed out`)));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

it.skipIf(process.platform !== "darwin")(
  "reconnects an existing Dev terminal credential and streams the same turn to both desktops",
  async () => {
    const runtime = await runtimeFixture();
    const binding = olderDevBinding(runtime);
    const [formal, dev] = await Promise.all([runtime.attach("formal"), runtime.attach("dev")]);
    expect(formal.handshake.pid).toBe(dev.handshake.pid);

    const readCredential = () =>
      JSON.parse(readFileSync(binding.credential, "utf8")) as {
        socketPath: string;
        bindingId: string;
        token: string;
      };
    await expect.poll(() => readCredential().socketPath).not.toBe(binding.oldSocket);
    const credential = readCredential();
    expect(credential).toMatchObject({ bindingId: binding.bindingId, token: binding.token });
    const identity = {
      protocol: 1,
      bindingId: binding.bindingId,
      nativeId: binding.nativeId,
      cwd: binding.workspace,
      cliVersion: "2.1.301",
      pluginVersion: "0.4.0",
      instanceId: randomUUID(),
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
    };
    const lease = await bridgeRequest<{ leaseId: string; bindingId: string }>(
      credential.socketPath,
      binding.token,
      "/v1/reconnect",
      identity,
    );
    expect(lease.bindingId).toBe(binding.bindingId);
    const [formalSubscription, devSubscription] = await Promise.all([
      formal.subscribe(binding.sessionId),
      dev.subscribe(binding.sessionId),
    ]);
    const turnId = randomUUID();
    await expect(
      bridgeRequest(credential.socketPath, binding.token, "/v1/events", {
        bindingId: binding.bindingId,
        leaseId: lease.leaseId,
        nativeId: binding.nativeId,
        cwd: binding.workspace,
        instanceId: identity.instanceId,
        events: [
          {
            seq: 1,
            event: {
              type: "snapshot",
              snapshot: {
                ...identity,
                revision: 1,
                currentTurnId: turnId,
                status: "running",
                waiting: null,
                messages: [],
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
                  approve: false,
                  answer: false,
                },
              },
            },
          },
        ],
      }),
    ).resolves.toEqual({ ackSeq: 1 });
    const notified = (events: SessionStreamEvent[]) =>
      events.find(
        (event) =>
          event.sessionId === binding.sessionId &&
          event.type === "state" &&
          event.payload.turnId === turnId,
      );
    await expect
      .poll(() => notified(formal.events))
      .toMatchObject({ subscriptionId: formalSubscription.subscriptionId });
    await expect
      .poll(() => notified(dev.events))
      .toMatchObject({ subscriptionId: devSubscription.subscriptionId });
    const formalEvent = notified(formal.events)!;
    const devEvent = notified(dev.events)!;
    expect(devEvent).toMatchObject({
      runtimeBootId: formalEvent.runtimeBootId,
      epoch: formalEvent.epoch,
      seq: formalEvent.seq,
      payload: formalEvent.payload,
    });
  },
  30_000,
);
