import { powerMonitor } from "electron";
import type { HomeSession } from "@agentkib/session-catalog";
import {
  parseSessionNotificationInteractions,
  SESSION_NOTIFICATION_INTERACTIONS_CHANGED,
} from "@agentkib/runtime-protocol";
import type { SupportedLocale } from "../../../src/core/types";
import { RUNTIME_METHODS } from "../../generated/runtime-protocol";
import { registerDesktopNotificationsIpc } from "../ipc/desktop-notifications";
import type { RuntimeHost } from "../runtime-host";
import type { WebAccessService } from "../web/service";
import { createDesktopNotificationPlatform } from "./desktop-notification-platform";
import { DesktopSessionNotifier } from "./desktop-session-notifier";
import { DesktopNotificationInteractionSource } from "./desktop-notification-interaction-source";
import { PushNotifier, type PushNotifierOptions } from "./notifier";
import type { NotificationPolicyStore } from "./policy";

export function createSessionNotifications(
  runtime: Pick<RuntimeHost, "on" | "off">,
  options: {
    remote: WebAccessService;
    policy: NotificationPolicyStore;
    requestWhenRuntimeReady: RuntimeHost["request"];
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
  },
) {
  const { remote, policy } = options;
  const workerStatus: NonNullable<PushNotifierOptions["workerStatus"]> = (sessionIds, kind) =>
    options.requestWhenRuntimeReady(RUNTIME_METHODS.sessionRequest, {
      host: { request: { operation: "notification-worker-status", sessionIds, kind } },
    });
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
    workerStatus,
    isViewing: options.isViewing,
    silent: away,
    locale: options.locale,
  });
  const interactions = new DesktopNotificationInteractionSource(remote, (id, evidence, seed) => {
    void desktop.observeInteractions(id, evidence, seed);
  });
  const runtimeNotification = (method: string, params: unknown) => {
    if (method !== SESSION_NOTIFICATION_INTERACTIONS_CHANGED || !policy.desktopEnabled()) return;
    const evidence = parseSessionNotificationInteractions(params);
    if (evidence) interactions.changed(evidence.sessionId, evidence);
  };
  const runtimeExit = () => {
    interactions.invalidate();
    desktop.invalidateInteractions();
  };
  runtime.on("notification", runtimeNotification);
  runtime.on("exit", runtimeExit);
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
    workerStatus,
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
      if (policy.desktopEnabled()) interactions.update(sessions);
      else interactions.disable();
    },
    async stop() {
      runtime.off("notification", runtimeNotification);
      runtime.off("exit", runtimeExit);
      interactions.invalidate();
      await Promise.allSettled([push.stop(), desktop.stop()]);
      platform.close();
    },
  };
}
