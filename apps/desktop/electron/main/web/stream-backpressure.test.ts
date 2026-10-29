// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, request, ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationHub } from "../conversation-hub";
import { RUNTIME_METHODS, type SessionStreamEvent } from "../../generated/runtime-protocol";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";
import { createWebControlState, WebAccessService } from "./service";

describe("SSE socket backpressure cleanup", () => {
  let directory: string;
  let service: WebAccessService;
  let hub: ConversationHub;
  let control: ReturnType<typeof createWebControlState>;
  let port: number;
  let cookie: string;
  let deviceId: string;
  let largeBaseline: boolean;
  let response: ServerResponse | undefined;
  let responseSocket: Socket | undefined;
  let backpressure: Promise<void>;
  let signalBackpressure: () => void;
  const clients: Socket[] = [];
  const subscriptions = new Set<string>();
  const drainTimers = new Map<ReturnType<typeof setTimeout>, () => void>();
  const expirationTimers = new Map<ReturnType<typeof setTimeout>, () => void>();
  const activeTimeouts = new Set<ReturnType<typeof setTimeout>>();
  const activeIntervals = new Set<ReturnType<typeof setInterval>>();

  const envelope = {
    protocolVersion: 2,
    subscriptionId: "synthetic-subscription",
    sessionId: "synthetic-session",
    runtimeBootId: "synthetic-boot",
    epoch: "synthetic-epoch",
  } as const;

  beforeEach(async () => {
    largeBaseline = true;
    response = undefined;
    responseSocket = undefined;
    backpressure = new Promise((resolve) => {
      signalBackpressure = resolve;
    });
    subscriptions.clear();
    drainTimers.clear();
    expirationTimers.clear();
    activeTimeouts.clear();
    activeIntervals.clear();
    directory = await mkdtemp(join(tmpdir(), "agentkib-sse-backpressure-"));
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    hub = new ConversationHub(async (method) => {
      if (method === RUNTIME_METHODS.sessionsUnsubscribe) {
        subscriptions.delete(envelope.subscriptionId);
        return { removed: true };
      }
      subscriptions.add(envelope.subscriptionId);
      return {
        subscriptionId: envelope.subscriptionId,
        cursor: "synthetic-epoch:0",
        events: [
          {
            ...envelope,
            seq: 0,
            cursor: "synthetic-epoch:0",
            type: "snapshot",
            payload: {
              live: {
                sessionId: envelope.sessionId,
                executionMode: "codex-follower",
                status: "idle",
                revision: 0,
                sendEnabled: false,
                approvals: [],
                questions: [],
                // Stay below the stream's 4 MiB frame budget, but exceed the
                // receiving socket's window when its application stops reading.
                streamText: largeBaseline ? "x".repeat(4 * 1024 * 1024 - 4096) : "",
              },
            },
          },
        ],
      };
    });
    control = createWebControlState();
    service = new WebAccessService({
      conversationHub: hub,
      sharedControl: control,
      dataDir: directory,
      staticDir: directory,
      runtimeRequest: async () => ({ sessions: [], workspaces: [] }),
      verifiedExperimental: true,
    });
    await service.initialize();
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: true,
    });
    cookie = await new Promise<string>((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port, path: "/api/web/v1/access", agent: false },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.headers["set-cookie"]![0].split(";")[0]));
        },
      );
      req.once("error", reject);
      req.end();
    });
    deviceId = await approveLegacyBrowser(service, cookie);

    const timeout = globalThis.setTimeout;
    const clearTimeout = globalThis.clearTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay !== 30_000 && delay !== 2_147_483_647) return timeout(callback, delay, ...args);
      const fire = () => {
        activeTimeouts.delete(timer);
        drainTimers.delete(timer);
        expirationTimers.delete(timer);
        callback(...args);
      };
      const timer = timeout(fire, delay);
      activeTimeouts.add(timer);
      if (delay === 30_000) {
        drainTimers.set(timer, fire);
        signalBackpressure();
      } else expirationTimers.set(timer, fire);
      return timer;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
      activeTimeouts.delete(timer as ReturnType<typeof setTimeout>);
      drainTimers.delete(timer as ReturnType<typeof setTimeout>);
      expirationTimers.delete(timer as ReturnType<typeof setTimeout>);
      clearTimeout(timer);
    });
    const interval = globalThis.setInterval;
    const clearInterval = globalThis.clearInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const timer = interval(callback, delay, ...args);
      if (delay === 15_000) activeIntervals.add(timer);
      return timer;
    }) as typeof setInterval);
    vi.spyOn(globalThis, "clearInterval").mockImplementation((timer) => {
      activeIntervals.delete(timer as ReturnType<typeof setInterval>);
      clearInterval(timer);
    });
    const write = ServerResponse.prototype.write;
    vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<typeof write>
    ) {
      if (String(args[0]).startsWith("id: ")) {
        response = this;
        responseSocket = this.socket ?? undefined;
      }
      // Use the real write and socket buffer; returning a fabricated false
      // would let end() finish immediately and miss the leaked socket.
      return write.apply(this, args);
    });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    await service.shutdown();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  function openStream(paused: boolean) {
    const chunks: string[] = [];
    const client = connect(port, "127.0.0.1", () => {
      client.write(
        `GET /api/web/v1/stream?protocolVersion=2&sessionId=${envelope.sessionId} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`,
      );
    });
    clients.push(client);
    client.on("error", () => {});
    if (paused) client.pause();
    else client.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    return { client, chunks };
  }

  async function waitForBackpressure() {
    // Observe the actual false write before a fast loopback can drain it into
    // the kernel, rather than depending on the platform's TCP window size.
    await backpressure;
    expect(response?.writableLength).toBeGreaterThan(0);
    expect(response?.listenerCount("drain")).toBe(1);
    expect(drainTimers.size).toBe(1);
    expect(responseSocket?.destroyed).toBe(false);
  }

  function notify(seq: number, text = "x") {
    const event: SessionStreamEvent = {
      ...envelope,
      seq,
      cursor: `synthetic-epoch:${seq}`,
      type: "text-delta",
      payload: { text, offset: seq - 1 },
    };
    hub.notification("sessions.event", event);
  }

  async function expectReleased(hard: boolean) {
    await vi.waitFor(() => {
      expect(subscriptions.size).toBe(0);
      expect((service as unknown as { streams: Map<unknown, unknown> }).streams.size).toBe(0);
      expect(response?.listenerCount("drain")).toBe(0);
      expect(activeTimeouts.size).toBe(0);
      expect(activeIntervals.size).toBe(0);
      expect(hub.listenerCount("unavailable")).toBe(0);
      expect(control.events.listenerCount("changed")).toBe(0);
      if (hard) {
        expect(response?.destroyed).toBe(true);
        expect(responseSocket?.destroyed).toBe(true);
        expect(response?.writableLength).toBe(0);
      }
    });
  }

  it("destroys a non-reading socket when its drain deadline expires", async () => {
    openStream(true);
    await waitForBackpressure();
    [...drainTimers.values()][0]();
    await expectReleased(true);
  });

  it.each(["event-count", "queued-bytes"])(
    "destroys a non-reading socket on %s overflow",
    async (limit) => {
      openStream(true);
      await waitForBackpressure();
      const count = limit === "event-count" ? 513 : 5;
      const text = limit === "event-count" ? "x" : "x".repeat(1024 * 1024);
      for (let seq = 1; seq <= count; seq++) notify(seq, text);
      await expectReleased(true);
    },
  );

  it("cancels a pending drain and closes the socket when scopes become unavailable", async () => {
    openStream(true);
    await waitForBackpressure();
    hub.scopesChanged();
    await expectReleased(true);
  });

  it.each(["revoke", "expire"])("destroys a non-reading socket on access %s", async (reason) => {
    openStream(true);
    await waitForBackpressure();
    if (reason === "revoke") await service.request({ operation: "revoke", id: deviceId });
    else {
      const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 24 * 60 * 60 * 1000);
      expect(expirationTimers.size).toBe(1);
      [...expirationTimers.values()][0]();
      now.mockRestore();
    }
    await expectReleased(true);
  });

  it("finishes a healthy stream with its unavailable frame and releases all timers", async () => {
    largeBaseline = false;
    const stream = openStream(false);
    await vi.waitFor(() => expect(stream.chunks.join("")).toContain("event: session-ready"));
    hub.scopesChanged();
    await vi.waitFor(() => expect(stream.chunks.join("")).toContain("event: unavailable"));
    await expectReleased(false);
    expect(response?.writableFinished).toBe(true);
    await vi.waitFor(() => expect(stream.client.destroyed).toBe(true));
  });
});
