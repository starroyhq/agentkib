import { createRoot } from "react-dom/client";
import { EmbeddedConversation } from "@/features/sessions/conversation/desktop-embedded-conversation";
import { WebClient } from "@agentkib/web-client";
import { createDesktopConversationAdapter } from "../core/conversation-bridge";
import "../styles.css";

interface Sample {
  sequence: number;
  nativeEpochMs: number;
  domMs: number;
  frameMs: number;
}
interface BenchmarkWindow extends Window {
  conversationBenchmarkStage?: string;
}
declare global {
  interface Window {
    conversationBenchmarkResult: Promise<{
      passed: boolean;
      samples: Sample[];
      domP95Ms: number;
      frameP95Ms: number;
      maxFrameMs: number;
      expectedSamples: number;
    }>;
  }
}

async function benchmark() {
  const setStage = (stage: string) => {
    (window as BenchmarkWindow).conversationBenchmarkStage = stage;
  };
  setStage("initializing");
  const sessionId = new URL(location.href).searchParams.get("sessionId");
  const bridge = window.desktopConversation;
  if (!sessionId || !bridge) throw new Error("Missing benchmark session or production preload");
  let connected!: () => void;
  const subscribed = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const adapter = createDesktopConversationAdapter(() => ({
    ...bridge,
    async subscribe(id, cursor) {
      const result = await bridge.subscribe(id, cursor);
      if (id === sessionId) {
        setStage("subscribed");
        connected();
      }
      return result;
    },
  }));
  const client = new WebClient(undefined, { type: "same-origin" }, adapter);
  const samples = new Map<number, Sample>();
  const observed = new Set<number>();
  let lastEvent = "none";
  let complete!: () => void;
  const allFrames = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let turnCompleted!: () => void;
  const finished = new Promise<void>((resolve) => {
    turnCompleted = resolve;
  });
  let running = false;
  const stopObserving = bridge.onEvent((event) => {
    if (event.sessionId !== sessionId) return;
    const payload = event.payload as unknown as Record<string, unknown>;
    const payloadItems = Array.isArray(payload.items) ? payload.items : [];
    const observedItems = payloadItems.map((item) => ({
      id: item.id,
      kind: item.kind,
      content: typeof item.content === "string" ? item.content.slice(0, 160) : null,
    }));
    lastEvent = `${event.type}:status=${String((payload.live as Record<string, unknown> | undefined)?.status)}:items=${JSON.stringify(observedItems)}`;
    const status =
      event.type === "snapshot"
        ? (payload.live as Record<string, unknown> | undefined)?.status
        : event.type === "state"
          ? payload.status
          : undefined;
    if (status === "running") running = true;
    if (running && status === "idle") turnCompleted();
  });
  const observer = new MutationObserver(() => {
    const text = document.querySelector('[data-event-id="benchmark-item"]')?.textContent ?? "";
    for (const match of text.matchAll(/\[stream-benchmark:(\d+):(\d+\.\d+)\]/g)) {
      const sequence = Number(match[1]);
      if (observed.has(sequence)) continue;
      observed.add(sequence);
      const nativeEpochMs = Number(match[2]);
      const domMs = performance.timeOrigin + performance.now() - nativeEpochMs;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          samples.set(sequence, {
            sequence,
            nativeEpochMs,
            domMs,
            frameMs: performance.timeOrigin + performance.now() - nativeEpochMs,
          });
          if (samples.size === 40) complete();
        }),
      );
    }
  });
  observer.observe(document.body, { subtree: true, characterData: true, childList: true });
  createRoot(document.getElementById("root")!).render(
    <div className="flex h-screen flex-col">
      <EmbeddedConversation
        client={client}
        sessionId={sessionId}
        locale="en-US"
        onSessionChange={() => {}}
      />
    </div>,
  );
  // No native output starts until the reader's actual IPC subscription exists.
  await subscribed;
  setStage("reading-access");
  const access = await client.access();
  const live = await client.live(sessionId);
  if (!live.sendEnabled) throw new Error("Fixture session is not ready to send");
  const sent = await client.request<{ accepted?: boolean }>("send", {
    sessionId,
    text: "stream-benchmark",
    requestId: crypto.randomUUID(),
    bootId: access.bootId,
    expectedRevision: live.revision,
  });
  if (!sent.accepted) throw new Error("Fixture send was not accepted");
  setStage("sent");
  const timeoutError = new Promise<never>((_, reject) =>
    setTimeout(() => {
      const text = document.querySelector('[data-event-id="benchmark-item"]')?.textContent ?? "";
      reject(
        new Error(
          `Timed out at stage ${(window as BenchmarkWindow).conversationBenchmarkStage ?? "unknown"}; samples=${samples.size}; observed=${observed.size}; item=${Boolean(text)}; text=${text.slice(0, 200)}; running=${running}; lastEvent=${lastEvent}`,
        ),
      );
    }, 12_000),
  );
  await Promise.race([Promise.all([allFrames, finished]), timeoutError]);
  setStage("completed");
  observer.disconnect();
  stopObserving();
  if (document.querySelectorAll('[data-event-id="benchmark-item"]').length !== 1)
    throw new Error("Completed native item was duplicated");
  if (document.visibilityState !== "visible") throw new Error("Benchmark renderer was hidden");
  const ordered = [...samples.values()].sort((a, b) => a.sequence - b.sequence);
  if (
    ordered.length !== 40 ||
    ordered.some(
      (sample, index) =>
        sample.sequence !== index || sample.domMs < 0 || sample.frameMs < sample.domMs,
    )
  )
    throw new Error("Lost samples or incompatible clocks");
  const percentile = (values: number[]) =>
    values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  const domP95Ms = percentile(ordered.map((sample) => sample.domMs));
  const frameP95Ms = percentile(ordered.map((sample) => sample.frameMs));
  return {
    passed: frameP95Ms <= 150,
    expectedSamples: 40,
    samples: ordered,
    domP95Ms,
    frameP95Ms,
    maxFrameMs: Math.max(...ordered.map((sample) => sample.frameMs)),
  };
}

window.conversationBenchmarkResult = benchmark();
