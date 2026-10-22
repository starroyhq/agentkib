import { normalizePlatform, type AppPlatform } from "./platform";

export type ShortcutId =
  | "navigate-home"
  | "navigate-workspaces"
  | "navigate-sessions"
  | "navigate-catalog"
  | "navigate-quota"
  | "navigate-insights"
  | "open-settings"
  | "refresh-current"
  | "add-workspace"
  | "add-scan-root"
  | "toggle-sidebar"
  | "history-back"
  | "history-forward"
  | "open-search"
  | "open-help";

export type ShortcutGroup = "navigation" | "actions";

export interface ShortcutDefinition {
  id: ShortcutId;
  key: string;
  labelKey: string;
  group: ShortcutGroup;
  shift?: boolean;
  nativeMac?: boolean;
  platformBindings?: Partial<Record<AppPlatform, ShortcutBinding>>;
}

interface ShortcutBinding {
  key: string;
  primary?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export const shortcutDefinitions: readonly ShortcutDefinition[] = [
  { id: "navigate-home", key: "1", labelKey: "nav.home", group: "navigation", nativeMac: true },
  {
    id: "navigate-workspaces",
    key: "2",
    labelKey: "nav.workspaces",
    group: "navigation",
    nativeMac: true,
  },
  {
    id: "navigate-sessions",
    key: "3",
    labelKey: "sessions.nav",
    group: "navigation",
    nativeMac: true,
  },
  {
    id: "navigate-catalog",
    key: "4",
    labelKey: "nav.catalog",
    group: "navigation",
    nativeMac: true,
  },
  { id: "navigate-quota", key: "5", labelKey: "nav.quota", group: "navigation", nativeMac: true },
  {
    id: "navigate-insights",
    key: "6",
    labelKey: "nav.insights",
    group: "navigation",
    nativeMac: true,
  },
  {
    id: "open-settings",
    key: ",",
    labelKey: "menu.settings",
    group: "navigation",
    nativeMac: true,
  },
  {
    id: "refresh-current",
    key: "r",
    labelKey: "menu.refreshCurrent",
    group: "actions",
    nativeMac: true,
  },
  {
    id: "add-workspace",
    key: "o",
    labelKey: "menu.addWorkspace",
    group: "actions",
    nativeMac: true,
  },
  {
    id: "add-scan-root",
    key: "o",
    labelKey: "menu.addScanRoot",
    group: "actions",
    shift: true,
    nativeMac: true,
  },
  {
    id: "toggle-sidebar",
    key: "b",
    labelKey: "shortcuts.toggleSidebar",
    group: "actions",
  },
  {
    id: "history-back",
    key: "[",
    labelKey: "shortcuts.back",
    group: "navigation",
    platformBindings: {
      windows: { key: "ArrowLeft", primary: false, alt: true },
      linux: { key: "ArrowLeft", primary: false, alt: true },
    },
  },
  {
    id: "history-forward",
    key: "]",
    labelKey: "shortcuts.forward",
    group: "navigation",
    platformBindings: {
      windows: { key: "ArrowRight", primary: false, alt: true },
      linux: { key: "ArrowRight", primary: false, alt: true },
    },
  },
  {
    id: "open-search",
    key: "k",
    labelKey: "search.open",
    group: "actions",
  },
  {
    id: "open-help",
    key: "/",
    labelKey: "shortcuts.openHelp",
    group: "actions",
  },
];

const shortcutById = new Map(shortcutDefinitions.map((definition) => [definition.id, definition]));

export function getShortcutDefinition(id: ShortcutId): ShortcutDefinition {
  const definition = shortcutById.get(id);
  if (!definition) throw new Error(`Unknown shortcut: ${id}`);
  return definition;
}

export function shortcutsForGroup(group: ShortcutGroup): ShortcutDefinition[] {
  return shortcutDefinitions.filter((definition) => definition.group === group);
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) return true;
  return (
    typeof element.closest === "function" && Boolean(element.closest('[contenteditable="true"]'))
  );
}

export function matchesShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  definition: ShortcutDefinition,
  platform: AppPlatform = currentAppPlatform(),
): boolean {
  const binding = shortcutBinding(definition, platform);
  const expectsPrimary = binding.primary !== false;
  const primaryPressed =
    platform === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (
    primaryPressed !== expectsPrimary ||
    event.altKey !== Boolean(binding.alt) ||
    event.shiftKey !== Boolean(binding.shift)
  )
    return false;
  if (!expectsPrimary && (event.ctrlKey || event.metaKey)) return false;
  return event.key.toLowerCase() === binding.key.toLowerCase();
}

export function formatShortcut(
  definition: ShortcutDefinition,
  platform: AppPlatform = currentAppPlatform(),
): string {
  const binding = shortcutBinding(definition, platform);
  const primary = binding.primary === false ? "" : platform === "macos" ? "⌘" : "Ctrl+";
  const alt = binding.alt ? "Alt+" : "";
  const shift = binding.shift ? "Shift+" : "";
  return `${primary}${alt}${shift}${displayKey(binding.key)}`;
}

export function ariaShortcut(
  definition: ShortcutDefinition,
  platform: AppPlatform = currentAppPlatform(),
): string {
  const binding = shortcutBinding(definition, platform);
  const modifiers = [
    binding.primary === false ? undefined : platform === "macos" ? "Meta" : "Control",
    binding.alt ? "Alt" : undefined,
    binding.shift ? "Shift" : undefined,
  ].filter(Boolean);
  return [...modifiers, binding.key.length === 1 ? binding.key.toUpperCase() : binding.key].join(
    "+",
  );
}

function shortcutBinding(definition: ShortcutDefinition, platform: AppPlatform): ShortcutBinding {
  return (
    definition.platformBindings?.[platform] ?? {
      key: definition.key,
      primary: true,
      shift: definition.shift,
    }
  );
}

function displayKey(key: string): string {
  if (key === "ArrowLeft") return "←";
  if (key === "ArrowRight") return "→";
  return key.length === 1 ? key.toUpperCase() : key;
}

export function currentAppPlatform(): AppPlatform {
  const rootPlatform = document.documentElement.dataset.platform;
  return normalizePlatform(rootPlatform);
}

export function shouldHandleInFrontend(
  definition: ShortcutDefinition,
  platform: AppPlatform = currentAppPlatform(),
): boolean {
  return platform !== "macos" || !definition.nativeMac;
}
