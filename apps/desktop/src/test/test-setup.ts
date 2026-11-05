if (typeof window !== "undefined") {
  const unsubscribe = () => undefined;
  if (typeof window.localStorage?.getItem !== "function") {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return values.size;
        },
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => [...values.keys()][index] ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, String(value)),
      },
    });
  }
  Object.defineProperty(window, "agentkibDesktop", {
    configurable: true,
    value: {
      platform: "linux",
      events: {
        onQuitRequested: () => unsubscribe,
        onThemeChanged: () => unsubscribe,
        onRefreshState: () => unsubscribe,
        onQuotaUpdated: () => unsubscribe,
        onLocalCostUpdated: () => unsubscribe,
        onNavigate: () => unsubscribe,
        onMenuCommand: () => unsubscribe,
        onRuntimeStatus: () => unsubscribe,
      },
      runtime: {
        status: async () => ({ state: "ready", restartCount: 0 }),
        retry: async () => undefined,
      },
      benchmark: {
        mark: async () => undefined,
      },
    },
  });
  document.documentElement.dataset.platform = "linux";

  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (media: string) => ({
        media,
        matches: false,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      }),
    });
  }

  class TestPointerEvent extends window.MouseEvent {
    pointerId = 1;
    pointerType = "mouse";
    isPrimary = true;
  }

  if (!window.PointerEvent) {
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
  }

  if (!window.ResizeObserver) {
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
  }

  if (!window.Element.prototype.scrollIntoView) {
    window.Element.prototype.scrollIntoView = () => undefined;
  }
}
