import { randomUUID } from "node:crypto";

/**
 * What a Project Agent's reports go through when they are messages to it: AgentKib's own controls
 * of a Codex session it runs, or of a DeepSeek Harness session through the DSH bridge.
 */
export type LeadMessageControls = {
  live(sessionId: string): Promise<Record<string, unknown>>;
  control(value: Record<string, unknown>): Promise<Record<string, unknown>>;
  queue(sessionId: string): Promise<{ data?: Array<Record<string, unknown>> } | null>;
};

/** The provider has not applied a report, so it can be retried safely. */
export class LeadReportNotDispatched extends Error {}

/** A native usage hold was observed before sending any controls. */
export class LeadReportUsageLimit extends LeadReportNotDispatched {}

/**
 * The reports for Codex and DeepSeek Harness Project Agents (docs/agents/project-agent.md). A
 * report is a message AgentKib sends the lead in the name of the device that set it up: at once
 * when it is idle, else queued after its turn in the agent's own queue. A report still waiting in
 * that queue takes the next one in (`queue-update`, found by the request that queued it), as a
 * managed Claude Code lead's waiting report does.
 */
export class MessageLeadReports {
  /** The report each lead has waiting in Codex's queue, by the request that queued it. */
  #waiting = new Map<string, { requestId: string; text: string }>();
  #sending = new Map<string, Promise<boolean>>();

  constructor(private readonly controls: LeadMessageControls) {}

  /** Sends or queues the report; true when it joined one still waiting. Throws when refused. */
  async send(
    sessionId: string,
    deviceId: string,
    text: string,
    canSend?: () => boolean,
  ): Promise<boolean> {
    // Normal and quit reports can both become deliverable at once. Read the next
    // control revision only after the previous report's send or update settles.
    const previous = this.#sending.get(sessionId);
    const send = () => this.#send(sessionId, deviceId, text, canSend);
    const pending = previous ? previous.then(send, send) : send();
    this.#sending.set(sessionId, pending);
    try {
      return await pending;
    } finally {
      if (this.#sending.get(sessionId) === pending) this.#sending.delete(sessionId);
    }
  }

  async #send(
    sessionId: string,
    deviceId: string,
    text: string,
    canSend: (() => boolean) | undefined,
  ): Promise<boolean> {
    const live = await this.controls.live(sessionId).catch((error: unknown) => {
      throw new LeadReportNotDispatched(String(error), { cause: error });
    });
    // A Codex automatic continue in flight still has its live limit; a queue-add would clear it.
    if (live.executionMode === "codex-managed" && live.usageLimit != null)
      throw new LeadReportUsageLimit("usage-limit");
    const running = ["running", "awaiting-approval", "waiting-input"].includes(String(live.status));
    const control = (value: Record<string, unknown>) => {
      if (canSend && !canSend()) throw new LeadReportNotDispatched("report-authorization-changed");
      return this.controls.control({
        sessionId,
        deviceId,
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        ...value,
      });
    };
    const waiting = running ? this.#waiting.get(sessionId) : undefined;
    if (waiting) {
      const queue = await this.controls.queue(sessionId).catch(() => null);
      const row = queue?.data?.find((item) => item.clientUserMessageId === waiting.requestId);
      if (typeof row?.id === "string") {
        const joined = `${waiting.text}\n\n${text}`;
        const updated = await control({
          operation: "queue-update",
          requestId: randomUUID(),
          queuedSubmissionId: row.id,
          text: joined,
        });
        if (updated?.accepted === true) {
          this.#waiting.set(sessionId, { requestId: waiting.requestId, text: joined });
          return true;
        }
        if (updated?.accepted !== false || updated.controlOutcome === "unknown")
          throw new Error(String(updated?.reason ?? updated?.error ?? "report-undelivered"));
      }
    }
    const requestId = randomUUID();
    const result = await control({ operation: running ? "queue-add" : "send", requestId, text });
    if (result?.accepted !== true) {
      const reason = String(result?.reason ?? result?.error ?? "report-undelivered");
      if (result?.controlOutcome === "not-dispatched") throw new LeadReportNotDispatched(reason);
      throw new Error(reason);
    }
    if (running) this.#waiting.set(sessionId, { requestId, text });
    else this.#waiting.delete(sessionId);
    return false;
  }
}
