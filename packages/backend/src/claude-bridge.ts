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
  CLAUDE_BRIDGE_CLI_VERSION,
  CLAUDE_BRIDGE_PLUGIN_VERSION,
  CLAUDE_BRIDGE_PATHS,
  CLAUDE_BRIDGE_REQUIRED_CAPABILITIES,
  claudeBridgeCompatibility,
  missingClaudeBridgeCapabilities,
  type ClaudeBridgeConnectionFailure,
  type ClaudeBridgeIdentity,
  type ClaudeBridgeCommand,
  type ClaudeBridgeEvent,
  type ClaudeBridgeSnapshot,
  type SessionStreamEvent,
} from "@agentkib/runtime-protocol";
import {
  bridgeIdentitySchema,
  bridgeEventsSchema,
  bridgePollSchema,
  bridgeResultSchema,
} from "./claude-bridge-schema";
import { acquirePortableFileLease } from "./managed-session-lock";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
  observeManagedCommandCompletion,
  readUnknownManagedCommands,
  replayManagedCommand,
} from "./managed-ledger";
import { validHistoryControl } from "./history-control-schema";
import { sanitizeSessionText } from "./session-handoff";

const MAX_BODY = 1024 * 1024;
const HEARTBEAT_MS = 35_000;
const LOCAL_OWNER = "agentkib-local-owner";
const uuid = z.string().uuid();
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
type Challenge = { target: ClaudeBridgeTarget; expires: number };
type ConnectionAttempt = (
  | { challenge: Challenge; bindingId?: never }
  | { bindingId: string; challenge?: never }
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
const reconnectFailureSchema = z
  .object({
    protocol: z.literal(1),
    pluginVersion: z.literal(CLAUDE_BRIDGE_PLUGIN_VERSION),
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
  .strict();
type Pending = {
  command: ClaudeBridgeCommand;
  requestId: string;
  deviceId: string;
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
  gap: boolean;
  pending: Pending | null;
  wake?: () => void;
  pollActive: boolean;
  completed: Map<string, boolean>;
};
interface BridgeOptions {
  dataDir: string;
  bootId: string;
  pluginDirectory: string;
  /** A bounded native identity read. No model, transcript rewrite or managed adopt. */
  target(sessionId: string, nativeId?: string): Promise<ClaudeBridgeTarget>;
  /** The binding ID only accompanies an existing row's authenticated execution or recovery. */
  validate(target: ClaudeBridgeTarget, forControl: boolean, bindingId?: string): void;
  publish(
    sessionId: string,
    type: SessionStreamEvent["type"],
    payload: Record<string, unknown>,
    live: Record<string, unknown>,
  ): void;
  platform?: NodeJS.Platform;
  commandTimeoutMs?: number;
}

function privatePath(value: string, directory = false): void {
  if (!path.isAbsolute(value) || path.normalize(value) !== value)
    throw new Error("unsafe-Claude-bridge-path");
  for (let current = value; ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error("unsafe-Claude-bridge-path");
    if (path.dirname(current) === current) break;
  }
  if (directory) {
    mkdirSync(value, { recursive: true, mode: 0o700 });
    const stat = lstatSync(value);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
      throw new Error("unsafe-Claude-bridge-owner");
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
  if (row.protocol !== 1 || row.pluginVersion !== CLAUDE_BRIDGE_PLUGIN_VERSION)
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
  #connections = new Map<string, Connection>();
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
        const rows = z
          .object({ version: z.literal(1), bindings: z.array(bindingSchema).max(64) })
          .strict()
          .parse(JSON.parse(readFileSync(registry, "utf8")));
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
    this.#timer = setInterval(() => {
      for (const [id, connection] of this.#connections)
        if (Date.now() - connection.lastSeen > HEARTBEAT_MS) this.#disconnect(id);
    }, 5_000);
    this.#timer.unref();
  }

  get supported(): boolean {
    return (this.options.platform ?? process.platform) === "darwin";
  }
  assertCanAdopt(): void {
    if (this.#registryInvalid) throw new Error("claude-bridge-registry-invalid");
  }
  handles(sessionId: string): boolean {
    const row = this.#bindings.get(sessionId);
    return !!row && (!row.revoked || row.inflight !== null);
  }
  blocksManagedResume(sessionId: string): boolean {
    this.assertCanAdopt();
    const row = this.#bindings.get(sessionId);
    if (!row) return false;
    if (row.inflight || readUnknownManagedCommands(this.options.dataDir, sessionId).length > 0)
      return true;
    const connection = this.#connections.get(sessionId);
    // A fresh lease also protects the interval between pairing and its first snapshot.
    // Expired, settled bindings retain their credentials without blocking a native resume.
    return !!connection && !row.revoked && Date.now() - connection.lastSeen <= HEARTBEAT_MS;
  }
  #save(): void {
    privateJson(path.join(this.root, "bindings-v1.json"), {
      version: 1,
      bindings: [...this.#bindings.values()],
    });
  }
  initialize(): void {
    if (
      this.supported &&
      !this.#registryInvalid &&
      [...this.#bindings.values()].some((row) => !row.revoked)
    )
      void this.#listen().catch(() => {
        this.#startupFailed = true;
      });
  }

  async management(value: Record<string, unknown>): Promise<unknown> {
    const input = z
      .object({
        operation: z.enum(["bridge-status", "bridge-challenge", "bridge-disconnect"]),
        sessionId: z.string().min(1).max(256),
        deviceId: z.literal(LOCAL_OWNER),
      })
      .strict()
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
        rmSync(this.#credentialPath(row.bindingId), { force: true });
      }
      this.#disconnect(input.sessionId);
      return { disconnected: true };
    }
    let target: ClaudeBridgeTarget;
    try {
      target = await this.options.target(input.sessionId);
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
        reason: this.supported
          ? this.#startupFailed
            ? "claude-bridge-unavailable"
            : connected
              ? undefined
              : "claude-bridge-not-connected"
          : "platform-unsupported",
        pluginDirectory: this.options.pluginDirectory,
        installInstructions: [
          `claude plugin marketplace add '${this.options.pluginDirectory.replaceAll("'", "'\\''")}'`,
          "claude plugin install agentkib-bridge@agentkib-local",
          "claude plugin update agentkib-bridge@agentkib-local",
          "/reload-plugins",
        ].join("\n"),
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
    const unknownCommand = readUnknownManagedCommands(this.options.dataDir, id).some(
      (command) => command.requestId !== connection?.pending?.requestId,
    );
    const uncertain =
      unknownCommand ||
      (row.inflight !== null &&
        (!online || !row.inflight.turnId || snapshot?.currentTurnId !== row.inflight.turnId));
    const gap = connection?.gap === true;
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
            : snapshot?.waiting === "permission"
              ? "claude-terminal-approval"
              : snapshot?.waiting === "question"
                ? "claude-terminal-question"
                : snapshot?.waiting === "unknown"
                  ? "claude-terminal-permission-unconfirmed"
                  : snapshot?.status === "running" && !snapshot.currentTurnId
                    ? "claude-follower-turn-unconfirmed"
                    : snapshot?.status === "idle" && !snapshot.capabilities.send
                      ? "claude-follower-send-unverified"
                      : undefined;
    const status = uncertain
      ? "outcome-unknown"
      : !online || gap
        ? "unsupported"
        : snapshot?.waiting === "permission"
          ? "awaiting-approval"
          : snapshot?.waiting === "question"
            ? "waiting-input"
            : snapshot?.status === "running" || snapshot?.status === "waiting"
              ? "running"
              : "idle";
    return {
      sessionId: id,
      sourceSessionId: row.target.nativeId,
      workspaceId: row.target.workspaceId,
      runtimeBootId: this.options.bootId,
      executionMode: "claude-follower",
      executionLocation: online ? "terminal" : null,
      ownershipReason: null,
      // The plugin's static capability; `sendEnabled` additionally needs an idle terminal.
      terminalSend: snapshot?.capabilities.send === true,
      connectionGeneration: connection?.leaseId ?? this.options.bootId,
      cliVersion: connection ? `${connection.identity.cliVersion} (Claude Code)` : undefined,
      bridgeCompatibility: valid ? (compatibilityStatus(connection) ?? null) : null,
      bridgeConnectionFailure: connectionFailure,
      revision: connection?.revision ?? this.#revision,
      status,
      reason,
      turnId: snapshot?.currentTurnId ?? null,
      sendEnabled:
        controls &&
        online &&
        !uncertain &&
        !gap &&
        !connection?.pending &&
        !row.inflight &&
        snapshot?.status === "idle" &&
        snapshot.capabilities.send,
      stopEnabled:
        controls &&
        online &&
        !uncertain &&
        !gap &&
        !connection?.pending &&
        !!snapshot?.currentTurnId &&
        snapshot.capabilities.stop,
      approvals: [],
      questions: [],
      streamText: sanitizeSessionText(snapshot?.streamText ?? "", { value: 0 }),
      usage:
        snapshot?.usage &&
        snapshot.usage.tokens !== null &&
        snapshot.usage.window !== null &&
        snapshot.usage.window > 0
          ? {
              available: true,
              state: "ready",
              usedTokens: snapshot.usage.tokens,
              contextWindow: snapshot.usage.window,
              percent:
                snapshot.usage.percent ?? (snapshot.usage.tokens / snapshot.usage.window) * 100,
              revision: connection?.revision,
              updatedAt: new Date(snapshot.usage.observedAt).toISOString(),
            }
          : { available: false, state: "unavailable", reason: "usage-unavailable" },
    };
  }
  capabilities(id: string, controls: boolean): Record<string, unknown> {
    const live = this.live(id, controls);
    const flags: Record<string, boolean> = {
      send: live.sendEnabled === true,
      stop: live.stopEnabled === true,
      inspect: true,
      usage: true,
      context: false,
      files: true,
      reconcile: true,
      adopt: false,
      release: false,
      approve: false,
      answer: false,
      attachments: false,
      steer: false,
      resources: false,
      settings: false,
      "settings-state": false,
      queue: false,
      "queue-list": false,
      "queue-add": false,
      "queue-update": false,
      "queue-delete": false,
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
                  key === "approve"
                    ? "claude-terminal-approval"
                    : key === "answer"
                      ? "claude-terminal-question"
                      : key === "attachments"
                        ? "claude-follower-attachments-unavailable"
                        : key === "send" && !this.#connections.get(id)?.snapshot?.capabilities.send
                          ? (live.reason ?? "claude-follower-send-unverified")
                          : (live.reason ?? "operation-unavailable"),
              },
        ]),
      ),
    };
  }
  async request(value: Record<string, unknown>): Promise<unknown> {
    const id = z.string().min(1).max(256).parse(value.sessionId);
    const row = this.#bindings.get(id);
    if (!row) throw new Error("session-unavailable");
    const controls = value.experimentalEnabled === true;
    switch (value.operation) {
      case "live":
        return this.live(id, controls);
      case "capabilities":
        return this.capabilities(id, controls);
      case "inspect":
        return {
          sessionId: id,
          sourceSessionId: row.target.nativeId,
          workspaceId: row.target.workspaceId,
          live: this.live(id, controls),
          reconciled: false,
        };
      case "usage":
        return this.live(id, false).usage;
      case "context":
        this.options.validate(row.target, false, row.bindingId);
        return {
          available: true,
          cwd: row.target.workspace,
          projectId: null,
          branchAtCreation: null,
        };
      case "reconcile":
        return {
          accepted: false,
          completed: false,
          reconciled: false,
          sessionId: id,
          live: this.live(id, controls),
          reason: row.inflight ? "control-outcome-unconfirmed" : "read-only-reconciliation",
        };
      case "send":
      case "stop":
        return this.#control(value, row);
      default:
        throw new Error("operation-unavailable");
    }
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
      finishManagedCommand(this.options.dataDir, pending.requestId, result);
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
    ]);
    if (
      Object.keys(value).some((key) => !allowed.has(key)) ||
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
    const fingerprint = digest(stable({ ...value, runtimeBootId: undefined })).toString("hex");
    const replay = replayManagedCommand(this.options.dataDir, requestId, fingerprint);
    if (replay) return replay;
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
    let command: ClaudeBridgeCommand;
    if (value.operation === "send") {
      if (live.sendEnabled !== true) throw new Error("session-busy");
      // Follower text goes through the existing history-reference expansion, never attachment paths.
      const text = value.text ?? value.input;
      if (
        typeof text !== "string" ||
        !text.trim() ||
        text.length > 16_000 ||
        Buffer.byteLength(text) > 16_384
      )
        throw new Error("invalid-text-input");
      command = {
        commandId: randomUUID(),
        kind: "send",
        requestId,
        text,
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
    const prior = claimManagedCommand(
      this.options.dataDir,
      requestId,
      row.target.sessionId,
      fingerprint,
      deviceId,
      evidence,
    );
    if (prior) return prior;
    if (command.kind === "send") {
      row.inflight = { requestId, commandId: command.commandId, turnId: null };
      this.#save();
    }
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
        if (!unknown) finishManagedCommand(this.options.dataDir, requestId, result);
        resolve(result);
        this.#publish(row.target.sessionId);
      }, this.options.commandTimeoutMs ?? 12_000);
      timer.unref();
      connection.pending = { command, requestId, deviceId, delivered: false, resolve, timer };
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
  #writeCredential(row: Binding): void {
    privateJson(this.#credentialPath(row.bindingId), {
      protocol: 1,
      socketPath: this.#socketPath,
      bindingId: row.bindingId,
      token: row.token,
      nativeId: row.target.nativeId,
      cwd: row.target.workspace,
      // Registries written before B2 could only contain the exactly pinned CLI.
      cliVersion: row.cliVersion ?? CLAUDE_BRIDGE_CLI_VERSION,
      pluginVersion: CLAUDE_BRIDGE_PLUGIN_VERSION,
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
            .strict()
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
        const hello = bridgeIdentitySchema
          .extend({ ticket: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
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
          }
        }
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
        if (old) rmSync(this.#credentialPath(old.bindingId), { force: true });
        this.#connectionAttempts.delete(target.sessionId);
        const connection = this.#newConnection(row, hello);
        reply(200, {
          protocol: 1,
          bindingId: row.bindingId,
          token: row.token,
          leaseId: connection.leaseId,
          credentialPath: this.#credentialPath(row.bindingId),
        });
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
        reply(410, { error: "bridge-source-unavailable" });
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
        const hello = bridgeIdentitySchema.extend({ bindingId: uuid }).strict().parse(value);
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
        if (connection.pollActive) throw new Error("bridge-poll-already-active");
        connection.pollActive = true;
        try {
          if (!connection.pending && input.waitMs)
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                if (connection.wake === done) connection.wake = undefined;
                response.off("close", done);
                resolve();
              };
              const timer = setTimeout(done, input.waitMs);
              timer.unref();
              connection.wake = done;
              response.once("close", done);
            });
          const pending = connection.pending;
          if (
            pending &&
            !pending.delivered &&
            this.#connections.get(row.target.sessionId) === connection
          ) {
            this.options.validate(row.target, true, row.bindingId);
            if (response.destroyed) return;
            dispatchManagedCommand(this.options.dataDir, pending.requestId);
            pending.delivered = true;
            reply(200, { commands: [pending.command] });
          } else reply(200, { commands: [] });
        } finally {
          connection.pollActive = false;
        }
        return;
      }
      if (request.url === CLAUDE_BRIDGE_PATHS.results) {
        const input = bridgeResultSchema.parse(value);
        const pending = connection.pending;
        const lateClaim = !pending
          ? readUnknownManagedCommands(this.options.dataDir, row.target.sessionId).find(
              (command) =>
                command.evidence?.commandId === input.commandId &&
                command.evidence.bindingId === row.bindingId &&
                command.evidence.nativeId === row.target.nativeId,
            )
          : undefined;
        const recovering =
          !pending && (row.inflight?.commandId === input.commandId || lateClaim !== undefined);
        if (
          (!pending || !pending.delivered || pending.command.commandId !== input.commandId) &&
          !recovering
        ) {
          reply(200, { ok: true });
          return;
        }
        if (recovering) {
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
            const completed = connection.completed.has(input.turnId);
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
        if (input.status === "accepted" && pending.command.kind === "send" && !input.turnId)
          throw new Error("missing-native-turn");
        if (
          input.status === "accepted" &&
          pending.command.kind === "stop" &&
          input.turnId !== pending.command.turnId
        )
          throw new Error("bridge-turn-mismatch");
        if (input.status === "accepted" && row.inflight?.commandId === input.commandId)
          row.inflight.turnId = input.turnId!;
        const completed =
          input.status === "accepted" &&
          !!input.turnId &&
          (pending.command.kind === "stop"
            ? connection.completed.get(input.turnId) === true
            : connection.completed.has(input.turnId));
        if (completed && row.inflight?.commandId === input.commandId) row.inflight = null;
        if (input.status === "rejected" && row.inflight?.commandId === input.commandId)
          row.inflight = null;
        this.#save();
        clearTimeout(pending.timer);
        const outcome =
          input.status === "accepted"
            ? "accepted"
            : input.status === "rejected"
              ? "not-dispatched"
              : "unknown";
        const result = this.#result(row, pending.requestId, outcome, completed);
        if (outcome !== "unknown")
          finishManagedCommand(this.options.dataDir, pending.requestId, result);
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
    const connection: Connection = {
      leaseId: randomUUID(),
      instanceId: identity.instanceId,
      identity,
      lastSeen: Date.now(),
      seq: 0,
      revision: ++this.#revision,
      snapshot: null,
      gap: false,
      pending: null,
      pollActive: false,
      completed: new Map(),
    };
    this.#connections.set(row.target.sessionId, connection);
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
      connection.snapshot = snapshot;
      connection.gap = false;
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
        snapshot.streamText = "";
      } else if (event.type === "text") {
        if (snapshot.currentTurnId !== event.turnId) throw new Error("bridge-turn-mismatch");
        if (Buffer.byteLength(snapshot.streamText + event.text) > 128 * 1024) {
          connection.gap = true;
        } else snapshot.streamText += event.text;
      } else if (event.type === "turn-complete") {
        if (snapshot.currentTurnId === event.turnId) {
          snapshot.status = "idle";
          snapshot.waiting = null;
          snapshot.currentTurnId = null;
          snapshot.streamText = "";
        }
      } else if (event.type === "tool-start" || event.type === "tool-complete") {
        snapshot.toolItems = [
          ...snapshot.toolItems.filter((tool) => tool.id !== event.tool.id),
          event.tool,
        ].slice(-256);
      }
    }
    connection.revision = ++this.#revision;
    this.#publish(id);
  }

  #complete(
    row: Binding,
    connection: Connection,
    event: Extract<ClaudeBridgeEvent, { type: "turn-complete" }>,
  ): void {
    connection.completed.set(
      event.turnId,
      event.aborted || connection.completed.get(event.turnId) === true,
    );
    if (connection.completed.size > 256)
      connection.completed.delete(connection.completed.keys().next().value!);
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
  #publish(id: string): void {
    if (!this.#bindings.has(id)) return;
    const live = this.live(id, true);
    const connection = this.#connections.get(id);
    if (!connection?.snapshot || !this.#online(id)) {
      this.options.publish(id, "snapshot", { live, items: [], replaceItems: false }, live);
      return;
    }
    this.options.publish(id, "state", live, live);
    if (connection?.snapshot && this.#online(id)) {
      for (const tool of connection.snapshot.toolItems)
        this.options.publish(
          id,
          "item-upsert",
          {
            id: `claude-follower-tool:${tool.id}`,
            kind: "tool-summary",
            content: "",
            tool_name: sanitizeSessionText(tool.name, { value: 0 }),
            tool_status: tool.status,
            attachment_count: 0,
            truncated: false,
            turn_id: connection.snapshot.currentTurnId,
          },
          live,
        );
    }
  }
  #disconnect(id: string): void {
    const connection = this.#connections.get(id);
    if (!connection) return;
    const overlays =
      connection.snapshot?.toolItems.map((tool) => `claude-follower-tool:${tool.id}`) ?? [];
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
      if (!pending.delivered) finishManagedCommand(this.options.dataDir, pending.requestId, result);
      pending.resolve(result);
    }
    this.#publish(id);
    if (overlays.length) {
      const live = this.live(id, true);
      this.options.publish(
        id,
        "snapshot",
        { live, items: [], replaceItemIds: overlays, completeItems: false },
        live,
      );
    }
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#challenges.clear();
    await this.#listening?.catch(() => undefined);
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
  }
}
