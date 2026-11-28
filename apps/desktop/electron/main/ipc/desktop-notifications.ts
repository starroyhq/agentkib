import {
  type DesktopNotificationPermission,
  type DesktopNotificationSettings,
} from "@agentkib/runtime-protocol";
import type { IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { NotificationPolicyStore } from "../push/policy";
import type { IpcRegistrar } from "./registrar";

interface DesktopNotificationsIpcOptions {
  policy: NotificationPolicyStore;
  platform: {
    status(): Promise<DesktopNotificationPermission>;
    requestPermission(): Promise<DesktopNotificationPermission>;
    openSettings(): Promise<void>;
  };
  onChanged(): void;
  onSessionObserved(event: IpcMainInvokeEvent, sessionId: string | null): void;
}

const desktopToggle = z.strictObject({ desktopEnabled: z.boolean() });
const sessionId = z.string().min(1).max(256).nullable();

export function registerDesktopNotificationsIpc(
  register: IpcRegistrar["handle"],
  { policy, platform, onChanged, onSessionObserved }: DesktopNotificationsIpcOptions,
): void {
  const handle: IpcRegistrar["handle"] = (channel, callback) =>
    register(channel, (event, ...args) => {
      if (event.senderFrame !== event.sender.mainFrame)
        throw new Error("Desktop notifications require the main frame");
      return callback(event, ...args);
    });
  const status = (permission: DesktopNotificationPermission): DesktopNotificationSettings => ({
    desktopEnabled: policy.desktopEnabled(),
    policy: policy.read(),
    permission,
  });

  handle("agentkib:notifications:status", async () => status(await platform.status()));
  handle("agentkib:notifications:update", async (_event, patch: unknown) => {
    const toggle = desktopToggle.safeParse(patch);
    if (toggle.success) {
      await policy.setDesktopEnabled(toggle.data.desktopEnabled);
    } else {
      await policy.update(patch, () => {});
    }
    onChanged();
    return status(await platform.status());
  });
  handle("agentkib:notifications:request-permission", async () => {
    const permission = await platform.requestPermission();
    onChanged();
    return status(permission);
  });
  handle("agentkib:notifications:open-settings", () => platform.openSettings());
  handle("agentkib:notifications:observe-session", (event, value: unknown) =>
    onSessionObserved(event, sessionId.parse(value)),
  );
}
