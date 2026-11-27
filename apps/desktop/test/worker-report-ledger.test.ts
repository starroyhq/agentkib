import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexLeadTurns } from "../../../packages/backend/src/lead-turn-origin";
import { MessageLeadReports } from "../../../packages/backend/src/message-lead-reports";
import {
  bindWorkerReportMessage,
  projectWorkerReports,
  rememberWorkerReport,
} from "../../../packages/backend/src/worker-report-ledger";

const lead = "fixture-lead";
const native = "fixture-native";
const source = {
  workerSessionId: "fixture-worker-id",
  workerName: "fixture-worker",
  agent: "codex",
  occurredAt: "2026-11-27T00:00:00Z",
  requiresUser: false,
};

const user = (id: string, content: string, turn_id?: string) => ({
  id,
  kind: "user-message",
  content,
  turn_id,
});

describe("Worker report delivery projection", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "ak-worker-report-ledger-"));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const complete = {
    ...source,
    kind: "turn-ended" as const,
    outcome: "completed",
    durationMs: 2500,
    reply: "Done. **Evidence** is in the test.",
  };
  const approval = {
    ...source,
    kind: "waiting-approval" as const,
    requiresUser: true,
    waitingItems: [{ kind: "command" as const, summary: "Run the regression tests" }],
  };
  const first = `[AgentKib report] Worker done.\n\n${complete.reply}\n\nUse worker_read for more.`;
  const second = "[AgentKib report] Worker is waiting. The user decides in AgentKib.";

  function remember(id: string, text: string, meta: typeof complete | typeof approval) {
    rememberWorkerReport(dataDir, lead, { reportId: id, text, parts: [{ text, meta }] });
  }

  it("requires both the native message identity and matching delivered content in the same lead", () => {
    remember("report-a", first, complete);
    const text = `${first}\n\n[AgentKib report ID: report-a]`;
    bindWorkerReportMessage(
      dataDir,
      lead,
      { type: "native-message", id: "native-user" },
      ["report-a"],
      text,
    );
    const verified = user("native-user", text);
    const edited = user("native-user", `${text}\nEdited by a person.`);
    const copied = user("copied-user", text);
    const page = projectWorkerReports(dataDir, lead, { events: [verified, edited, copied] });
    expect(page.events).toEqual([
      { ...verified, worker_reports: { reportId: "report-a", parts: [complete] } },
      edited,
      copied,
    ]);
    expect(projectWorkerReports(dataDir, "another-lead", verified)).toEqual(verified);
    expect(projectWorkerReports(dataDir, lead, verified)).toMatchObject({ content: text });
  });

  it("retains ordinary and unstructured report events and strips native provenance from output", () => {
    rememberWorkerReport(dataDir, lead, { reportId: "old-report", text: first });
    bindWorkerReportMessage(
      dataDir,
      lead,
      { type: "request", id: "old-request" },
      ["old-report"],
      first,
    );
    const row = user("old-native", first);
    expect(
      projectWorkerReports(dataDir, lead, {
        items: [{ ...row, worker_report_request_id: "old-request" }],
      }),
    ).toEqual({ items: [row] });
  });

  it("uses the original queued request for the updated batch and only tags its verified Codex item", async () => {
    remember("report-a", first, complete);
    remember("report-b", second, approval);
    const controller = new MessageLeadReports({
      dataDir: () => dataDir,
      live: async () => ({ status: "running", executionMode: "codex-managed" }),
      receipt: async () => ({ found: false }),
      control: async () => ({ accepted: true }),
      queue: async () => ({ data: [{ id: "fixture-queued", clientUserMessageId: "report-a" }] }),
    });
    await expect(
      controller.send(lead, "fixture-device", first, () => true, "report-a"),
    ).resolves.toBe(false);
    await expect(
      controller.send(lead, "fixture-device", second, () => true, "report-b"),
    ).resolves.toBe(true);
    const joined = `${first}\n\n${second}`;
    const nativeEvent = user("native-message", joined, "verified-turn");
    const notify = new CodexLeadTurns(dataDir, lead, () => native);
    const notification = (threadId: string) => ({
      method: "item/completed",
      params: {
        threadId,
        turnId: "verified-turn",
        item: { type: "userMessage", id: nativeEvent.id, clientId: "report-a" },
      },
    });
    notify.observe(notification("another-thread"));
    expect(projectWorkerReports(dataDir, lead, nativeEvent)).toEqual(nativeEvent);
    notify.observe(notification(native));
    expect(projectWorkerReports(dataDir, lead, nativeEvent)).toMatchObject({
      worker_reports: { reportId: "report-a", parts: [complete, approval] },
    });
    const copy = user("copied-message", joined, "verified-turn");
    expect(projectWorkerReports(dataDir, lead, copy)).toEqual(copy);
    const sourceEvent = user("dsh:1", joined);
    expect(
      projectWorkerReports(dataDir, lead, { ...sourceEvent, worker_report_request_id: "report-a" }),
    ).toEqual({
      ...sourceEvent,
      worker_reports: { reportId: "report-a", parts: [complete, approval] },
    });
  });
});
