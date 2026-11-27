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
import type {
  InterruptedQuitWork,
  QuitWorkDecision,
  QuitWorkOutcome,
  QuitWorkPreview,
} from "@agentkib/runtime-protocol";
import { z } from "zod";

const MAX_ENTRIES = 50;
const MAX_TICKETS = 32;
const MAX_JOURNAL_BYTES = 512 * 1024;
const CONTINUATION =
  "The previous turn was interrupted when AgentKib quit. Please continue from where it stopped.";
const UPGRADE_CONTINUATION =
  "The previous turn was interrupted by an AgentKib upgrade. Please continue from where it stopped. If it was waiting for approval or an answer, ask again and wait for the user. Do not assume a decision.";

export const quitWorkDecisionSchema = z.object({ ticket: z.uuid(), resume: z.boolean() }).strict();
export const QUIT_WORK_MANUAL_REASON = "quit-work-manual-required";

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
});
const journalSchema = z.object({
  version: z.literal(1),
  entries: z.array(checkpointSchema).max(MAX_ENTRIES),
});

type Session = z.infer<typeof sessionSchema>;
type Assignment = z.infer<typeof assignmentSchema>;
type Checkpoint = z.infer<typeof checkpointSchema>;
type QuitWorkCandidate = { turnId: string; manualOnly?: boolean };
type Candidate = Session & { id: string } & Partial<QuitWorkCandidate>;
type WorkerOutcome = "continued" | "not-continued" | "unknown";
type FinishedOutcome = Exclude<QuitWorkOutcome, "manual-required">;

interface QuitWorkDependencies {
  sessions: () => Promise<Session[]>;
  resumeByDefault: () => boolean;
  candidate: (session: Session) => Promise<QuitWorkCandidate | undefined>;
  assignment: (sessionId: string) => Assignment | undefined;
  interrupt: (session: Candidate, turnId: string) => Promise<Record<string, unknown> | undefined>;
  check: (entry: Checkpoint) => Promise<boolean | "open-session">;
  dispatch: (entry: Checkpoint, text: string) => Promise<QuitWorkOutcome>;
  receipt: (entry: Checkpoint) => QuitWorkOutcome;
  report: (entry: Checkpoint, assignment: Assignment, outcome: WorkerOutcome) => void;
}

export class QuitWork {
  readonly #file: string;
  #entries: Checkpoint[] = [];
  readonly #tickets = new Map<string, Candidate[]>();
  readonly #verifiedManual = new Map<string, "continue" | "open-session">();
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #upgradingTurns = new Map<string, string>();
  #startupReady?: Promise<unknown>;
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.error("AgentKib could not read the interrupted work journal");
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

  #report(entry: Checkpoint, outcome: WorkerOutcome): void {
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
    const sessions = (await this.dependencies.sessions()).slice(0, MAX_ENTRIES);
    const candidates = await Promise.all(
      sessions.map(async (session): Promise<Candidate> => {
        const candidate = await this.dependencies.candidate(session).catch(() => undefined);
        return {
          ...session,
          id: randomUUID(),
          turnId: candidate?.turnId,
          manualOnly: candidate?.manualOnly,
        };
      }),
    );
    const ticket = randomUUID();
    if (!this.#stopping) {
      if (this.#tickets.size >= MAX_TICKETS)
        this.#tickets.delete(this.#tickets.keys().next().value!);
      this.#tickets.set(ticket, candidates);
    }
    return {
      ticket,
      resumeByDefault: this.dependencies.resumeByDefault(),
      work: candidates.map(({ id, title, agent, turnId, manualOnly }) => ({
        id,
        title,
        agent,
        resumable: turnId !== undefined && !manualOnly,
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

  async #checkManual(entry: Checkpoint): Promise<boolean> {
    const check = await this.dependencies.check(entry);
    if (!check) {
      this.#finish(entry, "skipped");
      return false;
    }
    this.#report(entry, "not-continued");
    this.#verifiedManual.set(
      entry.id,
      check === "open-session" || entry.evidence.manualOnly === true ? "open-session" : "continue",
    );
    return true;
  }

  async #continuePending(): Promise<void> {
    for (const entry of this.#entries) {
      if (this.#stopping) return;
      try {
        if (entry.phase === "pending") {
          await this.#dispatch(entry);
        } else if (entry.phase === "claimed") {
          const outcome = this.dependencies.receipt(entry);
          if (outcome === "manual-required") await this.#requireManual(entry);
          else this.#finish(entry, outcome);
        } else if (
          entry.phase === "continued" ||
          entry.phase === "skipped" ||
          entry.phase === "unknown"
        ) {
          this.#report(entry, entry.phase === "skipped" ? "not-continued" : entry.phase);
        }
      } catch {
        console.error("AgentKib could not reconcile an interrupted task");
      }
    }
  }

  #finish(entry: Checkpoint, outcome: FinishedOutcome): void {
    const current = this.#update(entry, { phase: outcome });
    this.#report(current, outcome === "skipped" ? "not-continued" : outcome);
  }

  async #dispatch(entry: Checkpoint): Promise<QuitWorkOutcome> {
    if (this.#stopping) return "skipped";
    this.#verifiedManual.delete(entry.id);
    if (entry.evidence.manualOnly === true) return this.#requireManual(entry);
    // The claim must hit disk before dispatch. Across a crash, only a receipt can
    // establish whether this request was accepted; never submit the request again.
    const claimed = this.#update(entry, { phase: "claimed" });
    let outcome: QuitWorkOutcome;
    try {
      outcome = await this.dependencies.dispatch(
        claimed,
        entry.upgrade ? UPGRADE_CONTINUATION : CONTINUATION,
      );
    } catch {
      outcome = this.dependencies.receipt(claimed);
    }
    if (outcome === "manual-required") return this.#requireManual(claimed);
    this.#finish(claimed, outcome);
    return outcome;
  }

  async #requireManual(entry: Checkpoint): Promise<QuitWorkOutcome> {
    const manual = this.#update(entry, {
      phase: "manual",
      evidence: { ...entry.evidence, manualOnly: true },
    });
    return (await this.#checkManual(manual)) ? "manual-required" : "skipped";
  }

  async list(): Promise<InterruptedQuitWork[]> {
    await this.#startupReady;
    return this.#entries.flatMap(({ id, sessionId, title, agent, phase }) => {
      const action = phase === "manual" ? this.#verifiedManual.get(id) : undefined;
      if (!action && phase !== "unknown") return [];
      return [
        {
          id,
          sessionId,
          title,
          agent,
          resumable: action === "continue",
          status: action ? "interrupted" : "unknown",
          ...(action === "open-session" && { openSession: true as const }),
        },
      ];
    });
  }

  async resume(id: string): Promise<{ outcome: QuitWorkOutcome }> {
    await this.#startupReady;
    const entry = this.#entries.find((item) => item.id === id);
    if (entry?.phase === "unknown") return { outcome: "unknown" };
    const action = this.#verifiedManual.get(id);
    if (entry?.phase !== "manual" || !action) return { outcome: "skipped" };
    if (action === "open-session") return { outcome: "manual-required" };
    return { outcome: await this.#run(this.#dispatch(entry)) };
  }
}
