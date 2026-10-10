import { navigationStyles } from "@/components/navigationStyles";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  Bot,
  ChevronRight,
  FolderGit2,
  GitCompareArrows,
  Menu,
  MonitorSmartphone,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Star,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "cn";
import { SidebarSearchButton } from "./SidebarSearchButton";
import { useAppStore } from "@/stores/app-store";
import {
  ariaShortcut,
  currentAppPlatform,
  formatShortcut,
  getShortcutDefinition,
  type ShortcutId,
} from "@/core/keyboard-shortcuts";
import type { WorkspaceSummary } from "@/core/types";
import type { GlobalPage, Page } from "@/features/app/app-route";
import { useRetainedScroll } from "@/features/app/useRetainedScroll";
import { SidebarPanelTarget } from "@/features/app/SidebarPanel";
import { useSidebarViewStore } from "@/features/app/sidebar-view-store";
import {
  workspaceTaskEntries,
  workspaceDevelopmentEntries,
} from "@/features/workspace/workspace-navigation";
import { SessionDirectory } from "@/features/sessions/SessionDirectory";
import { RemoteConnectionPanel } from "@/features/remote/RemoteConnectionPanel";
import logo from "../../resources/assets/agentkib-icon-mark.png";

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
  | { kind: "agents"; filter: AgentFilter; onFilterChange: (filter: AgentFilter) => void };

// 与 styles.css 中窄窗口抽屉的断点（max-width: 1023px）一致。
const DESKTOP_LAYOUT_QUERY = "(min-width: 1024px)";

const agentFilters: Array<[AgentFilter, string]> = [
  ["all", "agents.filter.all"],
  ["enabled", "agents.filter.enabled"],
  ["available", "agents.filter.available"],
];

export function AppSidebar(props: {
  active: GlobalPage | "settings";
  entries: SidebarEntry<GlobalPage>[];
  onNavigate: (page: GlobalPage) => void;
  onSettings: () => void;
  onRemoteSettings?: () => void;
  onOpenSearch?: () => void;
  onRefresh?: () => void;
  searchOpen?: boolean;
  collapsed: boolean;
  context?: AppSidebarContext;
  workspaces?: WorkspaceSummary[];
  workspacesPending?: boolean;
  workspacesError?: string;
  onRetryWorkspaces?: () => void;
  favoriteWorkspaceIds?: string[];
  onOpenWorkspace?: (workspace: WorkspaceSummary, page?: Page) => void;
  onCollapsedChange?: (collapsed: boolean) => void;
  activeWorkspaceId?: string;
  workspacePage?: Page;
  changeCount?: number;
  onWorkspaceNavigate?: (page: Page) => void;
  secondary?: ReactNode;
}) {
  const { t: tr } = useTranslation();
  const { active, context, collapsed } = props;
  const hasPanel = ["workspaces", "sessions", "agents", "catalog", "settings"].includes(active);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const sidebarId = useId();
  const panelId = useId();
  const asideRef = useRef<HTMLElement>(null);
  const [scrollOffsets] = useState(() => new Map<string, number>());
  const scrollRef = useRetainedScroll(active, scrollOffsets);
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const expandedWorkspaces = useSidebarViewStore((state) => state.expandedWorkspaces);
  const setWorkspaceExpanded = useSidebarViewStore((state) => state.setWorkspaceExpanded);
  const platform = currentAppPlatform();

  useEffect(() => {
    if (props.searchOpen || active === "settings") setMobileOpen(false);
  }, [active, props.searchOpen]);
  useEffect(() => {
    if (
      props.activeWorkspaceId &&
      !(props.activeWorkspaceId in useSidebarViewStore.getState().expandedWorkspaces)
    )
      setWorkspaceExpanded(props.activeWorkspaceId, true);
  }, [props.activeWorkspaceId, setWorkspaceExpanded]);

  useEffect(() => {
    const desktop = window.matchMedia(DESKTOP_LAYOUT_QUERY);
    const closeOnDesktop = () => {
      if (desktop.matches) setMobileOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    const aside = asideRef.current;
    const closeAfterSelection = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-sidebar-navigate], [data-session-entry], [role=tab]")
      )
        setMobileOpen(false);
    };
    aside?.addEventListener("click", closeAfterSelection);
    return () => aside?.removeEventListener("click", closeAfterSelection);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const getButtons = () =>
      Array.from(
        asideRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, [tabindex="0"], a[href]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    getButtons()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
      }
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const buttons = getButtons();
      const first = buttons[0];
      const last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [mobileOpen]);

  const expandPanel = () => {
    setSidebarCollapsed(false);
    props.onCollapsedChange?.(false);
  };
  const navigate = (page: GlobalPage) => {
    const needsPanel = ["workspaces", "sessions", "agents", "catalog"].includes(page);
    if (needsPanel && active !== "settings") {
      // 窄窗口抽屉里面板本来就展开；只有桌面布局才需要（并持久化）展开偏好，
      // 否则在抽屉里点一下会悄悄改掉桌面端的折叠设置。
      if (window.matchMedia(DESKTOP_LAYOUT_QUERY).matches) expandPanel();
    } else setMobileOpen(false);
    props.onNavigate(page);
  };
  const panelTitle =
    active === "settings"
      ? tr("nav.settings")
      : tr(props.entries.find((entry) => entry.id === active)?.label ?? "nav.workspaces");
  const renderWorkspaceEntry = ({
    page,
    label,
    icon: Icon,
  }: (typeof workspaceTaskEntries)[number] | (typeof workspaceDevelopmentEntries)[number]) => (
    <Button
      key={page}
      variant="bare"
      size="content"
      data-sidebar-navigate
      className={cn(
        navigationStyles.appSidebarItem,
        "workspace-sidebar-child min-h-[34px] gap-2 py-[7px] px-2 text-xs!",
        props.workspacePage === page && navigationStyles.appSidebarItemActive,
      )}
      aria-current={props.workspacePage === page ? "page" : undefined}
      onClick={() => props.onWorkspaceNavigate?.(page)}
    >
      <Icon size={15} />
      <span className="truncate">{tr(label)}</span>
    </Button>
  );

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
        data-sidebar-mobile-trigger=""
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
        ref={asideRef}
        role={mobileOpen ? "dialog" : undefined}
        aria-modal={mobileOpen || undefined}
        // 只有作为抽屉对话框时才需要名称；否则内部的 <nav> 已经叫"主导航"，
        // 再给 aside 同名会出现两个同名地标。
        aria-label={mobileOpen ? tr("common.primaryNavigation") : undefined}
        className={cn(
          "app-sidebar app-sidebar-dual",
          active === "sessions" && "app-sidebar-sessions",
          collapsed && "app-sidebar-panel-collapsed",
          !hasPanel && "app-sidebar-no-panel",
          mobileOpen && "app-sidebar-open",
        )}
      >
        <div className="app-activity-bar">
          <div className="activity-bar-brand grid size-[38px] place-items-center [&_img]:size-6 [&_img]:object-contain">
            <img src={logo} alt="" aria-hidden="true" />
            <span className="sr-only">AgentKib</span>
          </div>
          {props.onOpenSearch && (
            <SidebarSearchButton
              onOpenSearch={props.onOpenSearch}
              className="activity-bar-search"
            />
          )}
          <nav
            className="activity-bar-navigation flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto [scrollbar-width:none]"
            aria-label={tr("common.primaryNavigation")}
          >
            {props.entries.map(({ id, label, icon: Icon, badge, shortcut }) => {
              const translatedLabel = tr(label);

              return (
                <Tooltip key={id}>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="bare"
                        size="content"
                        className={cn(
                          "activity-bar-item",
                          active === id && "activity-bar-item-active",
                        )}
                        aria-label={translatedLabel}
                        aria-current={active === id ? "page" : undefined}
                        aria-keyshortcuts={
                          shortcut
                            ? ariaShortcut(getShortcutDefinition(shortcut), platform)
                            : undefined
                        }
                        aria-controls={
                          ["workspaces", "sessions", "agents", "catalog"].includes(id)
                            ? panelId
                            : undefined
                        }
                        onClick={() => navigate(id)}
                      >
                        <Icon size={20} />
                        <span className="sr-only">{translatedLabel}</span>
                        {!!badge && (
                          <em className="activity-bar-badge absolute top-px right-0 min-w-[15px] h-[15px] px-[3px] rounded-[8px] bg-sidebar-primary text-sidebar-primary-foreground text-[9px] leading-[15px] not-italic">
                            {badge}
                          </em>
                        )}
                      </Button>
                    }
                  />
                  <TooltipContent side="right">{translatedLabel}</TooltipContent>
                </Tooltip>
              );
            })}
          </nav>
          <div className="activity-bar-footer flex flex-col gap-1.5">
            {props.onRefresh && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="bare"
                      size="content"
                      className="activity-bar-item"
                      type="button"
                      aria-label={tr("menu.refreshCurrent")}
                      aria-keyshortcuts={ariaShortcut(
                        getShortcutDefinition("refresh-current"),
                        platform,
                      )}
                      title={`${tr("menu.refreshCurrent")} (${formatShortcut(getShortcutDefinition("refresh-current"), platform)})`}
                      onClick={() => {
                        setMobileOpen(false);
                        props.onRefresh?.();
                      }}
                    >
                      <RefreshCw size={19} />
                      <span className="sr-only">{tr("menu.refreshCurrent")}</span>
                    </Button>
                  }
                />
                <TooltipContent side="right">{tr("menu.refreshCurrent")}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="bare"
                    size="content"
                    className="activity-bar-item"
                    aria-label={tr("sessions.remote")}
                    onClick={() => {
                      setMobileOpen(false);
                      setRemoteOpen(true);
                    }}
                  >
                    <MonitorSmartphone size={19} />
                    <span className="sr-only">{tr("sessions.remote")}</span>
                  </Button>
                }
              />
              <TooltipContent side="right">{tr("sessions.remote")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="bare"
                    size="content"
                    className={cn(
                      "activity-bar-item",
                      active === "settings" && "activity-bar-item-active",
                    )}
                    aria-label={tr("nav.settings")}
                    aria-current={active === "settings" ? "page" : undefined}
                    aria-keyshortcuts={ariaShortcut(
                      getShortcutDefinition("open-settings"),
                      platform,
                    )}
                    onClick={() => {
                      setMobileOpen(false);
                      props.onSettings();
                    }}
                  >
                    <Settings size={20} />
                    <span className="sr-only">{tr("nav.settings")}</span>
                  </Button>
                }
              />
              <TooltipContent side="right">{tr("nav.settings")}</TooltipContent>
            </Tooltip>
            <Button
              variant="bare"
              size="content"
              className="activity-bar-item activity-bar-mobile-close"
              aria-label={tr("common.close")}
              onClick={() => setMobileOpen(false)}
            >
              <X size={19} />
            </Button>
          </div>
        </div>
        <div
          id={panelId}
          className="app-context-sidebar"
          inert={!hasPanel || (collapsed && !mobileOpen)}
        >
          <div className="app-sidebar-content">
            {active !== "sessions" && (
              <div className="app-sidebar-header">
                <h2 className="context-sidebar-title m-0 px-2 text-[14px] font-[650] text-sidebar-foreground">
                  {panelTitle}
                </h2>
              </div>
            )}
            <div
              ref={scrollRef}
              className={cn(
                "context-sidebar-scroll",
                active === "sessions" && "flex flex-col !overflow-hidden",
              )}
            >
              {active === "workspaces" && (
                <nav
                  className="workspace-sidebar-directory grid gap-1.5"
                  aria-label={tr("sidebar.allWorkspaces")}
                >
                  {(props.workspaces ?? []).map((workspace) => {
                    const selected = props.activeWorkspaceId === workspace.id;
                    const expanded = expandedWorkspaces[workspace.id] ?? selected;
                    return (
                      <div key={workspace.id} className="workspace-sidebar-group">
                        <div
                          className={cn(
                            "workspace-sidebar-row flex items-center rounded-[8px]",
                            selected &&
                              "workspace-sidebar-row-active bg-[color-mix(in_srgb,var(--sidebar-accent)_50%,transparent)]",
                          )}
                        >
                          <Button
                            variant="bare"
                            size="content"
                            className="workspace-sidebar-toggle grid w-[22px] h-9 flex-[0_0_22px] place-items-center text-muted-foreground rounded-[6px] [&_svg]:transition-transform [&_svg]:duration-160 [&_svg]:ease-[ease] motion-reduce:[&_svg]:transition-none"
                            aria-label={tr(
                              expanded ? "sidebar.collapseWorkspace" : "sidebar.expandWorkspace",
                              { name: workspace.name },
                            )}
                            aria-expanded={expanded}
                            onClick={() => setWorkspaceExpanded(workspace.id, !expanded)}
                          >
                            <ChevronRight size={14} className={cn(expanded && "rotate-90")} />
                          </Button>
                          <Button
                            variant="bare"
                            size="content"
                            className={cn(
                              navigationStyles.appSidebarItem,
                              "workspace-sidebar-name min-w-0 gap-[7px] pl-0.5 pr-1.5",
                            )}
                            data-sidebar-navigate
                            title={workspace.name}
                            onClick={() => {
                              setWorkspaceExpanded(workspace.id, selected ? !expanded : true);
                              if (!selected) props.onOpenWorkspace?.(workspace);
                            }}
                          >
                            <FolderGit2 size={16} />
                            <span className="min-w-0 flex-1 truncate text-left">
                              {workspace.name}
                            </span>
                            {workspace.status === "attention" && (
                              <span
                                className="app-sidebar-status-dot size-[0.4375rem] shrink-0 rounded-full bg-[var(--amber)]"
                                aria-label={tr("status.workspace.attention")}
                              />
                            )}
                            {props.favoriteWorkspaceIds?.includes(workspace.id) && (
                              <Star size={12} className="fill-current opacity-60" />
                            )}
                          </Button>
                        </div>
                        {expanded && (
                          <div className="workspace-sidebar-children grid gap-0.5 mt-1 mb-2 ml-2.5 pl-2.5 border-l border-sidebar-border">
                            {selected ? (
                              <>
                                {workspaceTaskEntries.map(renderWorkspaceEntry)}
                                <div className="workspace-sidebar-divider mx-2 my-1 border-t border-sidebar-border" />
                                {workspaceDevelopmentEntries.map(renderWorkspaceEntry)}
                                {(!!props.changeCount || props.workspacePage === "changes") && (
                                  <Button
                                    variant="bare"
                                    size="content"
                                    data-sidebar-navigate
                                    className={cn(
                                      navigationStyles.appSidebarItem,
                                      "workspace-sidebar-child min-h-[34px] gap-2 py-[7px] px-2 text-xs!",
                                      props.workspacePage === "changes" &&
                                        navigationStyles.appSidebarItemActive,
                                    )}
                                    aria-current={
                                      props.workspacePage === "changes" ? "page" : undefined
                                    }
                                    onClick={() => props.onWorkspaceNavigate?.("changes")}
                                  >
                                    <GitCompareArrows size={15} />
                                    <span>{tr("nav.changes")}</span>
                                    <em className="app-sidebar-item-badge grid min-w-5 h-5 place-items-center rounded-[0.4375rem] bg-sidebar-primary px-[0.3rem] text-sidebar-primary-foreground text-[0.6875rem] tabular-nums font-[650] leading-none">
                                      {props.changeCount ?? 0}
                                    </em>
                                  </Button>
                                )}
                              </>
                            ) : (
                              [...workspaceTaskEntries, ...workspaceDevelopmentEntries].map(
                                ({ page, label, icon: Icon }) => (
                                  <Button
                                    key={page}
                                    variant="bare"
                                    size="content"
                                    data-sidebar-navigate
                                    className={cn(
                                      navigationStyles.appSidebarItem,
                                      "workspace-sidebar-child min-h-[34px] gap-2 py-[7px] px-2 text-xs!",
                                    )}
                                    onClick={() => props.onOpenWorkspace?.(workspace, page)}
                                  >
                                    <Icon size={15} />
                                    {tr(label)}
                                  </Button>
                                ),
                              )
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!props.workspaces?.length && props.workspacesPending && (
                    <p className="px-3 py-6 text-sm text-muted-foreground">
                      {tr("common.loading")}
                    </p>
                  )}
                  {!props.workspaces?.length && props.workspacesError && (
                    <div className="grid justify-items-start gap-2 px-3 py-4">
                      <p role="alert" className="text-sm text-destructive">
                        {props.workspacesError}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        type="button"
                        onClick={props.onRetryWorkspaces}
                      >
                        {tr("errors.retryPage")}
                      </Button>
                    </div>
                  )}
                  {!props.workspaces?.length &&
                    !props.workspacesPending &&
                    !props.workspacesError && (
                      <p className="px-3 py-6 text-sm text-muted-foreground">
                        {tr("sidebar.noWorkspaces")}
                      </p>
                    )}
                </nav>
              )}
              {context?.kind === "agents" && (
                <div className="app-sidebar-group grid gap-0.5 agent-sidebar-filters mb-3">
                  {agentFilters.map(([id, label]) => (
                    <Button
                      key={id}
                      variant="bare"
                      size="content"
                      className={cn(
                        navigationStyles.appSidebarItem,
                        context.filter === id && navigationStyles.appSidebarItemActive,
                      )}
                      aria-pressed={context.filter === id}
                      onClick={() => context.onFilterChange(id)}
                    >
                      <span className={navigationStyles.appSidebarItemIcon}>
                        {id === "all" ? <Bot size={16} /> : <SlidersHorizontal size={16} />}
                      </span>
                      {tr(label)}
                    </Button>
                  ))}
                </div>
              )}
              {active === "sessions" && (
                <div className="app-sidebar-session-directory min-h-0 flex flex-1 flex-col mt-0 border-t-0">
                  <SessionDirectory />
                </div>
              )}
              {(active === "agents" || active === "catalog") && <SidebarPanelTarget />}
              {props.secondary}
            </div>
          </div>
        </div>
      </aside>
      {remoteOpen && (
        <RemoteConnectionPanel
          open={remoteOpen}
          onOpenChange={setRemoteOpen}
          onSettings={() => {
            setRemoteOpen(false);
            (props.onRemoteSettings ?? props.onSettings)();
          }}
        />
      )}
    </>
  );
}
