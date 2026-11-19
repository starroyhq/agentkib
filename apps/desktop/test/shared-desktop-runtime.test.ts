// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LOCAL_RUNTIME_PRESENCE,
  LOCAL_RUNTIME_PRESENCE_CHANGED,
  type LocalRuntimePresence,
} from "@agentkib/backend/local-runtime-ipc";
import {
  RUNTIME_METHODS,
  SESSION_EVENT_NOTIFICATION,
  type SessionStreamEvent,
  type SessionSubscription,
} from "@agentkib/runtime-protocol";
import { afterEach, expect, it } from "vitest";
import { resolveDesktopRuntimeProfile } from "../electron/main/application-data-dir";
import { createLocalRuntimeTransport } from "../electron/main/local-runtime-transport";
import { DesktopRuntimeHost } from "../electron/main/runtime-host";
import { RuntimeRouter } from "../electron/main/runtime-router";

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
    const child = spawn(...args);
    children.push(child);
    return child;
  };
  async function attach(flavor: "dev" | "formal") {
    const profile = flavor === "dev" ? dev : formal;
    const { shared } = profile;
    if (!shared) throw new Error("Fixture requires the shared runtime");
    const host = new DesktopRuntimeHost({
      executablePath:
        process.env.AGENTKIB_TEST_BACKEND_BUNDLE ?? path.resolve("dist-electron/backend.cjs"),
      maxRestarts: 0,
      clientVersion: flavor,
      environment: {
        ...environment,
        AGENTKIB_APP_FLAVOR: "ai.agentkib",
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
  return { attach, children, dataDir, dev, directory, formal, shared };
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
  },
  30_000,
);

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
