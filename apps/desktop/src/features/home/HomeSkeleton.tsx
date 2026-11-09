import {
  SkeletonListRows,
  SkeletonPage,
  SkeletonPanel,
  SkeletonPanelHeader,
} from "@/components/ui/skeleton-layouts";

/** The session groups and recent sessions, as rows; the home never shows a loading card. */
export function HomeSkeleton() {
  return (
    <SkeletonPage className="pb-8" labelKey="loading.home">
      <SkeletonPanel>
        <SkeletonListRows count={3} />
      </SkeletonPanel>
      <SkeletonPanel>
        <SkeletonPanelHeader />
        <SkeletonListRows count={4} compact />
      </SkeletonPanel>
    </SkeletonPage>
  );
}
