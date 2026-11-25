import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  LeadReportNotDispatched,
  MessageLeadReports,
} from "../../../packages/backend/src/message-lead-reports";

describe("a Codex Project Agent's reports", () => {
  it("go at once when it is idle, queue while it works, and join a report still queued", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let status = "idle";
    const queue: Array<Record<string, unknown>> = [];
    const reports = new MessageLeadReports({
      live: async () => ({ status, runtimeBootId: "boot", revision: 7 }),
      control: async (value) => {
        calls.push(value);
        if (value.operation === "queue-add")
          queue.push({ id: "queued-1", clientUserMessageId: value.requestId });
        return { accepted: true };
      },
      queue: async () => ({ data: queue }),
    });
    expect(await reports.send("lead", "phone", "one")).toBe(false);
    expect(calls.at(-1)).toMatchObject({
      operation: "send",
      sessionId: "lead",
      deviceId: "phone",
      runtimeBootId: "boot",
      expectedRevision: 7,
      experimentalEnabled: true,
      text: "one",
    });
    status = "running";
    expect(await reports.send("lead", "phone", "two")).toBe(false);
    expect(calls.at(-1)).toMatchObject({ operation: "queue-add", text: "two" });
    expect(await reports.send("lead", "phone", "three")).toBe(true);
    expect(calls.at(-1)).toMatchObject({
      operation: "queue-update",
      queuedSubmissionId: "queued-1",
      text: "two\n\nthree",
    });
    // Its turn began meanwhile: the next report is queued anew.
    queue.length = 0;
    expect(await reports.send("lead", "phone", "four")).toBe(false);
    expect(calls.at(-1)).toMatchObject({ operation: "queue-add", text: "four" });
  });

  it("throw what refused them, so delegation pauses with the report held", async () => {
    const reports = new MessageLeadReports({
      live: async () => ({ status: "idle", runtimeBootId: "boot", revision: 1 }),
      control: async () => ({ accepted: false, error: "codex-owner-busy" }),
      queue: async () => null,
    });
    await expect(reports.send("lead", "phone", "report")).rejects.toThrow("codex-owner-busy");
  });

  it("reads a fresh control revision for concurrent reports to the same lead", async () => {
    let revision = 1;
    const calls: Array<Record<string, unknown>> = [];
    const reports = new MessageLeadReports({
      live: async () => ({ status: revision === 1 ? "idle" : "running", revision }),
      control: async (value) => {
        if (value.expectedRevision !== revision)
          return { accepted: false, reason: "stale-revision" };
        calls.push(value);
        revision++;
        return { accepted: true };
      },
      queue: async () => null,
    });
    await expect(
      Promise.all([
        reports.send("lead", "phone", "Worker completed"),
        reports.send("lead", "phone", "Worker continued after quit"),
      ]),
    ).resolves.toEqual([false, false]);
    expect(calls).toMatchObject([
      { operation: "send", expectedRevision: 1, text: "Worker completed" },
      { operation: "queue-add", expectedRevision: 2, text: "Worker continued after quit" },
    ]);
  });

  it("distinguishes a definite refusal from an unknown queue update", async () => {
    const queue: Array<Record<string, unknown>> = [];
    const operations: unknown[] = [];
    let liveUnavailable = true;
    const reports = new MessageLeadReports({
      live: async () => {
        if (liveUnavailable) throw new Error("not ready");
        return { status: "running" };
      },
      control: async ({ operation, requestId }) => {
        operations.push(operation);
        if (operations.length === 1) return { accepted: false, controlOutcome: "not-dispatched" };
        if (operation === "queue-add") {
          queue.push({ id: "queued-1", clientUserMessageId: requestId });
          return { accepted: true };
        }
        return { accepted: false, controlOutcome: "unknown", reason: "outcome_unknown" };
      },
      queue: async () => ({ data: queue }),
    });
    await expect(reports.send("lead", "phone", "one")).rejects.toBeInstanceOf(
      LeadReportNotDispatched,
    );
    expect(operations).toEqual([]);
    liveUnavailable = false;
    await expect(reports.send("lead", "phone", "one")).rejects.toBeInstanceOf(
      LeadReportNotDispatched,
    );
    await expect(reports.send("lead", "phone", "one")).resolves.toBe(false);
    await expect(reports.send("lead", "phone", "two")).rejects.toThrow("outcome_unknown");
    expect(operations).toEqual(["queue-add", "queue-add", "queue-update"]);
  });

  it("rechecks authorization after reading live and before handing off a report", async () => {
    let authorized = true;
    const control = vi.fn(async () => ({ accepted: true }));
    const reports = new MessageLeadReports({
      live: async () => {
        authorized = false;
        return { status: "idle" };
      },
      control,
      queue: async () => null,
    });
    await expect(
      reports.send("lead", "phone", "quit report", () => authorized),
    ).rejects.toBeInstanceOf(LeadReportNotDispatched);
    expect(control).not.toHaveBeenCalled();
  });

  it.each(["send", "queue-add"])(
    "reconciles a committed %s after a lost response and a restart",
    async (operation) => {
      const reportId = randomUUID();
      const live = vi.fn(async () => ({ status: operation === "send" ? "idle" : "running" }));
      let committed = false;
      const receipt = (id: string) => ({
        found: committed && id === reportId,
        sessionId: "lead",
        status: "accepted",
        operation,
      });
      const control = vi.fn(async () => {
        committed = true;
        throw new Error("response lost");
      });
      const reports = new MessageLeadReports({ live, receipt, control, queue: async () => null });
      await expect(reports.send("lead", "phone", "once", undefined, reportId)).rejects.toThrow(
        "response lost",
      );
      expect(control).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ operation, requestId: reportId }),
      );

      const recovered = new MessageLeadReports({ live, control, queue: async () => null, receipt });
      await expect(recovered.send("lead", "phone", "once", undefined, reportId)).resolves.toBe(
        false,
      );
      expect(live).toHaveBeenCalledTimes(1);
      expect(control).toHaveBeenCalledTimes(1);
    },
  );

  it("recognizes a merged report after a lost response without appending it again", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const receipts = new Map<
      string,
      { found: true; sessionId: string; status: string; operation: unknown }
    >();
    const control = vi.fn(async (value: Record<string, unknown>) => {
      receipts.set(String(value.requestId), {
        found: true,
        sessionId: "lead",
        status: "accepted",
        operation: value.operation,
      });
      if (value.operation === "queue-update") throw new Error("response lost");
      return { accepted: true };
    });
    const reports = new MessageLeadReports({
      live: async () => ({ status: "running" }),
      control,
      queue: async () => ({ data: [{ id: "queued-1", clientUserMessageId: first }] }),
      receipt: (id) => receipts.get(id) ?? { found: false },
    });
    await expect(reports.send("lead", "phone", "one", undefined, first)).resolves.toBe(false);
    await expect(reports.send("lead", "phone", "two", undefined, second)).rejects.toThrow(
      "response lost",
    );
    await expect(reports.send("lead", "phone", "two", undefined, second)).resolves.toBe(true);
    expect(control).toHaveBeenCalledTimes(2);
    expect(control.mock.calls[1]?.[0]).toMatchObject({
      operation: "queue-update",
      requestId: second,
      text: "one\n\ntwo",
    });
  });

  it("uses a new deterministic command only after a durable definite refusal", async () => {
    const reportId = randomUUID();
    let status = "unknown";
    const control = vi.fn(async (_value: Record<string, unknown>) => ({ accepted: true }));
    const controls = {
      live: async () => ({ status: "idle" }),
      control,
      queue: async () => null,
      receipt: (id: string) => ({
        found: id === reportId,
        sessionId: "lead",
        operation: "send",
        status,
        ack: { controlOutcome: status },
      }),
    };
    const reports = new MessageLeadReports(controls);
    await expect(reports.send("lead", "phone", "once", undefined, reportId)).rejects.toThrow(
      "control-outcome-unconfirmed",
    );
    expect(control).not.toHaveBeenCalled();
    status = "not-dispatched";
    await expect(reports.send("lead", "phone", "once", undefined, reportId)).resolves.toBe(false);
    const next = control.mock.calls[0]?.[0].requestId;
    expect(next).toMatch(/^[a-f0-9-]{36}$/);
    expect(next).not.toBe(reportId);
    const restarted = new MessageLeadReports({
      ...controls,
      receipt: (id) =>
        id === next
          ? {
              ...controls.receipt(id),
              found: true,
              status: "accepted",
              ack: { accepted: true, controlOutcome: "accepted" },
            }
          : controls.receipt(id),
    });
    await expect(restarted.send("lead", "phone", "once", undefined, reportId)).resolves.toBe(false);
    expect(control).toHaveBeenCalledTimes(1);
  });
});
