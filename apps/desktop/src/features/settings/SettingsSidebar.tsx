import { navigationStyles } from "@/components/navigationStyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ComponentType } from "react";
import {
  Database,
  FolderSearch,
  Keyboard,
  MonitorSmartphone,
  PackageSearch,
  Palette,
  PlugZap,
  Search,
  Settings2,
  Stethoscope,
  X,
} from "lucide-react";
import { tr } from "@/core/i18n";
import { cn } from "cn";
import { useSidebarViewStore } from "@/features/app/sidebar-view-store";
import { focusSettingsTarget } from "./components/SettingsLayout";

export type SettingsSection =
  | "general"
  | "appearance"
  | "shortcuts"
  | "discovery"
  | "tools"
  | "remote"
  | "integrations"
  | "privacy"
  | "diagnostics";

export const settingsTargets = [
  "general-interface",
  "general-quota",
  "appearance-mode",
  "appearance-theme",
  "shortcuts-list",
  "discovery-status",
  "discovery-sources",
  "discovery-roots",
  "discovery-excluded",
  "tools-app",
  "tools-environment",
  "tools-actions",
  "remote-access",
  "remote-devices",
  "integrations-mcp",
  "integrations-gateways",
  "integrations-obsidian",
  "privacy-local",
  "privacy-sessions",
  "privacy-git",
  "diagnostics-overview",
  "diagnostics-quota",
  "diagnostics-providers",
  "diagnostics-activity",
] as const;

export type SettingsTarget = (typeof settingsTargets)[number];

const sections: Array<{
  id: SettingsSection;
  label: string;
  icon: ComponentType<{ size?: number }>;
}> = [
  { id: "general", label: "settings.section.general", icon: Settings2 },
  { id: "appearance", label: "settings.section.appearance", icon: Palette },
  { id: "shortcuts", label: "settings.section.shortcuts", icon: Keyboard },
  { id: "discovery", label: "settings.section.discovery", icon: FolderSearch },
  { id: "tools", label: "settings.section.tools", icon: PackageSearch },
  { id: "remote", label: "settings.section.remote", icon: MonitorSmartphone },
  { id: "integrations", label: "settings.section.integrations", icon: PlugZap },
  { id: "privacy", label: "settings.section.privacy", icon: Database },
  { id: "diagnostics", label: "settings.section.diagnostics", icon: Stethoscope },
];

const searchEntries: Array<{
  section: SettingsSection;
  target: SettingsTarget;
  label: string;
  keywords: string[];
}> = [
  {
    section: "remote",
    target: "remote-access",
    label: "remote.access",
    keywords: ["remote.pair", "remote.address"],
  },
  {
    section: "remote",
    target: "remote-devices",
    label: "remote.authorized",
    keywords: ["remote.revoke", "remote.connections"],
  },
  {
    section: "general",
    target: "general-interface",
    label: "settings.interface",
    keywords: ["settings.appIcon", "settings.language", "settings.closeBehavior"],
  },
  {
    section: "appearance",
    target: "appearance-mode",
    label: "settings.theme",
    keywords: ["settings.theme.light", "settings.theme.dark", "settings.theme.system"],
  },
  {
    section: "appearance",
    target: "appearance-theme",
    label: "settings.accentTheme",
    keywords: [
      "settings.accentTheme.description",
      "settings.accentTheme.minimal-neutral",
      "settings.accentTheme.vtron",
      "settings.accentTheme.claude",
      "settings.accentTheme.sakura",
      "settings.accentTheme.ocean-breeze",
    ],
  },
  {
    section: "shortcuts",
    target: "shortcuts-list",
    label: "settings.shortcutsTitle",
    keywords: [
      "settings.shortcuts",
      "shortcuts.title",
      "shortcuts.group.navigation",
      "shortcuts.group.actions",
    ],
  },
  {
    section: "general",
    target: "general-quota",
    label: "settings.quotaTitle",
    keywords: ["settings.quotaAutoRefresh"],
  },
  {
    section: "discovery",
    target: "discovery-status",
    label: "settings.discovery",
    keywords: ["settings.discoveryStatus"],
  },
  {
    section: "discovery",
    target: "discovery-roots",
    label: "settings.scanRoots",
    keywords: ["settings.addFolder", "settings.maxDepth"],
  },
  {
    section: "discovery",
    target: "discovery-sources",
    label: "settings.discoverySources",
    keywords: ["settings.discoveryDetails", "settings.discoveryReasons"],
  },
  {
    section: "discovery",
    target: "discovery-excluded",
    label: "settings.excluded",
    keywords: ["settings.noExcluded"],
  },
  {
    section: "tools",
    target: "tools-app",
    label: "settings.updates",
    keywords: ["settings.checkForUpdates"],
  },
  {
    section: "tools",
    target: "tools-environment",
    label: "settings.tools.localEnvironment",
    keywords: ["settings.tools.environmentDescription"],
  },
  {
    section: "tools",
    target: "tools-actions",
    label: "settings.search.updateActions",
    keywords: ["settings.tools.batchDescription", "settings.tools.manualCommand"],
  },
  {
    section: "integrations",
    target: "integrations-mcp",
    label: "settings.search.localService",
    keywords: ["mcp.network"],
  },
  {
    section: "integrations",
    target: "integrations-gateways",
    label: "gateway.title",
    keywords: ["gateway.add"],
  },
  {
    section: "integrations",
    target: "integrations-obsidian",
    label: "obsidian.title",
    keywords: ["obsidian.addVault"],
  },
  {
    section: "privacy",
    target: "privacy-local",
    label: "settings.localData",
    keywords: ["settings.dataLocation", "settings.appDataAccess"],
  },
  {
    section: "privacy",
    target: "privacy-sessions",
    label: "conversations.settingsTitle",
    keywords: ["conversations.indexSetting", "conversations.clearIndex"],
  },
  {
    section: "privacy",
    target: "privacy-git",
    label: "settings.gitIdentity",
    keywords: ["settings.addAlias"],
  },
  {
    section: "diagnostics",
    target: "diagnostics-overview",
    label: "settings.search.overallHealth",
    keywords: ["settings.section.diagnostics"],
  },
  {
    section: "diagnostics",
    target: "diagnostics-quota",
    label: "quota.diagnostics",
    keywords: ["quota.collector", "quota.sidecar"],
  },
  {
    section: "diagnostics",
    target: "diagnostics-providers",
    label: "settings.providerStatus",
    keywords: ["insights.noData"],
  },
  {
    section: "diagnostics",
    target: "diagnostics-activity",
    label: "activity.title",
    keywords: ["activity.emptyText"],
  },
];

/**
 * 设置页的二级导航，嵌在主侧边栏的上下文面板里（见 routes/__root.tsx）。
 * 窄窗口抽屉、折叠与返回按钮都由 AppSidebar 负责；搜索词保存在 sidebar-view-store，
 * 在设置页之间切换时保留。
 */
export function SettingsSidebar(props: {
  active: SettingsSection;
  activeTarget?: SettingsTarget;
  onSelect: (section: SettingsSection, target?: SettingsTarget) => void;
}) {
  const { t: tr } = useTranslation();
  const { active, activeTarget, onSelect } = props;
  const query = useSidebarViewStore((state) => state.settingsQuery);
  const setQuery = useSidebarViewStore((state) => state.setSettingsQuery);

  const select = (section: SettingsSection, target?: SettingsTarget) => {
    if (target && active === section && activeTarget === target && focusSettingsTarget(target)) {
      return;
    }
    onSelect(section, target);
  };

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const results = normalizedQuery
    ? searchEntries.filter((entry) =>
        [
          tr(`settings.section.${entry.section}`),
          tr(entry.label),
          ...entry.keywords.map((key) => tr(key)),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
    : [];

  return (
    <div className="settings-sidebar-content">
      <div className="app-sidebar-header">
        <label className="relative block">
          <Search
            size={16}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            className="h-10 rounded-xl border-transparent bg-muted/70 pl-9 pr-9 shadow-none focus-visible:border-input focus-visible:bg-background"
            value={query}
            type="search"
            placeholder={tr("settings.search.placeholder")}
            aria-label={tr("settings.search.placeholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <Button
              variant="bare"
              size="content"
              className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              type="button"
              aria-label={tr("settings.search.clear")}
              onClick={() => setQuery("")}
            >
              <X size={14} />
            </Button>
          )}
        </label>
      </div>
      <nav className="app-sidebar-nav" aria-label={tr("settings.navigation")}>
        {!normalizedQuery &&
          sections.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              data-sidebar-navigate
              variant="bare"
              size="content"
              className={cn(
                navigationStyles.appSidebarItem,
                active === id && navigationStyles.appSidebarItemActive,
              )}
              aria-current={active === id ? "page" : undefined}
              title={tr(label)}
              onClick={() => select(id)}
            >
              <span className={navigationStyles.appSidebarItemIcon}>
                <Icon size={18} />
              </span>
              <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
                {tr(label)}
              </span>
            </Button>
          ))}
        {normalizedQuery &&
          sections.map(({ id, label }) => {
            const sectionResults = results.filter((result) => result.section === id);
            if (!sectionResults.length) return null;
            return (
              <section className="app-sidebar-group grid gap-0.5 mt-1" key={id}>
                <p className="px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
                  {tr(label)}
                </p>
                {sectionResults.map((result) => (
                  <Button
                    key={result.target}
                    data-sidebar-navigate
                    variant="bare"
                    size="content"
                    className={cn(
                      navigationStyles.appSidebarItem,
                      "min-h-10 pl-3",
                      active === id &&
                        activeTarget === result.target &&
                        navigationStyles.appSidebarItemActive,
                    )}
                    aria-current={
                      active === id && activeTarget === result.target ? "location" : undefined
                    }
                    title={tr(result.label)}
                    onClick={() => select(id, result.target)}
                  >
                    <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
                      {tr(result.label)}
                    </span>
                  </Button>
                ))}
              </section>
            );
          })}
        {normalizedQuery && !results.length && (
          <p className="px-3 py-6 text-center text-xs leading-relaxed text-muted-foreground">
            {tr("settings.search.empty")}
          </p>
        )}
      </nav>
    </div>
  );
}

export function settingsSectionLabel(section: SettingsSection) {
  return tr(`settings.section.${section}`);
}
