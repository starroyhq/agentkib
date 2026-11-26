import { useEffect, useRef } from "react";

const FOREGROUND_REFRESH_COALESCE_MS = 250;

export function subscribeSessionForegroundRefresh(refresh: () => void) {
  let lastRefresh = -Infinity;
  const foreground = () => {
    if (document.visibilityState !== "visible") return;
    const now = performance.now();
    // A browser may report visibility and focus separately when a tab is restored.
    if (now - lastRefresh < FOREGROUND_REFRESH_COALESCE_MS) return;
    lastRefresh = now;
    refresh();
  };
  window.addEventListener("focus", foreground);
  document.addEventListener("visibilitychange", foreground);
  return () => {
    window.removeEventListener("focus", foreground);
    document.removeEventListener("visibilitychange", foreground);
  };
}

export function useSessionForegroundRefresh(sessionId: string | undefined, refresh: () => void) {
  const callback = useRef(refresh);
  useEffect(() => {
    callback.current = refresh;
  }, [refresh]);
  useEffect(() => {
    if (!sessionId) return;
    return subscribeSessionForegroundRefresh(() => callback.current());
  }, [sessionId]);
}
