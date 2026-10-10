import { useState } from "react";
import { useI18n } from "@/core/useI18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Activity,
  Award,
  Brain,
  CalendarCheck2,
  Check,
  ChevronRight,
  Flame,
  FolderGit2,
  GitCommitHorizontal,
  LockKeyhole,
  MessageSquareText,
  Moon,
  Network,
  PlugZap,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import type { Achievement } from "@/core/types";
import {
  achievementReached,
  buildAchievementWallItems,
  selectDefaultTrackMilestone,
  type AchievementCategory,
  type AchievementTrack,
  type AchievementWallItem,
} from "@/features/insights/achievements";
import { cn } from "cn";
import { Empty } from "./InsightsComponents";

const milestoneIcons: Record<AchievementCategory, typeof Activity> = {
  token: Sparkles,
  session: MessageSquareText,
  commit: GitCommitHorizontal,
  "active-days": CalendarCheck2,
  streak: Flame,
  workspaces: FolderGit2,
  agents: Network,
};
const specialAchievementIcons: Record<string, typeof Activity> = {
  "special-first-changeset": ShieldCheck,
  "special-first-memory": Brain,
  "special-shared-workspace": Network,
  "special-exact-attribution": GitCommitHorizontal,
  "special-remote-handshake": PlugZap,
  "special-night-owl": Moon,
  "special-comeback": RotateCcw,
  "special-same-day-delivery": Workflow,
};

export function AchievementWall({ achievements }: { achievements: Achievement[] }) {
  const { formatNumber, tr } = useI18n();
  const [selectedId, setSelectedId] = useState<string>();
  if (!achievements.length)
    return (
      <Card className="rounded-2xl border-border bg-card shadow-sm">
        <Empty icon={Award} title={tr("insights.preparing")} />
      </Card>
    );
  const items = buildAchievementWallItems(achievements);
  const selected = items.find((item) => item.id === selectedId);
  const tracks = items.filter((item) => item.kind === "track");
  const specials = items.filter((item) => item.kind === "special");
  const completedMilestones = tracks.reduce((count, item) => count + item.track.completed, 0);
  const milestoneCount = tracks.reduce((count, item) => count + item.track.milestones.length, 0);
  const completedSpecials = specials.filter((item) => item.unlocked).length;
  return (
    <Card className="h-full overflow-hidden rounded-2xl border-border bg-card shadow-sm">
      <CardHeader className="flex min-h-[58px] flex-row items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <div className="m-0 text-base font-semibold">{tr("insights.milestones")}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatNumber(completedMilestones)} / {formatNumber(milestoneCount)}
          </p>
        </div>
        <div className="flex items-center gap-2 max-[520px]:items-end max-[520px]:flex-col">
          <Badge variant="outline">
            {tr("achievementWall.milestones", {
              completed: formatNumber(completedMilestones),
              total: formatNumber(milestoneCount),
            })}
          </Badge>
          <Badge variant="outline">
            {tr("achievementWall.specials", {
              completed: formatNumber(completedSpecials),
              total: formatNumber(specials.length),
            })}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4 bg-muted/20 p-5 max-[760px]:grid-cols-2 max-[520px]:grid-cols-1">
          {items.map((item) => (
            <AchievementWallCard key={item.id} item={item} onOpen={() => setSelectedId(item.id)} />
          ))}
        </div>
      </CardContent>
      {selected && (
        <AchievementDetailDialog
          key={selected.id}
          item={selected}
          onClose={() => setSelectedId(undefined)}
        />
      )}
    </Card>
  );
}

function AchievementWallCard({ item, onOpen }: { item: AchievementWallItem; onOpen: () => void }) {
  const { formatCompactNumber, formatNumber, formatDateTime, tr } = useI18n();
  if (item.kind === "track") {
    const Icon = milestoneIcons[item.track.category];
    const title = tr(`achievements.${achievementTranslationKey(item.cover.code)}.title`);
    return (
      <Button
        variant="bare"
        size="content"
        className={cn(
          "group relative grid min-h-[156px] min-w-0 grid-cols-[38px_minmax(0,1fr)] grid-rows-[auto_auto_1fr_auto] gap-x-3 gap-y-1.5 rounded-[11px] border border-border bg-card p-4 text-left text-muted-foreground transition hover:-translate-y-px hover:border-foreground/20 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          item.unlocked &&
            "border-[color-mix(in_srgb,var(--green)_30%,var(--border))] bg-[color-mix(in_srgb,var(--green)_7%,transparent)]",
        )}
        onClick={onOpen}
        aria-label={tr("achievementWall.openTrack", {
          category: tr(`milestones.category.${item.track.category}`),
        })}
      >
        <span
          className={cn(
            "row-span-2 grid size-[38px] place-items-center rounded-[10px] border border-border bg-background text-muted-foreground",
            item.unlocked &&
              "border-[color-mix(in_srgb,var(--green)_35%,var(--border))] bg-[color-mix(in_srgb,var(--green)_12%,transparent)] text-[var(--green)]",
          )}
        >
          <Icon size={20} />
        </span>
        <span className="self-end truncate text-xs font-semibold">
          {tr(`milestones.category.${item.track.category}`)}
        </span>
        <strong className="self-start truncate text-base text-foreground">{title}</strong>
        <small className="col-span-full self-center truncate text-xs">
          {formatMilestoneValue(item.track.category, item.cover.threshold, formatCompactNumber, tr)}
        </small>
        <span
          className={cn(
            "col-span-full flex min-w-0 items-center justify-between gap-2 border-t border-border pt-2 text-xs",
            item.unlocked && "text-[var(--green)]",
          )}
        >
          <span className="truncate">
            {tr("milestones.completed", {
              completed: formatNumber(item.track.completed),
              total: formatNumber(item.track.milestones.length),
            })}
          </span>
          <ChevronRight size={15} />
        </span>
      </Button>
    );
  }
  const { achievement, secret, unlocked } = item.special;
  const hidden = secret && !unlocked;
  const Icon = hidden ? LockKeyhole : (specialAchievementIcons[achievement.code] ?? Award);
  const title = hidden
    ? tr("special.mystery")
    : tr(`achievements.${achievementTranslationKey(achievement.code)}.title`);
  const status = achievement.unlocked_at
    ? tr("insights.unlockedAt", { date: formatDateTime(achievement.unlocked_at) })
    : unlocked
      ? tr("special.reachedDateUnknown")
      : tr("milestones.locked");
  return (
    <Button
      variant="bare"
      size="content"
      className={cn(
        "group relative grid min-h-[156px] min-w-0 grid-cols-[38px_minmax(0,1fr)] grid-rows-[auto_auto_1fr_auto] gap-x-3 gap-y-1.5 rounded-[11px] border border-border bg-card p-4 text-left text-muted-foreground transition hover:-translate-y-px hover:border-foreground/20 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        unlocked &&
          "border-[color-mix(in_srgb,var(--green)_30%,var(--border))] bg-[color-mix(in_srgb,var(--green)_7%,transparent)]",
      )}
      onClick={onOpen}
      aria-label={tr("achievementWall.openSpecial", { title })}
    >
      <span
        className={cn(
          "row-span-2 grid size-[38px] place-items-center rounded-[10px] border border-border bg-background text-muted-foreground",
          unlocked &&
            "border-[color-mix(in_srgb,var(--green)_35%,var(--border))] bg-[color-mix(in_srgb,var(--green)_12%,transparent)] text-[var(--green)]",
        )}
      >
        <Icon size={20} />
      </span>
      <span className="self-end truncate text-xs font-semibold">{tr("special.title")}</span>
      <strong className="self-start truncate text-base text-foreground">{title}</strong>
      <small className="col-span-full self-center truncate text-xs">{status}</small>
      <span
        className={cn(
          "col-span-full flex min-w-0 items-center justify-between gap-2 border-t border-border pt-2 text-xs",
          unlocked && "text-[var(--green)]",
        )}
      >
        <span className="truncate">
          {unlocked ? tr("achievementWall.unlocked") : tr("milestones.locked")}
        </span>
        <ChevronRight size={15} />
      </span>
    </Button>
  );
}

function AchievementDetailDialog({
  item,
  onClose,
}: {
  item: AchievementWallItem;
  onClose: () => void;
}) {
  const { tr } = useI18n();
  const title =
    item.kind === "track"
      ? tr(`milestones.category.${item.track.category}`)
      : item.special.secret && !item.special.unlocked
        ? tr("special.mystery")
        : tr(`achievements.${achievementTranslationKey(item.special.achievement.code)}.title`);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="grid max-h-[min(940px,calc(100vh-40px))] w-[min(1100px,calc(100%-32px))] max-w-[min(1100px,calc(100%-32px))] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-[14px] border-[var(--border-strong)] bg-card p-0 shadow-2xl sm:!max-w-[min(1100px,calc(100%-32px))] max-[760px]:max-h-[calc(100vh-24px)] max-[760px]:w-[calc(100%-24px)] max-[760px]:!max-w-[calc(100%-24px)]"
        showCloseButton={false}
      >
        <DialogHeader className="flex min-h-[68px] flex-row items-center justify-between gap-4 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <span className="mb-0.5 block text-xs font-semibold text-muted-foreground">
              {item.kind === "track" ? tr("achievementWall.track") : tr("special.title")}
            </span>
            <DialogTitle id="achievement-dialog-title" className="truncate text-xl">
              {title}
            </DialogTitle>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={tr("common.close")}>
            <X size={17} />
          </Button>
        </DialogHeader>
        {item.kind === "track" ? (
          <AchievementTrackDetail track={item.track} />
        ) : (
          <SpecialAchievementDetail item={item} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AchievementTrackDetail({ track }: { track: AchievementTrack }) {
  const { formatCompactNumber, formatNumber, formatDateTime, tr } = useI18n();
  const [selectedCode, setSelectedCode] = useState(() => selectDefaultTrackMilestone(track).code);
  const selected =
    track.milestones.find((milestone) => milestone.code === selectedCode) ??
    selectDefaultTrackMilestone(track);
  // The line spans the first and last dots; the first completed milestone is its origin.
  const progressPercent =
    track.milestones.length === 1
      ? achievementReached(track.milestones[0])
        ? 100
        : 0
      : Math.round(
          Math.max(
            0,
            (track.progressRatio * track.milestones.length - 1) / (track.milestones.length - 1),
          ) * 100,
        );
  const selectedReached = achievementReached(selected);
  const selectedCurrent = track.next?.code === selected.code;
  const milestoneCount = Math.max(1, track.milestones.length);
  return (
    <div className="min-h-0 overflow-auto">
      <div className="grid grid-cols-3 border-b border-border max-[760px]:grid-cols-1">
        {[
          [
            tr("achievementWall.currentValue"),
            formatMilestoneValue(track.category, track.progress, formatCompactNumber, tr),
          ],
          [
            tr("achievementWall.completedStages"),
            `${formatNumber(track.completed)} / ${formatNumber(track.milestones.length)}`,
          ],
          [
            tr("achievementWall.nextTarget"),
            track.next
              ? formatMilestoneValue(track.category, track.next.threshold, formatCompactNumber, tr)
              : tr("milestones.highest"),
          ],
        ].map(([label, value], index) => (
          <span
            className={cn(
              "grid min-h-[68px] content-center gap-1 px-5 py-3",
              index > 0 && "border-l border-border max-[760px]:border-l-0 max-[760px]:border-t",
            )}
            key={label}
          >
            <small className="text-xs text-muted-foreground">{label}</small>
            <strong className="truncate text-sm text-foreground">{value}</strong>
          </span>
        ))}
      </div>
      <div className="overflow-x-auto overflow-y-hidden border-b border-border px-5 pb-4 pt-7">
        <ToggleGroup
          className="segmented-control segmented-control-grid relative w-full min-w-0 gap-0 pb-2 max-[760px]:min-w-[640px]"
          value={[selected.code]}
          onValueChange={(values) => {
            const next = track.milestones.find((milestone) => milestone.code === values[0]);
            if (next) setSelectedCode(next.code);
          }}
          style={{
            gridTemplateColumns: `repeat(${milestoneCount}, minmax(0, 1fr))`,
            gap: 0,
            padding: 0,
            alignItems: "stretch",
          }}
        >
          <Progress
            value={progressPercent}
            aria-label={tr("milestones.progress", {
              category: tr(`milestones.category.${track.category}`),
            })}
            style={{ left: `${50 / milestoneCount}%`, right: `${50 / milestoneCount}%` }}
            className="pointer-events-none absolute top-[35px] z-0 h-0.5 w-auto bg-border"
          />
          {track.milestones.map((milestone) => {
            const reached = achievementReached(milestone);
            const current = track.next?.code === milestone.code;
            return (
              <ToggleGroupItem
                value={milestone.code}
                className={cn(
                  "segmented-control-item relative z-1 grid h-auto min-h-[104px] min-w-0 grid-rows-[22px_auto_auto] items-center content-start justify-items-center gap-1.5 px-1 pt-6 text-center focus-visible:ring-2 focus-visible:ring-ring",
                  reached && "text-foreground",
                  current && "text-[var(--blue)]",
                )}
                key={milestone.code}
              >
                <span
                  className={cn(
                    "grid size-[22px] place-items-center rounded-full border-2 border-[var(--border-strong)] bg-card text-muted-foreground",
                    reached && "border-[var(--green)] bg-[var(--green)] text-white",
                    current &&
                      "border-primary shadow-[0_0_0_4px_color-mix(in_srgb,var(--primary)_14%,transparent)]",
                  )}
                >
                  {reached ? <Check size={13} /> : ""}
                </span>
                <strong className="max-w-full whitespace-normal text-xs leading-tight">
                  {formatMilestoneValue(
                    track.category,
                    milestone.threshold,
                    formatCompactNumber,
                    tr,
                  )}
                </strong>
                <small className="max-w-full whitespace-normal text-xs leading-tight">
                  {tr(`achievements.${achievementTranslationKey(milestone.code)}.title`)}
                </small>
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
      </div>
      <section className="grid min-h-24 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-1.5 px-5 py-4 max-[760px]:grid-cols-1">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              "grid size-[30px] shrink-0 place-items-center rounded-full border border-border bg-muted text-muted-foreground",
              selectedReached && "border-[var(--green)] bg-[var(--green)] text-white",
              selectedCurrent && "border-[var(--blue)]",
            )}
          >
            {selectedReached ? <Check size={14} /> : <LockKeyhole size={13} />}
          </span>
          <div className="min-w-0">
            <small className="mb-0.5 block text-xs text-muted-foreground">
              {tr("achievementWall.stageDetail")}
            </small>
            <h3 className="truncate text-base font-semibold text-foreground">
              {tr(`achievements.${achievementTranslationKey(selected.code)}.title`)}
            </h3>
          </div>
        </div>
        <strong className="text-sm text-foreground">
          {formatMilestoneValue(track.category, selected.threshold, formatCompactNumber, tr)}
        </strong>
        <p className="col-span-full m-0 pl-[41px] text-xs text-muted-foreground max-[760px]:pl-[41px]">
          {selected.unlocked_at
            ? tr("insights.unlockedAt", { date: formatDateTime(selected.unlocked_at) })
            : selectedReached
              ? tr("special.reachedDateUnknown")
              : selectedCurrent
                ? tr("milestones.currentProgress", {
                    progress: formatMilestoneValue(
                      track.category,
                      track.progress,
                      formatCompactNumber,
                      tr,
                    ),
                  })
                : tr("milestones.locked")}
        </p>
      </section>
    </div>
  );
}

function SpecialAchievementDetail({
  item,
}: {
  item: Extract<AchievementWallItem, { kind: "special" }>;
}) {
  const { formatDateTime, tr } = useI18n();
  const { achievement, secret, unlocked } = item.special;
  const hidden = secret && !unlocked;
  const key = achievementTranslationKey(achievement.code);
  const Icon = hidden ? LockKeyhole : (specialAchievementIcons[achievement.code] ?? Award);
  const title = hidden ? tr("special.mystery") : tr(`achievements.${key}.title`);
  const status = achievement.unlocked_at
    ? tr("insights.unlockedAt", { date: formatDateTime(achievement.unlocked_at) })
    : unlocked
      ? tr("special.reachedDateUnknown")
      : tr("milestones.locked");
  return (
    <div className="grid justify-items-center px-7 pb-10 pt-9 text-center">
      <span
        className={cn(
          "grid size-16 place-items-center rounded-2xl border border-border bg-muted text-muted-foreground",
          unlocked &&
            "border-[color-mix(in_srgb,var(--green)_35%,var(--border))] bg-[color-mix(in_srgb,var(--green)_12%,transparent)] text-[var(--green)]",
        )}
      >
        <Icon size={28} />
      </span>
      <h3 className="mt-3.5 text-xl font-semibold text-foreground">{title}</h3>
      <p className="my-2 max-w-[560px] text-sm leading-relaxed text-muted-foreground">
        {hidden ? tr("achievementWall.secretCondition") : tr(`achievements.${key}.description`)}
      </p>
      <Badge variant="outline">{status}</Badge>
    </div>
  );
}

function formatMilestoneValue(
  category: AchievementCategory,
  value: number,
  formatCompactNumber: ReturnType<typeof useI18n>["formatCompactNumber"],
  tr: ReturnType<typeof useI18n>["tr"],
) {
  return tr(`milestones.value.${category}`, { count: value, value: formatCompactNumber(value) });
}
function achievementTranslationKey(code: string) {
  return (
    (
      {
        "token-100000": "token_100k",
        "token-1000000": "token_1m",
        "token-10000000": "token_10m",
        "token-100000000": "token_100m",
        "token-1000000000": "token_1b",
        "token-10000000000": "token_10b",
        "token-100000000000": "token_100b",
        "token-1000000000000": "token_1t",
        "session-10": "session_10",
        "session-50": "session_50",
        "session-100": "session_100",
        "session-500": "session_500",
        "session-1000": "session_1000",
        "session-5000": "session_5000",
        "session-10000": "session_10000",
        "commit-1": "commit_1",
        "commit-10": "commit_10",
        "commit-100": "commit_100",
        "commit-1000": "commit_1000",
        "commit-5000": "commit_5000",
        "commit-10000": "commit_10000",
        "active-days-7": "active_days_7",
        "active-days-30": "active_days_30",
        "active-days-100": "active_days_100",
        "active-days-365": "active_days_365",
        "active-days-1000": "active_days_1000",
        "streak-3": "streak_3",
        "streak-7": "streak_7",
        "streak-14": "streak_14",
        "streak-30": "streak_30",
        "streak-60": "streak_60",
        "streak-100": "streak_100",
        "streak-180": "streak_180",
        "streak-365": "streak_365",
        "workspaces-1": "workspaces_1",
        "workspaces-5": "workspaces_5",
        "workspaces-10": "workspaces_10",
        "workspaces-25": "workspaces_25",
        "workspaces-50": "workspaces_50",
        "workspaces-100": "workspaces_100",
        "agents-1": "agents_1",
        "agents-2": "agents_2",
        "agents-3": "agents_3",
        "agents-4": "agents_4",
        "agents-5": "agents_5",
        "special-first-changeset": "special_first_changeset",
        "special-first-memory": "special_first_memory",
        "special-shared-workspace": "special_shared_workspace",
        "special-exact-attribution": "special_exact_attribution",
        "special-remote-handshake": "special_remote_handshake",
        "special-night-owl": "special_night_owl",
        "special-comeback": "special_comeback",
        "special-same-day-delivery": "special_same_day_delivery",
      } as Record<string, string>
    )[code] ?? code
  );
}
