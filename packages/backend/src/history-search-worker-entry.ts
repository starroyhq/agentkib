import { parentPort, workerData } from "node:worker_threads";
import {
  formatHistoryReferences,
  HISTORY_REFERENCE_BYTES,
  HISTORY_REFERENCE_LIMIT,
  type HistorySearchQuery,
  type HistoryReference,
  type ResolvedHistoryReference,
} from "@agentkib/runtime-protocol";
import { TaskContext, runWithTask } from "./task-executor";
import { Commands } from "./commands";
import {
  HistorySearchStore,
  historyLocationSchema,
  historyReferenceSchema,
  unicodeBoundary,
  type SearchSession,
} from "./history-search-store";
import { historySourceStampCurrent, readHistorySearchSource } from "./history-search-source";
import {
  HistorySourceInvalidatedError,
  HistorySourceSnapshotError,
  type HistorySourceInput,
} from "./history-search-source-types";
import { z } from "zod";

if (!parentPort) throw new Error("History search requires a worker port");
const port = parentPort;
const configuration = workerData as { filename: string; writable: boolean; limitBytes: number };
let store: HistorySearchStore | undefined;
let running: { id: string; task: TaskContext; verification?: (valid: boolean) => void } | undefined;
const commands = new Commands();
function database() {
  return (store ??= new HistorySearchStore(
    configuration.filename,
    configuration.writable,
    configuration.limitBytes,
  ));
}
async function verify() {
  if (!running) throw new Error("No active history request");
  await new Promise<void>((resolve, reject) => {
    running!.verification = (valid) =>
      valid ? resolve() : reject(new Error("history-source-stale"));
    port.postMessage({ type: "verify", id: running!.id });
  });
}
function sourceWithCachedBinding(source: HistorySourceInput, session?: SearchSession) {
  if (
    (!session && source.summary.agent === "open-claw") ||
    (session &&
      (session.sessionId !== source.sessionId ||
        session.workspaceId !== source.summary.workspace_id ||
        session.agent !== source.summary.agent))
  )
    throw new Error("history-source-unavailable");
  // Discovery can no longer find an OpenClaw native ref after its cwd/agent changes.
  // All read paths must verify the binding committed for this owner, never caller data.
  return {
    ...source,
    openClawBinding: session ? database().cachedOpenClawBinding(session) : undefined,
  };
}
async function validateSource(
  source: HistorySourceInput,
  session: SearchSession | undefined,
  task: TaskContext,
  checkpoint: () => void,
) {
  try {
    return await readHistorySearchSource(sourceWithCachedBinding(source, session), () => {}, {
      commands,
      signal: task.signal,
      checkpoint,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "history-source-owner-changed" ||
        error.message === "history-source-redaction-failed")
    )
      throw new HistorySourceInvalidatedError(source.sessionId, error.message);
    throw error;
  }
}
port.on(
  "message",
  (message: {
    type: string;
    id: string;
    deadlineAt?: number;
    operation?: string;
    input?: unknown;
    cancelFlag?: SharedArrayBuffer;
    valid?: boolean;
  }) => {
    if (message.type === "verified" && running?.id === message.id) {
      const callback = running.verification;
      running.verification = undefined;
      callback?.(message.valid === true);
      return;
    }
    if (message.type === "cancel" && running?.id === message.id) {
      running.task.cancel();
      running.verification?.(false);
      return;
    }
    if (message.type === "close") {
      commands.close();
      store?.close();
      port.close();
      return;
    }
    if (message.type !== "run") return;
    if (running) {
      port.postMessage({ type: "error", id: message.id, message: "History worker is busy" });
      return;
    }
    const task = new TaskContext({ id: message.id, deadlineAt: message.deadlineAt! });
    const flag = new Int32Array(message.cancelFlag!);
    const checkpoint = () => {
      if (Atomics.load(flag, 0)) task.cancel();
      task.checkpoint();
    };
    running = { id: message.id, task };
    void runWithTask(task, async () => {
      try {
        checkpoint();
        const db = database();
        const input = message.input as Record<string, unknown>;
        const owners = Array.isArray(input.owners) ? (input.owners as SearchSession[]) : [];
        if (Array.isArray(input.owners) && message.operation !== "prune")
          input.allowedSessionIds = db.authorizedOwners(owners);
        let value: unknown;
        switch (message.operation) {
          case "init":
            value = true;
            break;
          case "index": {
            if (!configuration.writable) throw new Error("Read-only search worker");
            const session = input.session as unknown as SearchSession;
            let generation: string | undefined;
            let settled = false;
            try {
              const source = sourceWithCachedBinding(
                input.source as unknown as HistorySourceInput,
                session,
              );
              const previousRevision = db.cachedSourceRevision(session);
              const stamp = previousRevision
                ? db.sourceStamp(session.sessionId, previousRevision)
                : undefined;
              // Files exactly as they were read give the same revision, forced or not. A large
              // transcript is then neither read nor rewritten after every turn.
              if (previousRevision && stamp && historySourceStampCurrent(stamp)) {
                value = {
                  sessionId: session.sessionId,
                  sourceRevision: previousRevision,
                  rebuilt: false,
                };
                break;
              }
              if (previousRevision && input.force !== true) {
                // Provider summaries can stay unchanged when a JSONL body or SQLite WAL changes.
                // Read the complete source in this worker; retain the committed generation only
                // when both its content snapshot and current ownership still match.
                const snapshot = await readHistorySearchSource(source, () => {}, {
                  commands,
                  signal: task.signal,
                  checkpoint,
                });
                checkpoint();
                await verify();
                checkpoint();
                if (snapshot.sourceRevision === previousRevision) {
                  if (snapshot.stamp)
                    db.rememberStamp(session.sessionId, previousRevision, snapshot.stamp);
                  value = { ...snapshot, sessionId: session.sessionId, rebuilt: false };
                  break;
                }
              }
              if (db.budgetExceeded() && !db.canMakeRoom(session)) {
                // Refuse before opening a generation, so a full cache is not rewritten per pass.
                db.markUnindexed(session, "cache-budget-exceeded");
                settled = true;
                throw new Error("history-search-budget-exceeded");
              }
              generation = db.begin(session);
              const snapshot = await readHistorySearchSource(
                source,
                async (record) => {
                  checkpoint();
                  db.append(session.sessionId, generation!, record, checkpoint);
                },
                { commands, signal: task.signal, checkpoint },
              );
              checkpoint();
              await verify();
              checkpoint();
              await task.commit(() =>
                db.finish(
                  session.sessionId,
                  generation!,
                  snapshot.sourceRevision,
                  snapshot.status,
                  snapshot.limitations,
                  snapshot.openClawBinding,
                  snapshot.stamp,
                ),
              );
              value = { ...snapshot, sessionId: session.sessionId, rebuilt: true };
            } catch (error) {
              if (settled) throw error;
              const message = error instanceof Error ? error.message : "";
              const unsafeContent = message === "history-source-redaction-failed",
                ownerChanged = message === "history-source-owner-changed",
                budget = message === "history-search-budget-exceeded",
                sourceFailure =
                  error instanceof HistorySourceSnapshotError ? error.limitation : undefined;
              // Redaction failures and confirmed ownership changes must withdraw cached text.
              // Temporary source failures still preserve the previous committed generation.
              if (generation === undefined && !unsafeContent && !ownerChanged)
                // Nothing was staged; a source that keeps failing is recorded once.
                db.markUnindexed(
                  session,
                  budget ? "cache-budget-exceeded" : (sourceFailure ?? "source-unavailable"),
                );
              else
                db.abort(session.sessionId, generation ?? db.begin(session), budget, {
                  unsafeContent,
                  ownerChanged,
                  sourceFailure,
                });
              throw error;
            }
            break;
          }
          case "prune":
            if (!configuration.writable) throw new Error("Read-only search worker");
            db.prune(input.owners as Array<{ sessionId: string; ownerKey: string }>);
            value = true;
            break;
          case "withdraw":
            if (!configuration.writable) throw new Error("Read-only search worker");
            await task.commit(() => db.withdraw(String(input.sessionId), String(input.ownerKey)));
            value = true;
            break;
          case "status":
            value = db.status(input.allowedSessionIds as string[], owners);
            break;
          case "query":
            value = db.query(
              input.query as HistorySearchQuery,
              input.allowedSessionIds as string[],
              checkpoint,
              owners,
            );
            break;
          case "locate": {
            const location = historyLocationSchema.parse(input.location);
            const result = db.locate(location, input.allowedSessionIds as string[]);
            const snapshot = await validateSource(
              input.source as unknown as HistorySourceInput,
              owners.find((owner) => owner.sessionId === location.sessionId),
              task,
              checkpoint,
            );
            if (snapshot.sourceRevision !== location.sourceRevision)
              throw new Error("history-source-stale");
            checkpoint();
            await verify();
            checkpoint();
            value = result;
            break;
          }
          case "references": {
            const refs = z
              .array(historyReferenceSchema)
              .max(HISTORY_REFERENCE_LIMIT)
              .parse(input.references);
            const sources = input.sources as Record<string, HistorySourceInput>;
            const snapshots = new Map<string, string>();
            const references: ResolvedHistoryReference[] = [];
            let bytes = 0;
            for (const reference of refs) {
              checkpoint();
              const record = db.locate(reference, input.allowedSessionIds as string[]);
              if (!sources[reference.sessionId]) throw new Error("history-source-unavailable");
              if (!snapshots.has(reference.sessionId)) {
                const source = await validateSource(
                  sources[reference.sessionId]!,
                  owners.find((owner) => owner.sessionId === reference.sessionId),
                  task,
                  checkpoint,
                );
                snapshots.set(reference.sessionId, source.sourceRevision);
              }
              if (
                snapshots.get(reference.sessionId) !== reference.sourceRevision ||
                record.contentHash !== reference.contentHash
              )
                throw new Error("history-source-stale");
              if (
                reference.end <= reference.start ||
                !unicodeBoundary(record.content, reference.start) ||
                !unicodeBoundary(record.content, reference.end)
              )
                throw new Error("history-reference-range-invalid");
              const content = record.content.slice(reference.start, reference.end);
              bytes += Buffer.byteLength(content);
              if (bytes > HISTORY_REFERENCE_BYTES) throw new Error("history-references-too-large");
              references.push({
                reference: reference as HistoryReference,
                title: record.title,
                agent: record.agent,
                kind: record.kind,
                toolName: record.toolName,
                content,
              });
            }
            await verify();
            checkpoint();
            value = { references, text: formatHistoryReferences(references) };
            break;
          }
          default:
            throw new Error("Unknown history worker operation");
        }
        checkpoint();
        port.postMessage({ type: "result", id: message.id, value });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "";
        // Provider/SQLite exceptions can embed private native paths or command output.
        const safe = /^history-[a-z-]+$/.test(detail)
          ? detail
          : error instanceof z.ZodError
            ? "history-search-input-invalid"
            : message.operation === "init"
              ? "history-search-cache-unavailable"
              : "history-source-unavailable";
        port.postMessage({
          type: "error",
          id: message.id,
          message: safe,
          ...(error instanceof HistorySourceInvalidatedError
            ? { sourceSessionId: error.sessionId }
            : {}),
        });
      } finally {
        task.dispose();
        running = undefined;
      }
    });
  },
);
