import { useI18n } from "@/core/useI18n";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useState } from "react";
import { ExternalLink, FolderOpen, Link2, Unlink } from "lucide-react";
import { api } from "@/core/api";
import { useOptionalQueryClient } from "@/features/home/home-query";
import { obsidianKeys, useObsidianIntegration } from "./obsidian-query";

import type { ObsidianIntegration } from "@/core/types";
import { SettingsNotice, SettingsPanel } from "@/features/settings/components/SettingsLayout";

function InstallationStatus({ integration }: { integration: ObsidianIntegration }) {
  const { tr } = useI18n();
  const { installation } = integration;
  return (
    <div className="flex items-center gap-2.5 px-5 pb-2 pt-4">
      <Badge variant={installation.installed ? "secondary" : "outline"}>
        {tr(installation.installed ? "obsidian.installed" : "obsidian.notInstalled")}
      </Badge>
      {installation.version && (
        <small className="text-xs text-muted-foreground">
          {tr("obsidian.version", { version: installation.version })}
        </small>
      )}
      <small className="text-xs text-muted-foreground">
        {tr(installation.cli_available ? "obsidian.cliAvailable" : "obsidian.cliUnavailable")}
      </small>
    </div>
  );
}

/** 操作失败优先显示；否则显示读取失败。 */
function useObsidianError(actionError: unknown, loadError: unknown) {
  const { localizeMessage } = useI18n();
  const cause = actionError !== "" ? actionError : loadError;
  return cause === "" || cause == null ? "" : localizeMessage(cause);
}

export function ObsidianSettingsCard() {
  const { tr } = useI18n();
  const queryClient = useOptionalQueryClient();
  const { data: integration, error: loadError } = useObsidianIntegration();
  const [actionError, setError] = useState<unknown>("");
  const error = useObsidianError(actionError, loadError);

  const openApp = async () => {
    try {
      setError("");
      await api.openObsidian();
    } catch (cause) {
      setError(cause);
    }
  };

  const addVault = async () => {
    const selected = await api.pickDirectory(tr("obsidian.addVaultDialog"));
    if (typeof selected !== "string") return;
    try {
      setError("");
      queryClient.setQueryData(obsidianKeys.integration(), await api.addObsidianVault(selected));
    } catch (cause) {
      setError(cause);
    }
  };

  return (
    <SettingsPanel
      title={tr("obsidian.title")}
      action={
        <div className="flex items-center gap-2">
          {integration?.installation.installed && (
            <Button variant="outline" onClick={() => void openApp()}>
              <ExternalLink size={15} />
              {tr("obsidian.open")}
            </Button>
          )}
          <Button onClick={() => void addVault()}>
            <FolderOpen size={15} />
            {tr("obsidian.addVault")}
          </Button>
        </div>
      }
    >
      {integration ? (
        <InstallationStatus integration={integration} />
      ) : (
        <div
          className="grid gap-2 px-5 py-4"
          role="status"
          aria-busy="true"
          aria-label={tr("common.loading")}
        >
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3 w-64" />
        </div>
      )}
      {integration?.installation.app_path && (
        <code className="mx-5 mb-3 block break-all text-xs text-muted-foreground">
          {integration.installation.app_path}
        </code>
      )}
      {error && (
        <SettingsNotice tone="error" role="alert">
          {error}
        </SettingsNotice>
      )}
      <div className="px-5 pb-5 pt-2.5">
        <h3 className="mb-2 text-xs font-semibold text-muted-foreground">
          {tr("obsidian.vaults")}
        </h3>
        {integration?.vaults.map((vault) => (
          <div
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-border/60 py-3"
            key={vault.path}
          >
            <FolderOpen className="text-muted-foreground" size={16} />
            <span className="min-w-0">
              <strong className="block text-sm">{vault.name}</strong>
              <small className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                {vault.path}
              </small>
            </span>
            <Badge variant="outline">{tr(`obsidian.source.${vault.source}`)}</Badge>
          </div>
        ))}
        {integration && !integration.vaults.length && (
          <p className="text-sm text-muted-foreground">{tr("obsidian.noVaults")}</p>
        )}
      </div>
    </SettingsPanel>
  );
}

export function WorkspaceObsidianCard({ workspaceId }: { workspaceId: string }) {
  const { tr } = useI18n();
  const queryClient = useOptionalQueryClient();
  const { data: integration, error: loadError } = useObsidianIntegration();
  const [selectedVaultPath, setVaultPath] = useState("");
  const [relativeTarget, setRelativeTarget] = useState("");
  const [actionError, setError] = useState<unknown>("");
  const error = useObsidianError(actionError, loadError);
  // 用户没选时默认第一个 vault；不再把服务端数据同步进 state。
  const vaultPath = selectedVaultPath || integration?.vaults[0]?.path || "";
  const link = integration?.workspace_links.find((item) => item.workspace_id === workspaceId);

  const reload = () => queryClient.invalidateQueries({ queryKey: obsidianKeys.integration() });

  const linkWorkspace = async () => {
    if (!vaultPath) return;
    try {
      setError("");
      await api.linkWorkspaceToObsidian(workspaceId, vaultPath, relativeTarget);
      await reload();
    } catch (cause) {
      setError(cause);
    }
  };

  const unlinkWorkspace = async () => {
    try {
      setError("");
      await api.unlinkWorkspaceFromObsidian(workspaceId);
      await reload();
    } catch (cause) {
      setError(cause);
    }
  };

  const openLinkedTarget = async () => {
    try {
      setError("");
      await api.openWorkspaceInObsidian(workspaceId);
    } catch (cause) {
      setError(cause);
    }
  };

  if (integration && !integration.installation.installed && !link) return null;

  return (
    <Card className="overflow-hidden rounded-2xl border-border/70 pb-5 shadow-sm">
      <div className="flex min-h-16 items-center justify-between gap-4 border-b border-border/60 bg-muted/20 px-5 py-3">
        <h2>{tr("obsidian.workspaceTitle")}</h2>
        {link && (
          <Button variant="outline" onClick={() => void openLinkedTarget()}>
            <ExternalLink size={15} />
            {tr("obsidian.open")}
          </Button>
        )}
      </div>
      {error && (
        <div className="mx-5 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {!integration && (
        <div
          className="grid gap-2 px-5 py-4"
          role="status"
          aria-busy="true"
          aria-label={tr("common.loading")}
        >
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3 w-64" />
        </div>
      )}
      {integration && !integration.installation.installed && (
        <p className="px-5 py-3 text-sm text-muted-foreground">
          {tr("obsidian.notInstalledWorkspace")}
        </p>
      )}
      {integration?.installation.installed && link && (
        <div className="mx-5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-border/60 py-3">
          <Link2 className="text-muted-foreground" size={17} />
          <span className="min-w-0">
            <strong className="block text-sm">{tr("obsidian.linked")}</strong>
            <small className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
              {link.target_path}
            </small>
          </span>
          <Button variant="outline" onClick={() => void unlinkWorkspace()}>
            <Unlink size={15} />
            {tr("obsidian.unlink")}
          </Button>
        </div>
      )}
      {integration?.installation.installed && !link && integration.vaults.length > 0 && (
        <div className="mx-5 grid grid-cols-[minmax(180px,.8fr)_minmax(240px,1.2fr)_auto] items-end gap-3 pt-4 max-[760px]:grid-cols-1">
          <Label>
            {tr("obsidian.chooseVault")}
            <Select
              value={vaultPath}
              onValueChange={(value) => {
                if (value !== null) setVaultPath(String(value));
              }}
            >
              <SelectTrigger aria-label={tr("obsidian.chooseVault")}>
                <SelectValue>
                  {integration.vaults.find((vault) => vault.path === vaultPath)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {integration.vaults.map((vault) => (
                  <SelectItem key={vault.path} value={vault.path}>
                    {vault.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
          <Label>
            {tr("obsidian.relativeTarget")}
            <Input
              value={relativeTarget}
              onChange={(event) => setRelativeTarget(event.target.value)}
              placeholder={tr("obsidian.relativeTargetHint")}
            />
          </Label>
          <Button disabled={!vaultPath} onClick={() => void linkWorkspace()}>
            <Link2 size={15} />
            {tr("obsidian.link")}
          </Button>
        </div>
      )}
      {integration?.installation.installed && !link && !integration.vaults.length && (
        <p className="text-sm text-muted-foreground">{tr("obsidian.addVaultFirst")}</p>
      )}
    </Card>
  );
}
