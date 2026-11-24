import {
  isLiveSessionAgent,
  sessionProviderDeclaration,
  type Access,
  type LiveSessionAgent,
  type SessionCapabilities,
  type SessionProviderDeclaration,
  type SessionQueueAction,
  type SessionQueueItem,
} from "@agentkib/web-client";
import type { InteractionLocale } from "../interaction-model";
import { claudeCodeQueuePanel } from "./claude-code/queue-panel";
import { codexQueuePanel } from "./codex/queue-panel";
import { deepSeekHarnessQueuePanel } from "./deepseek-harness/queue-panel";

export type SessionQueuePanelAgent = LiveSessionAgent;

export type QueuePanelDescriptor = {
  connection?: NonNullable<SessionProviderDeclaration["connection"]>["kind"];
  match?: SessionQueueAction;
  surface: "operations" | "managed" | "basic";
  serial: boolean;
  pendingWithoutStatus: boolean;
  legacyRead?: "approved" | "features";
  automatic?: boolean;
  runningSteer?: boolean;
  title?(locale: InteractionLocale): string;
};

type SessionQueuePanel = QueuePanelDescriptor & {
  agent: SessionQueuePanelAgent;
  actions: readonly SessionQueueAction[];
};

const queuePanels: readonly QueuePanelDescriptor[] = [
  codexQueuePanel,
  claudeCodeQueuePanel,
  deepSeekHarnessQueuePanel,
];

/** Direct steering is a composer action, separate from inserting a specific queued item. */
export function registeredRunningSteer(provider?: SessionProviderDeclaration) {
  return queuePanels.some(
    (panel) => panel.connection === provider?.connection?.kind && panel.runningSteer,
  );
}

export function registeredSessionQueue(
  agent: string | undefined,
  provider = sessionProviderDeclaration(agent),
): SessionQueuePanel | undefined {
  if (!isLiveSessionAgent(agent) || !provider) return;
  const actions = provider.queue?.actions;
  if (!actions?.includes("list")) return;
  const panel = queuePanels.find(
    (entry) =>
      entry.connection === provider.connection?.kind &&
      (!entry.match || actions.includes(entry.match)),
  );
  if (panel) return { ...panel, agent, actions };
  if (provider.operations.execution || !actions.includes("pause") || !actions.includes("resume"))
    return;
  return {
    agent,
    surface: basicComposer(provider) ? "basic" : "managed",
    serial: true,
    pendingWithoutStatus: true,
    actions,
  };
}

/** Composer queue registration is also used by the basic action transport adapter. */
export function sessionQueuePanel(
  agent: string | undefined,
  provider?: SessionProviderDeclaration,
) {
  const panel = registeredSessionQueue(agent, provider);
  return panel?.surface === "operations" ? undefined : panel;
}

export function queueAccessGranted(access?: Access | null) {
  return access?.status === "approved" && access.device?.advancedControl === true;
}

export function queueActionGranted(
  panel: SessionQueuePanel | undefined,
  action: SessionQueueAction,
  access?: Access | null,
) {
  return (
    panel?.actions.includes(action) === true &&
    queueAccessGranted(access) &&
    (!panel.serial ||
      !["add", "update", "resume"].includes(action) ||
      access?.device?.send === true)
  );
}

export function canReadSessionQueue(
  panel: SessionQueuePanel | undefined,
  selected: string,
  capabilities?: SessionCapabilities,
  access?: Access | null,
) {
  if (!panel || !queueAccessGranted(access) || capabilities?.sessionId !== selected) return false;
  const features = capabilities.features;
  if (features["queue-list"]) return features["queue-list"].available === true;
  // Old hosts did not publish queue-list. Keep each operations queue's original fallback.
  if (capabilities.provider?.queue) return false;
  return (
    panel.legacyRead === "approved" ||
    (panel.legacyRead === "features" &&
      (features["queue-add"]?.available === true ||
        features["queue-resume"]?.available === true ||
        features["queue-pause"]?.available === true))
  );
}

export function queueItemPending(item: SessionQueueItem, panel: SessionQueuePanel) {
  return item.status === "pending" || (item.status === undefined && panel.pendingWithoutStatus);
}

export function reorderableQueueItems(
  items: readonly SessionQueueItem[] | undefined,
  panel: SessionQueuePanel,
) {
  return (
    items?.filter(
      (item) => queueItemPending(item, panel) && item.actions?.reorder?.available !== false,
    ) ?? []
  );
}

export function moveQueuedItemUp(items: readonly SessionQueueItem[], index: number) {
  const ids = items.map((item) => item.id);
  [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!];
  return ids;
}

function basicComposer(provider: SessionProviderDeclaration) {
  return (
    provider.composer && "surface" in provider.composer && provider.composer.surface === "basic"
  );
}
