import { create } from "zustand";
import type { AppMenuCommandRequest, AppNavigationRequest, RuntimeInfo } from "../core/types";

type Updater<T> = T | ((current: T) => T);

interface AppState {
  sidebarCollapsed: boolean;
  sidebarPeek: boolean;
  favoriteWorkspaceIds: string[];
  runtime?: RuntimeInfo;
  navigationRequest?: AppNavigationRequest;
  menuCommand?: AppMenuCommandRequest;
  quotaConfigureRequest: number;
}

interface AppActions {
  reset: () => void;
  setSidebarCollapsed: (value: Updater<boolean>) => void;
  setSidebarPeek: (value: Updater<boolean>) => void;
  toggleFavoriteWorkspace: (workspaceId: string) => void;
  setRuntime: (value: Updater<RuntimeInfo | undefined>) => void;
  setNavigationRequest: (value: Updater<AppNavigationRequest | undefined>) => void;
  setMenuCommand: (value: Updater<AppMenuCommandRequest | undefined>) => void;
  setQuotaConfigureRequest: (value: Updater<number>) => void;
}

const resolve = <T>(value: Updater<T>, current: T): T =>
  typeof value === "function" ? (value as (current: T) => T)(current) : value;

const SIDEBAR_COLLAPSED_STORAGE_KEY = "agentkib.sidebar-collapsed";
const FAVORITE_WORKSPACES_STORAGE_KEY = "agentkib.favorite-workspaces";

function initialSidebarCollapsed() {
  try {
    return typeof localStorage?.getItem === "function"
      ? localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true"
      : false;
  } catch {
    return false;
  }
}

function persistSidebarCollapsed(value: boolean) {
  try {
    if (typeof localStorage?.setItem === "function") {
      localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(value));
    }
  } catch {
    // Persisting this UI preference is best-effort in restricted webviews.
  }
}

function initialFavoriteWorkspaceIds() {
  try {
    const value = localStorage?.getItem(FAVORITE_WORKSPACES_STORAGE_KEY);
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function persistFavoriteWorkspaceIds(value: string[]) {
  try {
    localStorage?.setItem(FAVORITE_WORKSPACES_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Persisting this UI preference is best-effort in restricted webviews.
  }
}

export const useAppStore = create<AppState & AppActions>((set) => ({
  sidebarCollapsed: initialSidebarCollapsed(),
  sidebarPeek: false,
  favoriteWorkspaceIds: initialFavoriteWorkspaceIds(),
  quotaConfigureRequest: 0,
  reset: () =>
    set({
      sidebarCollapsed: false,
      sidebarPeek: false,
      favoriteWorkspaceIds: [],
      runtime: undefined,
      navigationRequest: undefined,
      menuCommand: undefined,
      quotaConfigureRequest: 0,
    }),
  setSidebarCollapsed: (value) =>
    set((state) => {
      const next = resolve(value, state.sidebarCollapsed);
      persistSidebarCollapsed(next);
      return { sidebarCollapsed: next };
    }),
  setSidebarPeek: (value) => set((state) => ({ sidebarPeek: resolve(value, state.sidebarPeek) })),
  toggleFavoriteWorkspace: (workspaceId) =>
    set((state) => {
      const next = state.favoriteWorkspaceIds.includes(workspaceId)
        ? state.favoriteWorkspaceIds.filter((id) => id !== workspaceId)
        : [...state.favoriteWorkspaceIds, workspaceId];
      persistFavoriteWorkspaceIds(next);
      return { favoriteWorkspaceIds: next };
    }),
  setRuntime: (value) => set((state) => ({ runtime: resolve(value, state.runtime) })),
  setNavigationRequest: (value) =>
    set((state) => ({ navigationRequest: resolve(value, state.navigationRequest) })),
  setMenuCommand: (value) => set((state) => ({ menuCommand: resolve(value, state.menuCommand) })),
  setQuotaConfigureRequest: (value) =>
    set((state) => ({ quotaConfigureRequest: resolve(value, state.quotaConfigureRequest) })),
}));
