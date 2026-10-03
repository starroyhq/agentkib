import { createInterface } from "node:readline";
import { TypeScriptBackend } from "@agentkib/backend";
import { RUNTIME_METHODS } from "./generated/runtime-protocol";

const backend = new TypeScriptBackend();
const pending = new Set<Promise<void>>();
let closing = false;
function shutdown(request: unknown): boolean {
  return (
    typeof request === "object" &&
    request !== null &&
    "method" in request &&
    request.method === RUNTIME_METHODS.shutdown
  );
}
function dispatch(request: unknown, send: (response: unknown) => Promise<void>): void {
  if (closing) return;
  const stopping = shutdown(request);
  if (stopping) closing = true;
  const task = (async () => {
    if (stopping) {
      backend.cancelPendingOperations();
      await Promise.allSettled([...pending]);
    }
    const response = await backend.handleAsync(request);
    await send(response);
    if (stopping && !response.error) process.exit(0);
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
