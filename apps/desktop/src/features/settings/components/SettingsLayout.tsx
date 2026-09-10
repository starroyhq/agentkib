import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { SettingsTarget } from "../SettingsSidebar";

export type SettingsPageVariant = "form" | "management" | "workspace";

const pageWidths: Record<SettingsPageVariant, string> = {
  form: "max-w-[920px]",
  management: "max-w-[920px]",
  workspace: "max-w-[1080px]",
};

export function SettingsPage({
  children,
  variant = "form",
  className,
}: {
  children: ReactNode;
  variant?: SettingsPageVariant;
  className?: string;
}) {
  return (
    <div
      className={cn("mx-auto grid w-full gap-5", pageWidths[variant], className)}
      data-settings-layout={variant}
    >
      {children}
    </div>
  );
}

export function SettingsPageHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex min-h-14 items-start justify-between gap-6 pb-1">
      <div className="grid min-w-0 gap-1.5">
        <h1 className="font-heading text-2xl font-semibold tracking-[-0.025em]">{title}</h1>
        {description && (
          <p className="max-w-[68ch] text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="shrink-0 pt-0.5">{action}</div>}
    </header>
  );
}

export function settingsTargetId(target: SettingsTarget) {
  return `settings-target-${target}`;
}

export function focusSettingsTarget(target: SettingsTarget) {
  const element = document.getElementById(settingsTargetId(target));
  if (!element) return false;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  element.focus({ preventScroll: true });
  return true;
}

export function SettingsAnchor({
  target,
  children,
  className,
}: {
  target: SettingsTarget;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      id={settingsTargetId(target)}
      tabIndex={-1}
      className={cn("scroll-mt-6 outline-none", className)}
    >
      {children}
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
  target,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  target?: SettingsTarget;
}) {
  return (
    <section
      id={target ? settingsTargetId(target) : undefined}
      tabIndex={target ? -1 : undefined}
      className={cn("grid scroll-mt-6 gap-2 outline-none", className)}
    >
      <header className="flex min-h-10 items-end justify-between gap-4 px-0.5">
        <div className="grid min-w-0 gap-1">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card text-card-foreground [&>*:last-child]:border-b-0">
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  children,
  border = true,
  className,
}: {
  children: ReactNode;
  border?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid min-h-16 grid-cols-[minmax(0,1fr)_minmax(180px,max-content)] items-center gap-8 px-5 py-3 [&>*:nth-child(2)]:justify-self-end max-[640px]:grid-cols-1 max-[640px]:gap-3",
        border && "border-b border-border/60",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SettingsCopy({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid min-w-0 gap-1 [&_code]:max-w-full [&_code]:truncate [&_code]:font-mono [&_code]:text-xs [&_code]:text-muted-foreground [&_small]:max-w-[62ch] [&_small]:text-xs [&_small]:leading-relaxed [&_small]:text-muted-foreground [&_strong]:text-sm [&_strong]:font-medium",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SettingsPanel({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
  target,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  target?: SettingsTarget;
}) {
  return (
    <section
      id={target ? settingsTargetId(target) : undefined}
      tabIndex={target ? -1 : undefined}
      className={cn("grid scroll-mt-6 gap-2 outline-none", className)}
    >
      <header className="flex min-h-10 items-end justify-between gap-4 px-0.5">
        <div className="grid min-w-0 gap-1">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div
        className={cn(
          "overflow-hidden rounded-xl border border-border/70 bg-card text-card-foreground [&>*:last-child]:border-b-0",
          contentClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

type NoticeTone = "default" | "warning" | "error";

export function SettingsNotice({
  children,
  tone = "default",
  inset = true,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  tone?: NoticeTone;
  inset?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs",
        inset && "mx-5 my-3",
        tone === "default" && "border-border/60 bg-muted/20 text-muted-foreground",
        tone === "warning" &&
          "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300",
        tone === "error" && "border-destructive/30 bg-destructive/5 text-destructive",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

type StatusTone = "neutral" | "success" | "warning" | "error";

export function SettingsStatus({
  children,
  tone = "neutral",
  indicator = true,
  className,
}: {
  children: ReactNode;
  tone?: StatusTone;
  indicator?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 justify-self-end text-xs font-medium",
        tone === "neutral" && "text-muted-foreground",
        tone === "success" && "text-emerald-600 dark:text-emerald-400",
        tone === "warning" && "text-amber-700 dark:text-amber-300",
        tone === "error" && "text-destructive",
        className,
      )}
    >
      {indicator && <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}
