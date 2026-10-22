import { useEffect } from "react";
import type { GlobalPage } from "./app-route";
import {
  currentAppPlatform,
  isEditableTarget,
  matchesShortcut,
  shouldHandleInFrontend,
  shortcutDefinitions,
  type ShortcutId,
} from "@/core/keyboard-shortcuts";

export interface AppShortcutActions {
  onNavigate: (page: GlobalPage) => void;
  onOpenSettings: () => void;
  onRefreshCurrent: () => Promise<void>;
  onAddWorkspace: () => Promise<void>;
  onAddScanRoot: () => Promise<void>;
  onToggleSidebar: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onOpenSearch: () => void;
  onOpenHelp: () => void;
  helpOpen: boolean;
}

const navigationByShortcut: Partial<Record<ShortcutId, GlobalPage>> = {
  "navigate-home": "home",
  "navigate-workspaces": "workspaces",
  "navigate-sessions": "sessions",
  "navigate-catalog": "catalog",
  "navigate-quota": "quota",
  "navigate-insights": "insights",
};

export function useAppShortcuts({
  onNavigate,
  onOpenSettings,
  onRefreshCurrent,
  onAddWorkspace,
  onAddScanRoot,
  onToggleSidebar,
  onGoBack,
  onGoForward,
  onOpenSearch,
  onOpenHelp,
  helpOpen,
}: AppShortcutActions) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || helpOpen) return;
      if (isEditableTarget(event.target)) return;
      const platform = currentAppPlatform();
      const definition = shortcutDefinitions.find(
        (candidate) =>
          shouldHandleInFrontend(candidate, platform) &&
          matchesShortcut(event, candidate, platform),
      );
      if (!definition) return;

      event.preventDefault();
      const page = navigationByShortcut[definition.id];
      if (page) {
        onNavigate(page);
        return;
      }
      switch (definition.id) {
        case "open-settings":
          onOpenSettings();
          break;
        case "refresh-current":
          void onRefreshCurrent();
          break;
        case "add-workspace":
          void onAddWorkspace();
          break;
        case "add-scan-root":
          void onAddScanRoot();
          break;
        case "toggle-sidebar":
          onToggleSidebar();
          break;
        case "history-back":
          onGoBack();
          break;
        case "history-forward":
          onGoForward();
          break;
        case "open-search":
          onOpenSearch();
          break;
        case "open-help":
          onOpenHelp();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    helpOpen,
    onAddScanRoot,
    onAddWorkspace,
    onGoBack,
    onGoForward,
    onNavigate,
    onOpenHelp,
    onOpenSearch,
    onOpenSettings,
    onRefreshCurrent,
    onToggleSidebar,
  ]);
}
