import { useEffect, useState } from "react";
import { claudeConnectionCopy, readClaudeBridgePluginStatus } from "@agentkib/session-ui";
import { Switch } from "@/components/ui/switch";
import { desktopApi } from "@/core/desktop";
import { useI18n } from "@/core/useI18n";
import { usePathDisplay } from "@/lib/usePathDisplay";
import {
  SettingsCopy,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
} from "./components/SettingsLayout";

const statusRequest = { operation: "bridge-plugin-status" };
const readStatus = async (params: Record<string, unknown>) =>
  readClaudeBridgePluginStatus(await desktopApi().claude.request(params));

export function ClaudeBridgePluginSettings() {
  const { locale, tr } = useI18n();
  const copy = claudeConnectionCopy[locale];
  const displayPath = usePathDisplay();
  const [status, setStatus] = useState<ReturnType<typeof readClaudeBridgePluginStatus>>();
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [switchFailed, setSwitchFailed] = useState(false);

  useEffect(() => {
    if (switching) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      const next = await readStatus(statusRequest).catch(() => undefined);
      if (!current) return;
      setStatus(next);
      setLoading(false);
      if (next?.status === "updating") timer = setTimeout(() => void refresh(), 1_000);
    }
    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [switching]);

  const canChange =
    status?.canChangeAutomatic === true && typeof status.automaticEnabled === "boolean";
  const disabled = !canChange || switching;
  const disabledReason =
    loading || switching ? tr("common.loading") : copy.pluginAutomaticUnavailable;
  async function toggle(enabled: boolean) {
    if (disabled) return;
    setSwitching(true);
    setSwitchFailed(false);
    try {
      const next = await readStatus({ operation: "bridge-plugin-auto-update", enabled });
      if (next?.automaticEnabled !== enabled) throw new Error("invalid_bridge_plugin_status");
      setStatus(next);
    } catch {
      setSwitchFailed(true);
    } finally {
      setSwitching(false);
    }
  }

  const scopeLabels = {
    user: copy.pluginScopeUser,
    project: copy.pluginScopeProject,
    local: copy.pluginScopeLocal,
  };
  return (
    <SettingsSection title={copy.title}>
      <SettingsRow>
        <SettingsCopy>
          <strong>{copy.pluginAutomatic}</strong>
        </SettingsCopy>
        <span title={disabled ? disabledReason : undefined}>
          <Switch
            aria-label={copy.pluginAutomatic}
            checked={status?.automaticEnabled !== false}
            disabled={disabled}
            onCheckedChange={(enabled) => void toggle(enabled)}
          />
        </span>
      </SettingsRow>
      <SettingsRow>
        <SettingsCopy>
          <strong>{copy.pluginScopes}</strong>
          {status && (
            <small>{copy.pluginBundledVersion.replace("{version}", status.bundledVersion)}</small>
          )}
        </SettingsCopy>
        {status?.installations?.length ? (
          <ul className="grid min-w-0 gap-1 text-sm">
            {status.installations.map(({ scope, version, projectPath }) => (
              <li key={JSON.stringify([scope, version, projectPath])}>
                <span>
                  {scopeLabels[scope]} · {version}
                </span>
                {projectPath && (
                  <code
                    className="block max-w-64 truncate text-xs text-muted-foreground"
                    title={projectPath}
                  >
                    {displayPath(projectPath)}
                  </code>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-sm text-muted-foreground">
            {status?.installations ? tr("common.notInstalled") : "—"}
          </span>
        )}
      </SettingsRow>
      {status?.status === "updating" && (
        <SettingsNotice role="status">{copy.pluginUpdating}</SettingsNotice>
      )}
      {status?.status === "updated" && (
        <SettingsNotice role="status">{copy.pluginUpdated}</SettingsNotice>
      )}
      {status?.status === "failed" && (
        <SettingsNotice tone="error" role="alert" className="grid gap-1">
          <strong>{copy.pluginAutomaticFailed}</strong>
          {status.reason && <p className="break-words">{status.reason}</p>}
          {status.installInstructions && (
            <div className="min-w-0">
              <p>{copy.pluginInstallInstructions}</p>
              <pre className="overflow-auto whitespace-pre-wrap break-all">
                {status.installInstructions}
              </pre>
            </div>
          )}
        </SettingsNotice>
      )}
      {switchFailed && (
        <SettingsNotice tone="error" role="alert">
          {tr("errors.generic")}
        </SettingsNotice>
      )}
    </SettingsSection>
  );
}
