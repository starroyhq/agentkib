import { Check, ChevronDown, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "cn";

const chip =
  "min-w-0 gap-1.5 rounded-full px-2.5 text-sm font-normal text-muted-foreground hover:text-foreground";

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
}: {
  label: string;
  title: string;
  risky?: boolean;
  disabled: boolean;
  side: "top" | "bottom";
  items: { id: string; name: string; description: string; risky?: boolean }[];
  selected?: string;
  onSelect: (id: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabledReason?: string;
  status?: string;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className={cn(chip, "h-11", risky && "text-orange-600 hover:text-orange-700")}
            disabled={disabled}
            title={disabledReason}
          />
        }
        aria-label={`${title}: ${label}`}
      >
        <Shield className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate @max-[28rem]:sr-only">{label}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{title}</DropdownMenuLabel>
          {status && <p className="px-1.5 py-1 text-xs text-muted-foreground">{status}</p>}
          {items.map((item) => (
            <DropdownMenuItem
              key={item.id}
              className={cn("items-start", item.risky && "text-orange-600")}
              disabled={disabled || !!status}
              onClick={() => onSelect(item.id)}
            >
              <span className="grid min-w-0 flex-1">
                <span>{item.name}</span>
                <span
                  className={cn(
                    "text-xs",
                    item.risky ? "text-orange-600/80" : "text-muted-foreground",
                  )}
                >
                  {item.description}
                </span>
              </span>
              {item.id === selected && <Check className="mt-0.5 size-4" aria-hidden />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
