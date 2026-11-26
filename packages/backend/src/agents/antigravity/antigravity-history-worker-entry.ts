import { parentPort, workerData } from "node:worker_threads";
import type {
  AntigravityHistoryRequest,
  AntigravityHistoryReply,
} from "./antigravity-history-worker";
import { AntigravityLocalHistory } from "./antigravity-local-history";

if (!parentPort || typeof workerData !== "string") throw new Error("Invalid history worker");
const port = parentPort;
const history = new AntigravityLocalHistory({ HOME: workerData });
port.on("message", (input: AntigravityHistoryRequest) => {
  const send = (reply: AntigravityHistoryReply) => port.postMessage(reply);
  void (
    input.method === "records"
      ? history.records(...input.args)
      : input.method === "readEvents"
        ? history.readEvents(...input.args)
        : history.readDocument(...input.args)
  ).then(
    (value) => send({ value }),
    (error: unknown) =>
      send({ error: error instanceof Error ? error.message : "Antigravity history failed" }),
  );
});
