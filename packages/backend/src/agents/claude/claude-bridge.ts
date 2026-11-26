import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { nextReportOfferAt, trackReportRecovery } from "../../report-delivery";
import {
  CLAUDE_BRIDGE_CLI_VERSION,
  CLAUDE_BRIDGE_COMPATIBILITY,
  claudeBridgeFeatures,
  CLAUDE_BRIDGE_PATHS,
  CLAUDE_BRIDGE_REQUIRED_CAPABILITIES,
  claudeBridgeCompatibility,
  claudeBridgePluginCompatibility,
  missingClaudeBridgeCapabilities,
  type ClaudeBridgeConnectionFailure,
  type ClaudeBridgeIdentity,
  type ClaudeBridgeCommand,
  type ClaudeBridgeEvent,
  type ClaudeBridgeSnapshot,
  type ClaudeBridgeTool,
  type SessionStreamEvent,
} from "@agentkib/runtime-protocol";
import {
  bridgeIdentitySchema,
  bridgeEventsSchema,
  bridgeLeadCallSchema,
  bridgePollSchema,
  bridgeResultSchema,
} from "./claude-bridge-schema";
import {
  claudeBridgeToolEvent,
  terminalQuestions,
  terminalQuestionSettled,
  terminalToolItems,
} from "./claude-bridge-tool-detail";
import { acquirePortableFileLease } from "../../managed-session-lock";
import { privateJson, privatePath } from "./claude-bridge-files";
import type { ClaudeLocalTitleScope } from "./claude-host-state";
import type { ClaudeBridgePluginUpdater } from "./claude-bridge-plugin-update";
import {
  acknowledgeDispatchedManagedCommand,
  finishManagedCommand,
  observeManagedCommandCompletion,
  readUnknownManagedCommands,
} from "../../managed-ledger";
import { admitControlReceipt } from "../../sessions/control-receipts";
import { LeadReportNotDispatched } from "../../message-lead-reports";
import { validHistoryControl } from "../../history-control-schema";
import { sanitizeSessionText } from "../../session-handoff";
import { terminalSubagentActivities } from "../../session-activities";
import type { ClaudeTranscriptObservation } from "./claude-context-usage";
import type { ContextUsage } from "../../context-usage";
import type { ClaudeObservedPermissionMode } from "./claude-managed-runner";
import type { WorkerObserver } from "../../orchestration-service";

const MAX_BODY = 1024 * 1024;
const HEARTBEAT_MS = 35_000;
const LOCAL_OWNER = "agentkib-local-owner";
const uuid = z.string().uuid();
const terminalAttachmentInputSchema = z.tuple([
  z.strictObject({
    type: z.literal("claude-terminal-attachments"),
    cwd: z.string().min(1).max(4096),
    text: z.string().max(16_000),
  }),
]);
const targetSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    nativeId: uuid,
    workspaceId: z.string().min(1),
    workspace: z.string().min(1),
    registeredWorkspace: z.string().min(1),
  })
  .strict();
export type ClaudeBridgeTarget = z.infer<typeof targetSchema>;
const bindingSchema = z
  .object({
    version: z.literal(1),
    bindingId: uuid,
    target: targetSchema,
    token: z.string().regex(/^[a-f0-9]{64}$/),
    revoked: z.boolean(),
    cliVersion: z.string().max(64).optional(),
    inflight: z
      .object({ requestId: uuid, commandId: uuid, turnId: uuid.nullable() })
      .strict()
      .nullable(),
  })
  .strict();
type Binding = z.infer<typeof bindingSchema>;
type ClaudeBridgeSessionScope = {
  value: Record<string, unknown>;
  id: string;
  row: Binding;
  controls: boolean;
};
type ClaudeBridgeSessionOperation = (value: Record<string, unknown>) => Promise<unknown>;
const bindingRegistrySchema = z
  .object({ version: z.literal(1), bindings: z.array(bindingSchema).max(64) })
  .strict();
type Challenge = { target: ClaudeBridgeTarget; expires: number };
type ConnectionAttempt = (
  | { challenge: Challenge; bindingId?: never; auto?: never }
  | { bindingId: string; challenge?: never; auto?: never }
  | { auto: true; challenge?: never; bindingId?: never }
) & {
  error?: string;
  cliVersion?: string;
  missingCapabilities?: string[];
};
const reportedCliVersion = z
  .string()
  .max(64)
  .refine((version) => claudeBridgeCompatibility(version) !== "invalid")
  .optional();
const reportedMissingCapabilities = z
  .array(z.enum(CLAUDE_BRIDGE_REQUIRED_CAPABILITIES as [string, ...string[]]))
  .max(CLAUDE_BRIDGE_REQUIRED_CAPABILITIES.length)
  .optional();
// Plugins of other releases report here too, an old one included, so the dialog can say why.
const reconnectFailureSchema = z
  .object({
    protocol: z.literal(1),
    pluginVersion: z
      .string()
      .max(64)
      .refine((version) => claudeBridgePluginCompatibility(version) !== "invalid"),
    bindingId: uuid,
    nativeId: uuid,
    cwd: z.string().min(1).max(4096),
    instanceId: uuid,
    connectionError: z.enum([
      "bridge-cli-too-old",
      "bridge-cli-unsupported",
      "bridge-capabilities-missing",
      "bridge-plugin-update-required",
    ]),
    cliVersion: reportedCliVersion,
    missingCapabilities: reportedMissingCapabilities,
  })
  .strip();
const AUTO_STATE_LIMIT = 512;
// Kept beside, not inside, bindings-v1.json so an older Runtime can still read its registry.
const autoStateSchema = z
  .object({
    version: z.literal(1),
    disabledWorkspaces: z.array(z.string().min(1).max(256)).max(AUTO_STATE_LIMIT),
    declined: z.array(uuid).max(AUTO_STATE_LIMIT),
    autoBindings: z.array(uuid).max(64),
  })
  .strict();
const contextWindowAnchorSchema = z
  .object({
    usedTokens: z.number().int().min(0),
    updatedAt: z.string().datetime(),
    model: z.string().min(1).max(128).nullable(),
    afterCompaction: z.boolean(),
  })
  .strict();
const contextWindowEntrySchema = z
  .object({
    bindingId: uuid,
    anchor: contextWindowAnchorSchema,
    window: z.number().int().positive(),
    reportedModel: z.string().min(1).max(128).nullable(),
  })
  .strict()
  .refine((entry) => entry.window >= entry.anchor.usedTokens)
  .refine((entry) =>
    entry.reportedModel === null
      ? entry.anchor.afterCompaction
      : entry.reportedModel === entry.anchor.model,
  );
// Keep optional display observations separate so older runtimes can read the binding registry.
const contextWindowRegistrySchema = z
  .object({ version: z.literal(1), observations: z.array(contextWindowEntrySchema).max(64) })
  .strict();
type ContextWindowEntry = z.infer<typeof contextWindowEntrySchema>;
const terminalExitModelsSchema = z.object({
  version: z.literal(1),
  models: z.array(z.tuple([uuid, z.string().min(1).max(128)])).max(64),
});

function transcriptWindowAnchor(observation?: ClaudeTranscriptObservation) {
  const usage = observation?.usage;
  if (!usage?.available || !usage.historical) return undefined;
  const parsed = contextWindowAnchorSchema.safeParse({
    usedTokens: usage.usedTokens,
    updatedAt: usage.updatedAt,
    model: observation?.model ?? null,
    afterCompaction: usage.reason === "claude-post-compaction-usage",
  });
  return parsed.success ? parsed.data : undefined;
}

function withContextWindow(usage: ContextUsage, entry: ContextWindowEntry): ContextUsage {
  const { reason, ...saved } = usage;
  return {
    ...saved,
    contextWindow: entry.window,
    ...(entry.reportedModel === null
      ? { reason: "claude-post-compaction-current-window" }
      : reason && reason !== "model-context-window-unavailable"
        ? { reason }
        : {}),
  };
}

type Pending = {
  command: ClaudeBridgeCommand;
  requestId: string;
  deviceId: string;
  receipt: Pick<ReturnType<typeof admitControlReceipt>, "dispatch" | "finish">;
  delivered: boolean;
  resolve(value: Record<string, unknown>): void;
  timer: ReturnType<typeof setTimeout>;
};
type Connection = {
  identity: ClaudeBridgeIdentity;
  leaseId: string;
  instanceId: string;
  lastSeen: number;
  seq: number;
  revision: number;
  snapshot: ClaudeBridgeSnapshot | null;
  terminalSubagentsObserved: boolean;
  gap: boolean;
  pending: Pending | null;
  wake?: () => void;
  pollActive: boolean;
  completed: Map<string, boolean>;
  turnTools: Map<string, ClaudeBridgeTool>;
  publishedTools: Map<string, ClaudeBridgeTool>;
  /** The plugin can register a Project Agent's tools (feature `lead-tools`). */
  leadTools?: boolean;
  leadWorkerSettings?: boolean;
  leadReportsPaused?: boolean;
  leadReportsRecovery?: Promise<void>;
  nativeReportOffers?: Map<string, number>;
};
/** A report on its way into a terminal Project Agent's outbox. */
type QueuedReport = {
  id: string;
  text: string;
  offered?: true;
  nativeReceipt?: true;
  mergedIds?: string[];
};
type ReportReceipt = { id: string; merged: boolean };
export type ClaudeTerminalHandoverSource = {
  bindingId: string;
  lastLeaseId?: string;
  target: ClaudeBridgeTarget;
  reports: readonly QueuedReport[];
  reason: string | null;
  revision: number;
  model?: string;
};
export type ClaudeTerminalExitSource = {
  target: ClaudeBridgeTarget;
  bindingId: string;
  leaseId: string;
  revision: number;
  turnId: string | null;
};
/** A Project Agent in a terminal (docs/agents/project-agent.md); `orchestration-service.ts`. */
export interface BridgeLead {
  /** Its worker tools, or null when the session directs none. */
  tools(sessionId: string): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> | null;
  call(
    sessionId: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ text: string; isError?: boolean }>;
  /** The person wrote to it, in the terminal or from AgentKib. */
  userSpoke(sessionId: string): void;
  /**
   * Its CLI began a turn by itself (background work woke it). Past the Project Agent's automatic
   * turns it names the device to stop that turn as; null lets it run.
   */
  selfTurn?(sessionId: string): { stopAs: string } | null;
  /** Why its delegation is paused, or null; the terminal tells the person. */
  paused?(sessionId: string): string | null;
  reportPauseChanged?(sessionId: string, paused: boolean): void | Promise<void>;
}
interface BridgeOptions {
  dataDir: string;
  /** Explicit legacy Dev profile, supplied only by the shared runtime launcher. */
  legacyDataDir?: string;
  sessionIdForNative?(nativeId: string): string;
  bootId: string;
  pluginDirectory: string;
  pluginUpdate?: ClaudeBridgePluginUpdater;
  /** A bounded native identity read. No model, transcript rewrite or managed adopt. */
  target(
    sessionId: string,
    nativeId?: string,
    activeWorkspace?: string,
  ): Promise<ClaudeBridgeTarget>;
  /** The binding ID only accompanies an existing row's authenticated execution or recovery. */
  validate(target: ClaudeBridgeTarget, forControl: boolean, bindingId?: string): void;
  /** Pure verified history reads; never opens a CLI/SDK worker or changes terminal settings. */
  observation?(target: ClaudeBridgeTarget): ClaudeTranscriptObservation;
  /** Read only the native session's persisted last-wins permission-mode marker. */
  permission?(target: ClaudeBridgeTarget): ClaudeObservedPermissionMode | null;
  /**
   * Resolves a terminal's own native identity to its registered workspace session.
   * Absent means automatic pairing is unavailable; one-time codes keep working.
   */
  autoTarget?(nativeId: string, cwd: string): Promise<ClaudeBridgeTarget>;
  /** Fixed per-user path where terminals find the broker and the current auto-pair key. */
  discoveryFile?: string;
  publish(
    sessionId: string,
    type: SessionStreamEvent["type"],
    payload: Record<string, unknown>,
    live: Record<string, unknown>,
  ): void;
  platform?: NodeJS.Platform;
  commandTimeoutMs?: number;
  completed?(
    target: ClaudeBridgeTarget,
    turnId: string,
    aborted: boolean,
    timing: { occurredAt?: number; startedAt?: number },
  ): void;
  /** Lets a connected terminal session be a Project Agent; absent, none is. */
  lead?: BridgeLead;
}

/** Reports a terminal holds at most before it takes them, as its outbox holds 20 messages. */
const MAX_QUEUED_REPORTS = 16;
const MAX_MERGED_REPORT_IDS = 128;
// Keep more receipts than can be acknowledged by removing the entire queue at once.
const MAX_REPORT_RECEIPTS = 4096;
const NATIVE_REPORT_RETRY_MS = 4_000;
/** The legacy on-disk format can contain reports larger than a plugin can submit. */
const MAX_REPORT_TEXT = 32_000;
const MAX_REPORT_CODE_POINTS = 16_000;
const MAX_REPORT_BYTES = 16_384;
function fitsTerminalReport(text: string): boolean {
  return Buffer.byteLength(text) <= MAX_REPORT_BYTES && [...text].length <= MAX_REPORT_CODE_POINTS;
}
const reportQueueSchema = z
  .array(
    z.object({
      id: uuid,
      text: z.string().max(MAX_REPORT_TEXT),
      offered: z.literal(true).optional(),
      nativeReceipt: z.literal(true).optional(),
      mergedIds: z.array(uuid).max(MAX_MERGED_REPORT_IDS).optional(),
    }),
  )
  .max(MAX_QUEUED_REPORTS);
const reportReceiptsSchema = z
  .array(z.object({ id: uuid, merged: z.boolean() }))
  .max(MAX_REPORT_RECEIPTS);

function readLegacyJson(file: string, maxBytes = MAX_BODY): unknown {
  privatePath(file);
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.size > maxBytes ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("unsafe-Claude-bridge-path");
  return JSON.parse(readFileSync(file, "utf8"));
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

class CompatibilityError extends Error {
  constructor(
    reason: string,
    readonly cliVersion?: string,
    readonly missingCapabilities?: string[],
  ) {
    super(reason);
  }
}
function requireCompatibility(value: unknown): void {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const state = claudeBridgeCompatibility(row.cliVersion);
  const version = state === "invalid" ? undefined : (row.cliVersion as string);
  // A plugin of another release connects too, a newer one included.
  if (row.protocol !== 1 || claudeBridgePluginCompatibility(row.pluginVersion) !== "supported")
    throw new CompatibilityError("bridge-plugin-update-required", version);
  if (state === "too-old") throw new CompatibilityError("bridge-cli-too-old", version);
  if (state === "invalid") throw new CompatibilityError("bridge-cli-unsupported");
  const missing = missingClaudeBridgeCapabilities(row.nativeCapabilities);
  if (missing.length) throw new CompatibilityError("bridge-capabilities-missing", version, missing);
}
function compatibilityStatus(connection?: Connection) {
  if (!connection) return undefined;
  const cliVersion = connection.identity.cliVersion;
  const status = claudeBridgeCompatibility(cliVersion);
  return status === "verified" || status === "unverified" ? { cliVersion, status } : undefined;
}

/** A borrowed native execution host. Closing this broker never signals a Claude process. */
export class ClaudeBridge {
  readonly root: string;
  #bindings = new Map<string, Binding>();
  #contextWindows = new Map<string, ContextWindowEntry>();
  #terminalExitModels = new Map<string, string>();
  #compactStartedAt = new WeakMap<Binding, number>();
  #connections = new Map<string, Connection>();
  #lastConnectionLease = new WeakMap<Binding, string>();
  #challenges = new Map<string, Challenge>();
  #connectionAttempts = new Map<string, ConnectionAttempt>();
  #server?: Server;
  #listening?: Promise<void>;
  #socketPath?: string;
  #socketDirectory?: string;
  #releaseLock?: () => void;
  #closed = false;
  #startupFailed = false;
  #registryInvalid = false;
  #revision = 0;
  #timer: ReturnType<typeof setInterval>;
  // Rotates per Runtime start; only the 0600 discovery file carries it to terminals.
  readonly #autoKey = randomBytes(32).toString("hex");
  #disabledWorkspaces = new Set<string>();
  // Sessions the user disconnected. Only an explicit one-time code pairs them again.
  #declined = new Set<string>();
  #autoBindings = new Set<string>();
  #legacyBindings: Binding[] = [];
  #legacyUnresolved = new Set<string>();
  #releaseLegacyLock?: () => void;
  /** Reports for terminal Project Agents, by session, until their plugin takes them. */
  #reports = new Map<string, QueuedReport[]>();
  #reportReceipts = new Map<string, Map<string, boolean>>();
  #workerObserver?: WorkerObserver;

  constructor(readonly options: BridgeOptions) {
    this.root = path.join(options.dataDir, "claude-bridge");
    const registry = path.join(this.root, "bindings-v1.json");
    try {
      privatePath(registry);
      if (existsSync(registry)) {
        privatePath(this.root, true);
        const stat = lstatSync(registry);
        if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()))
          throw new Error("invalid-Claude-bridge-registry");
        if (lstatSync(registry).size > MAX_BODY) throw new Error("invalid-Claude-bridge-registry");
        chmodSync(registry, 0o600);
        const rows = bindingRegistrySchema.parse(JSON.parse(readFileSync(registry, "utf8")));
        for (const row of rows.bindings) {
          if (this.#bindings.has(row.target.sessionId))
            throw new Error("duplicate-Claude-bridge-binding");
          this.#bindings.set(row.target.sessionId, row);
        }
      }
    } catch {
      // Corrupt optional integration state must not prevent the desktop from starting.
      // Do not overwrite it or infer that formerly dispatched commands never existed.
      this.#bindings.clear();
      this.#registryInvalid = true;
    }
    try {
      const file = path.join(this.root, "auto-v1.json");
      privatePath(file);
      if (existsSync(file)) {
        const stat = lstatSync(file);
        if (
          stat.isFile() &&
          stat.size <= MAX_BODY &&
          (!process.getuid || stat.uid === process.getuid())
        ) {
          const state = autoStateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
          this.#disabledWorkspaces = new Set(state.disabledWorkspaces);
          this.#declined = new Set(state.declined);
          const bound = new Set([...this.#bindings.values()].map((row) => row.bindingId));
          this.#autoBindings = new Set(state.autoBindings.filter((id) => bound.has(id)));
        }
      }
    } catch {
      // Unreadable preferences fall back to the default: automatic connection on.
    }
    try {
      const file = path.join(this.root, "context-usage-v1.json");
      const { observations } = contextWindowRegistrySchema.parse(readLegacyJson(file));
      const bindings = new Set(
        [...this.#bindings.values()].filter((row) => !row.revoked).map((row) => row.bindingId),
      );
      for (const entry of observations)
        if (bindings.has(entry.bindingId)) this.#contextWindows.set(entry.bindingId, entry);
    } catch {
      // Optional display data cannot keep the broker from starting.
    }
    try {
      const file = path.join(this.root, "terminal-exit-models-v1.json");
      const { models } = terminalExitModelsSchema.parse(readLegacyJson(file));
      const current = new Set([...this.#bindings.values()].map(({ bindingId }) => bindingId));
      for (const [bindingId, model] of models)
        if (current.has(bindingId)) this.#terminalExitModels.set(bindingId, model);
    } catch {
      // Model observations are optional for older sessions and brokers.
    }
    this.#readLegacyBindings();
    this.#timer = setInterval(() => {
      for (const [id, connection] of this.#connections)
        if (Date.now() - connection.lastSeen > HEARTBEAT_MS) this.#disconnect(id);
    }, 5_000);
    this.#timer.unref();
  }

  get supported(): boolean {
    return (this.options.platform ?? process.platform) === "darwin";
  }
  get autoAvailable(): boolean {
    return (
      this.supported &&
      !this.#registryInvalid &&
      !!this.options.autoTarget &&
      !!this.options.discoveryFile
    );
  }
  #autoStatus(target: ClaudeBridgeTarget) {
    return {
      available: this.autoAvailable,
      enabled: !this.#disabledWorkspaces.has(target.workspaceId),
      // This session was disconnected by the user and needs a code to connect again.
      declined: this.#declined.has(target.nativeId),
    };
  }
  /**
   * A terminal whose plugin or CLI is rejected stops pairing by itself, so the
   * connection dialog is the only place that can ask for an update.
   */
  async #recordAutoFailure(value: unknown, error: CompatibilityError): Promise<void> {
    const identity = z
      .object({ nativeId: z.string().uuid(), cwd: z.string().min(1).max(4096) })
      .safeParse(value);
    if (!identity.success || this.#declined.has(identity.data.nativeId)) return;
    let target: ClaudeBridgeTarget;
    try {
      target = await this.options.autoTarget!(identity.data.nativeId, identity.data.cwd);
    } catch {
      return;
    }
    const { sessionId } = target;
    if (
      target.nativeId !== identity.data.nativeId ||
      target.workspace !== identity.data.cwd ||
      this.#disabledWorkspaces.has(target.workspaceId) ||
      this.#connections.has(sessionId) ||
      this.#connectionAttempts.get(sessionId)?.challenge
    )
      return;
    const attempt: ConnectionAttempt = {
      auto: true,
      error: error.message,
      cliVersion: error.cliVersion,
      missingCapabilities: error.missingCapabilities,
    };
    if (stable(this.#connectionAttempts.get(sessionId)) === stable(attempt)) return;
    this.#connectionAttempts.set(sessionId, attempt);
    ++this.#revision;
    this.#publish(sessionId);
  }
  #saveAuto(): void {
    const bound = new Set([...this.#bindings.values()].map((row) => row.bindingId));
    for (const id of this.#autoBindings) if (!bound.has(id)) this.#autoBindings.delete(id);
    const recent = (values: Set<string>) => [...values].slice(-AUTO_STATE_LIMIT);
    privateJson(path.join(this.root, "auto-v1.json"), {
      version: 1,
      disabledWorkspaces: recent(this.#disabledWorkspaces),
      declined: recent(this.#declined),
      autoBindings: [...this.#autoBindings],
    });
  }
  #writeDiscovery(): void {
    const file = this.options.discoveryFile;
    if (!file || !this.autoAvailable || !this.#socketPath) return;
    try {
      privateJson(file, { protocol: 1, socketPath: this.#socketPath, autoKey: this.#autoKey });
    } catch {
      // Without discovery, terminals simply fall back to one-time codes.
    }
  }
  #removeDiscovery(): void {
    const file = this.options.discoveryFile;
    if (!file) return;
    try {
      // Another AgentKib instance may own the file by now; remove only our own key.
      if (JSON.parse(readFileSync(file, "utf8"))?.autoKey === this.#autoKey)
        rmSync(file, { force: true });
    } catch {
      /* Missing or foreign discovery files are left alone. */
    }
  }
  assertRegistryValid(): void {
    if (this.#registryInvalid) throw new Error("claude-bridge-registry-invalid");
  }
  #assertLegacySettled(sessionId: string): void {
    if (this.#legacyUnresolved.has(sessionId)) throw new Error("control-outcome-unconfirmed");
  }
  handles(sessionId: string): boolean {
    const row = this.#bindings.get(sessionId);
    return (
      this.#legacyUnresolved.has(sessionId) || (!!row && (!row.revoked || row.inflight !== null))
    );
  }
  blocksManagedResume(sessionId: string): boolean {
    this.assertRegistryValid();
    this.#assertLegacySettled(sessionId);
    const row = this.#bindings.get(sessionId);
    if (!row) return false;
    if (row.inflight || readUnknownManagedCommands(this.options.dataDir, sessionId).length > 0)
      return true;
    const connection = this.#connections.get(sessionId);
    // A fresh lease also protects the interval between pairing and its first snapshot.
    // Expired, settled bindings retain their credentials without blocking a native resume.
    return !!connection && !row.revoked && Date.now() - connection.lastSeen <= HEARTBEAT_MS;
  }

  /** An expired lease removes the bridge claim, but does not prove native process exit. */
  terminalHandoverSource(
    id: string,
    handoverRequestId?: string,
  ): ClaudeTerminalHandoverSource | undefined {
    const row = this.#bindings.get(id);
    if (!row) return;
    this.assertRegistryValid();
    this.#assertLegacySettled(id);
    const reports = this.#reportQueue(id);
    const connection = this.#connections.get(id);
    const reason =
      row.inflight ||
      readUnknownManagedCommands(this.options.dataDir, id).some(
        ({ requestId, evidence }) =>
          requestId !== handoverRequestId ||
          evidence?.operation !== "handover-terminal" ||
          evidence.bindingId !== row.bindingId,
      )
        ? "control-outcome-unconfirmed"
        : connection && !row.revoked && Date.now() - connection.lastSeen <= HEARTBEAT_MS
          ? "claude-owner-busy"
          : reports.some((report) => report.offered)
            ? "claude-terminal-report-unconfirmed"
            : null;
    const model =
      connection && !connection.gap && this.#online(id)
        ? connection.snapshot?.model
        : this.#terminalExitModels.get(row.bindingId);
    const lastLeaseId = this.#lastConnectionLease.get(row);
    return {
      bindingId: row.bindingId,
      ...(lastLeaseId ? { lastLeaseId } : {}),
      target: row.target,
      reports,
      reason,
      revision: this.#revision,
      ...(model ? { model } : {}),
    };
  }

  remoteTerminalExitSource(id: string): ClaudeTerminalExitSource | undefined {
    const source = this.terminalHandoverSource(id);
    if (source?.reason !== "claude-owner-busy" || source.reports.some((report) => report.offered))
      return;
    const connection = this.#connections.get(id);
    const snapshot = connection?.snapshot;
    if (
      !connection ||
      !snapshot ||
      !this.#online(id) ||
      connection.gap ||
      connection.pending ||
      snapshot.capabilities.handover !== true ||
      snapshot.compacting ||
      snapshot.modelPickerOpen ||
      snapshot.outbox.length ||
      (!snapshot.currentTurnId && (snapshot.status !== "idle" || snapshot.waiting))
    )
      return;
    const row = this.#bindings.get(id)!;
    try {
      this.options.validate(row.target, true, row.bindingId);
    } catch {
      return;
    }
    return {
      target: row.target,
      bindingId: row.bindingId,
      leaseId: connection.leaseId,
      revision: connection.revision,
      turnId: snapshot.currentTurnId,
    };
  }

  requestTerminalExit(
    source: ClaudeTerminalExitSource,
    requestId: string,
    deviceId: string,
    commandId: string,
    dispatch: () => void,
  ): Promise<Record<string, unknown>> {
    const { sessionId } = source.target;
    const connection = this.#connections.get(sessionId);
    const row = this.#bindings.get(sessionId);
    if (
      !row ||
      row.bindingId !== source.bindingId ||
      !connection?.snapshot ||
      connection.leaseId !== source.leaseId ||
      connection.revision !== source.revision ||
      connection.pending
    )
      throw new Error("stale-Claude-revision");
    const command: ClaudeBridgeCommand = {
      kind: "handover-exit",
      commandId,
      expectedRevision: connection.snapshot.revision,
      ...(source.turnId ? { turnId: source.turnId } : {}),
    };
    // The bridge only acknowledges command delivery here. The caller settles this
    // receipt once the native process exit and managed transfer are verified.
    return this.#queueCommand(row, connection, command, requestId, deviceId, {
      dispatch,
      finish: () => {},
    });
  }

  /** Called only after observing the exact native process die and no alternate owner. */
  confirmRemoteTerminalExit(source: ClaudeTerminalExitSource): void {
    const { sessionId } = source.target;
    const row = this.#bindings.get(sessionId);
    if (
      row?.bindingId !== source.bindingId ||
      this.#lastConnectionLease.get(row) !== source.leaseId
    )
      throw new Error("native-identity-changed");
    this.#disconnect(sessionId);
  }

  /** Remove only reports which were persisted in the managed queue. */
  finishTerminalHandover(source: ClaudeTerminalHandoverSource): void {
    const row = this.#bindings.get(source.target.sessionId);
    if (!row || row.bindingId !== source.bindingId || source.reports.length === 0) return;
    const imported = new Set(source.reports.map((report) => report.id));
    this.#retireReports(row, (report) => imported.has(report.id));
  }
  #save(): void {
    privateJson(path.join(this.root, "bindings-v1.json"), {
      version: 1,
      bindings: [...this.#bindings.values()],
    });
  }
  #saveTerminalExitModels(): void {
    const current = new Set([...this.#bindings.values()].map(({ bindingId }) => bindingId));
    for (const bindingId of this.#terminalExitModels.keys())
      if (!current.has(bindingId)) this.#terminalExitModels.delete(bindingId);
    privateJson(path.join(this.root, "terminal-exit-models-v1.json"), {
      version: 1,
      models: [...this.#terminalExitModels],
    });
  }

  #reportFile(bindingId: string): string {
    return path.join(this.root, "lead-reports", `${bindingId}.json`);
  }

  #reportReceiptFile(bindingId: string): string {
    return path.join(this.root, "lead-report-receipts", `${bindingId}.json`);
  }

  #reportReceiptIndex(row: Binding): Map<string, boolean> {
    const sessionId = row.target.sessionId;
    const cached = this.#reportReceipts.get(sessionId);
    if (cached) return cached;
    const file = this.#reportReceiptFile(row.bindingId);
    const rows = existsSync(file)
      ? reportReceiptsSchema.parse(readLegacyJson(file, MAX_REPORT_RECEIPTS * 64 + 2))
      : [];
    const receipts = new Map(rows.map(({ id, merged }) => [id, merged]));
    this.#reportReceipts.set(sessionId, receipts);
    return receipts;
  }

  #reportQueue(sessionId: string): QueuedReport[] {
    const row = this.#bindings.get(sessionId);
    if (!row || row.revoked) return [];
    let queued = this.#reports.get(sessionId);
    if (!queued) {
      const file = this.#reportFile(row.bindingId);
      // JSON uses up to six bytes for each escaped UTF-16 code unit.
      queued = existsSync(file)
        ? reportQueueSchema.parse(
            readLegacyJson(
              file,
              MAX_QUEUED_REPORTS * (MAX_REPORT_TEXT * 6 + MAX_MERGED_REPORT_IDS * 39 + 128),
            ),
          )
        : [];
      this.#reports.set(sessionId, queued);
    }
    const receipts = this.#reportReceiptIndex(row);
    return queued.filter(({ id }) => !receipts.has(id));
  }

  #saveReports(row: Binding, reports: QueuedReport[]): void {
    privateJson(this.#reportFile(row.bindingId), reports);
    this.#reports.set(row.target.sessionId, reports);
  }

  #retireReports(row: Binding, retire: (report: QueuedReport) => boolean): void {
    const sessionId = row.target.sessionId;
    const queued = this.#reportQueue(sessionId);
    const acknowledged = queued.filter(retire);
    if (!acknowledged.length) return;
    const receipts = new Map(this.#reportReceiptIndex(row));
    for (const report of acknowledged) {
      for (const id of report.mergedIds ?? []) receipts.set(id, true);
      receipts.set(report.id, false);
    }
    const entries: ReportReceipt[] = [...receipts]
      .slice(-MAX_REPORT_RECEIPTS)
      .map(([id, merged]) => ({ id, merged }));
    // Commit receipts before removing payloads. A crash between the two writes
    // leaves the existing outbox readable, with the receipt taking precedence.
    privateJson(this.#reportReceiptFile(row.bindingId), entries);
    this.#reportReceipts.set(sessionId, new Map(entries.map(({ id, merged }) => [id, merged])));
    const removed = new Set(acknowledged.map(({ id }) => id));
    this.#saveReports(
      row,
      queued.filter(({ id }) => !removed.has(id)),
    );
  }

  #forgetReports(row: Binding): void {
    this.#reports.delete(row.target.sessionId);
    this.#reportReceipts.delete(row.target.sessionId);
    for (const file of [this.#reportFile(row.bindingId), this.#reportReceiptFile(row.bindingId)]) {
      privatePath(file);
      rmSync(file, { force: true });
    }
  }

  #saveContextWindows(): void {
    const active = new Set(
      [...this.#bindings.values()].filter((row) => !row.revoked).map((row) => row.bindingId),
    );
    for (const id of this.#contextWindows.keys())
      if (!active.has(id)) this.#contextWindows.delete(id);
    try {
      privateJson(path.join(this.root, "context-usage-v1.json"), {
        version: 1,
        observations: [...this.#contextWindows.values()],
      });
    } catch {
      // Observable window metadata never changes the terminal lease or event acknowledgement.
    }
  }

  #readLegacyBindings(): void {
    const { legacyDataDir, sessionIdForNative } = this.options;
    if (!this.supported || !legacyDataDir || !sessionIdForNative) return;
    try {
      privatePath(legacyDataDir);
      if (realpathSync(legacyDataDir) === realpathSync(this.options.dataDir)) return;
      const root = path.join(legacyDataDir, "claude-bridge");
      const parent = lstatSync(legacyDataDir);
      const directory = lstatSync(root);
      const uid = process.getuid?.();
      if (
        !parent.isDirectory() ||
        (parent.mode & 0o022) !== 0 ||
        !directory.isDirectory() ||
        (directory.mode & 0o077) !== 0 ||
        (uid !== undefined && (parent.uid !== uid || directory.uid !== uid))
      )
        return;
      const registry = path.join(root, "bindings-v1.json");
      let bindings = bindingRegistrySchema.parse(readLegacyJson(registry)).bindings;
      try {
        this.#releaseLegacyLock = acquirePortableFileLease(path.join(root, "broker.lock"));
      } catch {
        // An older Dev process may still use these credentials. Leave its data in place.
        for (const row of bindings)
          if (!row.revoked || row.inflight)
            this.#legacyUnresolved.add(sessionIdForNative(row.target.nativeId));
        return;
      }
      // Read again under the old broker lease to catch writes that won the startup race.
      bindings = bindingRegistrySchema.parse(readLegacyJson(registry)).bindings;
      for (const row of bindings) {
        const sessionId = sessionIdForNative(row.target.nativeId);
        try {
          if (
            row.inflight ||
            readUnknownManagedCommands(legacyDataDir, row.target.sessionId).length
          ) {
            this.#legacyUnresolved.add(sessionId);
            continue;
          }
        } catch {
          this.#legacyUnresolved.add(sessionId);
          continue;
        }
        if (!row.revoked) this.#legacyBindings.push(row);
      }
      const autoFile = path.join(root, "auto-v1.json");
      if (existsSync(autoFile)) {
        const { declined } = autoStateSchema.parse(readLegacyJson(autoFile));
        this.#legacyBindings = this.#legacyBindings.filter(
          (row) => !declined.includes(row.target.nativeId),
        );
      }
    } catch {
      // Legacy files are optional. Never replace or recreate an unreadable registry.
      this.#releaseLegacyLock?.();
      this.#releaseLegacyLock = undefined;
      this.#legacyBindings = [];
    }
  }

  async #migrateLegacyBindings(): Promise<void> {
    const { legacyDataDir, sessionIdForNative, autoTarget } = this.options;
    if (!legacyDataDir || !sessionIdForNative || !autoTarget || !this.#releaseLegacyLock) return;
    const root = path.join(legacyDataDir, "claude-bridge");
    for (const legacy of this.#legacyBindings) {
      const { nativeId, workspace, registeredWorkspace } = legacy.target;
      if (
        this.#closed ||
        this.#declined.has(nativeId) ||
        this.#legacyBindings.some((other) => other !== legacy && other.target.nativeId === nativeId)
      )
        continue;
      try {
        const legacyFile = path.join(root, `${legacy.bindingId}.credential.json`);
        const credential = z
          .object({
            protocol: z.literal(1),
            nativeId: uuid,
            cwd: z.string(),
            bindingId: uuid,
            token: z.string(),
          })
          .parse(readLegacyJson(legacyFile));
        if (credential.nativeId !== nativeId || credential.cwd !== workspace) continue;
        const matchesCredential = (row: Binding) =>
          credential.bindingId === row.bindingId &&
          timingSafeEqual(digest(credential.token), digest(row.token));
        const sessionId = sessionIdForNative(nativeId);
        const canonical = this.#bindings.get(sessionId);
        const matchesLegacy = matchesCredential(legacy);
        // After migration the same old path may already hold the canonical credential.
        if (!matchesLegacy && !(canonical && !canonical.revoked && matchesCredential(canonical)))
          continue;
        const target = targetSchema.parse(await autoTarget(nativeId, workspace));
        const existing = this.#bindings.get(sessionId);
        if (
          this.#closed ||
          this.#declined.has(nativeId) ||
          target.sessionId !== sessionId ||
          target.nativeId !== nativeId ||
          target.workspace !== workspace ||
          target.registeredWorkspace !== registeredWorkspace ||
          (!matchesLegacy && existing !== canonical) ||
          (existing &&
            (existing.revoked ||
              existing.inflight ||
              stable(existing.target) !== stable(target))) ||
          (!existing &&
            (this.#bindings.size >= 64 ||
              [...this.#bindings.values()].some((row) => row.bindingId === legacy.bindingId)))
        )
          continue;
        this.#assertLegacySettled(target.sessionId);
        if (readUnknownManagedCommands(this.options.dataDir, target.sessionId).length) continue;
        this.options.validate(target, false);
        const row = existing ?? { ...legacy, target };
        if (!existing) {
          this.#bindings.set(target.sessionId, row);
          try {
            this.#save();
          } catch (error) {
            this.#bindings.delete(target.sessionId);
            throw error;
          }
        }
        // The old terminal can authenticate at the new socket with its saved path and binding.
        this.#writeCredential(row, legacyFile);
      } catch {
        // Missing workspaces, unresolved controls and unverifiable credentials stay in Dev.
      }
    }
  }
  initialize(): void {
    if (this.supported) void this.options.pluginUpdate?.start();
    if (
      this.supported &&
      !this.#registryInvalid &&
      (this.autoAvailable || [...this.#bindings.values()].some((row) => !row.revoked))
    )
      void this.#listen().catch(() => {
        this.#startupFailed = true;
      });
  }

  async management(value: Record<string, unknown>): Promise<unknown> {
    if (
      value.operation === "bridge-plugin-status" ||
      value.operation === "bridge-plugin-auto-update"
    ) {
      const input = z
        .object({
          operation: z.enum(["bridge-plugin-status", "bridge-plugin-auto-update"]),
          deviceId: z.literal(LOCAL_OWNER),
          enabled: z.boolean().optional(),
        })
        .strict()
        .refine(
          (row) => (row.operation === "bridge-plugin-auto-update") === (row.enabled !== undefined),
        )
        .parse(value);
      const updater = this.supported && !this.#closed ? this.options.pluginUpdate : undefined;
      if (input.enabled === undefined) return updater?.status() ?? null;
      if (!updater) throw new Error("claude-bridge-plugin-update-unavailable");
      return updater.setAutomatic(input.enabled);
    }
    const input = z
      .object({
        operation: z.enum([
          "bridge-status",
          "bridge-challenge",
          "bridge-disconnect",
          "bridge-auto-connect",
          "bridge-plugin-retry",
        ]),
        sessionId: z.string().min(1).max(256),
        deviceId: z.literal(LOCAL_OWNER),
        enabled: z.boolean().optional(),
      })
      .strict()
      .refine((row) => (row.operation === "bridge-auto-connect") === (row.enabled !== undefined))
      .parse(value);
    if (this.#closed) throw new Error("claude-bridge-unavailable");
    if (this.#registryInvalid) {
      if (input.operation !== "bridge-status") throw new Error("claude-bridge-registry-invalid");
      return {
        supported: false,
        connected: false,
        hasBinding: false,
        sessionId: input.sessionId,
        version: CLAUDE_BRIDGE_CLI_VERSION,
        reason: "claude-bridge-registry-invalid",
        pluginDirectory: this.options.pluginDirectory,
        installInstructions: "",
      };
    }
    if (input.operation === "bridge-disconnect") {
      this.#connectionAttempts.delete(input.sessionId);
      for (const [ticket, item] of this.#challenges)
        if (item.target.sessionId === input.sessionId) this.#challenges.delete(ticket);
      const row = this.#bindings.get(input.sessionId);
      if (row) {
        row.revoked = true;
        this.#save();
        this.#forgetReports(row);
        if (this.#contextWindows.delete(row.bindingId)) this.#saveContextWindows();
        rmSync(this.#credentialPath(row.bindingId), { force: true });
        // Respect the disconnect: automatic pairing must not reconnect this session.
        this.#declined.delete(row.target.nativeId);
        this.#declined.add(row.target.nativeId);
        this.#saveAuto();
      }
      this.#disconnect(input.sessionId);
      return { disconnected: true };
    }
    if (input.operation === "bridge-challenge") this.#assertLegacySettled(input.sessionId);
    let target: ClaudeBridgeTarget;
    try {
      const previous =
        input.operation === "bridge-status" ? this.#bindings.get(input.sessionId) : undefined;
      target =
        previous && !previous.revoked
          ? await this.options
              .target(input.sessionId, previous.target.nativeId, previous.target.workspace)
              .catch(() => this.options.target(input.sessionId))
          : await this.options.target(input.sessionId);
    } catch {
      if (input.operation === "bridge-challenge")
        throw new Error("claude-bridge-session-unavailable");
      return {
        supported: false,
        connected: false,
        hasBinding: false,
        sessionId: input.sessionId,
        version: CLAUDE_BRIDGE_CLI_VERSION,
        reason: "claude-bridge-session-unavailable",
        pluginDirectory: this.options.pluginDirectory,
        installInstructions: "",
      };
    }
    this.options.validate(target, false);
    if (input.operation === "bridge-plugin-retry") {
      if (!this.supported || !this.options.pluginUpdate)
        throw new Error("claude-bridge-plugin-update-unavailable");
      return this.options.pluginUpdate.retry();
    }
    if (input.operation === "bridge-auto-connect") {
      // Default on: only workspaces the user switched off are recorded.
      this.#disabledWorkspaces.delete(target.workspaceId);
      if (!input.enabled) this.#disabledWorkspaces.add(target.workspaceId);
      this.#saveAuto();
      return { sessionId: input.sessionId, autoConnect: this.#autoStatus(target) };
    }
    if (input.operation === "bridge-status") {
      const row = this.#bindings.get(input.sessionId);
      let hasBinding = false;
      if (this.supported && row && !row.revoked && stable(row.target) === stable(target)) {
        try {
          this.options.validate(row.target, false, row.bindingId);
          hasBinding = true;
        } catch {
          // A retained credential is recoverable only for its still-valid original identity.
        }
      }
      const connected = hasBinding && this.#online(input.sessionId);
      const pluginUpdate = this.supported ? this.options.pluginUpdate?.status() : undefined;
      return {
        supported: this.supported,
        connected,
        hasBinding,
        sessionId: input.sessionId,
        version: CLAUDE_BRIDGE_CLI_VERSION,
        connectionError: this.#connectionAttempts.get(input.sessionId)?.error,
        connectionCliVersion: this.#connectionAttempts.get(input.sessionId)?.cliVersion,
        connectionMissingCapabilities: this.#connectionAttempts.get(input.sessionId)
          ?.missingCapabilities,
        bridgeCompatibility: hasBinding
          ? (compatibilityStatus(this.#connections.get(input.sessionId)) ?? null)
          : null,
        autoConnect: this.#autoStatus(target),
        reason: this.supported
          ? this.#startupFailed
            ? "claude-bridge-unavailable"
            : connected
              ? undefined
              : "claude-bridge-not-connected"
          : "platform-unsupported",
        pluginDirectory: this.options.pluginDirectory,
        pluginUpdate,
        installInstructions: pluginUpdate?.installInstructions ?? "",
      };
    }
    if (!this.supported) throw new Error("platform-unsupported");
    if (
      this.#bindings.get(input.sessionId)?.inflight ||
      readUnknownManagedCommands(this.options.dataDir, input.sessionId).length > 0
    )
      throw new Error("control-outcome-unconfirmed");
    await this.#listen();
    for (const [ticket, item] of this.#challenges)
      // Retain an expired code briefly so a late attempt can be attributed to
      // its session and explained in the desktop panel. The map remains bounded.
      if (item.expires + 300_000 < Date.now() || item.target.sessionId === input.sessionId) {
        this.#challenges.delete(ticket);
        if (this.#connectionAttempts.get(item.target.sessionId)?.challenge === item)
          this.#connectionAttempts.delete(item.target.sessionId);
      }
    if (this.#challenges.size >= 64) throw new Error("claude-bridge-busy");
    const ticket = randomBytes(32).toString("hex");
    const expires = Date.now() + 120_000;
    const attempt = { target, expires };
    this.#challenges.set(ticket, attempt);
    this.#connectionAttempts.set(input.sessionId, { challenge: attempt });
    const challenge = Buffer.from(
      JSON.stringify({ protocol: 1, socketPath: this.#socketPath, ticket }),
    ).toString("base64url");
    return {
      challenge,
      expiresAt: new Date(expires).toISOString(),
      instructions: `/agentkib-connect ${challenge}`,
    };
  }

  #online(id: string): boolean {
    const connection = this.#connections.get(id);
    return (
      connection?.snapshot?.capabilities.read === true &&
      Date.now() - connection.lastSeen <= HEARTBEAT_MS
    );
  }
  #sourceReadable(row: Binding): boolean {
    if (row.revoked) return false;
    try {
      this.options.validate(row.target, false, row.bindingId);
      return true;
    } catch {
      return false;
    }
  }
  #readTranscriptObservation(
    row: Binding,
    snapshot: ClaudeBridgeSnapshot | null,
  ): ClaudeTranscriptObservation | undefined {
    try {
      const observation = this.options.observation?.(row.target);
      const started = this.#compactStartedAt.get(row);
      if (
        observation?.usage.available &&
        ((started !== undefined && !(Date.parse(observation.usage.updatedAt ?? "") >= started)) ||
          (snapshot?.model && snapshot.model !== observation.model))
      )
        return { ...observation, usage: { available: false, state: "unavailable" } };
      return observation;
    } catch {
      // Missing optional metadata never changes the native execution lease.
      return undefined;
    }
  }

  #windowFromSnapshot(
    row: Binding,
    observation: ClaudeTranscriptObservation | undefined,
    snapshot: ClaudeBridgeSnapshot | null,
  ): ContextWindowEntry | undefined {
    const report = snapshot?.usage;
    if (!report?.window || !snapshot?.capabilities.read || snapshot.compacting) return undefined;
    const anchor = transcriptWindowAnchor(observation);
    if (!anchor || report.observedAt < Date.parse(anchor.updatedAt)) return undefined;
    // A model-less report can establish the window only for this exact compaction boundary.
    const entry = contextWindowEntrySchema.safeParse({
      bindingId: row.bindingId,
      anchor,
      window: report.window,
      reportedModel: snapshot.model ?? null,
    });
    return entry.success ? entry.data : undefined;
  }

  #rememberContextWindow(row: Binding, snapshot: ClaudeBridgeSnapshot): void {
    // The plugin sends a cleared snapshot before releasing its lease on exit.
    // Binding revocation is handled separately from that terminal lifecycle event.
    if (snapshot.status === "disconnected" && !snapshot.capabilities.read) return;
    const previous = this.#contextWindows.get(row.bindingId);
    const started = this.#compactStartedAt.get(row);
    const invalid =
      snapshot.compacting ||
      !snapshot.capabilities.read ||
      (previous &&
        ((snapshot.model && snapshot.model !== previous.anchor.model) ||
          (snapshot.usage?.window && snapshot.usage.window !== previous.window) ||
          (started !== undefined && Date.parse(previous.anchor.updatedAt) < started)));
    // An unchanged live window needs no new transcript read on each streamed
    // snapshot. The first report and the next idle snapshot capture the anchor.
    const observed =
      snapshot.usage?.window && (!previous || invalid || !snapshot.currentTurnId)
        ? this.#windowFromSnapshot(row, this.#readTranscriptObservation(row, snapshot), snapshot)
        : undefined;
    const next = observed ?? (invalid ? undefined : previous);
    if (stable(next) === stable(previous)) return;
    if (next) this.#contextWindows.set(row.bindingId, next);
    else this.#contextWindows.delete(row.bindingId);
    this.#saveContextWindows();
  }

  #retainedWindow(
    row: Binding,
    observation: ClaudeTranscriptObservation | undefined,
    snapshot: ClaudeBridgeSnapshot | null,
  ): ContextWindowEntry | undefined {
    if (snapshot?.compacting || snapshot?.capabilities.read === false) return undefined;
    const previous = this.#contextWindows.get(row.bindingId);
    if (!previous || (snapshot?.model && snapshot.model !== previous.anchor.model))
      return undefined;
    const anchor = transcriptWindowAnchor(observation);
    const started = this.#compactStartedAt.get(row);
    return anchor &&
      (started === undefined || Date.parse(anchor.updatedAt) >= started) &&
      stable(anchor) === stable(previous.anchor)
      ? previous
      : undefined;
  }

  /** The managed read may reuse a window while the original executor is offline. */
  retainedUsage(
    sessionId: string,
    source: Pick<ClaudeBridgeTarget, "nativeId" | "workspace" | "workspaceId">,
    observation: ClaudeTranscriptObservation,
    readEarlier?: () => ClaudeTranscriptObservation,
  ): ContextUsage | undefined {
    const row = this.#bindings.get(sessionId);
    const cached = row && this.#contextWindows.get(row.bindingId);
    if (
      !row ||
      !cached ||
      observation.usage.contextWindow !== undefined ||
      source.nativeId !== row.target.nativeId ||
      source.workspace !== row.target.workspace ||
      source.workspaceId !== row.target.workspaceId ||
      !this.#sourceReadable(row)
    )
      return undefined;
    const window = this.#retainedWindow(row, observation, null);
    if (window) return withContextWindow(observation.usage, window);
    // A saved window can refer to a compaction older than the usual history tail.
    if (
      observation.usage.available &&
      (observation.usage.updatedAt !== cached.anchor.updatedAt ||
        observation.usage.usedTokens !== cached.anchor.usedTokens)
    )
      return undefined;
    const earlier = readEarlier?.();
    const retained = this.#retainedWindow(row, earlier, null);
    return earlier && retained ? withContextWindow(earlier.usage, retained) : undefined;
  }

  #observation(
    row: Binding,
    snapshot: ClaudeBridgeSnapshot | null,
  ): ClaudeTranscriptObservation | undefined {
    const observation = this.#readTranscriptObservation(row, snapshot);
    if (!observation || observation.usage.contextWindow !== undefined) return observation;
    const window =
      this.#windowFromSnapshot(row, observation, snapshot) ??
      this.#retainedWindow(row, observation, snapshot);
    return window
      ? { ...observation, usage: withContextWindow(observation.usage, window) }
      : observation;
  }
  #permission(
    row: Binding,
    observation?: ClaudeTranscriptObservation,
  ): ClaudeObservedPermissionMode | null {
    if (observation?.permissionMode !== undefined) return observation.permissionMode;
    try {
      return this.options.permission?.(row.target) ?? null;
    } catch {
      return null;
    }
  }
  #usage(
    snapshot: ClaudeBridgeSnapshot | null,
    observation: ClaudeTranscriptObservation | undefined,
    revision: number | undefined,
    compactStartedAt: number | undefined,
  ): ContextUsage {
    if (snapshot?.compacting)
      return {
        available: true,
        state: "pending",
        reason: "session-compacting",
        revision,
        ...(compactStartedAt !== undefined
          ? { updatedAt: new Date(compactStartedAt).toISOString() }
          : {}),
      };
    if (snapshot?.usage?.tokens !== null && snapshot?.usage?.tokens !== undefined) {
      const report = snapshot.usage;
      const window = report.window;
      const full = window !== null && window > 0;
      if (
        !full &&
        observation?.usage.usedTokens === report.tokens &&
        observation.usage.contextWindow !== undefined
      )
        return { ...observation.usage, revision };
      return {
        available: true,
        state: full ? "ready" : "stale",
        usedTokens: report.tokens!,
        ...(full
          ? {
              contextWindow: window,
              percent: Math.min(100, (report.tokens! / window) * 100),
            }
          : { reason: "model-context-window-unavailable" }),
        revision,
        updatedAt: new Date(report.observedAt).toISOString(),
      };
    }
    if (observation?.usage.available) return { ...observation.usage };
    if (snapshot?.usage?.window && snapshot.usage.window > 0)
      return {
        available: true,
        state: "pending",
        contextWindow: snapshot.usage.window,
        reason: "usage-not-reported",
        revision,
        updatedAt: new Date(snapshot.usage.observedAt).toISOString(),
      };
    if (compactStartedAt !== undefined)
      return { available: true, state: "pending", reason: "usage-not-reported", revision };
    return { available: false, state: "unavailable", reason: "usage-unavailable" };
  }
  live(id: string, controls: boolean): Record<string, unknown> {
    const row = this.#bindings.get(id);
    if (!row) throw new Error("session-unavailable");
    let valid = false;
    try {
      this.options.validate(row.target, false, row.bindingId);
      valid = true;
    } catch {
      /* Invalid sources never expose cached private content. */
    }
    const connection = this.#connections.get(id);
    const online = valid && !row.revoked && this.#online(id);
    const snapshot = online ? connection!.snapshot! : null;
    const observation =
      valid &&
      !row.revoked &&
      !snapshot?.compacting &&
      (snapshot?.usage?.tokens == null ||
        (!snapshot.usage.window && this.#contextWindows.has(row.bindingId)))
        ? this.#observation(row, snapshot)
        : undefined;
    const unknownCommands = readUnknownManagedCommands(this.options.dataDir, id).filter(
      (command) => command.requestId !== connection?.pending?.requestId,
    );
    const uncertain =
      unknownCommands.some((command) => command.evidence?.operation !== "open-model-picker") ||
      (row.inflight !== null &&
        (!online || !row.inflight.turnId || snapshot?.currentTurnId !== row.inflight.turnId));
    const gap = connection?.gap === true;
    const pickerOpen =
      snapshot?.modelPickerOpen === true &&
      !snapshot.currentTurnId &&
      !snapshot.waiting &&
      !snapshot.compacting;
    const attempt = this.#connectionAttempts.get(id);
    const connectionFailure: ClaudeBridgeConnectionFailure | null =
      valid && !row.revoked && !online && attempt?.bindingId === row.bindingId && attempt.error
        ? {
            reason: attempt.error,
            cliVersion: attempt.cliVersion,
            missingCapabilities: attempt.missingCapabilities,
          }
        : null;
    const reason = !valid
      ? "claude-bridge-session-unavailable"
      : uncertain
        ? "control-outcome-unconfirmed"
        : !online
          ? (connectionFailure?.reason ?? "claude-bridge-disconnected")
          : gap
            ? "claude-bridge-event-gap"
            : snapshot?.compacting
              ? "session-compacting"
              : snapshot?.waiting === "permission"
                ? "claude-terminal-approval"
                : snapshot?.waiting === "question"
                  ? "claude-terminal-question"
                  : snapshot?.waiting === "unknown"
                    ? "claude-terminal-permission-unconfirmed"
                    : pickerOpen
                      ? "claude-model-picker-open"
                      : snapshot?.status === "running" && !snapshot.currentTurnId
                        ? "claude-follower-turn-unconfirmed"
                        : snapshot?.status === "idle" &&
                            !snapshot.capabilities.send &&
                            // Waiting messages go out next; a direct send waits for them.
                            snapshot.outbox.length === 0
                          ? "claude-follower-send-unverified"
                          : undefined;
    // One command at a time reaches the plugin; every mode also needs a verified lease.
    const controllable =
      controls &&
      online &&
      !uncertain &&
      !gap &&
      !connection?.pending &&
      !snapshot?.compacting &&
      !pickerOpen;
    const status = uncertain
      ? "outcome-unknown"
      : !online || gap
        ? "unsupported"
        : snapshot?.waiting === "permission"
          ? "awaiting-approval"
          : snapshot?.waiting === "question"
            ? "waiting-input"
            : !pickerOpen &&
                (snapshot?.compacting ||
                  snapshot?.status === "running" ||
                  snapshot?.status === "waiting")
              ? "running"
              : "idle";
    const approval = snapshot?.pendingApprovalDetails;
    return {
      sessionId: id,
      sourceSessionId: row.target.nativeId,
      workspaceId: row.target.workspaceId,
      runtimeBootId: this.options.bootId,
      executionMode: "claude-follower",
      executionLocation: online ? "terminal" : null,
      ownershipReason: null,
      ...(online && typeof connection?.leadReportsPaused === "boolean"
        ? { leadReportsPaused: connection.leadReportsPaused }
        : {}),
      // The plugin takes messages from here. Which mode can go now is in the *Enabled flags:
      // a send needs an idle terminal, a steer a running turn, a queued message neither.
      terminalSend:
        !pickerOpen &&
        (snapshot?.capabilities.send === true ||
          snapshot?.capabilities.steer === true ||
          snapshot?.capabilities.queue === true),
      connectionGeneration: connection?.leaseId ?? this.options.bootId,
      cliVersion: connection ? `${connection.identity.cliVersion} (Claude Code)` : undefined,
      bridgeCompatibility: valid ? (compatibilityStatus(connection) ?? null) : null,
      bridgeConnectionFailure: connectionFailure,
      revision: connection?.revision ?? this.#revision,
      status,
      ...(snapshot?.compacting ? { activity: "compacting" } : {}),
      reason,
      turnId: snapshot?.currentTurnId ?? null,
      sendEnabled:
        controllable && !row.inflight && snapshot?.status === "idle" && snapshot.capabilities.send,
      steerEnabled:
        controllable && !!snapshot?.currentTurnId && snapshot.capabilities.steer === true,
      queueEnabled: controllable && snapshot?.capabilities.queue === true,
      modelPickerEnabled:
        controllable &&
        !unknownCommands.some((command) => command.evidence?.operation === "open-model-picker") &&
        !row.inflight &&
        snapshot?.status === "idle" &&
        !snapshot.waiting &&
        !snapshot.currentTurnId &&
        snapshot.outbox.length === 0 &&
        snapshot.capabilities.modelPicker === true,
      // Withdrawing needs no writable terminal: an unknown message stays until it is deleted.
      queueEditEnabled: controllable && (snapshot?.outbox.length ?? 0) > 0,
      queuedCount: snapshot?.outbox.length ?? 0,
      stopEnabled:
        controls &&
        online &&
        !uncertain &&
        !gap &&
        !connection?.pending &&
        !!snapshot?.currentTurnId &&
        snapshot.capabilities.stop,
      approvals:
        status === "awaiting-approval" && approval && approval.turnId === snapshot?.currentTurnId
          ? [
              {
                requestId: approval.toolUseId,
                turnId: approval.turnId,
                method: "claude/can_use_tool",
                toolName: approval.toolName,
                input: approval.input,
                cwd: row.target.workspace,
                supported: false,
                availableDecisions: ["allow", "deny"],
              },
            ]
          : [],
      questions:
        status === "waiting-input" ? terminalQuestions(snapshot, connection?.turnTools) : [],
      ...(status === "waiting-input" && snapshot?.pendingQuestionSummary
        ? { terminalQuestionSummary: snapshot.pendingQuestionSummary }
        : {}),
      ...(connection?.terminalSubagentsObserved
        ? {
            activities: terminalSubagentActivities(
              gap ? undefined : snapshot?.terminalSubagents,
              id,
              connection.leaseId,
            ),
          }
        : {}),
      permission: { mode: valid && !row.revoked ? this.#permission(row, observation) : null },
      streamText: sanitizeSessionText(snapshot?.streamText ?? "", { value: 0 }),
      usage: this.#usage(
        snapshot,
        observation,
        connection?.revision,
        valid && !row.revoked ? this.#compactStartedAt.get(row) : undefined,
      ),
    };
  }
  workerObservation(id: string): Record<string, unknown> {
    const live = this.live(id, false);
    const activity = this.#connections.get(id)?.snapshot?.terminalWorkerActivity;
    if (live.status !== "running" || !live.turnId || !activity) return live;
    return { ...live, commands: activity.commands, workerProgress: String(activity.revision) };
  }

  capabilities(id: string, controls: boolean): Record<string, unknown> {
    const live = this.live(id, controls);
    const readable = this.#sourceReadable(this.#bindings.get(id)!);
    const flags: Record<string, boolean> = {
      send: live.sendEnabled === true,
      stop: live.stopEnabled === true,
      inspect: true,
      usage: true,
      context: false,
      files: true,
      reconcile: true,
      release: false,
      approve: false,
      answer: false,
      attachments:
        this.#connections.get(id)?.snapshot?.capabilities.attachments === true &&
        (live.sendEnabled === true || live.steerEnabled === true || live.queueEnabled === true),
      steer: live.steerEnabled === true,
      resources: readable,
      settings: false,
      "settings-state": readable,
      "open-model-picker": live.modelPickerEnabled === true,
      queue: live.queueEnabled === true,
      "queue-list": live.executionLocation === "terminal",
      "queue-add": live.queueEnabled === true,
      "queue-update": false,
      "queue-delete": live.queueEditEnabled === true,
      "queue-reorder": false,
      "queue-resume": false,
      "queue-pause": false,
      fork: false,
      rename: controls && readable,
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
      executionMode: "claude-follower",
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
                  live.reason ??
                  (key === "settings"
                    ? "claude-follower-settings-unavailable"
                    : key === "context"
                      ? "follower-resource-input-unsupported"
                      : key === "goal" || key.startsWith("goal-")
                        ? "native-operation-not-integrated"
                        : key === "approve"
                          ? "claude-terminal-approval"
                          : key === "answer"
                            ? "claude-terminal-question"
                            : key === "attachments"
                              ? "claude-follower-attachments-unavailable"
                              : key === "send" &&
                                  !this.#connections.get(id)?.snapshot?.capabilities.send
                                ? (live.reason ??
                                  (live.status === "idle" &&
                                  !this.#connections.get(id)?.snapshot?.outbox.length
                                    ? "claude-follower-send-unverified"
                                    : "session-busy"))
                                : "operation-unavailable"),
              },
        ]),
      ),
    };
  }
  #sessionScope(value: Record<string, unknown>): ClaudeBridgeSessionScope {
    const id = z.string().min(1).max(256).parse(value.sessionId);
    this.#assertLegacySettled(id);
    const row = this.#bindings.get(id);
    if (!row) throw new Error("session-unavailable");
    return { value, id, row, controls: value.experimentalEnabled === true };
  }

  #sessionOperation(
    run: (scope: ClaudeBridgeSessionScope) => unknown,
  ): ClaudeBridgeSessionOperation {
    return async (value) => run(this.#sessionScope(value));
  }

  renameLocalTitle(
    value: Record<string, unknown>,
    commit: (scope: ClaudeLocalTitleScope) => { receipt: unknown; changed: boolean },
  ): Promise<unknown> {
    return this.#sessionOperation(({ id, row }) => {
      if (!this.#sourceReadable(row)) throw new Error("session-unavailable");
      const connection = this.#connections.get(id);
      const result = commit({
        sessionId: id,
        workspaceId: row.target.workspaceId,
        revision: connection?.revision ?? this.#revision,
        executionMode: "claude-follower",
      });
      if (result.changed) {
        const revision = ++this.#revision;
        if (connection) connection.revision = revision;
        this.#publish(id);
      }
      return result.receipt;
    })(value);
  }

  readonly #sessionControl = this.#sessionOperation(({ value, row }) => this.#control(value, row));

  /** Select by the original operation and keep the request intact for receipt validation. */
  readonly sessionOperations: ReadonlyMap<string, ClaudeBridgeSessionOperation> = new Map([
    ["live", this.#sessionOperation(({ id, controls }) => this.live(id, controls))],
    ["capabilities", this.#sessionOperation(({ id, controls }) => this.capabilities(id, controls))],
    [
      "inspect",
      this.#sessionOperation(({ id, row, controls }) => ({
        sessionId: id,
        sourceSessionId: row.target.nativeId,
        workspaceId: row.target.workspaceId,
        live: this.live(id, controls),
        reconciled: false,
      })),
    ],
    ["usage", this.#sessionOperation(({ id }) => this.live(id, false).usage)],
    [
      "settings-state",
      this.#sessionOperation(({ id, row }) => {
        if (!this.#sourceReadable(row)) throw new Error("session-unavailable");
        const snapshot = this.#online(id) ? this.#connections.get(id)?.snapshot : null;
        const observation =
          !snapshot?.compacting && (!snapshot?.model || snapshot.usage?.tokens == null)
            ? this.#observation(row, snapshot ?? null)
            : undefined;
        const model = snapshot?.model ?? null;
        const readonly = { available: false, reason: "claude-follower-settings-unavailable" };
        return {
          available: true,
          sessionId: id,
          executionMode: "claude-follower",
          revision: this.#connections.get(id)?.revision ?? this.#revision,
          current: {
            model,
            effort: null,
            permissionMode: this.#permission(row, observation),
            ...(snapshot?.usage?.window && snapshot.usage.window > 0
              ? { maxContextTokens: snapshot.usage.window }
              : {}),
          },
          ...(model ? { selected: { model }, applicationStatus: "confirmed" } : {}),
          ...(observation?.model ? { historicalSettings: { model: observation.model } } : {}),
          ...(observation?.usage.available ? { historicalUsage: observation.usage } : {}),
          defaults: {},
          models: model ? [{ id: model, name: model, efforts: [] }] : [],
          permissionModes: [],
          policies: [],
          serviceTiers: [],
          writable: Object.fromEntries(
            [
              "model",
              "effort",
              "mode",
              "policy",
              "serviceTier",
              "permissionMode",
              "restoreDefaults",
            ].map((key) => [key, readonly]),
          ),
        };
      }),
    ],
    [
      "resources",
      this.#sessionOperation(({ id, row }) => {
        if (!this.#sourceReadable(row)) throw new Error("session-unavailable");
        return {
          available: true,
          sessionId: id,
          executionMode: "claude-follower",
          revision: this.#connections.get(id)?.revision ?? this.#revision,
          skills: [],
          plugins: [],
          apps: [],
          contextReferences: { supportedTypes: [] },
        };
      }),
    ],
    [
      "context",
      this.#sessionOperation(({ row }) => {
        this.options.validate(row.target, false, row.bindingId);
        return {
          available: true,
          executionMode: "claude-follower",
          cwd: row.target.workspace,
          projectId: null,
          branchAtCreation: null,
        };
      }),
    ],
    [
      "reconcile",
      this.#sessionOperation(({ id, controls, row }) => ({
        accepted: false,
        completed: false,
        reconciled: false,
        sessionId: id,
        live: this.live(id, controls),
        reason: row.inflight ? "control-outcome-unconfirmed" : "read-only-reconciliation",
      })),
    ],
    ["queue-list", this.#sessionOperation(({ id }) => this.#queueList(id))],
    ["send", this.#sessionControl],
    ["stop", this.#sessionControl],
    ["steer", this.#sessionControl],
    ["queue-add", this.#sessionControl],
    ["queue-delete", this.#sessionControl],
    ["open-model-picker", this.#sessionControl],
  ]);

  async request(value: Record<string, unknown>): Promise<unknown> {
    const { operation } = value;
    const handler =
      typeof operation === "string" ? this.sessionOperations.get(operation) : undefined;
    if (handler) return handler(value);
    // Legacy callers validate the target before receiving an unsupported-operation error.
    this.#sessionScope(value);
    throw new Error("operation-unavailable");
  }
  /** The terminal's waiting messages, in the shape of a managed queue; read-only. */
  #queueList(id: string): Record<string, unknown> {
    const live = this.live(id, false);
    const snapshot = this.#online(id) ? this.#connections.get(id)?.snapshot : null;
    return {
      available: true,
      revision: live.revision,
      paused: false,
      requiresResume: false,
      reason: null,
      data: (snapshot?.outbox ?? []).map((item) => ({
        id: item.id,
        kind: item.kind,
        input: [{ type: "text", text: item.text }],
        status: item.status === "dispatching" ? "dispatched" : item.status,
        createdAt: new Date(item.createdAt).toISOString(),
        requiresAttachments: false,
      })),
      nextCursor: null,
    };
  }
  receipt(value: unknown): unknown {
    if (
      !value ||
      typeof value !== "object" ||
      !("executionMode" in value) ||
      value.executionMode !== "claude-follower"
    )
      return value;
    const result = value as Record<string, unknown>;
    const ack = result.ack as Record<string, unknown> | undefined;
    return { ...result, completionObserved: ack?.completed === true };
  }

  /** Existing host authorization invalidation also fences native commands not yet delivered. */
  invalidate(deviceId?: string, sessionId?: string): void {
    for (const [id, connection] of this.#connections) {
      const pending = connection.pending;
      if (
        !pending ||
        pending.delivered ||
        (sessionId && id !== sessionId) ||
        (deviceId && pending.deviceId !== deviceId)
      )
        continue;
      connection.pending = null;
      clearTimeout(pending.timer);
      const row = this.#bindings.get(id)!;
      if (row.inflight?.commandId === pending.command.commandId) row.inflight = null;
      this.#save();
      const result = this.#result(row, pending.requestId, "not-dispatched");
      pending.receipt.finish(result);
      pending.resolve(result);
      connection.wake?.();
      this.#publish(id);
    }
  }

  async #control(value: Record<string, unknown>, row: Binding): Promise<Record<string, unknown>> {
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
      "historyReferences",
      "historyInputHash",
      "publicInputHash",
      "queuedSubmissionId",
    ]);
    if (
      Object.keys(value).some((key) => !allowed.has(key)) ||
      (Array.isArray(value.input) &&
        !["send", "steer", "queue-add"].includes(String(value.operation))) ||
      (value.operation === "open-model-picker" &&
        ["text", "input", "turnId", "queuedSubmissionId"].some((key) =>
          Object.hasOwn(value, key),
        )) ||
      !validHistoryControl({ ...value, operation: String(value.operation) })
    )
      throw new Error("invalid-managed-control");
    const requestId = uuid.parse(value.requestId);
    const deviceId = z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_:-]+$/)
      .parse(value.deviceId);
    const revision = z.number().safe().int().nonnegative().parse(value.expectedRevision);
    if (value.publicInputHash !== undefined)
      z.string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(value.publicInputHash);
    const receipt = admitControlReceipt(
      this.options.dataDir,
      requestId,
      stable({ ...value, runtimeBootId: undefined }),
    );
    if (receipt.previous) return receipt.previous;
    if (
      this.#closed ||
      !this.supported ||
      value.experimentalEnabled !== true ||
      value.runtimeBootId !== this.options.bootId
    )
      throw new Error("control-unavailable");
    this.options.validate(row.target, true, row.bindingId);
    const live = this.live(row.target.sessionId, true);
    const connection = this.#connections.get(row.target.sessionId);
    if (!connection?.snapshot || row.revoked || !this.#online(row.target.sessionId))
      throw new Error("claude-bridge-disconnected");
    if (revision !== live.revision) throw new Error("stale-Claude-revision");
    if (connection.pending) throw new Error("session-busy");
    const messageText = (): string => {
      let text = value.text ?? value.input;
      if (Array.isArray(value.input)) {
        const parsed = terminalAttachmentInputSchema.safeParse(value.input);
        if (value.text !== undefined || !parsed.success) throw new Error("invalid-text-input");
        const [input] = parsed.data;
        if (
          connection.snapshot?.capabilities.attachments !== true ||
          input.cwd !== row.target.workspace
        )
          throw new Error("claude-follower-attachments-unavailable");
        text = input.text;
      }
      if (
        typeof text !== "string" ||
        !text.trim() ||
        text.length > 16_000 ||
        Buffer.byteLength(text) > 16_384
      )
        throw new Error("invalid-text-input");
      return text;
    };
    let command: ClaudeBridgeCommand;
    if (value.operation === "send") {
      if (live.sendEnabled !== true) throw new Error("session-busy");
      command = {
        commandId: randomUUID(),
        kind: "send",
        requestId,
        text: messageText(),
        expectedRevision: connection.snapshot.revision,
      };
    } else if (value.operation === "open-model-picker") {
      if (live.modelPickerEnabled !== true) throw new Error("operation-unavailable");
      command = {
        commandId: randomUUID(),
        kind: "open-model-picker",
        expectedRevision: connection.snapshot.revision,
      };
    } else if (value.operation === "steer") {
      // A steer joins the turn the person saw. One that has ended is refused, not resent.
      if (!connection.snapshot.currentTurnId || value.turnId !== connection.snapshot.currentTurnId)
        throw new Error("stale-turn");
      if (live.steerEnabled !== true) throw new Error("session-busy");
      command = {
        commandId: randomUUID(),
        kind: "steer",
        requestId,
        text: messageText(),
        turnId: uuid.parse(value.turnId),
        expectedRevision: connection.snapshot.revision,
      };
    } else if (value.operation === "queue-add") {
      if (live.queueEnabled !== true) throw new Error("session-busy");
      command = {
        commandId: randomUUID(),
        kind: "queue",
        requestId,
        text: messageText(),
        expectedRevision: connection.snapshot.revision,
      };
    } else if (value.operation === "queue-delete") {
      if (live.queueEditEnabled !== true) throw new Error("session-busy");
      const itemId = uuid.parse(value.queuedSubmissionId);
      const item = connection.snapshot.outbox.find((entry) => entry.id === itemId);
      if (!item || !["pending", "unknown"].includes(item.status))
        throw new Error("queue-item-unavailable");
      command = {
        commandId: randomUUID(),
        kind: "cancel",
        itemId,
        expectedRevision: connection.snapshot.revision,
      };
    } else {
      if (live.stopEnabled !== true || value.turnId !== connection.snapshot.currentTurnId)
        throw new Error("stale-turn");
      command = {
        commandId: randomUUID(),
        kind: "stop",
        turnId: uuid.parse(value.turnId),
        expectedRevision: connection.snapshot.revision,
      };
    }
    const evidence = {
      operation: value.operation,
      commandId: command.commandId,
      bindingId: row.bindingId,
      nativeId: row.target.nativeId,
      workspaceId: row.target.workspaceId,
      runtimeBootId: this.options.bootId,
      expectedRevision: revision,
      turnId: value.turnId ?? null,
      executionMode: "claude-follower",
      ...(value.historyInputHash ? { historyInputHash: value.historyInputHash } : {}),
      ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
    };
    const prior = receipt.claim(row.target.sessionId, deviceId, evidence);
    if (prior) return prior;
    // The person wrote to a terminal Project Agent from AgentKib: as when they type there.
    if (command.kind === "send" || command.kind === "steer" || command.kind === "queue")
      this.#leadSpoke(connection, row.target.sessionId);
    if (command.kind === "send") {
      row.inflight = { requestId, commandId: command.commandId, turnId: null };
      this.#save();
    }
    return this.#queueCommand(row, connection, command, requestId, deviceId, receipt);
  }

  #queueCommand(
    row: Binding,
    connection: Connection,
    command: ClaudeBridgeCommand,
    requestId: string,
    deviceId: string,
    receipt: Pending["receipt"],
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = connection.pending;
        if (!pending || pending.command.commandId !== command.commandId) return;
        connection.pending = null;
        const unknown = pending.delivered;
        if (!unknown) {
          if (row.inflight?.commandId === command.commandId) row.inflight = null;
          this.#save();
        }
        const result = this.#result(row, requestId, unknown ? "unknown" : "not-dispatched");
        if (!unknown) pending.receipt.finish(result);
        resolve(result);
        this.#publish(row.target.sessionId);
      }, this.options.commandTimeoutMs ?? 12_000);
      timer.unref();
      connection.pending = {
        command,
        requestId,
        deviceId,
        receipt,
        delivered: false,
        resolve,
        timer,
      };
      connection.wake?.();
    });
  }
  #result(
    row: Binding,
    requestId: string,
    outcome: string,
    completed = false,
  ): Record<string, unknown> {
    return {
      accepted: outcome === "accepted",
      completed,
      requestId,
      sessionId: row.target.sessionId,
      runtimeBootId: this.options.bootId,
      controlOutcome: outcome,
      ...(outcome === "unknown" ? { reason: "control-outcome-unconfirmed" } : {}),
      live: this.live(row.target.sessionId, true),
    };
  }

  #credentialPath(bindingId: string): string {
    return path.join(this.root, `${bindingId}.credential.json`);
  }
  /** Creates the binding for a verified pairing, by one-time code or automatically. */
  #bind(target: ClaudeBridgeTarget, hello: ClaudeBridgeIdentity, auto: boolean) {
    this.#assertLegacySettled(target.sessionId);
    const old = this.#bindings.get(target.sessionId);
    if (
      old?.inflight ||
      readUnknownManagedCommands(this.options.dataDir, target.sessionId).length > 0
    )
      throw new Error("control-outcome-unconfirmed");
    // The limit bounds retained active or unresolved bindings, not every
    // session ever connected. Never discard evidence for an unknown command.
    for (const [id, binding] of this.#bindings) {
      if (
        binding.revoked &&
        !binding.inflight &&
        readUnknownManagedCommands(this.options.dataDir, id).length === 0
      ) {
        this.#bindings.delete(id);
        rmSync(this.#credentialPath(binding.bindingId), { force: true });
        this.#forgetReports(binding);
      }
    }
    if (auto && !old && this.#bindings.size >= 64) this.#evictAutoBinding();
    this.#disconnect(target.sessionId);
    const row: Binding = {
      version: 1,
      bindingId: randomUUID(),
      target,
      token: randomBytes(32).toString("hex"),
      revoked: false,
      cliVersion: hello.cliVersion,
      inflight: null,
    };
    if (this.#bindings.size >= 64 && !old) throw new Error("claude-bridge-binding-limit");
    this.#bindings.set(target.sessionId, row);
    this.#save();
    this.#writeCredential(row);
    if (old) {
      if (this.#contextWindows.delete(old.bindingId)) this.#saveContextWindows();
      this.#forgetReports(old);
      rmSync(this.#credentialPath(old.bindingId), { force: true });
      this.#autoBindings.delete(old.bindingId);
    }
    if (auto) this.#autoBindings.add(row.bindingId);
    // A new one-time code is explicit consent again after a disconnect.
    else this.#declined.delete(target.nativeId);
    this.#saveAuto();
    this.#connectionAttempts.delete(target.sessionId);
    const connection = this.#newConnection(row, hello);
    return {
      protocol: 1,
      bindingId: row.bindingId,
      token: row.token,
      leaseId: connection.leaseId,
      credentialPath: this.#credentialPath(row.bindingId),
      features: claudeBridgeFeatures(!!this.options.lead),
    };
  }

  /** Whether this session's terminal can take a Project Agent's tools now. */
  leadCapable(sessionId: string): boolean {
    return this.#connections.get(sessionId)?.leadTools === true;
  }

  *runningSessionIds(): Iterable<string> {
    for (const [id, connection] of this.#connections) {
      if (!connection.gap && connection.snapshot?.status === "running" && this.#online(id))
        yield id;
    }
  }

  /** An established lead can still receive reports until a managed record takes over. */
  canQueueLeadReport(sessionId: string): boolean {
    const row = this.#bindings.get(sessionId);
    return !!row && !row.revoked && this.#sourceReadable(row);
  }

  leadReportsPaused(sessionId: string): boolean {
    return this.#connections.get(sessionId)?.leadReportsPaused === true;
  }
  /** The session became a Project Agent or stopped being one: its poll answers at once. */
  leadChanged(sessionId: string): void {
    this.#connections.get(sessionId)?.wake?.();
  }

  /** The registered workspace of a connected session. */
  workspaceOf(sessionId: string): string | null {
    return this.#bindings.get(sessionId)?.target.workspaceId ?? null;
  }

  /** Reports waiting for this terminal to take them. */
  queuedReports(sessionId: string): number {
    return this.#reportQueue(sessionId).length;
  }

  /**
   * Queues a report for a terminal Project Agent; its plugin takes it on its next poll and
   * submits it as a turn once the terminal is idle. True when it joined one still waiting.
   */
  queueReport(sessionId: string, text: string, reportId?: string): boolean {
    const row = this.#bindings.get(sessionId);
    if (!row || row.revoked) throw new LeadReportNotDispatched("session-unavailable");
    if (!fitsTerminalReport(text)) throw new LeadReportNotDispatched("report-too-long");
    if (reportId !== undefined && !uuid.safeParse(reportId).success)
      throw new Error("invalid-report-id");
    let merged = false;
    try {
      if (reportId) {
        const prior = this.#reportReceiptIndex(row).get(reportId);
        if (prior !== undefined) return prior;
      }
      const queued = this.#reportQueue(sessionId);
      if (reportId) {
        const prior = queued.find(
          ({ id, mergedIds }) => id === reportId || mergedIds?.includes(reportId),
        );
        if (prior) return prior.id !== reportId;
      }
      const last = queued.at(-1);
      const combined = last ? `${last.text}\n\n${text}` : "";
      merged =
        !!last &&
        !last.offered &&
        (!reportId || (last.mergedIds?.length ?? 0) < MAX_MERGED_REPORT_IDS) &&
        fitsTerminalReport(combined);
      if (merged && last) {
        queued[queued.length - 1] = {
          ...last,
          text: combined,
          ...(reportId ? { mergedIds: [...(last.mergedIds ?? []), reportId] } : {}),
        };
      } else {
        if (queued.length >= MAX_QUEUED_REPORTS)
          throw new LeadReportNotDispatched("report-queue-full");
        queued.push({ id: reportId ?? randomUUID(), text });
      }
      this.#saveReports(row, queued);
    } catch (error) {
      if (error instanceof LeadReportNotDispatched) throw error;
      throw new LeadReportNotDispatched("report-storage-unavailable", { cause: error });
    }
    const connection = this.#connections.get(sessionId);
    if (!connection?.leadReportsPaused) connection?.wake?.();
    return merged;
  }
  /** Frees room for a new automatic binding by dropping the oldest idle automatic one. */
  #evictAutoBinding(): void {
    for (const [id, row] of this.#bindings) {
      if (
        !this.#autoBindings.has(row.bindingId) ||
        row.inflight ||
        this.#connections.has(id) ||
        this.#reportQueue(id).length > 0 ||
        readUnknownManagedCommands(this.options.dataDir, id).length > 0
      )
        continue;
      // Resuming that terminal later pairs it again automatically.
      this.#bindings.delete(id);
      this.#forgetReports(row);
      this.#autoBindings.delete(row.bindingId);
      if (this.#contextWindows.delete(row.bindingId)) this.#saveContextWindows();
      rmSync(this.#credentialPath(row.bindingId), { force: true });
      return;
    }
  }
  async #listen(): Promise<void> {
    if (this.#closed) throw new Error("claude-bridge-unavailable");
    if (this.#server?.listening) return;
    if (this.#listening) return this.#listening;
    this.#listening = (async () => {
      privatePath(this.root, true);
      this.#releaseLock = acquirePortableFileLease(path.join(this.root, "broker.lock"));
      const identity = digest(realpathSync(this.root)).toString("hex").slice(0, 20);
      const directory = path.join(
        realpathSync("/tmp"),
        `akcb-${process.getuid?.() ?? 0}-${identity}`,
      );
      privatePath(directory, true);
      const socket = path.join(directory, "b.sock");
      if (Buffer.byteLength(socket) >= 104) throw new Error("claude-bridge-socket-path-too-long");
      if (existsSync(socket)) {
        const stat = lstatSync(socket);
        if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid()))
          throw new Error("unsafe-Claude-bridge-socket");
        // The persistent file lease excludes another broker for this exact data directory.
        rmSync(socket);
      }
      const server = createServer((request, response) => void this.#http(request, response));
      server.requestTimeout = 25_000;
      server.headersTimeout = 5_000;
      server.maxConnections = 32;
      this.#socketPath = socket;
      this.#socketDirectory = directory;
      this.#server = server;
      await this.#migrateLegacyBindings();
      if (this.#closed) throw new Error("claude-bridge-unavailable");
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, () => {
          server.off("error", reject);
          resolve();
        });
      });
      chmodSync(socket, 0o600);
      this.#startupFailed = false;
      // A Runtime restart keeps the native executor and credential identity, but not its lease.
      for (const row of this.#bindings.values()) if (!row.revoked) this.#writeCredential(row);
      this.#writeDiscovery();
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
  #writeCredential(row: Binding, file = this.#credentialPath(row.bindingId)): void {
    privateJson(file, {
      protocol: 1,
      socketPath: this.#socketPath,
      bindingId: row.bindingId,
      token: row.token,
      nativeId: row.target.nativeId,
      cwd: row.target.workspace,
      // Registries written before B2 could only contain the exactly pinned CLI.
      cliVersion: row.cliVersion ?? CLAUDE_BRIDGE_CLI_VERSION,
      // Plugin 0.4.0 reconnects only with a credential naming its own version. Naming the oldest
      // plugin this Runtime takes keeps that plugin working; later plugins take any supported one.
      pluginVersion: CLAUDE_BRIDGE_COMPATIBILITY.minimumPluginVersion,
    });
  }
  async #http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let attemptedChallenge: Challenge | undefined;
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
        request.method !== "POST" ||
        request.headers.host !== "localhost" ||
        request.headers.origin
      ) {
        reply(403, { error: "bridge-request-rejected" });
        return;
      }
      if (this.#closed) {
        reply(409, { error: "bridge-lease-expired" });
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
      if (this.#closed) {
        reply(409, { error: "bridge-lease-expired" });
        return;
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.url === CLAUDE_BRIDGE_PATHS.pair) {
        const ticket = z.object({ ticket: z.string().regex(/^[a-f0-9]{64}$/) }).parse(value).ticket;
        const challenge = this.#challenges.get(ticket);
        attemptedChallenge = challenge;
        if (!challenge) throw new Error("invalid-bridge-challenge");
        if (challenge.expires < Date.now()) throw new Error("expired-bridge-challenge");
        // Native validation may fail before a complete identity is available.
        // Possession of the current local code permits reporting a failure only;
        // it never creates a binding or grants execution access.
        if (value && typeof value === "object" && "connectionError" in value) {
          const report = z
            .object({
              ticket: z.string(),
              connectionError: z.enum([
                "bridge-version-mismatch",
                "bridge-cli-too-old",
                "bridge-cli-unsupported",
                "bridge-capabilities-missing",
                "bridge-plugin-update-required",
                "unsupported-native-identity",
                "native-identity-changed",
              ]),
              cliVersion: reportedCliVersion,
              missingCapabilities: reportedMissingCapabilities,
            })
            .strip()
            .parse(value);
          throw new CompatibilityError(
            report.connectionError === "bridge-version-mismatch"
              ? "bridge-plugin-update-required"
              : report.connectionError,
            report.cliVersion,
            report.missingCapabilities,
          );
        }
        requireCompatibility(value);
        // A newer plugin may add fields this Runtime does not know; they are dropped.
        const hello = bridgeIdentitySchema
          .extend({ ticket: z.string().regex(/^[a-f0-9]{64}$/) })
          .strip()
          .parse(value);
        let target: ClaudeBridgeTarget;
        try {
          target = await this.options.target(challenge.target.sessionId, hello.nativeId);
        } catch {
          throw new Error("bridge-identity-mismatch");
        }
        if (this.#challenges.get(hello.ticket) !== challenge || challenge.expires < Date.now())
          throw new Error("invalid-bridge-challenge");
        this.options.validate(target, false);
        if (
          stable(target) !== stable(challenge.target) ||
          hello.nativeId !== target.nativeId ||
          hello.cwd !== target.workspace
        )
          throw new Error("bridge-identity-mismatch");
        this.#challenges.delete(hello.ticket);
        reply(200, this.#bind(target, hello, false));
        return;
      }
      if (request.url === CLAUDE_BRIDGE_PATHS.autoPair) {
        const key = z
          .object({ autoKey: z.string().regex(/^[a-f0-9]{64}$/) })
          .passthrough()
          .safeParse(value);
        if (
          !this.autoAvailable ||
          !key.success ||
          !timingSafeEqual(digest(key.data.autoKey), digest(this.#autoKey))
        ) {
          reply(401, { error: "bridge-authorization-required" });
          return;
        }
        try {
          requireCompatibility(value);
        } catch (error) {
          if (error instanceof CompatibilityError) await this.#recordAutoFailure(value, error);
          throw error;
        }
        const hello = bridgeIdentitySchema.extend({ autoKey: z.string() }).strip().parse(value);
        if (this.#declined.has(hello.nativeId)) {
          reply(409, { error: "bridge-auto-declined", reason: "session-disconnected" });
          return;
        }
        let target: ClaudeBridgeTarget;
        try {
          // A brand-new session may not be indexed yet; the terminal retries later.
          target = await this.options.autoTarget!(hello.nativeId, hello.cwd);
        } catch (error) {
          const reason = error instanceof Error ? error.message : undefined;
          reply(409, {
            error: "bridge-auto-unavailable",
            reason:
              reason === "workspace-not-registered" || reason === "session-not-indexed"
                ? reason
                : undefined,
          });
          return;
        }
        if (this.#disabledWorkspaces.has(target.workspaceId)) {
          reply(409, { error: "bridge-auto-disabled", reason: "auto-connect-disabled" });
          return;
        }
        this.options.validate(target, false);
        if (hello.nativeId !== target.nativeId || hello.cwd !== target.workspace)
          throw new Error("bridge-identity-mismatch");
        const existing = this.#bindings.get(target.sessionId);
        if (existing?.revoked) {
          reply(409, { error: "bridge-auto-declined", reason: "session-disconnected" });
          return;
        }
        reply(200, this.#bind(target, hello, true));
        return;
      }
      const token = /^Bearer ([a-f0-9]{64})$/.exec(
        String(request.headers.authorization ?? ""),
      )?.[1];
      if (!token || !value || typeof value !== "object" || !("bindingId" in value)) {
        reply(401, { error: "bridge-authorization-required" });
        return;
      }
      const row = [...this.#bindings.values()].find((item) => item.bindingId === value.bindingId);
      if (!row || !timingSafeEqual(digest(token), digest(row.token))) {
        reply(401, { error: "bridge-authorization-required" });
        return;
      }
      if (row.revoked) {
        reply(410, { error: "bridge-binding-revoked" });
        return;
      }
      try {
        this.options.validate(row.target, false, row.bindingId);
      } catch {
        this.#disconnect(row.target.sessionId);
        // The source may disappear briefly while indexing or while the shared service exits.
        // Existing plugins already retry this response without changing the saved binding.
        reply(409, { error: "bridge-lease-expired" });
        return;
      }
      if (request.url === CLAUDE_BRIDGE_PATHS.reconnect) {
        if ("connectionError" in value) {
          if (
            !("nativeId" in value) ||
            value.nativeId !== row.target.nativeId ||
            !("cwd" in value) ||
            value.cwd !== row.target.workspace
          )
            throw new Error("bridge-identity-mismatch");
          const report = reconnectFailureSchema.parse(value);
          // An authenticated old terminal may explain an offline binding, but
          // cannot replace a newer lease or the user's current pairing attempt.
          const activeChallenge = [...this.#challenges.values()].some(
            (challenge) =>
              challenge.target.sessionId === row.target.sessionId &&
              challenge.expires >= Date.now(),
          );
          const reported = !this.#connections.has(row.target.sessionId) && !activeChallenge;
          if (reported) {
            const attempt: ConnectionAttempt = {
              bindingId: row.bindingId,
              error: report.connectionError,
              cliVersion: report.cliVersion,
              missingCapabilities: report.missingCapabilities,
            };
            if (stable(this.#connectionAttempts.get(row.target.sessionId)) !== stable(attempt)) {
              this.#connectionAttempts.set(row.target.sessionId, attempt);
              ++this.#revision;
              this.#publish(row.target.sessionId);
            }
          }
          reply(200, { reported });
          return;
        }
        requireCompatibility(value);
        const hello = bridgeIdentitySchema.extend({ bindingId: uuid }).strip().parse(value);
        if (hello.nativeId !== row.target.nativeId || hello.cwd !== row.target.workspace)
          throw new Error("bridge-identity-mismatch");
        this.#disconnect(row.target.sessionId);
        row.cliVersion = hello.cliVersion;
        this.#save();
        this.#writeCredential(row);
        this.#connectionAttempts.delete(row.target.sessionId);
        const connection = this.#newConnection(row, hello);
        reply(200, {
          protocol: 1,
          bindingId: row.bindingId,
          token: row.token,
          leaseId: connection.leaseId,
          credentialPath: this.#credentialPath(row.bindingId),
          features: claudeBridgeFeatures(!!this.options.lead),
        });
        return;
      }
      const connection = this.#connections.get(row.target.sessionId);
      if (!connection) {
        reply(409, { error: "bridge-lease-expired" });
        return;
      }
      if (
        !("leaseId" in value) ||
        value.leaseId !== connection.leaseId ||
        !("nativeId" in value) ||
        value.nativeId !== row.target.nativeId ||
        !("cwd" in value) ||
        value.cwd !== row.target.workspace ||
        !("instanceId" in value) ||
        value.instanceId !== connection.instanceId
      ) {
        reply(410, { error: "stale-bridge-lease" });
        return;
      }
      connection.lastSeen = Date.now();
      if (request.url === CLAUDE_BRIDGE_PATHS.events) {
        const input = bridgeEventsSchema.parse(value);
        for (const entry of input.events) {
          if (entry.seq <= connection.seq) continue;
          if (entry.seq !== connection.seq + 1 && !["snapshot", "gap"].includes(entry.event.type)) {
            connection.gap = true;
            this.#publish(row.target.sessionId);
            throw new Error("bridge-event-gap");
          }
          this.#apply(row, connection, entry.event);
          connection.seq = entry.seq;
          if (!this.#connections.has(row.target.sessionId)) break;
        }
        reply(200, { ackSeq: connection.seq });
        return;
      }
      if (request.url === CLAUDE_BRIDGE_PATHS.commands) {
        const input = bridgePollSchema.parse(value);
        const { leadReportsPaused } = input;
        if (connection.pollActive) throw new Error("bridge-poll-already-active");
        const sessionId = row.target.sessionId;
        if (input.leadTools !== undefined && this.options.lead)
          connection.leadTools = input.leadTools;
        connection.leadWorkerSettings = !!connection.leadTools && input.leadWorkerSettings === true;
        const nativeReceipts = this.options.lead !== undefined && input.reportAckIds !== undefined;
        const nativeOffers = nativeReceipts
          ? (connection.nativeReportOffers ??= new Map())
          : undefined;
        const nativeTaken = new Set(nativeReceipts ? input.reportAckIds : undefined);
        const legacyTaken = new Set(input.takenReports);
        if (nativeTaken.size || legacyTaken.size) {
          this.#retireReports(
            row,
            (report) =>
              !!report.offered && (report.nativeReceipt ? nativeTaken : legacyTaken).has(report.id),
          );
          for (const id of nativeTaken) nativeOffers?.delete(id);
        }
        const reportCandidates = () =>
          (connection.leadReportsRecovery ? [] : this.#reportQueue(sessionId)).filter(
            (report) => !report.offered || (report.nativeReceipt === true) === nativeReceipts,
          );
        // What a terminal Project Agent needs: its tools, and the reports for it to queue.
        const lead = () => {
          if (!connection.leadTools || !this.options.lead) return {};
          let tools: ReturnType<BridgeLead["tools"]> = null;
          let paused: string | null = null;
          try {
            tools = this.options.lead.tools(sessionId);
            paused = this.options.lead.paused?.(sessionId) ?? null;
          } catch {
            /* The session is offered no tools rather than losing its commands. */
          }
          if (!tools) return { lead: null };
          const orderedTools = tools
            .filter(({ name }) => connection.leadWorkerSettings || name !== "worker_settings")
            .sort(
              (a, b) => Number(a.name === "worker_restart") - Number(b.name === "worker_restart"),
            );
          const handover =
            connection.pending?.command.kind === "handover-exit" ||
            readUnknownManagedCommands(this.options.dataDir, sessionId).some(
              ({ evidence }) => evidence?.operation === "handover-terminal",
            );
          const now = Date.now();
          const offered =
            connection.leadReportsPaused || handover
              ? []
              : reportCandidates()
                  .filter(({ id }) => (nativeOffers?.get(id) ?? 0) <= now)
                  .slice(0, 4);
          if (offered.some((report) => !report.offered)) {
            const offeredIds = new Set(offered.map(({ id }) => id));
            this.#saveReports(
              row,
              this.#reportQueue(sessionId).map((report) =>
                offeredIds.has(report.id)
                  ? {
                      ...report,
                      offered: true as const,
                      ...(nativeReceipts ? { nativeReceipt: true as const } : {}),
                    }
                  : report,
              ),
            );
          }
          for (const { id } of offered) nativeOffers?.set(id, now + NATIVE_REPORT_RETRY_MS);
          const reports = offered.map(({ id, text }) => ({ id, text }));
          return { lead: { tools: orderedTools, reports, paused } };
        };
        connection.pollActive = true;
        try {
          if (
            connection.leadTools &&
            leadReportsPaused !== undefined &&
            connection.leadReportsPaused !== leadReportsPaused &&
            this.options.lead?.tools(sessionId)
          ) {
            const previous = connection.leadReportsPaused;
            connection.leadReportsPaused = leadReportsPaused;
            try {
              const recovery = this.options.lead.reportPauseChanged?.(sessionId, leadReportsPaused);
              trackReportRecovery(connection, recovery);
            } catch (error) {
              connection.leadReportsPaused = previous;
              throw error;
            }
          }
          const now = Date.now();
          const nextReportAt =
            connection.leadReportsPaused || !connection.leadTools
              ? Infinity
              : nextReportOfferAt(reportCandidates(), nativeOffers, now);
          const waitMs = Math.min(input.waitMs, Math.max(0, nextReportAt - now));
          if (!connection.pending && waitMs)
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                if (connection.wake === done) connection.wake = undefined;
                response.off("close", done);
                resolve();
              };
              const timer = setTimeout(done, waitMs);
              timer.unref();
              connection.wake = done;
              response.once("close", done);
            });
          if (response.destroyed) return;
          if (this.#connections.get(sessionId) !== connection) {
            reply(409, { error: "bridge-lease-expired" });
            return;
          }
          const pending = connection.pending;
          if (pending && !pending.delivered) {
            this.options.validate(row.target, true, row.bindingId);
            const offered = lead();
            pending.receipt.dispatch();
            pending.delivered = true;
            reply(200, { commands: [pending.command], ...offered });
          } else reply(200, { commands: [], ...lead() });
        } finally {
          connection.pollActive = false;
        }
        return;
      }
      if (request.url === CLAUDE_BRIDGE_PATHS.leadCall) {
        const input = bridgeLeadCallSchema.parse(value);
        if (
          !connection.leadTools ||
          !this.options.lead ||
          (input.name === "worker_settings" && !connection.leadWorkerSettings)
        )
          throw new Error("bridge-feature-unavailable");
        // The binding must still be one AgentKib lets control this session.
        this.options.validate(row.target, true, row.bindingId);
        const answer = await this.options.lead.call(row.target.sessionId, input.name, input.input);
        reply(200, { text: answer.text, isError: answer.isError === true });
        return;
      }
      if (request.url === CLAUDE_BRIDGE_PATHS.results) {
        const input = bridgeResultSchema.parse(value);
        const pending = connection.pending;
        // A chooser receipt can arrive while an unrelated request is in flight: it fences
        // reopening the chooser, but never changes that other request's delivery or turn.
        const lateClaim =
          pending?.command.commandId !== input.commandId
            ? readUnknownManagedCommands(this.options.dataDir, row.target.sessionId).find(
                (command) =>
                  (!pending || command.evidence?.operation === "open-model-picker") &&
                  command.evidence?.commandId === input.commandId &&
                  command.evidence.bindingId === row.bindingId &&
                  command.evidence.nativeId === row.target.nativeId,
              )
            : undefined;
        const recovering =
          lateClaim !== undefined || (!pending && row.inflight?.commandId === input.commandId);
        if (
          (!pending || !pending.delivered || pending.command.commandId !== input.commandId) &&
          !recovering
        ) {
          reply(200, { ok: true });
          return;
        }
        if (recovering) {
          if (lateClaim?.evidence?.operation === "handover-terminal") {
            // A late plugin ACK can't prove host process exit or the managed commit.
            reply(200, { ok: true });
            return;
          }
          // A late receipt settles a message handed to the outbox, or its withdrawal. They
          // start no turn of their own here, so nothing waits for a completion.
          if (
            lateClaim &&
            ["steer", "queue-add", "queue-delete", "open-model-picker"].includes(
              String(lateClaim.evidence?.operation),
            )
          ) {
            if (input.status !== "unknown")
              finishManagedCommand(
                this.options.dataDir,
                lateClaim.requestId,
                this.#result(
                  row,
                  lateClaim.requestId,
                  input.status === "accepted" ? "accepted" : "not-dispatched",
                ),
              );
            this.#publish(row.target.sessionId);
            reply(200, { ok: true });
            return;
          }
          if (lateClaim?.evidence?.operation === "stop") {
            if (input.status === "accepted" && input.turnId !== lateClaim.evidence.turnId)
              throw new Error("bridge-turn-mismatch");
            if (input.status !== "unknown")
              finishManagedCommand(
                this.options.dataDir,
                lateClaim.requestId,
                this.#result(
                  row,
                  lateClaim.requestId,
                  input.status === "accepted" ? "accepted" : "not-dispatched",
                  !!input.turnId && connection.completed.get(input.turnId) === true,
                ),
              );
            this.#publish(row.target.sessionId);
            reply(200, { ok: true });
            return;
          }
          if (input.status === "accepted" && input.turnId) {
            row.inflight!.turnId = input.turnId;
            const requestId = row.inflight!.requestId;
            const completedTurns = lateClaim?.evidence?.completedTurns;
            const completed =
              connection.completed.has(input.turnId) ||
              (Array.isArray(completedTurns) && completedTurns.includes(input.turnId));
            if (completed) row.inflight = null;
            this.#save();
            finishManagedCommand(
              this.options.dataDir,
              requestId,
              this.#result(row, requestId, "accepted", completed),
            );
          } else if (input.status === "rejected") {
            const requestId = row.inflight!.requestId;
            row.inflight = null;
            this.#save();
            finishManagedCommand(
              this.options.dataDir,
              requestId,
              this.#result(row, requestId, "not-dispatched"),
            );
          }
          this.#publish(row.target.sessionId);
          reply(200, { ok: true });
          return;
        }
        if (!pending) throw new Error("missing-bridge-command");
        if (input.status === "exit-initiated" && pending.command.kind !== "handover-exit")
          throw new Error("bridge-result-mismatch");
        if (input.status === "accepted" && pending.command.kind === "send" && !input.turnId)
          throw new Error("missing-native-turn");
        if (
          input.status === "accepted" &&
          (pending.command.kind === "stop" || pending.command.kind === "steer") &&
          input.turnId !== pending.command.turnId
        )
          throw new Error("bridge-turn-mismatch");
        if (input.status === "accepted" && row.inflight?.commandId === input.commandId)
          row.inflight.turnId = input.turnId!;
        // Only a send starts, and a stop ends, a turn whose completion settles the receipt.
        const completed =
          input.status === "accepted" &&
          !!input.turnId &&
          (pending.command.kind === "stop"
            ? connection.completed.get(input.turnId) === true
            : pending.command.kind === "send" && connection.completed.has(input.turnId));
        if (completed && row.inflight?.commandId === input.commandId) row.inflight = null;
        if (input.status === "rejected" && row.inflight?.commandId === input.commandId)
          row.inflight = null;
        this.#save();
        clearTimeout(pending.timer);
        const outcome =
          input.status === "accepted" || input.status === "exit-initiated"
            ? "accepted"
            : input.status === "rejected"
              ? "not-dispatched"
              : "unknown";
        const result = this.#result(row, pending.requestId, outcome, completed);
        if (outcome !== "unknown") pending.receipt.finish(result);
        connection.pending = null;
        pending.resolve(result);
        this.#publish(row.target.sessionId);
        reply(200, { ok: true });
        return;
      }
      reply(404, { error: "bridge-method-unavailable" });
    } catch (error) {
      const reason =
        error instanceof Error &&
        [
          "invalid-bridge-challenge",
          "expired-bridge-challenge",
          "bridge-version-mismatch",
          "bridge-cli-too-old",
          "bridge-cli-unsupported",
          "bridge-capabilities-missing",
          "bridge-plugin-update-required",
          "unsupported-native-identity",
          "native-identity-changed",
          "bridge-identity-mismatch",
          "control-outcome-unconfirmed",
          "claude-bridge-binding-limit",
          "bridge-auto-unavailable",
          "bridge-auto-disabled",
          "bridge-auto-declined",
        ].includes(error.message)
          ? error.message
          : "bridge-request-rejected";
      const attempt = attemptedChallenge
        ? this.#connectionAttempts.get(attemptedChallenge.target.sessionId)
        : undefined;
      // A replaced, revoked or successfully paired code no longer owns the panel's feedback.
      const details =
        error instanceof CompatibilityError
          ? { cliVersion: error.cliVersion, missingCapabilities: error.missingCapabilities }
          : {};
      if (attempt && attempt.challenge === attemptedChallenge) {
        attempt.error = reason;
        attempt.cliVersion = details.cliVersion;
        attempt.missingCapabilities = details.missingCapabilities;
      }
      reply(409, { error: reason, ...details });
    }
  }

  #newConnection(row: Binding, identity: ClaudeBridgeIdentity): Connection {
    if (this.#terminalExitModels.delete(row.bindingId)) this.#saveTerminalExitModels();
    const connection: Connection = {
      leaseId: randomUUID(),
      instanceId: identity.instanceId,
      identity,
      lastSeen: Date.now(),
      seq: 0,
      revision: ++this.#revision,
      snapshot: null,
      terminalSubagentsObserved: false,
      gap: false,
      pending: null,
      pollActive: false,
      completed: new Map(),
      turnTools: new Map(),
      publishedTools: new Map(),
    };
    this.#connections.set(row.target.sessionId, connection);
    this.#lastConnectionLease.set(row, connection.leaseId);
    this.#publish(row.target.sessionId);
    return connection;
  }
  #apply(row: Binding, connection: Connection, event: ClaudeBridgeEvent): void {
    const id = row.target.sessionId;
    if (event.type === "invalidated") {
      this.#disconnect(id);
      return;
    }
    if (event.type === "gap") {
      connection.gap = true;
      connection.revision = ++this.#revision;
      this.invalidate(undefined, id);
      this.#publish(id);
      this.options.publish(id, "invalidate", { domains: ["history"] }, this.live(id, true));
      return;
    }
    // A native terminal event remains evidence even when it precedes the first
    // display snapshot after reconnect. Never discard it merely for UI ordering.
    if (event.type === "turn-complete") this.#complete(row, connection, event);
    const previousTurnId = connection.snapshot?.currentTurnId;
    const previousWaiting = connection.snapshot?.waiting;
    let stop: { turnId: string; deviceId: string } | null = null;
    if (event.type === "snapshot") {
      const snapshot = event.snapshot;
      if (
        snapshot.nativeId !== row.target.nativeId ||
        snapshot.cwd !== row.target.workspace ||
        snapshot.instanceId !== connection.instanceId ||
        snapshot.cliVersion !== connection.identity.cliVersion ||
        snapshot.pluginVersion !== connection.identity.pluginVersion ||
        stable(snapshot.nativeCapabilities) !== stable(connection.identity.nativeCapabilities)
      )
        throw new Error("bridge-identity-mismatch");
      if (connection.snapshot && snapshot.revision < connection.snapshot.revision)
        throw new Error("stale-bridge-snapshot");
      const started =
        snapshot.compactStartedAt ??
        (snapshot.compacting && !connection.snapshot?.compacting ? connection.lastSeen : undefined);
      if (started !== undefined && started > (this.#compactStartedAt.get(row) ?? -1))
        this.#compactStartedAt.set(row, Math.min(started, connection.lastSeen));
      connection.snapshot = snapshot;
      connection.terminalSubagentsObserved ||= snapshot.terminalSubagents !== undefined;
      connection.gap = false;
      if (
        snapshot.terminalModelAtExit === true &&
        snapshot.model &&
        snapshot.status === "disconnected" &&
        !snapshot.capabilities.read
      ) {
        this.#terminalExitModels.set(row.bindingId, snapshot.model);
        this.#saveTerminalExitModels();
      }
      this.#rememberContextWindow(row, snapshot);
    } else {
      const snapshot = connection.snapshot;
      if (!snapshot) {
        connection.gap = true;
        return;
      }
      if (event.revision < snapshot.revision && event.type !== "turn-complete")
        throw new Error("stale-bridge-event");
      snapshot.revision = Math.max(snapshot.revision, event.revision);
      if (event.type === "turn-start") {
        snapshot.currentTurnId = event.turnId;
        snapshot.status = "running";
        snapshot.waiting = null;
        delete snapshot.pendingApprovalDetails;
        delete snapshot.pendingQuestionSummary;
        snapshot.streamText = "";
        delete snapshot.terminalWorkerActivity;
        // A Project Agent's count of turns without the person restarts when they type. A turn the
        // CLI begins by itself has no text, so no origin from a plugin that gives one; it counts,
        // and past the limit it stops, as for a session AgentKib runs.
        if (event.origin === "terminal") {
          this.#leadSpoke(connection, id);
          try {
            if (this.#workerObserver?.isWorker(id)) this.#workerObserver.controlled(id, "send");
          } catch {
            // Reporting must not affect the terminal's message.
          }
        } else if (event.origin === undefined && connection.leadTools)
          try {
            const refused = this.options.lead?.selfTurn?.(id);
            if (refused) stop = { turnId: event.turnId, deviceId: refused.stopAs };
          } catch {
            /* A lead's bookkeeping never disturbs the terminal. */
          }
      } else if (event.type === "text") {
        if (snapshot.currentTurnId !== event.turnId) throw new Error("bridge-turn-mismatch");
        if (Buffer.byteLength(snapshot.streamText + event.text) > 128 * 1024) {
          connection.gap = true;
        } else snapshot.streamText += event.text;
      } else if (event.type === "turn-complete") {
        if (snapshot.currentTurnId === event.turnId) {
          snapshot.status = "idle";
          snapshot.waiting = null;
          delete snapshot.pendingApprovalDetails;
          delete snapshot.pendingQuestionSummary;
          snapshot.currentTurnId = null;
          snapshot.streamText = "";
          delete snapshot.terminalWorkerActivity;
        }
      } else if (event.type === "tool-start" || event.type === "tool-complete") {
        if (
          snapshot.currentTurnId &&
          (event.turnId === snapshot.currentTurnId ||
            (event.turnId === undefined &&
              (event.type === "tool-start" || connection.turnTools.has(event.tool.id))))
        ) {
          // Only the next snapshot has the full worker observation.
          delete snapshot.terminalWorkerActivity;
          connection.turnTools.set(event.tool.id, event.tool);
          if (connection.turnTools.size > 256)
            connection.turnTools.delete(connection.turnTools.keys().next().value!);
        }
      }
    }
    if (previousTurnId !== connection.snapshot?.currentTurnId) connection.turnTools.clear();
    connection.revision = ++this.#revision;
    this.#publish(id);
    if (terminalQuestionSettled(event, connection.turnTools, previousWaiting))
      this.options.publish(id, "invalidate", { domains: ["history"] }, this.live(id, true));
    if (event.type === "snapshot") {
      const { currentTurnId: turnId, waiting } = event.snapshot;
      if (
        turnId &&
        (waiting === "permission" || waiting === "question") &&
        (turnId !== previousTurnId || waiting !== previousWaiting)
      ) {
        try {
          if (this.#workerObserver?.isWorker(id))
            this.#workerObserver.waiting(
              id,
              turnId,
              waiting === "question" ? "waiting-input" : "awaiting-approval",
            );
        } catch {
          // Reporting must not affect the terminal's pending interaction.
        }
      }
    }
    if (stop) void this.#stopLeadTurn(row, stop.turnId, stop.deviceId);
  }

  observeWorkers(observer: WorkerObserver): void {
    this.#workerObserver = observer;
  }

  /** The person wrote to this session; for a terminal Project Agent, its turns restart. */
  #leadSpoke(connection: Connection, sessionId: string): void {
    if (!connection.leadTools) return;
    try {
      this.options.lead?.userSpoke(sessionId);
    } catch {
      /* A lead's bookkeeping never disturbs the terminal. */
    }
  }

  /**
   * Stops a turn a terminal Project Agent's CLI began by itself past its automatic turns, as Stop
   * in AgentKib would, in the name of the device that set the Project Agent up.
   */
  async #stopLeadTurn(row: Binding, turnId: string, deviceId: string): Promise<void> {
    try {
      await this.#control(
        {
          operation: "stop",
          sessionId: row.target.sessionId,
          requestId: randomUUID(),
          deviceId,
          runtimeBootId: this.options.bootId,
          expectedRevision: this.live(row.target.sessionId, true).revision,
          experimentalEnabled: true,
          turnId,
        },
        row,
      );
    } catch {
      // Another command is on its way or the turn ended: it runs out by itself, and delegation
      // is paused either way.
    }
  }

  #complete(
    row: Binding,
    connection: Connection,
    event: Extract<ClaudeBridgeEvent, { type: "turn-complete" }>,
  ): void {
    try {
      this.options.completed?.(row.target, event.turnId, event.aborted, {
        occurredAt: event.occurredAt,
        startedAt: event.startedAt,
      });
    } catch {
      console.warn("Conversation read-state observation could not be recorded");
    }
    try {
      const id = row.target.sessionId;
      if (!connection.completed.has(event.turnId) && this.#workerObserver?.isWorker(id)) {
        const duration =
          event.startedAt !== undefined &&
          event.occurredAt !== undefined &&
          event.occurredAt >= event.startedAt
            ? event.occurredAt - event.startedAt
            : null;
        this.#workerObserver.turnEnded(
          id,
          event.turnId,
          event.aborted ? "cancelled" : "completed",
          duration,
          undefined,
          event.text.trim() ? event.text : null,
        );
      }
    } catch {
      // Reporting must not affect the terminal's completion receipt.
    }
    connection.completed.set(
      event.turnId,
      event.aborted || connection.completed.get(event.turnId) === true,
    );
    if (connection.completed.size > 256)
      connection.completed.delete(connection.completed.keys().next().value!);
    // Native completion can be acknowledged before the send's receipt identifies its turn.
    // Preserve the candidate on the dispatched request so a restarted service can match it.
    const inflight = row.inflight;
    if (inflight?.turnId === null) {
      const claim = readUnknownManagedCommands(this.options.dataDir, row.target.sessionId).find(
        (command) => command.requestId === inflight.requestId,
      );
      const evidence = claim?.evidence;
      if (
        evidence?.operation === "send" &&
        evidence.commandId === inflight.commandId &&
        evidence.bindingId === row.bindingId &&
        evidence.nativeId === row.target.nativeId
      ) {
        const turns: unknown[] = Array.isArray(evidence.completedTurns)
          ? evidence.completedTurns
          : [];
        if (!turns.includes(event.turnId))
          acknowledgeDispatchedManagedCommand(this.options.dataDir, inflight.requestId, {
            ...evidence,
            completedTurns: [...turns.slice(-255), event.turnId],
          });
      }
    }
    if (row.inflight?.turnId === event.turnId) {
      const requestId = row.inflight.requestId;
      row.inflight = null;
      this.#save();
      finishManagedCommand(this.options.dataDir, requestId, {
        ...this.#result(row, requestId, "accepted", true),
        completionObserved: true,
      });
    }
    if (event.aborted)
      observeManagedCommandCompletion(
        this.options.dataDir,
        row.target.sessionId,
        {
          operation: "stop",
          executionMode: "claude-follower",
          bindingId: row.bindingId,
          nativeId: row.target.nativeId,
          workspaceId: row.target.workspaceId,
          turnId: event.turnId,
        },
        this.#result(row, "", "accepted", true),
      );
    this.options.publish(
      row.target.sessionId,
      "invalidate",
      { domains: ["history", "catalog", "receipts"] },
      this.live(row.target.sessionId, true),
    );
  }
  #dropToolOverlays(id: string, ids: string[], live = this.live(id, true)): void {
    this.options.publish(
      id,
      "snapshot",
      { live, items: [], replaceItemIds: ids, completeItems: false },
      live,
    );
  }
  #publish(id: string): void {
    const binding = this.#bindings.get(id);
    if (!binding) return;
    const live = this.live(id, true);
    const connection = this.#connections.get(id);
    if (!connection?.snapshot || !this.#online(id)) {
      this.options.publish(id, "snapshot", { live, items: [], replaceItems: false }, live);
      return;
    }
    this.options.publish(id, "state", live, live);
    // The snapshot contains a history preview. Live overlays come only from this turn's tool events.
    const turnId = connection.gap ? null : connection.snapshot.currentTurnId;
    const previous = connection.publishedTools;
    const tools = terminalToolItems(turnId, connection.turnTools);
    const removed = [...previous.keys()].filter((key) => !tools.has(key));
    if (removed.length) this.#dropToolOverlays(id, removed, live);
    connection.publishedTools = tools;
    for (const [toolId, tool] of tools) {
      if (previous.get(toolId) === tool) continue;
      this.options.publish(
        id,
        "item-upsert",
        claudeBridgeToolEvent(toolId, tool, turnId, binding.target.workspace),
        live,
      );
    }
  }
  #disconnect(id: string): void {
    const connection = this.#connections.get(id);
    if (!connection) return;
    const overlays = [...connection.publishedTools.keys()];
    this.#connections.delete(id);
    ++this.#revision;
    connection.wake?.();
    const pending = connection.pending;
    connection.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      const row = this.#bindings.get(id)!;
      const outcome = pending.delivered ? "unknown" : "not-dispatched";
      if (!pending.delivered) {
        if (row.inflight?.commandId === pending.command.commandId) row.inflight = null;
        this.#save();
      }
      const result = this.#result(row, pending.requestId, outcome);
      if (!pending.delivered) pending.receipt.finish(result);
      pending.resolve(result);
    }
    this.#publish(id);
    if (overlays.length) this.#dropToolOverlays(id, overlays);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.options.pluginUpdate?.close();
    clearInterval(this.#timer);
    this.#challenges.clear();
    await this.#listening?.catch(() => undefined);
    this.#removeDiscovery();
    for (const id of this.#connections.keys()) this.#disconnect(id);
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
    this.#releaseLegacyLock?.();
    this.#releaseLegacyLock = undefined;
  }
}
