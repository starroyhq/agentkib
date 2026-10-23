import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
