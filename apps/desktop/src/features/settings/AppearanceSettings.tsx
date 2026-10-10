import { cn } from "cn";
import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Check, CircleAlert, Monitor, Moon, Sun } from "lucide-react";

import { api } from "@/core/api";
import { Button } from "@/components/ui/button";
import {
  ACCENT_THEME_IDS,
  accentThemePreference,
  applyAccentTheme,
  applyTheme,
  cacheAccentTheme,
  systemTheme,
} from "@/core/theme";
import type { AccentThemeId, EffectiveTheme, RuntimeInfo, ThemePreference } from "@/core/types";
import { localizeMessage } from "@/core/i18n";
import { withAsyncCleanup } from "@/lib/utils";

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

const previewStyles = {
  themeChoiceCard:
    "theme-choice-card grid w-full items-stretch justify-stretch overflow-hidden appearance-none cursor-pointer border border-border rounded-[0.9rem] bg-card text-card-foreground text-left transition-[border-color,box-shadow,transform,translate] duration-180 ease-[ease] hover:border-[color-mix(in_oklch,var(--primary)_48%,var(--border))] hover:shadow-[0_0.5rem_1.25rem_color-mix(in_srgb,var(--foreground)_7%,transparent)] hover:-translate-y-px active:translate-y-px focus-visible:border-ring focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--ring)_25%,transparent)] focus-visible:outline-none aria-pressed:border-primary aria-pressed:shadow-[0_0_0_2px_color-mix(in_srgb,var(--primary)_18%,transparent)] disabled:cursor-wait disabled:opacity-[0.68] disabled:translate-none motion-reduce:transition-none",
  themeChoiceCardFooter:
    "theme-choice-card-footer flex min-h-13 items-center justify-between gap-3 py-3 px-3.5 text-foreground text-sm font-semibold [&>svg]:shrink-0 [&>svg]:text-primary",
  themeModePreview:
    "theme-mode-preview relative grid min-h-33 gap-[0.45rem] overflow-hidden pt-[1.35rem] px-[0.65rem] pb-[0.65rem] grid-cols-[29%_minmax(0,1fr)] bg-[var(--preview-canvas)]",
  themeAccentPreview:
    "theme-accent-preview relative grid min-h-33 gap-[0.45rem] overflow-hidden pt-[1.35rem] px-[0.65rem] pb-[0.65rem] grid-cols-[27%_minmax(0,1fr)] bg-[var(--preview-canvas)]",
  themeModePreviewSidebar:
    "theme-mode-preview-sidebar grid content-start gap-[0.45rem] min-w-0 rounded-[0.45rem] p-[0.55rem] bg-[var(--preview-sidebar)]",
  themeModePreviewContent:
    "theme-mode-preview-content grid content-start gap-[0.45rem] min-w-0 rounded-[0.45rem] p-[0.55rem] bg-[color-mix(in_srgb,var(--preview-canvas)_88%,var(--preview-sidebar))]",
  themeAccentPreviewSidebar:
    "theme-accent-preview-sidebar grid content-start gap-[0.42rem] min-w-0 rounded-[0.45rem] p-[0.55rem] bg-[color-mix(in_srgb,var(--preview-sidebar)_86%,var(--preview-accent)_14%)]",
  themeAccentPreviewContent:
    "theme-accent-preview-content grid content-start gap-[0.42rem] min-w-0 rounded-[0.45rem] p-[0.55rem] bg-[color-mix(in_srgb,var(--preview-canvas)_92%,var(--preview-sidebar))]",
  themePreviewDot: "theme-preview-dot block size-4 rounded-[0.32rem] bg-[var(--preview-accent)]",
  themePreviewLogo:
    "theme-preview-logo block size-[1.15rem] mb-1 rounded-[0.38rem] bg-[var(--preview-accent)] shadow-[0_0_0_0.2rem_color-mix(in_srgb,var(--preview-accent)_16%,transparent)]",
  themePreviewLine:
    "theme-preview-line block w-full h-[0.35rem] rounded-full bg-[var(--preview-line)]",
  themePreviewLineShort: "theme-preview-line-short w-[62%]",
  themePreviewLineMedium: "theme-preview-line-medium w-[78%]",
  themePreviewLineTitle: "theme-preview-line-title w-[44%] h-[0.42rem] bg-[var(--preview-strong)]",
  themePreviewToolbar: "theme-preview-toolbar flex items-center justify-between gap-[0.4rem]",
  themePreviewCardRow: "theme-preview-card-row flex items-center justify-between gap-[0.4rem] mt-1",
  themePreviewAction:
    "theme-preview-action block w-[1.4rem] h-[0.55rem] rounded-full bg-[var(--preview-accent)]",
  themePreviewChart:
    "theme-preview-chart flex h-7 items-end gap-[0.24rem] mt-[0.22rem] py-[0.3rem] px-[0.4rem] rounded-[0.35rem] bg-[color-mix(in_srgb,var(--preview-accent-soft)_48%,var(--preview-canvas))]",
  themePreviewChartBar:
    "theme-preview-chart-bar block flex-1 h-[42%] rounded-t-[0.15rem] rounded-b-[0.08rem] bg-[color-mix(in_srgb,var(--preview-accent)_52%,var(--preview-canvas))]",
  themePreviewChartBarShort: "theme-preview-chart-bar-short h-[27%]",
  themePreviewChartBarMedium: "theme-preview-chart-bar-medium h-[60%]",
  themePreviewChartBarTall: "theme-preview-chart-bar-tall h-[82%] bg-[var(--preview-accent)]",
  themePreviewCard:
    "theme-preview-card block w-[48%] h-8 border border-[color-mix(in_srgb,var(--preview-muted)_38%,transparent)] rounded-[0.35rem] bg-[color-mix(in_srgb,var(--preview-sidebar)_56%,var(--preview-canvas))]",
  themePreviewCardAccent:
    "theme-preview-card-accent border-[color-mix(in_srgb,var(--preview-accent)_40%,transparent)] bg-[var(--preview-accent-soft)]",
} as const;

function ThemeModePreview({ mode }: { mode: ThemePreference }) {
  return (
    <div className={previewStyles.themeModePreview} data-preview-mode={mode} aria-hidden="true">
      <span className="theme-preview-chrome" />
      <div className={previewStyles.themeModePreviewSidebar}>
        <span className={previewStyles.themePreviewDot} />
        <span className={cn(previewStyles.themePreviewLine, previewStyles.themePreviewLineShort)} />
        <span className={previewStyles.themePreviewLine} />
        <span className={cn(previewStyles.themePreviewLine, previewStyles.themePreviewLineShort)} />
      </div>
      <div className={previewStyles.themeModePreviewContent}>
        <span className={cn(previewStyles.themePreviewLine, previewStyles.themePreviewLineTitle)} />
        <span className={previewStyles.themePreviewLine} />
        <span
          className={cn(previewStyles.themePreviewLine, previewStyles.themePreviewLineMedium)}
        />
        <div className={previewStyles.themePreviewChart}>
          <span className={previewStyles.themePreviewChartBar} />
          <span
            className={cn(
              previewStyles.themePreviewChartBar,
              previewStyles.themePreviewChartBarMedium,
            )}
          />
          <span
            className={cn(
              previewStyles.themePreviewChartBar,
              previewStyles.themePreviewChartBarTall,
            )}
          />
          <span
            className={cn(
              previewStyles.themePreviewChartBar,
              previewStyles.themePreviewChartBarShort,
            )}
          />
          <span
            className={cn(
              previewStyles.themePreviewChartBar,
              previewStyles.themePreviewChartBarMedium,
            )}
          />
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
      className={previewStyles.themeAccentPreview}
      data-preview-mode={mode}
      style={style}
      aria-hidden="true"
    >
      <span className="theme-preview-chrome" />
      <div className={previewStyles.themeAccentPreviewSidebar}>
        <span className={previewStyles.themePreviewLogo} />
        <span className={cn(previewStyles.themePreviewLine, previewStyles.themePreviewLineShort)} />
        <span className={previewStyles.themePreviewLine} />
        <span
          className={cn(previewStyles.themePreviewLine, previewStyles.themePreviewLineMedium)}
        />
      </div>
      <div className={previewStyles.themeAccentPreviewContent}>
        <div className={previewStyles.themePreviewToolbar}>
          <span
            className={cn(previewStyles.themePreviewLine, previewStyles.themePreviewLineTitle)}
          />
          <span className={previewStyles.themePreviewAction} />
        </div>
        <span className={previewStyles.themePreviewLine} />
        <span
          className={cn(previewStyles.themePreviewLine, previewStyles.themePreviewLineMedium)}
        />
        <div className={previewStyles.themePreviewChart}>
          <span
            className={cn(
              previewStyles.themePreviewChartBar,
              previewStyles.themePreviewChartBarShort,
            )}
          />
          <span
            className={cn(
              previewStyles.themePreviewChartBar,
              previewStyles.themePreviewChartBarTall,
            )}
          />
          <span
            className={cn(
              previewStyles.themePreviewChartBar,
              previewStyles.themePreviewChartBarMedium,
            )}
          />
          <span className={previewStyles.themePreviewChartBar} />
          <span
            className={cn(
              previewStyles.themePreviewChartBar,
              previewStyles.themePreviewChartBarTall,
            )}
          />
        </div>
        <div className={previewStyles.themePreviewCardRow}>
          <span className={previewStyles.themePreviewCard} />
          <span
            className={cn(previewStyles.themePreviewCard, previewStyles.themePreviewCardAccent)}
          />
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
    await withAsyncCleanup(
      async () => {
        try {
          const nextRuntime = await api.setThemePreference(preference);
          applyTheme(nextRuntime.effective_theme);
          onChanged(nextRuntime);
        } catch (reason) {
          setError(localizeMessage(reason));
        }
      },
      () => setBusy(false),
    );
  };

  const updateAccent = async (preference: AccentThemeId) => {
    if (preference === selectedAccent || busy) return;
    setBusy(true);
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          const nextRuntime = await api.setAccentThemePreference(preference);
          const nextAccent = nextRuntime.accent_theme_preference ?? preference;
          applyAccentTheme(nextAccent);
          cacheAccentTheme(nextAccent);
          onChanged(nextRuntime);
        } catch (reason) {
          setError(localizeMessage(reason));
        }
      },
      () => setBusy(false),
    );
  };

  return (
    <SettingsPage variant="form">
      <SettingsPageHeader title={tr("settings.section.appearance")} />

      <SettingsSection title={tr("settings.theme")} target="appearance-mode">
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          {themePreferences.map((mode) => {
            const Icon = themeIcons[mode];
            const selected = selectedMode === mode;
            return (
              <Button
                key={mode}
                type="button"
                variant="bare"
                size="content"
                className={previewStyles.themeChoiceCard}
                aria-pressed={selected}
                disabled={busy || !runtime}
                onClick={() => void updateTheme(mode)}
              >
                <ThemeModePreview mode={mode} />
                <span className={previewStyles.themeChoiceCardFooter}>
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <Icon size={16} aria-hidden="true" />
                    <span className="truncate">{tr(`settings.theme.${mode}`)}</span>
                  </span>
                  {selected && <Check size={16} aria-hidden="true" />}
                </span>
              </Button>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection title={tr("settings.accentTheme")} target="appearance-theme">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {ACCENT_THEME_IDS.map((theme) => {
            const selected = selectedAccent === theme;
            return (
              <Button
                key={theme}
                type="button"
                variant="bare"
                size="content"
                className={previewStyles.themeChoiceCard}
                aria-pressed={selected}
                disabled={busy || !runtime}
                onClick={() => void updateAccent(theme)}
              >
                <AccentThemePreview theme={theme} mode={effectiveTheme} />
                <span className={previewStyles.themeChoiceCardFooter}>
                  <span className="truncate">{tr(`settings.accentTheme.${theme}`)}</span>
                  {selected && <Check size={16} aria-hidden="true" />}
                </span>
              </Button>
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
