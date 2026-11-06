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
  type DshBridgePromptPart,
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
import { decodedSessionImage, sessionImageResult } from "./session-images";
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
    // Absent in caches written before archive support.
    archived: z.boolean().optional(),
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
    archived: z.boolean().optional(),
  })
  .strip();
const modelPartSchema = z.string().min(1).max(128);
const selectionSchema = z
  .object({
    provider: modelPartSchema,
    model: modelPartSchema,
    reasoningEffort: modelPartSchema.nullable(),
  })
  .strip();
const modelsSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            provider: modelPartSchema,
            providerName: z.string().max(128),
            model: modelPartSchema,
            name: z.string().max(256),
            efforts: z
              .array(z.object({ id: modelPartSchema, name: z.string().max(128) }).strip())
              .max(16),
            defaultEffort: modelPartSchema.nullable(),
          })
          .strip(),
      )
      .max(64),
    default: selectionSchema.nullable(),
    selected: selectionSchema.nullable(),
  })
  .strip();
type DshModels = z.infer<typeof modelsSchema>;
/**
 * One DSH model as a single picker ID. Both parts are URI-encoded, so a "/" inside a provider or
 * model name cannot be mistaken for the separator.
 */
const modelId = (provider: string, model: string) =>
  `${encodeURIComponent(provider)}/${encodeURIComponent(model)}`;
function parseModelId(value: unknown): { provider: string; model: string } | null {
  if (typeof value !== "string") return null;
  const index = value.indexOf("/");
  if (index <= 0 || index === value.length - 1) return null;
  try {
    return {
      provider: decodeURIComponent(value.slice(0, index)),
      model: decodeURIComponent(value.slice(index + 1)),
    };
  } catch {
    return null;
  }
}
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
            images: z.number().int().nonnegative().max(64),
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
    workspaceController: z.boolean().optional(),
    modelCatalog: z.boolean().optional(),
    images: z.boolean().optional(),
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
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
/** A message with attachments, as the Host's attachment store builds it for DSH. */
const promptContentSchema = z
  .array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string().max(16_384) }).strict(),
      z
        .object({
          type: z.literal("image"),
          path: z
            .string()
            .min(1)
            .max(4096)
            .refine((value) => path.isAbsolute(value)),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          size: z
            .number()
            .int()
            .positive()
            .max(25 * 1024 * 1024),
          mediaType: z.enum(IMAGE_TYPES),
          name: z.string().min(1).max(255),
        })
        .strict(),
    ]),
  )
  .min(1)
  .max(32);
/** One image a history record names; anything else is dropped rather than shown. */
const historyImageSchema = z
  .object({
    attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    mediaType: z.enum(IMAGE_TYPES),
    name: z.string().max(255).nullable(),
  })
  .strip();
const IMAGE_ID_PREFIX = "dsh-image-v1-";

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
  /** When this runtime last reported its session list; 0 before the first. */
  listedAt: number;
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
  /** The root of a registered workspace, where a new DSH session starts; null if unknown. */
  workspacePath?(workspaceId: string): string | null;
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
      case "user": {
        // Each image is read on demand through the session (`DshBridge.image`), as other
        // agents' history images are; the ID names DSH's stored copy.
        const images = new Map<string, NonNullable<ConversationEvent["images"]>[number]>();
        for (const value of Array.isArray(record.images) ? record.images : []) {
          const image = historyImageSchema.safeParse(value);
          if (!image.success) continue;
          const id = IMAGE_ID_PREFIX + image.data.attachmentId.slice("sha256:".length);
          const name = image.data.name?.replace(/[\p{Cc}\p{Cf}]/gu, "");
          images.set(id, { id, mimeType: image.data.mediaType, ...(name ? { name } : {}) });
        }
        events.push({
          ...base(record),
          id: `dsh:${record.seq}`,
          kind: "user-message",
          ...(turnIdOf(turn) ? { turn_id: turnIdOf(turn)! } : {}),
          content: sanitizeSessionText(record.text, { value: 0 }),
          attachment_count: images.size + record.files,
          ...(images.size ? { images: [...images.values()] } : {}),
          truncated: record.truncated,
        });
        break;
      }
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
  /**
   * The model catalog last read for each session. A settings change always reads it first, so
   * the current model is known when only the reasoning effort changes.
   */
  #models = new Map<string, DshModels>();
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
        archived: row.archived === true,
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
  /**
   * One image a session's history shows, read from the DSH that has the session. DSH returns only
   * images the session's own log refers to; the ID is the digest of the stored bytes, so the
   * bytes are checked against it here.
   */
  async image(nativeId: string, imageId: string): Promise<{ mimeType: string; base64: string }> {
    const sha256 = imageId.startsWith(IMAGE_ID_PREFIX) ? imageId.slice(IMAGE_ID_PREFIX.length) : "";
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("session-image-invalid");
    const runtime =
      this.#controlRuntime(nativeId) ??
      this.#online().find((candidate) => candidate.services.images === true);
    if (runtime?.services.images !== true) throw new Error("session-image-unavailable");
    const result = await this.#command(
      runtime,
      {
        commandId: randomUUID(),
        type: "image",
        sessionId: nativeId,
        attachmentId: `sha256:${sha256}`,
      },
      HISTORY_TIMEOUT_MS,
    );
    if (!result.ok)
      throw new Error(
        result.error === "image-too-large"
          ? "session-image-too-large"
          : "session-image-unavailable",
      );
    const value = result.value as { mediaType?: unknown; data?: unknown } | null;
    if (typeof value?.data !== "string") throw new Error("session-image-unavailable");
    const bytes = decodedSessionImage(value.data);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256)
      throw new Error("session-image-changed");
    return sessionImageResult(
      bytes,
      typeof value.mediaType === "string" ? value.mediaType : undefined,
    );
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
      runtime.listedAt = Date.now();
      for (const row of report.sessions) {
        const cached: CatalogRow = {
          id: row.sessionId,
          cwd: row.cwd,
          title: row.title,
          updatedAt: row.updatedAt,
          parentSessionId: row.parentSessionId,
          origin: row.origin,
          ...(row.archived === true ? { archived: true } : {}),
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
    const inflight = this.#inflight.get(id);
    // A request still waiting for its reply makes the session busy, not unconfirmed. Also
    // covers requests left unconfirmed by an earlier run of AgentKib.
    const unknown = readUnknownManagedCommands(this.options.dataDir, id).some(
      (command) => command.requestId !== inflight?.requestId,
    );
    if (unknown) this.#unknownSessions.add(nativeId);
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
    const nativeId = this.#ids.get(id)!;
    const services = this.#state(nativeId).runtime?.services;
    // `live` reports this as queueEditEnabled: online, controllable and nothing unconfirmed.
    const controllable = live.queueEditEnabled === true;
    const idle = controllable && live.status === "idle";
    const archived = this.#catalog.get(nativeId)?.archived === true;
    const archivable = idle && services?.workspaceController === true;
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
      resources: false,
      // Images go with any message DSH takes now: sent, queued or added to the running turn.
      attachments:
        services?.images === true &&
        (live.sendEnabled === true || live.queueEnabled === true || live.steerEnabled === true),
      // Model and reasoning effort; a running turn keeps its model, so changes wait for idle.
      settings: idle && services?.modelCatalog === true,
      "settings-state": online && services?.modelCatalog === true,
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
      fork: controllable,
      rename: controllable,
      // DSH refuses to archive an active session rather than stop it; so does AgentKib.
      archive: archivable && !archived,
      unarchive: archivable && archived,
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
                  key === "attachments" && online && services?.images !== true
                    ? "dsh-attachments-unavailable"
                    : // Offered once the turn ends, so say that rather than "unavailable".
                      controllable &&
                        !idle &&
                        ((key === "settings" && services?.modelCatalog === true) ||
                          (["archive", "unarchive"].includes(key) &&
                            services?.workspaceController === true))
                      ? "session-busy"
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
      // Not offered yet, but answered: clients that open the goal panel read this first.
      case "goal":
        return {
          available: false,
          reason: "operation-unavailable",
          revision: this.live(id, controls).revision,
        };
      case "context":
        return {
          available: true,
          cwd: this.#catalog.get(nativeId)!.cwd,
          projectId: null,
          branchAtCreation: null,
        };
      case "queue-list":
        return this.#queueList(id, nativeId);
      case "settings-state":
        return this.#settingsState(id, nativeId);
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
      case "rename":
      case "archive":
      case "unarchive":
      case "fork":
      case "settings":
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
      data: queuedFor(state).map((item) => {
        // An attached file reaches DSH as its own line of text (see the Host's attachment store).
        // Listing those lines and the images, which are already in DSH, as their own inputs
        // marks the item as one with attachments; an edit would replace them with text only.
        const lines = item.text.split("\n");
        const note = (line: string) => line.startsWith("User attached file ");
        return {
          id: item.id,
          kind: "queue",
          input: [
            { type: "text", text: lines.filter((line) => !note(line)).join("\n") },
            ...lines.filter(note).map((text) => ({ type: "text", text })),
            ...Array.from({ length: item.images }, () => ({ type: "image" })),
          ],
          status: "pending",
          createdAt: null,
          requiresAttachments: false,
        };
      }),
      nextCursor: null,
    };
  }
  /** Whether a new session can start now: exactly one running DSH that can take it. */
  createOptions(): { available: boolean; reason?: string } {
    if (!this.supported) return { available: false, reason: "platform-unsupported" };
    const candidates = this.#online().filter((item) => item.services.sessionController);
    if (candidates.length === 1) return { available: true };
    // Not "dsh-runtime-ambiguous": that one asks to open an existing session in one of them.
    return {
      available: false,
      reason: candidates.length ? "dsh-create-ambiguous" : "dsh-runtime-offline",
    };
  }
  /**
   * Starts a DSH session in a registered workspace through the one running DSH that can. With
   * more than one, AgentKib cannot tell which the user means, so it asks them to pick in DSH.
   */
  async create(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = uuid.parse(value.requestId);
    const deviceId = z.string().min(1).max(256).parse(value.deviceId);
    const workspaceId = z.string().min(1).max(256).parse(value.workspaceId);
    const result = (outcome: string, extra: Record<string, unknown> = {}) =>
      this.#created(requestId, outcome, extra);
    const fingerprint = digest(stable({ ...value, runtimeBootId: undefined })).toString("hex");
    const replay = replayManagedCommand(this.options.dataDir, requestId, fingerprint);
    if (replay) return replay;
    let runtime: Runtime;
    let cwd: string;
    try {
      if (this.#closed || !this.supported) throw new Error("control-unavailable");
      const root = this.options.workspacePath?.(workspaceId) ?? null;
      if (!root) throw new Error("workspace-unavailable");
      cwd = root;
      const candidates = this.#online().filter((item) => item.services.sessionController);
      if (!candidates.length) throw new Error("dsh-runtime-offline");
      if (candidates.length > 1) throw new Error("dsh-create-ambiguous");
      runtime = candidates[0]!;
    } catch (error) {
      return result("not-dispatched", { reason: preflightReason(error) });
    }
    // DSH names a new session after the ID it is given, so the receipt carries the real session
    // and a reply that never comes back is settled by that session being listed or not.
    const nativeId = `session-${randomUUID()}`;
    const id = this.options.sessionId(nativeId);
    const commandId = randomUUID();
    const prior = claimManagedCommand(this.options.dataDir, requestId, id, fingerprint, deviceId, {
      operation: "create",
      commandId,
      runtimeId: runtime.runtimeId,
      workspaceId,
      nativeSessionId: nativeId,
      claimedAt: Date.now(),
      runtimeBootId: this.options.bootId,
      executionMode: DSH_EXECUTION_MODE,
    });
    if (prior) return prior;
    // Until DSH has replied and listed the session, it is busy, not unconfirmed.
    this.#inflight.set(id, { requestId, commandId, runtime: runtime.token });
    let sent: { ok: boolean; value?: unknown; error?: string };
    let made = nativeId;
    try {
      sent = await this.#command(
        runtime,
        { commandId, type: "create", cwd, sessionId: nativeId },
        undefined,
        () => dispatchManagedCommand(this.options.dataDir, requestId),
      );
      const child = sent.ok ? (sent.value as { sessionId?: unknown } | null)?.sessionId : undefined;
      if (typeof child === "string" && child) made = child;
      if (sent.ok) await this.#listed(made);
    } finally {
      this.#inflight.delete(id);
    }
    // Delivered without a reply: never sent again, settled as described above.
    if (sent.error === "unknown") {
      this.#unknownSessions.add(nativeId);
      this.#autoReconcile(nativeId);
      return result("unknown", { reason: "control-outcome-unconfirmed" });
    }
    const outcome = sent.ok
      ? result("accepted", { sessionId: this.options.sessionId(made) })
      : result("not-dispatched", { reason: sent.error });
    finishManagedCommand(this.options.dataDir, requestId, outcome);
    return outcome;
  }
  /**
   * Waits briefly for DSH to list a session it just made. DSH replies first and lists it with
   * its next report, and the client opens the session as soon as the reply arrives.
   */
  async #listed(nativeId: string, timeoutMs = 3_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!this.#catalog.has(nativeId) && !this.#closed && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 50));
  }
  #created(requestId: string, outcome: string, extra: Record<string, unknown> = {}) {
    return {
      accepted: outcome === "accepted",
      completed: outcome === "accepted",
      requestId,
      runtimeBootId: this.options.bootId,
      executionMode: DSH_EXECUTION_MODE,
      controlOutcome: outcome,
      ...extra,
    };
  }
  /**
   * Settles a create whose reply never came. Its session being listed means DSH made it; long
   * overdue, a DSH that listed its sessions since and has none under that ID never made it.
   */
  #settleCreate(id: string, requestId: string): Record<string, unknown> | null {
    const command = readUnknownManagedCommands(this.options.dataDir, id).find(
      (item) => item.requestId === requestId,
    );
    if (command?.evidence?.operation !== "create") return null;
    const claimedAt = Number(command.evidence.claimedAt);
    const giveUp = this.options.reconcileGiveUpMs ?? RECONCILE_GIVE_UP_MS;
    const listed = this.#ids.has(id);
    const absent =
      Date.now() - claimedAt >= giveUp &&
      this.#online().some(
        (runtime) => runtime.services.sessionController && runtime.listedAt > claimedAt,
      );
    if (!listed && !absent) return null;
    const outcome = listed
      ? this.#created(requestId, "accepted", { sessionId: id })
      : this.#created(requestId, "not-dispatched", { reason: "dsh-session-not-created" });
    finishManagedCommand(this.options.dataDir, requestId, outcome);
    this.#unknownSince.delete(requestId);
    if (!listed) this.#unknownSessions.delete(String(command.evidence.nativeSessionId));
    return outcome;
  }
  /** The model and reasoning effort picker, read from DSH's own model catalog. */
  async #settingsState(id: string, nativeId: string): Promise<Record<string, unknown>> {
    const live = this.live(id, true);
    const unavailable = (reason: string) => ({
      available: false,
      reason,
      executionMode: DSH_EXECUTION_MODE,
      revision: live.revision,
    });
    const runtime = this.#controlRuntime(nativeId);
    if (!runtime || live.executionLocation !== "external")
      return unavailable("dsh-runtime-offline");
    if (runtime.services.modelCatalog !== true) return unavailable("operation-unavailable");
    const result = await this.#command(runtime, {
      commandId: randomUUID(),
      type: "models",
      sessionId: nativeId,
    });
    const parsed = result.ok ? modelsSchema.safeParse(result.value) : null;
    if (!parsed?.success) return unavailable("dsh-models-unavailable");
    const catalog = parsed.data;
    this.#models.set(nativeId, catalog);
    const values = (selection: DshModels["default"]) =>
      selection
        ? { model: modelId(selection.provider, selection.model), effort: selection.reasoningEffort }
        : { model: null, effort: null };
    const current = values(catalog.selected ?? catalog.default);
    // The same model name can come from more than one provider.
    const names = new Map<string, number>();
    for (const model of catalog.models) names.set(model.name, (names.get(model.name) ?? 0) + 1);
    const writable = live.queueEditEnabled === true && live.status === "idle";
    // Why an offered choice cannot change now: a running turn keeps its model until it ends.
    const blocked =
      live.queueEditEnabled === true
        ? "session-busy"
        : ((live.reason as string | undefined) ?? "operation-unavailable");
    const choice = (offered: boolean) =>
      !offered
        ? { available: false, reason: "operation-unavailable" }
        : writable
          ? { available: true }
          : { available: false, reason: blocked };
    return {
      available: true,
      executionMode: DSH_EXECUTION_MODE,
      revision: live.revision,
      current,
      selected: current,
      defaults: values(catalog.default),
      applicationStatus: "confirmed",
      models: catalog.models.map((model) => ({
        id: modelId(model.provider, model.model),
        name:
          (names.get(model.name) ?? 0) > 1 ? `${model.name} · ${model.providerName}` : model.name,
        efforts: model.efforts.map((effort) => effort.id),
        ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
      })),
      writable: {
        model: choice(catalog.models.length > 0),
        effort: choice(catalog.models.some((model) => model.efforts.length > 0)),
      },
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
      // This session is listed, so the create that reserved its ID ran.
      if (operation === "create") {
        if (this.#settleCreate(id, command.requestId)) reconciled = true;
        continue;
      }
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
      const row = this.#catalog.get(nativeId);
      let selected: DshModels["selected"] = null;
      if (operation === "settings") {
        const models = await this.#command(runtime, {
          commandId: randomUUID(),
          type: "models",
          sessionId: nativeId,
        });
        const parsed = models.ok ? modelsSchema.safeParse(models.value) : null;
        selected = parsed?.success ? parsed.data.selected : null;
      }
      // A fork leaves no trace on its source, so it settles as not dispatched once overdue; a
      // copy that was made anyway still shows up in the session list.
      const applied = ["queue-delete", "queue-update", "queue-steer"].includes(operation)
        ? !queuedFor(state).some((item) => item.id === evidence.itemId)
        : operation === "stop"
          ? !(state?.status === "running" && turnIdOf(state.turn) === evidence.turnId)
          : ["approve", "answer"].includes(operation)
            ? !this.#interactions(nativeId).some((item) => item.id === evidence.interactionId)
            : operation === "rename"
              ? row?.title === evidence.title
              : operation === "archive" || operation === "unarchive"
                ? (row?.archived === true) === (evidence.archived === true)
                : operation === "settings"
                  ? selected?.provider === evidence.provider &&
                    selected?.model === evidence.model &&
                    (selected?.reasoningEffort ?? null) === (evidence.reasoningEffort ?? null)
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
    let result = value as Record<string, unknown>;
    // The new-session dialog that sent an unconfirmed create waits on this receipt.
    if (result.operation === "create" && result.status === "unknown") {
      const ack = this.#settleCreate(String(result.sessionId), String(result.requestId));
      if (ack)
        result = { ...result, status: ack.accepted === true ? "accepted" : "not-dispatched", ack };
    }
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
      // Rename and model settings.
      "name",
      "model",
      "effort",
      "resetDefaults",
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
      // A message with attachments arrives as content the Host's attachment store built.
      const content = (): DshBridgePromptPart[] => {
        if (!Array.isArray(value.input)) return [{ type: "text", text: text() }];
        const parts = promptContentSchema.parse(value.input);
        if (!parts.some((part) => part.type === "image" || part.text.trim()))
          throw new Error("invalid-text-input");
        if (parts.some((part) => part.type === "image") && runtime.services.images !== true)
          throw new Error("dsh-attachments-unavailable");
        return parts;
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
            content: content(),
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
            content: content(),
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
            content: content(),
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
        case "rename": {
          if (live.queueEditEnabled !== true) throw new Error("session-busy");
          const title = typeof value.name === "string" ? value.name.trim() : "";
          if (!title || title.length > 200) throw new Error("invalid-name");
          command = { commandId, type: "rename", sessionId: nativeId, title };
          break;
        }
        case "archive":
        case "unarchive":
          if (runtime.services.workspaceController !== true)
            throw new Error("operation-unavailable");
          // DSH refuses to archive an active session rather than stop its work.
          if (live.queueEditEnabled !== true || live.status !== "idle")
            throw new Error("session-busy");
          command = {
            commandId,
            type: "archive",
            sessionId: nativeId,
            archived: value.operation === "archive",
          };
          break;
        case "fork":
          if (live.queueEditEnabled !== true) throw new Error("session-busy");
          command = { commandId, type: "fork", sessionId: nativeId };
          break;
        case "settings": {
          if (runtime.services.modelCatalog !== true) throw new Error("operation-unavailable");
          if (live.queueEditEnabled !== true || live.status !== "idle")
            throw new Error("session-busy");
          // Read moments before by the same request, so this is the selection the user saw.
          const catalog = this.#models.get(nativeId);
          if (!catalog) throw new Error("stale-settings");
          const current = catalog.selected ?? catalog.default;
          // The Host offers "restore defaults" whenever DSH reports a default model.
          const reset = value.resetDefaults === true;
          const target = reset
            ? catalog.default
            : value.model === undefined
              ? current
              : parseModelId(value.model);
          if (!target) throw new Error("invalid-model");
          const model = catalog.models.find(
            (entry) => entry.provider === target.provider && entry.model === target.model,
          );
          if (!model) throw new Error("invalid-model");
          // An effort change keeps the model; a new model starts at its own default effort.
          const effort = reset
            ? (catalog.default?.reasoningEffort ?? null)
            : typeof value.effort === "string"
              ? value.effort
              : value.model === undefined
                ? (current?.reasoningEffort ?? null)
                : null;
          if (effort !== null && !model.efforts.some((entry) => entry.id === effort))
            throw new Error("invalid-effort");
          command = {
            commandId,
            type: "selectModel",
            sessionId: nativeId,
            provider: model.provider,
            model: model.model,
            ...(effort !== null ? { reasoningEffort: effort } : {}),
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
      ...(command.type === "rename" ? { title: command.title } : {}),
      ...(command.type === "archive" ? { archived: command.archived } : {}),
      ...(command.type === "selectModel"
        ? {
            provider: command.provider,
            model: command.model,
            reasoningEffort: command.reasoningEffort ?? null,
          }
        : {}),
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
      // Clients open a fork from the reply, as they do a Codex fork; still in flight, wait for
      // DSH to list it first.
      const child = result.ok ? (result.value as { sessionId?: unknown } | null)?.sessionId : null;
      const forked = command.type === "fork" && typeof child === "string" && child ? child : null;
      if (forked) await this.#listed(forked);
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
          if (forked)
            outcome = { ...outcome, sessionId: this.options.sessionId(forked), completed: true };
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
            listedAt: 0,
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
