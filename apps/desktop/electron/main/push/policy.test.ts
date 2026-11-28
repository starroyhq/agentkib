// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { notificationDelivery, notificationPolicyVersion, NotificationPolicyStore } from "./policy";

const authorized = () => undefined;
const localTime = (hour: number, minute = 0, day = 29) =>
  new Date(2026, 10, day, hour, minute).getTime();

// Frozen v0.36.4 disk reader schema, including strict nested keys.
const v1LocalTime = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/);
const legacyStoredPolicy = z.strictObject({
  version: z.literal(1),
  policy: z.strictObject({
    enabled: z.boolean(),
    categories: z.strictObject({
      approval: z.boolean(),
      question: z.boolean(),
      completed: z.boolean(),
      failed: z.boolean(),
    }),
    onlyAway: z.boolean(),
    quietHours: z
      .strictObject({ start: v1LocalTime, end: v1LocalTime })
      .refine(({ start, end }) => start !== end)
      .nullable(),
  }),
});

describe("host notification policy", () => {
  let directory: string;
  let store: NotificationPolicyStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agentkib-test-notification-policy-"));
    store = new NotificationPolicyStore(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("advertises the new capability only when the client requests the supported version", () => {
    const access = new URL("https://example.test/api/web/v1/access");
    expect(notificationPolicyVersion(access)).toBe(1);
    access.searchParams.set("pushPolicyVersion", "3");
    expect(notificationPolicyVersion(access)).toBe(1);
    access.searchParams.set("pushPolicyVersion", "2");
    expect(notificationPolicyVersion(access)).toBe(2);
  });

  it("keeps legacy alerts enabled and away-only if the host has no saved policy", async () => {
    await store.initialize();
    expect(store.read()).toEqual({
      enabled: true,
      categories: { approval: true, question: true, completed: true, failed: true },
      onlyAway: true,
      quietHours: null,
      workerResults: false,
    });
    expect(store.delivery("approval", true)).toBe("hold");
    expect(store.delivery("approval", false)).toBe("send");
    expect(store.allowsActivityStart()).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  it("persists one computer's policy across restarts and preserves concurrent partial edits", async () => {
    const first = store.update({ enabled: false, categories: { approval: false } }, authorized);
    const second = store.update({ onlyAway: false, categories: { completed: false } }, authorized);
    await Promise.all([first, second]);
    const reloaded = new NotificationPolicyStore(directory);
    await reloaded.initialize();
    expect(reloaded.read()).toEqual({
      enabled: false,
      categories: { approval: false, question: true, completed: false, failed: true },
      onlyAway: false,
      quietHours: null,
      workerResults: false,
    });
    expect(await readdir(directory)).toEqual(["notification-policy.json"]);
    if (process.platform !== "win32")
      expect((await stat(join(directory, "notification-policy.json"))).mode & 0o077).toBe(0);
    const detached = reloaded.read();
    detached.categories.approval = true;
    expect(reloaded.read().categories.approval).toBe(false);
  });

  it("defaults legacy policies to off and keeps the opt-in across restart and old patches", async () => {
    const file = join(directory, "notification-policy.json");
    const workerFile = join(directory, "notification-worker-results.json");
    const previousPolicy = {
      enabled: true,
      categories: { approval: true, question: false, completed: true, failed: true },
      onlyAway: false,
      quietHours: null,
    };
    const saved = JSON.stringify({ version: 1, policy: previousPolicy });
    await writeFile(file, saved);
    await store.initialize();
    expect(store.read()).toEqual({ ...previousPolicy, workerResults: false });
    expect(await readFile(file, "utf8")).toBe(saved);

    await store.update({ workerResults: true }, authorized);
    expect(await readFile(file, "utf8")).toBe(saved);
    expect(JSON.parse(await readFile(workerFile, "utf8"))).toEqual({
      version: 1,
      workerResults: true,
    });
    if (process.platform !== "win32") expect((await stat(workerFile)).mode & 0o077).toBe(0);
    const reloaded = new NotificationPolicyStore(directory);
    await reloaded.initialize();
    expect(reloaded.read()).toEqual({ ...previousPolicy, workerResults: true });
    await expect(
      reloaded.update({ categories: { failed: false } }, authorized),
    ).resolves.toMatchObject({
      workerResults: true,
      categories: { failed: false },
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      policy: { ...previousPolicy, categories: { ...previousPolicy.categories, failed: false } },
    });

    await expect(reloaded.update({ workerResults: false }, authorized)).resolves.toMatchObject({
      workerResults: false,
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      policy: { ...previousPolicy, categories: { ...previousPolicy.categories, failed: false } },
    });
    expect(JSON.parse(await readFile(workerFile, "utf8"))).toEqual({
      version: 1,
      workerResults: false,
    });
  });

  it("can downgrade to the strict v0.36.4 reader and re-upgrade after editing its shared policy", async () => {
    const file = join(directory, "notification-policy.json");
    const policy = await store.update(
      {
        onlyAway: false,
        categories: { question: false },
        quietHours: { start: "22:00", end: "08:00" },
        workerResults: true,
      },
      authorized,
    );
    expect(policy.workerResults).toBe(true);

    const old = legacyStoredPolicy.parse(JSON.parse(await readFile(file, "utf8")));
    expect(notificationDelivery(old.policy, "approval", true, localTime(12))).toBe("send");
    expect(notificationDelivery(old.policy, "approval", false, localTime(23))).toBe("hold");
    expect(notificationDelivery(old.policy, "question", false, localTime(12))).toBe("drop");
    old.policy.categories.completed = false;
    await writeFile(file, JSON.stringify(old));

    const upgraded = new NotificationPolicyStore(directory);
    await upgraded.initialize();
    expect(upgraded.read()).toEqual({ ...old.policy, workerResults: true });
  });

  it.each(['{"version":2,"workerResults":true}', "{"])(
    "defaults only the Worker opt-in when its file is unreadable (%s)",
    async (contents) => {
      const policy = await store.update(
        { categories: { question: false }, onlyAway: false },
        authorized,
      );
      await writeFile(join(directory, "notification-worker-results.json"), contents);
      const reloaded = new NotificationPolicyStore(directory);
      await reloaded.initialize();
      expect(reloaded.read()).toEqual(policy);
      expect(reloaded.delivery("approval", true)).toBe("send");
    },
  );

  it("restores the previous Worker setting if the main file of a mixed patch cannot be replaced", async () => {
    await store.update({ workerResults: true }, authorized);
    const worker = join(directory, "notification-worker-results.json");
    const before = await readFile(worker, "utf8");
    await mkdir(join(directory, "notification-policy.json"));
    await expect(
      store.update({ enabled: false, workerResults: false }, authorized),
    ).rejects.toThrow("notification_policy_unavailable");
    expect(store.read()).toMatchObject({ enabled: true, workerResults: true });
    expect(await readFile(worker, "utf8")).toBe(before);
    expect((await readdir(directory)).sort()).toEqual([
      "notification-policy.json",
      "notification-worker-results.json",
    ]);
  });

  it("does not leave an enabled Worker sidecar if authorization changes during a mixed patch", async () => {
    const baseline = await store.update({ onlyAway: false }, authorized);
    const file = join(directory, "notification-policy.json");
    const before = await readFile(file, "utf8");
    const revoked = new Error("access_ended");
    const authorize = vi.fn(authorized).mockImplementationOnce(authorized);
    authorize.mockImplementationOnce(() => {
      throw revoked;
    });
    await expect(store.update({ enabled: false, workerResults: true }, authorize)).rejects.toBe(
      revoked,
    );
    expect(store.read()).toEqual(baseline);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readdir(directory)).toEqual(["notification-policy.json"]);
  });

  it("drops globally or categorically disabled alerts, including verification and delegation", async () => {
    await store.update({ categories: { approval: false, question: false } }, authorized);
    expect(store.delivery("approval", true)).toBe("drop");
    expect(store.delivery("question", false)).toBe("drop");
    expect(store.delivery("verify", false)).toBe("drop");
    expect(store.delivery("delegation", false)).toBe("drop");
    expect(store.delivery("completed", false)).toBe("send");
    expect(store.delivery("failed", false)).toBe("send");
    await store.update({ enabled: false }, authorized);
    expect(store.delivery("completed", false)).toBe("drop");
    expect(store.delivery("failed", false)).toBe("drop");
    expect(store.allowsActivityStart()).toBe(false);
  });

  it("applies host-local quiet hours across midnight and lets the owner turn them off", async () => {
    await store.update({ quietHours: { start: "22:00", end: "08:00" } }, authorized);
    expect(store.delivery("approval", false, localTime(21, 59))).toBe("send");
    expect(store.delivery("approval", false, localTime(22))).toBe("hold");
    expect(store.delivery("approval", false, localTime(0, 0, 30))).toBe("hold");
    expect(store.delivery("approval", false, localTime(7, 59, 30))).toBe("hold");
    expect(store.delivery("approval", false, localTime(8, 0, 30))).toBe("send");
    expect(store.allowsActivityStart(localTime(22))).toBe(false);
    expect(store.allowsActivityStart(localTime(8, 0, 30))).toBe(true);
    await store.update({ quietHours: null, onlyAway: false }, authorized);
    expect(store.delivery("approval", true, localTime(23))).toBe("send");
  });

  it("observes a quiet period within a day even when away-only delivery is disabled", async () => {
    await store.update(
      { onlyAway: false, quietHours: { start: "09:30", end: "17:00" } },
      authorized,
    );
    expect(store.delivery("failed", true, localTime(9, 29))).toBe("send");
    expect(store.delivery("failed", false, localTime(9, 30))).toBe("hold");
    expect(store.delivery("failed", true, localTime(16, 59))).toBe("hold");
    expect(store.delivery("failed", true, localTime(17))).toBe("send");
  });

  it.each([
    { enabled: "false" },
    { workerResults: "true" },
    { workerResults: null },
    { categories: { other: false } },
    { quietHours: { start: "24:00", end: "08:00" } },
    { quietHours: { start: "09:00", end: "09:00" } },
    { quietHours: { start: "09:00" } },
    { unrecognized: true },
  ])("rejects malformed settings without authorizing or writing (%j)", async (patch) => {
    const authorize = vi.fn();
    await expect(store.update(patch, authorize)).rejects.toThrow("invalid_notification_policy");
    expect(authorize).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not apply or publish a write after device authorization is revoked", async () => {
    await store.update({ onlyAway: false }, authorized);
    const file = join(directory, "notification-policy.json");
    const before = await readFile(file, "utf8");
    const expired = new Error("access_ended");
    const authorize = vi.fn(async () => {
      // The recheck is immediately before the temp policy would replace the committed policy.
      expect(await readFile(file, "utf8")).toBe(before);
      throw expired;
    });
    await expect(store.update({ enabled: false }, authorize)).rejects.toBe(expired);
    expect(authorize).toHaveBeenCalledOnce();
    expect(store.read().enabled).toBe(true);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readdir(directory)).toEqual(["notification-policy.json"]);
    await expect(store.update({ enabled: false }, authorized)).resolves.toMatchObject({
      enabled: false,
      onlyAway: false,
    });
  });

  it("does not update the active policy if the atomic replacement fails", async () => {
    await store.initialize();
    await mkdir(join(directory, "notification-policy.json"));
    await expect(store.update({ enabled: false }, authorized)).rejects.toThrow(
      "notification_policy_unavailable",
    );
    expect(store.read().enabled).toBe(true);
    expect(await readdir(directory)).toEqual(["notification-policy.json"]);
  });

  it("suppresses delivery for an unreadable saved policy until an authorized update repairs it", async () => {
    const file = join(directory, "notification-policy.json");
    await writeFile(file, '{"version":1,"policy":');
    await store.initialize();
    expect(store.delivery("approval", false)).toBe("drop");
    expect(await readFile(file, "utf8")).toBe('{"version":1,"policy":');
    await store.update({ enabled: true }, authorized);
    expect(store.delivery("approval", false)).toBe("send");
  });
});
