import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";
import {
  RUNTIME_METHODS,
  SESSION_EVENT_NOTIFICATION,
  type SessionStreamEvent,
  type SessionSubscription,
} from "../generated/runtime-protocol";
import { ConversationHub } from "../main/conversation-hub";
import { registerConversationIpc } from "../main/ipc/conversation";
import { createWebControlState, WebAccessService } from "../main/web/service";

const scratch = process.env.AGENTKIB_CONVERSATION_BACKPRESSURE;
if (!scratch) throw new Error("Missing isolated backpressure configuration");
app.setPath("userData", path.join(scratch, "electron"));
app.setName("AgentKib isolated IPC acceptance");

const nativeCalls: { method: string; subscriptionId?: string }[] = [];
const subscriptions = new Map<string, { sessionId: string; active: boolean }>();
const revisions = new Map<string, number>();
let nextSubscription = 0;
function event(
  subscriptionId: string,
  sessionId: string,
  seq: number,
  type: SessionStreamEvent["type"],
  payload: SessionStreamEvent["payload"],
): SessionStreamEvent {
  return {
    protocolVersion: 2,
    subscriptionId,
    sessionId,
    runtimeBootId: "synthetic-boot",
    epoch: `synthetic-${sessionId}`,
    seq,
    cursor: `synthetic-${sessionId}:${seq}`,
    type,
    payload,
  };
}
const hub = new ConversationHub(async (method, params) => {
  const input = params as { sessionId?: string; subscriptionId?: string };
  nativeCalls.push({ method, subscriptionId: input.subscriptionId });
  if (method === RUNTIME_METHODS.sessionsSubscribe) {
    const sessionId = input.sessionId!;
    const subscriptionId = `synthetic-sub-${++nextSubscription}`;
    subscriptions.set(subscriptionId, { sessionId, active: true });
    const seq = revisions.get(sessionId) ?? 0;
    const snapshot = event(subscriptionId, sessionId, seq, "snapshot", {
      live: { sessionId, revision: seq, status: "running", streamText: `baseline-${seq}` },
    });
    return { subscriptionId, cursor: snapshot.cursor, events: [snapshot] };
  }
  if (method === RUNTIME_METHODS.sessionsUnsubscribe) {
    const subscription = subscriptions.get(input.subscriptionId!);
    if (subscription) subscription.active = false;
    return { removed: !!subscription };
  }
  throw new Error(`Unexpected native command: ${method}`);
});
const service = new WebAccessService({
  conversationHub: hub,
  sharedControl: createWebControlState(),
  dataDir: path.join(scratch, "service"),
  staticDir: scratch,
  sessionRequest: async () => {
    throw new Error("Backpressure acceptance must not invoke native controls");
  },
});

interface ProbeStats {
  subscriptionId: string;
  dataEvents: number;
  dataBytes: number;
  resyncEvents: number;
  resyncReasons: string[];
  lastSeq: number;
  baselineSeq: number;
  appliedEvents: number;
  acknowledgedEvents: number;
  errors: string[];
}

// The slow subscription's probe observes transport metadata only; it deliberately
// never applies its data or acknowledges it. Healthy consumers apply before ACK.
const rendererHarness = `(() => {
  const api = window.desktopConversation;
  if (typeof api?.acknowledge !== "function") throw new Error("Production preload lacks ACK");
  const subscriptions = new Map();
  function receive(event) {
    const state = subscriptions.get(event.subscriptionId);
    if (!state) throw new Error("Unexpected subscription event");
    if (event.type === "resync-required") {
      state.stats.resyncEvents++;
      state.stats.resyncReasons.push(event.payload.reason);
      return;
    }
    state.stats.dataEvents++;
    state.stats.dataBytes += new TextEncoder().encode(JSON.stringify(event)).byteLength;
    state.stats.lastSeq = event.seq;
    if (!state.consume) return;
    state.appliedCursor = event.cursor;
    state.stats.appliedEvents++;
    state.pending = state.pending.then(async () => {
      await api.acknowledge(event.subscriptionId, event.cursor);
      state.stats.acknowledgedEvents++;
    }).catch((error) => state.stats.errors.push(String(error)));
  }
  api.onEvent(receive);
  window.backpressureProbe = {
    async subscribe(sessionId, consume) {
      const result = await api.subscribe(sessionId);
      subscriptions.set(result.subscriptionId, {
        consume, pending: Promise.resolve(),
        stats: { subscriptionId: result.subscriptionId, dataEvents: 0, dataBytes: 0,
          resyncEvents: 0, resyncReasons: [], lastSeq: -1,
          baselineSeq: result.events[0]?.seq, appliedEvents: 0, acknowledgedEvents: 0, errors: [] },
      });
      for (const event of result.events) receive(event);
      await this.flush();
      return { subscriptionId: result.subscriptionId, cursor: result.cursor,
        events: result.events.map(({ payload, ...event }) => event) };
    },
    async flush() { await Promise.all([...subscriptions.values()].map((state) => state.pending)); },
    stats(id) { return subscriptions.get(id).stats; },
    unsubscribe(id) { return api.unsubscribe(id); },
  };
})();`;

const windows: BrowserWindow[] = [];
let finishing = false;
async function finish(code: number) {
  if (finishing) return;
  finishing = true;
  await service.shutdown();
  for (const window of windows) window.destroy();
  hub.unavailable();
  app.exit(code);
}
app.on("window-all-closed", () => {
  if (!finishing) void finish(1);
});
const timeout = setTimeout(() => {
  console.error("Isolated backpressure acceptance exceeded 45 seconds");
  void finish(1);
}, 45_000);

function run<T>(window: BrowserWindow, expression: string): Promise<T> {
  return window.webContents.executeJavaScript(`window.backpressureProbe.${expression}`);
}
function subscribe(window: BrowserWindow, sessionId: string, consume: boolean) {
  return run<SessionSubscription>(window, `subscribe(${JSON.stringify(sessionId)}, ${consume})`);
}
function stats(window: BrowserWindow, id: string) {
  return run<ProbeStats>(window, `stats(${JSON.stringify(id)})`);
}
function unsubscribe(window: BrowserWindow, id: string) {
  return run(window, `unsubscribe(${JSON.stringify(id)})`);
}
function emit(sessionId: string, text: string) {
  const seq = (revisions.get(sessionId) ?? 0) + 1;
  revisions.set(sessionId, seq);
  // Include detached IDs to prove even late source notifications stop at the Hub.
  for (const [id, subscription] of subscriptions)
    if (subscription.sessionId === sessionId)
      hub.notification(
        SESSION_EVENT_NOTIFICATION,
        event(id, sessionId, seq, "text-delta", { text, offset: seq - 1 }),
      );
}
async function flush() {
  // A same-WebContents executeJavaScript barrier follows already-sent IPC events.
  await Promise.all(windows.map((window) => run(window, "flush()")));
}
function assertDetached(id: string) {
  assert.equal(subscriptions.get(id)?.active, false, "Overflow must detach the Hub observer");
  assert.equal(
    nativeCalls.filter(
      (call) => call.method === RUNTIME_METHODS.sessionsUnsubscribe && call.subscriptionId === id,
    ).length,
    1,
    "Overflow must only unsubscribe once",
  );
}
function assertHealthy(value: ProbeStats, lastSeq: number, events: number) {
  assert.equal(value.lastSeq, lastSeq);
  assert.equal(value.dataEvents, events);
  assert.equal(value.appliedEvents, events);
  assert.equal(value.acknowledgedEvents, events);
  assert.equal(value.resyncEvents, 0);
  assert.deepEqual(value.errors, []);
}

async function acceptance() {
  await app.whenReady();
  await service.initialize();
  const renderer = pathToFileURL(path.join(scratch!, "renderer.html")).href;
  for (const name of ["slow", "healthy"])
    windows.push(
      new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(scratch!, "bundle/preload.cjs"),
          partition: `isolated-backpressure-${name}`,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      }),
    );
  registerConversationIpc({
    service,
    hub,
    assertTrustedRenderer(event) {
      if (
        !windows.some((window) => window.webContents === event.sender) ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== renderer
      )
        throw new Error("Untrusted backpressure renderer");
    },
  });
  await Promise.all(
    windows.map(async (window) => {
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      await window.loadURL(renderer);
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      await window.webContents.executeJavaScript(rendererHarness);
    }),
  );
  const [slowWindow, healthyWindow] = windows;
  const rendererPids = windows.map((window) => window.webContents.getOSProcessId());
  assert.notEqual(rendererPids[0], rendererPids[1], "The windows must use separate renderers");

  const countSlow = await subscribe(slowWindow, "count", false);
  const countSame = await subscribe(slowWindow, "count", true);
  const countOther = await subscribe(healthyWindow, "count", true);
  for (let index = 0; index < 272; index++) {
    emit("count", "x");
    if (index % 8 === 7) await flush();
  }
  await flush();
  const count = {
    attemptedDeltas: 272,
    slow: await stats(slowWindow, countSlow.subscriptionId),
    sameRenderer: await stats(slowWindow, countSame.subscriptionId),
    otherRenderer: await stats(healthyWindow, countOther.subscriptionId),
  };
  assert.equal(count.slow.dataEvents, 256, "The 256-event budget includes bootstrap");
  assert.equal(count.slow.appliedEvents, 0);
  assert.equal(count.slow.acknowledgedEvents, 0);
  assert.equal(count.slow.resyncEvents, 1);
  assert.deepEqual(count.slow.resyncReasons, ["desktop-subscriber-overflow"]);
  assertDetached(countSlow.subscriptionId);
  assertHealthy(count.sameRenderer, 272, 273);
  assertHealthy(count.otherRenderer, 272, 273);

  // A detached slow subscriber still occupies one of its renderer's four slots.
  const spareA = await subscribe(slowWindow, "spare-a", true);
  const spareB = await subscribe(slowWindow, "spare-b", true);
  const requestsBeforeLimit = nativeCalls.length;
  await assert.rejects(subscribe(slowWindow, "over-limit", true), /stream_limit/);
  assert.equal(nativeCalls.length, requestsBeforeLimit);
  await unsubscribe(slowWindow, spareA.subscriptionId);
  await unsubscribe(slowWindow, spareB.subscriptionId);
  await unsubscribe(slowWindow, countSlow.subscriptionId);
  assertDetached(countSlow.subscriptionId);
  const recovered = await subscribe(slowWindow, "count", true);
  assert.notEqual(recovered.subscriptionId, countSlow.subscriptionId);
  assert.equal(recovered.events[0]?.type, "snapshot");
  const recoveryBaseline = await stats(slowWindow, recovered.subscriptionId);
  assert.equal(recoveryBaseline.baselineSeq, 272);
  emit("count", "recovered");
  await flush();
  const recovery = await stats(slowWindow, recovered.subscriptionId);
  assertHealthy(recovery, 273, 2);
  assert.equal((await stats(slowWindow, countSlow.subscriptionId)).resyncEvents, 1);
  await unsubscribe(slowWindow, recovered.subscriptionId);
  await unsubscribe(slowWindow, countSame.subscriptionId);
  await unsubscribe(healthyWindow, countOther.subscriptionId);

  const byteSlow = await subscribe(slowWindow, "bytes", false);
  const byteSame = await subscribe(slowWindow, "bytes", true);
  const byteOther = await subscribe(healthyWindow, "bytes", true);
  const payloadBytes = 512 * 1024;
  for (let index = 0; index < 12; index++) {
    emit("bytes", "x".repeat(payloadBytes));
    await flush();
  }
  const bytes = {
    attemptedDeltas: 12,
    payloadBytes,
    slow: await stats(slowWindow, byteSlow.subscriptionId),
    sameRenderer: await stats(slowWindow, byteSame.subscriptionId),
    otherRenderer: await stats(healthyWindow, byteOther.subscriptionId),
  };
  assert.equal(bytes.slow.dataEvents, 8, "Bootstrap plus seven 512 KiB events fit under 4 MiB");
  assert.ok(bytes.slow.dataBytes <= 4 * 1024 * 1024);
  assert.ok(bytes.slow.dataBytes + payloadBytes > 4 * 1024 * 1024);
  assert.equal(bytes.slow.appliedEvents, 0);
  assert.equal(bytes.slow.acknowledgedEvents, 0);
  assert.equal(bytes.slow.resyncEvents, 1);
  assert.deepEqual(bytes.slow.resyncReasons, ["desktop-subscriber-overflow"]);
  assertDetached(byteSlow.subscriptionId);
  assertHealthy(bytes.sameRenderer, 12, 13);
  assertHealthy(bytes.otherRenderer, 12, 13);
  await unsubscribe(slowWindow, byteSlow.subscriptionId);
  await unsubscribe(slowWindow, byteSame.subscriptionId);
  await unsubscribe(healthyWindow, byteOther.subscriptionId);
  assert.equal([...subscriptions.values()].filter((subscription) => subscription.active).length, 0);
  assert.ok(
    nativeCalls.every(
      (call) =>
        call.method === RUNTIME_METHODS.sessionsSubscribe ||
        call.method === RUNTIME_METHODS.sessionsUnsubscribe,
    ),
  );
  return {
    passed: true,
    createdAt: new Date().toISOString(),
    scope:
      "bounded synthetic source → production ConversationHub + WebAccessService → production Electron IPC + preload → two isolated Chromium renderers",
    boundary:
      "The slow consumer probes transport metadata without applying or ACKing data; the renderer event loop remains responsive. This is IPC acceptance, not a native-agent or React rendering benchmark. No Runtime, real account, task, or network listener is started.",
    environment: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      rendererPids,
    },
    count,
    bytes,
    recovery,
    detachedOwnerRetainsRendererSlot: true,
    nativeCalls,
    nativeControlCommands: 0,
  };
}

void acceptance()
  .then(async (report) => {
    await writeFile(path.join(scratch!, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    clearTimeout(timeout);
    await finish(0);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await writeFile(
      path.join(scratch!, "report.json"),
      `${JSON.stringify({ passed: false, error: String(error), nativeCalls }, null, 2)}\n`,
    );
    clearTimeout(timeout);
    await finish(1);
  });
