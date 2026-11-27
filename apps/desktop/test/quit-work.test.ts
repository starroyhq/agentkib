// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REMOTE_ERROR_CODES as codes } from "@agentkib/runtime-protocol";
import { QuitWork } from "../../../packages/backend/src/sessions/quit-work";
import { startLocalRuntimeDiagnostics } from "../../../packages/backend/src/local-runtime-activity";
import { localRuntimeTracePaths } from "../../../packages/backend/src/local-runtime-trace";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
} from "../../../packages/backend/src/managed-ledger";
import { resolveQuitWorkReceipt } from "../../../packages/backend/src/sessions/quit-work-sources";
import { restoreClaudeQuitQueue } from "../../../packages/backend/src/sessions/quit-work-trace";

const session = { sessionId: "claude-session", title: "Local Claude", agent: "claude-code" };
const unmanaged = { sessionId: "unsupported", title: "Local ACP", agent: "devin" };
const assignment = { leadId: "project-agent", laneId: "worker" };
const evidence = { nativeId: "native-thread", checkpoint: "known" };

const dirs: string[] = [];
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "agentkib-quit-work-"));
  dirs.push(directory);
  const deps = {
    sessions: vi.fn(async () => [session, unmanaged]),
    resumeByDefault: vi.fn(() => true),
    candidate: vi.fn<ConstructorParameters<typeof QuitWork>[1]["candidate"]>(
      async ({ sessionId }) =>
        sessionId === session.sessionId ? { turnId: "interrupted-turn" } : undefined,
    ),
    assignment: vi.fn(() => assignment),
    interrupt: vi.fn<ConstructorParameters<typeof QuitWork>[1]["interrupt"]>(async () => evidence),
    check: vi.fn<ConstructorParameters<typeof QuitWork>[1]["check"]>(async () => true),
    dispatch: vi.fn<ConstructorParameters<typeof QuitWork>[1]["dispatch"]>(async () => "continued"),
    receipt: vi.fn<ConstructorParameters<typeof QuitWork>[1]["receipt"]>(() => "unknown"),
    report: vi.fn(),
  };
  const file = path.join(directory, "quit-work.json");
  return { deps, file, boot: () => new QuitWork(directory, deps) };
}

function blockJournalWrite(file: string) {
  const original = file + ".saved";
  renameSync(file, original);
  mkdirSync(file);
  return () => {
    rmSync(file, { recursive: true, force: true });
    renameSync(original, file);
  };
}

describe("explicit desktop quit work", () => {
  it("distinguishes a failed candidate read and a broken plan from no active candidates", async () => {
    const { boot, deps } = fixture();
    const runtime = boot();
    deps.candidate.mockRejectedValueOnce(new Error("native error with private contents"));
    await expect(runtime.prepare()).resolves.toMatchObject({
      work: [
        { resumable: false, reason: codes.quitWorkCandidateUnavailable },
        { resumable: false },
      ],
    });
    deps.sessions.mockResolvedValueOnce([]);
    expect(await runtime.prepare()).not.toHaveProperty("reason");
    deps.sessions.mockRejectedValueOnce(new Error("catalog read failed"));
    const failed = await runtime.prepare();
    expect(failed).toMatchObject({ reason: codes.quitWorkPlanUnavailable, work: [] });
    await runtime.stop({ ticket: failed.ticket, resume: true });
    expect(deps.interrupt).not.toHaveBeenCalled();
  });

  it("offers only eligible tasks and continues the confirmed same turn once", async () => {
    const { boot, deps } = fixture();
    const before = boot();
    const preview = await before.prepare();
    expect(preview).toMatchObject({
      resumeByDefault: true,
      work: [
        { title: "Local Claude", agent: "claude-code", resumable: true },
        { title: "Local ACP", agent: "devin", resumable: false },
      ],
    });
    expect(deps.interrupt).not.toHaveBeenCalled();
    await before.stop({ ticket: preview.ticket, resume: true });
    expect(deps.interrupt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: session.sessionId }),
      "interrupted-turn",
    );
    const after = boot();
    after.start();
    await expect.poll(() => deps.report.mock.calls.length).toBe(1);
    expect(deps.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: session.sessionId, id: preview.work[0]!.id, evidence }),
      "The previous turn was interrupted when AgentKib quit. Please continue from where it stopped.",
      expect.any(Function),
    );
    expect(deps.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ turnId: "interrupted-turn" }),
      assignment,
      "continued",
    );
    await after.stop();
    const reopened = boot();
    reopened.start();
    await reopened.stop();
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.report).toHaveBeenCalledTimes(1);
  });

  it("reports the unchecked choice, then allows only one manual continuation", async () => {
    const { boot, deps } = fixture();
    deps.resumeByDefault.mockReturnValue(false);
    const before = boot();
    const preview = await before.prepare();
    expect(preview.resumeByDefault).toBe(false);
    await before.stop({ ticket: preview.ticket, resume: false });
    const after = boot();
    after.start();
    const list = await after.list();
    expect(list).toMatchObject([
      { id: preview.work[0]!.id, status: "interrupted", resumable: true },
    ]);
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ turnId: "interrupted-turn" }),
      assignment,
      "not-continued",
    );
    const id = list[0]!.id;
    await expect(Promise.all([after.resume(id), after.resume(id)])).resolves.toEqual([
      { outcome: "continued" },
      { outcome: "skipped" },
    ]);
    await expect(after.list()).resolves.toEqual([]);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.report).toHaveBeenCalledTimes(1);
  });

  it("enrolls only actual stops tied to the explicit current runtime ticket", async () => {
    const { boot, deps, file } = fixture();
    const before = boot();
    const preview = await before.prepare();
    await before.stop({ ticket: randomUUID(), resume: true });
    expect(deps.interrupt).not.toHaveBeenCalled();
    const newRuntime = boot();
    expect(await newRuntime.list()).toEqual([]);
    await newRuntime.stop({ ticket: preview.ticket, resume: true });
    expect(deps.interrupt).not.toHaveBeenCalled();

    deps.interrupt.mockResolvedValue(undefined);
    const quitting = boot();
    const latest = await quitting.prepare();
    await quitting.stop({ ticket: latest.ticket, resume: true });
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toEqual([]);
    const after = boot();
    after.start();
    await after.stop();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("persists a verified interruption while another task is still stopping", async () => {
    const { boot, deps, file } = fixture();
    const slow = { ...session, sessionId: "slow-session" };
    deps.sessions.mockResolvedValue([session, slow]);
    deps.candidate.mockResolvedValue({ turnId: "interrupted-turn" });
    let confirmSlow!: (value: typeof evidence) => void;
    const slowInterrupt = new Promise<typeof evidence>((resolve) => {
      confirmSlow = resolve;
    });
    deps.interrupt.mockImplementation(async ({ sessionId }) =>
      sessionId === slow.sessionId ? slowInterrupt : evidence,
    );
    const before = boot();
    const preview = await before.prepare();
    const stopping = before.stop({ ticket: preview.ticket, resume: true });
    const saved = () => JSON.parse(readFileSync(file, "utf8")).entries;
    try {
      await expect
        .poll(() => saved())
        .toEqual([expect.objectContaining({ sessionId: session.sessionId, evidence })]);
    } finally {
      confirmSlow(evidence);
      await stopping;
    }
    expect(saved()).toHaveLength(2);
  });

  it("drops manually resumable work that ended or changed owners before restart", async () => {
    const { boot, deps } = fixture();
    const before = boot();
    const preview = await before.prepare();
    await before.stop({ ticket: preview.ticket, resume: false });
    deps.check.mockImplementation(async (_, note) => {
      note(codes.claudeOwnerBusy);
      return false;
    });
    const after = boot();
    after.start();
    await expect(after.list()).resolves.toEqual([]);
    await expect(after.resume(preview.work[0]!.id)).resolves.toEqual({
      outcome: "skipped",
      reason: codes.claudeOwnerBusy,
    });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("records a confirmed interruption even when its quit row is disabled", async () => {
    const { boot, deps } = fixture();
    deps.candidate.mockImplementation(async ({ sessionId }, note) => {
      if (sessionId !== session.sessionId) return;
      note(codes.quitWorkQueueUnconfirmed);
      return { turnId: "interrupted-turn", manualOnly: true };
    });
    deps.check.mockResolvedValue("open-session");
    const before = boot();
    const preview = await before.prepare();
    const { id } = preview.work[0]!;
    expect(preview.work[0]?.resumable).toBe(false);
    await before.stop({ ticket: preview.ticket, resume: true });

    const after = boot();
    after.start();
    const expected = [
      expect.objectContaining({
        id,
        sessionId: session.sessionId,
        status: "interrupted",
        resumable: false,
        openSession: true,
      }),
    ];
    await expect(after.list()).resolves.toEqual(expected);
    await expect(after.resume(id)).resolves.toEqual({
      outcome: "manual-required",
      reason: codes.quitWorkQueueUnconfirmed,
    });
    await after.stop();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id, evidence: { ...evidence, manualOnly: true } }),
      assignment,
      "not-continued",
    );

    const reopened = boot();
    reopened.start();
    await expect(reopened.list()).resolves.toEqual(expected);
    expect(deps.report).toHaveBeenCalledTimes(1);
  });

  it("exposes the manual fallback from an asynchronous startup attempt without replaying it", async () => {
    const { boot, deps } = fixture();
    const dispatch = Promise.withResolvers<"manual-required">();
    deps.dispatch.mockReturnValueOnce(dispatch.promise);
    const before = boot();
    const preview = await before.prepare();
    const { id } = preview.work[0]!;
    await before.stop({ ticket: preview.ticket, resume: true });
    const after = boot();
    after.start();
    const list = after.list();
    dispatch.resolve("manual-required");
    await expect(list).resolves.toEqual([
      expect.objectContaining({ id, status: "interrupted", resumable: false, openSession: true }),
    ]);
    // A provider does not need to honor the UI flag to stop this request.
    await expect(after.resume(id)).resolves.toEqual({
      outcome: "manual-required",
      reason: codes.quitWorkManualRequired,
    });
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id }),
      assignment,
      "not-continued",
    );
  });

  it.each(["continued", "unknown", "manual-required"] as const)(
    "reconciles a claimed continuation as %s from its receipt without replay",
    async (outcome) => {
      const { boot, deps, file } = fixture();
      const before = boot();
      const preview = await before.prepare();
      const id = preview.work[0]!.id;
      await before.stop({ ticket: preview.ticket, resume: true });
      // Simulate process exit after claiming the continuation but before updating the quit journal.
      const journal = JSON.parse(readFileSync(file, "utf8"));
      journal.entries[0].phase = "claimed";
      writeFileSync(file, JSON.stringify(journal));
      deps.receipt.mockReturnValue(outcome);
      const after = boot();
      after.start();
      await expect.poll(() => deps.report.mock.calls.length).toBe(1);
      expect(deps.receipt).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id }),
        expect.any(Function),
      );
      const list = await after.list();
      if (outcome === "manual-required") {
        expect(list).toEqual([
          expect.objectContaining({
            id,
            status: "interrupted",
            resumable: false,
            openSession: true,
          }),
        ]);
        await expect(after.resume(id)).resolves.toEqual({
          outcome,
          reason: codes.quitWorkManualRequired,
        });
        expect(deps.report).toHaveBeenCalledWith(
          expect.objectContaining({ id }),
          assignment,
          "not-continued",
        );
      } else {
        expect(list).toEqual(
          outcome === "unknown"
            ? [expect.objectContaining({ id, status: "unknown", resumable: false })]
            : [],
        );
      }
      expect(deps.dispatch).not.toHaveBeenCalled();
    },
  );

  it("settles a lost reply from the original receipt without another dispatch", async () => {
    const { boot, deps, file } = fixture();
    const before = boot();
    const preview = await before.prepare();
    const { id } = preview.work[0]!;
    await before.stop({ ticket: preview.ticket, resume: false });
    const after = boot();
    after.start();
    deps.dispatch.mockRejectedValueOnce(new Error("response lost"));
    await expect(after.resume(id)).resolves.toEqual({
      outcome: "unknown",
      reason: codes.controlOutcomeUnconfirmed,
    });
    expect(await after.list()).toMatchObject([{ id, status: "unknown", resumable: false }]);
    deps.receipt.mockImplementation((entry, note) => {
      expect(entry.id).toBe(id);
      note(codes.quitWorkQueueRestoreFailed);
      return "continued";
    });
    await expect(Promise.all([after.list(), after.list()])).resolves.toEqual([[], []]);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.report).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toMatchObject([
      { id, phase: "continued", reason: codes.quitWorkQueueRestoreFailed },
    ]);
  });

  it("reconciles a durable claim after the journal write fails and a receipt arrives", async () => {
    const { boot, deps, file } = fixture();
    const before = boot();
    const preview = await before.prepare();
    const { id } = preview.work[0]!;
    await before.stop({ ticket: preview.ticket, resume: false });
    const runtime = boot();
    runtime.start();
    const provider = Promise.withResolvers<"unknown">();
    deps.dispatch.mockReturnValueOnce(provider.promise);
    const active = runtime.resume(id);
    await expect.poll(() => deps.dispatch.mock.calls.length).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toMatchObject([
      { id, phase: "claimed" },
    ]);
    await expect(runtime.list(true)).resolves.toEqual([]);
    expect(deps.receipt).not.toHaveBeenCalled();
    const restore = blockJournalWrite(file);
    try {
      provider.resolve("unknown");
      await expect(active).resolves.toEqual({
        outcome: "unknown",
        reason: codes.controlOutcomeUnconfirmed,
        bookkeepingReason: codes.quitWorkJournalUnavailable,
      });
      await expect(runtime.list()).resolves.toEqual([
        expect.objectContaining({
          id,
          status: "unknown",
          resumable: false,
          reason: codes.controlOutcomeUnconfirmed,
          bookkeepingReason: codes.quitWorkJournalUnavailable,
        }),
      ]);
    } finally {
      restore();
    }
    deps.receipt.mockClear().mockImplementation((entry, note) => {
      expect(entry.id).toBe(id);
      note(codes.quitWorkQueueRestoreFailed);
      return "continued";
    });
    const terminal = [
      expect.objectContaining({
        id,
        sessionId: session.sessionId,
        status: "continued",
        resumable: false,
        openSession: true,
        queueRestoreReason: codes.quitWorkQueueRestoreFailed,
      }),
    ];
    await expect(Promise.all([runtime.list(true), runtime.list(true)])).resolves.toEqual([
      terminal,
      terminal,
    ]);
    await expect(runtime.list()).resolves.toEqual([]);
    expect(deps.receipt).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toMatchObject([
      { id, phase: "continued", reason: codes.quitWorkQueueRestoreFailed },
    ]);
  });

  it("keeps the original accepted receipt when the queue reconciliation itself throws", async () => {
    const { file } = fixture();
    const directory = path.dirname(file);
    const id = randomUUID();
    claimManagedCommand(directory, id, session.sessionId, "fixture", "desktop-local", {
      operation: "send",
      executionMode: "claude-managed",
    });
    dispatchManagedCommand(directory, id);
    finishManagedCommand(directory, id, { accepted: true });
    const note = vi.fn();
    const restore = vi.fn(() => {
      throw new Error("private queue error");
    });
    const trace = startLocalRuntimeDiagnostics(directory);
    try {
      expect(resolveQuitWorkReceipt(directory, { ...session, id }, note, restore)).toBe(
        "continued",
      );
      expect(note).toHaveBeenCalledExactlyOnceWith(codes.quitWorkQueueRestoreFailed);
      expect(restore).toHaveBeenCalledTimes(1);
      expect(
        resolveQuitWorkReceipt(directory, { ...session, id: randomUUID() }, note, restore),
      ).toBe("unknown");
      expect(restore).toHaveBeenCalledTimes(1);
    } finally {
      await trace.close();
    }
    const traceText = readFileSync(localRuntimeTracePaths(directory)[0]!, "utf8");
    expect(traceText).toContain('"stage":"quit-work-queue-restore"');
    expect(traceText).toContain(codes.quitWorkQueueRestoreFailed);
    expect(traceText).not.toContain("private queue error");
    expect(traceText).not.toContain(id);
  });

  it("retains an accepted outcome when the continuation journal cannot be updated", async () => {
    const { boot, deps, file } = fixture();
    const before = boot();
    const preview = await before.prepare();
    const { id } = preview.work[0]!;
    await before.stop({ ticket: preview.ticket, resume: true });
    const runtime = boot();
    let restore: (() => void) | undefined;
    deps.dispatch.mockImplementationOnce(async (_entry, _text, note) => {
      restore = blockJournalWrite(file);
      note(codes.quitWorkQueueRestoreFailed);
      return "continued";
    });
    runtime.start();
    try {
      await expect(runtime.list(true)).resolves.toEqual([
        expect.objectContaining({
          id,
          sessionId: session.sessionId,
          status: "continued",
          resumable: false,
          openSession: true,
          queueRestoreReason: codes.quitWorkQueueRestoreFailed,
          bookkeepingReason: codes.quitWorkJournalUnavailable,
        }),
      ]);
      await expect(runtime.resume(id)).resolves.toEqual({
        outcome: "continued",
        queueRestoreReason: codes.quitWorkQueueRestoreFailed,
        bookkeepingReason: codes.quitWorkJournalUnavailable,
      });
    } finally {
      restore?.();
    }
    const [settled] = await runtime.list(true);
    expect(settled).toMatchObject({
      id,
      status: "continued",
      queueRestoreReason: codes.quitWorkQueueRestoreFailed,
    });
    expect(settled).not.toHaveProperty("bookkeepingReason");
    expect(deps.receipt).not.toHaveBeenCalled();
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.report).toHaveBeenCalledTimes(1);
  });

  it("offers the reason for an automatic refusal only when terminal results are requested", async () => {
    const { boot, deps } = fixture();
    const before = boot();
    const preview = await before.prepare();
    const { id } = preview.work[0]!;
    await before.stop({ ticket: preview.ticket, resume: true });
    deps.dispatch.mockImplementationOnce(async (_entry, _text, note) => {
      note(codes.claudeOwnerBusy);
      return "skipped";
    });
    const runtime = boot();
    runtime.start();
    await expect(runtime.list()).resolves.toEqual([]);
    await expect(runtime.list(true)).resolves.toEqual([
      expect.objectContaining({
        id,
        sessionId: session.sessionId,
        status: "skipped",
        resumable: false,
        reason: codes.claudeOwnerBusy,
      }),
    ]);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps a successful continuation separate from its queue restoration failure", async () => {
    const { boot, deps, file } = fixture();
    const before = boot();
    const preview = await before.prepare();
    const { id } = preview.work[0]!;
    await before.stop({ ticket: preview.ticket, resume: false });
    const after = boot();
    after.start();
    deps.dispatch.mockImplementationOnce(async (_, _text, note) => {
      restoreClaudeQuitQueue(() => {
        throw new Error("private queue failure");
      }, note);
      return "continued";
    });
    const directory = path.dirname(file);
    const trace = startLocalRuntimeDiagnostics(directory);
    try {
      await expect(after.resume(id)).resolves.toEqual({
        outcome: "continued",
        queueRestoreReason: codes.quitWorkQueueRestoreFailed,
      });
    } finally {
      await trace.close();
    }
    await expect(after.resume(id)).resolves.toEqual({ outcome: "skipped" });
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    const traceText = readFileSync(localRuntimeTracePaths(directory)[0]!, "utf8");
    const requests = traceText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(({ method }) => method === "quitWork.resume");
    expect(requests).toEqual([
      expect.objectContaining({
        stage: "quit-work-queue-restore",
        outcome: "failed",
        reason: codes.quitWorkQueueRestoreFailed,
      }),
      expect.objectContaining({ stage: "quit-work-dispatch", outcome: "accepted" }),
    ]);
    expect(traceText).not.toMatch(/private queue failure|claude-session|native-thread/);
    expect(traceText).not.toContain(id);
  });
});
