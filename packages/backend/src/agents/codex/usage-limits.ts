import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { claimManagedCommand, finishManagedCommand } from "../../managed-ledger";
import type { managedControlSchema } from "../../sessions/control-admission";
import {
  AUTO_CONTINUE_TEXT,
  armUsageLimit,
  codexUsageLimitHit,
  holdUsageLimit,
  usageLimitArmable,
  usageLimitAutoContinue,
  usageLimitContinue,
  usageLimitView,
  type UsageLimit,
  type UsageLimitView,
} from "../../usage-limit";
import type { CodexAppServerSession } from "./codex-app-server";
import type { ManagedCodexState } from "./managed-codex-state";
import type { ManagedRecord } from "./managed-records";

type UsageLimitRequest = Pick<
  z.infer<typeof managedControlSchema>,
  "sessionId" | "requestId" | "deviceId" | "operation" | "runtimeBootId" | "expectedRevision"
>;
type UsageLimitRecord = Pick<ManagedRecord, "workspace_id"> | undefined;

type CodexUsageLimitDependencies = {
  dataDir: string;
  runtimeBootId: string;
  isShuttingDown(): boolean;
  readLive(sessionId: string): Promise<Record<string, unknown>>;
  controlSession(value: Record<string, unknown>, restrictNativePolicy: boolean): Promise<unknown>;
  publishLimit(sessionId: string, view: UsageLimitView | null): void;
  limitEnded(sessionId: string): void;
  home(): string;
  readAccountLimit(sessionId: string): Promise<unknown>;
  reloadIdleRunner(sessionId: string): Promise<void>;
};

export const CODEX_ACCOUNT_LIMIT_METHOD = "account/rateLimits/read";
export const CODEX_ACCOUNT_LIMIT_PARAMS = { excludeResetCreditDetails: true };

export class CodexUsageLimits {
  /**
   * The usage limit each managed Codex session's last turn met, and the continue armed for it
   * (`usage-limit.ts`). In memory only: as Claude Code's own wait does, it ends with AgentKib.
   * `continuing` is the request of the continue AgentKib sent, until that turn ends.
   */
  #limits = new Map<
    string,
    { limit: UsageLimit; timer?: ReturnType<typeof setTimeout>; continuing?: string }
  >();
  /** The device whose message each managed Codex session last took. */
  #senders = new Map<string, { deviceId: string; restrictNativePolicy: boolean }>();
  #credentialVersion?: string;
  #refreshing?: Promise<boolean>;

  constructor(private readonly dependencies: CodexUsageLimitDependencies) {}

  stopTimers(): void {
    for (const entry of this.#limits.values()) clearTimeout(entry.timer);
  }

  view(sessionId: string): UsageLimitView | null {
    return usageLimitView(this.#limits.get(sessionId)?.limit, this.dependencies.runtimeBootId);
  }

  canCancel(sessionId: string): boolean {
    return typeof this.#limits.get(sessionId)?.limit.continueAt === "number";
  }

  canContinue(sessionId: string): boolean {
    return usageLimitArmable(this.#limits.get(sessionId)?.limit, this.dependencies.runtimeBootId);
  }

  beforeControl(request: UsageLimitRequest, restrictNativePolicy: boolean): void {
    if (!["send", "queue-add", "steer", "goal-resume"].includes(request.operation)) return;
    // The person's message takes over from a continue armed after a usage limit.
    // Only the record changes here: the live revision this control was checked against stays,
    // and the turn it starts clears what the state shows.
    const held = this.#limits.get(request.sessionId);
    if (held && held.continuing !== request.requestId)
      this.#arm(request.sessionId, null, undefined, false);
    if (request.deviceId)
      this.#senders.set(request.sessionId, {
        deviceId: request.deviceId,
        restrictNativePolicy,
      });
  }

  cancel(request: UsageLimitRequest, record: UsageLimitRecord, fingerprint: string) {
    return this.#choose(request, record, fingerprint, (limit) =>
      limit.continueAt === null ? null : { ...limit, continueAt: null, manual: "cancelled" },
    );
  }

  continue(request: UsageLimitRequest, record: UsageLimitRecord, fingerprint: string) {
    return this.#choose(request, record, fingerprint, (limit) =>
      armUsageLimit(limit, { bootId: this.dependencies.runtimeBootId }),
    );
  }

  projectLive(sessionId: string, live: Record<string, unknown>) {
    return live.executionMode === "codex-managed"
      ? { ...live, usageLimit: this.view(sessionId) }
      : live;
  }

  /**
   * After a managed Codex turn: one that met the account's usage limit is held, with the continue
   * armed as `usage-limit.ts` says; a turn that completes ends the hold.
   */
  onTurnCompleted(
    sessionId: string,
    session: CodexAppServerSession,
    limited: ManagedCodexState["limitedTurn"],
    turn: Record<string, unknown>,
  ): void {
    if (limited && limited.turnId === turn.id) {
      void this.#hold(sessionId, session, limited.message);
      return;
    }
    if (turn.status === "completed" && !turn.error && this.#limits.has(sessionId)) {
      this.#arm(sessionId, null);
      this.dependencies.limitEnded(sessionId);
    }
  }

  /** Whether a managed Codex session waits for its usage limit to reset. */
  isLimited(sessionId: string): boolean {
    const held = this.#limits.get(sessionId);
    return !!held && !held.continuing;
  }

  #credentials(): string | undefined {
    try {
      const home = this.dependencies.home();
      const file = statSync(join(home, "auth.json"), { bigint: true, throwIfNoEntry: false });
      // Metadata is an invalidation signal. No login material is read or kept.
      return [home, file?.dev, file?.ino, file?.mtimeNs, file?.ctimeNs, file?.size].join("\0");
    } catch {
      return undefined;
    }
  }

  observeAccount(nativeUpdate = false): void {
    const sessionId = this.#limits.keys().next().value;
    if (!sessionId || this.#refreshing) return;
    const version = this.#credentials();
    if (!nativeUpdate && (version === undefined || version === this.#credentialVersion)) return;
    this.#credentialVersion = version;
    void this.refreshWorker(sessionId).catch(() => undefined);
  }

  refreshWorker(sessionId: string): Promise<boolean> {
    if (this.dependencies.isShuttingDown()) return Promise.resolve(false);
    if (this.#refreshing) return this.#refreshing;
    if (!this.#limits.has(sessionId)) return Promise.resolve(true);
    return (this.#refreshing = this.#refreshAccount(sessionId).finally(() => {
      this.#refreshing = undefined;
    }));
  }

  async #refreshAccount(sessionId: string): Promise<boolean> {
    const version = this.#credentials();
    const held = [...this.#limits];
    const read = await this.dependencies.readAccountLimit(sessionId).catch(() => null);
    if (!isObject(read) || version !== this.#credentials() || this.dependencies.isShuttingDown())
      return false;
    // Codex validates this field against the active account. A missing field or a
    // reset time that has passed does not prove that ordinary usage is available.
    if (read.ordinaryUsageAllowed !== true && read.ordinaryUsageAllowed !== false) return false;
    this.#credentialVersion = version;
    const recovered: string[] = [];
    await Promise.all(
      held.map(async ([id, entry]) => {
        const current = () => this.#limits.get(id) === entry && !entry.continuing;
        if (!current()) return;
        const hit = codexUsageLimitHit(read, entry.limit.message);
        if (read.ordinaryUsageAllowed === true) {
          // The runner that hit the hold may still have the previous auth cached.
          // Close only idle children, using the ordinary managed teardown fence.
          try {
            await this.dependencies.reloadIdleRunner(id);
          } catch {
            return;
          }
          if (!current() || version !== this.#credentials() || this.dependencies.isShuttingDown())
            return;
          this.#arm(id, null);
          recovered.push(id);
        } else if (
          hit.resetsAt !== entry.limit.resetsAt ||
          hit.kind !== entry.limit.kind ||
          hit.scope !== entry.limit.scope
        ) {
          const limit = { ...entry.limit, ...hit };
          this.#arm(id, limit.continueAt === null ? limit : this.#updatedContinue(limit));
        }
      }),
    );
    for (const id of recovered) this.dependencies.limitEnded(id);
    return true;
  }

  #updatedContinue(limit: UsageLimit): UsageLimit {
    return holdUsageLimit("codex", limit, {
      deviceId: limit.deviceId,
      bootId: limit.bootId,
      previous: limit,
      autoContinue: usageLimitAutoContinue(this.dependencies.dataDir),
    });
  }

  async #hold(sessionId: string, session: CodexAppServerSession, message: string): Promise<void> {
    // Codex's error carries no reset time; the account's limits do, as the Codex app reads them.
    if (this.#limits.size === 0) this.#credentialVersion = this.#credentials();
    const read = await session
      .request(CODEX_ACCOUNT_LIMIT_METHOD, CODEX_ACCOUNT_LIMIT_PARAMS)
      .catch(() => null);
    const held = this.#limits.get(sessionId);
    this.#arm(
      sessionId,
      holdUsageLimit("codex", codexUsageLimitHit(read, message), {
        deviceId: this.#senders.get(sessionId)?.deviceId ?? held?.limit.deviceId ?? "",
        bootId: this.dependencies.runtimeBootId,
        // Only a turn AgentKib's continue started counts toward the three in a row.
        previous: held?.continuing ? held.limit : null,
        autoContinue: usageLimitAutoContinue(this.dependencies.dataDir),
      }),
    );
  }

  /**
   * Holds `limit` (null ends the hold) and arms its continue; `show` puts it on the live state,
   * which moves its revision, so never in the middle of a control.
   */
  #arm(sessionId: string, limit: UsageLimit | null, continuing?: string, show = true): void {
    const held = this.#limits.get(sessionId);
    clearTimeout(held?.timer);
    if (!limit) this.#limits.delete(sessionId);
    else {
      const timer =
        limit.continueAt === null
          ? undefined
          : setTimeout(
              () => void this.#fireContinue(sessionId).catch(() => undefined),
              Math.max(0, limit.continueAt - Date.now()),
            );
      timer?.unref?.();
      this.#limits.set(sessionId, { limit, timer, continuing });
    }
    if (show)
      this.dependencies.publishLimit(
        sessionId,
        usageLimitView(limit, this.dependencies.runtimeBootId),
      );
  }

  /**
   * The continue armed after a usage limit is due: AgentKib resumes a goal Codex paused for the
   * limit, or sends its continue, in the name of the device whose turn met the limit.
   */
  async #fireContinue(sessionId: string): Promise<void> {
    const held = this.#limits.get(sessionId);
    if (!held || this.dependencies.isShuttingDown()) return;
    const due = usageLimitContinue(held.limit, this.dependencies.runtimeBootId);
    if (due === "never") return;
    if (due === "wait") return this.#arm(sessionId, held.limit);
    if (due === "stale")
      return this.#arm(sessionId, { ...held.limit, continueAt: null, manual: "stale" });
    const requestId = randomUUID();
    this.#arm(
      sessionId,
      { ...held.limit, continueAt: null, autoContinues: held.limit.autoContinues + 1 },
      requestId,
      false,
    );
    const live = await this.dependencies.readLive(sessionId).catch(() => null);
    if (this.#limits.get(sessionId)?.continuing !== requestId) return;
    if (!live || live.status !== "idle") {
      // Something else runs: look again shortly.
      return this.#arm(sessionId, { ...held.limit, continueAt: Date.now() + 60_000 });
    }
    const goal = isObject(live.goal) && live.goal.status === "usageLimited";
    const sender = this.#senders.get(sessionId);
    const result = (await this.dependencies
      .controlSession(
        {
          operation: goal ? "goal-resume" : "send",
          sessionId,
          requestId,
          ...(held.limit.deviceId ? { deviceId: held.limit.deviceId } : {}),
          runtimeBootId: live.runtimeBootId,
          expectedRevision: live.revision,
          experimentalEnabled: true,
          ...(goal ? {} : { text: AUTO_CONTINUE_TEXT.codex }),
        },
        sender?.deviceId === held.limit.deviceId && sender.restrictNativePolicy,
      )
      .catch(() => null)) as Record<string, unknown> | null;
    const current = this.#limits.get(sessionId);
    if (result?.accepted !== true && current?.continuing === requestId)
      // Refused: the person continues.
      this.#arm(sessionId, { ...current.limit, manual: "stale" });
  }

  /** The person's choice about the continue: off this time (`usage-limit-cancel`), or on. */
  #choose(
    request: UsageLimitRequest,
    record: UsageLimitRecord,
    fingerprint: string,
    choose: (limit: UsageLimit) => UsageLimit | null,
  ): Record<string, unknown> {
    const held = this.#limits.get(request.sessionId);
    const next = held ? choose(held.limit) : null;
    if (!record || !next) throw new Error("usage-limit-continue-unavailable");
    const claimed = claimManagedCommand(
      this.dependencies.dataDir,
      request.requestId,
      request.sessionId,
      fingerprint,
      request.deviceId ?? null,
      {
        operation: request.operation,
        workspaceId: record.workspace_id,
        runtimeBootId: request.runtimeBootId,
        expectedRevision: request.expectedRevision,
        executionMode: "codex-managed",
        turnId: null,
        nativeRequestId: null,
      },
    );
    if (claimed) return claimed;
    this.#arm(request.sessionId, next);
    const result = {
      sessionId: request.sessionId,
      accepted: true,
      completed: true,
      requestId: request.requestId,
      runtimeBootId: this.dependencies.runtimeBootId,
    };
    finishManagedCommand(this.dependencies.dataDir, request.requestId, result);
    return result;
  }

  /** A device lost access: AgentKib no longer continues in its name after a usage limit. */
  invalidateDevice(deviceId: string): void {
    for (const [sessionId, held] of this.#limits)
      if (held.limit.deviceId === deviceId && held.limit.continueAt !== null)
        this.#arm(sessionId, { ...held.limit, continueAt: null, manual: "cancelled" });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
