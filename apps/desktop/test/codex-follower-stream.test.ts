// @vitest-environment node
import { EventEmitter, once } from "node:events";
import { chmod, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexFollowerBridge } from "../../../packages/backend/src/agents/codex/codex-follower-bridge";
import { CodexFollowerConnection } from "../../../packages/backend/src/agents/codex/codex-follower-connection";
import type { CodexFollowerState } from "../../../packages/backend/src/agents/codex/codex-follower-state";

type JsonRecord = Record<string, unknown>;
type Snapshot = ReturnType<CodexFollowerState["streamSnapshot"]>;

const threadId = "01234567-89ab-cdef-0123-456789abcdef";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  vi.restoreAllMocks();
});

function conversation(running = true) {
  return {
    id: threadId,
    hostId: "local",
    threadRuntimeStatus: { type: running ? "active" : "idle" },
    turns: running
      ? [
          {
            turnId: "turn-a",
            status: "inProgress",
            items: [{ id: "reply-a", type: "agentMessage", text: "" }],
          },
        ]
      : [],
    requests: [],
  };
}

function change(revision: number, body: JsonRecord, version = 11): JsonRecord {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    version,
    sourceClientId: "owner",
    params: {
      conversationId: threadId,
      hostId: "local",
      change: { revision, ...body },
    },
  };
}

function textPatch(revision: number, text: string, baseRevision = revision - 1) {
  return change(revision, {
    type: "patches",
    baseRevision,
    patches: [{ op: "replace", path: ["turns", 0, "items", 0, "text"], value: text }],
  });
}

function encode(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.byteLength);
  return Buffer.concat([header, body]);
}

/** Uses the production frame parser and request dispatcher without opening a native session. */
class FixtureSocket extends EventEmitter {
  destroyed = false;
  readonly sent: JsonRecord[] = [];
  onFrame: (value: JsonRecord) => void = () => {};

  write(bytes: Buffer, done: (error?: Error) => void) {
    const value = JSON.parse(bytes.subarray(4).toString("utf8")) as JsonRecord;
    this.sent.push(value);
    done();
    this.onFrame(value);
    return true;
  }

  push(...values: JsonRecord[]) {
    this.emit("data", Buffer.concat(values.map(encode)));
  }

  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }
}

async function fixture(running = true, streamVersion = 11, settings = false) {
  const socket = new FixtureSocket();
  const connection = Reflect.construct(CodexFollowerConnection, [
    socket,
    "26.930.51102",
    "/synthetic/ipc.sock",
    settings ? "/synthetic/bundled-codex" : undefined,
  ]) as CodexFollowerConnection;
  const snapshots: Snapshot[] = [];
  let latestSnapshot = change(
    1,
    { type: "snapshot", conversationState: conversation(running) },
    streamVersion,
  );
  const response = (request: JsonRecord) => ({
    type: "response",
    requestId: request.requestId,
    resultType: "success",
    handledByClientId: "owner",
    method: request.method,
    result: {},
  });
  let onRequest: ((request: JsonRecord) => boolean) | undefined;
  socket.onFrame = (value) => {
    if (value.type === "request") {
      if (onRequest?.(value)) return;
      socket.push(response(value));
    } else if (
      value.method === "thread-stream-following-changed" &&
      (value.params as JsonRecord).following === true
    ) {
      socket.push(latestSnapshot);
    }
  };
  vi.spyOn(CodexFollowerConnection, "connectInstalled").mockResolvedValue(connection);
  const bridge = await CodexFollowerBridge.connect("/synthetic/ipc.sock", threadId, (snapshot) => {
    snapshots.push(snapshot);
  });
  cleanups.push(() => bridge.close());
  return {
    socket,
    connection,
    bridge,
    snapshots,
    response,
    setSnapshot: (revision: number, body: JsonRecord) => {
      latestSnapshot = change(
        revision,
        { type: "snapshot", conversationState: body },
        streamVersion,
      );
    },
    requests: () => socket.sent.filter((value) => value.type === "request"),
    onRequest: (handler: (request: JsonRecord) => boolean) => {
      onRequest = handler;
    },
  };
}

describe("Codex desktop owner connection diagnostics", () => {
  it.skipIf(process.platform === "win32")(
    "reports a private socket inode without a listener",
    async () => {
      vi.spyOn(CodexFollowerConnection, "supported").mockReturnValue(true);
      const dir = await realpath(await mkdtemp(join(tmpdir(), "ak-follower-")));
      const listening = join(dir, "router.sock");
      const stale = join(dir, "stale.sock");
      const router = createServer();
      try {
        router.listen(listening);
        await once(router, "listening");
        await chmod(listening, 0o600);
        // Keep the filesystem socket after the fake app has stopped listening.
        await rename(listening, stale);
        const closed = once(router, "close");
        router.close();
        await closed;
        await expect(CodexFollowerConnection.connectInstalled(stale)).rejects.toMatchObject({
          code: "codex-desktop-ipc-unavailable",
          cause: { code: "ECONNREFUSED" },
        });
      } finally {
        if (router.listening) router.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [{ resultType: "error", error: "no-client-found" }, "codex-desktop-owner-missing"],
    [{ resultType: "error", error: "different-protocol" }, "codex-desktop-ipc-incompatible"],
    [{ resultType: "success", result: {} }, "codex-desktop-ipc-incompatible"],
  ] as const)("classifies the owner discovery response %j", async (response, code) => {
    const socket = new FixtureSocket();
    const endpoint = "/synthetic/ipc.sock";
    const connection = Reflect.construct(CodexFollowerConnection, [
      socket,
      "26.1117.41037",
      endpoint,
    ]) as CodexFollowerConnection;
    vi.spyOn(CodexFollowerConnection, "connectInstalled").mockResolvedValue(connection);
    socket.onFrame = (request) => {
      if (request.method === "thread-owner-discovery")
        socket.push({
          type: "response",
          requestId: request.requestId,
          method: request.method,
          ...response,
        });
    };
    await expect(CodexFollowerBridge.connect(endpoint, threadId)).rejects.toMatchObject({ code });
    expect(socket.sent.map(({ method }) => method)).toEqual(["thread-owner-discovery"]);
    expect(socket.destroyed).toBe(true);
  });
});

describe("resident native Codex follower stream", () => {
  it.each([
    ["confirmed", false],
    ["confirmed", true],
    ["refused", false],
    ["refused", true],
    ["invalid-ack", true],
    ["mismatched-readback", true],
    ["changed-owner", false],
  ] as const)(
    "requires the current owner and readback to confirm native settings: %s (running=%s)",
    async (scenario, running) => {
      const f = await fixture(running, 14, true);
      const oldSettings = { model: "model-a", effort: "low", modelProvider: "openai" };
      const requested = { ...oldSettings, effort: "high" };
      const conversationWithSettings = (settings: typeof oldSettings) => ({
        ...conversation(running),
        cwd: "/synthetic/workspace",
        latestModel: settings.model,
        latestReasoningEffort: settings.effort,
        modelProvider: settings.modelProvider,
      });
      const initial = conversationWithSettings(oldSettings);
      f.setSnapshot(2, initial);
      f.socket.push(change(2, { type: "snapshot", conversationState: initial }, 14));
      await vi.waitFor(() => expect(f.bridge.selectedState?.revision).toBe(2));
      let dispatched = false;
      const onDispatch = vi.fn(() => {
        dispatched = true;
      });
      const onApplied = vi.fn();
      f.onRequest((request) => {
        const reply = f.response(request);
        if (
          request.method === "thread-owner-discovery" &&
          dispatched &&
          scenario === "changed-owner"
        ) {
          f.socket.push({ ...reply, handledByClientId: "different-owner" });
        } else if (request.method === "thread-follower-read-model-settings") {
          const settings = dispatched && scenario === "confirmed" ? requested : oldSettings;
          f.socket.push({
            ...reply,
            result: { settings: { ...settings, reasoningEffort: settings.effort } },
          });
        } else if (request.method === "thread-follower-update-thread-settings") {
          if (scenario !== "refused") f.setSnapshot(3, conversationWithSettings(requested));
          f.socket.push({
            ...reply,
            result: scenario === "invalid-ack" ? {} : { applied: scenario !== "refused" },
          });
        } else return false;
        return true;
      });

      const mutation = f.bridge.updateModelSettings({
        expectedScope: f.bridge.selectedState!.settingsWriteScope,
        expectedRevision: 2,
        current: oldSettings,
        next: requested,
        onDispatch,
        onApplied,
      });
      if (scenario === "confirmed") await expect(mutation).resolves.toBe(true);
      else if (scenario === "refused") await expect(mutation).resolves.toBe(false);
      else await expect(mutation).rejects.toThrow();

      expect(onDispatch).toHaveBeenCalledOnce();
      expect(onApplied).toHaveBeenCalledTimes(
        ["invalid-ack", "refused"].includes(scenario) ? 0 : 1,
      );
      const dispatchedRequests = f
        .requests()
        .filter((request) => request.method === "thread-follower-update-thread-settings");
      expect(dispatchedRequests).toMatchObject([
        {
          version: 2,
          targetClientId: "owner",
          params: {
            conversationId: threadId,
            threadSettings: { effort: "high" },
            condition: { ifModelEquals: "model-a", ifEffortEquals: "low" },
          },
        },
      ]);
      expect((dispatchedRequests[0]!.params as JsonRecord).threadSettings).toEqual({
        effort: "high",
      });
      expect(dispatchedRequests[0]!.params).not.toHaveProperty("activeTurnId");
      if (scenario === "refused" || scenario === "confirmed")
        expect(f.bridge.selectedState?.status).toBe(running ? "running" : "idle");
    },
  );

  it("does not reproject duplicate and unrelated native notifications", async () => {
    const f = await fixture();
    f.socket.push(
      { ...textPatch(2, "Unrelated"), sourceClientId: "another-owner" },
      change(1, { type: "snapshot", conversationState: conversation() }),
      textPatch(2, "Selected thread"),
    );
    await vi.waitFor(() => expect(f.snapshots.at(-1)?.live.revision).toBe(2));
    expect(f.snapshots.map(({ live }) => live.revision)).toEqual([1, 2]);
    expect(f.bridge.selectedState?.snapshotCount).toBe(2);
  });

  it.each([11, 13, 14])(
    "publishes incremental text on v%i without another live read",
    async (version) => {
      const f = await fixture(true, version);
      const bytes = encode({ ...textPatch(2, "Native text"), version });
      f.socket.emit("data", bytes.subarray(0, 7));
      f.socket.emit("data", bytes.subarray(7));

      await vi.waitFor(() => {
        expect(f.snapshots.at(-1)?.items).toEqual([
          expect.objectContaining({ id: "reply-a", content: "Native text" }),
        ]);
      });
      expect(f.bridge.selectedState?.revision).toBe(2);
      // The stream must not acquire a writer or issue a control/read RPC for every token.
      expect(f.requests().map((value) => value.method)).toEqual(["thread-owner-discovery"]);
    },
  );

  it("rejects an incompatible increment even from the selected owner", async () => {
    const f = await fixture(true, 14);
    f.socket.push(change(2, { type: "patches", baseRevision: 1, patches: {} }, 14));
    await vi.waitFor(() => expect(f.bridge.selectedState?.revision).toBeNull());
    expect(f.bridge.selectedState?.status).toBe("unsupported");
    expect(f.snapshots.map(({ live }) => live.revision)).toEqual([1]);
  });

  it("invalidates a snapshot with an incompatible native request structure", async () => {
    const f = await fixture(false, 14);
    f.socket.push(
      change(
        2,
        {
          type: "snapshot",
          conversationState: { ...conversation(false), requests: [{ requestId: "approval-a" }] },
        },
        14,
      ),
    );
    await vi.waitFor(() => expect(f.bridge.selectedState?.revision).toBeNull());
    expect(f.bridge.selectedState?.status).toBe("unsupported");
    expect(f.snapshots.map(({ live }) => live.revision)).toEqual([1]);
  });

  it("does not dispatch a send when the owner adds an unrecognized turn status", async () => {
    const f = await fixture(false, 14);
    f.socket.push(
      change(
        2,
        {
          type: "snapshot",
          conversationState: {
            ...conversation(false),
            turns: [{ turnId: "turn-a", status: "queued", items: [] }],
          },
        },
        14,
      ),
    );
    await vi.waitFor(() => expect(f.bridge.selectedState?.revision).toBe(2));
    expect(f.snapshots.at(-1)?.live).toMatchObject({ status: "unsupported", sendEnabled: false });
    const dispatched = vi.fn();
    await expect(f.bridge.mutate("thread-follower-start-turn", {}, 2, dispatched)).rejects.toThrow(
      "follower-operation-unverified",
    );
    expect(dispatched).not.toHaveBeenCalled();
  });

  it("continues draining bursts beyond a single bounded notification batch", async () => {
    const f = await fixture();
    const frames = Array.from({ length: 70 }, (_, index) =>
      textPatch(index + 2, "x".repeat(index + 1)),
    );
    f.socket.push(...frames);

    await vi.waitFor(() => {
      expect(f.bridge.selectedState?.revision).toBe(71);
      expect(f.snapshots.at(-1)?.items[0]?.content).toBe("x".repeat(70));
    });
    expect(f.requests()).toHaveLength(1);
  });

  it.each(["before", "after"])(
    "keeps a mutation acknowledgement separate from notifications %s its response",
    async (order) => {
      const f = await fixture(false, 14);
      f.onRequest((request) => {
        if (request.method !== "thread-follower-start-turn") return false;
        const update = change(2, { type: "snapshot", conversationState: conversation() }, 14);
        f.setSnapshot(2, conversation());
        const acknowledgement = f.response(request);
        f.socket.push(
          ...(order === "before" ? [update, acknowledgement] : [acknowledgement, update]),
        );
        return true;
      });
      const dispatched = vi.fn();

      await expect(
        f.bridge.mutate("thread-follower-start-turn", {}, 1, dispatched),
      ).resolves.toEqual({});
      await vi.waitFor(() => expect(f.bridge.selectedState?.revision).toBe(2));
      expect(dispatched).toHaveBeenCalledTimes(1);
      expect(
        f.requests().filter((value) => value.method === "thread-follower-start-turn"),
      ).toHaveLength(1);
      expect(
        f
          .requests()
          .every((value) =>
            ["thread-owner-discovery", "thread-follower-start-turn"].includes(String(value.method)),
          ),
      ).toBe(true);
    },
  );

  it("invalidates a disconnected owner without needing the next snapshot poll", async () => {
    const f = await fixture();
    f.socket.push({
      type: "broadcast",
      method: "client-status-changed",
      version: 1,
      sourceClientId: "owner",
      params: { clientId: "owner", status: "disconnected" },
    });

    await vi.waitFor(() => {
      expect(f.bridge.selectedState?.revision).toBeNull();
      expect(f.bridge.selectedState?.status).toBe("disconnected");
    });
    expect(f.requests()).toHaveLength(1);
  });

  it("stops delivery after owner discovery reports a replacement owner", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const f = await fixture();
    f.onRequest((request) => {
      if (request.method !== "thread-owner-discovery") return false;
      f.socket.push({ ...f.response(request), handledByClientId: "replacement-owner" });
      return true;
    });
    clock.mockReturnValue(now + 2_001);
    f.socket.push(textPatch(2, "Stale owner text"));

    await vi.waitFor(() => expect(f.connection.connected).toBe(false));
    expect(f.bridge.selectedState?.revision).toBeNull();
    const published = f.snapshots.length;
    f.socket.push(textPatch(3, "Must not arrive after owner replacement"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.snapshots).toHaveLength(published);
  });

  it("disconnects on a missing revision and requires a fresh connection to recover", async () => {
    const f = await fixture();
    const published = f.snapshots.length;
    f.socket.push(textPatch(3, "Out of order", 2));
    await vi.waitFor(() => expect(f.bridge.selectedState?.revision).toBeNull());
    expect(f.bridge.selectedState?.status).toBe("unsupported");
    expect(f.snapshots).toHaveLength(published);

    await expect(f.bridge.observeLive()).rejects.toThrow("Codex IPC disconnected");
    const recovered = await fixture();
    expect(recovered.bridge.selectedState?.revision).toBe(1);
    expect(recovered.bridge.selectedState?.streamSnapshot().items[0]?.content).toBe("");
    f.socket.push(textPatch(4, "Late text from the failed connection"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(recovered.bridge.selectedState?.revision).toBe(1);
  });

  it("stops queued delivery and unfollows the selected thread on close", async () => {
    const f = await fixture();
    const published = f.snapshots.length;
    f.socket.push(textPatch(2, "Must not arrive after close"));
    f.bridge.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(f.snapshots).toHaveLength(published);
    expect(f.connection.connected).toBe(false);
    expect(f.socket.sent.at(-1)).toMatchObject({
      method: "thread-stream-following-changed",
      params: { conversationId: threadId, following: false },
    });
  });
});
