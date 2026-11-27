import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  REMOTE_ERROR_CODES,
  sessionCollection,
  type SessionCollection,
  type SubagentCatalog,
} from "@agentkib/runtime-protocol";
import { CodexSessions, type NativeSessionSource } from "./agents/codex/codex-sessions";
import { ClaudeSessions } from "./agents/claude/claude-sessions";
import { GrokSessions } from "./grok-sessions";
import { OpenClawSessions } from "./openclaw-sessions";
import { HermesSessions } from "./hermes-sessions";
import { OpenCodeSessions } from "./opencode-sessions";
import { AntigravityHistory } from "./agents/antigravity/antigravity-history";
import { ANTIGRAVITY_ACP_DISABLED, antigravityAcpEnabled } from "./agents/antigravity/acp-enabled";
import { CursorSessions } from "./cursor-sessions";
import { CursorIdeSessions } from "./cursor-ide-sessions";
import { DevinSessions } from "./agents/devin/devin-sessions";
import type { NativeHistoryWork } from "./native-history-work";
import type { CursorBridge } from "./cursor-bridge";
import { readOpenClawSqliteDocument, readOpenClawSqliteEvents } from "./openclaw-sqlite-sessions";
import { SessionPaging } from "./session-paging";
import {
  SessionSubagents,
  type CodexSubagentSource,
  type SubagentObservation,
  type SubagentParent,
} from "./session-subagents";
import { readHermesEvents } from "./hermes-events";
import { readGrokDocument, readHermesDocument } from "./native-chat-documents";
import { SessionStore, sessionIdentity, type NativeSession } from "./session-store";
import { Commands } from "./commands";
import { parameters, optionalString, unsigned } from "./rpc";
import type { ConversationEventPage } from "./session-events";
import type { DocumentOptions, SessionDocument } from "./session-model";
import { readEventDocument } from "./session-document-providers";
import { canonicalize, pathIdentity } from "./paths";
import { within } from "./files";
import { handoffActive, handoffCheckpoint, readHandoff } from "./handoff-work";
import { readCheckout } from "./git-checkouts";
import { isReparseOrSymlink } from "./native-files";
import {
  withSessionDirectory,
  type DshSessionSource,
  type NativeListing,
  type SessionHistoryContext,
  type SessionHistoryProvider,
} from "./sessions/history-provider";
import { getSessionProviderReader } from "./sessions/providers";

export type { DshSessionSource, NativeListing } from "./sessions/history-provider";

const canonicalizePath = canonicalize;
const claudeBridgeFileVersion = (metadata: BigIntStats) =>
  [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(":");

/** Worktree administration pointers are small local files, never followed through a link. */
function claudeBridgeGitPointer(file: string): string {
  const metadata = lstatSync(file, { bigint: true });
  if (!metadata.isFile() || isReparseOrSymlink(file, metadata) || metadata.size > 4096n)
    throw new Error("session-workspace-mismatch");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (
      claudeBridgeFileVersion(fstatSync(fd, { bigint: true })) !== claudeBridgeFileVersion(metadata)
    )
      throw new Error("session-workspace-mismatch");
    const buffer = Buffer.alloc(4097);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    const value = buffer.subarray(0, count).toString("utf8").trim();
    if (
      count !== Number(metadata.size) ||
      !value ||
      /[\r\n\0]/.test(value) ||
      claudeBridgeFileVersion(fstatSync(fd, { bigint: true })) !== claudeBridgeFileVersion(metadata)
    )
      throw new Error("session-workspace-mismatch");
    return value;
  } finally {
    closeSync(fd);
  }
}

/**
 * The real path of a session directory, or for a deleted one, its nearest existing ancestor's
 * real path joined with the missing part. Other failures (such as permissions) still throw.
 */
export function recordedDirectory(value: string): { path: string; missing: boolean } {
  const absent = (error: unknown) =>
    ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
  try {
    return { path: canonicalize(value), missing: false };
  } catch (error) {
    if (!absent(error)) throw error;
  }
  const missing: string[] = [];
  for (let current = path.resolve(value); ;) {
    const parent = path.dirname(current);
    missing.unshift(path.basename(current));
    if (parent === current) return { path: path.resolve(value), missing: true };
    try {
      return { path: path.join(canonicalize(parent), ...missing), missing: true };
    } catch (error) {
      if (!absent(error)) throw error;
    }
    current = parent;
  }
}

export const SESSION_AGENTS = [
  "codex",
  "claude-code",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
  "antigravity",
  "cursor",
  "deepseek-harness",
  "devin",
] as const;
export type SessionAgent = (typeof SESSION_AGENTS)[number];
/** One catalog call may share discovery; every metadata target still verifies its own header. */
export type ClaudeControlMetadataShare = { current?: ReturnType<ClaudeSessions["list"]> };

/** Revalidate indexed workspace ownership before resolving an opaque reference in native history. */
export class SessionReaders {
  #codex: CodexSessions;
  #claude: ClaudeSessions;
  #grok: GrokSessions;
  #openclaw: OpenClawSessions;
  #hermes: HermesSessions;
  #opencode: OpenCodeSessions;
  #antigravity: AntigravityHistory;
  #cursor: CursorSessions;
  #cursorIde: CursorIdeSessions;
  #devin: DevinSessions;
  #paging = new SessionPaging();
  #subagents: SessionSubagents;
  #subagentCandidates = new Map<string, { at: number; candidates: CodexSubagentSource[] }>();
  #history = new Map<string, SessionHistoryProvider>();
  constructor(
    readonly store: Pick<SessionStore, "get" | "id" | "workspacePath" | "identitySalt">,
    commands: Commands,
    readonly env: NodeJS.ProcessEnv,
    readonly cursorBridge: Pick<CursorBridge, "profiles">,
    readonly dsh?: DshSessionSource,
    readonly nativeHistory?: NativeHistoryWork,
  ) {
    this.#subagents = new SessionSubagents(store.identitySalt());
    this.#codex = new CodexSessions(env, { retainDatabase: true });
    this.#claude = new ClaudeSessions(env);
    this.#grok = new GrokSessions(env);
    this.#openclaw = new OpenClawSessions(env);
    this.#hermes = new HermesSessions(env);
    this.#opencode = new OpenCodeSessions(commands, env);
    this.#antigravity = new AntigravityHistory(env);
    this.#cursor = new CursorSessions(env);
    this.#cursorIde = new CursorIdeSessions(cursorBridge);
    this.#devin = new DevinSessions(env);
    const context: SessionHistoryContext = {
      store,
      codex: this.#codex,
      claude: this.#claude,
      antigravity: this.#antigravity,
      devin: this.#devin,
      nativeHistory,
      dsh,
      paging: this.#paging,
      imageScope: (native, workspace) => this.#imageScope(native, workspace),
      resolveSession: (sessionId) => this.resolve(sessionId),
      verifiedCodexControlDirectory: (nativeRef) => this.verifiedCodexControlDirectory(nativeRef),
      verifiedCodexSubagentParent: (sessionId, nativeId, workspace) =>
        this.verifiedCodexSubagentParent(sessionId, nativeId, workspace),
      verifiedClaudeImageSource: (id) => this.verifiedClaudeReadSource(id),
      verifiedClaudeNativeSource: (nativeRef, workspace) => {
        const source = this.#verifiedClaudeControlSource(nativeRef, workspace);
        return { native: source.session, transcript: source.transcript };
      },
    };
    for (const agent of SESSION_AGENTS) {
      const reader = getSessionProviderReader(agent);
      if (reader) this.#history.set(agent, reader.history(context));
    }
  }
  catalogListing(agent: SessionAgent, paths?: readonly string[]) {
    return this.#history.get(agent)?.catalogListing?.(paths);
  }
  close(): void {
    this.#codex.close();
    this.#antigravity.close();
    this.#paging.clear();
    this.#subagents.clear();
    this.#subagentCandidates.clear();
    for (const reader of this.#history.values()) reader.clear?.();
  }
  /** Children never pass through the ordinary catalog/control resolver. */
  async subagentsForNative(
    parent: SubagentParent,
    childId?: string,
    cursor: string | null = null,
    limit = 50,
    observations: SubagentObservation[] = [],
  ) {
    const cacheKey = JSON.stringify([
      parent.sessionId,
      parent.nativeId,
      parent.workspace,
      parent.transcript,
    ]);
    const cached = this.#subagentCandidates.get(cacheKey);
    const candidates: CodexSubagentSource[] =
      cached && Date.now() - cached.at < 2_000 ? cached.candidates : [];
    const reader = this.#history.get(parent.agent);
    if (reader?.collectSubagentCandidates && candidates !== cached?.candidates) {
      reader.collectSubagentCandidates(parent, candidates);
      this.#subagentCandidates.set(cacheKey, { at: Date.now(), candidates });
      if (this.#subagentCandidates.size > 64)
        this.#subagentCandidates.delete(this.#subagentCandidates.keys().next().value!);
    }
    return childId
      ? this.#subagents.events(parent, childId, cursor, limit, candidates, observations)
      : this.#subagents.list(parent, candidates, observations);
  }
  verifiedCodexSubagentParent(
    sessionId: string,
    nativeId: string,
    workspace: string,
  ): SubagentParent {
    const identity = this.verifiedCodexControlDirectory(nativeId);
    const root = canonicalize(workspace);
    if (!identity || !within(canonicalize(identity.cwd), root))
      throw new Error("session-workspace-mismatch");
    const source = this.#codex
      .list(null, { nativeRef: nativeId })
      .sessions.find(
        (value) => value.session.native_ref === nativeId && value.session.origin !== "auxiliary",
      );
    if (!source) throw new Error("session-unavailable");
    return { sessionId, nativeId, workspace: root, transcript: source.transcript, agent: "codex" };
  }
  subagentObservationId(parent: SubagentParent, id: string, observations: SubagentObservation[]) {
    return this.#subagents.observationId(parent, id, observations);
  }

  async activitySubagentsForDevin(sessionId: string): Promise<SubagentCatalog | undefined> {
    const source = await this.resolve(sessionId);
    if (source.native.sidechain) return;
    return this.#history.get(source.native.agent)?.activitySubagents?.(source, sessionId);
  }

  async subagentsForSession(
    sessionId: string,
    childId?: string,
    cursor: string | null = null,
    limit = 50,
    running = false,
    turnId: string | null = null,
    observation?: Pick<SubagentParent, "connected" | "observerId">,
  ) {
    const source = await this.resolve(sessionId);
    const reader = this.#history.get(source.native.agent);
    if (reader?.subagents && !source.native.sidechain)
      return reader.subagents({ ...source, sessionId, childId, cursor, limit });
    if (
      !source.transcript ||
      !reader?.subagentParent ||
      source.native.origin === "auxiliary" ||
      source.native.sidechain
    )
      throw new Error("session-not-controllable");
    const parent = reader.subagentParent({ ...source, transcript: source.transcript }, sessionId);
    return this.subagentsForNative(
      { ...parent, running, turnId, ...observation },
      childId,
      cursor,
      limit,
    );
  }
  verifiedCodexControlIds(nativeRefs: Iterable<string>): Set<string> {
    return this.#codex.verifiedControlIds(nativeRefs);
  }
  managedCodexCandidates(
    nativeRefs: Iterable<string>,
    matchesScope: (nativeRef: string, cwd: string, collection: SessionCollection | null) => boolean,
  ) {
    return this.#codex.list(null, { nativeRefs, matchesScope }).sessions;
  }
  verifiedCodexIndexedIdentities(nativeRefs: Iterable<string>, rolloutHome: string) {
    return this.#codex.verifiedIndexedIdentities(nativeRefs, rolloutHome);
  }
  verifiedCodexResumeIdentity(nativeRef: string): { id: string; cwd: string } | undefined {
    if (!this.#codex.verifiedControlIds([nativeRef]).has(nativeRef.toLowerCase())) return;
    return this.#codex.verifiedIndexedIdentities([nativeRef]).get(nativeRef.toLowerCase());
  }
  verifiedCodexControlDirectory(nativeRef: string): { id: string; cwd: string } | undefined {
    return this.#codex.verifiedControlDirectories([nativeRef]).get(nativeRef.toLowerCase());
  }
  codexHistoricalSettings(nativeRef: string, workspace: string) {
    return this.#codex.historicalSettings(nativeRef, workspace);
  }
  codexThreadWritten(nativeRef: string): boolean {
    return this.#codex.writtenThreadIds([nativeRef]).has(nativeRef.toLowerCase());
  }
  antigravityControlExecutable(): string {
    return this.#antigravity.controlExecutable();
  }
  devinSessionModel(nativeRef: string) {
    return this.nativeHistory
      ? this.nativeHistory.read("devin-model", [this.#devin.database(), nativeRef])
      : this.#devin.model(nativeRef);
  }
  devinLastContextInput(nativeRef: string, workspace: string, model: string) {
    return this.nativeHistory
      ? this.nativeHistory.read("devin-lastContextInput", [
          this.#devin.database(),
          nativeRef,
          workspace,
          model,
        ])
      : this.#devin.lastContextInput(nativeRef, workspace, model);
  }
  antigravityReadHandoff(nativeRef: string) {
    return this.#antigravity.readHandoff(nativeRef);
  }
  verifiedClaudeControlTarget(nativeRef: string, workspace: string): string {
    return this.#verifiedClaudeControlSource(nativeRef, workspace).transcript;
  }

  /** A first managed turn can be visible before there is any transcript to verify. */
  claudeFirstTranscript(nativeRef: string, workspace: string): string | null {
    return (
      this.#verifiedClaudeControlSource(nativeRef, workspace, undefined, false, true)?.transcript ??
      null
    );
  }

  async claudeFirstEvents(
    nativeRef: string,
    workspace: string,
    count: number,
    retain: boolean,
  ): Promise<ConversationEventPage | null> {
    const source = this.#verifiedClaudeControlSource(nativeRef, workspace, undefined, false, true);
    return source
      ? this.#readEvents(source.session, workspace, null, count, source.transcript, retain)
      : null;
  }
  /** A native EnterWorktree move keeps its original UUID and transcript, not its opening cwd. */
  verifyClaudeBridgeWorktree(
    nativeId: string,
    sourceWorkspace: string,
    candidateWorkspace: string,
  ): void {
    const fail = () => {
      throw new Error("session-workspace-mismatch");
    };
    const source = canonicalize(sourceWorkspace),
      candidate = canonicalize(candidateWorkspace),
      worktrees = path.join(source, ".claude", "worktrees");
    if (
      source !== sourceWorkspace ||
      candidate !== candidateWorkspace ||
      candidateWorkspace.split(/[\\/]/).some((part) => part === "." || part === "..") ||
      path.dirname(candidate) !== worktrees
    )
      fail();
    const directory = (value: string) => {
      const metadata = lstatSync(value, { bigint: true });
      if (!metadata.isDirectory() || isReparseOrSymlink(value, metadata)) fail();
    };
    const layout = () => {
      if (canonicalize(source) !== source || canonicalize(candidate) !== candidate) fail();
      for (const value of [path.join(source, ".claude"), worktrees, candidate]) directory(value);
      const primary = readCheckout(source);
      if (!primary) return fail();
      const marker = path.join(candidate, ".git"),
        pointer = /^gitdir:\s*(.+)$/i.exec(claudeBridgeGitPointer(marker));
      if (!pointer) return fail();
      const admin = path.resolve(candidate, pointer[1]!),
        administration = path.join(primary.commonDir, "worktrees");
      if (path.dirname(admin) !== administration) fail();
      directory(administration);
      directory(admin);
      if (
        canonicalize(admin) !== admin ||
        path.resolve(admin, claudeBridgeGitPointer(path.join(admin, "commondir"))) !==
          primary.commonDir ||
        path.resolve(admin, claudeBridgeGitPointer(path.join(admin, "gitdir"))) !== marker
      )
        fail();
      const linked = readCheckout(candidate);
      if (!linked?.linked || linked.gitDir !== admin || linked.commonDir !== primary.commonDir)
        fail();
      return [primary.commonDir, admin].join("\0");
    };
    const beforeLayout = layout(),
      transcript = this.verifiedClaudeControlTarget(nativeId, source),
      metadata = lstatSync(transcript, { bigint: true });
    if (!metadata.isFile() || isReparseOrSymlink(transcript, metadata)) fail();
    const version = claudeBridgeFileVersion(metadata),
      fd = openSync(transcript, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (claudeBridgeFileVersion(fstatSync(fd, { bigint: true })) !== version) fail();
      const size = Math.min(Number(metadata.size), 512 * 1024),
        start = Number(metadata.size) - size,
        buffer = Buffer.alloc(size),
        count = readSync(fd, buffer, 0, buffer.length, start);
      if (count !== size) fail();
      const text = buffer.toString("utf8"),
        lines = (start ? text.slice(text.indexOf("\n") + 1) : text).split("\n");
      let latest: Record<string, unknown> | undefined;
      for (const line of lines) {
        if (!line.trim()) continue;
        let row: unknown;
        try {
          row = JSON.parse(line);
        } catch {
          return fail();
        }
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        const value = row as Record<string, unknown>;
        if (value.type !== "user" && value.type !== "assistant") continue;
        if (
          value.isSidechain === true ||
          value.isMeta === true ||
          value.isCompactSummary === true ||
          typeof value.agentId === "string"
        )
          continue;
        if (
          typeof value.sessionId !== "string" ||
          value.sessionId.toLowerCase() !== nativeId.toLowerCase()
        )
          fail();
        latest = value;
      }
      if (
        typeof latest?.cwd !== "string" ||
        latest.cwd !== candidate ||
        !latest.message ||
        typeof latest.message !== "object" ||
        Array.isArray(latest.message) ||
        (latest.message as Record<string, unknown>).role !== latest.type ||
        claudeBridgeFileVersion(fstatSync(fd, { bigint: true })) !== version ||
        claudeBridgeFileVersion(lstatSync(transcript, { bigint: true })) !== version
      )
        fail();
    } finally {
      closeSync(fd);
    }
    // The bounded tail must not validate a file or Git layout swapped after its opening proof.
    if (
      this.verifiedClaudeControlTarget(nativeId, source) !== transcript ||
      claudeBridgeFileVersion(lstatSync(transcript, { bigint: true })) !== version ||
      layout() !== beforeLayout
    )
      fail();
  }
  /** Display metadata follows the same native identity and workspace proof as control. */
  verifiedClaudeControlMetadata(
    nativeRef: string,
    workspace: string,
    share?: ClaudeControlMetadataShare,
  ) {
    const { session } = this.#verifiedClaudeControlSource(nativeRef, workspace, share);
    return { title: session.title, created_at: session.created_at, updated_at: session.updated_at };
  }
  /** Read-only resolution checks the indexed identity without parsing or hashing its history. */
  verifiedClaudeReadSource(id: string) {
    const summary = this.store.get(id);
    if (!summary) throw new Error("session-unavailable");
    if (summary.agent !== "claude-code" || summary.sidechain)
      throw new Error("session-not-controllable");
    const root = canonicalize(this.store.workspacePath(summary.workspace_id));
    const listing = this.#claude.list(root);
    const source = listing.sessions.find(
      (candidate) => this.store.id("claude-code", candidate.session.native_ref) === id,
    );
    if (!source) throw new Error("session-unavailable");
    // A deleted worktree leaves only the path its transcript recorded; its history stays readable.
    const directory = recordedDirectory(source.cwd);
    const workspace = directory.path;
    if (!within(workspace, root)) throw new Error("session-workspace-mismatch");
    const verified = this.#verifiedClaudeControlSource(
      source.session.native_ref,
      workspace,
      { current: listing },
      directory.missing,
    );
    return {
      workspaceId: summary.workspace_id,
      workspace,
      /** Reading still works; continuing needs the folder back. */
      directoryMissing: directory.missing,
      nativeId: verified.session.native_ref,
      transcript: verified.transcript,
      native: verified.session,
    };
  }
  /** `retain` false keeps no cursor; see [SessionPaging.read]. */
  async claudeEventsForSession(
    id: string,
    cursor: string | null,
    count: number,
    retain = true,
  ): Promise<ConversationEventPage> {
    const source = this.verifiedClaudeReadSource(id);
    return this.#readEvents(
      source.native,
      source.workspace,
      cursor,
      count,
      source.transcript,
      retain,
    );
  }
  /** Control needs the directory to exist; a read may name a deleted one by its recorded path. */
  #verifiedClaudeControlSource(
    nativeRef: string,
    workspace: string,
    share?: ClaudeControlMetadataShare,
    allowMissingDirectory?: boolean,
  ): NativeSessionSource;
  #verifiedClaudeControlSource(
    nativeRef: string,
    workspace: string,
    share: undefined,
    allowMissingDirectory: false,
    allowUnwrittenTranscript: true,
  ): NativeSessionSource | null;
  #verifiedClaudeControlSource(
    nativeRef: string,
    workspace: string,
    share?: ClaudeControlMetadataShare,
    allowMissingDirectory = false,
    allowUnwrittenTranscript = false,
  ): NativeSessionSource | null {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeRef))
      throw new Error("unverified-session-identity");
    const sessionId = nativeRef.toLowerCase();
    const canonicalize = allowMissingDirectory
      ? (value: string) => recordedDirectory(value).path
      : canonicalizePath;
    const expectedWorkspace = canonicalize(workspace);
    const listing = allowUnwrittenTranscript
      ? this.#claude.list(null, nativeRef)
      : share
        ? (share.current ??= this.#claude.list(null))
        : this.#claude.list(null);
    const source = listing.sessions.find(
      (candidate) => candidate.session.native_ref.toLowerCase() === sessionId,
    );
    if (
      !source &&
      allowUnwrittenTranscript &&
      !listing.incomplete &&
      !listing.hasTranscriptCandidate
    )
      return null;
    if (
      !source ||
      source.session.sidechain ||
      pathIdentity(canonicalize(source.cwd)) !== pathIdentity(expectedWorkspace)
    )
      throw new Error("session-workspace-mismatch");
    const transcript = source.transcript;
    const verifyHeader = () => {
      const pathInfo = lstatSync(transcript);
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink())
        throw new Error("Claude transcript symlink unsupported");
      const fd = openSync(transcript, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = fstatSync(fd);
        if (!info.isFile()) throw new Error("unverified-session-identity");
        if (allowUnwrittenTranscript && info.size === 0) return false;
        const buffer = Buffer.alloc(256 * 1024);
        const size = readSync(fd, buffer, 0, buffer.length, 0);
        for (const line of buffer.subarray(0, size).toString("utf8").split("\n")) {
          let row: unknown;
          try {
            row = JSON.parse(line);
          } catch {
            continue;
          }
          if (!row || typeof row !== "object" || Array.isArray(row)) continue;
          const value = row as Record<string, unknown>;
          if (typeof value.sessionId !== "string") continue;
          if (value.sessionId.toLowerCase() !== sessionId)
            throw new Error("session-identity-mismatch");
          if (value.isSidechain === true) throw new Error("auxiliary-session-not-controllable");
          if (typeof value.cwd === "string") {
            if (pathIdentity(canonicalize(value.cwd)) !== pathIdentity(expectedWorkspace))
              throw new Error("session-workspace-mismatch");
            return true;
          }
        }
      } finally {
        closeSync(fd);
      }
      throw new Error("unverified-session-identity");
    };
    return verifyHeader() ? source : null;
  }
  claudeControlWorkspace(nativeRef: string, workspaceRoot: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeRef))
      throw new Error("unverified-session-identity");
    const root = canonicalize(workspaceRoot);
    const source = this.#claude
      .list(null)
      .sessions.find(
        (candidate) => candidate.session.native_ref.toLowerCase() === nativeRef.toLowerCase(),
      );
    if (!source || source.session.sidechain) throw new Error("unverified-session-identity");
    const cwd = canonicalize(source.cwd);
    const relative = path.relative(root, cwd);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("session-workspace-mismatch");
    return cwd;
  }
  codexHome(): string {
    return this.#codex.home();
  }
  verifiedCodexReadTranscript(nativeId: string, workspace: string): string | null {
    return (
      this.#codex
        .list(workspace, { nativeRef: nativeId })
        .sessions.find((source) => source.session.native_ref === nativeId)?.transcript ?? null
    );
  }
  /** `matches` narrows Codex classification and resolves previously indexed Antigravity aliases. */
  async list(
    agent: SessionAgent,
    workspace: string,
    selection: {
      matches?: (nativeRef: string) => boolean;
      indexedSessionIds?: readonly string[];
    } = {},
  ): Promise<NativeListing> {
    const collection = sessionCollection(workspace);
    const reader = this.#history.get(agent);
    if (collection)
      return (
        reader?.listCollection?.(collection, selection.matches) ?? {
          sessions: [],
          incomplete: false,
        }
      );
    if (reader) {
      if (
        agent !== "antigravity" ||
        !selection.indexedSessionIds?.length ||
        antigravityAcpEnabled(this.env)
      )
        return reader.list(workspace, selection.matches);
      const previous = new Set(selection.indexedSessionIds);
      const salt = this.store.identitySalt();
      const idOf = (nativeRef: string) => sessionIdentity(salt, agent, nativeRef);
      const listing = await reader.list(workspace, (nativeRef) => previous.has(idOf(nativeRef)));
      for (const { native_ref } of listing.sessions) previous.delete(idOf(native_ref));
      if (!previous.size) return listing;
      // Keep summaries that are still known only through the now-disabled ACP source.
      return {
        ...listing,
        retainedMetadataIds: [...previous],
      };
    }
    switch (agent) {
      case "opencode":
        return { sessions: await this.#opencode.list(workspace), incomplete: false };
      case "cursor": {
        const cli = this.#cursor.list(workspace);
        try {
          const ide = this.#cursorIde.list(workspace);
          return {
            sessions: [...cli.sessions, ...ide.sessions],
            incomplete: cli.incomplete || ide.incomplete,
          };
        } catch {
          return { ...cli, incomplete: true };
        }
      }
      default: {
        const provider =
          agent === "grok-build"
            ? this.#grok
            : agent === "open-claw"
              ? this.#openclaw
              : this.#hermes;
        const listing = provider.list(workspace);
        return {
          sessions: listing.sessions.map(withSessionDirectory),
          incomplete: listing.incomplete,
        };
      }
    }
  }
  async resolve(id: string) {
    const summary = this.store.get(id);
    if (!summary) throw new Error("Conversation metadata is no longer available");
    const agent = summary.agent;
    if (!(SESSION_AGENTS as readonly string[]).includes(agent))
      throw new Error("Conversation provider is unavailable");
    const collection = sessionCollection(summary.workspace_id);
    const reader = this.#history.get(agent);
    if (collection) {
      if (!reader?.resolveCollection) throw new Error("Conversation provider is unavailable");
      const source = reader.resolveCollection(id, collection);
      if (!source) throw new Error("Conversation transcript is no longer available");
      return { summary, ...source };
    }
    const workspace = this.store.workspacePath(summary.workspace_id);
    if (reader?.resolve) {
      // Resolve ownership and the transcript together for each request.
      const source = reader.resolve(id, workspace);
      if (!source) throw new Error("Conversation transcript is no longer available");
      return { summary, ...source };
    }
    const matches = (nativeRef: string) => this.store.id(agent, nativeRef) === id;
    const listing = await this.list(
      agent as SessionAgent,
      workspace,
      agent === "antigravity" ? { matches } : undefined,
    );
    const native = listing.sessions.find((candidate) => matches(candidate.native_ref));
    if (!native)
      throw new Error(
        agent === "antigravity" && !antigravityAcpEnabled(this.env)
          ? ANTIGRAVITY_ACP_DISABLED
          : "Conversation transcript is no longer available",
      );
    return { summary, native, workspace };
  }
  /** `retainCursor` false keeps no cursor; see [SessionPaging.read]. */
  async events(value: unknown): Promise<ConversationEventPage> {
    const { sessionId, cursor, limit, retainCursor } = parameters(
      z.object({
        sessionId: z.string(),
        cursor: optionalString,
        limit: unsigned.nullable().optional(),
        retainCursor: z.boolean().optional(),
      }),
      value,
    );
    const { native, workspace, transcript } = await this.resolve(sessionId);
    return this.#readEvents(
      native,
      workspace,
      cursor ?? null,
      limit ?? 50,
      transcript,
      retainCursor !== false,
    );
  }
  hasImageReferences(ids: readonly string[]): boolean {
    return this.#paging.hasImageReferences(ids);
  }
  async image(sessionId: string, imageId: string) {
    try {
      return await this.#image(sessionId, imageId);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("session-image-")) throw error;
      throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);
    }
  }
  async #image(sessionId: string, imageId: string) {
    const agent = this.store.get(sessionId)?.agent;
    const imageSource = agent ? this.#history.get(agent)?.imageSource : undefined;
    if (imageSource) {
      const source = imageSource(sessionId);
      const result = await this.#readImage(
        source.native,
        source.workspace,
        imageId,
        source.transcript,
      );
      const current = imageSource(sessionId);
      if (
        current.nativeId !== source.nativeId ||
        current.workspaceId !== source.workspaceId ||
        pathIdentity(current.workspace) !== pathIdentity(source.workspace)
      )
        throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);
      return result;
    }
    const source = await this.resolve(sessionId);
    const result = await this.#readImage(
      source.native,
      source.workspace,
      imageId,
      source.transcript,
    );
    const current = await this.resolve(sessionId);
    if (
      current.native.agent !== source.native.agent ||
      current.native.native_ref !== source.native.native_ref ||
      current.summary.workspace_id !== source.summary.workspace_id ||
      pathIdentity(current.workspace) !== pathIdentity(source.workspace)
    )
      throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);
    return result;
  }
  async imageForNative(
    agent: SessionAgent,
    nativeRef: string,
    workspace: string,
    imageId: string,
    options?: { codexDirectory: string },
  ) {
    if (!nativeRef || nativeRef.length > 4096)
      throw new Error(REMOTE_ERROR_CODES.invalidRequestDetail);
    const reader = this.#history.get(agent);
    if (options) {
      if (!reader?.nativeDirectorySource) throw new Error(REMOTE_ERROR_CODES.invalidRequestDetail);
      const source = reader.nativeDirectorySource(
        nativeRef,
        workspace,
        options.codexDirectory,
        REMOTE_ERROR_CODES.sessionImageUnavailable,
      );
      const result = await this.#readImage(source.native, workspace, imageId, source.transcript);
      source.verify();
      return result;
    }
    if (reader?.nativeWorkspaceSource) {
      const source = reader.nativeWorkspaceSource(nativeRef, workspace);
      const result = await this.#readImage(source.native, workspace, imageId, source.transcript);
      reader.nativeWorkspaceSource(nativeRef, workspace);
      return result;
    }
    throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);
  }
  #imageScope(native: NativeSession, workspace: string) {
    return JSON.stringify([
      native.agent,
      native.native_ref.toLowerCase(),
      pathIdentity(recordedDirectory(workspace).path),
    ]);
  }
  async #readImage(native: NativeSession, workspace: string, imageId: string, transcript?: string) {
    const reader = this.#history.get(native.agent);
    if (!reader?.image) throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);
    return reader.image({ native, workspace, imageId, transcript });
  }
  /** `retain` false keeps no cursor; see [SessionPaging.read]. */
  async eventsForNative(
    agent: SessionAgent,
    nativeRef: string,
    workspace: string,
    cursor: string | null,
    limit: number,
    options?: { codexDirectory: string; imageScanBudget?: { remainingBytes: number } },
    retain = true,
  ): Promise<ConversationEventPage> {
    if (!nativeRef || nativeRef.length > 4096 || limit < 1 || limit > 100)
      throw new Error(REMOTE_ERROR_CODES.invalidRequestDetail);
    const reader = this.#history.get(agent);
    if (options) {
      if (!reader?.nativeDirectorySource) throw new Error(REMOTE_ERROR_CODES.invalidRequestDetail);
      const source = reader.nativeDirectorySource(
        nativeRef,
        workspace,
        options.codexDirectory,
        "session-unavailable",
      );
      const page = await this.#readEvents(
        { ...source.native, cwd: source.cwd },
        workspace,
        cursor,
        limit,
        source.transcript,
        retain,
        options.imageScanBudget,
      );
      source.verify();
      return page;
    }
    if (reader?.nativeWorkspaceSource) {
      const source = reader.nativeWorkspaceSource(nativeRef, workspace);
      return this.#readEvents(source.native, workspace, cursor, limit, source.transcript, retain);
    }
    const listing = await this.list(agent, workspace);
    const native = listing.sessions.find(
      (candidate) => candidate.native_ref === nativeRef && candidate.agent === agent,
    );
    if (!native) throw new Error("session-unavailable");
    return this.#readEvents(native, workspace, cursor, limit, undefined, retain);
  }
  async #readEvents(
    native: NativeSession,
    workspace: string,
    offset: string | null,
    count: number,
    transcript?: string,
    retain = true,
    imageScanBudget?: { remainingBytes: number },
  ): Promise<ConversationEventPage> {
    const ref = native.native_ref,
      agent = native.agent;
    const reader = this.#history.get(agent);
    if (reader)
      return reader.events({
        native,
        workspace,
        offset,
        count,
        transcript,
        retain,
        imageScanBudget,
      });
    switch (agent) {
      case "grok-build":
        return this.#paging.read(
          this.#grok.resolve(ref).transcript,
          offset,
          count,
          agent,
          {},
          retain,
        );
      case "open-claw": {
        const source = this.#openclaw.resolve(ref);
        return source.sqlite
          ? readOpenClawSqliteEvents(source.sqlite, offset, count)
          : this.#paging.read(source.transcript, offset, count, agent, {}, retain);
      }
      case "hermes": {
        const { source } = this.#hermes.resolve(ref);
        return source.type === "sqlite"
          ? readHermesEvents(source.path, source.sessionId, offset, count)
          : this.#paging.read(source.path, offset, count, "hermes", {}, retain);
      }
      case "opencode":
        return this.#opencode.readEvents(workspace, ref, offset, count);
      case "cursor":
        return ref.startsWith("cursor-ide-v1-")
          ? this.#cursorIde.events(ref, workspace, offset, count)
          : this.#cursor.events(ref, offset, count);
      default:
        throw new Error("Conversation provider is unavailable");
    }
  }
  async document(sessionId: string, options?: DocumentOptions): Promise<SessionDocument> {
    const summary = this.store.get(sessionId);
    if (!summary) throw new Error("Conversation metadata is no longer available");
    // Readers backed by a live bridge must run in the host even during a handoff.
    const hostReader = this.#history.get(summary.agent);
    if (hostReader?.hostDocument) {
      if (summary.availability !== "readable")
        throw new Error("Conversation transcript is no longer available");
      return hostReader.hostDocument(sessionId, summary, options);
    }
    if (handoffActive()) {
      const workspace = sessionCollection(summary.workspace_id)
        ? summary.workspace_id
        : this.store.workspacePath(summary.workspace_id);
      const profiles = summary.agent === "cursor" ? this.cursorBridge.profiles(workspace) : [];
      const document = await readHandoff(
        "source-document",
        {
          sessionId,
          summary,
          workspace,
          profiles,
          environment: this.env,
          identitySalt: this.store.identitySalt(),
          ...(options ? { options } : {}),
        },
        () => {
          throw new Error("Handoff read worker is unavailable");
        },
      );
      handoffCheckpoint();
      if (
        JSON.stringify(this.store.get(sessionId)) !== JSON.stringify(summary) ||
        (!sessionCollection(summary.workspace_id) &&
          this.store.workspacePath(summary.workspace_id) !== workspace) ||
        (summary.agent === "cursor" &&
          JSON.stringify(this.cursorBridge.profiles(workspace)) !== JSON.stringify(profiles))
      )
        throw new Error("Conversation ownership changed while reading history");
      return document;
    }
    if (summary.availability !== "readable")
      throw new Error("Conversation transcript is no longer available");
    if (!(SESSION_AGENTS as readonly string[]).includes(summary.agent))
      throw new Error("Conversation provider is unavailable");
    const { native, workspace, transcript } = await this.resolve(sessionId);
    const reader = this.#history.get(native.agent);
    if (reader?.document)
      return reader.document({ summary, native, workspace, transcript, options });
    if (native.agent === "opencode")
      return this.#opencode.readDocument(workspace, native.native_ref, {
        ...summary,
        agent: native.agent,
      });
    if (native.agent === "cursor")
      return native.native_ref.startsWith("cursor-ide-v1-")
        ? this.#cursorIde.document(native, summary.workspace_id, workspace)
        : this.#cursor.document(native, summary.workspace_id, workspace);
    if (native.agent === "open-claw") {
      const source = this.#openclaw.resolve(native.native_ref);
      if (source.sqlite) return readOpenClawSqliteDocument(source.sqlite, summary.workspace_id);
      return readEventDocument(
        {
          agent: native.agent,
          workspace_id: summary.workspace_id,
          title: summary.title,
          created_at: summary.created_at,
          updated_at: summary.updated_at,
          git_branch: summary.git_branch,
        },
        (cursor, limit) => this.#readEvents(native, workspace, cursor, limit),
      );
    }
    if (native.agent === "hermes") {
      const { source } = this.#hermes.resolve(native.native_ref);
      return readHermesDocument(
        {
          agent: native.agent,
          workspace_id: summary.workspace_id,
          title: summary.title,
          created_at: summary.created_at,
          updated_at: summary.updated_at,
          git_branch: summary.git_branch,
        },
        source,
      );
    }
    if (native.agent === "grok-build") {
      const source = this.#grok.resolve(native.native_ref);
      return readGrokDocument(
        {
          agent: native.agent,
          workspace_id: summary.workspace_id,
          title: summary.title,
          created_at: summary.created_at,
          updated_at: summary.updated_at,
          git_branch: summary.git_branch,
        },
        source.transcript,
      );
    }
    throw new Error("Conversation provider is unavailable");
  }
}
