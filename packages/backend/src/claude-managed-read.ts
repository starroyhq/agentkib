import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { resolveCommand } from "./command-resolution";
import type { Commands } from "./commands";
import type { SessionReaders } from "./session-readers";
import type { BackendStore } from "./store";
import { canonicalize, pathIdentity } from "./paths";
import { restrictRemotePath } from "./remote-tls";
import { acquirePortableFileLease } from "./managed-session-lock";
import {
  ClaudeManagedRunnerProcess,
  type ClaudeRunnerSnapshot,
  validateClaudeContent,
} from "./claude-managed-runner";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
  managedSessionHasUnknownCommands,
  replayManagedCommand,
  readUnknownManagedCommands,
} from "./managed-ledger";

const SUPPORTED_CLAUDE_VERSIONS = new Set(["2.1.263 (Claude Code)", "2.1.285 (Claude Code)"]);
const FILE_LIMIT = 2 * 1024 * 1024;
type ClaudeRecord = {
  version: 1;
  id: string;
  workspaceId: string;
  workspace: string;
  registeredWorkspace: string | null;
  home: string;
  nativeId: string;
  title: string;
  createdAt: string;
  adopted: boolean;
  released: boolean;
  fresh: boolean;
  fingerprint: string | null;
  snapshot: Record<string, unknown>;
  completedRequests: string[];
};
const isObject = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sessionIdPattern = /^[A-Za-z0-9-]{1,128}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_DEVICE = "agentkib-local-owner";
const supportsClaudeManagedRunner = () =>
  process.platform === "darwin" || process.platform === "linux";

/** Manages Claude session ownership, CLI runners, and read-side state. */
export class ClaudeManagedReadOwner {
  #version?: { at: number; value: string | null };
  #runners = new Map<string, ClaudeManagedRunnerProcess>();
  #runnerReservations = new Set<string>();
  #runnerReservationTail: Promise<void> = Promise.resolve();
  #ownerLocks = new Map<string, () => void>();
  #sessionQueues = new Map<string, Promise<void>>();

  constructor(
    readonly store: BackendStore,
    readonly sessions: SessionReaders,
    readonly commands: Commands,
    readonly dataDir: string,
    readonly environment: NodeJS.ProcessEnv,
    readonly bootId = randomUUID(),
  ) {}

  close(): void {
    void this.shutdown().catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    const runners = [...this.#runners.entries()];
    const results = await Promise.allSettled(
      runners.map(async ([id, runner]) => {
        await runner.shutdown();
        if (this.#runners.get(id) !== runner) return;
        this.#runners.delete(id);
        this.#ownerLocks.get(id)?.();
        this.#ownerLocks.delete(id);
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    for (const [id, release] of this.#ownerLocks) {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
      this.#ownerLocks.delete(id);
    }
    if (failures.length)
      throw new AggregateError(failures, "Claude managed runner shutdown failed");
  }

  async request(value: unknown): Promise<unknown> {
    if (!isObject(value) || typeof value.operation !== "string") throw new Error("invalid-request");
    const id = typeof value.sessionId === "string" ? value.sessionId : undefined;
    const writeOperations = new Set([
      "adopt",
      "release",
      "reconcile",
      "send",
      "stop",
      "approve",
      "answer",
    ]);
    const run = () => this.#requestLocked(value, id);
    return id && writeOperations.has(value.operation) ? this.#serializeSession(id, run) : run();
  }

  async #requestLocked(value: Record<string, any>, id?: string): Promise<unknown> {
    const readOperations = new Set([
      "live",
      "capabilities",
      "inspect",
      "context",
      "events",
      "settings-state",
      "usage",
      "goal",
      "resources",
      "reconcile",
    ]);
    const hasRecord = id !== undefined && this.#load(id) !== null;
    const ownedHere = id !== undefined && this.#ownerLocks.has(id);
    const hasRunner = id !== undefined && this.#runners.has(id);
    const release =
      hasRecord && readOperations.has(value.operation) && !ownedHere && !hasRunner
        ? this.#tryLock(id!)
        : null;
    if (hasRecord && readOperations.has(value.operation) && !release && !ownedHere && !hasRunner)
      throw new Error("session-managed-by-another-runtime");
    try {
      return await this.#requestRead(value, id);
    } finally {
      release?.();
    }
  }

  async #serializeSession<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#sessionQueues.get(id) ?? Promise.resolve();
    const current = previous.then(run);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.#sessionQueues.set(id, tail);
    try {
      return await current;
    } finally {
      if (this.#sessionQueues.get(id) === tail) this.#sessionQueues.delete(id);
    }
  }

  async #requestRead(value: Record<string, any>, id?: string): Promise<unknown> {
    switch (value.operation) {
      case "options":
        return this.options();
      case "create":
        return this.#create(value);
      case "adopt":
        if (!id) throw new Error("missing-session");
        return this.#adopt(value, id);
      case "release":
        if (!id) throw new Error("missing-session");
        return this.#release(value, id);
      case "send":
      case "stop":
      case "approve":
      case "answer":
        if (!id) throw new Error("missing-session");
        return this.#control(value, id);
      case "live":
        if (!id) throw new Error("missing-session");
        return this.live(id, value.experimentalEnabled === true);
      case "capabilities":
        if (!id) throw new Error("missing-session");
        return this.capabilities(id, value.experimentalEnabled === true);
      case "inspect":
        if (!id) throw new Error("missing-session");
        return this.inspect(id, value.experimentalEnabled === true);
      case "context":
        if (!id) throw new Error("missing-session");
        return this.context(id);
      case "events":
        if (!id) throw new Error("missing-session");
        return this.events(id, value.cursor, value.limit);
      case "settings-state":
      case "usage":
      case "goal":
      case "resources":
        if (!id) throw new Error("missing-session");
        return this.settingsState(id);
      case "reconcile":
        if (!id) throw new Error("missing-session");
        return this.#reconcile(value, id);
      default:
        throw new Error(`unsupported-Claude-managed-operation:${value.operation}`);
    }
  }

  async #control(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    const operation = value.operation as string;
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
      "resourceRefs",
      "turnId",
      "approvalId",
      "questionId",
      "answers",
      "decision",
    ]);
    const requestId = value.requestId;
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    if (
      value.deviceId !== LOCAL_DEVICE ||
      typeof requestId !== "string" ||
      !uuidPattern.test(requestId) ||
      Object.keys(value).some((key) => !allowed.has(key)) ||
      value.runtimeBootId !== this.bootId ||
      !Number.isSafeInteger(value.expectedRevision) ||
      Number(value.expectedRevision) < 0 ||
      value.experimentalEnabled !== true
    )
      throw new Error("invalid-managed-control");

    const record = this.#load(id);
    if (!record) throw new Error("session-unavailable");
    if (record.released) throw new Error("session-released");
    this.#validate(record);
    const existingRunner = this.#runners.get(id);
    if (operation !== "send" && !existingRunner) throw new Error("session-runner-unavailable");
    if (managedSessionHasUnknownCommands(this.dataDir, id))
      throw new Error("control-outcome-unconfirmed");
    const live = await this.#live(id, true);
    if (value.expectedRevision !== live.revision) throw new Error("stale-Claude-revision");
    if (live.status === "outcome-unknown") throw new Error("control-outcome-unconfirmed");

    const logical = { ...value };
    delete logical.runtimeBootId;
    const fingerprint = createHash("sha256").update(stableJson(logical)).digest("hex");
    const prior = replayManagedCommand(this.dataDir, requestId, fingerprint);
    if (prior) return prior;

    let content: unknown;
    let executable: string | null | undefined;
    let newlyAcquiredOwnerLock = false;
    if (operation === "send") {
      if (live.sendEnabled !== true) throw new Error("session-busy");
      if (Array.isArray(value.resourceRefs) && value.resourceRefs.length)
        throw new Error("native-resource-unverified");
      if (value.resourceRefs !== undefined && !Array.isArray(value.resourceRefs))
        throw new Error("invalid-resource-references");
      content = value.input ?? (typeof value.text === "string" ? value.text : undefined);
      if (content === undefined) throw new Error("missing-input");
      validateClaudeContent(content);
      if ((await this.#installationVersion()) === null) throw new Error("claude-cli-unavailable");
      executable = resolveCommand("claude", this.environment);
      if (!executable) throw new Error("claude-cli-unavailable");
      if (!existingRunner) {
        const release = this.#tryLock(id);
        if (!release) throw new Error("session-managed-by-another-runtime");
        this.#ownerLocks.set(id, release);
        newlyAcquiredOwnerLock = true;
        try {
          this.#ensureNoExternalOwner(record.nativeId);
          if (!record.fresh) {
            const target = await this.#resolveNative(record.id);
            if (target.nativeId !== record.nativeId || record.fingerprint !== target.fingerprint)
              throw new Error("Claude-history-changed-requires-handoff");
          }
        } catch (error) {
          this.#ownerLocks.delete(id);
          release();
          throw error;
        }
      }
    }
    const inputFingerprint =
      content === undefined ? null : createHash("sha256").update(stableJson(content)).digest("hex");
    const evidence = {
      operation,
      workspaceId: record.workspaceId,
      runtimeBootId: this.bootId,
      expectedRevision: value.expectedRevision,
      turnId: value.turnId ?? null,
      inputFingerprint,
      executionMode: "claude-managed",
    };
    let reservedRunnerSlot = false;
    try {
      if (operation === "send") reservedRunnerSlot = await this.#reserveRunner(id);
      const claimed = claimManagedCommand(
        this.dataDir,
        requestId,
        id,
        fingerprint,
        LOCAL_DEVICE,
        evidence,
      );
      if (claimed) {
        if (newlyAcquiredOwnerLock) {
          const release = this.#ownerLocks.get(id);
          this.#ownerLocks.delete(id);
          release?.();
        }
        return claimed;
      }

      const previousSnapshot = structuredClone(record.snapshot);
      record.snapshot = { ...live, status: "outcome-unknown" };
      this.#save(record);
      dispatchManagedCommand(this.dataDir, requestId);
      let runner = existingRunner;
      if (!runner) {
        runner = new ClaudeManagedRunnerProcess(
          record.workspace,
          record.nativeId,
          record.fresh,
          Number(value.expectedRevision),
          this.environment,
          (snapshot: ClaudeRunnerSnapshot) => {
            const current = this.#load(id);
            if (!current || current.released) throw new Error("Claude session unavailable");
            const turnId = snapshot.turnId;
            let completed = false;
            if (
              snapshot.status === "idle" &&
              typeof turnId === "string" &&
              turnId.length > 0 &&
              !current.completedRequests.includes(turnId)
            ) {
              try {
                current.fingerprint = this.#targetFingerprint(current.nativeId, current.workspace);
              } catch {
                // Completion is still recorded; a missing transcript cannot prove a new handoff.
              }
              current.completedRequests.push(turnId);
              completed = true;
            }
            current.snapshot = snapshot as unknown as Record<string, unknown>;
            this.#save(current);
            if (completed) this.#recoverCompletions(current);
          },
          this.#version?.value === "2.1.285 (Claude Code)",
        );
        this.#runners.set(id, runner);
      }

      try {
        switch (operation) {
          case "send": {
            const dispatch = runner.send(
              executable!,
              content,
              requestId,
              Number(value.expectedRevision),
            );
            if (reservedRunnerSlot) {
              this.#runnerReservations.delete(id);
              reservedRunnerSlot = false;
            }
            await dispatch;
            record.fresh = false;
            break;
          }
          case "stop":
            if (typeof value.turnId !== "string") throw new Error("missing-turn");
            await runner.stop(value.turnId, Number(value.expectedRevision));
            break;
          case "approve":
            if (typeof value.turnId !== "string") throw new Error("missing-turn");
            await runner.approve(
              value.approvalId,
              value.turnId,
              value.decision,
              Number(value.expectedRevision),
            );
            break;
          case "answer":
            if (typeof value.turnId !== "string") throw new Error("missing-turn");
            await runner.answer(
              value.questionId,
              value.turnId,
              value.answers,
              Number(value.expectedRevision),
            );
            break;
          default:
            throw new Error("unsupported-Claude-control");
        }
        const snapshot = runner.snapshot();
        const current = this.#load(id)!;
        current.snapshot = snapshot as unknown as Record<string, unknown>;
        if (operation === "send") current.fresh = false;
        this.#save(current);
        const result = {
          accepted: true,
          completed: false,
          requestId,
          sessionId: id,
          runtimeBootId: this.bootId,
          controlOutcome: "accepted",
          live: await this.#live(id, true),
        };
        finishManagedCommand(this.dataDir, requestId, result);
        return result;
      } catch (error) {
        const current = this.#load(id);
        if (current) {
          current.snapshot = runner.snapshot() as unknown as Record<string, unknown>;
          this.#save(current);
        } else {
          record.snapshot = previousSnapshot;
        }
        const unknown = current?.snapshot.status === "outcome-unknown";
        const result = {
          accepted: false,
          completed: false,
          requestId,
          sessionId: id,
          runtimeBootId: this.bootId,
          controlOutcome: unknown ? "unknown" : "not-dispatched",
          error: error instanceof Error ? error.message : String(error),
        };
        if (!unknown) finishManagedCommand(this.dataDir, requestId, result);
        return result;
      }
    } finally {
      // The slot is handed to a live worker when send starts; failures before then
      // release it here so another session can claim the available capacity.
      if (reservedRunnerSlot) this.#runnerReservations.delete(id);
    }
  }

  async #create(value: Record<string, any>): Promise<Record<string, unknown>> {
    const allowed = new Set(["operation", "workspaceId", "requestId", "deviceId", "name"]);
    const requestId = value.requestId;
    const workspaceId = value.workspaceId;
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    if (
      value.deviceId !== LOCAL_DEVICE ||
      typeof requestId !== "string" ||
      !uuidPattern.test(requestId) ||
      typeof workspaceId !== "string" ||
      workspaceId.length === 0 ||
      Object.keys(value).some((key) => !allowed.has(key)) ||
      (value.name !== undefined &&
        (typeof value.name !== "string" || Buffer.byteLength(value.name) > 512))
    )
      throw new Error("invalid-managed-create");
    if ((await this.#installationVersion()) === null) throw new Error("claude-cli-unavailable");
    const workspace = canonicalize(this.store.workspacePath(workspaceId));
    const logical = { ...value };
    delete logical.runtimeBootId;
    const fingerprint = createHash("sha256").update(stableJson(logical)).digest("hex");
    const prior = replayManagedCommand(this.dataDir, requestId, fingerprint);
    if (prior) return prior;

    const id = randomUUID();
    const nativeId = randomUUID();
    this.#privateDirectory(true);
    const release = this.#tryLock(id);
    if (!release) throw new Error("session-managed-by-another-runtime");
    let retainLock = false;
    try {
      const evidence = {
        operation: "create",
        workspaceId,
        runtimeBootId: this.bootId,
        executionMode: "claude-managed",
      };
      const claimed = claimManagedCommand(
        this.dataDir,
        requestId,
        id,
        fingerprint,
        LOCAL_DEVICE,
        evidence,
      );
      if (claimed) {
        this.#ownerLocks.set(id, release);
        retainLock = true;
        return claimed;
      }
      dispatchManagedCommand(this.dataDir, requestId);
      const now = new Date().toISOString();
      const name =
        typeof value.name === "string" && value.name.trim().length > 0 ? value.name : "Claude Code";
      const record: ClaudeRecord = {
        version: 1,
        id,
        workspaceId,
        workspace,
        registeredWorkspace: workspace,
        home: this.#home(),
        nativeId,
        title: Buffer.byteLength(name) <= 512 ? name : "Claude Code",
        createdAt: now,
        adopted: false,
        released: false,
        fresh: true,
        fingerprint: null,
        snapshot: {
          status: "idle",
          revision: 0,
          turnId: null,
          sendEnabled: true,
          stopEnabled: false,
          approvals: [],
          questions: [],
          streamText: "",
        },
        completedRequests: [],
      };
      this.#save(record);
      const live = {
        ...record.snapshot,
        sessionId: id,
        workspaceId,
        sourceSessionId: nativeId,
        runtimeBootId: this.bootId,
        executionMode: "claude-managed",
        cliVersion: await this.#installationVersion(),
        permissionMode: "cli-configured",
      };
      const result = {
        accepted: true,
        completed: true,
        controlOutcome: "accepted",
        requestId,
        sessionId: id,
        sourceSessionId: nativeId,
        runtimeBootId: this.bootId,
        live,
      };
      finishManagedCommand(this.dataDir, requestId, result);
      this.#ownerLocks.set(id, release);
      retainLock = true;
      return result;
    } finally {
      if (!retainLock) release();
    }
  }

  async #adopt(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    const allowed = new Set([
      "operation",
      "sessionId",
      "requestId",
      "deviceId",
      "handoffConfirmed",
      "handoffFingerprint",
    ]);
    const requestId = value.requestId;
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    if (
      value.deviceId !== LOCAL_DEVICE ||
      value.handoffConfirmed !== true ||
      typeof requestId !== "string" ||
      !uuidPattern.test(requestId) ||
      typeof value.handoffFingerprint !== "string" ||
      Object.keys(value).some((key) => !allowed.has(key))
    )
      throw new Error("invalid-managed-adopt");
    if ((await this.#installationVersion()) === null) throw new Error("claude-cli-unavailable");
    const logical = { ...value };
    delete logical.runtimeBootId;
    const fingerprint = createHash("sha256").update(stableJson(logical)).digest("hex");
    const prior = replayManagedCommand(this.dataDir, requestId, fingerprint);
    if (prior) return prior;

    this.#privateDirectory(true);
    const release = this.#tryLock(id);
    if (!release) throw new Error("session-managed-by-another-runtime");
    let retainLock = false;
    try {
      const existing = this.#load(id);
      let workspaceId: string;
      let workspace: string;
      let nativeId: string;
      let handoff: string | null;
      let fresh: boolean;
      if (existing && existing.fresh && existing.released) {
        this.#validate(existing);
        if (value.handoffFingerprint !== this.#emptyFingerprint(existing))
          throw new Error("handoff-fingerprint-changed");
        ({ workspaceId, workspace, nativeId } = existing);
        handoff = null;
        fresh = true;
      } else {
        if (existing && !existing.released) throw new Error("session-already-managed");
        const target = await this.#resolveNative(id);
        this.#ensureNoExternalOwner(target.nativeId);
        const current = this.#targetFingerprint(target.nativeId, target.workspace);
        if (value.handoffFingerprint !== current) throw new Error("handoff-fingerprint-changed");
        workspaceId = target.workspaceId;
        workspace = target.workspace;
        nativeId = target.nativeId;
        handoff = current;
        fresh = false;
      }

      const evidence = {
        operation: "adopt",
        workspaceId,
        runtimeBootId: this.bootId,
        executionMode: "claude-managed",
      };
      const claimed = claimManagedCommand(
        this.dataDir,
        requestId,
        id,
        fingerprint,
        LOCAL_DEVICE,
        evidence,
      );
      if (claimed) {
        this.#ownerLocks.set(id, release);
        retainLock = true;
        return claimed;
      }
      const previous = this.#load(id);
      const name = "Claude Code";
      const record: ClaudeRecord = {
        version: 1,
        id,
        workspaceId,
        workspace,
        registeredWorkspace: canonicalize(this.store.workspacePath(workspaceId)),
        home: this.#home(),
        nativeId,
        title: name,
        createdAt: new Date().toISOString(),
        adopted: previous?.adopted ?? true,
        released: false,
        fresh,
        fingerprint: handoff,
        completedRequests: previous?.completedRequests ?? [],
        snapshot: {
          status: "idle",
          revision: 0,
          turnId: null,
          sendEnabled: true,
          stopEnabled: false,
          approvals: [],
          questions: [],
          streamText: "",
        },
      };
      dispatchManagedCommand(this.dataDir, requestId);
      this.#save(record);
      const live = {
        ...record.snapshot,
        sessionId: id,
        workspaceId,
        sourceSessionId: nativeId,
        runtimeBootId: this.bootId,
        executionMode: "claude-managed",
        cliVersion: await this.#installationVersion(),
        permissionMode: "cli-configured",
      };
      const result = {
        accepted: true,
        completed: true,
        controlOutcome: "accepted",
        requestId,
        sessionId: id,
        sourceSessionId: nativeId,
        runtimeBootId: this.bootId,
        live,
      };
      finishManagedCommand(this.dataDir, requestId, result);
      this.#ownerLocks.set(id, release);
      retainLock = true;
      return result;
    } finally {
      if (!retainLock) release();
    }
  }

  async #release(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    const allowed = new Set([
      "operation",
      "sessionId",
      "requestId",
      "deviceId",
      "runtimeBootId",
      "expectedRevision",
    ]);
    const requestId = value.requestId;
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    if (
      value.deviceId !== LOCAL_DEVICE ||
      typeof requestId !== "string" ||
      !uuidPattern.test(requestId) ||
      typeof value.runtimeBootId !== "string" ||
      !Number.isSafeInteger(value.expectedRevision) ||
      Number(value.expectedRevision) < 0 ||
      Object.keys(value).some((key) => !allowed.has(key))
    )
      throw new Error("invalid-managed-release");
    const logical = { ...value };
    delete logical.runtimeBootId;
    const fingerprint = createHash("sha256").update(stableJson(logical)).digest("hex");
    const prior = replayManagedCommand(this.dataDir, requestId, fingerprint);
    if (prior) return prior;

    this.#privateDirectory(false);
    const ownerRelease = this.#ownerLocks.get(id);
    const releaseLock = ownerRelease ? null : this.#tryLock(id);
    if (!ownerRelease && !releaseLock) throw new Error("session-managed-by-another-runtime");
    let releasedOwned = false;
    try {
      const record = this.#load(id);
      if (!record) throw new Error("session-unavailable");
      this.#validate(record);
      if (record.released) throw new Error("session-released");
      const live = await this.#live(id, true);
      if (value.runtimeBootId !== this.bootId) throw new Error("stale-runtime-boot");
      if (Number(value.expectedRevision) !== live.revision)
        throw new Error("stale-Claude-revision");
      if (live.status !== "idle") throw new Error("session-busy");
      if (managedSessionHasUnknownCommands(this.dataDir, id))
        throw new Error("control-outcome-unconfirmed");
      const evidence = {
        operation: "release",
        workspaceId: record.workspaceId,
        runtimeBootId: this.bootId,
        expectedRevision: value.expectedRevision,
        turnId: null,
        inputFingerprint: null,
        executionMode: "claude-managed",
      };
      const claimed = claimManagedCommand(
        this.dataDir,
        requestId,
        id,
        fingerprint,
        LOCAL_DEVICE,
        evidence,
      );
      if (claimed) return claimed;
      dispatchManagedCommand(this.dataDir, requestId);
      const runner = this.#runners.get(id);
      if (runner) {
        await runner.shutdown();
        this.#runners.delete(id);
      }
      record.released = true;
      this.#save(record);
      releasedOwned = true;
      const result = {
        accepted: true,
        completed: true,
        requestId,
        sessionId: id,
        runtimeBootId: this.bootId,
        controlOutcome: "accepted",
      };
      finishManagedCommand(this.dataDir, requestId, result);
      return result;
    } finally {
      if (releaseLock) releaseLock();
      if (ownerRelease && releasedOwned) {
        this.#ownerLocks.delete(id);
        ownerRelease();
      }
    }
  }

  #emptyFingerprint(record: ClaudeRecord): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          record.id,
          record.nativeId,
          record.workspace,
          record.home,
          record.fresh,
          record.released,
        ]),
      )
      .digest("hex");
  }

  #targetFingerprint(nativeId: string, workspace: string): string {
    const transcript = this.sessions.verifiedClaudeControlTarget(nativeId, workspace);
    const read = () => {
      const info = lstatSync(transcript);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 * 1024)
        throw new Error("invalid-Claude-transcript");
      const fd = openSync(transcript, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.size > 128n * 1024n * 1024n)
          throw new Error("invalid-Claude-transcript");
        const chunks: Buffer[] = [];
        const buffer = Buffer.alloc(64 * 1024);
        let total = 0;
        for (;;) {
          const size = readSync(fd, buffer, 0, buffer.length, null);
          if (size === 0) break;
          total += size;
          if (total > 128 * 1024 * 1024)
            throw new Error("Claude transcript exceeds handoff budget");
          chunks.push(Buffer.from(buffer.subarray(0, size)));
        }
        const after = fstatSync(fd, { bigint: true });
        if (
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          BigInt(total) !== before.size
        )
          throw new Error("Claude history changed during handoff");
        return Buffer.concat(chunks, total);
      } finally {
        closeSync(fd);
      }
    };
    const first = read();
    if (this.sessions.verifiedClaudeControlTarget(nativeId, workspace) !== transcript)
      throw new Error("Claude transcript target changed during handoff");
    const serialized = Buffer.from(
      JSON.stringify([nativeId.toLowerCase(), canonicalize(workspace)]),
    );
    return createHash("sha256").update(serialized).update(first).digest("hex");
  }

  #ensureNoExternalOwner(nativeId: string): void {
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    const output = execFileSync("/bin/ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const mentioned = output.split("\n").some((line) => {
      const words = line.trim().split(/\s+/);
      return (
        words.some((word) => path.posix.basename(word) === "claude") &&
        (words.some(
          (word) => word === `--resume=${nativeId}` || word === `--session-id=${nativeId}`,
        ) ||
          words.some(
            (word, index) =>
              ["--resume", "-r", "--session-id"].includes(word) && words[index + 1] === nativeId,
          ))
      );
    });
    if (mentioned) throw new Error("Claude session is active in an external process");
  }

  async #reconcile(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    const requestId = value.requestId;
    const allowed = new Set(["operation", "sessionId", "requestId", "deviceId"]);
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    if (
      value.deviceId !== LOCAL_DEVICE ||
      typeof requestId !== "string" ||
      !uuidPattern.test(requestId) ||
      Object.keys(value).some((key) => !allowed.has(key))
    )
      throw new Error("invalid-managed-reconcile");
    const logical = { ...value };
    delete logical.runtimeBootId;
    const fingerprint = createHash("sha256").update(stableJson(logical)).digest("hex");
    const prior = replayManagedCommand(this.dataDir, requestId, fingerprint);
    if (prior) return prior;
    const record = this.#load(id);
    if (!record || record.released || !this.#validateForReconcile(record))
      throw new Error("session-unavailable");
    const live = await this.#live(id, false);
    const evidence = {
      operation: "reconcile",
      workspaceId: record.workspaceId,
      executionMode: "claude-managed",
      runtimeBootId: this.bootId,
    };
    const claimed = claimManagedCommand(
      this.dataDir,
      requestId,
      id,
      fingerprint,
      LOCAL_DEVICE,
      evidence,
    );
    if (claimed) return claimed;
    const result = {
      accepted: true,
      completed: true,
      requestId,
      sessionId: id,
      runtimeBootId: this.bootId,
      controlOutcome: "accepted",
      reconciled: live.status === "idle",
      live,
    };
    finishManagedCommand(this.dataDir, requestId, result);
    return result;
  }

  #validateForReconcile(record: ClaudeRecord): boolean {
    try {
      this.#validate(record);
      return true;
    } catch {
      return false;
    }
  }

  async #reserveRunner(id: string): Promise<boolean> {
    let release!: () => void;
    const previous = this.#runnerReservationTail;
    this.#runnerReservationTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      const existing = this.#runners.get(id);
      const needsSlot = !existing?.hasWorker || existing.isRetiring;
      if (needsSlot) {
        if (this.#runnerReservations.has(id)) return false;
        this.#runnerReservations.add(id);
      }
      const retirements: Array<[string, ClaudeManagedRunnerProcess, Promise<boolean>]> = [];
      for (const [otherId, runner] of this.#runners) {
        if (otherId === id) continue;
        const retirement = runner.retireIfInactive();
        if (retirement) retirements.push([otherId, runner, retirement]);
      }
      const retired = await Promise.allSettled(retirements.map(([, , retirement]) => retirement));
      for (const [index, [otherId, runner]] of retirements.entries()) {
        if (retired[index]?.status !== "fulfilled" || !retired[index].value) continue;
        const record = this.#load(otherId);
        if (record) {
          record.snapshot = runner.snapshot() as unknown as Record<string, unknown>;
          this.#save(record);
        }
      }
      const retirementFailure = retired.find(
        (result) =>
          result.status === "rejected" || (result.status === "fulfilled" && !result.value),
      );
      if (retirementFailure?.status === "rejected") throw retirementFailure.reason;
      if (retirementFailure) throw new Error("Claude-runner-limit");
      const active =
        this.#runnerReservations.size +
        [...this.#runners.values()].filter((runner) => runner.hasWorker && !runner.isRetiring)
          .length;
      if (active > 8) throw new Error("Claude-runner-limit");
      return needsSlot;
    } catch (error) {
      this.#runnerReservations.delete(id);
      throw error;
    } finally {
      release();
    }
  }

  #tryLock(id: string): (() => void) | null {
    if (!supportsClaudeManagedRunner()) return null;
    this.#privateDirectory(false);
    const file = this.#path(id).replace(/\.json$/, ".lock");
    try {
      return acquirePortableFileLease(file);
    } catch (error) {
      if (error instanceof Error && error.message === "session-managed-by-another-runtime")
        return null;
      throw error;
    }
  }

  catalog(): Array<Record<string, unknown>> {
    const records = this.#listRecords();
    return records.flatMap((record) => {
      try {
        this.#validate(record);
        if (record.released && record.adopted) return [];
        const indexedSessionId = this.store.sessions.id("claude-code", record.nativeId);
        return [
          {
            id: record.id,
            indexedSessionId,
            workspace_id: record.workspaceId,
            agent: "claude-code",
            title: record.title,
            origin: "interactive",
            created_at: record.createdAt,
            updated_at: record.createdAt,
            message_count: null,
            git_branch: null,
            archived: false,
            sidechain: false,
            availability: "readable",
            executionMode: "claude-managed",
            sourceSessionId: record.nativeId,
          },
        ];
      } catch {
        return [];
      }
    });
  }

  indexedAliases(): Set<string> {
    return new Set(
      this.catalog().flatMap((record) =>
        typeof record.indexedSessionId === "string" ? [record.indexedSessionId] : [],
      ),
    );
  }

  #directory(): string {
    return path.join(this.dataDir, "claude-managed");
  }

  #path(id: string): string {
    if (!sessionIdPattern.test(id)) throw new Error("invalid-session");
    return path.join(this.#directory(), `${id}.json`);
  }

  #home(): string {
    const configured =
      this.environment.CLAUDE_CONFIG_DIR ??
      path.join(this.environment.HOME ?? homedir(), ".claude");
    if (existsSync(configured)) return canonicalize(configured);
    const parent = path.dirname(configured);
    return path.join(canonicalize(parent), path.basename(configured));
  }

  #privateDirectory(create: boolean): void {
    const directory = this.#directory();
    if (create) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    for (let current = directory; ; current = path.dirname(current)) {
      if (existsSync(current)) {
        const info = lstatSync(current);
        if (info.isSymbolicLink()) throw new Error("Claude metadata path is a symlink");
      }
      if (path.dirname(current) === current) break;
    }
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Claude metadata directory unavailable");
    restrictRemotePath(directory, true);
  }

  #load(id: string): ClaudeRecord | null {
    const file = this.#path(id);
    if (!existsSync(file)) return null;
    this.#privateDirectory(false);
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > FILE_LIMIT)
      throw new Error("invalid-Claude-metadata");
    restrictRemotePath(file);
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      !isObject(value) ||
      value.version !== 1 ||
      value.id !== id ||
      typeof value.workspaceId !== "string" ||
      typeof value.workspace !== "string" ||
      typeof value.home !== "string" ||
      typeof value.nativeId !== "string" ||
      !uuidPattern.test(value.nativeId) ||
      typeof value.title !== "string" ||
      typeof value.createdAt !== "string" ||
      typeof value.adopted !== "boolean" ||
      typeof value.released !== "boolean" ||
      typeof value.fresh !== "boolean" ||
      !isObject(value.snapshot) ||
      !Array.isArray(value.completedRequests)
    )
      throw new Error("invalid-Claude-metadata");
    return value as ClaudeRecord;
  }

  #save(record: ClaudeRecord): void {
    this.#privateDirectory(true);
    const target = this.#path(record.id);
    if (existsSync(target)) {
      const info = lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid-Claude-metadata");
    }
    const temporary = path.join(this.#directory(), `.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeFileSync(fd, JSON.stringify(record));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, target);
      const directoryFd = openSync(this.#directory(), constants.O_RDONLY);
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch {}
      throw error;
    }
  }

  #listRecords(): ClaudeRecord[] {
    const directory = this.#directory();
    if (!existsSync(directory)) return [];
    this.#privateDirectory(false);
    const entries = readdirSync(directory, { withFileTypes: true }) as Array<{
      name: string;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }>;
    if (entries.length > 20_000) throw new Error("Claude managed catalog exceeds limit");
    return entries.flatMap((entry) => {
      if (!entry.name.endsWith(".json") || entry.isSymbolicLink() || !entry.isFile()) return [];
      const record = this.#load(path.basename(entry.name, ".json"));
      return record ? [record] : [];
    });
  }

  #validate(record: ClaudeRecord): void {
    const root = canonicalize(this.store.workspacePath(record.workspaceId));
    const expected = record.registeredWorkspace ?? record.workspace;
    if (pathIdentity(root) !== pathIdentity(canonicalize(expected)))
      throw new Error("session-workspace-mismatch");
    if (pathIdentity(canonicalize(record.workspace)) !== pathIdentity(root))
      throw new Error("session-workspace-mismatch");
    if (pathIdentity(this.#home()) !== pathIdentity(canonicalize(record.home)))
      throw new Error("claude-home-changed");
  }

  async #installationVersion(): Promise<string | null> {
    if (this.#version && Date.now() - this.#version.at < 30_000) return this.#version.value;
    const executable = resolveCommand("claude", this.environment);
    if (!executable) {
      this.#version = { at: Date.now(), value: null };
      return null;
    }
    try {
      const output = await this.commands.run(executable, ["--version"], {
        env: this.environment,
        timeout: 5000,
        limit: 4096,
        strictOutput: true,
        allowFailure: true,
      });
      const version = output.bytes.toString("utf8").trim();
      const value = output.success && SUPPORTED_CLAUDE_VERSIONS.has(version) ? version : null;
      this.#version = { at: Date.now(), value };
      return value;
    } catch {
      this.#version = { at: Date.now(), value: null };
      return null;
    }
  }

  async options(): Promise<Record<string, unknown>> {
    const cliVersion = supportsClaudeManagedRunner() ? await this.#installationVersion() : null;
    const available = cliVersion !== null;
    return {
      available,
      ...(available ? {} : { reason: "unverified-installation" }),
      workspaces: available
        ? (this.store.listWorkspaces() as Array<Record<string, unknown>>).map(({ id, name }) => ({
            id,
            name,
          }))
        : [],
      models: [],
      cliVersion,
      permissionMode: "cli-configured",
    };
  }

  async #live(id: string, controls: boolean): Promise<Record<string, unknown>> {
    const record = this.#load(id);
    const version = supportsClaudeManagedRunner() ? await this.#installationVersion() : null;
    if (!record) {
      await this.#resolveNative(id);
      return {
        sessionId: id,
        runtimeBootId: this.bootId,
        executionMode: "managed-resume",
        status: "idle",
        revision: 0,
        turnId: null,
        sendEnabled: false,
        stopEnabled: false,
        approvals: [],
        questions: [],
        streamText: "",
        reason: "handoff-required",
        cliVersion: version,
        permissionMode: "cli-configured",
      };
    }
    this.#validate(record);
    this.#recoverCompletions(record);
    const runner = this.#runners.get(id);
    if (runner) {
      const snapshot = runner.snapshot();
      const turnId = snapshot.turnId;
      if (
        snapshot.status === "idle" &&
        typeof turnId === "string" &&
        turnId.length > 0 &&
        !record.completedRequests.includes(turnId)
      ) {
        try {
          record.fingerprint = this.#targetFingerprint(record.nativeId, record.workspace);
        } catch {
          // Completion is still recorded; a missing transcript cannot prove a new handoff.
        }
        record.completedRequests.push(turnId);
      }
      record.snapshot = snapshot as unknown as Record<string, unknown>;
      this.#save(record);
      this.#recoverCompletions(record);
    }
    let live: Record<string, unknown>;
    if (
      (!runner && record.snapshot.status !== "idle") ||
      managedSessionHasUnknownCommands(this.dataDir, id)
    ) {
      live = {
        ...record.snapshot,
        status: "outcome-unknown",
        sendEnabled: false,
        stopEnabled: false,
        approvals: [],
        questions: [],
        streamText: "",
        reason: "control-outcome-unconfirmed",
      };
    } else {
      live = { ...record.snapshot };
    }
    if (record.released) {
      live.status = "released";
      live.reason = "handoff-required";
    }
    live.sessionId = record.id;
    live.sourceSessionId = record.nativeId;
    live.workspaceId = record.workspaceId;
    live.runtimeBootId = this.bootId;
    live.executionMode = "claude-managed";
    live.permissionMode = "cli-configured";
    live.cliVersion = version;
    if (!version) {
      live.sendEnabled = false;
      if (live.status === "idle") live.reason = "unverified-installation";
    }
    if (!controls || record.released) {
      live.sendEnabled = false;
      live.stopEnabled = false;
      for (const key of ["approvals", "questions"])
        if (Array.isArray(live[key]))
          live[key] = (live[key] as Array<Record<string, unknown>>).map((item) => ({
            ...item,
            supported: false,
          }));
    }
    return live;
  }

  async live(id: string, controls = false) {
    return this.#live(id, controls);
  }

  async receipt(value: unknown): Promise<unknown> {
    if (
      !isObject(value) ||
      value.found !== true ||
      value.executionMode !== "claude-managed" ||
      typeof value.sessionId !== "string" ||
      typeof value.requestId !== "string"
    )
      return value;
    const record = this.#load(value.sessionId);
    if (!record) return value;
    await this.request({ operation: "live", sessionId: value.sessionId });
    const current = this.#load(value.sessionId);
    const completionObserved = Boolean(current?.completedRequests.includes(value.requestId));
    const receipt: Record<string, any> = { ...value, completionObserved };
    if (completionObserved && value.operation === "send" && value.status === "unknown" && current) {
      receipt.ack = {
        accepted: true,
        completed: true,
        controlOutcome: "accepted",
        requestId: value.requestId,
        sessionId: current.id,
        sourceSessionId: current.nativeId,
        runtimeBootId: typeof value.runtimeBootId === "string" ? value.runtimeBootId : this.bootId,
        completionObserved: true,
      };
      receipt.status = "accepted";
    }
    return receipt;
  }

  #recoverCompletions(record: ClaudeRecord): void {
    if (record.completedRequests.length === 0) return;
    for (const command of readUnknownManagedCommands(this.dataDir, record.id)) {
      if (
        command.evidence?.operation !== "send" ||
        !record.completedRequests.includes(command.requestId)
      )
        continue;
      finishManagedCommand(this.dataDir, command.requestId, {
        accepted: true,
        completed: true,
        controlOutcome: "accepted",
        requestId: command.requestId,
        sessionId: record.id,
        sourceSessionId: record.nativeId,
        runtimeBootId:
          typeof command.evidence.runtimeBootId === "string"
            ? command.evidence.runtimeBootId
            : this.bootId,
        completionObserved: true,
      });
    }
  }

  async capabilities(id: string, controls = false): Promise<Record<string, unknown>> {
    const live = await this.#live(id, controls);
    const record = this.#load(id);
    const version = supportsClaudeManagedRunner() && (await this.#installationVersion()) !== null;
    const owned = Boolean(record && !record.released);
    const features: Record<string, unknown> = {};
    for (const operation of [
      "send",
      "stop",
      "approve",
      "answer",
      "attachments",
      "files",
      "adopt",
      "release",
      "inspect",
      "reconcile",
      "settings",
      "queue",
      "fork",
      "archive",
      "rename",
      "goal",
      "resources",
    ]) {
      const available =
        operation === "inspect" ||
        operation === "files" ||
        (operation === "reconcile"
          ? owned
          : operation === "adopt"
            ? !owned && version && controls
            : operation === "send" || operation === "attachments"
              ? version && controls && live.sendEnabled === true
              : operation === "stop"
                ? version && controls && live.stopEnabled === true
                : operation === "approve"
                  ? version &&
                    controls &&
                    Array.isArray(live.approvals) &&
                    live.approvals.length > 0
                  : operation === "answer"
                    ? version &&
                      controls &&
                      Array.isArray(live.questions) &&
                      live.questions.length > 0
                    : operation === "release"
                      ? owned && controls && live.status === "idle"
                      : false);
      features[operation] = available
        ? { available: true }
        : {
            available: false,
            reason: !version
              ? "unverified-installation"
              : !owned
                ? "handoff-required"
                : "operation-unavailable",
          };
    }
    return {
      sessionId: id,
      executionMode: live.executionMode,
      status: live.status,
      reason: live.reason,
      features,
    };
  }

  async inspect(id: string, controls = false): Promise<Record<string, unknown>> {
    const live = await this.#live(id, controls);
    const record = this.#load(id);
    if (record?.fresh)
      return {
        sessionId: id,
        live,
        workspaceId: record.workspaceId,
        sourceSessionId: record.nativeId,
        handoffFingerprint: this.#emptyFingerprint(record),
        reconciled: false,
      };
    const target = await this.#resolveNative(id);
    return {
      sessionId: id,
      workspaceId: target.workspaceId,
      sourceSessionId: target.nativeId,
      handoffFingerprint: target.fingerprint,
      live,
      reconciled: false,
    };
  }

  async context(id: string): Promise<Record<string, unknown>> {
    const record = this.#load(id);
    const workspace = record
      ? (this.#validate(record), record.workspace)
      : (await this.#resolveNative(id)).workspace;
    return { available: true, cwd: workspace, projectId: null, branchAtCreation: null };
  }

  async events(id: string, cursor: unknown, limit: unknown): Promise<unknown> {
    const record = this.#load(id);
    if (record) {
      this.#validate(record);
      if (record.fresh) return { events: [], next_cursor: null, warnings: [] };
      const count = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, Number(limit))) : 50;
      return this.sessions.eventsForNative(
        "claude-code",
        record.nativeId,
        record.workspace,
        typeof cursor === "string" ? cursor : null,
        count,
      );
    }
    const target = await this.#resolveNative(id);
    const count = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, Number(limit))) : 50;
    return this.sessions.eventsForNative(
      "claude-code",
      target.nativeId,
      target.workspace,
      typeof cursor === "string" ? cursor : null,
      count,
    );
  }

  async settingsState(id: string): Promise<Record<string, unknown>> {
    const live = await this.#live(id, false);
    return {
      available: live.tokenUsage !== null && live.tokenUsage !== undefined,
      executionMode: "claude-managed",
      tokenUsage: live.tokenUsage ?? null,
      reason: "cli-configured",
      settings: { model: live.model ?? null, permissionMode: "cli-configured" },
      skills: [],
      plugins: [],
      apps: [],
      contextReferences: { supportedTypes: [] },
    };
  }

  async #resolveNative(
    id: string,
  ): Promise<{ workspaceId: string; workspace: string; nativeId: string; fingerprint: string }> {
    const managed = this.#load(id);
    if (managed) {
      this.#validate(managed);
      if (managed.fresh)
        return {
          workspaceId: managed.workspaceId,
          workspace: managed.workspace,
          nativeId: managed.nativeId,
          fingerprint: this.#emptyFingerprint(managed),
        };
      return {
        workspaceId: managed.workspaceId,
        workspace: managed.workspace,
        nativeId: managed.nativeId,
        fingerprint: this.#targetFingerprint(managed.nativeId, managed.workspace),
      };
    }
    const session = this.store.sessions.get(id);
    if (!session) throw new Error("session-unavailable");
    if (session.agent !== "claude-code" || session.sidechain)
      throw new Error("session-not-controllable");
    const workspace = canonicalize(this.store.workspacePath(session.workspace_id));
    return this.#findNative(id, session.workspace_id, workspace);
  }

  async #findNative(
    id: string,
    workspaceId: string,
    workspace: string,
  ): Promise<{ workspaceId: string; workspace: string; nativeId: string; fingerprint: string }> {
    const listing = await this.sessions.list("claude-code", workspace);
    const native = listing.sessions.find(
      (candidate) => this.store.sessions.id("claude-code", candidate.native_ref) === id,
    );
    if (!native) throw new Error("session-unavailable");
    const document = await this.sessions.document(id);
    if (
      document.source.agent !== "claude-code" ||
      document.source.workspace_id !== workspaceId ||
      native.sidechain
    )
      throw new Error("unverified-session-identity");
    const nativeWorkspace = this.sessions.claudeControlWorkspace(native.native_ref, workspace);
    const digest = this.#targetFingerprint(native.native_ref, nativeWorkspace);
    return {
      workspaceId,
      workspace: nativeWorkspace,
      nativeId: native.native_ref,
      fingerprint: digest,
    };
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
