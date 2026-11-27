import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WorkerReportPart, WorkerReportView } from "@agentkib/runtime-protocol";
import { openManagedLedger, withManagedLedgerReader } from "./managed-ledger";
import type { ReportDelivery } from "./report-delivery";

type WorkerReportProof = {
  type: "native-message" | "request";
  id: string;
};
type Item = Record<string, unknown>;

const TABLES = `
  CREATE TABLE IF NOT EXISTS worker_report_deliveries (
    session_id TEXT NOT NULL, report_id TEXT NOT NULL, view TEXT NOT NULL,
    PRIMARY KEY(session_id, report_id)
  );
  CREATE TABLE IF NOT EXISTS worker_report_messages (
    session_id TEXT NOT NULL, proof_type TEXT NOT NULL, proof_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, report_ids TEXT NOT NULL,
    PRIMARY KEY(session_id, proof_type, proof_id, fingerprint)
  );`;

const fingerprint = (text: string) =>
  createHash("sha256").update(text.replaceAll("\r\n", "\n").trim()).digest("hex");

const item = (value: unknown): value is Item =>
  !!value && typeof value === "object" && !Array.isArray(value);

function write<T>(dataDir: string, operation: (database: DatabaseSync) => T): T | undefined {
  // Cards are a projection. Failing to save a card must never lose or repeat delivery.
  try {
    const database = openManagedLedger(dataDir, true)!;
    try {
      return operation(database);
    } finally {
      database.close();
    }
  } catch {
    /* Raw native history remains readable. */
  }
}

export function rememberWorkerReport(
  dataDir: string,
  sessionId: string,
  delivery: ReportDelivery,
): void {
  const parts = delivery.parts;
  if (!parts?.length || parts.some(({ meta }) => !meta)) return;
  const view: WorkerReportView = {
    reportId: delivery.reportId,
    parts: parts.map(({ meta }) => meta!),
    ...(parts.map(({ text }) => text).join("\n\n") !== delivery.text
      ? { omittedDetails: true }
      : {}),
  };
  write(dataDir, (database) => {
    database.exec(TABLES);
    database
      .prepare("INSERT OR IGNORE INTO worker_report_deliveries VALUES(?,?,?)")
      .run(sessionId, delivery.reportId, JSON.stringify(view));
  });
}

export function bindWorkerReportMessageInTransaction(
  database: DatabaseSync,
  sessionId: string,
  proof: WorkerReportProof,
  reportIds: readonly string[],
  text: string,
): void {
  if (!reportIds.length) return;
  try {
    const count = database.prepare(
      "SELECT 1 FROM worker_report_deliveries WHERE session_id=? AND report_id=?",
    );
    if (!reportIds.every((id) => count.get(sessionId, id))) return;
    database
      .prepare("INSERT OR IGNORE INTO worker_report_messages VALUES(?,?,?,?,?)")
      .run(sessionId, proof.type, proof.id, fingerprint(text), JSON.stringify(reportIds));
  } catch {
    // Old or unrecorded deliveries have no structured fields to bind.
  }
}

export function bindWorkerReportMessage(
  dataDir: string,
  sessionId: string,
  proof: WorkerReportProof,
  reportIds: readonly string[],
  text: string,
): void {
  write(dataDir, (database) =>
    bindWorkerReportMessageInTransaction(database, sessionId, proof, reportIds, text),
  );
}

/** Attach a second delivery to the native queued request it joined. The old body stays valid
 * until the native update takes effect, and only the exact body can select either variant. */
export function appendWorkerReportMessage(
  dataDir: string,
  sessionId: string,
  requestId: string,
  previous: string,
  reportId: string,
  text: string,
): void {
  write(dataDir, (database) => {
    const row = database
      .prepare(
        "SELECT report_ids FROM worker_report_messages WHERE session_id=? AND proof_type='request' AND proof_id=? AND fingerprint=?",
      )
      .get(sessionId, requestId, fingerprint(previous)) as { report_ids: string } | undefined;
    if (!row) return;
    const ids = JSON.parse(row.report_ids) as string[];
    bindWorkerReportMessageInTransaction(
      database,
      sessionId,
      { type: "request", id: requestId },
      [...ids, reportId],
      text,
    );
  });
}

/** A provider can persist a native message identity when its history has no request ID. */
export function anchorWorkerReportMessage(
  dataDir: string,
  sessionId: string,
  requestId: string,
  proof: WorkerReportProof,
): boolean {
  try {
    const present = withManagedLedgerReader(dataDir, (database) =>
      database
        .prepare(
          "SELECT 1 FROM worker_report_messages WHERE session_id=? AND proof_type='request' AND proof_id=? LIMIT 1",
        )
        .get(sessionId, requestId),
    );
    if (!present) return false;
  } catch {
    return false;
  }
  return Boolean(
    write(
      dataDir,
      (database) =>
        database
          .prepare(
            "INSERT OR IGNORE INTO worker_report_messages SELECT session_id,?,?,fingerprint,report_ids FROM worker_report_messages WHERE session_id=? AND proof_type='request' AND proof_id=?",
          )
          .run(proof.type, proof.id, sessionId, requestId).changes,
    ),
  );
}

function collectView(
  database: DatabaseSync,
  sessionId: string,
  ids: string[],
): WorkerReportView | undefined {
  const select = database.prepare(
    "SELECT view FROM worker_report_deliveries WHERE session_id=? AND report_id=?",
  );
  const parts: WorkerReportPart[] = [];
  let omitted = false;
  for (const id of ids) {
    const row = select.get(sessionId, id) as { view: string } | undefined;
    if (!row) return;
    const view = JSON.parse(row.view) as WorkerReportView;
    parts.push(...view.parts);
    omitted ||= view.omittedDetails === true;
  }
  return parts.length
    ? { reportId: ids[0]!, parts, ...(omitted ? { omittedDetails: true } : {}) }
    : undefined;
}

function projectItems(
  dataDir: string | undefined,
  sessionId: string,
  events: readonly unknown[],
): unknown[] {
  const cleaned = events.map((event) => {
    if (
      !item(event) ||
      !("worker_report_request_id" in event || "worker_report_native_message_id" in event)
    )
      return event;
    const {
      worker_report_request_id: _request,
      worker_report_native_message_id: _message,
      ...rest
    } = event;
    return rest;
  });
  if (!dataDir || !events.some((event) => item(event) && event.kind === "user-message"))
    return cleaned;
  try {
    return (
      withManagedLedgerReader(dataDir, (database) => {
        if (
          !database
            .prepare("SELECT 1 FROM worker_report_deliveries WHERE session_id=? LIMIT 1")
            .get(sessionId)
        )
          return cleaned;
        const lookup = database.prepare(
          "SELECT fingerprint,report_ids FROM worker_report_messages WHERE session_id=? AND proof_type=? AND proof_id=?",
        );
        return events.map((event, index) => {
          const clean = cleaned[index];
          if (
            !item(event) ||
            !item(clean) ||
            event.kind !== "user-message" ||
            typeof event.content !== "string"
          )
            return clean;
          const candidates: WorkerReportProof[] = [];
          if (typeof event.worker_report_request_id === "string")
            candidates.push({ type: "request", id: event.worker_report_request_id });
          if (typeof event.worker_report_native_message_id === "string")
            candidates.push({ type: "native-message", id: event.worker_report_native_message_id });
          if (typeof event.id === "string")
            candidates.push({ type: "native-message", id: event.id });
          for (const proof of candidates) {
            const rows = lookup.all(sessionId, proof.type, proof.id) as Array<{
              fingerprint: string;
              report_ids: string;
            }>;
            if (!rows.length) continue;
            const hash = fingerprint(event.content);
            const matched = rows.find((row) => row.fingerprint === hash);
            if (!matched) continue;
            const view = collectView(database, sessionId, JSON.parse(matched.report_ids));
            if (view) return { ...clean, worker_reports: view };
          }
          return clean;
        });
      }) ?? cleaned
    );
  } catch {
    return cleaned;
  }
}

export function projectWorkerReports<T>(
  dataDir: string | undefined,
  sessionId: unknown,
  value: T,
): T {
  if (typeof sessionId !== "string" || !item(value)) return value;
  if (Array.isArray(value.events))
    return { ...value, events: projectItems(dataDir, sessionId, value.events) };
  if (Array.isArray(value.items))
    return { ...value, items: projectItems(dataDir, sessionId, value.items) };
  if (value.kind === "user-message") return projectItems(dataDir, sessionId, [value])[0] as T;
  return value;
}
