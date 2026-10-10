import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ariaShortcut,
  currentAppPlatform,
  formatShortcut,
  getShortcutDefinition,
} from "@/core/keyboard-shortcuts";
import { cn } from "cn";

export function SidebarSearchButton({
  onOpenSearch,
  className,
}: {
  onOpenSearch: () => void;
  className?: string;
}) {
  const { t: tr } = useTranslation();
  const shortcut = getShortcutDefinition("open-search");
  return (
    <Button
      variant="bare"
      size="content"
      type="button"
      data-global-search-trigger
      className={cn(
        "sidebar-search-button grid size-8 shrink-0 place-items-center rounded-[0.5rem] text-muted-foreground [-webkit-app-region:no-drag] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
        className,
      )}
      aria-label={tr("search.open")}
      aria-keyshortcuts={ariaShortcut(shortcut, currentAppPlatform())}
      title={`${tr("search.open")} (${formatShortcut(shortcut)})`}
      onClick={onOpenSearch}
    >
      <Search size={18} aria-hidden="true" />
    </Button>
  );
}
