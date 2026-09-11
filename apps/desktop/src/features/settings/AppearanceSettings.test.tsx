// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { initializeI18n } from "@/core/i18n";
import type { RuntimeInfo } from "@/core/types";
import { AppearanceSettings } from "./AppearanceSettings";

const { setAccentThemePreference, setThemePreference } = vi.hoisted(() => ({
  setAccentThemePreference: vi.fn(),
  setThemePreference: vi.fn(),
}));

vi.mock("@/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/core/api")>()),
  api: {
    ...(await importOriginal<typeof import("@/core/api")>()).api,
    setAccentThemePreference,
    setThemePreference,
  },
}));

const runtime = {
  effective_theme: "light",
  theme_preference: "light",
  accent_theme_preference: "vtron",
} as RuntimeInfo;

describe("AppearanceSettings", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-accent-theme");
  });

  it("renders the real theme and accent cards", () => {
    render(<AppearanceSettings runtime={runtime} onChanged={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Light" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dark" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Follow System" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sakura" })).toBeTruthy();
    expect(screen.queryByText("Applies a coordinated palette to actions, focus, selections, surfaces, and the sidebar.")).toBeNull();
  });

  it("persists a selected accent", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const nextRuntime = { ...runtime, accent_theme_preference: "sakura" } as RuntimeInfo;
    setAccentThemePreference.mockResolvedValue(nextRuntime);
    render(<AppearanceSettings runtime={runtime} onChanged={onChanged} />);

    await user.click(screen.getByRole("button", { name: "Sakura" }));

    await waitFor(() => expect(setAccentThemePreference).toHaveBeenCalledWith("sakura"));
    expect(onChanged).toHaveBeenCalledWith(nextRuntime);
    expect(document.documentElement.dataset.accentTheme).toBe("sakura");
    expect(window.localStorage.getItem("agentkib.accent-theme")).toBe("sakura");
  });

  it("persists a selected appearance mode", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const nextRuntime = { ...runtime, effective_theme: "dark", theme_preference: "dark" } as RuntimeInfo;
    setThemePreference.mockResolvedValue(nextRuntime);
    render(<AppearanceSettings runtime={runtime} onChanged={onChanged} />);

    await user.click(screen.getByRole("button", { name: "Dark" }));

    await waitFor(() => expect(setThemePreference).toHaveBeenCalledWith("dark"));
    expect(onChanged).toHaveBeenCalledWith(nextRuntime);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("keeps the previous appearance when saving fails", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    setAccentThemePreference.mockRejectedValue(new Error("preference write failed"));
    document.documentElement.dataset.accentTheme = "vtron";
    window.localStorage.setItem("agentkib.accent-theme", "vtron");
    render(<AppearanceSettings runtime={runtime} onChanged={onChanged} />);

    await user.click(screen.getByRole("button", { name: "Sakura" }));

    expect((await screen.findByRole("alert")).textContent).toContain("preference write failed");
    expect(onChanged).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.accentTheme).toBe("vtron");
    expect(window.localStorage.getItem("agentkib.accent-theme")).toBe("vtron");
  });
});
