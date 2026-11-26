import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import type { BigIntStats } from "node:fs";
import type { DshBridgeDocumentPage, HistoryRecordKind } from "@agentkib/runtime-protocol";
import type { CursorBridgeContext } from "./cursor-bridge";
import type { SessionStore } from "./session-store";

// Shared by persisted caches and source fingerprints. Bump when common redaction changes,
// so startup rejects old text before source discovery or background rebuilding can run.
export const HISTORY_SEARCH_SANITIZER_VERSION = "2";

/** A whole snapshot failed; it must not replace a previously committed generation. */
export class HistorySourceSnapshotError extends Error {
  constructor(readonly limitation: "damaged-record" | "source-byte-limit") {
    super(REMOTE_ERROR_CODES.historySourceUnavailable);
  }
}

/** Internal worker evidence, never a path or a caller-provided source identity. */
export class HistorySourceInvalidatedError extends Error {
  constructor(
    readonly sessionId: string,
    reason: typeof REMOTE_ERROR_CODES.historySourceOwnerChanged | "history-source-redaction-failed",
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
}
/** A single page pulled from the running DSH. Null marks the end of the pinned snapshot. */
export type ReadDshSearchPage = () => Promise<DshBridgeDocumentPage | null>;
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
  /**
   * What the files this snapshot was read from looked like. Present only when they are its whole
   * input, so an unchanged stamp means an unchanged revision without reading them again.
   */
  stamp?: string;
}
/** Internal readers emit complete, unredacted text; the common sink sanitizes before delivery. */
export interface HistorySourceSink {
  emit(record: Omit<HistorySourceRecord, "ordinal">): Promise<void>;
  fingerprint(value: string | Uint8Array): void;
  limit(code: string): void;
  checkpoint(): void;
  /** A file the snapshot is read from, as it was when reading began. */
  stamp?(file: string, stat: BigIntStats): void;
}
