import {
  sessionProviderCapabilities,
  type Access,
  type ContextUsage,
  type ConversationSessionSummary,
  type Live,
  type SessionProviderCapabilities,
} from "@agentkib/web-client";
import { canReadContextUsage, useObservedContextUsage } from "./context-usage";

type Source = SessionProviderCapabilities["contextUsage"];
export type ContextUsageSession = {
  selected: string;
  current?: Pick<ConversationSessionSummary, "id" | "agent" | "workspace_id">;
  client: unknown;
  access?: Access;
  live?: Live;
  online: boolean;
  usageEpoch?: string;
};

export function useSessionContextUsage(
  session: ContextUsageSession,
  {
    fallback,
    capacity,
    source: declaredSource,
  }: { fallback?: ContextUsage; capacity?: number; source?: Source } = {},
) {
  const { selected, access, live, client, online, usageEpoch } = session;
  const current = session.current?.id === selected ? session.current : undefined;
  const selectedLive = live?.sessionId === selected ? live : undefined;
  const source =
    declaredSource ??
    (selectedLive?.settings?.sessionId === selected
      ? selectedLive.settings.provider?.contextUsage
      : undefined) ??
    sessionProviderCapabilities(current?.agent)?.contextUsage;
  const supported = source !== "unsupported";
  const authorized = canReadContextUsage(access);
  const scope = JSON.stringify([
    selected,
    current?.workspace_id,
    current?.agent,
    access?.bootId,
    access?.device?.id,
    authorized,
    source,
  ]);
  const epoch = JSON.stringify([
    usageEpoch,
    selectedLive?.executionMode,
    selectedLive?.connectionGeneration,
  ]);
  const view = useObservedContextUsage({
    selected,
    scope,
    epoch,
    identity: client,
    live: supported ? live : undefined,
    online,
    authorized: supported && authorized,
    fallback: supported ? fallback : undefined,
    source,
  });
  const limit = view.usage?.contextWindow ?? capacity;
  const knownCapacity =
    supported && authorized && limit !== undefined && Number.isSafeInteger(limit) && limit > 0
      ? limit
      : undefined;
  return {
    ...view,
    source,
    visible:
      supported &&
      (source !== "last-request" || view.usage?.historical === true || knownCapacity !== undefined),
    scope: JSON.stringify([scope, epoch]),
    capacity: knownCapacity,
    awaitingCliReport:
      source === "live" &&
      current?.agent === "claude-code" &&
      selectedLive?.executionMode === "claude-managed" &&
      !selectedLive.executionLocation &&
      ["idle", "released"].includes(selectedLive.status) &&
      !selectedLive.reason &&
      authorized &&
      online &&
      view.state === "unavailable" &&
      !view.usage?.available &&
      !view.usage?.reason &&
      view.percent === undefined,
  };
}

export type SessionContextUsageView = ReturnType<typeof useSessionContextUsage>;
