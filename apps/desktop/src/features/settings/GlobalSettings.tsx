import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useI18n } from "@/core/useI18n";
import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  CircleAlert,
  ExternalLink,
  FolderGit2,
  FolderPlus,
  GitCommitHorizontal,
  History,
  Keyboard,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { ObsidianSettingsCard } from "@/features/obsidian/ObsidianIntegration";
import { QuotaDiagnostics } from "@/features/quota/QuotaDiagnostics";
import { RemoteGatewaysSettings } from "./RemoteGateways";
import { AgentToolsSettings } from "./AgentToolsSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { RemoteConnectionSettings } from "@/features/remote/RemoteConnectionPanel";
import {
  SettingsCopy,
  SettingsAnchor,
  SettingsNotice,
  SettingsPage,
  SettingsPageHeader,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from "./components/SettingsLayout";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";
import { cacheEffectiveLocale, changeLocale, localizeMessage } from "@/core/i18n";
import {
  ACCENT_THEME_IDS,
  accentThemePreference,
  applyAccentTheme,
  cacheAccentTheme,
  cacheEffectiveTheme,
  isAccentThemeId,
} from "@/core/theme";
import { normalizePlatform, primaryShortcutModifier, usesSystemTrayWording } from "@/core/platform";
import type { SettingsSection as SettingsSectionId } from "./SettingsSidebar";
import type {
  ActivityRecord,
  AgentKind,
  AppIconPreference,
  CloseBehavior,
  DiscoveryReport,
  ExcludedWorkspace,
  GitIdentitySummary,
  InsightsStatus,
  LocalePreference,
  QuotaCollectorStatus,
  RemoteGatewaySummary,
  RuntimeInfo,
  ScanRoot,
  WorkspaceSummary,
} from "@/core/types";
import { activityPresentation } from "@/features/activity/activity-presentation";
import { agentSupportsInsights } from "@/features/insights/insights";
import { cn } from "@/lib/utils";
import { useShortcutHelp } from "@/features/app/ShortcutHelpContext";
import appIconBlack from "../../../resources/icons/app-icon-black.png";
import appIconWhite from "../../../resources/icons/app-icon-white.png";
import {
  ariaShortcut,
  currentAppPlatform,
  formatShortcut,
  getShortcutDefinition,
} from "@/core/keyboard-shortcuts";

const buildPlatform = desktopApi().platform;
const appPlatform = normalizePlatform(buildPlatform);
const hasFileAccessSettings = ["macos", "windows"].includes(appPlatform);
const settingsControlClass =
  "h-10 min-w-[180px] justify-self-end max-[560px]:min-w-0 max-[560px]:flex-1";
const appIconAssets: Record<AppIconPreference, string> = {
  white: appIconWhite,
  black: appIconBlack,
};
const agentLabels: Record<AgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  "open-claw": "OpenClaw",
  hermes: "Hermes",
  "grok-build": "Grok Build",
  "deepseek-harness": "DeepSeek Harness",
};

export type GlobalSettingsProps = {
  section: SettingsSectionId;
  runtime?: RuntimeInfo;
  workspaces: WorkspaceSummary[];
  discovery?: DiscoveryReport;
  insightsStatus?: InsightsStatus;
  quotaStatus?: QuotaCollectorStatus;
  remoteGateways: RemoteGatewaySummary[];
  scanRoots: ScanRoot[];
  excluded: ExcludedWorkspace[];
  activity: ActivityRecord[];
  onAddRoot: () => Promise<void>;
  onRemoveRoot: (id: string) => Promise<void>;
  onRestore: (path: string) => Promise<void>;
  onCloseBehaviorChanged: (behavior?: CloseBehavior) => Promise<void>;
  onLocaleChanged: (runtime: RuntimeInfo) => void;
  onSessionIndexCleared: () => void;
  onOnboardingRestarted: () => Promise<void>;
  onRemoteGatewaysChanged: () => Promise<void>;
  onRefreshDiagnostics: () => Promise<void>;
};

export function GlobalSettings({
  section,
  runtime,
  workspaces,
  discovery,
  insightsStatus,
  quotaStatus,
  remoteGateways,
  scanRoots,
  excluded,
  activity,
  onAddRoot,
  onRemoveRoot,
  onRestore,
  onCloseBehaviorChanged,
  onLocaleChanged,
  onSessionIndexCleared,
  onOnboardingRestarted,
  onRemoteGatewaysChanged,
  onRefreshDiagnostics,
}: GlobalSettingsProps) {
  const { tr, formatDateTime } = useI18n();
  if (section === "remote") return <RemoteConnectionSettings />;

  if (section === "appearance") {
    return (
      <AppearanceSettings
        runtime={runtime}
        onChanged={(nextRuntime) => {
          cacheEffectiveTheme(nextRuntime.effective_theme, nextRuntime.theme_preference);
          onLocaleChanged(nextRuntime);
        }}
      />
    );
  }

  if (section === "general")
    return (
      <SettingsPage variant="form">
        <SettingsPageHeader title={tr("settings.section.general")} />
        <SettingsSection title={tr("settings.interface")} target="general-interface">
          <AppIconSetting runtime={runtime} onChanged={onLocaleChanged} />
          <LanguageSetting runtime={runtime} onChanged={onLocaleChanged} />
          <SettingsRow>
            <SettingsCopy>
              <strong>{tr("settings.closeBehavior")}</strong>
            </SettingsCopy>
            <CloseBehaviorSelect
              value={runtime?.close_behavior}
              trayAvailable={runtime?.tray_available !== false}
              onChange={onCloseBehaviorChanged}
            />
          </SettingsRow>
          <SettingsRow>
            <SettingsCopy>
              <strong>{tr("settings.onboarding")}</strong>
            </SettingsCopy>
            <Button variant="outline" onClick={() => void onOnboardingRestarted()}>
              {tr("settings.onboardingRestart")}
            </Button>
          </SettingsRow>
          {runtime?.tray_available === false && (
            <SettingsNotice tone="warning" role="status">
              <CircleAlert size={14} />
              {tr("settings.trayUnavailable")}
            </SettingsNotice>
          )}
        </SettingsSection>
        <KeyboardShortcutsSetting />
        <QuotaAutoRefreshSetting runtime={runtime} onChanged={onLocaleChanged} />
      </SettingsPage>
    );
  if (section === "tools")
    return (
      <SettingsPage variant="workspace">
        <SettingsPageHeader
          title={tr("settings.section.tools")}
          description={tr("settings.page.tools.description")}
        />
        <AgentToolsSettings
          currentVersion={runtime?.app_version}
          updatesEnabled={runtime?.updates_enabled ?? false}
        />
      </SettingsPage>
    );
  if (section === "discovery")
    return (
      <SettingsPage variant="management">
        <SettingsPageHeader
          title={tr("settings.section.discovery")}
          description={tr("settings.page.discovery.description")}
        />
        <div className="grid gap-5">
          <SettingsSection title={tr("settings.discovery")} target="discovery-status">
            <SettingsRow>
              <SettingsCopy>
                <strong className="whitespace-nowrap">{tr("settings.discoveryStatus")}</strong>
              </SettingsCopy>
              <span
                className={cn(
                  "font-medium",
                  discovery?.errors.length ? "text-destructive" : "text-emerald-600",
                )}
              >
                {discovery
                  ? tr("settings.workspaceCount", { count: discovery.discovered_count })
                  : tr("home.discovering")}
              </span>
            </SettingsRow>
            {discovery?.errors.map((error) => (
              <SettingsNotice tone="error" key={error}>
                {error}
              </SettingsNotice>
            ))}
          </SettingsSection>
          <DiscoveryDiagnostics discovery={discovery} />
          <SettingsSection
            title={tr("settings.scanRoots")}
            target="discovery-roots"
            action={
              <Button className="gap-2" onClick={() => void onAddRoot()}>
                <FolderPlus size={15} />
                {tr("settings.addFolder")}
              </Button>
            }
          >
            <SettingsListEmptyState items={scanRoots.length} emptyText={tr("settings.noScanRoots")}>
              <div className="divide-y divide-border/60">
                {scanRoots.map((root) => (
                  <div
                    className="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3"
                    key={root.id}
                  >
                    <FolderGit2 size={17} className="text-muted-foreground" />
                    <span className="min-w-0">
                      <strong className="block break-all text-sm font-medium">{root.path}</strong>
                      <small className="mt-1 block text-xs text-muted-foreground">
                        {tr("settings.maxDepth", { depth: root.max_depth })}
                      </small>
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/10"
                      aria-label={tr("common.remove")}
                      onClick={() => void onRemoveRoot(root.id)}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                ))}
              </div>
            </SettingsListEmptyState>
          </SettingsSection>
        </div>
        <SettingsSection title={tr("settings.excluded")} target="discovery-excluded">
          <SettingsListEmptyState items={excluded.length} emptyText={tr("settings.noExcluded")}>
            <div className="divide-y divide-border/60">
              {excluded.map((item) => (
                <div
                  className="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3"
                  key={item.path}
                >
                  <X size={17} className="text-muted-foreground" />
                  <span className="min-w-0">
                    <strong className="block break-all text-sm font-medium">{item.path}</strong>
                    <small className="mt-1 block text-xs text-muted-foreground">
                      {formatDateTime(item.created_at)}
                    </small>
                  </span>
                  <Button variant="outline" onClick={() => void onRestore(item.path)}>
                    {tr("common.restore")}
                  </Button>
                </div>
              ))}
            </div>
          </SettingsListEmptyState>
        </SettingsSection>
      </SettingsPage>
    );
  if (section === "integrations")
    return (
      <SettingsPage variant="management">
        <SettingsPageHeader
          title={tr("settings.section.integrations")}
          description={tr("settings.page.integrations.description")}
        />
        <SettingsSection title={tr("settings.search.localService")} target="integrations-mcp">
          <SettingsRow border={false}>
            <SettingsCopy>
              <strong>{tr("mcp.network")}</strong>
              <code>
                {runtime?.mcp_hub ? runtime.mcp_hub.accessible_addresses.join(" · ") : "—"}
              </code>
            </SettingsCopy>
            <SettingsStatus tone={runtime?.mcp_hub?.running ? "success" : "neutral"}>
              {tr(runtime?.mcp_hub?.running ? "mcp.running" : "mcp.stopped")}
            </SettingsStatus>
          </SettingsRow>
        </SettingsSection>
        <SettingsAnchor target="integrations-gateways">
          <RemoteGatewaysSettings gateways={remoteGateways} onChanged={onRemoteGatewaysChanged} />
        </SettingsAnchor>
        <SettingsAnchor target="integrations-obsidian">
          <ObsidianSettingsCard />
        </SettingsAnchor>
      </SettingsPage>
    );
  if (section === "privacy")
    return (
      <SettingsPage variant="form">
        <SettingsPageHeader title={tr("settings.section.privacy")} />
        <SettingsSection title={tr("settings.localData")} target="privacy-local">
          <SettingsRow border={false}>
            <SettingsCopy>
              <strong>{tr("settings.dataLocation")}</strong>
              <code>{runtime?.data_dir ?? "—"}</code>
            </SettingsCopy>
            <SettingsStatus tone="success" indicator={false}>
              <Check size={14} />
              {tr("common.localOnly")}
            </SettingsStatus>
          </SettingsRow>
          {hasFileAccessSettings && <FileAccessSettingsRow />}
        </SettingsSection>
        <SettingsAnchor target="privacy-sessions">
          <ConversationPrivacySettings
            runtime={runtime}
            workspaces={workspaces}
            onChanged={onLocaleChanged}
            onIndexCleared={onSessionIndexCleared}
          />
        </SettingsAnchor>
        <SettingsAnchor target="privacy-git">
          <GitIdentitySettings />
        </SettingsAnchor>
      </SettingsPage>
    );
  const providerIssues =
    insightsStatus?.providers.filter(
      (provider) => agentSupportsInsights(provider.agent) && !provider.available,
    ).length ?? 0;
  const diagnosticsHealthy =
    quotaStatus !== undefined &&
    insightsStatus !== undefined &&
    !quotaStatus.error_key &&
    providerIssues === 0;
  return (
    <SettingsPage variant="management">
      <SettingsPageHeader
        title={tr("settings.section.diagnostics")}
        description={tr("settings.page.diagnostics.description")}
        action={
          <Button variant="outline" onClick={() => void onRefreshDiagnostics()}>
            <RefreshCw size={15} />
            {tr("menu.refreshCurrent")}
          </Button>
        }
      />
      <SettingsSection title={tr("settings.search.overallHealth")} target="diagnostics-overview">
        <SettingsRow border={false}>
          <SettingsCopy>
            <strong>{tr("settings.diagnostics.healthStatus")}</strong>
            <small>{tr("settings.diagnostics.healthDescription")}</small>
          </SettingsCopy>
          <SettingsStatus tone={diagnosticsHealthy ? "success" : "warning"}>
            {tr(
              diagnosticsHealthy
                ? "settings.diagnostics.healthy"
                : "settings.diagnostics.needsAttention",
            )}
          </SettingsStatus>
        </SettingsRow>
      </SettingsSection>
      <SettingsPanel title={tr("quota.diagnostics")} target="diagnostics-quota">
        <QuotaDiagnostics status={quotaStatus} />
      </SettingsPanel>
      <SettingsPanel title={tr("settings.providerStatus")} target="diagnostics-providers">
        {insightsStatus?.providers
          .filter((provider) => agentSupportsInsights(provider.agent))
          .map((provider) => (
            <SettingsRow className="px-5" key={provider.agent}>
              <div className="flex items-center gap-3">
                <AgentIcon agent={provider.agent} />
                <strong className="text-sm font-medium">{agentLabels[provider.agent]}</strong>
              </div>
              <SettingsStatus tone={provider.available ? "success" : "neutral"}>
                {tr(provider.available ? "quota.available" : "insights.noData")}
              </SettingsStatus>
            </SettingsRow>
          ))}
        {!insightsStatus?.providers.length && (
          <div className="px-5 py-4 text-sm text-muted-foreground">{tr("insights.noData")}</div>
        )}
      </SettingsPanel>
      <SettingsAnchor target="diagnostics-activity">
        <ActivityPage records={activity} />
      </SettingsAnchor>
    </SettingsPage>
  );
}

function DiscoveryDiagnostics({ discovery }: { discovery?: DiscoveryReport }) {
  const { tr, formatDateTime } = useI18n();
  const sources = discovery?.source_diagnostics ?? [];
  return (
    <SettingsSection
      title={tr("settings.discoverySources")}
      description={tr("settings.discoveryDetails")}
      target="discovery-sources"
    >
      {sources.length ? (
        <div className="divide-y divide-border/60">
          {sources.map((source, index) => (
            <Collapsible
              className="group px-5 py-3"
              key={`${source.agent ?? "unknown"}:${source.source}:${index}`}
            >
              <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-3 bg-transparent p-0 text-left">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted/50 text-muted-foreground">
                  <FolderGit2 size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm font-medium">
                    {source.agent ? agentLabels[source.agent] : tr("agents.capability.unknown")}
                    {` · ${source.source}`}
                  </strong>
                  <small className="mt-1 block truncate text-xs text-muted-foreground">
                    {source.path ?? tr("settings.discoveryPathUnavailable")}
                  </small>
                </span>
                <span
                  className={cn(
                    "shrink-0 text-xs font-medium",
                    source.status === "succeeded" || source.status === "empty"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : source.status === "partial"
                        ? "text-amber-700 dark:text-amber-300"
                        : "text-destructive",
                  )}
                >
                  {discoverySourceStatusLabel(source.status, tr)}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3 grid gap-3 border-t border-border/60 pt-3 text-xs">
                <div className="grid gap-1">
                  <span className="text-muted-foreground">{tr("settings.discoveryDetails")}</span>
                  <code className="break-all rounded-md bg-muted/40 px-2 py-1 text-[11px] text-foreground">
                    {source.path ?? tr("settings.discoveryPathUnavailable")}
                  </code>
                </div>
                <div className="grid gap-x-5 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
                  <DiscoveryMetric
                    label={tr("settings.discoveryCandidates")}
                    value={source.candidate_count}
                  />
                  <DiscoveryMetric
                    label={tr("settings.discoveryWorkspaces")}
                    value={source.included_count}
                  />
                  <DiscoveryMetric
                    label={tr("settings.discoverySkipped")}
                    value={source.skipped_count}
                  />
                  <DiscoveryMetric
                    label={tr("settings.discoveryStarted")}
                    value={source.started_at ? formatDateTime(source.started_at) : undefined}
                  />
                  <DiscoveryMetric
                    label={tr("settings.discoveryFinished")}
                    value={source.finished_at ? formatDateTime(source.finished_at) : undefined}
                  />
                </div>
                {source.reasons?.length ? (
                  <div className="grid gap-1.5">
                    <strong className="font-medium">{tr("settings.discoveryReasons")}</strong>
                    <ul className="grid gap-1 text-muted-foreground">
                      {source.reasons.map((reason, reasonIndex) => (
                        <li className="flex flex-wrap gap-x-2" key={`${reason}:${reasonIndex}`}>
                          <span>{discoveryReasonLabel(reason, tr)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <span className="text-muted-foreground">{tr("settings.discoveryNoReasons")}</span>
                )}
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      ) : (
        <SettingsNotice inset={false} className="m-0 rounded-none border-0">
          {discovery ? tr("settings.discoveryDetailsUnavailable") : tr("home.discovering")}
        </SettingsNotice>
      )}
    </SettingsSection>
  );
}

function discoveryReasonLabel(reason: string, translate: (key: string) => string) {
  const key = `settings.discovery.reason.${reason}`;
  const translated = String(translate(key));
  return translated === key ? translate("settings.discovery.reason.unknown") : translated;
}

function DiscoveryMetric({ label, value }: { label: string; value?: number | string }) {
  return (
    <span className="grid gap-1">
      <span className="text-muted-foreground">{label}</span>
      <strong className="font-medium text-foreground">{value ?? "—"}</strong>
    </span>
  );
}

function discoverySourceStatusLabel(status: string, translate: (key: string) => string) {
  const key = `settings.discovery.status.${status}`;
  const translated = translate(key);
  return translated === key ? status : translated;
}

function ActivityPage({ records }: { records: ActivityRecord[] }) {
  const { t: tr } = useTranslation();
  return (
    <SettingsPanel title={tr("activity.title")} contentClassName="divide-y divide-border/60">
      {records.map((record) => (
        <ActivityRow key={record.id} record={record} />
      ))}
      {!records.length && (
        <div className="grid min-h-[260px] place-content-center justify-items-center gap-1.5 p-[30px] text-center text-muted-foreground">
          <History size={28} className="mb-1.5" />
          <h3 className="m-0 text-[13px] font-semibold text-foreground">{tr("home.noActivity")}</h3>
          <p className="m-0 max-w-[380px] leading-relaxed">{tr("activity.emptyText")}</p>
        </div>
      )}
    </SettingsPanel>
  );
}
function ActivityRow({ record }: { record: ActivityRecord }) {
  const { tr, formatDateTime } = useI18n();
  const presentation = activityPresentation(record, tr);
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-5 py-4">
      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
      <div className="grid min-w-0 gap-1">
        <strong>{presentation.title}</strong>
        <small className="truncate text-xs text-muted-foreground" title={presentation.detail}>
          {presentation.detail}
        </small>
      </div>
      <time className="text-right text-xs text-muted-foreground">
        {formatDateTime(record.created_at)}
      </time>
    </div>
  );
}

function SettingsListEmptyState({
  items,
  emptyText,
  children,
}: {
  items: number;
  emptyText: string;
  children: ReactNode;
}) {
  return items ? (
    <>{children}</>
  ) : (
    <p className="px-5 py-5 text-sm text-muted-foreground">{emptyText}</p>
  );
}

function FileAccessSettingsRow() {
  const { t: tr } = useTranslation();
  const [error, setError] = useState("");
  const openSettings = async () => {
    setError("");
    try {
      await api.openFilesAndFoldersSettings();
    } catch (reason) {
      setError(localizeMessage(reason));
    }
  };
  return (
    <>
      <SettingsRow border={false}>
        <SettingsCopy>
          <strong>{tr("settings.appDataAccess")}</strong>
        </SettingsCopy>
        <Button
          className="justify-self-end border border-transparent bg-transparent text-foreground hover:bg-muted"
          type="button"
          onClick={() => void openSettings()}
        >
          <ExternalLink size={14} />
          {tr("settings.openFilesAndFolders")}
        </Button>
      </SettingsRow>
      {error && (
        <SettingsNotice tone="error" role="alert">
          {error}
        </SettingsNotice>
      )}
    </>
  );
}

function KeyboardShortcutsSetting() {
  const { t: tr } = useTranslation();
  const { openShortcutHelp } = useShortcutHelp();
  const platform = currentAppPlatform();
  const definition = getShortcutDefinition("open-help");
  return (
    <SettingsSection title={tr("settings.shortcutsTitle")} target="general-shortcuts">
      <SettingsRow border={false}>
        <SettingsCopy>
          <strong>{tr("settings.shortcuts")}</strong>
        </SettingsCopy>
        <Button
          variant="outline"
          type="button"
          aria-keyshortcuts={ariaShortcut(definition, platform)}
          title={`${tr("settings.viewShortcuts")} (${formatShortcut(definition, platform)})`}
          onClick={openShortcutHelp}
        >
          <Keyboard size={14} />
          {tr("settings.viewShortcuts")}
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
}

function QuotaAutoRefreshSetting({
  runtime,
  onChanged,
}: {
  runtime?: RuntimeInfo;
  onChanged: (runtime: RuntimeInfo) => void;
}) {
  const { t: tr } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggle = async (enabled: boolean, local = false) => {
    setBusy(true);
    setError("");
    try {
      onChanged(
        await (local
          ? api.setLocalAutoRefreshEnabled(enabled)
          : api.setQuotaAutoRefreshEnabled(enabled)),
      );
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={tr("settings.automaticUpdates")} target="general-quota">
      <SettingsRow border={false}>
        <SettingsCopy>
          <strong>{tr("settings.localAutoRefresh")}</strong>
        </SettingsCopy>
        <Label className="inline-flex items-center justify-self-end">
          <Switch
            checked={runtime?.local_auto_refresh_enabled !== false}
            disabled={busy || !runtime}
            onCheckedChange={(checked) => void toggle(checked, true)}
          />
        </Label>
      </SettingsRow>
      <SettingsRow border={false}>
        <SettingsCopy>
          <strong>{tr("settings.quotaAutoRefresh")}</strong>
        </SettingsCopy>
        <Label className="inline-flex items-center justify-self-end">
          <Switch
            checked={runtime?.quota_auto_refresh_enabled === true}
            disabled={busy || !runtime}
            onCheckedChange={(checked) => void toggle(checked)}
          />
        </Label>
      </SettingsRow>
      {error && (
        <SettingsNotice tone="error" role="alert">
          {error}
        </SettingsNotice>
      )}
    </SettingsSection>
  );
}

function ConversationPrivacySettings({
  runtime,
  workspaces,
  onChanged,
  onIndexCleared,
}: {
  runtime?: RuntimeInfo;
  workspaces: WorkspaceSummary[];
  onChanged: (runtime: RuntimeInfo) => void;
  onIndexCleared: () => void;
}) {
  const { t: tr } = useTranslation();
  const dialogs = useAppDialogs();
  const [indexedCount, setIndexedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const loadCount = async () => {
    const statuses = await Promise.all(
      workspaces.map((workspace) => api.workspaceSessionStatus(workspace.id)),
    );
    setIndexedCount(statuses.filter((items) => items.some((item) => item.last_success_at)).length);
  };
  useEffect(() => {
    void loadCount().catch(() => undefined);
  }, [workspaces]);
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError("");
    try {
      onChanged(await api.setSessionIndexEnabled(enabled));
      if (!enabled) setIndexedCount(0);
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    if (
      !(await dialogs.confirm({
        description: tr("conversations.clearConfirm"),
        tone: "destructive",
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api.clearSessionIndex();
      onIndexCleared();
      setIndexedCount(0);
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection title={tr("conversations.settingsTitle")}>
      <SettingsRow>
        <SettingsCopy>
          <strong>{tr("conversations.indexSetting")}</strong>
        </SettingsCopy>
        <Label className="inline-flex items-center justify-self-end">
          <Switch
            checked={runtime?.session_index_enabled !== false}
            disabled={busy}
            onCheckedChange={(checked) => void toggle(checked)}
          />
        </Label>
      </SettingsRow>
      <SettingsRow>
        <SettingsCopy>
          <strong>{tr("conversations.indexedWorkspaces", { count: indexedCount })}</strong>
        </SettingsCopy>
        <Button
          className="justify-self-end border border-transparent bg-transparent text-foreground hover:bg-muted"
          disabled={busy || indexedCount === 0}
          onClick={() => void clear()}
        >
          <Trash2 size={14} />
          {tr("conversations.clearIndex")}
        </Button>
      </SettingsRow>
      {error && (
        <SettingsNotice tone="error" role="alert">
          {error}
        </SettingsNotice>
      )}
    </SettingsSection>
  );
}

function LanguageSetting({
  runtime,
  onChanged,
}: {
  runtime?: RuntimeInfo;
  onChanged: (runtime: RuntimeInfo) => void;
}) {
  const { t: tr } = useTranslation();
  const update = async (preference: LocalePreference) => {
    const nextRuntime = await api.setLocale(preference);
    cacheEffectiveLocale(nextRuntime.effective_locale, nextRuntime.locale_preference);
    await changeLocale(nextRuntime.effective_locale);
    onChanged(nextRuntime);
  };
  return (
    <SettingsRow>
      <SettingsCopy>
        <strong>{tr("settings.language")}</strong>
      </SettingsCopy>
      <Select
        value={runtime?.locale_preference ?? "system"}
        onValueChange={(value) => {
          if (value !== null) void update(String(value) as LocalePreference);
        }}
      >
        <SelectTrigger className={settingsControlClass} aria-label={tr("settings.language")}>
          <SelectValue>
            {tr(`settings.language.${runtime?.locale_preference ?? "system"}`)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {(["system", "zh-CN", "zh-TW", "ja-JP", "en-US"] as LocalePreference[]).map((locale) => (
            <SelectItem key={locale} value={locale}>
              {tr(`settings.language.${locale}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}

export function AccentThemeSetting({
  runtime,
  onChanged,
}: {
  runtime?: RuntimeInfo;
  onChanged: (runtime: RuntimeInfo) => void;
}) {
  const { t: tr } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = runtime?.accent_theme_preference ?? accentThemePreference();
  const update = async (preference: (typeof ACCENT_THEME_IDS)[number]) => {
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
    <>
      <SettingsRow>
        <SettingsCopy>
          <strong>{tr("settings.accentTheme")}</strong>
          <small className="sr-only">
            {tr(
              runtime?.effective_theme === "dark"
                ? "settings.accentTheme.darkHint"
                : "settings.accentTheme.description",
            )}
          </small>
        </SettingsCopy>
        <Select
          value={selected}
          disabled={busy || !runtime}
          onValueChange={(value) => {
            if (isAccentThemeId(value)) void update(value);
          }}
        >
          <SelectTrigger className={settingsControlClass} aria-label={tr("settings.accentTheme")}>
            <SelectValue>{tr(`settings.accentTheme.${selected}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {ACCENT_THEME_IDS.map((theme) => (
              <SelectItem key={theme} value={theme}>
                {tr(`settings.accentTheme.${theme}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      {error && (
        <SettingsNotice tone="error" role="alert">
          {error}
        </SettingsNotice>
      )}
    </>
  );
}

function AppIconSetting({
  runtime,
  onChanged,
}: {
  runtime?: RuntimeInfo;
  onChanged: (runtime: RuntimeInfo) => void;
}) {
  const { t: tr } = useTranslation();
  const update = async (preference: AppIconPreference) => {
    onChanged(await api.setAppIconPreference(preference));
  };
  const selected = runtime?.app_icon_preference ?? "white";
  return (
    <SettingsRow>
      <SettingsCopy>
        <strong>{tr("settings.appIcon")}</strong>
      </SettingsCopy>
      <ToggleGroup
        spacing={0}
        variant="outline"
        className="segmented-control shrink-0 justify-self-end"
        value={[selected]}
        onValueChange={(values) => {
          const icon = values[0];
          if (icon === "white" || icon === "black") void update(icon);
        }}
        aria-label={tr("settings.appIcon")}
      >
        {(["white", "black"] as AppIconPreference[]).map((icon) => (
          <ToggleGroupItem
            key={icon}
            value={icon}
            className="segmented-control-item inline-flex h-10 min-h-10 w-14 min-w-14 items-center justify-center px-4 py-0"
            aria-label={tr(`settings.appIcon.${icon}`)}
            title={tr(`settings.appIcon.${icon}`)}
          >
            <img
              className="size-6 shrink-0 rounded-md object-cover"
              src={appIconAssets[icon]}
              alt=""
              aria-hidden="true"
            />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </SettingsRow>
  );
}

function CloseBehaviorSelect({
  value,
  trayAvailable = true,
  onChange,
}: {
  value?: CloseBehavior;
  trayAvailable?: boolean;
  onChange: (behavior?: CloseBehavior) => Promise<void>;
}) {
  const { t: tr } = useTranslation();
  const modifier = primaryShortcutModifier(buildPlatform);
  const trayKey = usesSystemTrayWording(buildPlatform)
    ? "settings.close.systemTray"
    : "settings.close.tray";
  const selected = value ?? "ask";
  return (
    <Select
      value={selected}
      onValueChange={(value) => {
        if (value !== null)
          void onChange(value === "ask" ? undefined : (String(value) as CloseBehavior));
      }}
    >
      <SelectTrigger
        className={settingsControlClass}
        aria-label={tr("settings.closeBehavior")}
        title={tr("settings.close.quitShortcut", { modifier })}
      >
        <SelectValue>
          {selected === "ask"
            ? tr("settings.close.ask")
            : selected === "quit"
              ? tr("settings.close.quit")
              : tr(trayKey)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="ask">{tr("settings.close.ask")}</SelectItem>
        <SelectItem value="minimize-to-tray" disabled={!trayAvailable}>
          {tr(trayKey)}
        </SelectItem>
        <SelectItem value="quit">{tr("settings.close.quit")}</SelectItem>
      </SelectContent>
    </Select>
  );
}

function GitIdentitySettings() {
  const { t: tr } = useTranslation();
  const [identities, setIdentities] = useState<GitIdentitySummary[]>([]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const load = async () => {
    try {
      setIdentities(await api.gitIdentities());
    } catch (reason) {
      setError(localizeMessage(reason));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const add = async () => {
    if (!email.trim()) return;
    try {
      setError("");
      await api.addGitIdentityAlias(email);
      setEmail("");
      await load();
    } catch (reason) {
      setError(localizeMessage(reason));
    }
  };
  return (
    <SettingsSection title={tr("settings.gitIdentity")}>
      {error && (
        <SettingsNotice tone="error" role="alert">
          {error}
        </SettingsNotice>
      )}
      <div className="flex flex-col gap-2.5 border-b border-border/60 p-5 sm:flex-row">
        <Input
          className="min-w-0 flex-1"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void add();
          }}
          placeholder={tr("settings.gitAliasPlaceholder")}
        />
        <Button className="shrink-0" onClick={() => void add()}>
          {tr("settings.addAlias")}
        </Button>
      </div>
      <div className="divide-y divide-border/60">
        {identities.map((identity) => (
          <Label
            className="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3"
            key={identity.id}
          >
            <GitCommitHorizontal size={15} className="text-muted-foreground" />
            <span className="min-w-0">
              <strong className="block break-all text-sm font-medium">
                {metadataLabel(identity.label, tr)}
              </strong>
              <small className="mt-1 block text-xs text-muted-foreground">
                {identity.source} · {identity.id.slice(0, 10)}…
              </small>
            </span>
            <Switch
              checked={identity.enabled}
              onCheckedChange={async (checked) => {
                await api.setGitIdentityEnabled(identity.id, checked);
                await load();
              }}
            />
          </Label>
        ))}
        {!identities.length && (
          <p className="px-5 py-5 text-sm text-muted-foreground">
            {tr("settings.gitIdentityEmpty")}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}

function metadataLabel(value: string, tr: TFunction) {
  if (value === "__unknown_model__") return tr("insights.unknownModel");
  if (value === "__unlinked_workspace__") return tr("insights.unlinkedWorkspace");
  if (value === "仓庫 Git 身份") return tr("settings.gitIdentityRepository");
  if (value === "全局 Git 身份") return tr("settings.gitIdentityGlobal");
  if (value === "历史邮箱别名") return tr("settings.gitIdentityAlias");
  return value.startsWith("settings.gitIdentity") ? tr(value) : value;
}
