/** Desktop-local, read-only native memory. These types are not exposed through Web/MCP. */
export interface NativeMemoryWorkspace {
  id: string;
  name: string;
}
export type NativeMemorySourceStatus = "ready" | "empty" | "disabled" | "unavailable" | "error";
export interface NativeMemorySource {
  id: string;
  agent: "claude-code";
  directory: string | null;
  workspaces: NativeMemoryWorkspace[];
  status: NativeMemorySourceStatus;
  stale: boolean;
  incomplete: boolean;
  reason?: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
}
export interface NativeMemoryFile {
  id: string;
  sourceId: string;
  relativePath: string;
  kind: "index" | "topic";
  title?: string;
  excerpt?: string;
  modifiedAt: string;
  version: string;
  size: number;
  truncated: boolean;
  stale: boolean;
}
export interface NativeMemoryQuery {
  workspaceId?: string;
  sourceId?: string;
  query?: string;
  offset?: number;
}
export interface NativeMemorySnapshot {
  sources: NativeMemorySource[];
  files: NativeMemoryFile[];
  total: number;
  nextOffset: number | null;
  revision: string;
  refreshing: boolean;
}
export interface NativeMemoryDetail {
  file: NativeMemoryFile;
  source: NativeMemorySource;
  content: string;
  links: Array<{ label: string; targetId: string; fragment?: string }>;
}
export const NATIVE_MEMORY_CHANGED = "memories.nativeChanged";
