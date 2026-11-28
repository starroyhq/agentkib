import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopNotificationPlatform } from "./desktop-notification-platform";

const fakes = vi.hoisted(() => ({
  permissions: vi.fn(),
  remove: vi.fn(),
  supported: vi.fn(),
  openExternal: vi.fn(),
  setAppUserModelId: vi.fn(),
  cards: [] as Array<{
    options: Record<string, unknown>;
    show: () => void;
    close: () => void;
    emit: (event: string, ...args: unknown[]) => boolean;
  }>,
}));

vi.mock("node:module", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:module")>()),
  createRequire: () => () => ({
    load: () => ({
      func: (name: string) =>
        name === "agentkib_notification_permission" ? { async: fakes.permissions } : fakes.remove,
    }),
  }),
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: {
      isPackaged: true,
      getAppPath: () => "/fixture/app.asar",
      setAppUserModelId: fakes.setAppUserModelId,
    },
    Notification: class extends EventEmitter {
      static isSupported = fakes.supported;
      show = vi.fn();
      close = vi.fn();

      constructor(readonly options: Record<string, unknown>) {
        super();
        fakes.cards.push(this);
      }
    },
    shell: { openExternal: fakes.openExternal },
  };
});

const actualPlatform = process.platform;
function platform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value });
}

const notice = { sessionId: "session", title: "Session", body: "Completed", silent: false };

beforeEach(() => {
  vi.clearAllMocks();
  fakes.cards.length = 0;
  fakes.supported.mockReturnValue(true);
});
afterEach(() => platform(actualPlatform));

describe("desktop notification platform", () => {
  it("reads macOS permission without starting Electron's permission prompt", async () => {
    platform("darwin");
    fakes.permissions.mockImplementation((_ask, done) => done(null, 0));
    const adapter = createDesktopNotificationPlatform(vi.fn());
    await expect(adapter.status()).resolves.toBe("not-determined");
    expect(fakes.permissions).toHaveBeenCalledWith(0, expect.any(Function));
    expect(fakes.supported).not.toHaveBeenCalled();
    await expect(adapter.show(notice)).resolves.toBe(false);
    expect(fakes.cards).toHaveLength(0);

    fakes.permissions.mockImplementation((_ask, done) => done(null, 1));
    await expect(adapter.requestPermission()).resolves.toBe("denied");
    expect(fakes.permissions).toHaveBeenLastCalledWith(1, expect.any(Function));
    await adapter.openSettings();
    expect(fakes.openExternal).toHaveBeenCalledOnce();
  });

  it("rechecks visibility and can withdraw a delivered macOS card by session ID", async () => {
    platform("darwin");
    fakes.permissions.mockImplementation((_ask, done) => done(null, 2));
    const adapter = createDesktopNotificationPlatform(vi.fn());
    await expect(adapter.show(notice, () => false)).resolves.toBe(false);
    expect(fakes.cards).toHaveLength(0);
    // Removal needs only a session ID, including cards persisted by the OS.
    await adapter.dismiss(notice.sessionId);
    expect(fakes.remove).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  it("keeps one card per session and opens precisely that session on click", async () => {
    platform("linux");
    const onClick = vi.fn();
    const adapter = createDesktopNotificationPlatform(onClick);
    await expect(adapter.status()).resolves.toBe("unknown");
    const first = adapter.show(notice);
    fakes.cards[0]!.emit("show");
    await expect(first).resolves.toBe(true);
    await adapter.dismiss(notice.sessionId);

    const next = adapter.show({ ...notice, body: "Failed" });
    fakes.cards[1]!.emit("show");
    await expect(next).resolves.toBe(true);
    expect(fakes.cards[1]!.options.id).toBe(fakes.cards[0]!.options.id);
    expect(fakes.cards[0]!.close).toHaveBeenCalledOnce();
    expect(fakes.cards[1]!.options).toEqual({
      id: expect.any(String),
      groupId: "agentkib-sessions",
      title: "Session",
      body: "Failed",
      silent: false,
    });
    fakes.cards[0]!.emit("click");
    fakes.cards[1]!.emit("click");
    expect(onClick).toHaveBeenCalledExactlyOnceWith(notice.sessionId);
    expect(fakes.cards[1]!.close).toHaveBeenCalledOnce();
  });

  it("withdraws a Windows card even if its OS delivery is still in progress", async () => {
    platform("win32");
    const adapter = createDesktopNotificationPlatform(vi.fn());
    const pending = adapter.show(notice);
    const card = fakes.cards[0]!;
    const withdrawn = adapter.dismiss(notice.sessionId);
    expect(card.close).not.toHaveBeenCalled();
    card.emit("show");
    await withdrawn;
    await expect(pending).resolves.toBe(false);
    expect(card.close).toHaveBeenCalledOnce();
  });
});
