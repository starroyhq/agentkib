import { ChevronDown, ShieldAlert } from "lucide-react";
import type { LivePermission } from "@agentkib/web-client";
import type { InteractionLocale as Locale } from "../../interaction-model";
import { useSessionPlatform } from "../../session-platform";
import { terminalPermissionObservation } from "../../agents/session-permission-observations";

/**
 * Tells the user when a Claude session runs where actions are no longer approved one by one
 * (auto, dontAsk, bypassPermissions), or when the mode is unknown on a CLI that may start in
 * auto. It carries text and an icon, never color alone, and only informs: it never blocks sending.
 * `default`, `plan`, `acceptEdits` and an unknown mode without a hint render nothing.
 */
export function PermissionModeNotice({
  permission,
  locale,
  compact = false,
}: {
  permission?: LivePermission | null;
  locale: Locale;
  compact?: boolean;
}) {
  const { Disclosure, DisclosureSummary, collapsible } = useSessionPlatform().components;
  const notice = terminalPermissionObservation.notice(permission, locale);
  if (!notice) return null;
  const content = (
    <span>
      {notice.text}
      {notice.previous && <span className="mt-1 block">{notice.previous}</span>}
    </span>
  );
  const color = notice.danger
    ? "border-destructive/40 bg-destructive/10 text-destructive-text"
    : "border-amber-500/25 bg-amber-500/5 text-amber-700 dark:text-amber-300";
  if (compact) {
    const className = `group rounded-lg border text-xs leading-5 ${color}`;
    const label = (
      <>
        <ShieldAlert aria-hidden="true" className="size-4 shrink-0" />
        <span>{notice.label}</span>
      </>
    );
    const details = (
      <p role="status" className="px-2.5 pb-2">
        {content}
      </p>
    );
    if (collapsible) {
      const { Collapsible, CollapsibleTrigger, CollapsibleContent } = collapsible;
      return (
        <Collapsible className={className}>
          <CollapsibleTrigger className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left">
            {label}
            <ChevronDown
              aria-hidden="true"
              className="ml-auto size-4 shrink-0 transition-transform group-data-[open]:rotate-180"
            />
          </CollapsibleTrigger>
          <CollapsibleContent keepMounted>{details}</CollapsibleContent>
        </Collapsible>
      );
    }
    return (
      <Disclosure className={className}>
        <DisclosureSummary className="flex min-h-11 cursor-pointer items-center gap-2 px-2.5 py-2">
          {label}
          <ChevronDown
            aria-hidden="true"
            className="ml-auto size-4 shrink-0 transition-transform group-open:rotate-180"
          />
        </DisclosureSummary>
        {details}
      </Disclosure>
    );
  }
  return (
    <p
      role="status"
      className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs leading-5 ${color}`}
    >
      <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {content}
    </p>
  );
}
