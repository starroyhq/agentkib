import { useState, type ReactNode } from "react";
import { useI18n } from "@/core/useI18n";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SettingsTarget } from "./SettingsSidebar";
import { SettingsAnchor, SettingsPage, SettingsPageHeader } from "./components/SettingsLayout";

export function AgentIntegrationsSettings({
  target,
  onTargetChange,
  agents,
  children,
}: {
  target?: SettingsTarget;
  onTargetChange?: (target: SettingsTarget) => void;
  agents?: ReactNode;
  children: ReactNode;
}) {
  const { tr } = useI18n();
  // Existing integrations links without a target keep their original destination.
  const [localTarget, setLocalTarget] = useState(target);
  const activeTarget = onTargetChange ? target : localTarget;
  const active = activeTarget === "integrations-agents" ? "agents" : "integrations";
  return (
    <SettingsPage variant="workspace">
      <SettingsAnchor target="integrations-agents">
        <SettingsPageHeader title={tr("settings.section.integrations")} />
      </SettingsAnchor>
      <Tabs
        value={active}
        onValueChange={(value) => {
          const next = value === "agents" ? "integrations-agents" : "integrations-mcp";
          if (onTargetChange) onTargetChange(next);
          else setLocalTarget(next);
        }}
      >
        <TabsList
          className="segmented-control w-fit"
          aria-label={tr("settings.section.integrations")}
        >
          <TabsTrigger className="segmented-control-item" value="agents">
            {tr("nav.agents")}
          </TabsTrigger>
          <TabsTrigger className="segmented-control-item" value="integrations">
            {tr("settings.integrationsTab")}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {active === "agents" ? agents : <div className="grid gap-5">{children}</div>}
    </SettingsPage>
  );
}
