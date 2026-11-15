import { describe, expect, it } from "vitest";
import { MessageLeadReports } from "../../../packages/backend/src/message-lead-reports";

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
});
