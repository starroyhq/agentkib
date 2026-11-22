import {
  isLiveSessionAgent,
  sessionProviderDeclaration,
  type LiveSessionAgent,
  type SessionProviderDeclaration,
  type SessionQueueAction,
} from "@agentkib/web-client";
import { deepSeekHarnessQueuePanel } from "./deepseek-harness/queue-panel";

export type SessionQueuePanelAgent = LiveSessionAgent;

type SessionQueuePanel = {
  agent: SessionQueuePanelAgent;
  surface: "managed" | "basic";
  serial: boolean;
  actions: readonly SessionQueueAction[];
};

/** Selects the queue panel in the composer. Live capabilities still govern its actions. */
export function sessionQueuePanel(
  agent: string | undefined,
  provider = sessionProviderDeclaration(agent),
): SessionQueuePanel | undefined {
  if (!isLiveSessionAgent(agent) || !provider) return;
  const actions = provider.queue?.actions;
  if (!actions?.includes("list")) return;
  const harness = deepSeekHarnessQueuePanel;
  if (actions.includes(harness.match))
    return { agent, surface: harness.surface, serial: harness.serial, actions };
  if (provider.operations.execution || !actions.includes("pause") || !actions.includes("resume"))
    return;
  return { agent, surface: basicComposer(provider) ? "basic" : "managed", serial: true, actions };
}

function basicComposer(provider: SessionProviderDeclaration) {
  return (
    provider.composer && "surface" in provider.composer && provider.composer.surface === "basic"
  );
}
