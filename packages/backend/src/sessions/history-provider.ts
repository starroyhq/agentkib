import type { SessionCollection, SubagentCatalog } from "@agentkib/runtime-protocol";
import type { AntigravityHistory } from "../agents/antigravity/antigravity-history";
import type { ClaudeSessions } from "../agents/claude/claude-sessions";
import type { CodexSessions } from "../agents/codex/codex-sessions";
import type { DevinSessions } from "../agents/devin/devin-sessions";
import type { DshBridge } from "../agents/dsh/dsh-bridge";
import type { NativeHistoryWork } from "../native-history-work";
import type { ConversationEventPage } from "../session-events";
import type { DocumentOptions, SessionDocument } from "../session-model";
import type { SessionPaging } from "../session-paging";
import type { NativeSession, SessionStore } from "../session-store";
import type { CodexSubagentSource, SubagentParent } from "../session-subagents";

export type DshSessionSource = Pick<DshBridge, "list" | "events" | "image" | "document">;

export interface NativeListing {
  sessions: NativeSession[];
  incomplete: boolean;
  issues?: SessionListingIssue[];
  /** The source could not be opened or read. Preserve the last successful index. */
  sourceFailed?: true;
  /** Opaque IDs from a source that cannot be read in the current configuration. */
  retainedMetadataIds?: readonly string[];
}

export interface NativeCatalogListing extends NativeListing {
  sessions: (NativeSession & { collection?: SessionCollection | null })[];
  /** Only these native identities were examined when reading exact transcript paths. */
  nativeRefs?: readonly string[];
  /** Missing titles in bounded metadata reads do not replace previously indexed titles. */
  retainUnobservedTitles?: true;
}

export interface SessionListingIssue {
  code: string;
  scope: "workspace" | "source" | "unattributed";
  /** Verified working directory used to attribute a targeted catalog failure. */
  cwd?: string;
  id?: string;
  surface?: "app" | "ide";
}

type Awaitable<T> = T | Promise<T>;
type SessionIdentity = Pick<SessionStore, "get" | "id">;
export type HistorySummary = NonNullable<ReturnType<SessionIdentity["get"]>>;

export type HistorySource = {
  native: NativeSession;
  workspace: string;
  transcript?: string;
};

export type HistoryEventRead = HistorySource & {
  offset: string | null;
  count: number;
  retain: boolean;
  imageScanBudget?: { remainingBytes: number };
};

export type HistoryImageRead = HistorySource & { imageId: string };
export type HistoryDocumentRead = HistorySource & {
  summary: HistorySummary;
  options?: DocumentOptions;
};

type NativeSource = {
  native: NativeSession;
  transcript: string;
};

type DirectorySource = NativeSource & {
  cwd: string;
  verify(): void;
};

type IndexedImageSource = HistorySource & {
  workspaceId: string;
  nativeId: string;
};

type NativeSubagentRead = HistorySource & {
  sessionId: string;
  childId?: string;
  cursor: string | null;
  limit: number;
};

export type SessionHistoryProvider = {
  list(workspace: string, matches?: (nativeRef: string) => boolean): Awaitable<NativeListing>;
  catalogListing?(paths?: readonly string[]): Awaitable<NativeCatalogListing>;
  listCollection?(
    collection: SessionCollection,
    matches?: (nativeRef: string) => boolean,
  ): NativeListing;
  resolve?(id: string, workspace: string): HistorySource | undefined;
  resolveCollection?(id: string, collection: SessionCollection): HistorySource | undefined;
  events(input: HistoryEventRead): Awaitable<ConversationEventPage>;
  image?(input: HistoryImageRead): Awaitable<{ mimeType: string; base64: string }>;
  document?(input: HistoryDocumentRead): Awaitable<SessionDocument>;
  hostDocument?(
    sessionId: string,
    summary: HistorySummary,
    options?: DocumentOptions,
  ): Promise<SessionDocument>;
  imageSource?(id: string): IndexedImageSource;
  nativeWorkspaceSource?(nativeRef: string, workspace: string): NativeSource;
  nativeDirectorySource?(
    nativeRef: string,
    workspace: string,
    directory: string,
    unavailable: string,
  ): DirectorySource;
  activitySubagents?(source: HistorySource, sessionId: string): Awaitable<SubagentCatalog>;
  subagents?(input: NativeSubagentRead): Awaitable<SubagentCatalog | ConversationEventPage>;
  subagentParent?(
    source: HistorySource & { transcript: string },
    sessionId: string,
  ): SubagentParent;
  collectSubagentCandidates?(parent: SubagentParent, candidates: CodexSubagentSource[]): void;
  clear?(): void;
};

export type SessionHistoryContext = {
  store: SessionIdentity;
  codex: CodexSessions;
  claude: ClaudeSessions;
  antigravity: AntigravityHistory;
  devin: DevinSessions;
  nativeHistory?: NativeHistoryWork;
  dsh?: DshSessionSource;
  paging: SessionPaging;
  imageScope(native: NativeSession, workspace: string): string;
  resolveSession(sessionId: string): Promise<HistorySource>;
  verifiedCodexControlDirectory(nativeRef: string): { id: string; cwd: string } | undefined;
  verifiedCodexSubagentParent(
    sessionId: string,
    nativeId: string,
    workspace: string,
  ): SubagentParent;
  verifiedClaudeImageSource(id: string): IndexedImageSource;
  verifiedClaudeNativeSource(nativeRef: string, workspace: string): NativeSource;
};

export const withSessionDirectory = (source: { cwd: string | null; session: NativeSession }) => ({
  ...source.session,
  cwd: source.cwd,
});
