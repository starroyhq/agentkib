import path from "node:path";
import { performance } from "node:perf_hooks";
import { resolveCommand } from "./command-resolution";
import { canonicalize, pathIdentity } from "./paths";
import { compareUtf8 } from "./workspaces";
import { sessionTitle } from "./codex-sessions";
import { hasText } from "./session-events";
import type { NativeSession } from "./session-store";
import { acpObject, acpTimestamp, stringifyAcpJson } from "./acp-json";
import { AntigravityAcp, type AcpId } from "./antigravity-acp";
import { AntigravityPaging } from "./antigravity-paging";
import { parseAntigravityReplay } from "./antigravity-replay";
import { finishDocument, type DocumentSource } from "./session-document-providers";
import type { SessionDocument } from "./session-model";

export interface AntigravitySession {
  id: string;
  workspace: string;
  title: string | null;
  created_at: string | null;
  updated_at: string | null;
}
function validateRef(value: string): void {
  if (!hasText(value) || Buffer.byteLength(value) > 4096 || /[\n\r\0]/.test(value))
    throw new Error("Invalid Antigravity native session reference");
}
export function parseAntigravitySession(value: unknown): AntigravitySession | null {
  const fields = acpObject(value);
  if (
    typeof fields.sessionId !== "string" ||
    typeof fields.cwd !== "string" ||
    !path.isAbsolute(fields.cwd)
  )
    throw new Error("Invalid Antigravity ACP session metadata");
  validateRef(fields.sessionId);
  let workspace: string;
  try {
    workspace = canonicalize(fields.cwd);
  } catch {
    return null;
  }
  return {
    id: fields.sessionId,
    workspace,
    title: sessionTitle(fields.title),
    created_at: acpTimestamp(fields.createdAt),
    updated_at: acpTimestamp(
      Object.hasOwn(fields, "updatedAt") ? fields.updatedAt : fields.lastActiveAt,
    ),
  };
}
/** Native history is listed and replayed only through a verified official ACP executable. */
export class AntigravitySessions {
  #clients = new Set<AntigravityAcp>();
  #closed = false;
  #paging = new AntigravityPaging({
    executable: () => this.#executable(),
    resolve: (ref, deadline) => this.resolve(ref, deadline),
    replay: (ref, deadline) => this.readReplay(ref, deadline),
  });
  constructor(
    readonly env: NodeJS.ProcessEnv = process.env,
    readonly executable?: string,
  ) {}
  close(): void {
    this.#closed = true;
    for (const client of this.#clients) client.shutdown();
    this.#clients.clear();
  }
  readEvents(nativeRef: string, cursor: string | null, limit: number) {
    return this.#paging.readEvents(nativeRef, cursor, limit);
  }
  async readHandoff(nativeRef: string) {
    const deadline = performance.now() + 15_000,
      { updates } = await this.readReplay(nativeRef, deadline),
      parsed = parseAntigravityReplay(updates, deadline);
    return {
      compact_summary: null,
      messages: parsed.events,
      omitted_tool_count: 0,
      warnings: parsed.warnings,
    };
  }
  async readDocument(nativeRef: string, source: DocumentSource): Promise<SessionDocument> {
    const deadline = performance.now() + 15_000,
      { session, updates } = await this.readReplay(nativeRef, deadline),
      parsed = parseAntigravityReplay(updates, deadline);
    return finishDocument(
      {
        ...source,
        title: parsed.title !== undefined ? parsed.title : (source.title ?? session.title),
        created_at: source.created_at ?? session.created_at,
        updated_at:
          parsed.updated_at !== undefined
            ? parsed.updated_at
            : (source.updated_at ?? session.updated_at),
      },
      parsed.turns,
      parsed.losses,
    );
  }
  optionalExecutable(): string | null {
    if (this.#closed) throw new Error("Antigravity session provider is closed");
    const explicit = this.executable ?? this.env.AGENTKIB_ANTIGRAVITY_ACP_BIN;
    if (explicit !== undefined) return this.#verifiedExecutable(explicit);
    for (const name of ["agy_acp_server.par", "agy_acp_server.exe"]) {
      const resolved = resolveCommand(name, this.env);
      if (resolved !== null) return this.#verifiedExecutable(resolved);
    }
    return null;
  }
  #verifiedExecutable(value: string): string {
    if (!path.isAbsolute(value))
      throw new Error("Antigravity ACP executable path must be absolute");
    if (resolveCommand(value, this.env) === null)
      throw new Error("Antigravity ACP executable is not a runnable regular file");
    return canonicalize(value);
  }
  #executable(): string {
    const executable = this.optionalExecutable();
    if (executable === null)
      throw new Error(
        "Antigravity ACP server is unavailable; set AGENTKIB_ANTIGRAVITY_ACP_BIN to the official absolute executable path",
      );
    return executable;
  }
  async list(
    workspace: string,
    deadline = performance.now() + 30_000,
  ): Promise<{ sessions: NativeSession[]; incomplete: boolean }> {
    const executable = this.optionalExecutable();
    if (executable === null) return { sessions: [], incomplete: true };
    const collected = await this.#collect(executable, workspace, deadline);
    return {
      incomplete: collected.incomplete,
      sessions: collected.sessions.map((session) => ({
        native_ref: session.id,
        agent: "antigravity",
        title: session.title,
        origin: "interactive",
        spawned_by_session_id: null,
        forked_from_session_id: null,
        created_at: session.created_at,
        updated_at: session.updated_at,
        message_count: null,
        git_branch: null,
        archived: false,
        sidechain: false,
        availability: collected.loadSession ? "readable" : "metadata-only",
      })),
    };
  }
  async resolve(
    nativeRef: string,
    deadline = performance.now() + 30_000,
  ): Promise<AntigravitySession> {
    validateRef(nativeRef);
    const collected = await this.#collect(this.#executable(), null, deadline),
      sessions = collected.sessions.filter((session) => session.id === nativeRef);
    if (sessions.length !== 1) throw new Error("Antigravity session is unavailable or ambiguous");
    return sessions[0]!;
  }
  async readReplay(
    nativeRef: string,
    deadline = performance.now() + 15_000,
  ): Promise<{ session: AntigravitySession; updates: Record<string, unknown>[] }> {
    const session = await this.resolve(nativeRef, deadline),
      client = await this.#connect(this.#executable(), session.workspace, deadline);
    try {
      if (!client.compatibility!.loadSession)
        throw new Error("Antigravity ACP does not support session/load");
      const request = await client.loadSession(session.id, session.workspace),
        replayDeadline = Math.min(deadline, performance.now() + 10_000),
        updates: Record<string, unknown>[] = [];
      let bytes = 0;
      for (let count = 0; count <= 100_000; count++) {
        const event = await this.#event(client, replayDeadline);
        if (event.type === "session-update") {
          if (event.sessionId !== nativeRef)
            throw new Error("Antigravity ACP replay session mismatch");
          bytes += Buffer.byteLength(stringifyAcpJson(event.update));
          if (bytes > 256 * 1024 * 1024) throw new Error("Antigravity ACP replay exceeds 256 MiB");
          updates.push(event.update);
        } else if (event.type === "response" && event.id === request) {
          if (event.method !== "session/load")
            throw new Error("Antigravity ACP load response method mismatch");
          if (event.error)
            throw new Error(`Antigravity ACP session/load failed: ${event.error.message}`);
          return { session, updates };
        } else if (
          ["permission", "permission-cancelled", "unsupported-request"].includes(event.type)
        ) {
          if (event.type === "permission")
            await client.respondPermission(event.id, null).catch(() => {});
          throw new Error("Antigravity ACP emitted an invalid event while loading history");
        }
      }
      throw new Error("Antigravity ACP replay exceeds the update limit");
    } finally {
      this.#release(client);
    }
  }
  async #collect(executable: string, workspace: string | null, deadline: number) {
    const filter = workspace === null ? null : canonicalize(workspace),
      cwd = filter ?? canonicalize(process.cwd()),
      client = await this.#connect(executable, cwd, deadline);
    try {
      if (!client.compatibility!.listSessions)
        throw new Error("Antigravity ACP does not support session/list");
      const sessions: AntigravitySession[] = [],
        seen = new Set<string>(),
        listDeadline = Math.min(deadline, performance.now() + 10_000);
      let cursor: string | null = null,
        incomplete = false;
      for (let page = 0; page < 100; page++) {
        const request = await client.listSessions(filter, cursor),
          response = acpObject(await this.#wait(client, request, "session/list", listDeadline));
        if (!Array.isArray(response.sessions))
          throw new Error("Antigravity ACP session/list response is missing sessions");
        for (const value of response.sessions) {
          let session: AntigravitySession | null;
          try {
            session = parseAntigravitySession(value);
          } catch {
            incomplete = true;
            continue;
          }
          if (session === null) {
            incomplete = true;
            continue;
          }
          if (filter !== null && pathIdentity(filter) !== pathIdentity(session.workspace)) continue;
          sessions.push(session);
          if (sessions.length > 10_000)
            throw new Error("Antigravity ACP session/list exceeds the session limit");
        }
        const next = response.nextCursor;
        if (next === null || next === undefined || next === "") {
          const unique = new Map<string, AntigravitySession>();
          for (const session of sessions) {
            const previous = unique.get(session.id);
            if (previous && pathIdentity(previous.workspace) !== pathIdentity(session.workspace))
              throw new Error("Antigravity ACP returned one session ID for multiple workspaces");
            unique.set(session.id, session);
          }
          return {
            sessions: [...unique.values()].sort((a, b) => compareUtf8(a.id, b.id)),
            incomplete,
            loadSession: client.compatibility!.loadSession,
          };
        }
        if (typeof next !== "string")
          throw new Error("Antigravity ACP session/list returned an invalid nextCursor");
        if (seen.has(next)) throw new Error("Antigravity ACP pagination cursor repeated");
        seen.add(next);
        cursor = next;
      }
      throw new Error("Antigravity ACP session/list exceeds the page limit");
    } finally {
      this.#release(client);
    }
  }
  async #connect(executable: string, cwd: string, deadline: number): Promise<AntigravityAcp> {
    const timeout = Math.min(10_000, deadline - performance.now());
    if (timeout <= 0) throw new Error("Antigravity ACP operation timed out before connection");
    const client = AntigravityAcp.spawn(executable, [], canonicalize(cwd), this.env, {
      timeout,
      deadline,
    });
    this.#clients.add(client);
    try {
      const request = await client.initialize();
      await this.#wait(
        client,
        request,
        "initialize",
        Math.min(deadline, performance.now() + 10_000),
      );
      return client;
    } catch (error) {
      this.#release(client);
      throw error;
    }
  }
  #release(client: AntigravityAcp): void {
    client.shutdown();
    this.#clients.delete(client);
  }
  async #event(client: AntigravityAcp, deadline: number) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Antigravity ACP operation timed out before its response");
    const event = await client.nextEvent(remaining);
    if (event === null) throw new Error("Antigravity ACP operation timed out before its response");
    return event;
  }
  async #wait(
    client: AntigravityAcp,
    request: AcpId,
    method: string,
    deadline: number,
  ): Promise<unknown> {
    for (let count = 0; count < 1024; count++) {
      const event = await this.#event(client, deadline);
      if (event.type === "response" && event.id === request) {
        if (event.method !== method) throw new Error("Antigravity ACP response method mismatch");
        if (event.error)
          throw new Error(`Antigravity ACP ${method} failed: ${event.error.message}`);
        return event.result;
      }
      if (["permission", "permission-cancelled", "unsupported-request"].includes(event.type)) {
        if (event.type === "permission")
          await client.respondPermission(event.id, null).catch(() => {});
        throw new Error("Antigravity ACP emitted an invalid event during a read-only operation");
      }
    }
    throw new Error("Antigravity ACP emitted too many events before its response");
  }
}
