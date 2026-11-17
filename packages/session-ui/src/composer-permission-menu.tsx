import { Check, ChevronDown, Shield } from "lucide-react";
import { Menu } from "@base-ui/react/menu";
import { composerButtonClasses } from "./composer-control-style";

interface ComposerPermissionItem {
  id: string;
  name: string;
  description?: string;
  risky?: boolean;
  group?: string;
  disabled?: boolean;
  selected?: boolean;
}

export function ComposerPermissionMenu({
  label,
  title,
  risky = false,
  disabled,
  side,
  items,
  selected,
  onSelect,
  open,
  onOpenChange,
  disabledReason,
  status,
  blockItemsOnStatus = true,
}: {
  label: string;
  title: string;
  risky?: boolean;
  disabled: boolean;
  side: "top" | "bottom";
  items: ComposerPermissionItem[];
  selected?: string;
  onSelect: (id: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabledReason?: string;
  status?: string;
  blockItemsOnStatus?: boolean;
}) {
  const groups = new Map<string, ComposerPermissionItem[]>([[title, []]]);
  for (const item of items) {
    const group = item.group ?? title;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(item);
  }
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger
        className={`${composerButtonClasses} h-11 min-w-0 gap-1.5 rounded-full px-2.5 text-sm font-normal ${risky ? "text-orange-600 hover:text-orange-700" : "text-muted-foreground"}`}
        disabled={disabled}
        title={disabledReason}
        aria-label={title === label ? title : `${title}: ${label}`}
      >
        <Shield className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate @max-[28rem]:sr-only">{label}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side={side} sideOffset={4} align="start" className="isolate z-50">
          <Menu.Popup
            className="max-h-(--available-height) w-72 max-w-[calc(100vw-24px)] overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
            aria-label={title}
          >
            {Array.from(groups, ([group, choices]) => (
              <Menu.Group
                key={group}
                className={group !== title ? "mt-1 border-t pt-1" : undefined}
              >
                <Menu.GroupLabel className="px-1.5 py-1 text-xs font-medium text-muted-foreground">
                  {group}
                </Menu.GroupLabel>
                {status && group === title && (
                  <p role="status" className="px-1.5 py-1 text-xs text-muted-foreground">
                    {status}
                  </p>
                )}
                {choices.map((item) => {
                  const active = item.selected ?? item.id === selected;
                  return (
                    <Menu.Item
                      key={item.id}
                      className={`flex cursor-default items-start gap-1.5 rounded-md px-1.5 py-1 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-50 ${item.risky ? "text-orange-600" : ""}`}
                      disabled={disabled || item.disabled || (blockItemsOnStatus && !!status)}
                      aria-current={active || undefined}
                      onClick={() => onSelect(item.id)}
                    >
                      <span className="grid min-w-0 flex-1">
                        <span>{item.name}</span>
                        {item.description && " "}
                        {item.description && (
                          <span
                            className={`text-xs ${item.risky ? "text-orange-600/80" : "text-muted-foreground"}`}
                          >
                            {item.description}
                          </span>
                        )}
                      </span>
                      {active && <Check className="mt-0.5 size-4" aria-hidden />}
                    </Menu.Item>
                  );
                })}
              </Menu.Group>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
