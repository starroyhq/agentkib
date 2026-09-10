import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Check, CircleAlert, Monitor, Moon, Sun } from "lucide-react";

import { api } from "@/core/api";
import {
  ACCENT_THEME_IDS,
  accentThemePreference,
  applyAccentTheme,
  applyTheme,
  cacheAccentTheme,
  cacheEffectiveTheme,
  systemTheme,
} from "@/core/theme";
import type { AccentThemeId, EffectiveTheme, RuntimeInfo, ThemePreference } from "@/core/types";
import { localizeMessage } from "@/core/i18n";

import {
  SettingsNotice,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
} from "./components/SettingsLayout";

type AppearanceSettingsProps = {
  runtime?: RuntimeInfo;
  onChanged: (runtime: RuntimeInfo) => void;
};

type AccentPreview = {
  accent: string;
  accentSoft: string;
  canvas: string;
  sidebar: string;
  line: string;
};

const accentPreviews: Record<AccentThemeId, AccentPreview> = {
  "minimal-neutral": {
    accent: "#242424",
    accentSoft: "#e5e5e5",
    canvas: "#ffffff",
    sidebar: "#f4f4f4",
    line: "#d4d4d4",
  },
  vtron: {
    accent: "#2e67ff",
    accentSoft: "#dfe8ff",
    canvas: "#fcfcfc",
    sidebar: "#f1f4ff",
    line: "#d7dff4",
  },
  claude: {
    accent: "#c96442",
    accentSoft: "#f1d9d0",
    canvas: "#fffaf5",
    sidebar: "#f3ece4",
    line: "#e0d2c6",
  },
  sakura: {
    accent: "#ef6f98",
    accentSoft: "#ffe0e9",
    canvas: "#fff9fb",
    sidebar: "#f9edf2",
    line: "#ead4dc",
  },
  "ocean-breeze": {
    accent: "#20a866",
    accentSoft: "#d9f5e6",
    canvas: "#f7fcfa",
    sidebar: "#e8f6ef",
    line: "#cfe7da",
  },
};

const themePreferences: readonly ThemePreference[] = ["light", "dark", "system"];

const themeIcons: Record<ThemePreference, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

function ThemeModePreview({ mode }: { mode: ThemePreference }) {
  return (
    <div className="theme-mode-preview" data-preview-mode={mode} aria-hidden="true">
      <span className="theme-preview-chrome" />
      <div className="theme-mode-preview-sidebar">
        <span className="theme-preview-dot" />
        <span className="theme-preview-line theme-preview-line-short" />
        <span className="theme-preview-line" />
        <span className="theme-preview-line theme-preview-line-short" />
      </div>
      <div className="theme-mode-preview-content">
        <span className="theme-preview-line theme-preview-line-title" />
        <span className="theme-preview-line" />
        <span className="theme-preview-line theme-preview-line-medium" />
        <div className="theme-preview-chart">
          <span className="theme-preview-chart-bar" />
          <span className="theme-preview-chart-bar theme-preview-chart-bar-medium" />
          <span className="theme-preview-chart-bar theme-preview-chart-bar-tall" />
          <span className="theme-preview-chart-bar theme-preview-chart-bar-short" />
          <span className="theme-preview-chart-bar theme-preview-chart-bar-medium" />
        </div>
      </div>
    </div>
  );
}

function AccentThemePreview({ theme, mode }: { theme: AccentThemeId; mode: EffectiveTheme }) {
  const preview = accentPreviews[theme];
  const dark = mode === "dark";
  const style = {
    "--preview-accent": preview.accent,
    "--preview-accent-soft": dark
      ? `color-mix(in srgb, ${preview.accent} 24%, #20242a)`
      : preview.accentSoft,
    "--preview-canvas": dark ? "#20242a" : preview.canvas,
    "--preview-sidebar": dark ? "#171b20" : preview.sidebar,
    "--preview-line": dark ? "#3b444e" : preview.line,
  } as CSSProperties;

  return (
    <div
      className="theme-accent-preview"
      data-preview-mode={mode}
      style={style}
      aria-hidden="true"
    >
      <span className="theme-preview-chrome" />
      <div className="theme-accent-preview-sidebar">
        <span className="theme-preview-logo" />
        <span className="theme-preview-line theme-preview-line-short" />
        <span className="theme-preview-line" />
        <span className="theme-preview-line theme-preview-line-medium" />
      </div>
      <div className="theme-accent-preview-content">
        <div className="theme-preview-toolbar">
          <span className="theme-preview-line theme-preview-line-title" />
          <span className="theme-preview-action" />
        </div>
        <span className="theme-preview-line" />
        <span className="theme-preview-line theme-preview-line-medium" />
        <div className="theme-preview-chart">
          <span className="theme-preview-chart-bar theme-preview-chart-bar-short" />
          <span className="theme-preview-chart-bar theme-preview-chart-bar-tall" />
          <span className="theme-preview-chart-bar theme-preview-chart-bar-medium" />
          <span className="theme-preview-chart-bar" />
          <span className="theme-preview-chart-bar theme-preview-chart-bar-tall" />
        </div>
        <div className="theme-preview-card-row">
          <span className="theme-preview-card" />
          <span className="theme-preview-card theme-preview-card-accent" />
        </div>
      </div>
    </div>
  );
}

export function AppearanceSettings({ runtime, onChanged }: AppearanceSettingsProps) {
  const { t: tr } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedMode = runtime?.theme_preference ?? "system";
  const selectedAccent = runtime?.accent_theme_preference ?? accentThemePreference();
  const effectiveTheme = runtime?.effective_theme ?? systemTheme();

  const updateTheme = async (preference: ThemePreference) => {
    if (preference === selectedMode || busy) return;
    setBusy(true);
    setError("");
    try {
      const nextRuntime = await api.setThemePreference(preference);
      applyTheme(nextRuntime.effective_theme);
      cacheEffectiveTheme(nextRuntime.effective_theme, nextRuntime.theme_preference);
      onChanged(nextRuntime);
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const updateAccent = async (preference: AccentThemeId) => {
    if (preference === selectedAccent || busy) return;
    setBusy(true);
    setError("");
    try {
      const nextRuntime = await api.setAccentThemePreference(preference);
      const nextAccent = nextRuntime.accent_theme_preference ?? preference;
      applyAccentTheme(nextAccent);
      cacheAccentTheme(nextAccent);
      onChanged(nextRuntime);
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPage variant="form">
      <SettingsPageHeader title={tr("settings.section.appearance")} />

      <SettingsSection
        title={tr("settings.theme")}
        target="appearance-mode"
      >
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          {themePreferences.map((mode) => {
            const Icon = themeIcons[mode];
            const selected = selectedMode === mode;
            return (
              <button
                key={mode}
                type="button"
                className="theme-choice-card"
                aria-pressed={selected}
                disabled={busy || !runtime}
                onClick={() => void updateTheme(mode)}
              >
                <ThemeModePreview mode={mode} />
                <span className="theme-choice-card-footer">
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <Icon size={16} aria-hidden="true" />
                    <span className="truncate">{tr(`settings.theme.${mode}`)}</span>
                  </span>
                  {selected && <Check size={16} aria-hidden="true" />}
                </span>
              </button>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        title={tr("settings.accentTheme")}
        target="appearance-theme"
      >
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {ACCENT_THEME_IDS.map((theme) => {
            const selected = selectedAccent === theme;
            return (
              <button
                key={theme}
                type="button"
                className="theme-choice-card"
                aria-pressed={selected}
                disabled={busy || !runtime}
                onClick={() => void updateAccent(theme)}
              >
                <AccentThemePreview theme={theme} mode={effectiveTheme} />
                <span className="theme-choice-card-footer">
                  <span className="truncate">{tr(`settings.accentTheme.${theme}`)}</span>
                  {selected && <Check size={16} aria-hidden="true" />}
                </span>
              </button>
            );
          })}
        </div>
      </SettingsSection>

      {error && (
        <SettingsNotice tone="error" role="alert">
          <CircleAlert size={14} />
          {error}
        </SettingsNotice>
      )}
    </SettingsPage>
  );
}
