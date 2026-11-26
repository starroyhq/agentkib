import { useI18n } from "@/core/useI18n";
import {
  SkeletonListRows,
  SkeletonPage,
  SkeletonPanel,
  SkeletonPanelHeader,
  SkeletonText,
} from "@/components/ui/skeleton-layouts";
import { Skeleton } from "@/components/ui/skeleton";
import type { InsightsSection } from "./InsightsPage";

export function InsightsSkeleton({ section = "overview" }: { section?: InsightsSection }) {
  const { tr } = useI18n();
  if (section === "milestones") return <AchievementWallSkeleton />;

  return (
    <SkeletonPage className="pb-8" label={`${tr("common.loading")} ${tr("nav.insights")}`}>
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonText className="h-9 w-24 rounded-lg" key={index} />
        ))}
      </div>
      <SkeletonPanel>
        <SkeletonPanelHeader />
        <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(260px,.75fr)]">
          <Skeleton className="min-h-[260px] w-full rounded-xl" />
          <SkeletonListRows count={5} compact />
        </div>
      </SkeletonPanel>
      <div className="grid gap-4 lg:grid-cols-2">
        <SkeletonPanel>
          <SkeletonPanelHeader />
          <SkeletonListRows count={4} compact />
        </SkeletonPanel>
        <SkeletonPanel>
          <SkeletonPanelHeader />
          <SkeletonListRows count={4} compact />
        </SkeletonPanel>
      </div>
    </SkeletonPage>
  );
}

export function AchievementWallSkeleton() {
  const { tr } = useI18n();
  return (
    <SkeletonPage
      className="pb-8"
      label={`${tr("common.loading")} ${tr("insights.section.milestones")}`}
    >
      <SkeletonPanel>
        <div className="flex min-h-[58px] items-center justify-between gap-3 border-b border-border/70 px-5 py-4 max-[520px]:items-end max-[520px]:flex-col">
          <div className="grid gap-2">
            <SkeletonText className="h-4 w-28" />
            <SkeletonText className="h-3 w-14" />
          </div>
          <div className="flex items-center gap-2 max-[520px]:w-full max-[520px]:justify-end">
            <SkeletonText className="h-5 w-28 rounded-full" />
            <SkeletonText className="h-5 w-24 rounded-full" />
          </div>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4 bg-muted/20 p-5 max-[760px]:grid-cols-2 max-[520px]:grid-cols-1">
          {Array.from({ length: 15 }, (_, index) => (
            <div
              className="grid min-h-[156px] grid-cols-[38px_minmax(0,1fr)] grid-rows-[auto_auto_1fr_auto] gap-x-3 gap-y-1.5 rounded-[11px] border border-border bg-card p-4"
              key={index}
            >
              <Skeleton className="row-span-2 size-[38px] rounded-[10px]" />
              <SkeletonText className="h-3 w-24 self-end" />
              <SkeletonText className="h-4 w-32 self-start" />
              <SkeletonText className="col-span-full h-3 w-28 self-center" />
              <div className="col-span-full flex items-center justify-between gap-2 border-t border-border pt-2">
                <SkeletonText className="h-3 w-20" />
                <Skeleton className="size-4 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      </SkeletonPanel>
    </SkeletonPage>
  );
}
