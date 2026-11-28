import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { app, Notification, shell } from "electron";
import type { DesktopNotificationPermission } from "@agentkib/runtime-protocol";
import type * as Koffi from "koffi";

type SessionNotice = { sessionId: string; title: string; body: string; silent: boolean };
type Card = {
  notification: Notification;
  posted: Promise<boolean>;
  displayed: boolean;
  removal?: Promise<void>;
};

const groupId = "agentkib-sessions";

function macNotificationCenter() {
  if (!app.isPackaged) return undefined;
  // Both native libraries are staged next to the main script and must load from disk.
  const root = path.join(
    app.getAppPath().replace(/app\.asar$/, "app.asar.unpacked"),
    "dist-electron",
  );
  const native = path.join(root, "native");
  const require = createRequire(path.join(root, "main.cjs"));
  try {
    const koffi = require(path.join(native, "koffi")) as typeof Koffi;
    const library = koffi.load(path.join(native, "desktop-notifications.dylib"));
    const permission = library.func("agentkib_notification_permission", "int", [
      "int",
    ]) as Koffi.KoffiFunc<(request: number) => number>;
    const remove = library.func("agentkib_remove_notification", "void", ["str"]);
    return {
      permission(request: boolean): Promise<DesktopNotificationPermission> {
        return new Promise((resolve) => {
          permission.async(Number(request), (error, status) => {
            if (error) resolve("unknown");
            else if (status === 0) resolve("not-determined");
            else if (status === 1) resolve("denied");
            else if ([2, 3, 4].includes(status)) resolve("authorized");
            else resolve("unknown");
          });
        });
      },
      remove: (id: string) => remove(id),
    };
  } catch {
    // Unsigned or incomplete bundles cannot use the macOS notification service.
    return undefined;
  }
}

function notificationId(sessionId: string) {
  // Windows toast tags allow up to 64 characters; provider IDs can be longer.
  return createHash("sha256").update(sessionId).digest("hex");
}

export function createDesktopNotificationPlatform(onClick: (sessionId: string) => void) {
  const mac = process.platform === "darwin";
  const windows = process.platform === "win32";
  if (windows && app.isPackaged && !process.windowsStore) app.setAppUserModelId("ai.agentkib");
  // On macOS, even Electron's isSupported() initializes the presenter and requests authorization.
  const center = mac ? macNotificationCenter() : undefined;
  const supported = mac ? !!center : Notification.isSupported();

  const cards = new Map<string, Card>();
  let closed = false;
  let authorization: Promise<DesktopNotificationPermission> | undefined;

  const status = async (): Promise<DesktopNotificationPermission> => {
    if (!supported) return "unsupported";
    return center ? center.permission(false) : "unknown";
  };

  const dismiss = async (sessionId: string): Promise<void> => {
    const card = cards.get(sessionId);
    const id = notificationId(sessionId);
    center?.remove(id);
    if (!card) return;
    card.removal ??= (async () => {
      // Electron schedules Windows toasts asynchronously. Let that finish before
      // closing the retained object, which also removes it from Action Center.
      if (!card.displayed) await card.posted;
      center?.remove(id);
      card.notification.close();
      if (cards.get(sessionId) === card) cards.delete(sessionId);
    })();
    await card.removal;
  };

  return {
    status,
    requestPermission(): Promise<DesktopNotificationPermission> {
      if (!center) return status();
      authorization ??= center.permission(true).finally(() => {
        authorization = undefined;
      });
      return authorization;
    },
    async openSettings(): Promise<void> {
      if (mac)
        await shell.openExternal(
          "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
        );
      else if (windows) await shell.openExternal("ms-settings:notifications");
    },
    async show({ sessionId, title, body, silent }: SessionNotice, canShow = () => true) {
      if (closed || !supported || (center && (await status()) !== "authorized")) return false;
      if (cards.has(sessionId)) await dismiss(sessionId);
      if (closed || cards.has(sessionId) || !canShow()) return false;
      const notification = new Notification({
        id: notificationId(sessionId),
        groupId,
        title,
        body,
        silent,
      });
      let resolve!: (shown: boolean) => void;
      const posted = new Promise<boolean>((complete) => {
        resolve = complete;
      });
      const card: Card = { notification, posted, displayed: false };
      cards.set(sessionId, card);
      const finish = (shown: boolean) => {
        clearTimeout(timer);
        resolve(shown);
      };
      const timer = setTimeout(() => finish(false), 5_000);
      timer.unref();
      notification.once("show", () => {
        card.displayed = true;
        finish(true);
      });
      notification.once("failed", () => finish(false));
      notification.once("click", () => {
        if (closed || card.removal || cards.get(sessionId) !== card) return;
        void dismiss(sessionId);
        onClick(sessionId);
      });
      notification.show();
      const shown = await posted;
      if (!shown) await dismiss(sessionId);
      return shown && !card.removal;
    },
    dismiss,
    close(): void {
      closed = true;
      for (const sessionId of cards.keys()) void dismiss(sessionId);
    },
  };
}
