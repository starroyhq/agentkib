import { CircleX, Goal, Lightbulb } from "lucide-react";
import { composerGoalCopy, planModeCopy } from "./composer-add-menu";
import type { InteractionLocale } from "./interaction-model";

const modeCopy = {
  "zh-CN": { plan: "计划", goal: "目标", exitPlan: "退出计划模式" },
  "zh-Hant": { plan: "計畫", goal: "目標", exitPlan: "退出計畫模式" },
  "en-US": { plan: "Plan", goal: "Goal", exitPlan: "Exit Plan mode" },
  "ja-JP": { plan: "計画", goal: "目標", exitPlan: "計画モードを終了" },
};

export function ComposerModeChip({
  mode,
  locale,
  detail,
  disabled,
  onOpen,
  onRemove,
}: {
  mode: "plan" | "goal";
  locale: InteractionLocale;
  detail?: string;
  disabled?: boolean;
  onOpen?: () => void;
  onRemove?: () => void;
}) {
  const copy = modeCopy[locale];
  const label = copy[mode];
  const name = mode === "plan" ? planModeCopy(locale).title : composerGoalCopy(locale).title;
  const removeLabel = mode === "plan" ? copy.exitPlan : composerGoalCopy(locale).clearDraft;
  const Icon = mode === "plan" ? Lightbulb : Goal;
  const removable = !!onRemove && !disabled;
  const icon = (
    <span className="relative grid size-4 shrink-0 place-items-center" aria-hidden>
      <Icon
        className={
          removable
            ? "size-4 group-hover/mode:invisible group-focus-within/mode:invisible"
            : "size-4"
        }
      />
      {removable && (
        <CircleX className="invisible absolute size-4 group-hover/mode:visible group-focus-within/mode:visible" />
      )}
    </span>
  );
  const action =
    "inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full px-1.5 text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 pointer-coarse:min-h-11";
  return (
    <span className="ml-1 flex shrink-0 items-center gap-0.5 border-l pl-1.5 text-muted-foreground">
      <span className="group/mode inline-flex items-center rounded-full hover:bg-muted focus-within:bg-muted">
        {onOpen && onRemove ? (
          <>
            <button
              type="button"
              className={`${action} pr-0.5`}
              aria-label={removeLabel}
              title={removeLabel}
              disabled={disabled}
              onClick={onRemove}
            >
              {icon}
            </button>
            <button
              type="button"
              className={`${action} pl-0.5`}
              aria-label={name}
              title={detail ?? name}
              disabled={disabled}
              onClick={onOpen}
            >
              {label}
            </button>
          </>
        ) : onOpen || onRemove ? (
          <button
            type="button"
            className={action}
            aria-label={onOpen ? name : removeLabel}
            title={onOpen ? (detail ?? name) : removeLabel}
            disabled={disabled}
            onClick={onOpen ?? onRemove}
          >
            {icon}
            {label}
          </button>
        ) : (
          <span
            className="inline-flex min-h-8 items-center gap-1 px-1.5 text-sm"
            title={detail ?? name}
          >
            {icon}
            {label}
          </span>
        )}
      </span>
    </span>
  );
}
