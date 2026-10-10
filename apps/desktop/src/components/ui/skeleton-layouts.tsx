import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "cn";
import { Skeleton } from "./skeleton";

function SkeletonText({ className }: { className?: string }) {
  return <Skeleton className={cn("h-3 w-24", className)} />;
}

function SkeletonMetricCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex min-h-[78px] items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 shadow-[0_8px_24px_-20px_rgba(15,23,42,.45)]",
        className,
      )}
    >
      <Skeleton className="size-10 shrink-0 rounded-xl" />
      <div className="grid min-w-0 gap-2">
        <SkeletonText className="h-3 w-20" />
        <SkeletonText className="h-5 w-10" />
      </div>
    </div>
  );
}

function SkeletonPanel({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

function SkeletonPanelHeader({ className }: { className?: string }) {
  return (
    <div className={cn("grid gap-2 border-b border-border/70 px-5 py-4", className)}>
      <SkeletonText className="h-4 w-40" />
      <SkeletonText className="h-3 w-56" />
    </div>
  );
}

function SkeletonListRows({
  count = 5,
  className,
  compact = false,
}: {
  count?: number;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("divide-y divide-border/70", className)}>
      {Array.from({ length: count }, (_, index) => (
        <div className={cn("flex items-center gap-3 px-5 py-3.5", compact && "py-3")} key={index}>
          <Skeleton className={cn("size-9 shrink-0 rounded-lg", compact && "size-8")} />
          <div className="grid min-w-0 flex-1 gap-2">
            <SkeletonText className={cn("h-3.5 w-[42%]", index % 2 === 1 && "w-[55%]")} />
            <SkeletonText className="h-3 w-[68%]" />
          </div>
          <Skeleton className="size-4 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function SkeletonTable({
  rows = 5,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm",
        className,
      )}
    >
      <div className="grid grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))] gap-4 border-b border-border bg-muted/25 px-5 py-3">
        {Array.from({ length: columns }, (_, index) => (
          <SkeletonText className={cn("h-3 w-20", index === 0 && "w-28")} key={index} />
        ))}
      </div>
      <div className="divide-y divide-border/70">
        {Array.from({ length: rows }, (_, row) => (
          <div
            className="grid min-h-[70px] grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))] items-center gap-4 px-5"
            key={row}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <Skeleton className="size-[34px] shrink-0 rounded-[9px]" />
              <div className="grid min-w-0 flex-1 gap-2">
                <SkeletonText className={cn("h-3.5 w-[46%]", row % 2 === 1 && "w-[60%]")} />
                <SkeletonText className="h-3 w-[72%]" />
              </div>
            </div>
            <SkeletonText className="h-3 w-20" />
            <SkeletonText className="h-3 w-8" />
            <SkeletonText className="h-3 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

function SkeletonToolbar({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      <Skeleton className="h-9 w-56 rounded-lg" />
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 w-28 rounded-lg" />
        <Skeleton className="size-9 rounded-lg" />
      </div>
    </div>
  );
}

function SkeletonPage({
  children,
  className,
  label,
  labelKey = "common.loading",
}: {
  children: ReactNode;
  className?: string;
  label?: string;
  labelKey?: string;
}) {
  const { t: tr } = useTranslation();
  return (
    <div
      className={cn("grid gap-4", className)}
      role="status"
      aria-busy="true"
      aria-label={label ?? tr(labelKey)}
    >
      {children}
    </div>
  );
}

export {
  SkeletonListRows,
  SkeletonMetricCard,
  SkeletonPage,
  SkeletonPanel,
  SkeletonPanelHeader,
  SkeletonTable,
  SkeletonText,
  SkeletonToolbar,
};
