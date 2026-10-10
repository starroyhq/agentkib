import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import {
  ariaShortcut,
  currentAppPlatform,
  formatShortcut,
  getShortcutDefinition,
} from "@/core/keyboard-shortcuts";
import { cn } from "cn";
import { useAppStore } from "@/stores/app-store";
import { ArrowLeft, ArrowRight, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";

const navigationButtonClassName =
  "grid size-6 place-items-center text-[color:color-mix(in_srgb,var(--foreground)_58%,transparent)] transition-[transform,scale,color] duration-180 ease-[cubic-bezier(0.22,1,0.36,1)] enabled:hover:scale-[1.06] enabled:hover:text-foreground enabled:active:scale-[0.92] disabled:text-[color:color-mix(in_srgb,var(--foreground)_28%,transparent)] disabled:cursor-default focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 motion-reduce:transition-none";

export function WindowNavigationControls({
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
  onOpenSearch,
  hasSidebarPanel = true,
  sidebarFixed = false,
}: {
  hasSidebarPanel?: boolean;
  sidebarFixed?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  onOpenSearch?: () => void;
}) {
  const { tr } = useI18n();
  const storedSidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const sidebarCollapsed = !sidebarFixed && storedSidebarCollapsed;
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const platform = currentAppPlatform();
  const backShortcut = getShortcutDefinition("history-back");
  const forwardShortcut = getShortcutDefinition("history-forward");
  const searchShortcut = getShortcutDefinition("open-search");

  return (
    <div className="app-window-navigation-controls">
      <Button
        variant="bare"
        size="content"
        className="app-sidebar-collapse-button max-lg:hidden grid size-6 place-items-center border-0 bg-transparent text-[color:color-mix(in_srgb,var(--sidebar-foreground)_58%,transparent)] transition-[transform,scale,color] duration-180 ease-[cubic-bezier(0.22,1,0.36,1)] pointer-events-auto [-webkit-app-region:no-drag] hover:scale-[1.06] hover:text-sidebar-accent-foreground active:scale-[0.92] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 motion-reduce:transition-none"
        type="button"
        aria-label={tr(sidebarCollapsed ? "common.expandSidebar" : "common.collapseSidebar")}
        aria-keyshortcuts={ariaShortcut(getShortcutDefinition("toggle-sidebar"), platform)}
        aria-expanded={!sidebarCollapsed}
        data-collapsed={sidebarCollapsed}
        disabled={!hasSidebarPanel || sidebarFixed}
        title={tr(sidebarCollapsed ? "common.expandSidebar" : "common.collapseSidebar")}
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
      >
        <span className="app-sidebar-collapse-icon" aria-hidden="true">
          <PanelLeftClose
            className={cn("app-sidebar-collapse-icon-close", sidebarCollapsed && "is-hidden")}
            size={17}
          />
          <PanelLeftOpen
            className={cn("app-sidebar-collapse-icon-open", !sidebarCollapsed && "is-hidden")}
            size={17}
          />
        </span>
      </Button>
      <Button
        variant="bare"
        size="content"
        className={cn("app-history-button", navigationButtonClassName)}
        type="button"
        disabled={!canGoBack}
        aria-label={tr("shortcuts.back")}
        aria-keyshortcuts={ariaShortcut(backShortcut, platform)}
        title={tr("shortcuts.back")}
        onClick={onBack}
      >
        <ArrowLeft size={17} aria-hidden="true" />
      </Button>
      <Button
        variant="bare"
        size="content"
        className={cn("app-history-button", navigationButtonClassName)}
        type="button"
        disabled={!canGoForward}
        aria-label={tr("shortcuts.forward")}
        aria-keyshortcuts={ariaShortcut(forwardShortcut, platform)}
        title={tr("shortcuts.forward")}
        onClick={onForward}
      >
        <ArrowRight size={17} aria-hidden="true" />
      </Button>
      {onOpenSearch && (
        <Button
          variant="bare"
          size="content"
          className={cn("app-global-search-button", navigationButtonClassName)}
          type="button"
          data-global-search-trigger
          aria-label={tr("search.open")}
          aria-keyshortcuts={ariaShortcut(searchShortcut, platform)}
          title={`${tr("search.open")} (${formatShortcut(searchShortcut)})`}
          onClick={onOpenSearch}
        >
          <Search size={17} aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
