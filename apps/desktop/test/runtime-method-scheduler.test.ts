import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeMethodScheduler,
  type RuntimeMethodRegistration,
} from "../../../packages/backend/src/runtime-method-scheduler";
import { currentTask } from "../../../packages/backend/src/task-executor";

function read(
  handler: RuntimeMethodRegistration["handler"],
  options: Partial<RuntimeMethodRegistration> = {},
): RuntimeMethodRegistration {
  return { lane: "read", timeoutMs: 30_000, concurrency: 2, trace: "method", handler, ...options };
}

afterEach(() => vi.useRealTimers());

describe("runtime method admission", () => {
  it("joins an identical read before checking capacity and separates methods and reader scopes", async () => {
    const scheduler = new RuntimeMethodScheduler({ limits: { read: 3 } });
    const gate = Promise.withResolvers<string>();
    const handler = vi.fn(() => gate.promise);
    const registration = read(handler, {
      coalesce: {
        key: ({ workspace, readerScope }) => JSON.stringify([workspace, readerScope]),
        until: "settled",
      },
    });
    const params = { workspace: "w", readerScope: "account:a" };
    const first = scheduler.run("workspace.sessions", registration, params);
    const otherReader = scheduler.run("workspace.sessions", registration, {
      ...params,
      readerScope: "account:b",
    });
    const otherMethod = scheduler.run("test.independent", registration, params);
    await expect(
      scheduler.run("workspace.sessions", registration, { workspace: "x" }),
    ).rejects.toMatchObject({
      reason: "queue-full",
    });
    expect(scheduler.run("workspace.sessions", registration, { ...params })).toBe(first);
    expect(otherReader).not.toBe(first);
    expect(otherMethod).not.toBe(first);
    expect(handler).toHaveBeenCalledTimes(3);

    gate.resolve("ready");
    await expect(Promise.all([first, otherReader, otherMethod])).resolves.toEqual([
      "ready",
      "ready",
      "ready",
    ]);
    await expect(scheduler.run("workspace.sessions", registration, params)).resolves.toBe("ready");
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it("starts a fresh read after an earlier handler captured mutable state", async () => {
    const scheduler = new RuntimeMethodScheduler();
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<void>();
    let value = "before mutation";
    const handler = vi.fn(async () => {
      const snapshot = value;
      started.resolve();
      await pending.promise;
      return snapshot;
    });
    const registration = read(handler, { coalesce: { key: () => "same", until: "start" } });
    const first = scheduler.run("read", registration, {});
    expect(scheduler.run("read", registration, {})).toBe(first);
    await started.promise;

    value = "after mutation";
    const latest = scheduler.run("read", registration, {});
    expect(latest).not.toBe(first);
    expect(scheduler.run("read", registration, {})).toBe(latest);
    pending.resolve();
    await expect(Promise.all([first, latest])).resolves.toEqual([
      "before mutation",
      "after mutation",
    ]);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("caps both a method and its lane while independently admitting batches", async () => {
    const scheduler = new RuntimeMethodScheduler({ limits: { read: 2, batch: 1 } });
    const pending = Promise.withResolvers<void>();
    const handler = vi.fn(() => pending.promise);
    const reading = read(handler, { concurrency: 1 });
    const batch = read(handler, { lane: "batch" });
    const r1 = scheduler.run("read.one", reading, {});
    const r2 = scheduler.run("read.two", reading, {});
    const b1 = scheduler.run("batch.one", batch, {});

    await expect(scheduler.run("read.one", reading, {})).rejects.toMatchObject({
      reason: "queue-full",
    });
    await expect(scheduler.run("read.three", reading, {})).rejects.toMatchObject({
      reason: "queue-full",
    });
    await expect(scheduler.run("batch.two", batch, {})).rejects.toMatchObject({
      reason: "queue-full",
    });
    expect(handler).toHaveBeenCalledTimes(3);

    pending.resolve();
    await Promise.all([r1, r2, b1]);
    await scheduler.drain();
    await expect(scheduler.run("batch.two", batch, {})).resolves.toBeUndefined();
  });

  it("releases synchronous success or rejection before admitting another read", async () => {
    const scheduler = new RuntimeMethodScheduler({ limits: { read: 1 } });
    const handler = vi
      .fn()
      .mockReturnValueOnce("prior")
      .mockImplementationOnce(() => {
        throw new Error("invalid request");
      })
      .mockReturnValue("current");
    const registration = read(handler);
    const previous = scheduler.run("read", registration, {});
    const error = scheduler.run("read", registration, {});
    const current = scheduler.run("read", registration, {});
    await expect(previous).resolves.toBe("prior");
    await expect(error).rejects.toThrow("invalid request");
    await expect(current).resolves.toBe("current");
  });

  it("expires a shared read and retains its slot until its late handler settles", async () => {
    vi.useFakeTimers();
    const scheduler = new RuntimeMethodScheduler({ limits: { read: 1 } });
    const pending = Promise.withResolvers<string>();
    const started = Promise.withResolvers<AbortSignal>();
    const registration = read(
      (_params, signal) => {
        expect(currentTask()?.signal).toBe(signal);
        started.resolve(signal);
        return pending.promise;
      },
      { coalesce: { key: () => "same", until: "settled" }, timeoutMs: 50 },
    );
    const reply = scheduler.run("read", registration, {});
    expect(scheduler.run("read", registration, {})).toBe(reply);
    const timeout = expect(reply).rejects.toMatchObject({ reason: "deadline-exceeded" });
    const signal = await started.promise;
    await vi.advanceTimersByTimeAsync(50);
    await timeout;
    expect(signal.reason).toMatchObject({ reason: "deadline-exceeded" });

    const drained = vi.fn();
    const drain = scheduler.drain().then(drained);
    const retry = scheduler.run("read", registration, {});
    expect(retry).not.toBe(reply);
    await expect(retry).rejects.toMatchObject({ reason: "queue-full" });
    expect(drained).not.toHaveBeenCalled();

    pending.reject(new Error("late failure"));
    await drain;
    expect(drained).toHaveBeenCalledOnce();
    await expect(
      scheduler.run(
        "read",
        read(() => "new reply"),
        {},
      ),
    ).resolves.toBe("new reply");
  });

  it("keeps an opted-in batch's real reply and slot after its diagnostic deadline", async () => {
    vi.useFakeTimers();
    const scheduler = new RuntimeMethodScheduler({ limits: { batch: 1 } });
    const pending = Promise.withResolvers<string>();
    const started = Promise.withResolvers<AbortSignal>();
    const batch = read(
      (_params, signal) => {
        expect(currentTask()).toBeUndefined();
        started.resolve(signal);
        return pending.promise;
      },
      {
        lane: "batch",
        coalesce: { key: () => "already single flight", until: "settled" },
        timeoutMs: 50,
      },
    );

    const response = scheduler.run("shared.batch", batch, {});
    expect(scheduler.run("shared.batch", batch, {})).toBe(response);
    const signal = await started.promise;
    await vi.advanceTimersByTimeAsync(50);
    expect(scheduler.run("shared.batch", batch, {})).toBe(response);
    expect(signal.aborted).toBe(false);
    await expect(scheduler.run("other.batch", batch, {})).rejects.toMatchObject({
      reason: "queue-full",
    });

    scheduler.stop();
    const drain = scheduler.drain();
    expect(signal.aborted).toBe(false);
    pending.resolve("committed");
    await expect(response).resolves.toBe("committed");
    await drain;
    expect(budget).toHaveBeenCalledOnce();
  });

  it("stops admission and cancels reads before closing their dependencies", async () => {
    const scheduler = new RuntimeMethodScheduler();
    const pending = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const active = scheduler.run(
      "read",
      read((_params, observed) => {
        signal = observed;
        return pending.promise;
      }),
      {},
    );
    const unstarted = vi.fn();
    const queued = scheduler.run(
      "read",
      read(unstarted, { coalesce: { key: () => "key", until: "start" } }),
      {},
    );
    scheduler.stop();
    await expect(active).rejects.toMatchObject({ reason: "backend-closing" });
    await expect(queued).rejects.toMatchObject({ reason: "backend-closing" });
    await expect(scheduler.run("read", read(unstarted), {})).rejects.toMatchObject({
      reason: "backend-closing",
    });
    expect(signal?.aborted).toBe(true);
    expect(unstarted).not.toHaveBeenCalled();
    const drain = scheduler.drain();
    pending.resolve();
    await drain;
  });

  it("rejects a deferred batch that has yet to start at shutdown", async () => {
    const scheduler = new RuntimeMethodScheduler();
    const handler = vi.fn();
    const batch = read(handler, {
      lane: "batch",
      coalesce: { key: () => "same", until: "settled" },
    });
    const reply = scheduler.run("batch", batch, {});
    scheduler.stop();
    await expect(reply).rejects.toMatchObject({ reason: "backend-closing" });
    await scheduler.drain();
    expect(handler).not.toHaveBeenCalled();
  });
});
