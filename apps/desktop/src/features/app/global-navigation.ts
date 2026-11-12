import { Award, FolderGit2, Gauge, Home, Library, MessageSquareText } from "lucide-react";
import type { SidebarEntry } from "@/components/AppSidebar";
import {
  AwardSolid,
  FolderGitSolid,
  GaugeSolid,
  HomeSolid,
  LibrarySolid,
  MessageSquareTextSolid,
} from "@/components/SidebarActiveIcons";
import type { GlobalPage } from "./app-route";

const globalNav: SidebarEntry<GlobalPage>[] = [
  { id: "home", label: "nav.home", icon: Home, activeIcon: HomeSolid, shortcut: "navigate-home" },
  {
    id: "sessions",
    label: "sessions.nav",
    icon: MessageSquareText,
    activeIcon: MessageSquareTextSolid,
    shortcut: "navigate-sessions",
  },
  {
    id: "workspaces",
    label: "nav.workspaces",
    icon: FolderGit2,
    activeIcon: FolderGitSolid,
    shortcut: "navigate-workspaces",
  },
  {
    id: "catalog",
    label: "nav.catalog",
    icon: Library,
    activeIcon: LibrarySolid,
    shortcut: "navigate-catalog",
  },
  {
    id: "quota",
    label: "nav.quota",
    icon: Gauge,
    activeIcon: GaugeSolid,
    shortcut: "navigate-quota",
  },
  {
    id: "insights",
    label: "nav.insights",
    icon: Award,
    activeIcon: AwardSolid,
    shortcut: "navigate-insights",
  },
];

export function createGlobalNavigation(pendingMemoryCount: number): SidebarEntry<GlobalPage>[] {
  return globalNav.map((entry) =>
    entry.id === "catalog" ? { ...entry, badge: pendingMemoryCount } : entry,
  );
}
