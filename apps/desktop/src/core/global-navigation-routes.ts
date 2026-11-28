/** Single source of truth for primary desktop navigation routes and their keyboard shortcuts. */
export type GlobalNavigationRouteId =
  | "home"
  | "sessions"
  | "workspaces"
  | "catalog"
  | "quota"
  | "insights";

export type GlobalNavigationShortcutId =
  | "navigate-home"
  | "navigate-sessions"
  | "navigate-workspaces"
  | "navigate-catalog"
  | "navigate-quota"
  | "navigate-insights";

export interface GlobalNavigationRoute {
  readonly id: GlobalNavigationRouteId;
  readonly label: string;
  readonly shortcutId: GlobalNavigationShortcutId;
  readonly shortcutKey: string;
  readonly nativeMac: true;
}

export const globalNavigationRoutes: readonly GlobalNavigationRoute[] = [
  {
    id: "home",
    label: "nav.home",
    shortcutId: "navigate-home",
    shortcutKey: "1",
    nativeMac: true,
  },
  {
    id: "sessions",
    label: "sessions.nav",
    shortcutId: "navigate-sessions",
    shortcutKey: "3",
    nativeMac: true,
  },
  {
    id: "workspaces",
    label: "nav.workspaces",
    shortcutId: "navigate-workspaces",
    shortcutKey: "2",
    nativeMac: true,
  },
  {
    id: "catalog",
    label: "nav.catalog",
    shortcutId: "navigate-catalog",
    shortcutKey: "4",
    nativeMac: true,
  },
  {
    id: "quota",
    label: "nav.quota",
    shortcutId: "navigate-quota",
    shortcutKey: "5",
    nativeMac: true,
  },
  {
    id: "insights",
    label: "nav.insights",
    shortcutId: "navigate-insights",
    shortcutKey: "6",
    nativeMac: true,
  },
];
