import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeManagedRunnerProcess } from "../../../packages/backend/src/agents/claude/claude-managed-runner";

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!["darwin", "linux"].includes(process.platform))("Claude catalog status", () => {
  it("follows protocol transitions without materializing a conversation snapshot", () => {
    const runner = new ClaudeManagedRunnerProcess(tmpdir(), randomUUID(), true, 0, {}, () => {});
    const snapshot = vi.spyOn(runner.state, "snapshot").mockImplementation(() => {
      throw new Error("catalog must not materialize private conversation content");
    });

    expect(runner.status).toBe("idle");
    runner.state.begin("synthetic message");
    expect(runner.status).toBe("running");
    runner.state.fail("synthetic ambiguous outcome");
    expect(runner.status).toBe("outcome-unknown");
    expect(snapshot).not.toHaveBeenCalled();
    expect(runner.hasWorker).toBe(false);
  });

  it("does not read or truncate accumulated response text for repeated catalog reads", () => {
    const runner = new ClaudeManagedRunnerProcess(tmpdir(), randomUUID(), true, 0, {}, () => {});
    runner.state.begin("synthetic message");
    const responseText = vi.fn(() => {
      throw new Error("catalog must not inspect accumulated response text");
    });
    Object.defineProperty(runner.state, "streamText", { get: responseText });

    for (let index = 0; index < 1000; index++) expect(runner.status).toBe("running");
    expect(responseText).not.toHaveBeenCalled();
    expect(runner.hasWorker).toBe(false);
  });
});
