import { StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { QuotaPopover } from "@/features/quota/QuotaPopover";
import { WebPairingPrompt } from "@/features/remote/WebPairingPrompt";
import { cachedEffectiveLocale, initializeI18n } from "./core/i18n";
import { applyPlatformAttribute } from "./core/platform";
import { desktopApi } from "./core/desktop";
import { PathDisplayProvider } from "./lib/usePathDisplay";
import {
  accentThemePreference,
  applyAccentTheme,
  applyTheme,
  cacheAccentTheme,
  cachedEffectiveTheme,
} from "./core/theme";
import { createAppRouter } from "./router";
import "./styles.css";

applyPlatformAttribute(desktopApi().platform);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

function BenchmarkCommitMarker() {
  useLayoutEffect(() => {
    void desktopApi()
      .benchmark.mark("renderer-first-commit")
      .catch(() => undefined);
  }, []);
  return null;
}

async function bootstrap() {
  const locale = cachedEffectiveLocale(navigator.language);
  applyTheme(cachedEffectiveTheme());
  const accentTheme = accentThemePreference();
  applyAccentTheme(accentTheme);
  cacheAccentTheme(accentTheme);
  await initializeI18n(locale);
  const surface = new URLSearchParams(window.location.search).get("surface");
  const app =
    surface === "quota-popover" ? <QuotaPopover /> : <RouterProvider router={createAppRouter()} />;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        {surface !== "quota-popover" && <BenchmarkCommitMarker />}
        <PathDisplayProvider>
          <AppDialogProvider>
            {app}
            {surface !== "quota-popover" && <WebPairingPrompt />}
          </AppDialogProvider>
        </PathDisplayProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();
