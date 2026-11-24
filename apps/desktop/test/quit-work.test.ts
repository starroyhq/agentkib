// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuitWork } from "../../../packages/backend/src/sessions/quit-work";

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
    candidate: vi.fn(async ({ sessionId }: typeof session) =>
      sessionId === session.sessionId ? { turnId: "interrupted-turn" } : undefined,
    ),
    assignment: vi.fn(() => assignment),
    interrupt: vi.fn<ConstructorParameters<typeof QuitWork>[1]["interrupt"]>(async () => evidence),
    check: vi.fn(async () => true),
    dispatch: vi.fn<ConstructorParameters<typeof QuitWork>[1]["dispatch"]>(async () => "continued"),
    receipt: vi.fn<ConstructorParameters<typeof QuitWork>[1]["receipt"]>(() => "unknown"),
    report: vi.fn(),
  };
  const file = path.join(directory, "quit-work.json");
  return { deps, file, boot: () => new QuitWork(directory, deps) };
}

describe("explicit desktop quit work", () => {
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
    deps.check.mockResolvedValue(false);
    const after = boot();
    after.start();
    await expect(after.list()).resolves.toEqual([]);
    await expect(after.resume(preview.work[0]!.id)).resolves.toEqual({ outcome: "skipped" });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it.each(["continued", "unknown"] as const)(
    "reconciles a claimed continuation as %s from its receipt without replay",
    async (outcome) => {
      const { boot, deps, file } = fixture();
      const before = boot();
      const preview = await before.prepare();
      const id = preview.work[0]!.id;
      await before.stop({ ticket: preview.ticket, resume: true });
      // Simulate process exit after claiming the continuation but before recording its receipt.
      const journal = JSON.parse(readFileSync(file, "utf8"));
      journal.entries[0].phase = "claimed";
      writeFileSync(file, JSON.stringify(journal));
      deps.receipt.mockReturnValue(outcome);
      const after = boot();
      after.start();
      await expect.poll(() => deps.report.mock.calls.length).toBe(1);
      expect(deps.receipt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id }));
      expect(deps.dispatch).not.toHaveBeenCalled();
      expect(await after.list()).toEqual(
        outcome === "unknown"
          ? [expect.objectContaining({ id, status: "unknown", resumable: false })]
          : [],
      );
    },
  );
});
