import { createHash, randomUUID } from "node:crypto";
import type { ConversationReadResult } from "@agentkib/runtime-protocol";
import { z } from "zod";
import type { ContextUsage } from "../../context-usage";
import type { ReadStateTarget } from "../../conversation-read-state";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
  managedSessionHasUnknownCommands,
  readManagedUsageLimit,
  replayManagedCommand,
  saveManagedUsageLimit,
} from "../../managed-ledger";
import type { LeadToolRegistration } from "../../orchestration-endpoint";
import type { WorkerRestartRequest, WorkerRestartResult } from "../../orchestration-service";
import { canonicalize, lexicalPathIdentity, pathIdentity } from "../../paths";
import { conversationReadKey, ReadStateLedger } from "../../read-state-ledger";
import type { SerialQueueTarget } from "../../sessions/serial-session-queue";
import {
  sessionResultProjectors,
  type SessionProviderRequest,
  type SessionProviderResponse,
  type SessionProviders,
  type SessionQuery,
  type TypedSessionProvider,
} from "../../session-provider";
import type { SessionReaders } from "../../session-readers";
import {
  stableJson,
  type ApplyManagedControl,
  type managedControlSchema,
} from "../../sessions/control-admission";
import { legacySessionFields } from "../../sessions/routing";
import { validateDevinControl } from "../../sessions/validate/devin";
import type { BackendStore } from "../../store";
import {
  AUTO_CONTINUE_TEXT,
  armUsageLimit,
  holdUsageLimit,
  parseUsageLimit,
  usageLimitArmable,
  usageLimitAutoContinue,
  usageLimitContinue,
  usageLimitView,
  type UsageLimit,
  type UsageLimitHit,
} from "../../usage-limit";
import { devinExecutable } from "./devin-executable";
import { devinSessionHome } from "./devin-sessions";
import { devinLimitReset, readDevinUsage, type DevinUsageWindow } from "./devin-usage";
import { DEVIN_DEFAULT_PERMISSION_MODE, DevinSessionSettings } from "./devin-session-settings";
import {
  DEVIN_EXECUTION_MODE,
  DEVIN_MAX_PROMPT_BYTES,
  DEVIN_MODEL_EFFORTS,
  DEVIN_PERMISSION_MODES,
  DevinManagedRunner,
  devinChildEnvironment,
  devinItemInTurn,
  devinModelCatalog,
  devinModelVariant,
  emptyDevinModelCatalog,
  resolveDevinModel,
  type DevinModelCatalog,
  type DevinModelVariant,
  type DevinRunnerHost,
  type DevinTurnEnd,
  type DevinTurnSettings,
} from "./devin-managed-runner";

/** A Devin session starts with its first message: Devin stores a session only once a turn runs. */
const devinCreateSchema = z
  .object({
    operation: z.literal("devin-create"),
    requestId: z.string().uuid(),
    deviceId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_:-]+$/),
    workspaceId: z.string().min(1).max(256),
    prompt: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= DEVIN_MAX_PROMPT_BYTES),
    model: z
      .string()
      .regex(/^[A-Za-z0-9._:@/+-]{1,128}$/)
      .optional(),
    effort: z.string().min(1).max(64).optional(),
    serviceTier: z.string().min(1).max(128).optional(),
    permissionMode: z.enum(DEVIN_PERMISSION_MODES).optional(),
  })
  .strict();

type DevinModelSelection = {
  model?: string;
  effort?: string | null;
  serviceTier?: string | null;
};

const DEVIN_SPEED_NAMES = {
  fast: "Fast",
  priority: "Priority",
  lightning: "Lightning",
};

function devinModelOptions(catalog: DevinModelCatalog) {
  const exact: Array<{
    id: string;
    name?: string;
    efforts: string[];
    serviceTierIds: string[];
    maxContextTokens?: number;
    variants: DevinModelVariant[];
  }> = [];
  const exactLimit = 256 - catalog.families.length;
  const familyIds = new Set(catalog.families.map(({ id }) => id));
  const families = catalog.families.map((family) => {
    const allVariants = catalog.variantsByFamily.get(family.id) ?? [];
    const variants = allVariants.slice(0, 128);
    const maxContextTokens = variants[0]?.maxContextTokens;
    const sameCapacity =
      maxContextTokens !== undefined &&
      allVariants.every((variant) => variant.maxContextTokens === maxContextTokens);
    for (const variant of variants) {
      // Native variants without normal effort/tier controls (for example Thinking + 1M)
      // remain selectable by their own IDs.
      if (
        exact.length < exactLimit &&
        variants.length > 1 &&
        !variant.effort &&
        !variant.serviceTierId &&
        !familyIds.has(variant.id)
      )
        exact.push({
          id: variant.id,
          name: variant.name,
          efforts: [],
          serviceTierIds: [],
          maxContextTokens: variant.maxContextTokens,
          variants: [variant],
        });
    }
    return {
      ...family,
      efforts: DEVIN_MODEL_EFFORTS.filter((effort) =>
        variants.some((variant) => variant.effort === effort),
      ),
      serviceTierIds: [
        ...new Set(
          variants.flatMap((variant) => (variant.serviceTierId ? [variant.serviceTierId] : [])),
        ),
      ],
      variants,
      ...(sameCapacity ? { maxContextTokens } : {}),
    };
  });
  const serviceTiers = [...new Set(families.flatMap((model) => model.serviceTierIds))].map(
    (id) => ({ id, name: DEVIN_SPEED_NAMES[id] }),
  );
  return { models: [...families, ...exact], serviceTiers };
}

function devinSelectedVariant(
  catalog: DevinModelCatalog,
  selectedModel?: string | null,
  nativeModel?: string | null,
) {
  const native = nativeModel ? devinModelVariant(catalog, nativeModel) : undefined;
  if (!selectedModel) return native;
  // A family previously saved by AgentKib still goes to the CLI as a family. Its last actual
  // variant can identify the existing effort, as long as that variant belongs to this family.
  return (
    devinModelVariant(catalog, selectedModel) ??
    (native?.familyId === selectedModel ? native : undefined)
  );
}

function devinSettingsModel(
  choice: DevinModelSelection,
  catalog: DevinModelCatalog,
  currentId?: string | null,
  nativeModel?: string | null,
) {
  const { model, effort, serviceTier } = choice;
  const target = model ?? currentId ?? nativeModel;
  if (!target) throw new Error("unsupported-model");
  const current = devinSelectedVariant(catalog, currentId, nativeModel);
  const proposed = devinModelVariant(catalog, target);
  const familyId = proposed?.familyId ?? target;
  const previous = proposed ?? (current?.familyId === familyId ? current : undefined);
  const selectedEffort = effort === undefined ? previous?.effort : (effort ?? undefined);
  const selectedTier =
    serviceTier === undefined ? previous?.serviceTierId : (serviceTier ?? undefined);
  const variants = catalog.variantsByFamily.get(familyId);
  if (!variants?.length) throw new Error("unsupported-model");
  if (selectedEffort && !variants.some((variant) => variant.effort === selectedEffort))
    throw new Error("unsupported-effort");
  // Turning off Fast is an explicit choice of a standard variant even without a known effort.
  if (serviceTier === null && !selectedEffort) {
    const standard = variants.filter((variant) => !variant.serviceTierId);
    if (standard.length !== 1) throw new Error("unsupported-service-tier");
    return standard[0]!.id;
  }
  const resolved = resolveDevinModel(catalog, {
    modelId: familyId,
    effort: selectedEffort,
    serviceTierId: selectedTier,
  });
  if (!resolved)
    throw new Error(serviceTier !== undefined ? "unsupported-service-tier" : "unsupported-effort");
  return resolved;
}

/** A usage limit's notice kept longer than this is not shown after a restart. */
const KEPT_LIMIT_MS = 7 * 24 * 60 * 60_000;
/** Longer waits are taken a day at a time: a timer cannot wait much more than 24 days. */
const LIMIT_TIMER_MS = 24 * 60 * 60_000;
/** A read of Devin's `/usage`; `known` once it ended, whether it named any window. */
type DevinUsageRead = { at: number; read: Promise<DevinUsageWindow[] | null>; known?: boolean };

type DevinExecutor = SessionProviders["devin"];

type DevinSessionHost = {
  store: BackendStore;
  sessions: SessionReaders;
  dataDir: string;
  environment: NodeJS.ProcessEnv;
  runtimeBootId: string;
  publishConversationEvent?: (
    sessionId: string,
    type: "state" | "text-delta" | "item-upsert" | "snapshot",
    payload: Record<string, unknown>,
    live: Record<string, unknown>,
  ) => void;
  catalogChanged?(): void;
  recordResult(
    target: Omit<ReadStateTarget, "transcript">,
    result: ConversationReadResult,
    options: { turnStartedAt: string },
  ): void;
  turnEnded(
    sessionId: string,
    turnId: string,
    outcome: string,
    durationMs: number,
    historyTurnId: string | undefined,
    replyText: string | null,
  ): void;
  /** A turn now waits for the person to answer one of Devin's permission requests. */
  laneWaiting?(sessionId: string, turnId: string): void;
  isShuttingDown(): boolean;
  serialQueueTarget(sessionId: string): SerialQueueTarget | undefined;
  admitControl(value: Record<string, unknown>, execute: ApplyManagedControl): Promise<unknown>;
  queue: NonNullable<DevinExecutor["queue"]>;
  readSession(value: Record<string, unknown>): Promise<unknown>;
  querySession(value: SessionQuery): Promise<unknown>;
  readSettingsSessionId(value: Record<string, unknown>): string;
  settingsState(value: Record<string, unknown>): Promise<unknown>;
  controlSession(value: Record<string, unknown>): Promise<unknown>;
  personControlled?(sessionId: string, operation: string): void;
  normalizeContextUsage(snapshot: { usage?: unknown; reason?: unknown }): ContextUsage;
};

type DevinRunnerRecord = {
  runner: DevinManagedRunner;
  lastUsed: number;
  settings: DevinTurnSettings;
  /** The workspace the session belongs to; its live state names it for access checks. */
  workspaceId: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class DevinSessionProvider implements DevinExecutor, TypedSessionProvider {
  readonly agent = "devin" as const;
  readonly validateControl = validateDevinControl;
  readonly createOperation = "devin-create";
  readonly typed = this;
  #runners = new Map<string, DevinRunnerRecord>();
  /** Where a Project Agent's worker tools are served (`OrchestrationService.leadTools`). */
  #leadEndpoint: ((sessionId: string) => Promise<LeadToolRegistration | null>) | undefined;

  leadEndpoints(
    source: ((sessionId: string) => Promise<LeadToolRegistration | null>) | undefined,
  ): void {
    this.#leadEndpoint = source;
  }

  /**
   * Whether a Devin session could be a Project Agent: a Devin session Devin stored, which
   * AgentKib runs over ACP. Its turns are then offered the worker tools.
   */
  leadCapable(sessionId: string): boolean {
    return this.host.store.sessions.get(sessionId)?.agent === "devin";
  }
  #savedSettings: DevinSessionSettings | undefined;
  /**
   * The usage limit each Devin session AgentKib runs last met, and the continue armed for it, as
   * `#codexLimits` holds Codex's. The notice is also kept in the managed ledger, so that it
   * outlives a restart. `continuing` is the request of the continue AgentKib sent, until that
   * turn ends.
   */
  #limits = new Map<
    string,
    { limit: UsageLimit; timer?: ReturnType<typeof setTimeout>; continuing?: string }
  >();
  /** The device whose message each Devin session last took. */
  #senders = new Map<string, string>();
  /** The last read of Devin's `/usage`, shared by sessions that meet a limit together. */
  #usageRead?: DevinUsageRead;
  #usageAbort = new AbortController();
  #models: { at: number; catalog: DevinModelCatalog } | undefined;

  constructor(private readonly host: DevinSessionHost) {}

  beginShutdown(): void {
    for (const entry of this.#limits.values()) clearTimeout(entry.timer);
    this.#usageAbort.abort();
  }

  close(): void {
    for (const record of this.#runners.values()) record.runner.close();
    this.#runners.clear();
  }

  invalidateUsageLimitDevice(deviceId: string): void {
    for (const [sessionId, held] of this.#limits)
      if (held.limit.deviceId === deviceId && held.limit.continueAt !== null)
        this.#armUsageLimit(sessionId, { ...held.limit, continueAt: null, manual: "cancelled" });
  }

  queue(request: Parameters<NonNullable<DevinExecutor["queue"]>>[0]) {
    return this.host.queue(request);
  }

  settingsState(value: Record<string, unknown>) {
    return this.#settingsState(this.host.readSettingsSessionId(value));
  }

  updateSettings(value: Record<string, unknown>) {
    return this.control(value);
  }

  control(value: Record<string, unknown>, beforeNativeDispatch?: () => void) {
    return this.host.admitControl(value, (request, fingerprint) =>
      this.#executeControl(request, fingerprint, beforeNativeDispatch),
    );
  }

  /** A print turn owns its process. The next send starts a new process with the same native ID. */
  async restartWorker(
    request: WorkerRestartRequest,
    beforeDispatch: () => void,
  ): Promise<WorkerRestartResult> {
    const { workspaceId, turnId, ...control } = request;
    const { sessionId } = request;
    const reject = (reason: string): WorkerRestartResult => ({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason,
    });
    try {
      const result = await this.host.admitControl(
        { ...control, operation: "stop", ...(turnId === null ? {} : { turnId }) },
        async (stop, fingerprint) => {
          const record = this.#runners.get(sessionId);
          // A record can exist merely because a client read live state. Only a running
          // process owned by this provider can be recycled.
          const nativeId = record?.runner.nativeId;
          if (!record || !nativeId) return reject("worker-restart-user-only");
          const snapshot = record.runner.snapshot();
          if (snapshot.stopEnabled !== true)
            return reject(snapshot.cancelling ? "worker-not-running" : "worker-restart-user-only");
          const sameTarget = () => {
            const target = this.host.serialQueueTarget(sessionId);
            if (
              target?.agent !== "devin" ||
              target.workspaceId !== workspaceId ||
              record.workspaceId !== workspaceId ||
              this.#runners.get(sessionId) !== record ||
              this.host.store.sessions.id("devin", nativeId) !== sessionId
            )
              return false;
            try {
              return (
                lexicalPathIdentity(canonicalize(this.host.store.workspacePath(workspaceId))) ===
                lexicalPathIdentity(record.runner.workspace)
              );
            } catch {
              return false;
            }
          };
          if (!sameTarget()) return reject("workspace-not-allowed");
          if (this.host.isShuttingDown()) return reject("control-unavailable");
          return this.#executeControl(stop, fingerprint, () => {
            if (!sameTarget()) throw new Error("workspace-not-allowed");
            if (this.host.isShuttingDown()) throw new Error("control-unavailable");
            beforeDispatch();
          });
        },
      );
      if (isObject(result)) {
        if (result.accepted === true) return { accepted: true, controlOutcome: "accepted" };
        const reason = typeof result.reason === "string" ? result.reason : "worker-restart-failed";
        if (result.controlOutcome === "unknown") {
          return { accepted: false, controlOutcome: "unknown", reason };
        }
        return reject(reason);
      }
      return reject("worker-restart-failed");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "worker-restart-failed";
      if (reason === "control-outcome-unconfirmed")
        return { accepted: false, controlOutcome: "unknown", reason };
      return reject(reason);
    }
  }

  request<Request extends SessionProviderRequest>(
    request: Request,
  ): Promise<SessionProviderResponse<Request["operation"]>>;
  async request(request: SessionProviderRequest): Promise<SessionProviderResponse> {
    const operation = request.operation;
    const raw = await this.#request(request);
    return {
      operation,
      result: sessionResultProjectors[operation](this.agent, raw),
    } as SessionProviderResponse;
  }

  async #request(request: SessionProviderRequest): Promise<unknown> {
    switch (request.operation) {
      case "create":
        return this.create({ ...request, operation: this.createOperation });
      case "settings-prepare":
        throw new Error("unsupported-session-provider-operation");
      case "live":
      case "usage":
      case "queue-start":
      case "queue-steer":
        return this.host.readSession(legacySessionFields(request));
      case "inspect":
      case "capabilities":
        return this.host.querySession(request);
      case "queue-list": {
        const { operation, sessionId, limit } = request;
        return this.queue({ operation, sessionId, limit });
      }
      case "settings-state":
        return this.host.settingsState(request);
      default: {
        const result = await this.host.controlSession(request);
        if (isObject(result) && result.accepted === true)
          this.host.personControlled?.(request.sessionId, request.operation);
        return result;
      }
    }
  }

  #saved() {
    this.#savedSettings ??= new DevinSessionSettings(this.host.dataDir);
    return this.#savedSettings;
  }

  #runnerHost(
    workspace: string,
    workspaceId: string,
    sessionId: () => string | null,
  ): DevinRunnerHost {
    const environment = devinChildEnvironment({ ...process.env, ...this.host.environment });
    const page = (nativeId: string, limit: number) =>
      this.host.sessions.eventsForNative("devin", nativeId, workspace, null, limit);
    return {
      executable: () => devinExecutable(environment),
      environment,
      latestItems: async (nativeId) =>
        (await page(nativeId, 100)).events.map((event) => ({
          ...event,
          turn_id: event.turn_id ?? event.id,
          ephemeral: false,
        })),
      listSessions: async () =>
        (await this.host.sessions.list("devin", workspace)).sessions.map((session) => ({
          nativeId: session.native_ref,
          createdAt: Date.parse(session.created_at ?? "") || 0,
        })),
      firstUserText: async (nativeId) =>
        (await page(nativeId, 20)).events.find((event) => event.kind === "user-message")?.content ??
        null,
      turnEnded: (end) => {
        const id = sessionId();
        if (id) this.#turnEnded(id, workspace, end);
      },
      waiting: (turnId) => {
        const id = sessionId();
        if (id) this.host.laneWaiting?.(id, turnId);
      },
      // A Project Agent's turns are offered its worker tools, read again for every turn.
      leadTools: async () => {
        const id = sessionId();
        return id ? ((await this.#leadEndpoint?.(id)) ?? null) : null;
      },
      publish: (type, payload, live) => {
        const id = sessionId();
        if (!id) return;
        const current = {
          ...live,
          sessionId: id,
          runtimeBootId: this.host.runtimeBootId,
          workspaceId,
        };
        const eventPayload =
          type === "state"
            ? current
            : isObject(payload.live)
              ? { ...payload, live: current }
              : payload;
        this.host.publishConversationEvent?.(id, type, eventPayload, current);
      },
    };
  }

  /**
   * A Devin turn AgentKib ran ended. Its result goes to the read state, which unread results and
   * the phone's alerts come from; a usage limit it met is held as Codex's are, and any other end
   * is the next turn after a limit, which ends the hold.
   */
  #turnEnded(sessionId: string, workspace: string, end: DevinTurnEnd): void {
    try {
      this.host.recordResult(
        {
          provider: "devin",
          home: devinSessionHome(this.host.environment),
          nativeId: end.nativeId,
          workspace,
        },
        {
          id: `turn:${end.turnId}`,
          turnId: end.historyTurnId,
          itemId: end.answerItemId,
          outcome: end.outcome,
          completedAt: end.endedAt,
        },
        { turnStartedAt: end.startedAt },
      );
    } catch {
      // A result that cannot be recorded changes nothing about the turn.
    }
    this.host.turnEnded(
      sessionId,
      end.turnId,
      end.outcome,
      Math.max(0, Date.parse(end.endedAt) - Date.parse(end.startedAt)),
      end.observedHistoryTurnId,
      end.observedReplyText ?? null,
    );
    if (end.usageLimit) void this.#holdUsageLimit(sessionId, workspace, end.usageLimit);
    else if (this.#limits.has(sessionId)) this.#armUsageLimit(sessionId, null);
  }

  /** Devin's native history has no terminal markers. Only AgentKib-observed results can catch up. */
  async endedTurns(sessionId: string) {
    const source = await this.host.sessions.resolve(sessionId);
    if (source.native.agent !== "devin") return [];
    const rows = new ReadStateLedger(this.host.dataDir)
      .recentTerminalResults(
        conversationReadKey(
          "devin",
          devinSessionHome(this.host.environment),
          source.native.native_ref,
        ),
      )
      .filter(
        ({ result, startedAt }) => startedAt && result.completedAt && result.id.startsWith("turn:"),
      );
    if (!rows.length) return [];
    const page = await this.host.sessions
      .eventsForNative("devin", source.native.native_ref, source.workspace, null, 100)
      .catch(() => null);
    const current = this.host.serialQueueTarget(sessionId);
    if (
      current?.agent !== "devin" ||
      current.workspaceId !== source.summary.workspace_id ||
      current.nativeId !== this.host.store.sessions.id("devin", source.native.native_ref)
    )
      return [];
    const events = new Map(page?.events.map((item) => [item.id, item]));
    return rows.map(({ result, startedAt }) => {
      const answer = result.itemId ? events.get(result.itemId) : undefined;
      const hasAnswer =
        answer?.kind === "agent-message" &&
        answer.turn_id === result.turnId &&
        devinItemInTurn(
          answer.timestamp,
          Date.parse(startedAt ?? ""),
          Date.parse(result.completedAt ?? ""),
        );
      return {
        turnId: result.id.slice("turn:".length),
        outcome: result.outcome,
        startedAt,
        endedAt: result.completedAt,
        ...(hasAnswer && result.turnId ? { historyTurnId: result.turnId } : {}),
        replyText: hasAnswer ? answer.content : null,
      };
    });
  }

  /**
   * Holds the limit a Devin turn met. The notice says so at once; when the limit resets follows
   * once Devin's `/usage` has said, and then the continue is armed as for Codex.
   */
  async #holdUsageLimit(sessionId: string, workspace: string, hit: UsageLimitHit): Promise<void> {
    const held = this.#limits.get(sessionId);
    const context = {
      deviceId: this.#senders.get(sessionId) ?? held?.limit.deviceId ?? "",
      bootId: this.host.runtimeBootId,
      // Only a turn AgentKib's continue started counts toward the three in a row.
      previous: held?.continuing ? held.limit : null,
      autoContinue: usageLimitAutoContinue(this.host.dataDir),
    };
    const first = holdUsageLimit("devin", hit, context);
    this.#armUsageLimit(sessionId, first);
    const windows = await this.#usageWindows(workspace);
    const reset = windows ? devinLimitReset(windows, hit) : null;
    // A turn that started meanwhile decides instead.
    if (!reset || this.host.isShuttingDown() || this.#limits.get(sessionId)?.limit !== first)
      return;
    this.#armUsageLimit(sessionId, holdUsageLimit("devin", { ...hit, ...reset }, context));
  }

  /**
   * Devin's `/usage` (`devin-usage.ts`), read in the session's workspace. Sessions that meet the
   * account's limit together share one read; a read that told nothing is not reused.
   */
  #usageWindows(workspace: string): Promise<DevinUsageWindow[] | null> {
    const recent = this.#usageRead;
    if (recent && recent.known !== false && Date.now() - recent.at < 60_000) return recent.read;
    const environment = devinChildEnvironment({ ...process.env, ...this.host.environment });
    const executable = devinExecutable(environment);
    const read = executable
      ? readDevinUsage(executable, workspace, environment, {
          signal: this.#usageAbort.signal,
        }).catch(() => null)
      : Promise.resolve(null);
    const entry: DevinUsageRead = { at: Date.now(), read };
    void read.then((windows) => {
      entry.known = !!windows?.length;
    });
    this.#usageRead = entry;
    return read;
  }

  /**
   * Holds `limit` for a Devin session (null ends the hold), arms its continue, keeps its notice
   * for a later run of AgentKib, and with `show` puts it on the session's live state.
   */
  #armUsageLimit(
    sessionId: string,
    limit: UsageLimit | null,
    continuing?: string,
    show = true,
  ): void {
    const held = this.#limits.get(sessionId);
    clearTimeout(held?.timer);
    if (!limit) this.#limits.delete(sessionId);
    else {
      const timer =
        limit.continueAt === null
          ? undefined
          : setTimeout(
              () => void this.#fireContinue(sessionId).catch(() => undefined),
              Math.min(LIMIT_TIMER_MS, Math.max(0, limit.continueAt - Date.now())),
            );
      timer?.unref?.();
      this.#limits.set(sessionId, { limit, timer, continuing });
    }
    try {
      // What the person is told outlives a restart; a continue on its way is a turn that started.
      saveManagedUsageLimit(this.host.dataDir, sessionId, limit && !continuing ? limit : null);
    } catch {
      // The notice still shows until AgentKib quits.
    }
    if (show)
      this.#runners
        .get(sessionId)
        ?.runner.showUsageLimit(usageLimitView(limit, this.host.runtimeBootId));
  }

  /** A new runner shows the hold for its session, also one an earlier run of AgentKib kept. */
  #showUsageLimit(sessionId: string, runner: DevinManagedRunner): void {
    let limit = this.#limits.get(sessionId)?.limit;
    if (!limit) {
      let kept: ReturnType<typeof readManagedUsageLimit> = null;
      try {
        kept = readManagedUsageLimit(this.host.dataDir, sessionId);
      } catch {
        kept = null;
      }
      const parsed = kept ? parseUsageLimit(kept.limit, "devin") : null;
      if (parsed && Date.now() - kept!.savedAt < KEPT_LIMIT_MS) {
        // A continue an earlier run armed ended with it: the person continues, or arms it again.
        limit =
          usageLimitContinue(parsed, this.host.runtimeBootId) === "never" &&
          parsed.continueAt !== null
            ? { ...parsed, continueAt: null, manual: "restarted" }
            : parsed;
        this.#limits.set(sessionId, { limit });
      }
    }
    if (limit) runner.showUsageLimit(usageLimitView(limit, this.host.runtimeBootId));
  }

  /**
   * The continue armed after a Devin usage limit is due: AgentKib sends its continue in the name
   * of the device whose turn met the limit, as for Codex.
   */
  async #fireContinue(sessionId: string): Promise<void> {
    const held = this.#limits.get(sessionId);
    if (!held || this.host.isShuttingDown()) return;
    const due = usageLimitContinue(held.limit, this.host.runtimeBootId);
    if (due === "never") return;
    if (due === "wait") return this.#armUsageLimit(sessionId, held.limit);
    if (due === "stale")
      return this.#armUsageLimit(sessionId, { ...held.limit, continueAt: null, manual: "stale" });
    const requestId = randomUUID();
    this.#armUsageLimit(
      sessionId,
      { ...held.limit, continueAt: null, autoContinues: held.limit.autoContinues + 1 },
      requestId,
      false,
    );
    const live = await this.live(sessionId).catch(() => null);
    if (!live || live.status !== "idle" || live.sendEnabled !== true)
      // Something else runs: look again shortly.
      return this.#armUsageLimit(sessionId, { ...held.limit, continueAt: Date.now() + 60_000 });
    const result = (await this.host
      .controlSession({
        operation: "send",
        sessionId,
        requestId,
        ...(held.limit.deviceId ? { deviceId: held.limit.deviceId } : {}),
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        text: AUTO_CONTINUE_TEXT.devin,
      })
      .catch(() => null)) as Record<string, unknown> | null;
    const current = this.#limits.get(sessionId);
    if (result?.accepted !== true && current?.continuing === requestId)
      // Refused: the person continues.
      this.#armUsageLimit(sessionId, { ...current.limit, manual: "stale" });
  }

  /**
   * The person's choice about a Devin session's continue: off this time (`usage-limit-cancel`),
   * or on. Armed again, it goes in the name of the device that asked.
   */
  #limitChoice(
    request: z.infer<typeof managedControlSchema>,
    fingerprint: string,
    choose: (limit: UsageLimit) => UsageLimit | null,
  ): Record<string, unknown> {
    const held = this.#limits.get(request.sessionId);
    const next = held && !held.continuing ? choose(held.limit) : null;
    if (!next) throw new Error("usage-limit-continue-unavailable");
    const claimed = claimManagedCommand(
      this.host.dataDir,
      request.requestId,
      request.sessionId,
      fingerprint,
      request.deviceId ?? null,
      {
        operation: request.operation,
        workspaceId: this.host.store.sessions.get(request.sessionId)?.workspace_id ?? null,
        runtimeBootId: request.runtimeBootId,
        expectedRevision: request.expectedRevision,
        executionMode: DEVIN_EXECUTION_MODE,
        turnId: null,
        nativeRequestId: null,
      },
    );
    if (claimed) return claimed;
    this.#armUsageLimit(request.sessionId, next);
    const result = {
      sessionId: request.sessionId,
      accepted: true,
      completed: true,
      requestId: request.requestId,
      runtimeBootId: this.host.runtimeBootId,
    };
    finishManagedCommand(this.host.dataDir, request.requestId, result);
    return result;
  }

  /**
   * A Devin row of the catalog while AgentKib holds the session's runner. Its turns run in a
   * `devin acp` AgentKib started, which quitting ends, so the home, menu bar, push and the quit
   * confirmation count a running one as they do the other agents' turns.
   */
  continuation<T extends { id: string }>(session: T): T {
    const live = this.#runners.get(session.id)?.runner.snapshot();
    if (!live) return session;
    return {
      ...session,
      continuation: {
        // A turn being stopped runs until its process exits.
        status: live.status === "running" || live.status === "stopping" ? "running" : "idle",
        executionLocation: "agentkib",
        ownershipReason: null,
        reason: live.reason ?? null,
      },
    };
  }

  #addRunner(
    sessionId: string,
    runner: DevinManagedRunner,
    settings: DevinTurnSettings,
    workspaceId: string,
  ) {
    if (this.#runners.size >= 8) {
      const [retireId, retire] =
        [...this.#runners.entries()]
          .filter(([, value]) => value.runner.snapshot().sendEnabled === true)
          .sort(([, left], [, right]) => left.lastUsed - right.lastUsed)[0] ?? [];
      if (!retireId || !retire) throw new Error("live-session-limit");
      this.#runners.delete(retireId);
      retire.runner.close();
    }
    const record = { runner, lastUsed: Date.now(), settings, workspaceId };
    this.#runners.set(sessionId, record);
    return record;
  }

  async #runner(sessionId: string) {
    const existing = this.#runners.get(sessionId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    const resolved = await this.host.sessions.resolve(sessionId);
    if (resolved.native.agent !== "devin") throw new Error("session-unavailable");
    const workspaceId = resolved.summary.workspace_id;
    const workspace = canonicalize(this.host.store.workspacePath(workspaceId));
    const runner = new DevinManagedRunner(
      workspace,
      resolved.native.native_ref,
      this.#runnerHost(workspace, workspaceId, () => sessionId),
    );
    // Without a saved choice a resumed turn keeps the session's model and edits the workspace.
    const record = this.#addRunner(
      sessionId,
      runner,
      this.#saved().get(resolved.native.native_ref),
      workspaceId,
    );
    this.#showUsageLimit(sessionId, runner);
    return record;
  }

  async live(sessionId: string): Promise<Record<string, unknown>> {
    try {
      const record = await this.#runner(sessionId);
      return {
        ...record.runner.snapshot(),
        sessionId,
        runtimeBootId: this.host.runtimeBootId,
        // Restricted devices may control sessions in their workspaces only.
        workspaceId: record.workspaceId,
      };
    } catch (error) {
      return {
        sessionId,
        executionMode: DEVIN_EXECUTION_MODE,
        runtimeBootId: this.host.runtimeBootId,
        workspaceId: this.host.store.sessions.get(sessionId)?.workspace_id ?? null,
        status: "unsupported",
        revision: 0,
        turnId: null,
        sendEnabled: false,
        stopEnabled: false,
        approvals: [],
        questions: [],
        reason: error instanceof Error ? error.message : "open-in-original-client",
      };
    }
  }

  async query(request: SessionQuery) {
    const live = await this.live(request.sessionId);
    const experimental = request.experimentalEnabled === true;
    const canStageSettings = this.#runners.get(request.sessionId)?.runner.canStageSettings;
    const held = this.#limits.get(request.sessionId);
    const limitChoice = (available: boolean) =>
      experimental && available && !held?.continuing && live.status !== "unsupported"
        ? { available: true }
        : { available: false, reason: "usage-limit-continue-unavailable" };
    const reason =
      live.status === "unsupported"
        ? String(live.reason)
        : experimental
          ? ((live.reason as string | null) ?? null)
          : "control-disabled";
    const unsupported = { available: false, reason: "unsupported-operation" };
    const features = {
      send:
        experimental && live.sendEnabled === true
          ? { available: true }
          : { available: false, reason: reason ?? "session-busy" },
      stop:
        experimental && live.stopEnabled === true
          ? { available: true }
          : { available: false, reason: reason ?? "session-not-running" },
      "settings-state": { available: live.status !== "unsupported" },
      // Host workspace browsing has no native resource-attachment support.
      resources: { available: live.status !== "unsupported" },
      files: { available: live.status !== "unsupported" },
      context: unsupported,
      settings:
        experimental && canStageSettings
          ? { available: true }
          : { available: false, reason: reason ?? "session-unavailable" },
      // Devin asks for a permission over ACP while a turn waits; it asks no free-form questions.
      approve:
        experimental && live.status === "waiting-approval"
          ? { available: true }
          : { available: false, reason: reason ?? "no-pending-approval" },
      answer: unsupported,
      inspect: { available: live.status !== "unsupported" },
      resume: unsupported,
      usage: { available: false, reason: "usage-not-reported" },
      // The continue armed after a usage limit, once Devin's `/usage` said when it resets.
      "usage-limit-cancel": limitChoice(typeof held?.limit.continueAt === "number"),
      "usage-limit-continue": limitChoice(usageLimitArmable(held?.limit, this.host.runtimeBootId)),
    };
    const base = {
      sessionId: request.sessionId,
      executionMode: DEVIN_EXECUTION_MODE,
      runtimeBootId: this.host.runtimeBootId,
      status: live.status,
      reason: live.reason,
    };
    return request.operation === "capabilities"
      ? { ...base, features }
      : { ...base, revision: live.revision, turnId: live.turnId, approvals: [] };
  }

  async #executeControl(
    request: z.infer<typeof managedControlSchema>,
    fingerprint: string,
    beforeNativeDispatch?: () => void,
  ) {
    const runtimeBootId = this.host.runtimeBootId;
    if (!request.experimentalEnabled || request.runtimeBootId !== runtimeBootId)
      throw new Error("stale-or-disabled-control");
    if (
      ![
        "send",
        "stop",
        "approve",
        "settings",
        "usage-limit-cancel",
        "usage-limit-continue",
      ].includes(request.operation)
    )
      throw new Error("unsupported-operation");
    if (
      request.operation === "usage-limit-cancel" ||
      request.operation === "usage-limit-continue"
    ) {
      // The runner shows the hold, also one kept from before a restart.
      const record = await this.#runner(request.sessionId);
      if (request.expectedRevision !== record.runner.snapshot().revision)
        throw new Error("stale-or-disabled-control");
      return request.operation === "usage-limit-cancel"
        ? this.#limitChoice(request, fingerprint, (limit) =>
            limit.continueAt === null ? null : { ...limit, continueAt: null, manual: "cancelled" },
          )
        : this.#limitChoice(request, fingerprint, (limit) => {
            const armed = armUsageLimit(limit, { bootId: runtimeBootId });
            return armed && request.deviceId ? { ...armed, deviceId: request.deviceId } : armed;
          });
    }
    if (
      request.operation === "settings" &&
      request.model !== undefined &&
      !/^[A-Za-z0-9._:@/+-]{1,128}$/.test(request.model)
    )
      throw new Error("unsupported-model");
    // AgentKib sends Devin text only; attachments are refused rather than dropped.
    if (request.input?.length || request.historyReferences?.length || request.resourceRefs?.length)
      throw new Error("attachments-unsupported");
    if (managedSessionHasUnknownCommands(this.host.dataDir, request.sessionId))
      throw new Error("control-outcome-unconfirmed");
    const record = await this.#runner(request.sessionId);
    if (request.expectedRevision !== record.runner.snapshot().revision)
      throw new Error("stale-or-disabled-control");
    const claimed = claimManagedCommand(
      this.host.dataDir,
      request.requestId,
      request.sessionId,
      fingerprint,
      request.deviceId ?? null,
      {
        operation: request.operation,
        workspaceId: this.host.store.sessions.get(request.sessionId)?.workspace_id ?? null,
        runtimeBootId,
        expectedRevision: request.expectedRevision,
        turnId: request.turnId ?? null,
        executionMode: DEVIN_EXECUTION_MODE,
        ...(request.historyInputHash ? { historyInputHash: request.historyInputHash } : {}),
      },
    );
    if (claimed) return claimed;
    let dispatched = false;
    const beforeDispatch = () => {
      beforeNativeDispatch?.();
      dispatchManagedCommand(this.host.dataDir, request.requestId);
      dispatched = true;
      if (request.operation !== "send") return;
      // The person's message takes over from a continue armed after a usage limit; the turn it
      // starts clears what the live state shows.
      const held = this.#limits.get(request.sessionId);
      if (held && held.continuing !== request.requestId)
        this.#armUsageLimit(request.sessionId, null, undefined, false);
      if (request.deviceId) this.#senders.set(request.sessionId, request.deviceId);
    };
    try {
      if (request.operation === "send") {
        if (typeof request.text !== "string") throw new Error("missing-text");
        await record.runner.send(
          request.text,
          request.expectedRevision,
          beforeDispatch,
          record.settings,
        );
      } else if (request.operation === "settings") {
        const { runner } = record;
        const nativeId = runner.nativeId;
        if (!nativeId || !runner.canStageSettings) throw new Error("session-unavailable");
        let model = request.model ?? record.settings.model;
        if (
          !request.resetDefaults &&
          (request.effort !== undefined || request.serviceTier !== undefined)
        ) {
          const catalog = await this.#readCatalog();
          if (
            this.#runners.get(request.sessionId) !== record ||
            !runner.canStageSettings ||
            runner.snapshot().revision !== request.expectedRevision
          )
            throw new Error("stale-or-disabled-control");
          model = devinSettingsModel(
            request,
            catalog,
            record.settings.model,
            this.host.sessions.devinSessionModel(nativeId),
          );
        }
        beforeDispatch();
        this.#saved().set(
          nativeId,
          request.resetDefaults
            ? {}
            : {
                ...(model ? { model } : {}),
                permissionMode: request.permissionMode ?? record.settings.permissionMode,
              },
        );
        record.settings = this.#saved().get(nativeId);
        runner.bump();
      } else if (request.operation === "approve") {
        if (
          request.approvalId === undefined ||
          typeof request.turnId !== "string" ||
          typeof request.decision !== "string"
        )
          throw new Error("missing-approval-decision");
        await record.runner.approve(
          String(request.approvalId),
          request.turnId,
          request.decision,
          request.expectedRevision,
          beforeDispatch,
        );
      } else {
        if (typeof request.turnId !== "string") throw new Error("missing-turn");
        await record.runner.stop(request.turnId, request.expectedRevision, beforeDispatch);
      }
      record.lastUsed = Date.now();
      const result = {
        accepted: true,
        // A settings change is applied when it is saved; the next turn runs with it.
        completed: request.operation === "settings",
        ...(request.operation === "settings" ? { appliesTo: "next-turn" } : {}),
        sessionId: request.sessionId,
        requestId: request.requestId,
        runtimeBootId,
      };
      finishManagedCommand(this.host.dataDir, request.requestId, result);
      return result;
    } catch (error) {
      const result = {
        accepted: false,
        completed: false,
        sessionId: request.sessionId,
        controlOutcome: dispatched ? "unknown" : "not-dispatched",
        reason: error instanceof Error ? error.message : "control-preflight-rejected",
        requestId: request.requestId,
        runtimeBootId,
      };
      if (!dispatched) finishManagedCommand(this.host.dataDir, request.requestId, result);
      return result;
    }
  }

  /**
   * Starts a Devin session with its first message and answers once Devin has stored it, so the
   * new session opens already running. Its model and permission mode apply to later turns too.
   */
  async create(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = devinCreateSchema.parse(value);
    const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
    const replay = replayManagedCommand(this.host.dataDir, request.requestId, fingerprint);
    if (replay) return replay;
    const result = (outcome: "accepted" | "not-dispatched" | "unknown", extra = {}) => ({
      accepted: outcome === "accepted",
      completed: outcome === "accepted",
      requestId: request.requestId,
      runtimeBootId: this.host.runtimeBootId,
      executionMode: DEVIN_EXECUTION_MODE,
      controlOutcome: outcome,
      ...extra,
    });
    let workspace: string;
    try {
      workspace = canonicalize(this.host.store.workspacePath(request.workspaceId));
    } catch {
      return result("not-dispatched", { reason: "workspace-unavailable" });
    }
    let created: string | null = null;
    const runner = new DevinManagedRunner(
      workspace,
      null,
      this.#runnerHost(workspace, request.workspaceId, () => created),
    );
    const prior = claimManagedCommand(
      this.host.dataDir,
      request.requestId,
      `devin-create:${request.requestId}`,
      fingerprint,
      request.deviceId,
      {
        operation: "create",
        workspaceId: request.workspaceId,
        runtimeBootId: this.host.runtimeBootId,
        executionMode: DEVIN_EXECUTION_MODE,
        claimedAt: Date.now(),
      },
    );
    if (prior) return prior;
    let dispatched = false;
    try {
      const model =
        request.effort !== undefined || request.serviceTier !== undefined
          ? devinSettingsModel(request, await this.#readCatalog())
          : request.model;
      const settings: DevinTurnSettings = {
        ...(model ? { model } : {}),
        permissionMode: request.permissionMode ?? DEVIN_DEFAULT_PERMISSION_MODE,
      };
      await runner.send(
        request.prompt,
        0,
        () => {
          dispatchManagedCommand(this.host.dataDir, request.requestId);
          dispatched = true;
        },
        settings,
      );
      let timer: NodeJS.Timeout | undefined;
      const nativeId = await Promise.race([
        runner.session(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("devin-session-unconfirmed")), 120_000);
        }),
      ]).finally(() => clearTimeout(timer));
      // Index it now so that its ID resolves before the next catalog refresh.
      this.host.store.sessions.sync(
        request.workspaceId,
        "devin",
        (await this.host.sessions.list("devin", workspace)).sessions,
        true,
      );
      created = this.host.store.sessions.id("devin", nativeId);
      // The choices made when it started apply to its later turns too, also after a restart.
      if (model || request.permissionMode)
        this.#saved().set(nativeId, {
          ...(model ? { model } : {}),
          ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
        });
      this.#addRunner(created, runner, settings, request.workspaceId);
      // Its first turn runs already: the catalog lists it in progress without waiting for it.
      this.host.catalogChanged?.();
      const outcome = result("accepted", { sessionId: created });
      finishManagedCommand(this.host.dataDir, request.requestId, outcome);
      return outcome;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "control-preflight-rejected";
      // A turn that ended without storing a session made nothing, so it may be sent again.
      if (!dispatched || reason !== "devin-session-unconfirmed") {
        runner.close();
        const outcome = result("not-dispatched", { reason });
        finishManagedCommand(this.host.dataDir, request.requestId, outcome);
        return outcome;
      }
      return result("unknown", { reason: "control-outcome-unconfirmed" });
    }
  }

  async contextUsage(sessionId: string): Promise<ContextUsage> {
    const settings = await this.#settingsState(sessionId);
    return this.host.normalizeContextUsage({
      usage: settings.historicalUsage ?? (settings.available ? { available: false } : undefined),
      reason: settings.reason,
    });
  }

  /**
   * A Devin session's settings in the shape the composer reads for managed sessions: the model
   * and permission mode its next turn runs with. Without a saved model a resumed turn keeps the
   * one Devin saved for the session.
   */
  async #settingsState(sessionId: string): Promise<Record<string, unknown>> {
    let record: DevinRunnerRecord;
    try {
      record = await this.#runner(sessionId);
    } catch (error) {
      return {
        available: false,
        executionMode: DEVIN_EXECUTION_MODE,
        revision: 0,
        reason: error instanceof Error ? error.message : "session-unavailable",
      };
    }
    const catalog = await this.#readCatalog();
    const options = devinModelOptions(catalog);
    const live = record.runner.snapshot();
    const nativeId = record.runner.nativeId;
    const nativeModel = nativeId ? this.host.sessions.devinSessionModel(nativeId) : null;
    const project = (settings: Readonly<DevinTurnSettings>) => {
      const selectedModel = settings.model ?? nativeModel;
      const variant = devinSelectedVariant(catalog, selectedModel, nativeModel);
      // An exact variant outside the family controls gets its own catalog row if available.
      const exact = variant && options.models.some((option) => option.id === variant.id);
      const model = variant ? (exact ? variant.id : variant.familyId) : selectedModel;
      const capacity =
        variant?.maxContextTokens ??
        options.models.find((option) => option.id === model)?.maxContextTokens;
      return {
        model,
        effort: variant?.effort ?? null,
        ...(variant?.serviceTierId ? { serviceTier: variant.serviceTierId } : {}),
        ...(variant ? { variantId: variant.id } : {}),
        ...(capacity !== undefined ? { maxContextTokens: capacity } : {}),
        permissionMode: settings.permissionMode ?? DEVIN_DEFAULT_PERMISSION_MODE,
      };
    };
    const selected = project(record.settings);
    const running = record.runner.runningSettings;
    const current = running ? project(running) : selected;
    const capacity = selected.maxContextTokens;
    const historicalUsage =
      nativeId &&
      nativeModel &&
      selected.variantId === nativeModel &&
      capacity !== undefined &&
      live.status === "idle"
        ? this.host.sessions.devinLastContextInput(nativeId, record.runner.workspace, nativeModel)
        : undefined;
    const mutable = record.runner.canStageSettings;
    return {
      available: true,
      executionMode: DEVIN_EXECUTION_MODE,
      revision: live.revision,
      current,
      selected,
      settings: selected,
      defaults: { model: null, effort: null, permissionMode: DEVIN_DEFAULT_PERMISSION_MODE },
      applicationStatus: "confirmed",
      ...options,
      ...(historicalUsage && capacity !== undefined && historicalUsage.usedTokens <= capacity
        ? {
            historicalUsage: {
              available: true,
              state: "stale",
              historical: true,
              reason: "devin-last-model-request",
              contextWindow: capacity,
              ...historicalUsage,
            },
          }
        : {}),
      permissionModes: DEVIN_PERMISSION_MODES.map((id) => ({ id, name: id })),
      writable: {
        model: { available: mutable && options.models.length > 0 },
        effort: { available: mutable && options.models.some((model) => model.efforts.length > 0) },
        serviceTier: { available: mutable && options.serviceTiers.length > 0 },
        permissionMode: { available: mutable },
        restoreDefaults: { available: mutable },
      },
    };
  }

  /**
   * What a new Devin session can start with. Without a CLI login the list is empty and Devin's
   * configured default applies; the login is explained only when a session is started.
   */
  async options(): Promise<Record<string, unknown>> {
    const environment = devinChildEnvironment({ ...process.env, ...this.host.environment });
    const executable = devinExecutable(environment);
    if (!executable) return { available: false, reason: "devin-cli-unavailable" };
    return {
      available: true,
      permissionModes: DEVIN_PERMISSION_MODES.map((id) => ({ id })),
      ...devinModelOptions(await this.#catalog(executable, environment)),
    };
  }

  async #readCatalog() {
    const environment = devinChildEnvironment({ ...process.env, ...this.host.environment });
    const executable = devinExecutable(environment);
    return executable ? this.#catalog(executable, environment) : emptyDevinModelCatalog();
  }

  async #catalog(executable: string, environment: NodeJS.ProcessEnv) {
    if (!this.#models || Date.now() - this.#models.at > 10 * 60_000)
      this.#models = {
        at: Date.now(),
        catalog: await devinModelCatalog(executable, environment),
      };
    return this.#models.catalog;
  }

  async resources(sessionId: string, workspaceId: string) {
    const source = await this.host.sessions.resolve(sessionId);
    const workspace = canonicalize(this.host.store.workspacePath(workspaceId));
    const latest = this.host.store.sessions.get(sessionId);
    if (
      source.native.agent !== "devin" ||
      source.native.sidechain ||
      !latest ||
      latest.agent !== "devin" ||
      latest.workspace_id !== workspaceId ||
      source.summary.workspace_id !== workspaceId ||
      pathIdentity(canonicalize(source.workspace)) !== pathIdentity(workspace)
    )
      throw new Error("session-workspace-mismatch");
    return {
      available: true,
      executionMode: DEVIN_EXECUTION_MODE,
      revision: this.#runners.get(sessionId)?.runner.snapshot().revision ?? 0,
      skills: [],
      plugins: [],
      apps: [],
      contextReferences: { supportedTypes: [] },
    };
  }
}
