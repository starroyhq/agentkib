import { Check, ChevronDown, LoaderCircle, Shield } from "lucide-react";
import { Menu } from "@base-ui/react/menu";
import { composerButtonClasses } from "./composer-control-style";
import { IconAction } from "./icon-action";
import { useDelayedBusy } from "./delayed-busy";

interface ComposerPermissionItem {
  id: string;
  name: string;
  risky?: boolean;
  disabled?: boolean;
  selected?: boolean;
}

type PermissionMenuProps = {
  label?: string;
  title: string;
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
};

export function ComposerPermissionMenu({
  label,
  title,
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
            className={`${composerButtonClasses} ${size} disabled:opacity-50 disabled:grayscale ${risky ? "text-orange-600 hover:text-orange-700" : "text-muted-foreground"} ${compact || label ? "" : "relative after:invisible after:ps-10 after:content-[attr(aria-label)] @max-[28rem]:after:hidden"}`}
            disabled={disabled}
            aria-busy={saving || undefined}
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
            className="max-h-(--available-height) min-w-48 max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-border/80 outline-none"
            aria-label={title}
          >
            <Menu.Group>
              <Menu.GroupLabel className="px-1.5 py-1 text-xs font-medium text-muted-foreground">
                {title}
              </Menu.GroupLabel>
              {items.map((item) => {
                const active = item.selected ?? item.id === selected;
                return (
                  <Menu.Item
                    key={item.id}
                    className={`flex cursor-default items-center gap-2 rounded-md px-1.5 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-50 data-disabled:grayscale ${item.risky ? "text-orange-600" : ""}`}
                    disabled={disabled || item.disabled}
                    aria-current={active || undefined}
                    onClick={() => onSelect(item.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    {active && <Check className="size-4 shrink-0" aria-hidden />}
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
