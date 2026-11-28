import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadStateProbe } from "../../../../../packages/session-ui/src/read-state-probe";

type Read = Parameters<typeof createReadStateProbe>[0]["read"];
type Result = Awaited<ReturnType<Read>>;
const readRetryDelays = [400, 800, 1600, 3200, 6400, 8000, 8000, 8000, 8000, 8000, 8000];

function heldRead() {
  let complete!: (result: Result) => void;
  const promise = new Promise<Result>((resolve) => {
    complete = resolve;
  });
  return { promise, complete };
}

const probes: ReturnType<typeof createReadStateProbe>[] = [];

function fixture(read: Read, canRetry = () => true) {
  const probe = createReadStateProbe({ canRead: () => true, canRetry, read });
  probes.push(probe);
  return probe;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  for (const probe of probes.splice(0)) probe.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("read-state probe scheduling", () => {
  it("coalesces ordinary invalidations into a single pass after the active read and reuse window", async () => {
    const pending = heldRead();
    const read = vi.fn<Read>().mockResolvedValue("ready").mockReturnValueOnce(pending.promise);
    const probe = fixture(read);
    probe.refresh();
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledOnce();

    for (let event = 0; event < 20; event++) {
      probe.refresh();
      probe.schedule();
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledOnce();

    pending.complete("ready");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(349);
    expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("exhausts eleven autonomous read attempts despite continuing viewport wakes", async () => {
    const read = vi.fn<Read>().mockResolvedValue("retry");
    const probe = fixture(read);
    probe.refresh();
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledOnce();

    for (const [index, delay] of readRetryDelays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      probe.schedule();
      expect(read).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(index + 2);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    probe.schedule();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(12);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let successful evidence reads refill the refused-update retry budget", async () => {
    const read = vi.fn<Read>().mockResolvedValue("ready");
    const probe = fixture(read);

    for (const [index, delay] of readRetryDelays.entries()) {
      probe.retryUpdate();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(read).toHaveBeenCalledTimes(index);
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(index + 1);
    }
    probe.retryUpdate();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(11);
    expect(vi.getTimerCount()).toBe(0);

    probe.updateCompleted();
    probe.retryUpdate();
    await vi.advanceTimersByTimeAsync(400);
    expect(read).toHaveBeenCalledTimes(12);
  });

  it("limits autonomous unknown-receipt readback to three attempts", async () => {
    const read = vi.fn<Read>().mockResolvedValue("reconcile");
    const probe = fixture(read);
    probe.retryReconcile();

    for (const [index, delay] of [400, 800, 1600].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      probe.schedule();
      expect(read).toHaveBeenCalledTimes(index);
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(index + 1);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    probe.schedule();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.every(([, retrying]) => retrying)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start an overdue automatic retry after a paused window expires", async () => {
    let atBottom = true;
    const read = vi.fn<Read>().mockResolvedValueOnce("retry").mockResolvedValue("ready");
    const probe = fixture(read, () => atBottom);
    probe.refresh();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(399);

    atBottom = false;
    probe.schedule();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(read).toHaveBeenCalledTimes(1);

    atBottom = true;
    probe.schedule();
    await vi.advanceTimersByTimeAsync(8000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // A real invalidation can still trigger one ordinary observation after exhaustion.
    probe.refresh();
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(expect.anything(), false);
  });

  it("aborts an automatic retry that is already reading and waits for the transport to settle", async () => {
    let atBottom = true;
    const pending = heldRead();
    const read = vi
      .fn<Read>()
      .mockResolvedValue("ready")
      .mockResolvedValueOnce("retry")
      .mockReturnValueOnce(pending.promise);
    const probe = fixture(read, () => atBottom);
    probe.refresh();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(400);
    expect(read).toHaveBeenCalledTimes(2);
    const [retrySignal] = read.mock.calls[1];
    expect(retrySignal.aborted).toBe(false);

    atBottom = false;
    probe.schedule();
    expect(retrySignal.aborted).toBe(true);
    probe.refresh();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(2);

    // Some transports do not cancel an IPC already processing. Its late result is discarded.
    pending.complete("retry");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(350);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls[2][0].aborted).toBe(false);
    atBottom = true;
    probe.schedule();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("will not rearm after its scope closes while a retry is in flight", async () => {
    const pending = heldRead();
    const read = vi.fn<Read>().mockResolvedValueOnce("retry").mockReturnValueOnce(pending.promise);
    const probe = fixture(read);
    probe.refresh();
    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenCalledTimes(2);

    const [retrySignal] = read.mock.calls[1];
    probe.close();
    expect(retrySignal.aborted).toBe(true);
    pending.complete("retry");
    probe.refresh();
    probe.schedule();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
