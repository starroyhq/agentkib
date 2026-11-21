import { useSyncExternalStore } from "react";

/** What Send does while the agent is running: queue for after the turn, or add to the turn. */
export type SendWhileRunning = "queue" | "steer";
const KEY = "agentkib.send-while-running";
const listeners = new Set<() => void>();
// Without storage the choice lasts until the page reloads.
let unsaved: SendWhileRunning | undefined;

function read(): SendWhileRunning {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "steer" || saved === "queue") return saved;
  } catch {
    /* Storage is unavailable; use the unsaved choice. */
  }
  return unsaved ?? "queue";
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab changing the preference reaches this one through the storage event.
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** This device's choice; the menu beside Send offers both either way. */
export function useSendWhileRunning(): SendWhileRunning {
  return useSyncExternalStore(subscribe, read, () => "queue");
}

export function setSendWhileRunning(value: SendWhileRunning) {
  unsaved = value;
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* Kept in memory above. */
  }
  for (const listener of listeners) listener();
}

/** The operation Send performs while the agent is running. */
export const runningSendAction = (mode: SendWhileRunning) =>
  mode === "steer" ? ("steer" as const) : ("queue-add" as const);
