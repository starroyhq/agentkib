import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TypeScriptBackend, quitWorkDecisionSchema } from "@agentkib/backend";
import { initializeLocalRuntimeDiagnostics } from "@agentkib/backend/local-runtime-activity";
import { serveLocalRuntime } from "@agentkib/backend/local-runtime-service";
import { BACKEND_INITIALIZE } from "@agentkib/backend/migration";
import { NativeHistoryWork } from "@agentkib/backend/native-history-work";
import { RUNTIME_METHODS } from "./generated/runtime-protocol";

const nativeHistoryWorkerFilename = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "backend-handoff-read.cjs",
);
const createNativeHistory = () => new NativeHistoryWork(nativeHistoryWorkerFilename);

if (process.argv[2] === "--local-runtime") {
  void startLocalService(process.argv[3], process.argv[4]).catch((error: unknown) => {
    // A competing launch already owns the service. Both clients attach to that owner.
    if (error instanceof Error && error.message === "session-managed-by-another-runtime") return;
    console.error("AgentKib local runtime failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
} else if (!(process.windowsStore === true && process.argv.includes("--agentkib-store-runtime"))) {
  startAttachedBackend();
}

export async function startLocalService(
  root?: string,
  dataDir?: string,
  environment = process.env,
) {
  if (!root || !dataDir || process.parentPort) throw new Error("Invalid local runtime arguments");
  const service = await serveLocalRuntime(
    root,
    dataDir,
    environment,
    undefined,
    createNativeHistory,
  );
  function stop() {
    void service.close().catch(() => {
      process.exitCode = 1;
    });
  }
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await service.closed;
  process.off("SIGTERM", stop).off("SIGINT", stop);
}

function sendNotification(method: string, params: unknown): void {
  const frame = { jsonrpc: "2.0", method, params };
  if (process.parentPort) process.parentPort.postMessage(frame);
  else process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function startAttachedBackend() {
  const backend = new TypeScriptBackend(process.env, sendNotification, createNativeHistory);
  let diagnostics: ReturnType<typeof initializeLocalRuntimeDiagnostics>;
  const pending = new Set<Promise<void>>();
  /** "Backend is closing" replies still being written. */
  const closingReplies = new Set<Promise<unknown>>();
  let closing = false;
  /**
   * Before the process exits after a shutdown, requests the client already wrote are answered
   * "Backend is closing" rather than dropped. A pipe can hand them over in a later read than the
   * shutdown itself (Windows does), after a quick shutdown has already finished.
   */
  async function answerQueuedRequests(): Promise<void> {
    if (process.parentPort) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await Promise.allSettled([...closingReplies]);
  }
  function shutdown(request: unknown): boolean {
    return (
      typeof request === "object" &&
      request !== null &&
      "method" in request &&
      request.method === RUNTIME_METHODS.shutdown
    );
  }
  function applicationUpdateShutdown(request: unknown): request is { id?: unknown } {
    if (
      typeof request !== "object" ||
      request === null ||
      !("jsonrpc" in request) ||
      request.jsonrpc !== "2.0" ||
      !("params" in request)
    )
      return false;
    const params = request.params;
    return (
      typeof params === "object" &&
      params !== null &&
      !Array.isArray(params) &&
      "reason" in params &&
      params.reason === "application-update" &&
      !quitWorkDecisionSchema.safeParse("quitWork" in params ? params.quitWork : undefined).success
    );
  }
  function dispatch(request: unknown, send: (response: unknown) => Promise<void>): void {
    if (closing) {
      const id = request && typeof request === "object" && "id" in request ? request.id : null;
      const reply = send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: "AgentKib command failed",
          data: { detail: "Backend is closing" },
        },
      }).catch(() => undefined);
      closingReplies.add(reply);
      void reply.finally(() => closingReplies.delete(reply));
      return;
    }
    const stopping = shutdown(request);
    const drain = stopping ? [...pending] : [];
    if (stopping) closing = true;
    diagnostics ??= initializeLocalRuntimeDiagnostics(request);
    const finish = diagnostics?.activity.beginRequest(request);
    const task = (async () => {
      let shouldExit = false;
      try {
        const upgrading = stopping && applicationUpdateShutdown(request);
        // Prepare while the providers are still live, then keep the normal RPC drain.
        const decision = upgrading ? await backend.prepareUpgradeQuitWork() : undefined;
        if (stopping) {
          backend.cancelPendingOperations();
          await Promise.allSettled(drain);
        }
        const response = upgrading
          ? await backend.closeAsync(decision, true).then(() => ({
              jsonrpc: "2.0",
              id: request.id ?? null,
              result: null,
              error: undefined,
            }))
          : await backend.handleAsync(request);
        await send(response);
        if (
          !response.error &&
          typeof request === "object" &&
          request !== null &&
          "method" in request &&
          request.method === BACKEND_INITIALIZE
        )
          backend.activateQuitWork();
        shouldExit = stopping && !response.error;
        if (shouldExit) await answerQueuedRequests();
        else if (stopping) closing = false;
      } finally {
        finish?.();
      }
      if (!shouldExit) return;
      await diagnostics?.close();
      process.exit(0);
    })()
      .catch(async () => {
        closing = true;
        try {
          await backend.closeAsync();
        } catch {
          process.exitCode = 1;
          return;
        } finally {
          await diagnostics?.close();
        }
        process.exit(1);
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  if (process.parentPort) {
    process.parentPort.on("message", ({ data }) =>
      dispatch(data, async (response) => process.parentPort!.postMessage(response)),
    );
  } else {
    const input = createInterface({ input: process.stdin });
    const send = (response: unknown) =>
      new Promise<void>((resolve) =>
        process.stdout.write(`${JSON.stringify(response)}\n`, () => resolve()),
      );
    input.on("line", (line) => {
      let request: unknown;
      try {
        request = JSON.parse(line);
      } catch {
        void send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      dispatch(request, send);
    });
    input.on("close", () => {
      closing = true;
      backend.cancelPendingOperations();
      void Promise.allSettled([...pending]).then(async () => {
        try {
          await backend.closeAsync();
        } catch {
          process.exitCode = 1;
          return;
        } finally {
          await diagnostics?.close();
        }
        process.exit(0);
      });
    });
  }
}
