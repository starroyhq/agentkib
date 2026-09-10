import { useEffect } from "react";
import type { Locale } from "@/i18n";

export function useAppearance(locale: Locale, theme: string, accent = "blue") {
  useEffect(() => {
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
  }, [locale, theme, accent]);
}
