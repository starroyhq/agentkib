import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Commands } from "../../../packages/backend/src/commands";
import { RemoteAgent } from "../../../packages/backend/src/remote-agent";
import { SessionIndex } from "../../../packages/backend/src/session-index";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";

const network = vi.hoisted(() => ({
  bonjour: vi.fn(function () {
    throw new Error("Unexpected discovery listener in disabled-sharing test");
  }),
  listen: vi.fn(async () => {
    throw new Error("Unexpected TLS listener in disabled-sharing test");
  }),
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  networkInterfaces: () => ({}),
}));
vi.mock("bonjour-service", () => ({ default: network.bonjour }));
vi.mock("../../../packages/backend/src/remote-tls", async (original) => ({
  ...(await original<typeof import("../../../packages/backend/src/remote-tls")>()),
  listenRemoteAgent: network.listen,
}));

const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  network.bonjour.mockClear();
  network.listen.mockClear();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  expect(network.bonjour).not.toHaveBeenCalled();
  expect(network.listen).not.toHaveBeenCalled();
});

async function fixture(address: string | null = null) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-remote-name-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const codex = path.join(root, "codex");
  const claude = path.join(root, "claude");
  for (const directory of [home, codex, claude, path.join(root, "remote")])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(root, "remote/devices.json");
  writeFileSync(
    file,
    JSON.stringify({
      name: "Original computer",
      enabled: false,
      address,
      authorized: {},
      connections: {},
    }),
    { mode: 0o600 },
  );
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  const commands = new Commands();
  const execute = vi
    .spyOn(commands, "run")
    .mockRejectedValue(new Error("Unexpected native command"));
  cleanups.push(() => commands.close());
  const environment = {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codex,
    CLAUDE_CONFIG_DIR: claude,
    AGENTKIB_HOME: path.join(root, "library"),
    PATH: "",
  };
  const readers = new SessionReaders(store.sessions, commands, environment, { profiles: () => [] });
  cleanups.push(() => readers.close());
  const index = new SessionIndex(store.sessions, readers, () => false);
  cleanups.push(() => index.close());
  function createAgent() {
    const agent = new RemoteAgent(root, store, readers, index);
    cleanups.push(() => agent.close());
    return agent;
  }
  const agent = createAgent();
  await agent.start();
  return {
    agent,
    createAgent,
    execute,
    saved: () => JSON.parse(readFileSync(file, "utf8")),
    contents: () => readFileSync(file, "utf8"),
  };
}

it("rejects an empty address before changing the name even while sharing is disabled", async () => {
  const f = await fixture();
  const before = f.contents();
  await expect(
    f.agent.request({
      operation: "configure",
      enabled: false,
      address: "",
      name: "Renamed computer",
    }),
  ).rejects.toThrow("invalid address");
  expect(await f.agent.request({ operation: "status" })).toMatchObject({
    local: { name: "Original computer", enabled: false, address: null },
  });
  expect(f.contents()).toBe(before);
  expect(f.saved()).toMatchObject({ name: "Original computer", enabled: false, address: null });
  expect(f.execute).not.toHaveBeenCalled();
});

it("renames disabled sharing using a nonempty loopback placeholder without persisting a bind address", async () => {
  const f = await fixture();
  expect(
    await f.agent.request({
      operation: "configure",
      enabled: false,
      address: "127.0.0.1:42987",
      name: "Renamed computer",
    }),
  ).toMatchObject({ local: { name: "Renamed computer", enabled: false, address: null } });
  expect(f.saved()).toEqual({
    name: "Renamed computer",
    enabled: false,
    address: null,
    authorized: {},
    connections: {},
  });
  expect(f.contents()).not.toContain("127.0.0.1");
  await f.agent.close();
  const reloaded = f.createAgent();
  await reloaded.start();
  expect(await reloaded.request({ operation: "status" })).toMatchObject({
    local: { name: "Renamed computer", enabled: false, address: null },
  });
  expect(f.execute).not.toHaveBeenCalled();
});

it("retains a previously saved disabled address when renaming with a placeholder", async () => {
  const existing = "192.168.1.23:42987";
  const f = await fixture(existing);
  expect(
    await f.agent.request({
      operation: "configure",
      enabled: false,
      address: "127.0.0.1:42987",
      name: "Renamed computer",
    }),
  ).toMatchObject({ local: { name: "Renamed computer", enabled: false, address: existing } });
  expect(f.saved()).toMatchObject({ name: "Renamed computer", enabled: false, address: existing });
  expect(f.contents()).not.toContain("127.0.0.1");
  expect(f.execute).not.toHaveBeenCalled();
});
