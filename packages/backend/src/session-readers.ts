import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { sessionCollection } from "@agentkib/runtime-protocol";
import { CodexSessions } from "./codex-sessions";
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
import { readHermesEvents } from "./hermes-events";
import { readGrokDocument, readHermesDocument } from "./native-chat-documents";
import { SessionStore, type NativeSession } from "./session-store";
import { Commands } from "./commands";
import { parameters, optionalString, unsigned } from "./rpc";
import type { ConversationEventPage } from "./session-events";
import type { SessionDocument } from "./session-model";
import {
  readClaudeDocument,
  readCodexDocument,
  readEventDocument,
} from "./session-document-providers";
import { canonicalize, pathIdentity } from "./paths";

export const SESSION_AGENTS = [
  "codex",
  "claude-code",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
  "antigravity",
  "cursor",
] as const;
export type SessionAgent = (typeof SESSION_AGENTS)[number];
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
  constructor(
    readonly store: SessionStore,
    commands: Commands,
    env: NodeJS.ProcessEnv,
    cursorBridge: CursorBridge,
  ) {
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
  }
  verifiedCodexControlIds(nativeRefs: Iterable<string>): Set<string> {
    return this.#codex.verifiedControlIds(nativeRefs);
  }
  verifiedClaudeControlTarget(nativeRef: string, workspace: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeRef))
      throw new Error("unverified-session-identity");
    const sessionId = nativeRef.toLowerCase();
    const expectedWorkspace = canonicalize(workspace);
    const source = this.#claude
      .list(null)
      .sessions.find((candidate) => candidate.session.native_ref.toLowerCase() === sessionId);
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
    return transcript;
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
  async list(agent: SessionAgent, workspace: string): Promise<NativeListing> {
    const collection = sessionCollection(workspace);
    if (collection) {
      if (agent !== "codex") return { sessions: [], incomplete: false };
      const listing = this.#codex.list(null, { collection });
      return {
        sessions: listing.sessions.map((source) => source.session),
        incomplete: listing.incomplete,
      };
    }
    switch (agent) {
      case "opencode":
        return { sessions: await this.#opencode.list(workspace), incomplete: false };
      case "antigravity":
        return this.#antigravity.list(workspace);
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
        const listing = provider.list(workspace);
        return {
          sessions: listing.sessions.map((source) => source.session),
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
      const provider = agent === "codex" ? this.#codex : this.#claude;
      const source = provider
        .list(workspace)
        .sessions.find((candidate) => this.store.id(agent, candidate.session.native_ref) === id);
      if (!source) throw new Error("Conversation transcript is no longer available");
      return { summary, native: source.session, workspace, transcript: source.transcript };
    }
    const listing = await this.list(agent as SessionAgent, workspace);
    const native = listing.sessions.find(
      (candidate) => this.store.id(agent, candidate.native_ref) === id,
    );
    if (!native) throw new Error("Conversation transcript is no longer available");
    return { summary, native, workspace };
  }
  async events(value: unknown): Promise<ConversationEventPage> {
    const { sessionId, cursor, limit } = parameters(
      z.object({
        sessionId: z.string(),
        cursor: optionalString,
        limit: unsigned.nullable().optional(),
      }),
      value,
    );
    const { native, workspace, transcript } = await this.resolve(sessionId);
    return this.#readEvents(native, workspace, cursor ?? null, limit ?? 50, transcript);
  }
  async eventsForNative(
    agent: SessionAgent,
    nativeRef: string,
    workspace: string,
    cursor: string | null,
    limit: number,
  ): Promise<ConversationEventPage> {
    if (!nativeRef || nativeRef.length > 4096 || limit < 1 || limit > 100)
      throw new Error("invalid-request");
    const listing = await this.list(agent, workspace);
    const native = listing.sessions.find(
      (candidate) => candidate.native_ref === nativeRef && candidate.agent === agent,
    );
    if (!native) throw new Error("session-unavailable");
    return this.#readEvents(native, workspace, cursor, limit);
  }
  async #readEvents(
    native: NativeSession,
    workspace: string,
    offset: string | null,
    count: number,
    transcript?: string,
  ): Promise<ConversationEventPage> {
    const ref = native.native_ref,
      agent = native.agent;
    switch (agent) {
      case "codex":
      case "claude-code": {
        if (transcript) return this.#paging.read(transcript, offset, count, agent);
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
        return this.#paging.read(source.transcript, offset, count, agent);
      }
      case "grok-build":
        return this.#paging.read(this.#grok.resolve(ref).transcript, offset, count, agent);
      case "open-claw": {
        const source = this.#openclaw.resolve(ref);
        return source.sqlite
          ? readOpenClawSqliteEvents(source.sqlite, offset, count)
          : this.#paging.read(source.transcript, offset, count, agent);
      }
      case "hermes": {
        const { source } = this.#hermes.resolve(ref);
        return source.type === "sqlite"
          ? readHermesEvents(source.path, source.sessionId, offset, count)
          : this.#paging.read(source.path, offset, count, "hermes");
      }
      case "opencode":
        return this.#opencode.readEvents(workspace, ref, offset, count);
      case "antigravity":
        return this.#antigravity.readEvents(ref, offset, count);
      case "cursor":
        return ref.startsWith("cursor-ide-v1-")
          ? this.#cursorIde.events(ref, workspace, offset, count)
          : this.#cursor.events(ref, offset, count);
      default:
        throw new Error("Conversation provider is unavailable");
    }
  }
  async document(sessionId: string): Promise<SessionDocument> {
    const summary = this.store.get(sessionId);
    if (!summary) throw new Error("Conversation metadata is no longer available");
    if (summary.availability !== "readable")
      throw new Error("Conversation transcript is no longer available");
    if (!(SESSION_AGENTS as readonly string[]).includes(summary.agent))
      throw new Error("Conversation provider is unavailable");
    const { native, workspace, transcript } = await this.resolve(sessionId);
    if (native.agent === "codex") {
      if (!transcript) throw new Error("Codex session is no longer available");
      return readCodexDocument(summary as Parameters<typeof readCodexDocument>[0], transcript);
    }
    if (native.agent === "claude-code") {
      if (!transcript) throw new Error("Claude session is no longer available");
      return readClaudeDocument(
        summary as Parameters<typeof readClaudeDocument>[0],
        transcript,
        native.sidechain,
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
