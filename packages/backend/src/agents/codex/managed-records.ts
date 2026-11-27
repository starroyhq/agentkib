import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { canonicalize, pathIdentity } from "../../paths";
import { readManagedRecord } from "../../managed-ledger";
import type { BackendStore } from "../../store";
import { managedRecordSchema } from "./managed-session-catalog";

export type ManagedRecord = z.infer<typeof managedRecordSchema>;

export function startupUnconfirmed(record: ManagedRecord): boolean {
  const snapshot = record.snapshot;
  // A clean runner close can look disconnected. The receipt ledger separately fences unknown work.
  return (
    snapshot?.status === "starting" ||
    (snapshot?.status === "outcome-unknown" && snapshot.reason !== "codex-disconnected")
  );
}

function matchesWorkspace(store: BackendStore, record: ManagedRecord): boolean {
  try {
    return (
      pathIdentity(canonicalize(store.workspacePath(record.workspace_id))) ===
      pathIdentity(canonicalize(record.workspace))
    );
  } catch {
    return false;
  }
}

/** A catalog eligibility probe reads the selected session, independently of other records. */
export function managedRecordInWorkspace(dataDir: string, store: BackendStore, sessionId: string) {
  const raw = readManagedRecord(dataDir, sessionId);
  if (!raw) return null;
  const record = managedRecordSchema.safeParse(raw);
  return record.success && matchesWorkspace(store, record.data) ? record.data : null;
}

export function readManagedRecords(
  dataDir: string,
  store: BackendStore,
  includeReleasedAdopted = true,
): ManagedRecord[] {
  const file = path.join(dataDir, "codex-managed", "executions.sqlite");
  if (!existsSync(file)) return [];
  if (!statSync(file).isFile()) throw new Error("Invalid managed Codex session database");
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const rows = database
      .prepare("SELECT record FROM managed_sessions ORDER BY rowid DESC LIMIT 20000")
      .all();
    const records: ManagedRecord[] = [];
    for (const row of rows) {
      let record: ManagedRecord;
      try {
        record = managedRecordSchema.parse(JSON.parse(String(row.record)));
      } catch {
        throw new Error("Invalid managed Codex session record");
      }
      if (!includeReleasedAdopted && record.released && record.adopted) continue;
      if (!matchesWorkspace(store, record)) continue;
      records.push(record);
    }
    return records;
  } finally {
    database.close();
  }
}
