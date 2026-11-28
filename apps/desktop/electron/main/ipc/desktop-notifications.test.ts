// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationPolicyStore } from "../push/policy";
import type { TrustedIpcHandler } from "./registrar";
import { registerDesktopNotificationsIpc } from "./desktop-notifications";

const frame = {};
const event = { sender: { mainFrame: frame }, senderFrame: frame } as IpcMainInvokeEvent;
const invoke = (operation: string, ...args: unknown[]) =>
  handlers.get(`agentkib:notifications:${operation}`)!(event, ...args);
const handlers = new Map<string, TrustedIpcHandler>();
const platform = {
  status: vi.fn(),
  requestPermission: vi.fn(),
  openSettings: vi.fn(),
};
const onChanged = vi.fn();
const onSessionObserved = vi.fn();
let directory: string;

beforeEach(async () => {
  vi.resetAllMocks();
  handlers.clear();
  directory = await mkdtemp(join(tmpdir(), "agentkib-test-desktop-notifications-ipc-"));
  const policy = new NotificationPolicyStore(directory);
  await policy.initialize();
  platform.status.mockResolvedValue("not-determined");
  platform.requestPermission.mockResolvedValue("denied");
  registerDesktopNotificationsIpc((name, callback) => handlers.set(name, callback), {
    policy,
    platform,
    onChanged,
    onSessionObserved,
  });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("keeps the local toggle saved while displaying the current system permission", async () => {
  await expect(invoke("status")).resolves.toMatchObject({
    desktopEnabled: false,
    permission: "not-determined",
    policy: { enabled: true, workerResults: false },
  });
  expect(platform.requestPermission).not.toHaveBeenCalled();
  await expect(invoke("update", { desktopEnabled: true })).resolves.toMatchObject({
    desktopEnabled: true,
    permission: "not-determined",
  });
  await expect(invoke("request-permission")).resolves.toMatchObject({
    desktopEnabled: true,
    permission: "denied",
  });
  await invoke("open-settings");
  expect(platform.openSettings).toHaveBeenCalledOnce();
  platform.status.mockResolvedValue("authorized");
  await expect(invoke("status")).resolves.toMatchObject({
    desktopEnabled: true,
    permission: "authorized",
  });
  expect(onChanged).toHaveBeenCalledTimes(2);
});

it("supports a shared row edit locally and rejects attempts to combine the desktop and mobile writes", async () => {
  await expect(invoke("update", { desktopEnabled: true, enabled: false })).rejects.toThrow(
    "invalid_notification_policy",
  );
  expect(onChanged).not.toHaveBeenCalled();
  await expect(invoke("update", { categories: { approval: false } })).resolves.toMatchObject({
    desktopEnabled: false,
    policy: { enabled: true, categories: { approval: false, question: true } },
  });
  expect(onChanged).toHaveBeenCalledOnce();
});

it("reports bounded session identities only from a main frame", () => {
  const observe = handlers.get("agentkib:notifications:observe-session")!;
  expect(() => observe({ ...event, senderFrame: {} } as IpcMainInvokeEvent, "session")).toThrow(
    "Desktop notifications require the main frame",
  );
  expect(() => invoke("observe-session", "s".repeat(257))).toThrow();
  expect(onSessionObserved).not.toHaveBeenCalled();
  invoke("observe-session", "session");
  invoke("observe-session", null);
  expect(onSessionObserved.mock.calls).toEqual([
    [event, "session"],
    [event, null],
  ]);
});
