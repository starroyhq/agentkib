import { useEffect, useState } from "react";

function matches(query: string, fallback: boolean) {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : fallback;
}

/**
 * Whether the viewport matches `query` now, following later changes. `fallback` answers where the
 * viewport cannot be queried, such as outside a browser.
 */
export function useMediaQuery(query: string, fallback = false) {
  const [value, setValue] = useState(() => matches(query, fallback));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setValue(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return value;
}
