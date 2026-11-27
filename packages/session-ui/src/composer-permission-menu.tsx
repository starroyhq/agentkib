import { Check, ChevronDown, LoaderCircle, Shield } from "lucide-react";
import { Menu } from "@base-ui/react/menu";
import { composerButtonClasses } from "./composer-control-style";
import { IconAction } from "./icon-action";
import { useDelayedBusy } from "./delayed-busy";

interface ComposerPermissionItem {
  id: string;
  name: string;
  description?: string;
  risky?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  selected?: boolean;
}

type PermissionMenuProps = {
  label?: string;
  title: string;
  description?: string;
  hint?: string;
  risky?: boolean;
  compact?: boolean;
  disabled: boolean;
  saving?: boolean;
  side: "top" | "bottom";
  items: ComposerPermissionItem[];
  selected?: string;
  onSelect: (id: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabledReason?: string;
};

export function ComposerPermissionMenu({
  label,
  title,
  description,
  hint,
  risky = false,
  compact = false,
  disabled,
  saving = false,
  side,
  items,
  selected,
  onSelect,
  open,
  onOpenChange,
  disabledReason,
}: PermissionMenuProps) {
  const visibleLabel = compact ? undefined : label;
  const showSaving = useDelayedBusy(saving);
  const size = compact
    ? "h-7 min-w-7 shrink-0 rounded-lg px-1.5"
    : "h-8 min-w-8 rounded-full px-2.5 text-sm font-normal pointer-coarse:h-11 pointer-coarse:min-w-11";
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <IconAction
        label={label && label !== title ? `${title}: ${label}` : title}
        render={
          <Menu.Trigger
            className={`${composerButtonClasses} ${size} disabled:opacity-50 disabled:grayscale ${disabledReason ? "disabled:pointer-events-auto!" : ""} ${risky ? "text-orange-600 hover:text-orange-700! dark:text-orange-400 dark:hover:text-orange-300!" : "text-muted-foreground"} ${compact || label ? "" : "relative after:invisible after:ps-10 after:content-[attr(aria-label)] @max-[28rem]:after:hidden"}`}
            disabled={disabled}
            aria-busy={saving || undefined}
            title={disabledReason}
          />
        }
      >
        {showSaving && !visibleLabel ? (
          <LoaderCircle
            className={`size-3.5 shrink-0 motion-safe:animate-spin ${compact || label ? "" : "absolute"}`}
            aria-hidden
          />
        ) : (
          <Shield
            className={`size-3.5 shrink-0 ${compact || label ? "" : "absolute"}`}
            aria-hidden
          />
        )}
        {visibleLabel && (
          <>
            <span className="truncate @max-[28rem]:sr-only">{visibleLabel}</span>
            {showSaving ? (
              <LoaderCircle className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden />
            ) : (
              <ChevronDown className="size-3.5 shrink-0" aria-hidden />
            )}
          </>
        )}
      </IconAction>
      <Menu.Portal>
        <Menu.Positioner side={side} sideOffset={4} align="start" className="isolate z-50">
          <Menu.Popup
            className="max-h-(--available-height) w-72 max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-border/80 outline-none"
            aria-label={title}
          >
            <Menu.Group>
              <Menu.GroupLabel className="px-1.5 py-1 text-xs font-medium text-muted-foreground">
                {title}
              </Menu.GroupLabel>
              {description && (
                <p className="px-1.5 py-1 text-xs text-muted-foreground">{description}</p>
              )}
              {hint && <p className="px-1.5 py-1 text-xs text-muted-foreground">{hint}</p>}
              {items.map((item) => {
                const active = item.selected ?? item.id === selected;
                const itemDisabled = disabled || item.disabled;
                return (
                  <Menu.Item
                    key={item.id}
                    className={`flex cursor-default ${item.description ? "items-start" : "items-center"} gap-1.5 rounded-md px-1.5 py-1 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-50 data-disabled:grayscale ${item.risky && !itemDisabled ? "text-orange-600 dark:text-orange-400" : ""}`}
                    disabled={itemDisabled}
                    title={itemDisabled ? item.disabledReason : undefined}
                    aria-current={active || undefined}
                    onClick={() => onSelect(item.id)}
                  >
                    <span className="grid min-w-0 flex-1">
                      <span>{item.name}</span>
                      {item.description && " "}
                      {item.description && (
                        <span
                          className={`text-xs ${item.risky && !itemDisabled ? "text-orange-600/80 dark:text-orange-400/80" : "text-muted-foreground"}`}
                        >
                          {item.description}
                        </span>
                      )}
                    </span>
                    {active && (
                      <Check
                        className={`${item.description ? "mt-0.5" : ""} size-4 shrink-0`}
                        aria-hidden
                      />
                    )}
                  </Menu.Item>
                );
              })}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
