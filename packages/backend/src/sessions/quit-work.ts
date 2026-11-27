import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  REMOTE_ERROR_CODES as codes,
  RUNTIME_METHODS,
  type InterruptedQuitWork,
  type QuitWorkDecision,
  type QuitWorkOutcome,
  type QuitWorkPreview,
  type QuitWorkResult,
  type RemoteErrorCode,
} from "@agentkib/runtime-protocol";
import { z } from "zod";
import {
  quitWorkReason,
  type NoteQuitWorkReason,
  type QuitWorkReportOutcome,
} from "./quit-work-result";
import { recordQuitWorkOutcome, recordQuitWorkTrace } from "./quit-work-trace";

const MAX_ENTRIES = 50;
const MAX_TICKETS = 32;
const MAX_JOURNAL_BYTES = 512 * 1024;
const CONTINUATION =
  "The previous turn was interrupted when AgentKib quit. Please continue from where it stopped.";
const UPGRADE_CONTINUATION =
  "The previous turn was interrupted by an AgentKib upgrade. Please continue from where it stopped. If it was waiting for approval or an answer, ask again and wait for the user. Do not assume a decision.";

export const quitWorkDecisionSchema = z.object({ ticket: z.uuid(), resume: z.boolean() }).strict();
const assignmentSchema = z.object({ leadId: z.string(), laneId: z.string() });
const sessionSchema = z.object({
  sessionId: z.string().min(1).max(256),
  title: z.string().max(512),
  agent: z.string().max(64),
});
const checkpointSchema = sessionSchema.extend({
  id: z.uuid(),
  turnId: z.string().min(1).max(256),
  assignment: assignmentSchema.optional(),
  evidence: z.record(z.string(), z.unknown()),
  phase: z.enum(["pending", "manual", "claimed", "continued", "skipped", "unknown"]),
  reported: z.boolean(),
  upgrade: z.literal(true).optional(),
  reason: z.unknown().transform(quitWorkReason).optional(),
});
const journalSchema = z.object({
  version: z.literal(1),
  entries: z.array(checkpointSchema).max(MAX_ENTRIES),
});

type Session = z.infer<typeof sessionSchema>;
type Assignment = z.infer<typeof assignmentSchema>;
type Checkpoint = z.infer<typeof checkpointSchema>;
type QuitWorkCandidate = { turnId: string; manualOnly?: boolean };
type Candidate = Session & { id: string; reason?: RemoteErrorCode } & Partial<QuitWorkCandidate>;
type FinishedOutcome = Exclude<QuitWorkOutcome, "manual-required">;

interface QuitWorkDependencies {
  sessions: () => Promise<Session[]>;
  resumeByDefault: () => boolean;
  candidate: (session: Session, note: NoteQuitWorkReason) => Promise<QuitWorkCandidate | undefined>;
  assignment: (sessionId: string) => Assignment | undefined;
  interrupt: (session: Candidate, turnId: string) => Promise<Record<string, unknown> | undefined>;
  check: (entry: Checkpoint, note: NoteQuitWorkReason) => Promise<boolean | "open-session">;
  dispatch: (entry: Checkpoint, text: string, note: NoteQuitWorkReason) => Promise<QuitWorkOutcome>;
  receipt: (entry: Checkpoint, note: NoteQuitWorkReason) => QuitWorkOutcome;
  report: (entry: Checkpoint, assignment: Assignment, outcome: QuitWorkReportOutcome) => void;
}

export class QuitWork {
  readonly #file: string;
  #entries: Checkpoint[] = [];
  readonly #tickets = new Map<string, Candidate[]>();
  readonly #verifiedManual = new Map<string, "continue" | "open-session">();
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #dispatching = new Set<string>();
  readonly #reconciling = new Map<string, Promise<QuitWorkResult>>();
  readonly #unwritten = new Map<string, QuitWorkResult>();
  readonly #upgradingTurns = new Map<string, string>();
  #startupReady?: Promise<unknown>;
  #journalUnavailable = false;
  #started = false;
  #stopping = false;

  constructor(
    dataDir: string,
    private readonly dependencies: QuitWorkDependencies,
  ) {
    this.#file = path.join(dataDir, "quit-work.json");
    try {
      if (statSync(this.#file).size > MAX_JOURNAL_BYTES) throw new Error("invalid-journal-size");
      this.#entries = journalSchema.parse(JSON.parse(readFileSync(this.#file, "utf8"))).entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#journalUnavailable = true;
        console.error("AgentKib could not read the interrupted work journal");
      }
    }
  }

  #write(entries: Checkpoint[]): void {
    const content = JSON.stringify({ version: 1, entries });
    if (Buffer.byteLength(content) > MAX_JOURNAL_BYTES) throw new Error("invalid-journal-size");
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, content);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.#file);
      this.#entries = entries;
      this.#journalUnavailable = false;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  #update(entry: Checkpoint, fields: Partial<Checkpoint>): Checkpoint {
    const updated = { ...entry, ...fields };
    this.#write(this.#entries.map((current) => (current.id === entry.id ? updated : current)));
    return updated;
  }

  #run<T>(task: Promise<T>): Promise<T> {
    this.#inFlight.add(task);
    void task.finally(() => this.#inFlight.delete(task)).catch(() => undefined);
    return task;
  }

  #report(entry: Checkpoint, outcome: QuitWorkReportOutcome): void {
    if (entry.reported || !entry.assignment) return;
    try {
      this.dependencies.report(entry, entry.assignment, outcome);
      this.#update(entry, { reported: true });
    } catch {
      // The continuation result has already been saved. A later startup can retry the report.
      console.error("AgentKib could not report interrupted work");
    }
  }

  async prepare(): Promise<QuitWorkPreview> {
    const started = performance.now();
    const ticket = randomUUID();
    const resumeByDefault = this.dependencies.resumeByDefault();
    const sessions = await this.dependencies.sessions().catch(() => undefined);
    if (!sessions) {
      recordQuitWorkTrace(RUNTIME_METHODS.quitWorkPrepare, started, {
        stage: "quit-work-prepare",
        outcome: "failed",
        reason: codes.quitWorkPlanUnavailable,
      });
      return { ticket, resumeByDefault, work: [], reason: codes.quitWorkPlanUnavailable };
    }
    const candidates = await Promise.all(
      sessions.slice(0, MAX_ENTRIES).map(async (session): Promise<Candidate> => {
        const started = performance.now();
        let reason: RemoteErrorCode | undefined;
        const candidate = await this.dependencies
          .candidate(session, (code) => {
            reason = code;
          })
          .catch(() => {
            reason = codes.quitWorkCandidateUnavailable;
            return undefined;
          });
        if (reason)
          recordQuitWorkTrace(RUNTIME_METHODS.quitWorkPrepare, started, {
            stage: "quit-work-candidate",
            outcome: candidate ? "refused" : "failed",
            reason,
          });
        return {
          ...session,
          id: randomUUID(),
          turnId: candidate?.turnId,
          manualOnly: candidate?.manualOnly,
          reason,
        };
      }),
    );
    if (!this.#stopping) {
      if (this.#tickets.size >= MAX_TICKETS)
        this.#tickets.delete(this.#tickets.keys().next().value!);
      this.#tickets.set(ticket, candidates);
    }
    return {
      ticket,
      resumeByDefault,
      work: candidates.map(({ id, title, agent, turnId, manualOnly, reason }) => ({
        id,
        title,
        agent,
        resumable: turnId !== undefined && !manualOnly,
        ...(reason && { reason }),
      })),
    };
  }

  isUpgradeInterruption(sessionId: string, turnId: string): boolean {
    return (
      this.#upgradingTurns.get(sessionId) === turnId ||
      this.#entries.some(
        (entry) => entry.upgrade && entry.sessionId === sessionId && entry.turnId === turnId,
      )
    );
  }

  isUpgradeDispatching(sessionId: string, assignment: Assignment): boolean {
    return (
      this.#dispatching.size > 0 &&
      this.#entries.some(
        (entry) =>
          entry.phase === "claimed" &&
          entry.upgrade &&
          this.#dispatching.has(entry.id) &&
          entry.sessionId === sessionId &&
          entry.assignment?.leadId === assignment.leadId &&
          entry.assignment.laneId === assignment.laneId,
      )
    );
  }

  async saveOnShutdown(decision?: QuitWorkDecision, upgrade = false): Promise<void> {
    const stopping = upgrade ? this.stop(decision, true) : this.stop(decision);
    await stopping.catch(() => {
      console.error("AgentKib could not save the interrupted work journal");
    });
  }

  async stop(decision?: QuitWorkDecision, upgrade = false): Promise<void> {
    this.#stopping = true;
    const candidates = decision && this.#tickets.get(decision.ticket);
    this.#tickets.clear();
    await Promise.allSettled([...this.#inFlight]);
    if (!decision || !candidates) return;
    // Replace the preceding explicit quit's batch. An upgrade preserves work the
    // user already chose to continue manually. Save each proof as
    // soon as it is ready so a slow sibling cannot lose a verified interruption.
    if (!upgrade) this.#write([]);
    await Promise.all(
      candidates.map(async (candidate) => {
        const turnId = candidate.turnId;
        if (!turnId) return;
        if (upgrade) this.#upgradingTurns.set(candidate.sessionId, turnId);
        try {
          const assignment = this.dependencies.assignment(candidate.sessionId);
          const evidence = await this.dependencies.interrupt(candidate, turnId);
          if (!evidence) return;
          const manualOnly = candidate.manualOnly === true || evidence.manualOnly === true;
          this.#write([
            ...this.#entries.slice(-(MAX_ENTRIES - 1)),
            {
              id: candidate.id,
              sessionId: candidate.sessionId,
              title: candidate.title,
              agent: candidate.agent,
              turnId,
              assignment,
              evidence: manualOnly ? { ...evidence, manualOnly: true } : evidence,
              phase: decision.resume && !manualOnly ? "pending" : "manual",
              ...(candidate.reason && { reason: candidate.reason }),
              reported: false,
              ...(upgrade && { upgrade: true as const }),
            },
          ]);
        } catch {
          console.error("AgentKib could not record an interruption during quit");
        } finally {
          if (upgrade) this.#upgradingTurns.delete(candidate.sessionId);
        }
      }),
    );
  }

  start(): void {
    if (this.#started || this.#stopping) return;
    this.#started = true;
    // A delayed auto attempt can become a manual task. Index the finished batch for
    // the first Home read so it cannot cache an empty result while recovery is in flight.
    this.#startupReady = this.#run(
      Promise.allSettled([this.#verifyManual(), this.#continuePending()]),
    );
  }

  async #verifyManual(): Promise<void> {
    for (const entry of this.#entries) {
      if (this.#stopping) return;
      if (entry.phase !== "manual") continue;
      try {
        await this.#checkManual(entry);
      } catch {
        console.error("AgentKib could not verify manually resumable work");
      }
    }
  }

  async #checkManual(entry: Checkpoint): Promise<QuitWorkResult> {
    const started = performance.now();
    let reason: RemoteErrorCode | undefined;
    let check: boolean | "open-session";
    try {
      check = await this.dependencies.check(entry, (code) => {
        reason = code;
      });
    } catch {
      reason = codes.quitWorkCandidateUnavailable;
      recordQuitWorkTrace(RUNTIME_METHODS.quitWorkResume, started, {
        stage: "quit-work-check",
        outcome: "failed",
        reason,
      });
      return { outcome: "manual-required", reason };
    }
    if (!check) {
      const refused = reason ?? codes.quitWorkEvidenceChanged;
      recordQuitWorkTrace(RUNTIME_METHODS.quitWorkResume, started, {
        stage: "quit-work-check",
        outcome: "refused",
        reason: refused,
      });
      return this.#finish(entry, "skipped", refused);
    }
    this.#report(entry, "not-continued");
    this.#verifiedManual.set(
      entry.id,
      check === "open-session" || entry.evidence.manualOnly === true ? "open-session" : "continue",
    );
    return { outcome: "manual-required", ...(entry.reason && { reason: entry.reason }) };
  }

  async #continuePending(): Promise<void> {
    for (const entry of this.#entries) {
      if (this.#stopping) return;
      try {
        if (entry.phase === "pending") {
          await this.#dispatch(entry);
        } else if (entry.phase === "claimed" || entry.phase === "unknown") {
          await this.#reconcile(entry);
        } else if (entry.phase === "continued" || entry.phase === "skipped") {
          this.#report(entry, entry.phase === "skipped" ? "not-continued" : entry.phase);
        }
      } catch {
        console.error("AgentKib could not reconcile an interrupted task");
      }
    }
  }

  #bookkeepingFailed(entry: Checkpoint, result: QuitWorkResult, started: number): QuitWorkResult {
    // Keep a verified result in this process. The durable claim still protects a restart.
    this.#unwritten.set(entry.id, result);
    const bookkeepingReason = codes.quitWorkJournalUnavailable;
    recordQuitWorkTrace(RUNTIME_METHODS.quitWorkResume, started, {
      stage: "quit-work-bookkeeping",
      outcome: "failed",
      reason: bookkeepingReason,
    });
    return { ...result, bookkeepingReason };
  }

  #finish(entry: Checkpoint, outcome: FinishedOutcome, reason?: RemoteErrorCode): QuitWorkResult {
    const started = performance.now();
    const result: QuitWorkResult =
      outcome === "continued"
        ? { outcome, ...(reason && { queueRestoreReason: reason }) }
        : { outcome, ...(reason && { reason }) };
    let current: Checkpoint;
    try {
      current = this.#update(entry, { phase: outcome, reason });
    } catch {
      return this.#bookkeepingFailed(entry, result, started);
    }
    this.#unwritten.delete(entry.id);
    this.#report(current, outcome === "skipped" ? "not-continued" : outcome);
    return result;
  }

  async #dispatch(entry: Checkpoint): Promise<QuitWorkResult> {
    if (this.#stopping) return { outcome: "skipped", reason: codes.quitWorkPlanUnavailable };
    if (entry.evidence.manualOnly === true) return this.#requireManual(entry);
    const started = performance.now();
    // The claim must hit disk before dispatch. Across a crash, only a receipt can
    // establish whether this request was accepted; never submit the request again.
    let claimed: Checkpoint;
    try {
      claimed = this.#update(entry, { phase: "claimed" });
    } catch {
      return recordQuitWorkOutcome("quit-work-dispatch", started, {
        outcome: "skipped",
        reason: codes.quitWorkJournalUnavailable,
      });
    }
    this.#verifiedManual.delete(entry.id);
    this.#dispatching.add(entry.id);
    try {
      let outcome: QuitWorkOutcome;
      let reason: RemoteErrorCode | undefined;
      try {
        outcome = await this.dependencies.dispatch(
          claimed,
          entry.upgrade ? UPGRADE_CONTINUATION : CONTINUATION,
          (code) => {
            reason = code;
          },
        );
      } catch {
        recordQuitWorkOutcome("quit-work-dispatch", started, { outcome: "unknown" });
        return await this.#readReceipt(claimed);
      }
      const result =
        outcome === "manual-required"
          ? await this.#requireManual(claimed, reason)
          : this.#finish(claimed, outcome, this.#resultReason(outcome, reason));
      return recordQuitWorkOutcome("quit-work-dispatch", started, result);
    } finally {
      this.#dispatching.delete(entry.id);
    }
  }

  #resultReason(outcome: FinishedOutcome, reason?: RemoteErrorCode) {
    return outcome === "unknown"
      ? codes.controlOutcomeUnconfirmed
      : (reason ?? (outcome === "skipped" ? codes.requestFailed : undefined));
  }

  #canReconcile({ id, phase }: Checkpoint): boolean {
    return (
      !this.#stopping &&
      !this.#dispatching.has(id) &&
      (phase === "claimed" || phase === "unknown" || this.#unwritten.has(id))
    );
  }

  #reconcile(entry: Checkpoint): Promise<QuitWorkResult> {
    const pending = this.#reconciling.get(entry.id);
    if (pending) return pending;
    const task = this.#readReceipt(entry).finally(() => this.#reconciling.delete(entry.id));
    this.#reconciling.set(entry.id, task);
    return this.#run(task);
  }

  async #readReceipt(entry: Checkpoint): Promise<QuitWorkResult> {
    const started = performance.now();
    const unwritten = this.#unwritten.get(entry.id);
    if (unwritten && unwritten.outcome !== "unknown") {
      const { outcome } = unwritten;
      if (outcome === "manual-required") return this.#requireManual(entry, unwritten.reason);
      return this.#finish(
        entry,
        outcome,
        outcome === "continued" ? unwritten.queueRestoreReason : unwritten.reason,
      );
    }
    let reason: RemoteErrorCode | undefined;
    let outcome: QuitWorkOutcome;
    try {
      outcome = this.dependencies.receipt(entry, (code) => {
        reason = code;
      });
    } catch {
      outcome = "unknown";
    }
    if (entry.phase === "unknown" && outcome === "unknown" && !unwritten) {
      this.#report(entry, "unknown");
      return recordQuitWorkOutcome("quit-work-reconcile", started, {
        outcome,
        reason: codes.controlOutcomeUnconfirmed,
      });
    }
    const result =
      outcome === "manual-required"
        ? await this.#requireManual(entry, reason)
        : this.#finish(entry, outcome, this.#resultReason(outcome, reason));
    return recordQuitWorkOutcome("quit-work-reconcile", started, result);
  }

  async #requireManual(entry: Checkpoint, reason?: RemoteErrorCode): Promise<QuitWorkResult> {
    const started = performance.now();
    const manualReason = reason ?? entry.reason ?? codes.quitWorkManualRequired;
    let manual: Checkpoint;
    try {
      manual = this.#update(entry, {
        phase: "manual",
        reason: manualReason,
        evidence: { ...entry.evidence, manualOnly: true },
      });
    } catch {
      return this.#bookkeepingFailed(
        entry,
        { outcome: "manual-required", reason: manualReason },
        started,
      );
    }
    this.#unwritten.delete(entry.id);
    return this.#checkManual(manual);
  }

  #listEntry(entry: Checkpoint, includeTerminalResults: boolean): InterruptedQuitWork | undefined {
    const { id, sessionId, title, agent, phase, reason } = entry;
    const fields = { id, sessionId, title, agent };
    const unwritten = this.#unwritten.get(id);
    const bookkeeping = unwritten ? { bookkeepingReason: codes.quitWorkJournalUnavailable } : {};
    const outcome = unwritten?.outcome ?? phase;
    if (outcome === "continued") {
      const queueRestoreReason =
        unwritten?.outcome === "continued" ? unwritten.queueRestoreReason : reason;
      if (!includeTerminalResults || (!queueRestoreReason && !unwritten)) return;
      return {
        ...fields,
        ...bookkeeping,
        status: "continued",
        resumable: false,
        openSession: true,
        ...(queueRestoreReason && { queueRestoreReason }),
      };
    }
    if (outcome === "skipped") {
      const refused = unwritten?.outcome === "skipped" ? unwritten.reason : reason;
      if (!includeTerminalResults || !refused) return;
      return { ...fields, ...bookkeeping, status: "skipped", resumable: false, reason: refused };
    }
    if (outcome === "unknown" || (outcome === "claimed" && !this.#dispatching.has(id)))
      return {
        ...fields,
        ...bookkeeping,
        status: "unknown",
        resumable: false,
        reason: codes.controlOutcomeUnconfirmed,
      };
    const action = outcome === "manual" ? this.#verifiedManual.get(id) : undefined;
    if (action)
      return {
        ...fields,
        status: "interrupted",
        resumable: action === "continue",
        ...(reason && { reason }),
        ...(action === "open-session" && { openSession: true }),
      };
    if (
      outcome === "manual-required" &&
      includeTerminalResults &&
      unwritten?.outcome === "manual-required"
    )
      return {
        ...fields,
        ...bookkeeping,
        status: "interrupted",
        resumable: false,
        ...(unwritten.reason && { reason: unwritten.reason }),
        openSession: true,
      };
  }

  async list(includeTerminalResults = false): Promise<InterruptedQuitWork[]> {
    await this.#startupReady;
    if (this.#journalUnavailable) throw new Error(codes.quitWorkJournalUnavailable);
    // A late receipt settles the existing claim; checking Home never submits a new prompt.
    for (const { id } of this.#entries) {
      const entry = this.#entries.find((candidate) => candidate.id === id);
      if (entry && this.#canReconcile(entry)) await this.#reconcile(entry);
    }
    return this.#entries.flatMap((entry) => this.#listEntry(entry, includeTerminalResults) ?? []);
  }

  async resume(id: string): Promise<QuitWorkResult> {
    await this.#startupReady;
    const entry = this.#entries.find((item) => item.id === id);
    if (entry && this.#canReconcile(entry)) return this.#reconcile(entry);
    if (entry?.phase === "skipped" && entry.reason)
      return { outcome: "skipped", reason: entry.reason };
    const action = this.#verifiedManual.get(id);
    if (entry?.phase !== "manual" || !action) return { outcome: "skipped" };
    if (action === "open-session")
      return { outcome: "manual-required", ...(entry.reason && { reason: entry.reason }) };
    return this.#run(this.#dispatch(entry));
  }
}
