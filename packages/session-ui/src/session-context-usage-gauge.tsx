import type { Ref } from "react";
import type { ComposerModelLocale } from "./composer-model-copy";
import { contextUsageCopyForSurface, contextUsageReason } from "./context-usage-copy";
import { ContextUsageIndicator, type ContextUsageHandle } from "./context-usage-indicator";
import { useSessionContextUsage, type ContextUsageSession } from "./session-context-usage";
import type { SessionSurface } from "./session-surface-copy";

export type SessionContextUsageGaugeProps = NonNullable<
  Parameters<typeof useSessionContextUsage>[1]
> & {
  usageRef?: Ref<ContextUsageHandle>;
};

export function SessionContextUsageGauge({
  session,
  surface,
  usageRef,
  ...options
}: SessionContextUsageGaugeProps & {
  session: ContextUsageSession & { locale: ComposerModelLocale };
  surface: SessionSurface;
}) {
  const view = useSessionContextUsage(session, options);
  if (!view.visible) return null;
  const { locale, online } = session;
  const copy = contextUsageCopyForSurface(locale, surface);
  return (
    <ContextUsageIndicator
      scope={view.scope}
      locale={locale}
      online={online}
      view={view}
      copy={copy}
      title={copy.title}
      unknown={copy.unknown}
      reason={contextUsageReason(locale, view.usage?.reason, surface)}
      usageRef={usageRef}
    />
  );
}
