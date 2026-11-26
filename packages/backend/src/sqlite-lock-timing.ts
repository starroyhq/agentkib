import type { DatabaseSync } from "node:sqlite";
import type { LocalRuntimeTraceEvent } from "./local-runtime-trace";

type LockEvent = Extract<LocalRuntimeTraceEvent, { kind: "sqlite" }>;
const SLOW_ACQUISITION_MS = 5;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

let observer: { record: (event: LockEvent) => void } | undefined;

export function observeSqliteLockAcquisition(record: (event: LockEvent) => void): () => void {
  const subscription = { record };
  observer = subscription;
  return () => {
    if (observer === subscription) observer = undefined;
  };
}

function lockFailure(error: unknown): "busy" | "locked" | undefined {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== "ERR_SQLITE_ERROR" ||
    !("errcode" in error) ||
    typeof error.errcode !== "number"
  )
    return;
  // Extended SQLite result codes keep the primary result in the low byte.
  const primary = error.errcode & 0xff;
  if (primary === SQLITE_BUSY) return "busy";
  if (primary === SQLITE_LOCKED) return "locked";
}

/** Time acquisition of the writer slot, before any transaction work. */
export function beginSqliteWrite(database: DatabaseSync, scope: LockEvent["database"]): void {
  const active = observer;
  if (!active) return database.exec("BEGIN IMMEDIATE");
  const start = performance.now();
  let outcome: LockEvent["outcome"] | undefined;
  try {
    database.exec("BEGIN IMMEDIATE");
    outcome = "acquired";
  } catch (error) {
    outcome = lockFailure(error);
    throw error;
  } finally {
    if (outcome) {
      // node:sqlite includes native busy-handler waits in elapsed time.
      const waitMs = performance.now() - start;
      if (outcome !== "acquired" || waitMs >= SLOW_ACQUISITION_MS) {
        try {
          active.record({
            kind: "sqlite",
            database: scope,
            operation: "begin-immediate",
            waitMs,
            outcome,
          });
        } catch {
          // Diagnostics must not alter whether the transaction opened.
        }
      }
    }
  }
}
