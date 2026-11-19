import type { Ref } from "react";
import type { ContextUsage, SessionProviderCapabilities } from "@agentkib/web-client";
import { SessionContextUsageGauge, type ContextUsageHandle } from "@agentkib/session-ui";
import { useSession } from "./session-context";

export { contextUsagePercent, useObservedContextUsage } from "@agentkib/session-ui";
export type ContextUsageGaugeHandle = ContextUsageHandle;
type Source = SessionProviderCapabilities["contextUsage"];

export function ContextUsageGauge({
  fallback,
  limit,
  source,
  gaugeRef,
}: {
  fallback?: ContextUsage;
  limit?: number;
  source?: Source;
  gaugeRef?: Ref<ContextUsageHandle>;
} = {}) {
  const session = useSession();
  return (
    <SessionContextUsageGauge
      session={session}
      surface="desktop"
      fallback={fallback}
      capacity={limit}
      source={source}
      usageRef={gaugeRef}
    />
  );
}
