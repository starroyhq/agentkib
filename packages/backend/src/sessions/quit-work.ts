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
});
const journalSchema = z.object({
  version: z.literal(1),
  entries: z.array(checkpointSchema).max(MAX_ENTRIES),
});

type Session = z.infer<typeof sessionSchema>;
type Assignment = z.infer<typeof assignmentSchema>;
type Checkpoint = z.infer<typeof checkpointSchema>;
type Candidate = Session & { id: string; turnId?: string };
type WorkerOutcome = "continued" | "not-continued" | "unknown";

interface QuitWorkDependencies {
  sessions: () => Promise<Session[]>;
  resumeByDefault: () => boolean;
  candidate: (session: Session) => Promise<{ turnId: string } | undefined>;
  assignment: (sessionId: string) => Assignment | undefined;
  interrupt: (session: Candidate, turnId: string) => Promise<Record<string, unknown> | undefined>;
  check: (entry: Checkpoint) => Promise<boolean>;
  dispatch: (entry: Checkpoint, text: string) => Promise<QuitWorkOutcome>;
  receipt: (entry: Checkpoint) => QuitWorkOutcome;
  report: (entry: Checkpoint, assignment: Assignment, outcome: WorkerOutcome) => void;
}

export class QuitWork {
  readonly #file: string;
  #entries: Checkpoint[] = [];
  readonly #tickets = new Map<string, Candidate[]>();
  readonly #verifiedManual = new Set<string>();
  readonly #inFlight = new Set<Promise<unknown>>();
  #manualReady?: Promise<void>;
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
        return { ...session, id: randomUUID(), turnId: candidate?.turnId };
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
      work: candidates.map(({ id, title, agent, turnId }) => ({
        id,
        title,
        agent,
        resumable: turnId !== undefined,
      })),
    };
  }

  async stop(decision?: QuitWorkDecision): Promise<void> {
    this.#stopping = true;
    const candidates = decision && this.#tickets.get(decision.ticket);
    this.#tickets.clear();
    await Promise.allSettled([...this.#inFlight]);
    if (!decision || !candidates) return;
    // Replace the preceding quit's batch before stopping any task. Save each proof as
    // soon as it is ready so a slow sibling cannot lose a verified interruption.
    this.#write([]);
    await Promise.all(
      candidates.map(async (candidate) => {
        const turnId = candidate.turnId;
        if (!turnId) return;
        try {
          const assignment = this.dependencies.assignment(candidate.sessionId);
          const evidence = await this.dependencies.interrupt(candidate, turnId);
          if (!evidence) return;
          this.#write([
            ...this.#entries,
            {
              id: candidate.id,
              sessionId: candidate.sessionId,
              title: candidate.title,
              agent: candidate.agent,
              turnId,
              assignment,
              evidence,
              phase: decision.resume ? "pending" : "manual",
              reported: false,
            },
          ]);
        } catch {
          console.error("AgentKib could not record an interruption during quit");
        }
      }),
    );
  }

  start(): void {
    if (this.#started || this.#stopping) return;
    this.#started = true;
    this.#manualReady = this.#run(this.#verifyManual());
    void this.#manualReady.catch(() => undefined);
    void this.#run(this.#continuePending()).catch(() =>
      console.error("AgentKib could not finish resuming interrupted work"),
    );
  }

  async #verifyManual(): Promise<void> {
    for (const entry of this.#entries) {
      if (this.#stopping) return;
      if (entry.phase !== "manual") continue;
      try {
        if (await this.dependencies.check(entry)) {
          this.#report(entry, "not-continued");
          this.#verifiedManual.add(entry.id);
        } else {
          this.#finish(entry, "skipped");
        }
      } catch {
        console.error("AgentKib could not verify manually resumable work");
      }
    }
  }

  async #continuePending(): Promise<void> {
    for (const entry of this.#entries) {
      if (this.#stopping) return;
      try {
        if (entry.phase === "pending") {
          await this.#dispatch(entry);
        } else if (entry.phase === "claimed") {
          this.#finish(entry, this.dependencies.receipt(entry));
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

  #finish(entry: Checkpoint, outcome: QuitWorkOutcome): void {
    const current = this.#update(entry, { phase: outcome });
    this.#report(current, outcome === "skipped" ? "not-continued" : outcome);
  }

  async #dispatch(entry: Checkpoint): Promise<QuitWorkOutcome> {
    if (this.#stopping) return "skipped";
    // The claim must hit disk before dispatch. Across a crash, only a receipt can
    // establish whether this request was accepted; never submit the request again.
    const claimed = this.#update(entry, { phase: "claimed" });
    let outcome: QuitWorkOutcome;
    try {
      outcome = await this.dependencies.dispatch(claimed, CONTINUATION);
    } catch {
      outcome = this.dependencies.receipt(claimed);
    }
    this.#finish(claimed, outcome);
    return outcome;
  }

  async list(): Promise<InterruptedQuitWork[]> {
    await this.#manualReady?.catch(() => undefined);
    return this.#entries.flatMap(({ id, sessionId, title, agent, phase }) => {
      const resumable = phase === "manual" && this.#verifiedManual.has(id);
      if (!resumable && phase !== "unknown") return [];
      return [
        { id, sessionId, title, agent, resumable, status: resumable ? "interrupted" : "unknown" },
      ];
    });
  }

  async resume(id: string): Promise<{ outcome: QuitWorkOutcome }> {
    await this.#manualReady?.catch(() => undefined);
    const entry = this.#entries.find((item) => item.id === id);
    if (entry?.phase === "unknown") return { outcome: "unknown" };
    if (entry?.phase !== "manual" || !this.#verifiedManual.has(id)) return { outcome: "skipped" };
    return { outcome: await this.#run(this.#dispatch(entry)) };
  }
}
