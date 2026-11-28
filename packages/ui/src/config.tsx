import * as React from "react";

export type UiSurface = "desktop" | "web";

export interface UiConfig {
  surface?: UiSurface;
  closeLabel?: string;
}

export interface UiCloseLabelSource {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => string;
}

const UiContext = React.createContext<UiConfig>({});

let defaultCloseLabelSource: UiCloseLabelSource | null = null;
const sourceListeners = new Set<() => void>();

function subscribeDefaultCloseLabel(listener: () => void) {
  sourceListeners.add(listener);
  let innerUnsubscribe = defaultCloseLabelSource?.subscribe(listener);
  const rebind = () => {
    innerUnsubscribe?.();
    innerUnsubscribe = defaultCloseLabelSource?.subscribe(listener);
    listener();
  };
  sourceListeners.delete(listener);
  sourceListeners.add(rebind);
  return () => {
    innerUnsubscribe?.();
    sourceListeners.delete(rebind);
  };
}

function getDefaultCloseLabel() {
  return defaultCloseLabelSource?.getSnapshot() ?? "Close";
}

export function setUiDefaultCloseLabelSource(source: UiCloseLabelSource | null) {
  defaultCloseLabelSource = source;
  for (const listener of sourceListeners) listener();
}

export function UiProvider({
  surface,
  closeLabel,
  children,
}: UiConfig & { children: React.ReactNode }) {
  const parent = React.useContext(UiContext);
  const value = React.useMemo<UiConfig>(
    () => ({
      surface: surface ?? parent.surface,
      closeLabel: closeLabel ?? parent.closeLabel,
    }),
    [surface, parent.surface, closeLabel, parent.closeLabel],
  );
  return <UiContext value={value}>{children}</UiContext>;
}

export function useUiSurface(explicit?: UiSurface): UiSurface {
  const config = React.useContext(UiContext);
  return explicit ?? config.surface ?? "desktop";
}

export function useUiCloseLabel(explicit?: string): string {
  const config = React.useContext(UiContext);
  const registered = React.useSyncExternalStore(
    subscribeDefaultCloseLabel,
    getDefaultCloseLabel,
    getDefaultCloseLabel,
  );
  return explicit ?? config.closeLabel ?? registered;
}
