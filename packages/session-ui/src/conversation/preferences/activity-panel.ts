import { useSyncExternalStore } from "react";

const key = "agentkib.session-activities.open";
const listeners = new Set<() => void>();
let unsaved: boolean | undefined;

function read() {
  if (unsaved !== undefined) return unsaved;
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function useActivityPanelOpen() {
  return useSyncExternalStore(subscribe, read, () => false);
}

export function setActivityPanelOpen(open: boolean) {
  try {
    localStorage.setItem(key, String(open));
    unsaved = undefined;
  } catch {
    unsaved = open;
  }
  for (const listener of listeners) listener();
}
