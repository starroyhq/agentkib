import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Commands } from "../../../packages/backend/src/commands";
import { RemoteAgent } from "../../../packages/backend/src/remote-agent";
import { SessionIndex } from "../../../packages/backend/src/session-index";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";
import type { RemoteTlsRequestHandler } from "../../../packages/backend/src/remote-tls";

const network = vi.hoisted(() => ({ handler: undefined as RemoteTlsRequestHandler | undefined }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  networkInterfaces: () => ({
    test: [{ family: "IPv4", internal: false, address: "192.168.20.10" }],
  }),
}));
vi.mock("bonjour-service", () => ({
  default: class {
    find() {
      return { on() {}, start() {}, stop() {}, update() {} };
    }
    publish() {
      return { stop() {} };
    }
    destroy() {}
  },
}));
vi.mock("../../../packages/backend/src/remote-tls", async (original) => ({
  ...(await original<typeof import("../../../packages/backend/src/remote-tls")>()),
  listenRemoteAgent: async (
    _identity: unknown,
    address: string,
    handler: RemoteTlsRequestHandler,
  ) => {
    network.handler = handler;
    return { address, close: async () => {}, disconnectPeer() {} };
  },
}));
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  network.handler = undefined;
});

async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-remote-read-state-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "remote"), { mode: 0o700 });
  const peer = "a".repeat(64);
  writeFileSync(
    path.join(root, "remote/devices.json"),
    JSON.stringify({
      name: "Synthetic host",
      enabled: false,
      address: null,
      connections: {},
      authorized: {
        [peer]: {
          id: peer,
          name: "Synthetic viewer",
          approved_at: 1,
          last_seen: null,
          grant_id: "grant",
        },
      },
    }),
    { mode: 0o600 },
  );
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanup.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "w",
    root,
    "Fixture",
    "healthy",
    "2026-11-03T00:00:00Z",
  );
  const commands = new Commands();
  cleanup.push(() => commands.close());
  const readers = new SessionReaders(
    store.sessions,
    commands,
    { PATH: "", CODEX_HOME: path.join(root, "codex") },
    { profiles: () => [] },
  );
  cleanup.push(() => readers.close());
  const index = new SessionIndex(store.sessions, readers, () => false);
  cleanup.push(() => index.close());
  const row = {
    id: "s",
    workspace_id: "w",
    agent: "codex",
    title: "Synthetic",
    availability: "readable",
    archived: false,
    sidechain: false,
  };
  vi.spyOn(index, "read").mockResolvedValue([
    row as Awaited<ReturnType<SessionIndex["read"]>>[number],
  ]);
  const state = {
    source: "agentkib" as const,
    status: "unread" as const,
    freshness: "current" as const,
    version: "v1",
    firstUnread: { type: "threadStart" as const },
    latestResult: null,
  };
  const receipts = {
    get: vi.fn(async () => state),
    update: vi.fn(async () => state),
    project: <T>(rows: T[]) => rows.map((item) => ({ ...item, readState: state })),
  };
  const agent = new RemoteAgent(root, store, readers, index, receipts);
  cleanup.push(() => agent.close());
  await agent.request({
    operation: "configure",
    enabled: true,
    address: "192.168.20.10:39091",
    name: "Synthetic host",
  });
  const request = (body: Record<string, unknown>, id = peer) =>
    network.handler!(id, "verified", body, new AbortController().signal);
  return { agent, peer, request, receipts, state, index, row };
}

it("projects and acknowledges through an approved read-only peer with a host-owned scope", async () => {
  const f = await fixture();
  expect(await f.request({ op: "catalog" })).toMatchObject({
    sessions: [{ id: "s", readState: f.state }],
  });
  expect(await f.request({ op: "read-state", session_id: "s" })).toEqual({ readState: f.state });
  expect(
    await f.request({
      op: "read-state-update",
      session_id: "s",
      expectedVersion: "v1",
      seenResultId: null,
    }),
  ).toEqual({ readState: f.state });
  expect(f.receipts.get).toHaveBeenCalledExactlyOnceWith("s", "local");
  expect(f.receipts.update).toHaveBeenCalledExactlyOnceWith("s", "local", "v1", null);
});

it("rejects unpaired peers, injected identity and unregistered sessions", async () => {
  const f = await fixture();
  await expect(f.request({ op: "read-state", session_id: "s" }, "unknown")).rejects.toThrow(
    "revoked",
  );
  await expect(
    f.request({ op: "read-state", session_id: "s", readerScope: "other" }),
  ).rejects.toThrow("invalid read-state request");
  await expect(
    f.request({
      op: "read-state-update",
      session_id: "other",
      expectedVersion: "v1",
      seenResultId: null,
    }),
  ).rejects.toThrow("read-state-unsupported");
  expect(f.receipts.get).not.toHaveBeenCalled();
  expect(f.receipts.update).not.toHaveBeenCalled();
});

it("does not replay a conflict and rechecks revocation after native completion", async () => {
  const f = await fixture();
  f.receipts.update.mockRejectedValueOnce(new Error("read-state-conflict"));
  const body = {
    op: "read-state-update",
    session_id: "s",
    expectedVersion: "v1",
    seenResultId: null,
  };
  await expect(f.request(body)).rejects.toThrow("read-state-conflict");
  expect(f.receipts.update).toHaveBeenCalledTimes(1);
  f.receipts.update.mockImplementationOnce(async () => {
    await f.agent.request({ operation: "revoke", id: f.peer });
    return f.state;
  });
  await expect(f.request(body)).rejects.toThrow("revoked");
  expect(f.receipts.update).toHaveBeenCalledTimes(2);
});

it("does not dispatch an acknowledgement after revocation during catalog preflight", async () => {
  const f = await fixture();
  vi.mocked(f.index.read).mockImplementationOnce(async () => {
    await f.agent.request({ operation: "revoke", id: f.peer });
    return [f.row as Awaited<ReturnType<SessionIndex["read"]>>[number]];
  });
  await expect(
    f.request({
      op: "read-state-update",
      session_id: "s",
      expectedVersion: "v1",
      seenResultId: null,
    }),
  ).rejects.toThrow("revoked");
  expect(f.receipts.update).not.toHaveBeenCalled();
});
