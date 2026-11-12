import { useLayoutEffect, useRef } from "react";
import { captureHistoryScrollAnchor } from "@agentkib/session-ui";
import type { useSessionHistory } from "./useSessionHistory";

/** Preserve visible records when an earlier history window is prepended. */
export function useSessionHistoryScroll(
  sessionKey: string,
  history: ReturnType<typeof useSessionHistory>,
) {
  const historyRef = useRef<HTMLDivElement>(null);
  const scrollAnchor = useRef<{
    key: string;
    restore: () => void;
  } | null>(null);
  useLayoutEffect(() => {
    scrollAnchor.current = null;
    if (historyRef.current) historyRef.current.scrollTop = 0;
  }, [sessionKey]);
  useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    const container = historyRef.current;
    if (!anchor || !container || anchor.key !== sessionKey) return;
    anchor.restore();
    scrollAnchor.current = null;
    if (history.loadingEarlier)
      scrollAnchor.current = { key: sessionKey, restore: captureHistoryScrollAnchor(container) };
  }, [history.nextCursor, history.loadingEarlier, sessionKey]);
  const loadEarlier = (turnId?: string) => {
    if (!history.nextCursor || history.loadingEarlier) return;
    const container = historyRef.current;
    if (container)
      scrollAnchor.current = {
        key: sessionKey,
        restore: captureHistoryScrollAnchor(container),
      };
    void history.loadEarlier(turnId);
  };

  return { historyRef, loadEarlier };
}
