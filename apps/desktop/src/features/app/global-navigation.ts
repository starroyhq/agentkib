import { Award, FolderGit2, Gauge, Home, Library, MessageSquareText } from "lucide-react";
import type { ComponentType } from "react";
import type { SidebarEntry } from "@/components/AppSidebar";
import {
  AwardSolid,
  FolderGitSolid,
  GaugeSolid,
  HomeSolid,
  LibrarySolid,
  MessageSquareTextSolid,
} from "@/components/SidebarActiveIcons";
import {
  globalNavigationRoutes,
  type GlobalNavigationRouteId,
} from "@/core/global-navigation-routes";
import type { GlobalPage } from "./app-route";

const routeIcons: Record<
  GlobalNavigationRouteId,
  { icon: ComponentType<{ size?: number }>; activeIcon: ComponentType<{ size?: number }> }
> = {
  home: { icon: Home, activeIcon: HomeSolid },
  sessions: { icon: MessageSquareText, activeIcon: MessageSquareTextSolid },
  workspaces: { icon: FolderGit2, activeIcon: FolderGitSolid },
  catalog: { icon: Library, activeIcon: LibrarySolid },
  quota: { icon: Gauge, activeIcon: GaugeSolid },
  insights: { icon: Award, activeIcon: AwardSolid },
};

const globalNav: SidebarEntry<GlobalPage>[] = globalNavigationRoutes.map((route) => ({
  id: route.id,
  label: route.label,
  icon: routeIcons[route.id].icon,
  activeIcon: routeIcons[route.id].activeIcon,
  shortcut: route.shortcutId,
}));

export function createGlobalNavigation(pendingMemoryCount: number): SidebarEntry<GlobalPage>[] {
  return globalNav.map((entry) =>
    entry.id === "catalog" ? { ...entry, badge: pendingMemoryCount } : entry,
  );
}
