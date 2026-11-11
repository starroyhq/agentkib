import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";
import { changeLocale } from "@/core/i18n";
import { applyTheme } from "@/core/theme";
import type { EffectiveTheme, RuntimeInfo } from "@/core/types";
import { useAppStore } from "@/stores/app-store";

const isOpen = () => document.visibilityState === "visible" && document.hasFocus();

/**
 * Whether the popover is open. It hides as soon as it loses focus, so focus says it: the catalog
 * is followed only while the popover shows, and nothing runs for it once it is closed.
 */
export function usePopoverOpen() {
  const [open, setOpen] = useState(isOpen);
  useEffect(() => {
    const update = () => setOpen(isOpen());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return open;
}

/**
 * The runtime settings the main window keeps in its store, read here on its own: the session
 * index switch, theme and language. Read again each time the popover opens.
 */
export function usePopoverRuntime(open: boolean): RuntimeInfo | undefined {
  const runtime = useAppStore((state) => state.runtime);
  const setRuntime = useAppStore((state) => state.setRuntime);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void api.runtime().then(
      async (value) => {
        if (disposed) return;
        setRuntime(value);
        applyTheme(value.effective_theme);
        await changeLocale(value.effective_locale);
      },
      () => undefined,
    );
    return () => {
      disposed = true;
    };
  }, [open, setRuntime]);
  useEffect(
    () => desktopApi().events.onThemeChanged((theme: EffectiveTheme) => applyTheme(theme)),
    [],
  );
  return runtime;
}

/**
 * Tells the window how tall the content is, so the popover grows with it up to the screen. The
 * list between `top` and `bottom` scrolls; its content's own height counts, not the room it got.
 */
export function usePopoverHeight(
  top: RefObject<HTMLElement | null>,
  list: RefObject<HTMLElement | null>,
  bottom: RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    let last = 0;
    let frame = 0;
    const report = () => {
      frame = 0;
      const height = Math.ceil(
        (top.current?.offsetHeight ?? 0) +
          (list.current?.offsetHeight ?? 0) +
          (bottom.current?.offsetHeight ?? 0),
      );
      if (!height || height === last) return;
      last = height;
      void desktopApi()
        .shell.setPopoverHeight(height)
        .catch(() => undefined);
    };
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(report);
    });
    for (const element of [top.current, list.current, bottom.current])
      if (element) observer.observe(element);
    report();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [top, list, bottom]);
}

/** The time, ticking every `interval` while `running`; running times count their seconds with it. */
export function useNow(running: boolean, interval = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [running, interval]);
  return now;
}
