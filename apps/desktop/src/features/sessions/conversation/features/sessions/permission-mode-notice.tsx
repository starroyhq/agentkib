import { ChevronDown, ShieldAlert } from "lucide-react";
import type { LivePermission } from "@agentkib/web-client";
import type { SupportedLocale as Locale } from "@/core/types";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "../../lib/utils";
import { permissionModeCopy, permissionModeSummaryCopy } from "@agentkib/session-ui";

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
  if (!permission) return null;
  const copy = permissionModeCopy[locale];
  const { mode } = permission;
  const noticeKey =
    mode === "auto" || mode === "dontAsk" || mode === "bypassPermissions"
      ? mode
      : mode === null && permission.possiblyAuto === true
        ? "possiblyAuto"
        : undefined;
  if (!noticeKey) return null;
  const message = copy[noticeKey];
  const content = (
    <span>
      {message}
      {mode !== null && permission.previous === true && (
        <span className="mt-1 block">{copy.previous}</span>
      )}
    </span>
  );
  const color =
    mode === "bypassPermissions"
      ? "border-destructive/40 bg-destructive/10 text-destructive-text"
      : "border-amber-500/25 bg-amber-500/5 text-amber-700 dark:text-amber-300";
  if (compact) {
    const summary = permissionModeSummaryCopy[locale];
    return (
      <Collapsible className={cn("group rounded-lg border text-xs leading-5", color)}>
        <CollapsibleTrigger className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left">
          <ShieldAlert aria-hidden="true" className="size-4 shrink-0" />
          <span>
            {summary[noticeKey]}
            {permission.previous && mode !== null ? ` · ${summary.previous}` : ""}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="ml-auto size-4 shrink-0 transition-transform group-data-[open]:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted>
          <p role="status" className="px-2.5 pb-2">
            {content}
          </p>
        </CollapsibleContent>
      </Collapsible>
    );
  }
  return (
    <p
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs leading-5",
        color,
      )}
    >
      <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {content}
    </p>
  );
}
