import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { sessionCollection } from "@agentkib/runtime-protocol";
import { CodexSessions } from "./codex-sessions";
import { codexRollouts } from "./codex-rollout-files";
import { ClaudeSessions } from "./claude-sessions";
import { GrokSessions } from "./grok-sessions";
import { OpenClawSessions } from "./openclaw-sessions";
import { HermesSessions } from "./hermes-sessions";
import { OpenCodeSessions } from "./opencode-sessions";
import { AntigravitySessions } from "./antigravity-sessions";
import { CursorSessions } from "./cursor-sessions";
import { CursorIdeSessions } from "./cursor-ide-sessions";
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
import { SessionStore, type NativeSession } from "./session-store";
import { Commands } from "./commands";
import { parameters, optionalString, unsigned } from "./rpc";
import type { ConversationEventPage } from "./session-events";
import type { DocumentOptions, SessionDocument } from "./session-model";
import type { DshBridge } from "./dsh-bridge";
import {
  readClaudeDocument,
  readCodexDocument,
  readEventDocument,
} from "./session-document-providers";
import { canonicalize, pathIdentity } from "./paths";
import { within } from "./files";
import { handoffActive, handoffCheckpoint, readHandoff } from "./handoff-work";

const canonicalizePath = canonicalize;

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
] as const;
export type SessionAgent = (typeof SESSION_AGENTS)[number];
/** DeepSeek Harness history and its images come from the running DSH through its AgentKib plugin. */
export type DshSessionSource = Pick<DshBridge, "list" | "events" | "image" | "document">;
/** One catalog call may share discovery; every metadata target still verifies its own header. */
export type ClaudeControlMetadataShare = { current?: ReturnType<ClaudeSessions["list"]> };

export interface NativeListing {
  sessions: NativeSession[];
  incomplete: boolean;
}

/** Revalidate indexed workspace ownership before resolving an opaque reference in native history. */
export class SessionReaders {
  #codex: CodexSessions;
  #claude: ClaudeSessions;
  #grok: GrokSessions;
  #openclaw: OpenClawSessions;
  #hermes: HermesSessions;
  #opencode: OpenCodeSessions;
  #antigravity: AntigravitySessions;
  #cursor: CursorSessions;
  #cursorIde: CursorIdeSessions;
  #paging = new SessionPaging();
  #subagents: SessionSubagents;
  #subagentCandidates = new Map<string, { at: number; candidates: CodexSubagentSource[] }>();
  constructor(
    readonly store: Pick<SessionStore, "get" | "id" | "workspacePath" | "identitySalt">,
    commands: Commands,
    readonly env: NodeJS.ProcessEnv,
    readonly cursorBridge: Pick<CursorBridge, "profiles">,
    readonly dsh?: DshSessionSource,
  ) {
    this.#subagents = new SessionSubagents(store.identitySalt());
    this.#codex = new CodexSessions(env);
    this.#claude = new ClaudeSessions(env);
    this.#grok = new GrokSessions(env);
    this.#openclaw = new OpenClawSessions(env);
    this.#hermes = new HermesSessions(env);
    this.#opencode = new OpenCodeSessions(commands, env);
    this.#antigravity = new AntigravitySessions(env);
    this.#cursor = new CursorSessions(env);
    this.#cursorIde = new CursorIdeSessions(cursorBridge);
  }
  close(): void {
    this.#antigravity.close();
    this.#paging.clear();
    this.#subagents.clear();
    this.#subagentCandidates.clear();
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
    if (parent.agent === "codex" && candidates !== cached?.candidates) {
      const seen = new Set([parent.nativeId]);
      let parents = new Set([parent.nativeId]);
      for (let depth = 0; depth < 8 && candidates.length < 128; depth++) {
        const listing = this.#codex.list(parent.workspace, {
          parents,
          limit: 128 - candidates.length,
        });
        const next = new Set<string>();
        for (const source of listing.sessions) {
          if (seen.has(source.session.native_ref) || !source.session.spawned_by_session_id)
            continue;
          seen.add(source.session.native_ref);
          next.add(source.session.native_ref);
          candidates.push({
            nativeId: source.session.native_ref,
            parentNativeId: source.session.spawned_by_session_id,
            name: source.session.title ?? "Codex",
            transcript: source.transcript,
          });
        }
        if (!next.size) break;
        parents = next;
      }
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
      .list(null, { matches: (ref) => ref === nativeId })
      .sessions.find(
        (value) => value.session.native_ref === nativeId && value.session.origin !== "auxiliary",
      );
    if (!source) throw new Error("session-unavailable");
    return { sessionId, nativeId, workspace: root, transcript: source.transcript, agent: "codex" };
  }
  subagentObservationId(parent: SubagentParent, id: string, observations: SubagentObservation[]) {
    return this.#subagents.observationId(parent, id, observations);
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
    if (
      !source.transcript ||
      !["codex", "claude-code"].includes(source.native.agent) ||
      source.native.origin === "auxiliary" ||
      source.native.sidechain
    )
      throw new Error("session-not-controllable");
    const parent =
      source.native.agent === "codex"
        ? this.verifiedCodexSubagentParent(sessionId, source.native.native_ref, source.workspace)
        : {
            sessionId,
            nativeId: source.native.native_ref,
            workspace: source.workspace,
            transcript: source.transcript,
            agent: "claude-code" as const,
          };
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
  verifiedCodexResumeIdentity(nativeRef: string): { id: string; cwd: string } | undefined {
    if (!this.#codex.verifiedControlIds([nativeRef]).has(nativeRef.toLowerCase())) return;
    return this.#codex.verifiedIndexedIdentities([nativeRef]).get(nativeRef.toLowerCase());
  }
  verifiedCodexControlDirectory(nativeRef: string): { id: string; cwd: string } | undefined {
    return this.#codex.verifiedControlDirectories([nativeRef]).get(nativeRef.toLowerCase());
  }
  antigravityControlExecutable(): string {
    return this.#antigravity.controlExecutable();
  }
  antigravityReadHandoff(nativeRef: string) {
    return this.#antigravity.readHandoff(nativeRef);
  }
  verifiedClaudeControlTarget(nativeRef: string, workspace: string): string {
    return this.#verifiedClaudeControlSource(nativeRef, workspace).transcript;
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
    allowMissingDirectory = false,
  ) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeRef))
      throw new Error("unverified-session-identity");
    const sessionId = nativeRef.toLowerCase();
    const canonicalize = allowMissingDirectory
      ? (value: string) => recordedDirectory(value).path
      : canonicalizePath;
    const expectedWorkspace = canonicalize(workspace);
    const listing = share ? (share.current ??= this.#claude.list(null)) : this.#claude.list(null);
    const source = listing.sessions.find(
      (candidate) => candidate.session.native_ref.toLowerCase() === sessionId,
    );
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
        if (!fstatSync(fd).isFile()) throw new Error("unverified-session-identity");
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
            return;
          }
        }
      } finally {
        closeSync(fd);
      }
      throw new Error("unverified-session-identity");
    };
    verifyHeader();
    return source;
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
        .list(workspace, { matches: (id) => id === nativeId })
        .sessions.find((source) => source.session.native_ref === nativeId)?.transcript ?? null
    );
  }
  /** `matches` narrows a Codex listing by native ID before any thread is classified. */
  async list(
    agent: SessionAgent,
    workspace: string,
    selection: { matches?: (nativeRef: string) => boolean } = {},
  ): Promise<NativeListing> {
    const collection = sessionCollection(workspace);
    // The index keeps each session's directory so the catalog can recognize git worktrees.
    const withDirectory = (source: { cwd: string | null; session: NativeSession }) => ({
      ...source.session,
      cwd: source.cwd,
    });
    if (collection) {
      if (agent !== "codex") return { sessions: [], incomplete: false };
      const listing = this.#codex.list(null, { collection, matches: selection.matches });
      return {
        sessions: listing.sessions.map(withDirectory),
        incomplete: listing.incomplete,
      };
    }
    switch (agent) {
      case "opencode":
        return { sessions: await this.#opencode.list(workspace), incomplete: false };
      case "antigravity":
        return this.#antigravity.list(workspace);
      case "deepseek-harness":
        // Workers without a bridge list nothing rather than a stale or partial set.
        return this.dsh ? this.dsh.list(workspace) : { sessions: [], incomplete: false };
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
          agent === "codex"
            ? this.#codex
            : agent === "claude-code"
              ? this.#claude
              : agent === "grok-build"
                ? this.#grok
                : agent === "open-claw"
                  ? this.#openclaw
                  : this.#hermes;
        const listing =
          agent === "codex"
            ? this.#codex.list(workspace, { matches: selection.matches })
            : provider.list(workspace);
        return {
          sessions: listing.sessions.map(withDirectory),
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
    if (collection) {
      if (agent !== "codex") throw new Error("Conversation provider is unavailable");
      const source = this.#codex
        .list(null, {
          collection,
          matches: (nativeRef) => this.store.id(agent, nativeRef) === id,
        })
        .sessions.find(
          (candidate) =>
            candidate.collection === collection &&
            this.store.id(agent, candidate.session.native_ref) === id,
        );
      if (!source) throw new Error("Conversation transcript is no longer available");
      return {
        summary,
        native: source.session,
        workspace: source.cwd,
        transcript: source.transcript,
      };
    }
    const workspace = this.store.workspacePath(summary.workspace_id);
    if (agent === "codex" || agent === "claude-code") {
      // Resolve ownership and the transcript together for this request. Readers
      // still check the file itself, and the next request discovers it afresh.
      const listing =
        agent === "codex"
          ? // Classify and read the header of this one thread, not every thread in the folder.
            this.#codex.list(workspace, {
              matches: (nativeRef) => this.store.id(agent, nativeRef) === id,
            })
          : this.#claude.list(workspace);
      const source = listing.sessions.find(
        (candidate) => this.store.id(agent, candidate.session.native_ref) === id,
      );
      if (!source) throw new Error("Conversation transcript is no longer available");
      return {
        summary,
        native: { ...source.session, cwd: source.cwd },
        workspace,
        transcript: source.transcript,
      };
    }
    const listing = await this.list(agent as SessionAgent, workspace);
    const native = listing.sessions.find(
      (candidate) => this.store.id(agent, candidate.native_ref) === id,
    );
    if (!native) throw new Error("Conversation transcript is no longer available");
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
  async image(sessionId: string, imageId: string) {
    try {
      return await this.#image(sessionId, imageId);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("session-image-")) throw error;
      throw new Error("session-image-unavailable");
    }
  }
  async #image(sessionId: string, imageId: string) {
    if (this.store.get(sessionId)?.agent === "claude-code") {
      const source = this.verifiedClaudeReadSource(sessionId);
      const result = await this.#readImage(
        source.native,
        source.workspace,
        imageId,
        source.transcript,
      );
      const current = this.verifiedClaudeReadSource(sessionId);
      if (
        current.nativeId !== source.nativeId ||
        current.workspaceId !== source.workspaceId ||
        pathIdentity(current.workspace) !== pathIdentity(source.workspace)
      )
        throw new Error("session-image-unavailable");
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
      throw new Error("session-image-unavailable");
    return result;
  }
  async imageForNative(
    agent: SessionAgent,
    nativeRef: string,
    workspace: string,
    imageId: string,
    options?: { codexDirectory: string },
  ) {
    if (!nativeRef || nativeRef.length > 4096) throw new Error("invalid-request");
    if (options) {
      if (agent !== "codex") throw new Error("invalid-request");
      const cwd = canonicalize(options.codexDirectory);
      if (!lstatSync(cwd).isDirectory() || !within(cwd, canonicalize(workspace)))
        throw new Error("session-workspace-mismatch");
      const verify = () => {
        const identity = this.verifiedCodexControlDirectory(nativeRef);
        if (
          !identity ||
          identity.id !== nativeRef.toLowerCase() ||
          pathIdentity(canonicalize(identity.cwd)) !== pathIdentity(cwd)
        )
          throw new Error("unverified-session-identity");
      };
      verify();
      const source = this.#codex
        .list(null, { matches: (ref) => ref.toLowerCase() === nativeRef.toLowerCase() })
        .sessions.find(
          (candidate) =>
            candidate.session.native_ref.toLowerCase() === nativeRef.toLowerCase() &&
            candidate.session.origin !== "auxiliary",
        );
      if (!source) throw new Error("session-image-unavailable");
      const result = await this.#readImage(source.session, workspace, imageId, source.transcript);
      verify();
      return result;
    }
    if (agent === "claude-code") {
      const source = this.#verifiedClaudeControlSource(nativeRef, workspace);
      const result = await this.#readImage(source.session, workspace, imageId, source.transcript);
      this.#verifiedClaudeControlSource(nativeRef, workspace);
      return result;
    }
    throw new Error("session-image-unavailable");
  }
  #imageScope(native: NativeSession, workspace: string) {
    return JSON.stringify([
      native.agent,
      native.native_ref.toLowerCase(),
      pathIdentity(recordedDirectory(workspace).path),
    ]);
  }
  async #readImage(native: NativeSession, workspace: string, imageId: string, transcript?: string) {
    // DSH keeps its images in its own store and reads them for the session that refers to them.
    if (native.agent === "deepseek-harness") {
      if (!this.dsh) throw new Error("session-image-unavailable");
      return this.dsh.image(native.native_ref, imageId);
    }
    if (!transcript || (native.agent !== "codex" && native.agent !== "claude-code"))
      throw new Error("session-image-unavailable");
    const file = native.agent === "codex" ? await codexRollouts.plain(transcript) : transcript;
    return this.#paging.image(file, imageId, this.#imageScope(native, workspace));
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
      throw new Error("invalid-request");
    if (options) {
      if (agent !== "codex") throw new Error("invalid-request");
      const cwd = canonicalize(options.codexDirectory);
      if (!lstatSync(cwd).isDirectory() || !within(cwd, canonicalize(workspace)))
        throw new Error("session-workspace-mismatch");
      const verify = () => {
        const identity = this.verifiedCodexControlDirectory(nativeRef);
        if (
          !identity ||
          identity.id !== nativeRef.toLowerCase() ||
          pathIdentity(canonicalize(identity.cwd)) !== pathIdentity(cwd)
        )
          throw new Error("unverified-session-identity");
      };
      verify();
      const source = this.#codex
        .list(null, { matches: (ref) => ref.toLowerCase() === nativeRef.toLowerCase() })
        .sessions.find(
          (candidate) =>
            candidate.session.native_ref.toLowerCase() === nativeRef.toLowerCase() &&
            candidate.session.origin !== "auxiliary",
        );
      if (!source) throw new Error("session-unavailable");
      const page = await this.#readEvents(
        { ...source.session, cwd },
        workspace,
        cursor,
        limit,
        source.transcript,
        retain,
        options.imageScanBudget,
      );
      verify();
      return page;
    }
    if (agent === "claude-code") {
      const source = this.#verifiedClaudeControlSource(nativeRef, workspace);
      return this.#readEvents(source.session, workspace, cursor, limit, source.transcript, retain);
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
    switch (agent) {
      case "codex":
      case "claude-code": {
        // Pages seek backwards, so a compressed Codex rollout is read from a
        // decompressed copy with the same offsets.
        const page = async (file: string) =>
          this.#paging.read(
            agent === "codex" ? await codexRollouts.plain(file) : file,
            offset,
            count,
            agent,
            // Collections pass an ID here; only an absolute root shortens paths.
            { workspace, cwd: native.cwd ?? workspace },
            retain,
            this.#imageScope(native, workspace),
            imageScanBudget,
          );
        if (transcript) return page(transcript);
        const provider = agent === "codex" ? this.#codex : this.#claude;
        const source = provider
          .list(null)
          .sessions.find((value) => value.session.native_ref === ref);
        if (!source)
          throw new Error(
            agent === "codex"
              ? "Codex session is no longer available"
              : "Claude session is no longer available",
          );
        return page(source.transcript);
      }
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
      case "antigravity":
        return this.#antigravity.readEvents(ref, offset, count);
      case "cursor":
        return ref.startsWith("cursor-ide-v1-")
          ? this.#cursorIde.events(ref, workspace, offset, count)
          : this.#cursor.events(ref, offset, count);
      case "deepseek-harness":
        if (!this.dsh) throw new Error("Conversation provider is unavailable");
        return this.dsh.events(ref, offset, count);
      default:
        throw new Error("Conversation provider is unavailable");
    }
  }
  /** `options` only change how Claude Code sources are read; every other source ignores them. */
  async document(sessionId: string, options?: DocumentOptions): Promise<SessionDocument> {
    const summary = this.store.get(sessionId);
    if (!summary) throw new Error("Conversation metadata is no longer available");
    // DSH history comes from the running DSH through its plugin, which the handoff read worker
    // cannot reach, so it is read here even during a handoff.
    if (summary.agent === "deepseek-harness") {
      if (summary.availability !== "readable")
        throw new Error("Conversation transcript is no longer available");
      if (!this.dsh) throw new Error("Conversation provider is unavailable");
      const { native } = await this.resolve(sessionId);
      const document = await this.dsh.document(
        native.native_ref,
        {
          agent: "deepseek-harness",
          workspace_id: summary.workspace_id,
          title: summary.title,
          created_at: summary.created_at,
          updated_at: summary.updated_at,
          git_branch: summary.git_branch,
        },
        options,
      );
      if (handoffActive()) {
        handoffCheckpoint();
        if (JSON.stringify(this.store.get(sessionId)) !== JSON.stringify(summary))
          throw new Error("Conversation ownership changed while reading history");
      }
      return document;
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
    if (native.agent === "codex") {
      if (!transcript) throw new Error("Codex session is no longer available");
      return readCodexDocument(
        summary as Parameters<typeof readCodexDocument>[0],
        await codexRollouts.plain(transcript),
      );
    }
    if (native.agent === "claude-code") {
      if (!transcript) throw new Error("Claude session is no longer available");
      return readClaudeDocument(
        summary as Parameters<typeof readClaudeDocument>[0],
        transcript,
        native.sidechain,
        options,
      );
    }
    if (native.agent === "opencode")
      return this.#opencode.readDocument(workspace, native.native_ref, {
        ...summary,
        agent: native.agent,
      });
    if (native.agent === "antigravity")
      return this.#antigravity.readDocument(native.native_ref, { ...summary, agent: native.agent });
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
