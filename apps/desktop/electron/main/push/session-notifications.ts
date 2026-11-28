import { powerMonitor } from "electron";
import type { HomeSession } from "@agentkib/session-catalog";
import type { SupportedLocale } from "../../../src/core/types";
import { registerDesktopNotificationsIpc } from "../ipc/desktop-notifications";
import type { WebAccessService } from "../web/service";
import { createDesktopNotificationPlatform } from "./desktop-notification-platform";
import { DesktopSessionNotifier } from "./desktop-session-notifier";
import { PushNotifier, type PushNotifierOptions } from "./notifier";
import type { NotificationPolicyStore } from "./policy";

export function createSessionNotifications(options: {
  remote: WebAccessService;
  policy: NotificationPolicyStore;
  workerStatus: NonNullable<PushNotifierOptions["workerStatus"]>;
  computerName: NonNullable<PushNotifierOptions["computerName"]>;
  trace: PushNotifierOptions["trace"];
  locale(): SupportedLocale;
  isViewing(id: string): boolean;
  open(id: string): void;
  handle: Parameters<typeof registerDesktopNotificationsIpc>[0];
  observeSession: NonNullable<
    Parameters<typeof registerDesktopNotificationsIpc>[1]["onSessionObserved"]
  >;
  refreshCatalog(): void;
}) {
  const { remote, policy } = options;
  const away = () => {
    const state = powerMonitor.getSystemIdleState(120);
    return state === "idle" || state === "locked";
  };
  const platform = createDesktopNotificationPlatform((id) => {
    desktop.click(id);
    options.open(id);
  });
  const desktop = new DesktopSessionNotifier({
    platform,
    enabled: () => policy.desktopEnabled(),
    delivery: (kind) => policy.desktopDelivery(kind),
    workerResults: () => policy.read().workerResults,
    workerStatus: options.workerStatus,
    isViewing: options.isViewing,
    silent: away,
    locale: options.locale,
  });
  const push = new PushNotifier({
    targets: () => remote.pushTargets(),
    recoveringTargets: () => remote.pushRecoveringTargets(),
    deviceId: () => remote.pushDeviceId(),
    send: (input) => remote.pushSend(input),
    trace: options.trace,
    terminalSummary: (target, sessionId, kind) =>
      remote.terminalInteractionPushSummary(target, sessionId, kind),
    alertContext: (target, session, kind) => remote.notificationAlertContext(target, session, kind),
    activitySnapshot: (target, sessions) => remote.notificationActivityForTarget(target, sessions),
    workerResults: () => policy.read().workerResults,
    workerStatus: options.workerStatus,
    delivery: (kind, present, now) => policy.delivery(kind, present, now),
    enabled: () => policy.read().enabled,
    activityStartAllowed: (now) => policy.allowsActivityStart(now),
    computerName: options.computerName,
    present: () => !away(),
  });
  const refresh = () => {
    push.refresh();
    desktop.refresh();
  };
  remote.onPushChanged(refresh);
  registerDesktopNotificationsIpc(options.handle, {
    policy,
    platform,
    onChanged: () => {
      refresh();
      options.refreshCatalog();
    },
    onSessionObserved: (event, id) => {
      options.observeSession(event, id);
      desktop.refresh();
    },
  });
  return {
    desktop,
    refresh,
    update(sessions: readonly HomeSession[] | undefined) {
      push.update(sessions);
      desktop.update(sessions);
    },
    async stop() {
      await Promise.allSettled([push.stop(), desktop.stop()]);
      platform.close();
    },
  };
}
