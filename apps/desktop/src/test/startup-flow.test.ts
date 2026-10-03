import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(import.meta.dirname, "../..");
describe("desktop startup flow", () => {
  it("renders from cached appearance without awaiting runtimeInfo", () => {
    const source = readFileSync(path.join(desktopRoot, "src/main.tsx"), "utf8");

    expect(source).toContain("cachedEffectiveLocale");
    expect(source).toContain("cachedEffectiveTheme");
    expect(source).not.toContain("await api.runtime()");
  });

  it("updates startup appearance caches when settings change", () => {
    const source = readFileSync(
      path.join(desktopRoot, "src/features/settings/GlobalSettings.tsx"),
      "utf8",
    );

    expect(source).toContain(
      "cacheEffectiveLocale(nextRuntime.effective_locale, nextRuntime.locale_preference)",
    );
    expect(source).toContain(
      "cacheEffectiveTheme(nextRuntime.effective_theme, nextRuntime.theme_preference)",
    );
  });

  it("registers IPC and starts the Runtime without blocking window creation", () => {
    const source = readFileSync(path.join(desktopRoot, "electron/main/index.ts"), "utf8");
    const start = source.indexOf("async function startApplication");
    const end = source.indexOf("function registerApplicationIpc", start);
    const startup = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(startup.indexOf("registerApplicationIpc()")).toBeGreaterThan(-1);
    expect(startup.indexOf("selectedRuntimeHost.start()")).toBeGreaterThan(-1);
    expect(startup.indexOf("registerApplicationIpc()")).toBeLessThan(
      startup.indexOf("selectedRuntimeHost.start()"),
    );
    expect(startup).toContain("void selectedRuntimeHost.start()");
    expect(startup).toContain("await createMainWindow()");
    expect(startup).not.toContain("await selectedRuntimeHost.start()");
  });

  it("exits benchmark mode when Runtime startup exhausts retries", () => {
    const source = readFileSync(path.join(desktopRoot, "electron/main/index.ts"), "utf8");
    const runtimeStart = source.indexOf("void selectedRuntimeHost.start().catch");
    const windowCreation = source.indexOf("await createMainWindow()", runtimeStart);
    expect(runtimeStart).toBeGreaterThan(-1);
    expect(windowCreation).toBeGreaterThan(runtimeStart);
    const failureHandler = source.slice(runtimeStart, windowCreation);

    expect(failureHandler).toContain("startupBenchmark.enabled");
    expect(failureHandler).toContain("app.exit(1)");
  });

  it("shows the main window after the Renderer first commits", () => {
    const source = readFileSync(path.join(desktopRoot, "electron/main/index.ts"), "utf8");
    const rendererCommit = source.indexOf('name === "renderer-first-commit"');
    const showWindow = source.indexOf("mainWindow.show()", rendererCommit);

    expect(rendererCommit).toBeGreaterThan(-1);
    expect(showWindow).toBeGreaterThan(rendererCommit);
  });

  it("only reports the first commit from the main Renderer surface", () => {
    const rendererSource = readFileSync(path.join(desktopRoot, "src/main.tsx"), "utf8");
    const mainSource = readFileSync(path.join(desktopRoot, "electron/main/index.ts"), "utf8");

    expect(rendererSource).toContain('surface !== "quota-popover" && <BenchmarkCommitMarker />');
    expect(mainSource).toContain("event.sender !== mainWindow.webContents");
  });

  it("approves update quits from Electron's native updater before the Renderer closes", () => {
    const source = readFileSync(path.join(desktopRoot, "electron/main/index.ts"), "utf8");

    expect(source).toContain("autoUpdater as nativeAutoUpdater");
    expect(source).toContain('nativeAutoUpdater.on("before-quit-for-update"');
    expect(source).not.toContain(
      '(autoUpdater as import("node:events").EventEmitter).on("before-quit-for-update"',
    );
  });

  it("uses the product display name instead of the workspace package name", () => {
    const source = readFileSync(path.join(desktopRoot, "electron/main/index.ts"), "utf8");

    expect(source).toContain(
      'const appDisplayName = isDevelopmentApp ? "AgentKib Dev" : "AgentKib"',
    );
    expect(source).toContain("app.setName(appDisplayName)");
    expect(source).toContain("AGENTKIB_APP_NAME: appDisplayName");
  });

  it("bounds the benchmark client's shutdown request", () => {
    const source = readFileSync(path.join(desktopRoot, "scripts/benchmark-runtime.mjs"), "utf8");

    expect(source).toContain("const gracefulShutdown = (async () =>");
    expect(source).toMatch(
      /Promise\.race\(\[\s*gracefulShutdown,\s*new Promise\(\(resolve\) => setTimeout\(resolve, 2_000\)\)/,
    );
  });
});
