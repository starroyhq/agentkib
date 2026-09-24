import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEffect, useId, useState, type ComponentType } from "react";
import {
  Bot,
  ChevronDown,
  Ellipsis,
  FolderGit2,
  Menu,
  MonitorSmartphone,
  Settings,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { SidebarBrand } from "./SidebarBrand";
import { SidebarSearchButton } from "./SidebarSearchButton";
import { useAppStore } from "@/stores/app-store";
import { clearSidebarPeekCloseTimer, scheduleSidebarPeekClose } from "@/features/app/sidebar-peek";
import {
  ariaShortcut,
  currentAppPlatform,
  getShortcutDefinition,
  type ShortcutId,
} from "@/core/keyboard-shortcuts";
import type { WorkspaceSummary } from "@/core/types";
import type { GlobalPage } from "@/features/app/app-route";
import { SessionDirectory } from "@/features/sessions/SessionDirectory";
import { RemoteConnectionPanel } from "@/features/remote/RemoteConnectionPanel";

export interface SidebarEntry<T extends string> {
  id: T;
  label: string;
  icon: ComponentType<{ size?: number }>;
  badge?: number;
  shortcut?: ShortcutId;
}

export type AgentFilter = "all" | "enabled" | "available";

export type AppSidebarContext =
  | { kind: "sessions" }
  | { kind: "global" }
  | {
      kind: "agents";
      filter: AgentFilter;
      onFilterChange: (filter: AgentFilter) => void;
    };

const agentFilters: Array<[AgentFilter, string]> = [
  ["all", "agents.filter.all"],
  ["enabled", "agents.filter.enabled"],
  ["available", "agents.filter.available"],
];

function SidebarSectionLabel({ children }: { children: string }) {
  return <div className="app-sidebar-section-label">{children}</div>;
}

export function AppSidebar(props: {
  active: GlobalPage;
  entries: SidebarEntry<GlobalPage>[];
  onNavigate: (page: GlobalPage) => void;
  onSettings: () => void;
  onRemoteSettings?: () => void;
  onOpenSearch?: () => void;
  searchOpen?: boolean;
  collapsed: boolean;
  context?: AppSidebarContext;
  workspaces?: WorkspaceSummary[];
  favoriteWorkspaceIds?: string[];
  onOpenWorkspace?: (workspace: WorkspaceSummary) => void;
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const { t: tr } = useTranslation();
  const { active, entries, onNavigate, onSettings, collapsed, context } = props;
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    if (props.searchOpen) setMobileOpen(false);
  }, [props.searchOpen]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [directoryMenuOpen, setDirectoryMenuOpen] = useState(false);
  const sidebarPeek = useAppStore((state) => state.sidebarPeek);
  const setSidebarPeek = useAppStore((state) => state.setSidebarPeek);
  const [toolsOpen, setToolsOpen] = useState(
    () =>
      active === "catalog" ||
      active === "quota" ||
      active === "insights" ||
      context?.kind === "global",
  );
  const sidebarId = useId();
  const platform = currentAppPlatform();
  const primaryIds: GlobalPage[] = ["home", "workspaces", "agents", "sessions"];
  const toolIds: GlobalPage[] = ["catalog", "quota", "insights"];
  const primaryEntries = entries.filter((entry) => primaryIds.includes(entry.id));
  const toolEntries = entries.filter((entry) => toolIds.includes(entry.id));

  useEffect(() => {
    setToolsOpen(
      active === "catalog" ||
        active === "quota" ||
        active === "insights" ||
        context?.kind === "global",
    );
  }, [active, context?.kind]);

  const handleSidebarMouseEnter = () => {
    if (!collapsed) return;
    clearSidebarPeekCloseTimer();
    setSidebarPeek(true);
  };

  const handleSidebarMouseLeave = () => {
    if (!collapsed || moreOpen || directoryMenuOpen) return;
    scheduleSidebarPeekClose(setSidebarPeek);
  };

  useEffect(() => {
    if (context?.kind !== "sessions") setDirectoryMenuOpen(false);
  }, [context?.kind]);

  useEffect(() => {
    if (!mobileOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen]);

  const navigate = (page: GlobalPage) => {
    setMobileOpen(false);
    onNavigate(page);
  };

  const renderNavigationEntry = ({
    id,
    label,
    icon: Icon,
    badge,
    shortcut,
  }: SidebarEntry<GlobalPage>) => {
    const shortcutDefinition = shortcut ? getShortcutDefinition(shortcut) : undefined;
    return (
      <Button
        key={id}
        variant="bare"
        size="content"
        className={cn("app-sidebar-item", active === id && "app-sidebar-item-active")}
        aria-current={active === id ? "page" : undefined}
        aria-label={tr(label)}
        aria-keyshortcuts={
          shortcutDefinition ? ariaShortcut(shortcutDefinition, platform) : undefined
        }
        title={tr(label)}
        onClick={() => navigate(id)}
      >
        <span className="app-sidebar-item-icon">
          <Icon size={17} />
        </span>
        <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
          {tr(label)}
        </span>
        {badge ? <em className="app-sidebar-item-badge">{badge}</em> : null}
      </Button>
    );
  };

  return (
    <>
      <Button
        variant="bare"
        size="content"
        className={cn("sidebar-mobile-trigger", mobileOpen && "invisible")}
        type="button"
        aria-expanded={mobileOpen}
        aria-controls={sidebarId}
        aria-label={tr("common.primaryNavigation")}
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
          context?.kind === "sessions" && "app-sidebar-sessions",
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
              <SidebarBrand />
              {props.onOpenSearch && <SidebarSearchButton onOpenSearch={props.onOpenSearch} />}
            </div>
          </div>
          <nav className="app-sidebar-nav" aria-label={tr("common.primaryNavigation")}>
            <div className="app-sidebar-group">{primaryEntries.map(renderNavigationEntry)}</div>

            {active === "workspaces" && !!props.workspaces?.length && (
              <div className="app-sidebar-group app-sidebar-context-group">
                <SidebarSectionLabel>{tr("sidebar.allWorkspaces")}</SidebarSectionLabel>
                {props.workspaces.map((workspace) => (
                  <Button
                    key={workspace.id}
                    variant="bare"
                    size="content"
                    className="app-sidebar-item app-sidebar-context-item"
                    title={workspace.name}
                    onClick={() => {
                      setMobileOpen(false);
                      props.onOpenWorkspace?.(workspace);
                    }}
                  >
                    <span className="app-sidebar-item-icon">
                      <FolderGit2 size={16} />
                    </span>
                    <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
                      {workspace.name}
                    </span>
                    {workspace.status === "attention" && (
                      <span
                        className="app-sidebar-status-dot"
                        aria-label={tr("status.workspace.attention")}
                      />
                    )}
                    <Star
                      size={13}
                      className={cn(
                        "transition-opacity",
                        props.favoriteWorkspaceIds?.includes(workspace.id)
                          ? "fill-current opacity-70"
                          : "opacity-0",
                      )}
                      aria-hidden="true"
                    />
                  </Button>
                ))}
              </div>
            )}

            {context?.kind === "agents" && (
              <div className="app-sidebar-group app-sidebar-context-group">
                <SidebarSectionLabel>{tr("agents.filters")}</SidebarSectionLabel>
                {agentFilters.map(([id, label]) => (
                  <Button
                    key={id}
                    variant="bare"
                    size="content"
                    className={cn(
                      "app-sidebar-item",
                      context.filter === id && "app-sidebar-item-active",
                    )}
                    onClick={() => context.onFilterChange(id)}
                  >
                    <span className="app-sidebar-item-icon">
                      {id === "all" ? <Bot size={16} /> : <SlidersHorizontal size={16} />}
                    </span>
                    <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
                      {tr(label)}
                    </span>
                  </Button>
                ))}
              </div>
            )}

            <Collapsible open={toolsOpen} onOpenChange={setToolsOpen}>
              <div className="app-sidebar-group app-sidebar-tools">
                <CollapsibleTrigger
                  render={
                    <Button variant="bare" size="content" className="app-sidebar-section-trigger" />
                  }
                >
                  <span>{tr("sidebar.tools")}</span>
                  <ChevronDown
                    className={cn("transition-transform", toolsOpen && "rotate-180")}
                    size={14}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="app-sidebar-collapsible-content">
                  {toolEntries.map(renderNavigationEntry)}
                </CollapsibleContent>
              </div>
            </Collapsible>
          </nav>
          {context?.kind === "sessions" && (
            <div
              className="app-sidebar-session-directory"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("[data-session-entry]")) {
                  setMobileOpen(false);
                }
              }}
            >
              <SessionDirectory
                onMenuOpenChange={(open) => {
                  setDirectoryMenuOpen(open);
                  if (open) clearSidebarPeekCloseTimer();
                  else if (collapsed && !moreOpen) scheduleSidebarPeekClose(setSidebarPeek);
                }}
              />
            </div>
          )}
          <div className="app-sidebar-footer">
            <DropdownMenu
              open={moreOpen}
              onOpenChange={(open) => {
                setMoreOpen(open);
                if (open) clearSidebarPeekCloseTimer();
                else if (collapsed && !directoryMenuOpen) scheduleSidebarPeekClose(setSidebarPeek);
              }}
            >
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="bare"
                    size="content"
                    className="app-sidebar-item app-sidebar-more-entry"
                    type="button"
                    aria-label={tr("sessions.more")}
                    title={tr("sessions.more")}
                  />
                }
              >
                <span className="app-sidebar-item-icon">
                  <Ellipsis size={18} />
                </span>
                <span className="app-sidebar-item-label min-w-0 flex-1 text-left">
                  {tr("sessions.more")}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                className="min-w-48"
                positionerClassName="z-80"
              >
                <DropdownMenuItem
                  aria-keyshortcuts={ariaShortcut(getShortcutDefinition("open-settings"), platform)}
                  onClick={() => {
                    setMobileOpen(false);
                    onSettings();
                  }}
                >
                  <Settings size={17} />
                  {tr("nav.settings")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setMoreOpen(false);
                    setMobileOpen(false);
                    setRemoteOpen(true);
                  }}
                >
                  <MonitorSmartphone size={17} />
                  {tr("sessions.remote")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </aside>
      {remoteOpen && (
        <RemoteConnectionPanel
          open={remoteOpen}
          onOpenChange={setRemoteOpen}
          onSettings={() => {
            setRemoteOpen(false);
            (props.onRemoteSettings ?? onSettings)();
          }}
        />
      )}
    </>
  );
}
