import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SidebarSearchButton } from "@/components/SidebarSearchButton";
import { useEffect, useId, useState, type ComponentType } from "react";
import {
  ArrowLeft,
  Database,
  FolderSearch,
  Menu,
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
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { clearSidebarPeekCloseTimer, scheduleSidebarPeekClose } from "@/features/app/sidebar-peek";
import { focusSettingsTarget } from "./components/SettingsLayout";

export type SettingsSection =
  | "general"
  | "appearance"
  | "discovery"
  | "tools"
  | "remote"
  | "integrations"
  | "privacy"
  | "diagnostics";

export const settingsTargets = [
  "general-interface",
  "general-shortcuts",
  "general-quota",
  "appearance-mode",
  "appearance-theme",
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
    keywords: [
      "settings.appIcon",
      "settings.language",
      "settings.closeBehavior",
    ],
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
    section: "general",
    target: "general-shortcuts",
    label: "settings.shortcutsTitle",
    keywords: ["settings.shortcuts", "settings.viewShortcuts"],
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

export function SettingsSidebar(props: {
  active: SettingsSection;
  activeTarget?: SettingsTarget;
  onSelect: (section: SettingsSection, target?: SettingsTarget) => void;
  onBack: () => void;
  onOpenSearch?: () => void;
  searchOpen?: boolean;
  onSettings?: () => void;
  collapsed: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const { t: tr } = useTranslation();
  const { active, activeTarget, onSelect, onBack, collapsed } = props;
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    if (props.searchOpen) setMobileOpen(false);
  }, [props.searchOpen]);
  const [query, setQuery] = useState("");
  const sidebarPeek = useAppStore((state) => state.sidebarPeek);
  const setSidebarPeek = useAppStore((state) => state.setSidebarPeek);
  const sidebarId = useId();

  useEffect(() => {
    if (!mobileOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen]);

  const handleSidebarMouseEnter = () => {
    if (!collapsed) return;
    clearSidebarPeekCloseTimer();
    setSidebarPeek(true);
  };

  const handleSidebarMouseLeave = () => {
    if (!collapsed) return;
    scheduleSidebarPeekClose(setSidebarPeek);
  };

  const select = (section: SettingsSection, target?: SettingsTarget) => {
    setMobileOpen(false);
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
    <>
      <Button
        variant="bare"
        size="content"
        className={cn("sidebar-mobile-trigger", mobileOpen && "invisible")}
        type="button"
        aria-expanded={mobileOpen}
        aria-controls={sidebarId}
        aria-label={tr("settings.navigation")}
        onClick={() => setMobileOpen(true)}
      >
        <Menu size={19} />
      </Button>
      {mobileOpen && (
        <Button
          variant="bare"
          size="content"
          className="sidebar-mobile-backdrop"
          type="button"
          aria-label={tr("common.close")}
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        id={sidebarId}
        className={cn(
          "app-sidebar",
          collapsed && "app-sidebar-collapsed",
          collapsed && sidebarPeek && "app-sidebar-peek",
          mobileOpen && "app-sidebar-open",
        )}
        onPointerEnter={handleSidebarMouseEnter}
        onPointerLeave={handleSidebarMouseLeave}
      >
        <div className="app-sidebar-content">
          <div className="app-sidebar-header">
            <div className="app-sidebar-header-row">
              <Button
                variant="bare"
                size="content"
                className="app-sidebar-item app-sidebar-back-item app-settings-back"
                type="button"
                title={tr("settings.backToApp")}
                onClick={() => {
                  setMobileOpen(false);
                  onBack();
                }}
              >
                <span className="app-sidebar-item-icon">
                  <ArrowLeft size={18} />
                </span>
                <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
                  {tr("settings.backToApp")}
                </span>
              </Button>
              {props.onOpenSearch && <SidebarSearchButton onOpenSearch={props.onOpenSearch} />}
            </div>
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
                  variant="bare"
                  size="content"
                  className={cn("app-sidebar-item", active === id && "app-sidebar-item-active")}
                  aria-current={active === id ? "page" : undefined}
                  title={tr(label)}
                  onClick={() => select(id)}
                >
                  <span className="app-sidebar-item-icon">
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
                  <section className="app-sidebar-group mt-1" key={id}>
                    <p className="px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
                      {tr(label)}
                    </p>
                    {sectionResults.map((result) => (
                      <Button
                        key={result.target}
                        variant="bare"
                        size="content"
                        className={cn(
                          "app-sidebar-item min-h-10 pl-3",
                          active === id &&
                            activeTarget === result.target &&
                            "app-sidebar-item-active",
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
      </aside>
    </>
  );
}

export function settingsSectionLabel(section: SettingsSection) {
  return tr(`settings.section.${section}`);
}
