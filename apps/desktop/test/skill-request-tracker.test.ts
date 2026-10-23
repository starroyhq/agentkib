import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createSkillRequestTracker } from "./fixtures/skill-request-tracker";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

it.each([false, true])(
  "finishes a started write before restoring mocks or deleting its fixture (rejects=%s)",
  async (rejects) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "skill-request-cleanup-"));
    folders.push(directory);
    const file = path.join(directory, "result.txt");
    const gate = deferred<void>();
    const failure = new Error("synthetic request failure");
    const events: string[] = [];
    const hooks = { completed: () => events.push("original callback") };
    const mock = vi.spyOn(hooks, "completed").mockImplementation(() => {
      events.push("injected callback");
      return events.length;
    });
    const originalPromise = (async () => {
      await gate.promise;
      await writeFile(file, "synthetic request data");
      hooks.completed();
      if (rejects) throw failure;
      return "request result";
    })();
    const originalRequest = vi.fn(
      (_method: string, _params: Record<string, unknown>) => originalPromise,
    );
    const client = { request: originalRequest };
    const tracker = createSkillRequestTracker();
    tracker.track(client);
    const params = { token: "synthetic token" };
    const returned = client.request("skills.applySync", params);
    expect(returned).toBe(originalPromise);
    expect(originalRequest).toHaveBeenCalledExactlyOnceWith("skills.applySync", params);
    const result = rejects
      ? expect(returned).rejects.toBe(failure)
      : expect(returned).resolves.toBe("request result");
    const teardown = (async () => {
      await tracker.settle();
      events.push(await readFile(file, "utf8"));
      mock.mockRestore();
      events.push("mocks restored");
      await rm(directory, { recursive: true, force: true });
      events.push("fixture deleted");
    })();
    try {
      await Promise.resolve();
      expect(existsSync(directory)).toBe(true);
      expect(events).toEqual([]);
      expect(vi.isMockFunction(hooks.completed)).toBe(true);
    } finally {
      gate.resolve();
      await Promise.all([result, teardown]);
    }
    expect(events).toEqual([
      "injected callback",
      "synthetic request data",
      "mocks restored",
      "fixture deleted",
    ]);
    expect(existsSync(directory)).toBe(false);
  },
);

it("blocks the next body until an abandoned hook's entire cleanup has finished", async () => {
  const tracker = createSkillRequestTracker();
  const bodyGate = deferred<void>();
  const cleanupGate = deferred<void>();
  const drained = deferred<void>();
  const hookDeadline = deferred<void>();
  const timeout = new Error("synthetic hook timeout");
  const events: string[] = [];
  const fixtures = ["first"];
  const hooks = { current: () => "original" };
  vi.spyOn(hooks, "current").mockReturnValue("first");
  const body = tracker.run(async () => {
    await bodyGate.promise;
    events.push("first body finished");
  });
  let cleanup: Promise<void> | undefined;
  let nextBody: Promise<void> | undefined;
  try {
    cleanup = tracker.cleanup(async () => {
      await tracker.settle();
      events.push("first body drained");
      drained.resolve();
      // Cleanup can still be in asynchronous fixture deletion after settle().
      await cleanupGate.promise;
      vi.restoreAllMocks();
      fixtures.splice(0);
      events.push("first cleanup finished");
    });
    const hookWrapper = Promise.race([cleanup, hookDeadline.promise]);
    const rejectedHook = expect(hookWrapper).rejects.toBe(timeout);
    hookDeadline.reject(timeout);
    await rejectedHook;

    nextBody = (async () => {
      await tracker.waitForCleanup();
      await tracker.run(async () => {
        fixtures.push("second");
        vi.spyOn(hooks, "current").mockReturnValue("second");
        events.push("second body started");
      });
    })();
    await nextTurn();
    expect(events).toEqual([]);
    expect(fixtures).toEqual(["first"]);
    expect(hooks.current()).toBe("first");

    bodyGate.resolve();
    await body;
    await drained.promise;
    await nextTurn();
    expect(events).toEqual(["first body finished", "first body drained"]);
    expect(fixtures).toEqual(["first"]);
    expect(hooks.current()).toBe("first");

    cleanupGate.resolve();
    await Promise.all([cleanup, nextBody]);
    expect(events).toEqual([
      "first body finished",
      "first body drained",
      "first cleanup finished",
      "second body started",
    ]);
    expect(fixtures).toEqual(["second"]);
    expect(hooks.current()).toBe("second");
  } finally {
    bodyGate.resolve();
    cleanupGate.resolve();
    await Promise.allSettled([body, cleanup, nextBody]);
  }
});

it("serializes another afterEach even when its beforeEach stopped waiting", async () => {
  const tracker = createSkillRequestTracker();
  const firstGate = deferred<void>();
  const firstStarted = deferred<void>();
  const secondGate = deferred<void>();
  const secondStarted = deferred<void>();
  const beforeDeadline = deferred<void>();
  const timeout = new Error("synthetic beforeEach timeout");
  const events: string[] = [];
  let first: Promise<void> | undefined;
  let second: Promise<void> | undefined;
  let third: Promise<void> | undefined;
  let ready: Promise<void> | undefined;
  try {
    first = tracker.cleanup(async () => {
      events.push("first cleanup started");
      firstStarted.resolve();
      await firstGate.promise;
      events.push("first cleanup finished");
    });
    await firstStarted.promise;
    const beforeWrapper = Promise.race([tracker.waitForCleanup(), beforeDeadline.promise]);
    const rejectedBefore = expect(beforeWrapper).rejects.toBe(timeout);
    beforeDeadline.reject(timeout);
    await rejectedBefore;

    // Vitest still invokes afterEach when beforeEach times out and skips the body.
    second = tracker.cleanup(async () => {
      events.push("second cleanup started");
      secondStarted.resolve();
      await secondGate.promise;
      events.push("second cleanup finished");
    });
    third = tracker.cleanup(async () => {
      events.push("third cleanup finished");
    });
    let nextReady = false;
    ready = tracker.waitForCleanup().then(() => {
      nextReady = true;
    });
    await nextTurn();
    expect(events).toEqual(["first cleanup started"]);
    expect(nextReady).toBe(false);

    firstGate.resolve();
    await first;
    await secondStarted.promise;
    await nextTurn();
    expect(events).toEqual([
      "first cleanup started",
      "first cleanup finished",
      "second cleanup started",
    ]);
    expect(nextReady).toBe(false);

    secondGate.resolve();
    await Promise.all([second, third, ready]);
    expect(events).toEqual([
      "first cleanup started",
      "first cleanup finished",
      "second cleanup started",
      "second cleanup finished",
      "third cleanup finished",
    ]);
    expect(nextReady).toBe(true);
  } finally {
    firstGate.resolve();
    secondGate.resolve();
    await Promise.allSettled([first, second, third, ready]);
  }
});

it("preserves a cleanup rejection for both hooks while allowing queued cleanup to run", async () => {
  const tracker = createSkillRequestTracker();
  const gate = deferred<void>();
  const started = deferred<void>();
  const failure = new Error("synthetic cleanup failure");
  const events: string[] = [];
  let failed: Promise<void> | undefined;
  let queued: Promise<void> | undefined;
  let rejectedCleanup: Promise<unknown> | undefined;
  let rejectedBefore: Promise<unknown> | undefined;
  try {
    failed = tracker.cleanup(async () => {
      events.push("failed cleanup started");
      started.resolve();
      await gate.promise;
      events.push("failed cleanup rejected");
      throw failure;
    });
    rejectedCleanup = expect(failed).rejects.toBe(failure);
    rejectedBefore = expect(tracker.waitForCleanup()).rejects.toBe(failure);
    await started.promise;
    queued = tracker.cleanup(async () => {
      events.push("queued cleanup finished");
    });
    await nextTurn();
    expect(events).toEqual(["failed cleanup started"]);

    gate.resolve();
    await Promise.all([rejectedCleanup, rejectedBefore, queued]);
    await expect(tracker.waitForCleanup()).resolves.toBeUndefined();
    expect(events).toEqual([
      "failed cleanup started",
      "failed cleanup rejected",
      "queued cleanup finished",
    ]);
  } finally {
    gate.resolve();
    await Promise.allSettled([failed, queued, rejectedCleanup, rejectedBefore]);
  }
});

it("returns a synchronous cleanup failure as the original rejected promise result", async () => {
  const tracker = createSkillRequestTracker();
  const failure = new Error("synthetic synchronous cleanup failure");
  const failed = tracker.cleanup(() => {
    throw failure;
  });
  await expect(failed).rejects.toBe(failure);
  await expect(tracker.waitForCleanup()).rejects.toBe(failure);
  const cleanup = vi.fn(async () => undefined);
  await tracker.cleanup(cleanup);
  expect(cleanup).toHaveBeenCalledOnce();
  await expect(tracker.waitForCleanup()).resolves.toBeUndefined();
});

it("also drains a request started by a settling request's continuation", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const tracker = createSkillRequestTracker();
  const client = tracker.track({
    request: (method: string, _params: Record<string, unknown>) =>
      method === "first" ? first.promise : second.promise,
  });
  const request = client.request("first", {}).then(() => client.request("second", {}));
  let settled = false;
  const teardown = tracker.settle().then(() => {
    settled = true;
  });
  try {
    first.resolve();
    await first.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    second.resolve();
    await Promise.all([request, teardown]);
  }
  expect(settled).toBe(true);
});

it.each([false, true])(
  "finishes a test body's nested fixture, bare write and later request before cleanup (rejects=%s)",
  async (rejects) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "skill-body-cleanup-"));
    folders.push(directory);
    const file = path.join(directory, "result.txt");
    const writeGate = deferred<void>();
    const requestGate = deferred<void>();
    const requestStarted = deferred<void>();
    const failure = new Error("synthetic body failure");
    const events: string[] = [];
    const hooks = { completed: () => events.push("original callback") };
    const mock = vi.spyOn(hooks, "completed").mockImplementation(() => {
      events.push("injected callback");
      return events.length;
    });
    const client = {
      request: vi.fn(async () => {
        events.push("request started");
        requestStarted.resolve();
        await requestGate.promise;
        events.push("request finished");
        return "body result";
      }),
    };
    async function prepareFile() {
      await writeGate.promise;
      await writeFile(file, "nested fixture data");
      events.push("file written");
      return file;
    }
    async function fixture() {
      const prepared = await prepareFile();
      await Promise.resolve();
      return { file: prepared };
    }
    const originalPromise = (async () => {
      const prepared = await fixture();
      expect(prepared.file).toBe(file);
      const result = await client.request();
      hooks.completed();
      if (rejects) throw failure;
      return result;
    })();
    const tracker = createSkillRequestTracker();
    const returned = tracker.run(() => originalPromise);
    expect(returned).toBe(originalPromise);
    const result = rejects
      ? expect(returned).rejects.toBe(failure)
      : expect(returned).resolves.toBe("body result");
    const teardown = (async () => {
      await tracker.settle();
      events.push(await readFile(file, "utf8"));
      mock.mockRestore();
      events.push("mocks restored");
      await rm(directory, { recursive: true, force: true });
      events.push("fixture deleted");
    })();
    try {
      await Promise.resolve();
      expect(events).toEqual([]);
      expect(existsSync(directory)).toBe(true);
      expect(vi.isMockFunction(hooks.completed)).toBe(true);
      writeGate.resolve();
      await Promise.race([requestStarted.promise, originalPromise]);
      await Promise.resolve();
      expect(events).toEqual(["file written", "request started"]);
      expect(existsSync(directory)).toBe(true);
      expect(vi.isMockFunction(hooks.completed)).toBe(true);
    } finally {
      writeGate.resolve();
      requestGate.resolve();
      await Promise.all([result, teardown]);
    }
    expect(client.request).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "file written",
      "request started",
      "request finished",
      "injected callback",
      "nested fixture data",
      "mocks restored",
      "fixture deleted",
    ]);
    expect(existsSync(directory)).toBe(false);
  },
);
