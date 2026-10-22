import { Award, FolderGit2, Gauge, Home, Library, MessageSquareText } from "lucide-react";
import type { SidebarEntry } from "@/components/AppSidebar";
import type { GlobalPage } from "./app-route";

const globalNav: SidebarEntry<GlobalPage>[] = [
  { id: "home", label: "nav.home", icon: Home, shortcut: "navigate-home" },
  {
    id: "workspaces",
    label: "nav.workspaces",
    icon: FolderGit2,
    shortcut: "navigate-workspaces",
  },
  { id: "sessions", label: "sessions.nav", icon: MessageSquareText, shortcut: "navigate-sessions" },
  { id: "catalog", label: "nav.catalog", icon: Library, shortcut: "navigate-catalog" },
  { id: "quota", label: "nav.quota", icon: Gauge, shortcut: "navigate-quota" },
  { id: "insights", label: "nav.insights", icon: Award, shortcut: "navigate-insights" },
];

export function createGlobalNavigation(pendingMemoryCount: number): SidebarEntry<GlobalPage>[] {
  return globalNav.map((entry) =>
    entry.id === "catalog" ? { ...entry, badge: pendingMemoryCount } : entry,
  );
}
