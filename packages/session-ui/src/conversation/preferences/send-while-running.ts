import { useSyncExternalStore } from "react";

/** What Send does while the agent is running: queue for after the turn, or add to the turn. */
export type SendWhileRunning = "queue" | "steer";
const DEFAULT_SEND_WHILE_RUNNING: SendWhileRunning = "steer";
const KEY = "agentkib.send-while-running";
const listeners = new Set<() => void>();
// Without storage the choice lasts until the page reloads.
let unsaved: SendWhileRunning | undefined;

function read(): SendWhileRunning {
  if (unsaved) return unsaved;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "steer" || saved === "queue") return saved;
  } catch {
    /* Storage is unavailable; use the unsaved choice. */
  }
  return DEFAULT_SEND_WHILE_RUNNING;
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

/** This device's choice for follow-up messages. */
export function useSendWhileRunning(): SendWhileRunning {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_SEND_WHILE_RUNNING);
}

export function setSendWhileRunning(value: SendWhileRunning) {
  try {
    localStorage.setItem(KEY, value);
    unsaved = undefined;
  } catch {
    unsaved = value;
  }
  for (const listener of listeners) listener();
}

/** The operation Send performs while the agent is running. */
export const runningSendAction = (mode: SendWhileRunning) =>
  mode === "steer" ? ("steer" as const) : ("queue-add" as const);

function usesCommandKey(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPad|iPhone|iPod/.test(navigator.platform);
}

export function alternateFollowUpShortcut(isMacOS = usesCommandKey()): string {
  return isMacOS ? "⌘Enter" : "Ctrl+Enter";
}

export function matchesAlternateFollowUpShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): boolean {
  return (
    event.key === "Enter" && !event.shiftKey && !event.altKey && (event.metaKey || event.ctrlKey)
  );
}
