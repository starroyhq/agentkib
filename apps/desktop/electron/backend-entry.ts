import { createInterface } from "node:readline";
import { TypeScriptBackend } from "@agentkib/backend";
import { RUNTIME_METHODS } from "./generated/runtime-protocol";

function sendNotification(method: string, params: unknown): void {
  const frame = { jsonrpc: "2.0", method, params };
  if (process.parentPort) process.parentPort.postMessage(frame);
  else process.stdout.write(`${JSON.stringify(frame)}\n`);
}

const backend = new TypeScriptBackend(process.env, sendNotification);
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
  if (stopping) closing = true;
  const task = (async () => {
    if (stopping) {
      backend.cancelPendingOperations();
      await Promise.allSettled([...pending]);
    }
    const response = await backend.handleAsync(request);
    await send(response);
    if (stopping && !response.error) {
      await answerQueuedRequests();
      process.exit(0);
    }
    if (stopping) closing = false;
  })()
    .catch(async () => {
      closing = true;
      try {
        await backend.closeAsync();
      } catch {
        process.exitCode = 1;
        return;
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
        process.exit(0);
      } catch {
        process.exitCode = 1;
      }
    });
  });
}
