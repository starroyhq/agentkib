import { useEffect, useState } from "react";

/** Keep short waits quiet and start a fresh delay each time work becomes active. */
export function useDelayedBusy(active: boolean, delayMs = 300): boolean {
  const [elapsedDelay, setElapsedDelay] = useState<number>();
  if (elapsedDelay !== undefined && (!active || elapsedDelay !== delayMs))
    setElapsedDelay(undefined);

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setElapsedDelay(delayMs), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);

  return active && elapsedDelay === delayMs;
}
