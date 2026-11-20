import { useEffect } from "react";
import type { InteractionLocale } from "../../interaction-model";

export function useAppearance(
  locale: InteractionLocale,
  theme: string,
  accent = "blue",
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () =>
      root.classList.toggle("dark", theme === "dark" || (theme === "system" && !!media?.matches));
    root.lang = locale;
    root.dataset.theme = theme;
    root.dataset.accent = accent;
    apply();
    media?.addEventListener("change", apply);
    return () => media?.removeEventListener("change", apply);
  }, [locale, theme, accent, enabled]);
}
