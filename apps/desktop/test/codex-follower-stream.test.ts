// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexFollowerBridge } from "../../../packages/backend/src/codex-follower-bridge";
import { CodexFollowerConnection } from "../../../packages/backend/src/codex-follower-connection";
import type { CodexFollowerState } from "../../../packages/backend/src/codex-follower-state";

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

function change(revision: number, body: JsonRecord): JsonRecord {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    version: 11,
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

async function fixture(running = true) {
  const socket = new FixtureSocket();
  const connection = Reflect.construct(CodexFollowerConnection, [
    socket,
    "26.930.51102",
    "/synthetic/ipc.sock",
  ]) as CodexFollowerConnection;
  const snapshots: Snapshot[] = [];
  let latestSnapshot = change(1, {
    type: "snapshot",
    conversationState: conversation(running),
  });
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
      latestSnapshot = change(revision, { type: "snapshot", conversationState: body });
    },
    requests: () => socket.sent.filter((value) => value.type === "request"),
    onRequest: (handler: (request: JsonRecord) => boolean) => {
      onRequest = handler;
    },
  };
}

describe("resident native Codex follower stream", () => {
  it("publishes incoming text without a live read and handles split native frames", async () => {
    const f = await fixture();
    const bytes = encode(textPatch(2, "Native text"));
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
      const f = await fixture(false);
      f.onRequest((request) => {
        if (request.method !== "thread-follower-start-turn") return false;
        const update = change(2, { type: "snapshot", conversationState: conversation() });
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
