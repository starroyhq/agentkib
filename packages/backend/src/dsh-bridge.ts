import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  DSH_BRIDGE_PATHS,
  DSH_BRIDGE_PLUGIN_VERSION,
  dshBridgeCompatibility,
  type DshBridgeCommand,
  type DshBridgeHistoryPage,
  type DshBridgeHistoryRecord,
  type DshBridgeInteraction,
  type DshBridgeServices,
  type DshBridgeSessionState,
  type DshBridgeSessionSummary,
  type SessionStreamEvent,
} from "@agentkib/runtime-protocol";
import { acquirePortableFileLease } from "./managed-session-lock";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
  readUnknownManagedCommands,
  replayManagedCommand,
} from "./managed-ledger";
import { sanitizeSessionText } from "./session-handoff";
import type { ConversationEvent, ConversationEventPage } from "./session-events";
import type { NativeSession } from "./session-store";

const MAX_BODY = 8 * 1024 * 1024;
const OFFLINE_MS = 45_000;
/** A plugin that drops its poll and does not poll again this soon has gone (DSH quit). */
const DISCONNECT_GRACE_MS = 3_000;
const POLL_MS = 20_000;
const HISTORY_TIMEOUT_MS = 15_000;
/** History read in this run, served while no DSH can be asked. Memory only. */
const PAGE_CACHE_CHARS = 16 * 1024 * 1024;
/** How often a session with unconfirmed commands asks its DSH again. */
const RECONCILE_INTERVAL_MS = 10_000;
/** After this long, a command DSH shows no trace of, and no longer works on, did not run. */
const RECONCILE_GIVE_UP_MS = 2 * 60_000;
const MAX_RUNTIMES = 8;
const CATALOG_LIMIT = 4096;
const CURSOR_PREFIX = "dsh-v1:";
export const DSH_EXECUTION_MODE = "dsh-follower";
const LOCAL_OWNER = "agentkib-local-owner";

const uuid = z.string().uuid();
const nativeIdSchema = z.string().min(1).max(256);
const catalogRowSchema = z
  .object({
    id: nativeIdSchema,
    cwd: z.string().min(1).max(4096),
    title: z.string().max(1024).nullable(),
    updatedAt: z.number().int().nonnegative().nullable(),
    parentSessionId: z.string().max(256).nullable(),
    origin: z.literal("subagent").nullable(),
  })
  .strict();
type CatalogRow = z.infer<typeof catalogRowSchema>;

const summarySchema = z
  .object({
    sessionId: nativeIdSchema,
    cwd: z.string().min(1).max(4096),
    title: z.string().max(1024).nullable(),
    updatedAt: z.number().int().nonnegative().nullable(),
    running: z.boolean(),
    live: z.boolean(),
    blank: z.boolean(),
    parentSessionId: z.string().max(256).nullable(),
    origin: z.literal("subagent").nullable(),
  })
  .strip();
const stateSchema = z
  .object({
    sessionId: nativeIdSchema,
    live: z.boolean(),
    status: z.enum(["idle", "running"]),
    turn: z.number().int().nonnegative().nullable(),
    cursor: z.number().int().min(-1),
    queue: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            placement: z.enum(["queued", "steering"]),
            text: z.string().max(8192),
            rpcId: z.string().max(256).nullable(),
          })
          .strip(),
      )
      .max(64),
    streamText: z.string().max(256 * 1024),
    streamTruncated: z.boolean(),
    pending: z.number().int().nonnegative().max(64),
  })
  .strip();
const questionSchema = z
  .object({
    id: z.string().min(1).max(256),
    question: z.string().max(8192),
    header: z.string().max(512).nullable(),
    detail: z
      .string()
      .max(128 * 1024)
      .nullable(),
    multiSelect: z.boolean(),
    options: z
      .array(
        z.object({ label: z.string().max(1024), description: z.string().max(2048).nullable() }),
      )
      .max(32),
    intent: z
      .union([
        z.object({ kind: z.literal("plan-review"), approve: z.string().max(1024) }).strip(),
        z
          .object({
            kind: z.literal("approval"),
            approve: z.string().max(1024),
            reject: z.string().max(1024),
            always: z.string().max(1024).optional(),
          })
          .strip(),
      ])
      .nullable(),
  })
  .strip();
const interactionSchema = z.union([
  z
    .object({
      id: uuid,
      sessionId: nativeIdSchema,
      createdAt: z.number().int().nonnegative(),
      kind: z.literal("approval"),
      toolName: z.string().max(512),
      callId: z.string().max(256).nullable(),
      reason: z.string().max(8192).nullable(),
      displayReason: z.record(z.string().max(32), z.string().max(8192)).nullable(),
      arguments: z.string().max(8192).nullable(),
    })
    .strip(),
  z
    .object({
      id: uuid,
      sessionId: nativeIdSchema,
      createdAt: z.number().int().nonnegative(),
      kind: z.literal("question"),
      questions: z.array(questionSchema).min(1).max(8),
    })
    .strip(),
]);
const servicesSchema = z
  .object({
    sessionController: z.boolean(),
    sessionQuery: z.boolean(),
    approvals: z.boolean(),
    questions: z.boolean(),
  })
  .strip();
const registerSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    protocol: z.number(),
    pluginVersion: z.string().max(64),
    dshVersion: z.string().max(64),
    runtimeId: uuid,
    pid: z.number().int().positive(),
    services: servicesSchema,
  })
  .strip();
const reportSchema = z
  .object({
    token: z.string().regex(/^[a-f0-9]{64}$/),
    services: servicesSchema.optional(),
    sessions: z.array(summarySchema).max(CATALOG_LIMIT).optional(),
    states: z.array(stateSchema).max(512).optional(),
    interactions: z.array(interactionSchema).max(64).optional(),
    historyChanged: z.array(nativeIdSchema).max(512).optional(),
  })
  .strip();
const resultSchema = z
  .object({
    token: z.string().regex(/^[a-f0-9]{64}$/),
    commandId: uuid,
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().max(256).optional(),
  })
  .strip();

type Command = DshBridgeCommand;
type CommandWaiter = {
  command: Command;
  delivered: boolean;
  settle(result: { ok: boolean; value?: unknown; error?: string; outcome?: "timeout" }): void;
  timer: ReturnType<typeof setTimeout>;
  onDelivered?: () => void;
};
type Runtime = {
  token: string;
  runtimeId: string;
  dshVersion: string;
  pluginVersion: string;
  pid: number;
  services: DshBridgeServices;
  lastSeen: number;
  summaries: Map<string, DshBridgeSessionSummary>;
  states: Map<string, DshBridgeSessionState>;
  interactions: Map<string, DshBridgeInteraction>;
  queue: Command[];
  waiting?: () => void;
  commands: Map<string, CommandWaiter>;
};
type Inflight = { requestId: string; commandId: string; runtime: string };

export interface DshBridgeOptions {
  dataDir: string;
  bootId: string;
  /** Unpacked plugin directory shipped with the application; shown in install instructions. */
  pluginDirectory: string;
  /** Per-user file where plugins find this Runtime; the key rotates with every start. */
  discoveryFile?: string;
  platform?: NodeJS.Platform;
  /** The AgentKib session ID for one native DSH session. */
  sessionId(nativeId: string): string;
  /** The innermost registered workspace containing `cwd`, or null. */
  workspaceFor(cwd: string): { id: string; path: string } | null;
  /** DSH sessions or the runtimes serving them changed in these workspaces; refresh listings. */
  sessionsChanged(workspaceIds: string[]): void;
  publish(
    sessionId: string,
    type: SessionStreamEvent["type"],
    payload: Record<string, unknown>,
    live: Record<string, unknown>,
  ): void;
  commandTimeoutMs?: number;
  disconnectGraceMs?: number;
  reconcileIntervalMs?: number;
  reconcileGiveUpMs?: number;
}

function privatePath(value: string, directory = false): void {
  if (!path.isAbsolute(value) || path.normalize(value) !== value)
    throw new Error("unsafe-dsh-bridge-path");
  for (let current = value; ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error("unsafe-dsh-bridge-path");
    if (path.dirname(current) === current) break;
  }
  if (directory) {
    mkdirSync(value, { recursive: true, mode: 0o700 });
    const stat = lstatSync(value);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
      throw new Error("unsafe-dsh-bridge-owner");
    chmodSync(value, 0o700);
  }
}
function privateJson(file: string, value: unknown): void {
  privatePath(path.dirname(file), true);
  privatePath(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const digest = (value: string) => createHash("sha256").update(value).digest();
const canonical = (value: string) => {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};
const within = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
const turnIdOf = (turn: number | null | undefined) =>
  typeof turn === "number" ? `dsh-turn-${turn}` : null;
/** Messages waiting for the next turn. Steering is already part of the running turn. */
const queuedFor = (state: DshBridgeSessionState | null | undefined) =>
  (state?.queue ?? []).filter((item) => item.placement === "queued");
/** The reason a control was refused before it reached DSH. */
const preflightReason = (error: unknown) =>
  error instanceof z.ZodError
    ? "invalid-managed-control"
    : error instanceof Error
      ? error.message
      : "control-unavailable";
/** What a control is decided on; streamed text and the history cursor are progress. */
const controlView = (state: DshBridgeSessionState | null | undefined) =>
  state
    ? {
        live: state.live,
        status: state.status,
        turn: state.turn,
        queue: state.queue,
        pending: state.pending,
      }
    : null;
const iso = (time: number | null) =>
  typeof time === "number" && Number.isFinite(time) ? new Date(time).toISOString() : null;

class BridgeHttpError extends Error {
  constructor(
    readonly status: number,
    code: string,
  ) {
    super(code);
  }
}

/**
 * Converts one page of DSH history records into conversation items. Tool calls pair with their
 * results by call ID; injected context and hidden reasoning never reach this point.
 */
export function dshConversationEvents(
  records: readonly DshBridgeHistoryRecord[],
): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  const calls = new Map<string, { name: string; index: number }>();
  let turn: number | null = null;
  const base = (record: DshBridgeHistoryRecord) => ({
    timestamp: iso(record.time),
    tool_name: null,
    tool_status: null,
    duration_ms: null,
    attachment_count: 0,
    truncated: false,
  });
  for (const record of records) {
    switch (record.kind) {
      case "turn-start":
        turn = record.turn;
        break;
      case "turn-end":
        turn = null;
        break;
      case "user":
        events.push({
          ...base(record),
          id: `dsh:${record.seq}`,
          kind: "user-message",
          ...(turnIdOf(turn) ? { turn_id: turnIdOf(turn)! } : {}),
          content: sanitizeSessionText(record.text, { value: 0 }),
          attachment_count: record.images + record.files,
          truncated: record.truncated,
        });
        break;
      case "assistant":
        events.push({
          ...base(record),
          id: `dsh:${record.seq}`,
          kind: "agent-message",
          ...(turnIdOf(record.turn) ? { turn_id: turnIdOf(record.turn)! } : {}),
          content: sanitizeSessionText(record.text, { value: 0 }),
          truncated: record.truncated,
        });
        break;
      case "tool-call": {
        calls.set(record.callId, { name: record.name, index: events.length });
        events.push({
          ...base(record),
          id: `dsh-tool:${record.callId}`,
          kind: "tool-summary",
          ...(turnIdOf(record.turn) ? { turn_id: turnIdOf(record.turn)! } : {}),
          content: null,
          tool_name: sanitizeSessionText(record.name, { value: 0 }),
          tool_status: "running",
        });
        break;
      }
      case "tool-result": {
        const call = calls.get(record.callId);
        const item: ConversationEvent = {
          ...base(record),
          id: `dsh-tool:${record.callId}`,
          kind: "tool-summary",
          ...(turnIdOf(record.turn) ? { turn_id: turnIdOf(record.turn)! } : {}),
          content: record.preview ? sanitizeSessionText(record.preview, { value: 0 }) : null,
          tool_name: call ? sanitizeSessionText(call.name, { value: 0 }) : null,
          tool_status: record.isError ? "failed" : "completed",
          truncated: record.truncated,
        };
        if (call) events[call.index] = { ...item, timestamp: events[call.index]!.timestamp };
        else events.push(item);
        break;
      }
    }
  }
  return events;
}

/**
 * A borrowed DeepSeek Harness execution host. Every DSH process with the AgentKib plugin
 * registers here; closing this broker never signals a DSH process.
 */
export class DshBridge {
  readonly root: string;
  #runtimes = new Map<string, Runtime>();
  #catalog = new Map<string, CatalogRow>();
  /** Canonical working directories, resolved once per row instead of on every listing. */
  #cwds = new Map<string, string>();
  #ids = new Map<string, string>();
  #revisions = new Map<string, number>();
  #inflight = new Map<string, Inflight>();
  #answered = new Map<string, { by: "native" | "agentkib" | "cancelled"; at: number }>();
  /** Pages by `<session>\n<cursor>`, oldest first. */
  #pages = new Map<string, { page: ConversationEventPage; chars: number }>();
  #pageChars = 0;
  /** Sessions whose history was answered without a DSH; they read again once one serves them. */
  #servedOffline = new Set<string>();
  /** Native sessions with commands of unknown outcome, asked about again while DSH runs. */
  #unknownSessions = new Set<string>();
  /** When this run first saw each unconfirmed request. */
  #unknownSince = new Map<string, number>();
  #reconciledAt = new Map<string, number>();
  #reconciling = new Set<string>();
  #server?: Server;
  #listening?: Promise<void>;
  #socketPath?: string;
  #socketDirectory?: string;
  #releaseLock?: () => void;
  #closed = false;
  #startupFailed = false;
  #revision = 0;
  #saveTimer?: ReturnType<typeof setTimeout>;
  #timer: ReturnType<typeof setInterval>;
  readonly #key = randomBytes(32).toString("hex");

  constructor(readonly options: DshBridgeOptions) {
    this.root = path.join(options.dataDir, "dsh-bridge");
    const file = path.join(this.root, "sessions-v1.json");
    try {
      privatePath(file);
      if (existsSync(file)) {
        const stat = lstatSync(file);
        if (
          stat.isFile() &&
          stat.size <= MAX_BODY &&
          (!process.getuid || stat.uid === process.getuid())
        ) {
          const rows = z
            .object({
              version: z.literal(1),
              sessions: z.array(catalogRowSchema).max(CATALOG_LIMIT),
            })
            .strict()
            .parse(JSON.parse(readFileSync(file, "utf8")));
          for (const row of rows.sessions) this.#remember(row);
        }
      }
    } catch {
      // A damaged cache only loses offline listings; online plugins report them again.
      this.#catalog.clear();
      this.#cwds.clear();
      this.#ids.clear();
    }
    this.#timer = setInterval(() => {
      for (const runtime of [...this.#runtimes.values()])
        if (Date.now() - runtime.lastSeen > OFFLINE_MS) this.#drop(runtime);
      for (const nativeId of this.#unknownSessions) this.#autoReconcile(nativeId);
    }, 5_000);
    this.#timer.unref();
  }

  get supported(): boolean {
    return (this.options.platform ?? process.platform) === "darwin";
  }
  initialize(): void {
    if (this.supported) void this.#listen().catch(() => (this.#startupFailed = true));
  }

  // ---- catalog ----------------------------------------------------------------------------

  #remember(row: CatalogRow): void {
    if (this.#catalog.get(row.id)?.cwd !== row.cwd) this.#cwds.set(row.id, canonical(row.cwd));
    this.#catalog.set(row.id, row);
    this.#ids.set(this.options.sessionId(row.id), row.id);
  }
  #saveCatalog(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      try {
        const rows = [...this.#catalog.values()]
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          .slice(0, CATALOG_LIMIT);
        privateJson(path.join(this.root, "sessions-v1.json"), { version: 1, sessions: rows });
      } catch {
        // The live listing still works; only offline listing is affected.
      }
    }, 500);
    this.#saveTimer.unref();
  }
  /** The native DSH session behind an AgentKib session ID. */
  nativeId(sessionId: string): string | undefined {
    return this.#ids.get(sessionId);
  }
  handles(sessionId: string): boolean {
    return this.#ids.has(sessionId);
  }
  #online(): Runtime[] {
    return [...this.#runtimes.values()].filter(
      (runtime) => Date.now() - runtime.lastSeen <= OFFLINE_MS,
    );
  }
  /**
   * Sessions whose working directory lies in this registered workspace. Subagents stay out.
   * A DSH session keeps its history while DSH is closed, so it stays readable; its live state
   * says when no DSH can serve or continue it.
   */
  list(workspace: string): { sessions: NativeSession[]; incomplete: boolean } {
    const root = canonical(workspace);
    const sessions: NativeSession[] = [];
    for (const row of this.#catalog.values()) {
      if (row.origin === "subagent" || !within(this.#cwds.get(row.id) ?? row.cwd, root)) continue;
      const updated = row.updatedAt === null ? null : new Date(row.updatedAt).toISOString();
      sessions.push({
        native_ref: row.id,
        agent: "deepseek-harness",
        title: row.title,
        created_at: null,
        updated_at: updated,
        message_count: null,
        git_branch: null,
        archived: false,
        sidechain: false,
        availability: "readable",
        origin: "interactive",
        spawned_by_session_id: null,
        forked_from_session_id: row.parentSessionId
          ? this.options.sessionId(row.parentSessionId)
          : null,
        cwd: row.cwd,
      });
    }
    return { sessions, incomplete: false };
  }
  #workspaceIds(nativeIds: Iterable<string>): string[] {
    const ids = new Set<string>();
    for (const id of nativeIds) {
      const row = this.#catalog.get(id);
      const workspace = row ? this.options.workspaceFor(row.cwd) : null;
      if (workspace) ids.add(workspace.id);
    }
    return [...ids];
  }

  // ---- history ----------------------------------------------------------------------------

  /** One page, newest first in paging order; each page is chronological. */
  async events(
    nativeId: string,
    cursor: string | null,
    limit: number,
  ): Promise<ConversationEventPage> {
    if (cursor !== null && !cursor.startsWith(CURSOR_PREFIX))
      throw new Error("TRANSCRIPT_CURSOR_STALE");
    const before = cursor === null ? undefined : Number(cursor.slice(CURSOR_PREFIX.length));
    if (before !== undefined && !Number.isSafeInteger(before))
      throw new Error("TRANSCRIPT_CURSOR_STALE");
    const runtime =
      this.#controlRuntime(nativeId) ??
      this.#online().find((candidate) => candidate.services.sessionQuery);
    const key = `${nativeId}\n${cursor ?? ""}`;
    if (!runtime) {
      // No DSH to ask: show what this run already read. A session not read yet shows no history
      // and its live state says DSH is not running; an older page never read cannot be shown.
      const cached = this.#pages.get(key);
      if (!cached && cursor !== null) throw new Error("dsh-runtime-offline");
      this.#servedOffline.add(nativeId);
      return cached?.page ?? { events: [], next_cursor: null, warnings: [] };
    }
    const result = await this.#command(
      runtime,
      {
        commandId: randomUUID(),
        type: "history",
        sessionId: nativeId,
        ...(before !== undefined ? { before } : {}),
        limit: Math.min(Math.max(limit, 1), 100),
      },
      HISTORY_TIMEOUT_MS,
    );
    if (!result.ok)
      throw new Error(
        result.error === "timeout" ? "dsh-history-timeout" : "dsh-history-unavailable",
      );
    const page = result.value as DshBridgeHistoryPage;
    if (!page || !Array.isArray(page.records) || page.sessionId !== nativeId)
      throw new Error("dsh-history-unavailable");
    const history: ConversationEventPage = {
      events: dshConversationEvents(page.records),
      next_cursor:
        typeof page.nextBefore === "number" ? `${CURSOR_PREFIX}${page.nextBefore}` : null,
      warnings: [],
    };
    this.#cachePage(key, history);
    return history;
  }
  #cachePage(key: string, page: ConversationEventPage): void {
    const previous = this.#pages.get(key);
    if (previous) {
      this.#pages.delete(key);
      this.#pageChars -= previous.chars;
    }
    const chars = JSON.stringify(page).length;
    if (chars > PAGE_CACHE_CHARS) return;
    this.#pages.set(key, { page, chars });
    this.#pageChars += chars;
    for (const [oldest, entry] of this.#pages) {
      if (this.#pageChars <= PAGE_CACHE_CHARS) break;
      this.#pages.delete(oldest);
      this.#pageChars -= entry.chars;
    }
  }

  // ---- runtimes ---------------------------------------------------------------------------

  /** The runtime running this session, else the only connected runtime that can resume it. */
  #controlRuntime(nativeId: string): Runtime | null {
    const online = this.#online();
    const running = online
      .filter(
        (runtime) => runtime.states.get(nativeId)?.live || runtime.summaries.get(nativeId)?.live,
      )
      .sort((a, b) => b.lastSeen - a.lastSeen)[0];
    if (running) return running;
    const resumable = online.filter((runtime) => runtime.services.sessionController);
    return resumable.length === 1 ? resumable[0]! : null;
  }
  #state(nativeId: string): {
    runtime: Runtime | null;
    state: DshBridgeSessionState | null;
    ambiguous: boolean;
  } {
    const runtime = this.#controlRuntime(nativeId);
    const ambiguous =
      !runtime &&
      this.#online().filter((candidate) => candidate.services.sessionController).length > 1;
    return { runtime, state: runtime?.states.get(nativeId) ?? null, ambiguous };
  }
  #interactions(nativeId: string): DshBridgeInteraction[] {
    const runtime = this.#controlRuntime(nativeId);
    return runtime
      ? [...runtime.interactions.values()].filter((item) => item.sessionId === nativeId)
      : [];
  }
  #touch(nativeId: string): void {
    this.#revisions.set(nativeId, ++this.#revision);
  }
  #publish(nativeId: string, history = false, queue = false): void {
    if (!this.#catalog.has(nativeId)) return;
    const id = this.options.sessionId(nativeId);
    const live = this.live(id, true);
    this.options.publish(id, "state", live, live);
    // Streaming changes the state many times a second; readers of the queue refetch only here.
    const domains = [...(history ? ["history"] : []), ...(queue ? ["queue"] : [])];
    if (domains.length) this.options.publish(id, "invalidate", { domains }, live);
  }
  #drop(runtime: Runtime): void {
    if (!this.#runtimes.delete(runtime.token)) return;
    runtime.waiting?.();
    for (const waiter of runtime.commands.values()) {
      clearTimeout(waiter.timer);
      waiter.settle({
        ok: false,
        error: waiter.delivered ? "unknown" : "not-dispatched",
        outcome: "timeout",
      });
    }
    runtime.commands.clear();
    const affected = new Set([...runtime.summaries.keys(), ...runtime.states.keys()]);
    for (const id of affected) {
      this.#touch(id);
      this.#publish(id);
    }
    // With no runtime left, every listed DSH session can only be read from this run's history.
    this.options.sessionsChanged(
      this.#workspaceIds(this.#online().length ? affected : this.#catalog.keys()),
    );
  }

  #apply(runtime: Runtime, report: z.infer<typeof reportSchema>): string[] {
    const changed = new Set<string>();
    // Sessions whose control state changed. A control carries the revision it was decided on, so
    // streamed text, titles and history progress, which change many times a second, never bump
    // it; otherwise a queue or steer sent while DSH streams would always look stale.
    const revised = new Set<string>();
    const historyChanged = new Set(report.historyChanged ?? []);
    let listChanged = false;
    if (report.services) runtime.services = report.services;
    if (report.sessions) {
      const next = new Map(report.sessions.map((row) => [row.sessionId, row]));
      for (const id of new Set([...runtime.summaries.keys(), ...next.keys()])) {
        const before = runtime.summaries.get(id);
        const after = next.get(id);
        if (stable(before) === stable(after)) continue;
        changed.add(id);
        if (!before || !after || before.live !== after.live) revised.add(id);
      }
      runtime.summaries = next;
      for (const row of report.sessions) {
        const cached: CatalogRow = {
          id: row.sessionId,
          cwd: row.cwd,
          title: row.title,
          updatedAt: row.updatedAt,
          parentSessionId: row.parentSessionId,
          origin: row.origin,
        };
        if (stable(this.#catalog.get(row.sessionId)) !== stable(cached)) {
          this.#remember(cached);
          listChanged = true;
        }
      }
      if (listChanged) this.#saveCatalog();
      // History shown without a DSH may be stale or empty; read it again from this one.
      if (runtime.services.sessionQuery)
        for (const id of runtime.summaries.keys())
          if (this.#servedOffline.delete(id)) historyChanged.add(id);
    }
    const queueChanged = new Set<string>();
    for (const state of report.states ?? []) {
      const previous = runtime.states.get(state.sessionId);
      if (stable(previous) === stable(state)) continue;
      if (stable(queuedFor(previous)) !== stable(queuedFor(state)))
        queueChanged.add(state.sessionId);
      if (stable(controlView(previous)) !== stable(controlView(state)))
        revised.add(state.sessionId);
      runtime.states.set(state.sessionId, state);
      changed.add(state.sessionId);
    }
    if (report.interactions) {
      const next = new Map(
        report.interactions.map((item) => [item.id, item as DshBridgeInteraction]),
      );
      for (const [id, item] of runtime.interactions)
        if (!next.has(id)) {
          if (!this.#answered.has(id)) this.#answered.set(id, { by: "native", at: Date.now() });
          changed.add(item.sessionId);
          revised.add(item.sessionId);
        }
      for (const item of next.values())
        if (!runtime.interactions.has(item.id)) {
          changed.add(item.sessionId);
          revised.add(item.sessionId);
        }
      runtime.interactions = next;
      for (const [id, entry] of this.#answered)
        if (Date.now() - entry.at > 10 * 60_000) this.#answered.delete(id);
    }
    for (const id of new Set([...changed, ...historyChanged])) {
      if (revised.has(id)) this.#touch(id);
      this.#publish(id, historyChanged.has(id), queueChanged.has(id));
    }
    // Every report, heartbeats included, is a chance to settle what is still unconfirmed.
    for (const nativeId of this.#unknownSessions) this.#autoReconcile(nativeId);
    if (listChanged)
      this.options.sessionsChanged(
        this.#workspaceIds(changed.size ? changed : runtime.summaries.keys()),
      );
    return [...runtime.summaries.keys()].filter((id) => {
      const row = this.#catalog.get(id);
      return !!row && row.origin !== "subagent" && !!this.options.workspaceFor(row.cwd);
    });
  }

  #command(
    runtime: Runtime,
    command: Command,
    timeoutMs = this.options.commandTimeoutMs ?? 12_000,
    onDelivered?: () => void,
  ): Promise<{ ok: boolean; value?: unknown; error?: string; outcome?: "timeout" }> {
    return new Promise((resolve) => {
      const waiter: CommandWaiter = {
        command,
        delivered: false,
        onDelivered,
        settle: (result) => {
          runtime.commands.delete(command.commandId);
          resolve(result);
        },
        timer: setTimeout(() => {
          const index = runtime.queue.indexOf(command);
          if (index >= 0) runtime.queue.splice(index, 1);
          waiter.settle({
            ok: false,
            error: waiter.delivered ? "unknown" : "not-dispatched",
            outcome: "timeout",
          });
        }, timeoutMs),
      };
      waiter.timer.unref();
      runtime.commands.set(command.commandId, waiter);
      runtime.queue.push(command);
      runtime.waiting?.();
    });
  }

  // ---- live projection --------------------------------------------------------------------

  live(id: string, controls: boolean): Record<string, unknown> {
    const nativeId = this.#ids.get(id);
    if (!nativeId) throw new Error("session-unavailable");
    const row = this.#catalog.get(nativeId)!;
    const workspace = this.options.workspaceFor(row.cwd);
    const { runtime, state, ambiguous } = this.#state(nativeId);
    const online = !!runtime;
    const interactions = this.#interactions(nativeId);
    const unknown = readUnknownManagedCommands(this.options.dataDir, id).length > 0;
    // Also covers requests left unconfirmed by an earlier run of AgentKib.
    if (unknown) this.#unknownSessions.add(nativeId);
    const inflight = this.#inflight.get(id);
    const controller = runtime?.services.sessionController === true;
    const running = state?.live === true && state.status === "running";
    const approval = interactions.find((item) => item.kind === "approval");
    const question = interactions.find((item) => item.kind === "question");
    const compatibility = runtime ? dshBridgeCompatibility(runtime.dshVersion) : null;
    const reason = !workspace
      ? "session-workspace-unavailable"
      : unknown
        ? "control-outcome-unconfirmed"
        : !online
          ? ambiguous
            ? "dsh-runtime-ambiguous"
            : "dsh-runtime-offline"
          : !controller
            ? "dsh-session-controller-unavailable"
            : approval
              ? "dsh-approval-pending"
              : question
                ? "dsh-question-pending"
                : undefined;
    const controllable = controls && online && controller && !!workspace && !unknown && !inflight;
    const turnId = running ? turnIdOf(state!.turn) : null;
    const status = unknown
      ? "outcome-unknown"
      : !online
        ? "unsupported"
        : approval
          ? "awaiting-approval"
          : question
            ? "waiting-input"
            : running
              ? "running"
              : "idle";
    const queue = queuedFor(state);
    return {
      sessionId: id,
      sourceSessionId: nativeId,
      workspaceId: workspace?.id ?? null,
      runtimeBootId: this.options.bootId,
      executionMode: DSH_EXECUTION_MODE,
      executionLocation: online ? "external" : null,
      ownershipReason: null,
      connectionGeneration: runtime ? runtime.runtimeId : this.options.bootId,
      cliVersion: runtime ? `${runtime.dshVersion} (DeepSeek Harness)` : undefined,
      bridgeCompatibility:
        runtime &&
        (compatibility === "verified" ||
          compatibility === "unverified" ||
          compatibility === "unknown")
          ? { cliVersion: runtime.dshVersion, status: compatibility }
          : null,
      revision: this.#revisions.get(nativeId) ?? 0,
      status,
      reason,
      turnId,
      sendEnabled: controllable && !running && !approval && !question,
      steerEnabled: controllable && running && !!turnId,
      queueEnabled: controllable && running,
      // Not tied to a non-empty queue: clients refetch capabilities on status changes, not when
      // DSH's own client queues a message. Each edit checks that its item still waits.
      queueEditEnabled: controllable,
      queuedCount: queue.length,
      stopEnabled: controls && online && controller && !unknown && running && !!turnId,
      approvals: approval
        ? interactions
            .filter((item) => item.kind === "approval")
            .map((item) =>
              this.#approval(
                item as Extract<DshBridgeInteraction, { kind: "approval" }>,
                turnId,
                controls && online && controller,
              ),
            )
        : [],
      questions: interactions
        .filter((item) => item.kind === "question")
        .map((item) =>
          this.#question(
            item as Extract<DshBridgeInteraction, { kind: "question" }>,
            turnId,
            controls && online && controller,
          ),
        ),
      streamText: running ? sanitizeSessionText(state?.streamText ?? "", { value: 0 }) : "",
      streamTextTruncated: running && state?.streamTruncated === true,
      usage: { available: false, state: "unavailable", reason: "usage-unavailable" },
    };
  }
  #approval(
    item: Extract<DshBridgeInteraction, { kind: "approval" }>,
    turnId: string | null,
    enabled: boolean,
  ) {
    let input: unknown = item.arguments;
    try {
      input = item.arguments ? JSON.parse(item.arguments) : null;
    } catch {
      // Show the raw arguments text.
    }
    return {
      requestId: item.id,
      turnId: turnId ?? "dsh-turn-unknown",
      method: "dsh/approval",
      toolName: item.toolName,
      input,
      command: {
        tool: item.toolName,
        ...(item.reason ? { reason: item.reason } : {}),
        ...(input !== null ? { arguments: input } : {}),
      },
      context: item.displayReason ? { description: item.displayReason } : undefined,
      availableDecisions: ["accept", "decline"],
      supported: enabled,
      unsupportedReason: enabled ? null : "dsh-handle-in-native-ui",
    };
  }
  #question(
    item: Extract<DshBridgeInteraction, { kind: "question" }>,
    turnId: string | null,
    enabled: boolean,
  ) {
    return {
      requestId: item.id,
      turnId: turnId ?? "dsh-turn-unknown",
      method: "dsh/question",
      supported: enabled,
      unsupportedReason: enabled ? null : "dsh-handle-in-native-ui",
      questions: item.questions.map((question) => {
        const options = question.options.map((option) => ({
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        }));
        if (question.intent?.kind === "approval" && question.intent.always)
          options.push({ label: question.intent.always });
        return {
          id: question.id,
          ...(question.header ? { header: question.header } : {}),
          question: question.detail
            ? `${question.question}\n\n${question.detail}`
            : question.question,
          options,
          multiSelect: question.multiSelect,
          // DSH accepts free text unless the question is a fixed approval card.
          allowCustom: question.intent?.kind !== "approval",
        };
      }),
    };
  }

  capabilities(id: string, controls: boolean): Record<string, unknown> {
    const live = this.live(id, controls);
    const online = live.executionLocation === "external";
    const flags: Record<string, boolean> = {
      send: live.sendEnabled === true,
      stop: live.stopEnabled === true,
      steer: live.steerEnabled === true,
      approve: (live.approvals as unknown[]).length > 0 && controls && online,
      answer: (live.questions as unknown[]).length > 0 && controls && online,
      inspect: true,
      usage: false,
      context: false,
      files: false,
      reconcile: true,
      adopt: false,
      release: false,
      attachments: false,
      resources: false,
      settings: false,
      "settings-state": false,
      queue: live.queueEnabled === true,
      "queue-list": online,
      "queue-add": live.queueEnabled === true,
      "queue-update": live.queueEditEnabled === true,
      "queue-delete": live.queueEditEnabled === true,
      // Moves a waiting message into the running turn, as DSH's own "steer" on a queued item.
      "queue-steer": live.queueEditEnabled === true && live.steerEnabled === true,
      "queue-reorder": false,
      "queue-resume": false,
      "queue-pause": false,
      fork: false,
      rename: false,
      archive: false,
      unarchive: false,
      goal: false,
      "goal-set": false,
      "goal-pause": false,
      "goal-resume": false,
      "goal-clear": false,
    };
    return {
      sessionId: id,
      executionMode: DSH_EXECUTION_MODE,
      status: live.status,
      reason: live.reason,
      features: Object.fromEntries(
        Object.entries(flags).map(([key, available]) => [
          key,
          available
            ? { available: true }
            : {
                available: false,
                reason:
                  key === "attachments"
                    ? "dsh-attachments-unavailable"
                    : ((live.reason as string | undefined) ?? "operation-unavailable"),
              },
        ]),
      ),
    };
  }

  async request(value: Record<string, unknown>): Promise<unknown> {
    const id = z.string().min(1).max(256).parse(value.sessionId);
    const nativeId = this.#ids.get(id);
    if (!nativeId) throw new Error("session-unavailable");
    const controls = value.experimentalEnabled === true;
    switch (value.operation) {
      case "live":
        return this.live(id, controls);
      case "capabilities":
        return this.capabilities(id, controls);
      case "inspect":
        return {
          sessionId: id,
          sourceSessionId: nativeId,
          workspaceId: this.options.workspaceFor(this.#catalog.get(nativeId)!.cwd)?.id ?? null,
          live: this.live(id, controls),
          reconciled: false,
        };
      case "usage":
        return { available: false, state: "unavailable", reason: "usage-unavailable" };
      case "context":
        return {
          available: true,
          cwd: this.#catalog.get(nativeId)!.cwd,
          projectId: null,
          branchAtCreation: null,
        };
      case "queue-list":
        return this.#queueList(id, nativeId);
      case "reconcile":
        return this.#reconcile(id, nativeId, controls);
      case "send":
      case "steer":
      case "queue-add":
      case "queue-update":
      case "queue-delete":
      case "queue-steer":
      case "stop":
      case "approve":
      case "answer":
        return this.#control(value, id, nativeId);
      default:
        throw new Error("operation-unavailable");
    }
  }
  #queueList(id: string, nativeId: string): Record<string, unknown> {
    const live = this.live(id, false);
    const { state } = this.#state(nativeId);
    return {
      available: true,
      revision: live.revision,
      paused: false,
      requiresResume: false,
      reason: null,
      data: queuedFor(state).map((item) => ({
        id: item.id,
        kind: "queue",
        input: [{ type: "text", text: item.text }],
        status: "pending",
        createdAt: null,
        requiresAttachments: false,
      })),
      nextCursor: null,
    };
  }
  /** Asks the running DSH about this session's unconfirmed commands, at most once an interval. */
  #autoReconcile(nativeId: string): void {
    const now = Date.now();
    const interval = this.options.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS;
    if (
      this.#reconciling.has(nativeId) ||
      now - (this.#reconciledAt.get(nativeId) ?? 0) < interval ||
      !this.#controlRuntime(nativeId) ||
      !this.#catalog.has(nativeId)
    )
      return;
    this.#reconciledAt.set(nativeId, now);
    this.#reconciling.add(nativeId);
    void this.#reconcile(this.options.sessionId(nativeId), nativeId, true)
      .catch(() => undefined)
      .finally(() => this.#reconciling.delete(nativeId));
  }
  /**
   * Settle commands whose result never came back. A sent message carries its request ID into
   * DSH's record, so finding it means accepted; once DSH no longer works on it and enough time
   * passed, its absence means it never ran. Other controls leave no record: long overdue, the
   * state they act on tells. Every later control is checked against the current state, so
   * ending a wait this way cannot repeat an action, and nothing is ever resent.
   */
  async #reconcile(id: string, nativeId: string, controls: boolean) {
    const runtime = this.#controlRuntime(nativeId);
    const unknown = readUnknownManagedCommands(this.options.dataDir, id);
    const giveUp = this.options.reconcileGiveUpMs ?? RECONCILE_GIVE_UP_MS;
    let reconciled = false;
    const settle = (requestId: string, outcome: "accepted" | "not-dispatched", reason?: string) => {
      finishManagedCommand(
        this.options.dataDir,
        requestId,
        this.#result(id, requestId, outcome, reason),
      );
      this.#unknownSince.delete(requestId);
      reconciled = true;
    };
    for (const command of unknown) {
      // A command still waiting for its result is not unconfirmed yet.
      if (!runtime || this.#inflight.get(id)?.requestId === command.requestId) continue;
      const evidence = command.evidence ?? {};
      const operation = String(evidence.operation);
      const since = this.#unknownSince.get(command.requestId) ?? Date.now();
      this.#unknownSince.set(command.requestId, since);
      const overdue = Date.now() - since >= giveUp;
      if (["send", "steer", "queue-add"].includes(operation)) {
        const result = await this.#command(runtime, {
          commandId: randomUUID(),
          type: "verify",
          sessionId: nativeId,
          requestId: command.requestId,
        });
        const found = result.ok
          ? (result.value as { present?: boolean; inFlight?: boolean } | null)
          : null;
        if (found?.present === true) settle(command.requestId, "accepted");
        else if (found?.present === false && found.inFlight !== true && overdue)
          settle(command.requestId, "not-dispatched", "dsh-message-not-recorded");
        continue;
      }
      if (!overdue) continue;
      const state = this.#state(nativeId).state;
      const applied = ["queue-delete", "queue-update", "queue-steer"].includes(operation)
        ? !queuedFor(state).some((item) => item.id === evidence.itemId)
        : operation === "stop"
          ? !(state?.status === "running" && turnIdOf(state.turn) === evidence.turnId)
          : ["approve", "answer"].includes(operation)
            ? !this.#interactions(nativeId).some((item) => item.id === evidence.interactionId)
            : false;
      settle(
        command.requestId,
        applied ? "accepted" : "not-dispatched",
        applied ? undefined : "control-outcome-expired",
      );
    }
    if (!readUnknownManagedCommands(this.options.dataDir, id).length) {
      this.#unknownSessions.delete(nativeId);
      this.#reconciledAt.delete(nativeId);
    }
    if (reconciled) {
      this.#touch(nativeId);
      this.#publish(nativeId, true);
      // Clients fencing these requests read their receipts again.
      this.options.publish(id, "invalidate", { domains: ["receipts"] }, this.live(id, controls));
    }
    return {
      accepted: false,
      completed: false,
      reconciled,
      sessionId: id,
      live: this.live(id, controls),
      reason: readUnknownManagedCommands(this.options.dataDir, id).length
        ? "control-outcome-unconfirmed"
        : undefined,
    };
  }
  receipt(value: unknown): unknown {
    if (
      !value ||
      typeof value !== "object" ||
      (value as { executionMode?: unknown }).executionMode !== DSH_EXECUTION_MODE
    )
      return value;
    const result = value as Record<string, unknown>;
    return {
      ...result,
      completionObserved: (result.ack as Record<string, unknown> | undefined)?.completed === true,
    };
  }
  /** Revoked device authorization also fences commands not yet delivered to the plugin. */
  invalidate(deviceId?: string, sessionId?: string): void {
    void deviceId;
    for (const runtime of this.#runtimes.values())
      for (const waiter of runtime.commands.values()) {
        if (waiter.delivered) continue;
        const command = waiter.command as { sessionId?: string };
        if (
          sessionId &&
          command.sessionId &&
          this.options.sessionId(command.sessionId) !== sessionId
        )
          continue;
        const index = runtime.queue.indexOf(waiter.command);
        if (index >= 0) runtime.queue.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.settle({ ok: false, error: "not-dispatched" });
      }
  }

  #result(
    id: string,
    requestId: string,
    outcome: string,
    reason?: string,
  ): Record<string, unknown> {
    return {
      accepted: outcome === "accepted",
      completed: false,
      requestId,
      sessionId: id,
      runtimeBootId: this.options.bootId,
      controlOutcome: outcome,
      ...(outcome === "unknown"
        ? { reason: "control-outcome-unconfirmed" }
        : reason
          ? { reason }
          : {}),
      live: this.live(id, true),
    };
  }

  async #control(
    value: Record<string, unknown>,
    id: string,
    nativeId: string,
  ): Promise<Record<string, unknown>> {
    const allowed = new Set([
      "operation",
      "sessionId",
      "requestId",
      "deviceId",
      "runtimeBootId",
      "expectedRevision",
      "experimentalEnabled",
      "text",
      "input",
      "turnId",
      "queuedSubmissionId",
      "approvalId",
      "decision",
      "nativeDecision",
      "questionId",
      "answers",
      "publicInputHash",
      "historyInputHash",
      "historyReferences",
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key)))
      throw new Error("invalid-managed-control");
    const requestId = uuid.parse(value.requestId);
    const deviceId = z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_:-]+$/)
      .parse(value.deviceId);
    const revision = z.number().safe().int().nonnegative().parse(value.expectedRevision);
    const fingerprint = digest(stable({ ...value, runtimeBootId: undefined })).toString("hex");
    const replay = replayManagedCommand(this.options.dataDir, requestId, fingerprint);
    if (replay) return replay;
    const prepare = () => {
      if (
        this.#closed ||
        !this.supported ||
        value.experimentalEnabled !== true ||
        value.runtimeBootId !== this.options.bootId
      )
        throw new Error("control-unavailable");
      const live = this.live(id, true);
      const runtime = this.#controlRuntime(nativeId);
      if (!runtime || live.executionLocation !== "external") throw new Error("dsh-runtime-offline");
      if (revision !== live.revision) throw new Error("stale-dsh-revision");
      if (this.#inflight.has(id)) throw new Error("session-busy");
      const text = (): string => {
        const input = value.text ?? value.input;
        if (
          typeof input !== "string" ||
          !input.trim() ||
          input.length > 16_000 ||
          Buffer.byteLength(input) > 16_384
        )
          throw new Error("invalid-text-input");
        return input;
      };
      const commandId = randomUUID();
      let command: Command;
      switch (value.operation) {
        case "send":
          if (live.sendEnabled !== true) throw new Error("session-busy");
          command = {
            commandId,
            type: "prompt",
            sessionId: nativeId,
            requestId,
            mode: "queue",
            text: text(),
          };
          break;
        case "queue-add":
          if (live.queueEnabled !== true) throw new Error("session-busy");
          command = {
            commandId,
            type: "prompt",
            sessionId: nativeId,
            requestId,
            mode: "queue",
            text: text(),
          };
          break;
        case "steer":
          if (live.steerEnabled !== true || value.turnId !== live.turnId)
            throw new Error("stale-turn");
          command = {
            commandId,
            type: "prompt",
            sessionId: nativeId,
            requestId,
            mode: "steer",
            text: text(),
          };
          break;
        case "queue-delete":
        case "queue-update":
        case "queue-steer": {
          if (live.queueEditEnabled !== true) throw new Error("session-busy");
          if (value.operation === "queue-steer" && live.steerEnabled !== true)
            throw new Error("stale-turn");
          const itemId = z.string().min(1).max(256).parse(value.queuedSubmissionId);
          if (!queuedFor(this.#state(nativeId).state).some((item) => item.id === itemId))
            throw new Error("queue-item-unavailable");
          command = {
            commandId,
            type: "queue",
            sessionId: nativeId,
            itemId,
            action:
              value.operation === "queue-delete"
                ? { kind: "remove" }
                : value.operation === "queue-steer"
                  ? { kind: "steer" }
                  : { kind: "edit", text: text() },
          };
          break;
        }
        case "stop":
          if (live.stopEnabled !== true || value.turnId !== live.turnId)
            throw new Error("stale-turn");
          command = { commandId, type: "cancel", sessionId: nativeId };
          break;
        case "approve": {
          const approval = this.#interactions(nativeId).find(
            (item) => item.kind === "approval" && item.id === value.approvalId,
          );
          if (!approval)
            throw new Error(
              this.#answered.has(String(value.approvalId))
                ? "interaction-answered-elsewhere"
                : "approval-unavailable",
            );
          const decision = value.nativeDecision ?? value.decision;
          if (decision !== "accept" && decision !== "decline") throw new Error("invalid-decision");
          command = {
            commandId,
            type: "answer",
            interactionId: approval.id,
            value: { outcome: decision === "accept" ? "allowed-once" : "rejected" },
          };
          break;
        }
        case "answer": {
          const question = this.#interactions(nativeId).find(
            (item) => item.kind === "question" && item.id === value.questionId,
          ) as Extract<DshBridgeInteraction, { kind: "question" }> | undefined;
          if (!question)
            throw new Error(
              this.#answered.has(String(value.questionId))
                ? "interaction-answered-elsewhere"
                : "question-unavailable",
            );
          const answers = z
            .record(z.string(), z.array(z.string().max(16_000)).max(32))
            .parse(value.answers);
          command = {
            commandId,
            type: "answer",
            interactionId: question.id,
            value: {
              answers: question.questions.map((item) => {
                const values = answers[item.id] ?? [];
                const labels = new Set(item.options.map((option) => option.label));
                if (item.intent?.kind === "approval" && item.intent.always)
                  labels.add(item.intent.always);
                const selected = values.filter((entry) => labels.has(entry));
                const custom = values
                  .filter((entry) => !labels.has(entry))
                  .join("\n")
                  .trim();
                return { id: item.id, selected, ...(custom ? { custom } : {}) };
              }),
            },
          };
          break;
        }
        default:
          throw new Error("operation-unavailable");
      }
      return { live, runtime, command, commandId };
    };
    let prepared: ReturnType<typeof prepare>;
    try {
      prepared = prepare();
    } catch (error) {
      // Refused before anything reached DSH. Saying so keeps the client's draft and does not
      // fence the session as if the outcome were unknown.
      return this.#result(id, requestId, "not-dispatched", preflightReason(error));
    }
    const { live, runtime, command, commandId } = prepared;
    const evidence = {
      operation: value.operation,
      commandId,
      runtimeId: runtime.runtimeId,
      nativeId,
      workspaceId: live.workspaceId,
      runtimeBootId: this.options.bootId,
      expectedRevision: revision,
      turnId: value.turnId ?? null,
      executionMode: DSH_EXECUTION_MODE,
      ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
      ...(value.historyInputHash ? { historyInputHash: value.historyInputHash } : {}),
      // What an unconfirmed control acted on, for settling it from the state later.
      ...(command.type === "queue" ? { itemId: command.itemId } : {}),
      ...(command.type === "answer" ? { interactionId: command.interactionId } : {}),
    };
    const prior = claimManagedCommand(
      this.options.dataDir,
      requestId,
      id,
      fingerprint,
      deviceId,
      evidence,
    );
    if (prior) return prior;
    this.#inflight.set(id, { requestId, commandId, runtime: runtime.token });
    this.#touch(nativeId);
    this.#publish(nativeId);
    try {
      const result = await this.#command(runtime, command, undefined, () =>
        dispatchManagedCommand(this.options.dataDir, requestId),
      );
      this.#inflight.delete(id);
      let outcome: Record<string, unknown>;
      if (result.ok) {
        const found = (result.value as { found?: boolean } | null)?.found;
        if (command.type === "answer" && found === false) {
          this.#answered.set(command.interactionId, { by: "native", at: Date.now() });
          outcome = this.#result(id, requestId, "not-dispatched", "interaction-answered-elsewhere");
        } else {
          if (command.type === "answer")
            this.#answered.set(command.interactionId, { by: "agentkib", at: Date.now() });
          outcome = this.#result(id, requestId, "accepted");
        }
        finishManagedCommand(this.options.dataDir, requestId, outcome);
      } else if (result.error === "unknown") {
        // Delivered, but the plugin never reported back. Keep it unknown; never resend. The
        // running DSH is asked about it again until its record or state settles it.
        outcome = this.#result(id, requestId, "unknown");
        this.#unknownSessions.add(nativeId);
        this.#unknownSince.set(requestId, Date.now());
      } else {
        outcome = this.#result(id, requestId, "not-dispatched", result.error);
        finishManagedCommand(this.options.dataDir, requestId, outcome);
      }
      this.#touch(nativeId);
      this.#publish(nativeId, result.ok);
      const settled = { ...outcome, live: this.live(id, true) };
      // The stored result was built while this request still counted as unconfirmed, so its
      // snapshot says "outcome-unknown". A replay or a receipt would hand that to a client,
      // which would take it as the session's state.
      if (outcome.controlOutcome !== "unknown")
        finishManagedCommand(this.options.dataDir, requestId, settled);
      return settled;
    } finally {
      this.#inflight.delete(id);
    }
  }

  // ---- management -------------------------------------------------------------------------

  management(value: Record<string, unknown>): Record<string, unknown> {
    z.object({ operation: z.literal("dsh-bridge-status"), deviceId: z.literal(LOCAL_OWNER) })
      .strip()
      .parse(value);
    const runtimes = this.#online().map((runtime) => ({
      runtimeId: runtime.runtimeId,
      dshVersion: runtime.dshVersion,
      compatibility: dshBridgeCompatibility(runtime.dshVersion),
      pluginVersion: runtime.pluginVersion,
      sessionController: runtime.services.sessionController,
      sessions: runtime.summaries.size,
    }));
    const directory = this.options.pluginDirectory.replaceAll("'", "'\\''");
    return {
      supported: this.supported,
      listening: !!this.#server?.listening,
      reason: !this.supported
        ? "platform-unsupported"
        : this.#startupFailed
          ? "dsh-bridge-unavailable"
          : undefined,
      pluginVersion: DSH_BRIDGE_PLUGIN_VERSION,
      pluginDirectory: this.options.pluginDirectory,
      runtimes,
      installInstructions: [
        `dsh plugin --profile web add '${directory}'`,
        "# Restart DeepSeek Harness afterwards.",
      ].join("\n"),
    };
  }

  // ---- transport --------------------------------------------------------------------------

  async #listen(): Promise<void> {
    if (this.#closed) throw new Error("dsh-bridge-unavailable");
    if (this.#server?.listening) return;
    if (this.#listening) return this.#listening;
    this.#listening = (async () => {
      privatePath(this.root, true);
      this.#releaseLock = acquirePortableFileLease(path.join(this.root, "broker.lock"));
      const identity = digest(realpathSync(this.root)).toString("hex").slice(0, 20);
      const directory = path.join(
        realpathSync("/tmp"),
        `akdsh-${process.getuid?.() ?? 0}-${identity}`,
      );
      privatePath(directory, true);
      const socket = path.join(directory, "b.sock");
      if (Buffer.byteLength(socket) >= 104) throw new Error("dsh-bridge-socket-path-too-long");
      if (existsSync(socket)) {
        const stat = lstatSync(socket);
        if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid()))
          throw new Error("unsafe-dsh-bridge-socket");
        // The persistent file lease excludes another broker for this exact data directory.
        rmSync(socket);
      }
      const server = createServer((request, response) => void this.#http(request, response));
      server.requestTimeout = POLL_MS + 10_000;
      server.headersTimeout = 5_000;
      server.maxConnections = 64;
      this.#socketPath = socket;
      this.#socketDirectory = directory;
      this.#server = server;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, () => {
          server.off("error", reject);
          resolve();
        });
      });
      chmodSync(socket, 0o600);
      this.#startupFailed = false;
      const file = this.options.discoveryFile;
      if (file)
        try {
          privateJson(file, { protocol: 1, socketPath: socket, key: this.#key });
        } catch {
          // Without discovery the plugin cannot find this Runtime; status reports it.
          this.#startupFailed = true;
        }
    })()
      .catch((error) => {
        this.#startupFailed = true;
        this.#releaseLock?.();
        this.#releaseLock = undefined;
        throw error;
      })
      .finally(() => {
        this.#listening = undefined;
      });
    return this.#listening;
  }

  #runtimeFor(token: string): Runtime {
    const runtime = this.#runtimes.get(token);
    if (!runtime) throw new BridgeHttpError(401, "unknown-runtime");
    runtime.lastSeen = Date.now();
    return runtime;
  }

  async #http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, value: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    try {
      if (
        this.#closed ||
        request.method !== "POST" ||
        request.headers.host !== "localhost" ||
        request.headers.origin
      ) {
        reply(403, { error: "bridge-request-rejected" });
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const raw of request) {
        const chunk = Buffer.from(raw);
        bytes += chunk.length;
        if (bytes > MAX_BODY) {
          reply(413, { error: "bridge-body-too-large" });
          return;
        }
        chunks.push(chunk);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      switch (request.url) {
        case DSH_BRIDGE_PATHS.register: {
          const hello = registerSchema.parse(value);
          const expected = Buffer.from(this.#key);
          const actual = Buffer.from(hello.key);
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
            throw new BridgeHttpError(403, "invalid-key");
          if (hello.protocol !== 1 || hello.pluginVersion !== DSH_BRIDGE_PLUGIN_VERSION)
            throw new BridgeHttpError(409, "dsh-bridge-plugin-update-required");
          if (dshBridgeCompatibility(hello.dshVersion) === "too-old")
            throw new BridgeHttpError(409, "dsh-version-too-old");
          for (const runtime of [...this.#runtimes.values()])
            if (runtime.runtimeId === hello.runtimeId) this.#drop(runtime);
          if (this.#runtimes.size >= MAX_RUNTIMES)
            throw new BridgeHttpError(429, "dsh-bridge-busy");
          const first = this.#online().length === 0;
          const token = randomBytes(32).toString("hex");
          this.#runtimes.set(token, {
            token,
            runtimeId: hello.runtimeId,
            dshVersion:
              dshBridgeCompatibility(hello.dshVersion) === "invalid" ? "unknown" : hello.dshVersion,
            pluginVersion: hello.pluginVersion,
            pid: hello.pid,
            services: hello.services,
            lastSeen: Date.now(),
            summaries: new Map(),
            states: new Map(),
            interactions: new Map(),
            queue: [],
            commands: new Map(),
          });
          reply(200, { token, bootId: this.options.bootId });
          // Listings refresh their marks once a runtime can serve and continue these sessions.
          if (first) this.options.sessionsChanged(this.#workspaceIds(this.#catalog.keys()));
          return;
        }
        case DSH_BRIDGE_PATHS.report: {
          const report = reportSchema.parse(value);
          const runtime = this.#runtimeFor(report.token);
          reply(200, { watch: this.#apply(runtime, report) });
          return;
        }
        case DSH_BRIDGE_PATHS.poll: {
          const { token } = z.object({ token: z.string() }).strip().parse(value);
          const runtime = this.#runtimeFor(token);
          if (!runtime.queue.length)
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, POLL_MS);
              runtime.waiting = () => {
                clearTimeout(timer);
                resolve();
              };
              response.once("close", () => {
                clearTimeout(timer);
                resolve();
              });
            });
          runtime.waiting = undefined;
          if (response.destroyed) {
            // The plugin dropped its poll. A live one polls again at once; silence means DSH
            // quit, so its sessions stop showing as connected well before OFFLINE_MS.
            const seen = runtime.lastSeen;
            setTimeout(() => {
              if (this.#runtimes.get(runtime.token) === runtime && runtime.lastSeen === seen)
                this.#drop(runtime);
            }, this.options.disconnectGraceMs ?? DISCONNECT_GRACE_MS).unref();
            return;
          }
          if (!this.#runtimes.has(runtime.token)) return;
          const commands = runtime.queue.splice(0);
          for (const command of commands) {
            const waiter = runtime.commands.get(command.commandId);
            if (!waiter) continue;
            waiter.delivered = true;
            waiter.onDelivered?.();
          }
          runtime.lastSeen = Date.now();
          reply(200, { commands });
          return;
        }
        case DSH_BRIDGE_PATHS.result: {
          const result = resultSchema.parse(value);
          const runtime = this.#runtimeFor(result.token);
          const waiter = runtime.commands.get(result.commandId);
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.settle(
              result.ok
                ? { ok: true, value: result.value }
                : { ok: false, error: result.error ?? "error" },
            );
          }
          reply(200, { ok: true });
          return;
        }
        default:
          reply(404, { error: "not-found" });
      }
    } catch (error) {
      if (error instanceof BridgeHttpError) reply(error.status, { error: error.message });
      else reply(400, { error: "bridge-request-invalid" });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = undefined;
      try {
        privateJson(path.join(this.root, "sessions-v1.json"), {
          version: 1,
          sessions: [...this.#catalog.values()].slice(0, CATALOG_LIMIT),
        });
      } catch {
        // Offline listing only.
      }
    }
    await this.#listening?.catch(() => undefined);
    const file = this.options.discoveryFile;
    if (file)
      try {
        // Another AgentKib instance may own the file by now; remove only our own key.
        if (JSON.parse(readFileSync(file, "utf8"))?.key === this.#key)
          rmSync(file, { force: true });
      } catch {
        /* Missing or foreign discovery files are left alone. */
      }
    for (const runtime of [...this.#runtimes.values()]) this.#drop(runtime);
    const server = this.#server;
    this.#server = undefined;
    if (server) {
      const closing = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closing;
    }
    if (this.#socketPath) rmSync(this.#socketPath, { force: true });
    if (this.#socketDirectory && existsSync(this.#socketDirectory))
      rmdirSync(this.#socketDirectory);
    this.#releaseLock?.();
    this.#releaseLock = undefined;
  }
}
