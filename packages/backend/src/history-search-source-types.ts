import type { HistoryRecordKind } from "@agentkib/runtime-protocol";
import type { CursorBridgeContext } from "./cursor-bridge";
import type { DshSearchRecord } from "./dsh-document";
import type { SessionStore } from "./session-store";

// Shared by persisted caches and source fingerprints. Bump when common redaction changes,
// so startup rejects old text before source discovery or background rebuilding can run.
export const HISTORY_SEARCH_SANITIZER_VERSION = "2";

/** A whole snapshot failed; it must not replace a previously committed generation. */
export class HistorySourceSnapshotError extends Error {
  constructor(readonly limitation: "damaged-record" | "source-byte-limit") {
    super("history-source-unavailable");
  }
}

/** Internal worker evidence, never a path or a caller-provided source identity. */
export class HistorySourceInvalidatedError extends Error {
  constructor(
    readonly sessionId: string,
    reason: "history-source-owner-changed" | "history-source-redaction-failed",
  ) {
    super(reason);
  }
}

/** Private identity evidence; never accepted from search/reference RPC callers. */
export interface OpenClawHistorySourceBinding {
  home: string;
  agentId: string;
  sessionId: string;
  cwd: string;
}
export interface HistorySourceInput {
  sessionId: string;
  summary: NonNullable<ReturnType<SessionStore["get"]>>;
  workspacePath: string;
  environment: NodeJS.ProcessEnv;
  profiles: CursorBridgeContext["profile"][];
  identitySalt: string;
  openClawBinding?: OpenClawHistorySourceBinding;
  /**
   * A DeepSeek Harness session's records, read on the main thread from the running DSH; the
   * search worker cannot reach it. Absent when DSH could not be read.
   */
  dsh?: { revision: string; records: DshSearchRecord[] };
}
export interface HistorySourceRecord {
  recordId: string;
  ordinal: number;
  kind: HistoryRecordKind;
  toolName: string | null;
  timestamp: string | null;
  content: string;
}
export interface HistorySourceResult {
  sourceRevision: string;
  recordCount: number;
  limitations: string[];
  status: "ready" | "partial";
  openClawBinding?: OpenClawHistorySourceBinding;
}
/** Internal readers emit complete, unredacted text; the common sink sanitizes before delivery. */
export interface HistorySourceSink {
  emit(record: Omit<HistorySourceRecord, "ordinal">): Promise<void>;
  fingerprint(value: string | Uint8Array): void;
  limit(code: string): void;
  checkpoint(): void;
}
