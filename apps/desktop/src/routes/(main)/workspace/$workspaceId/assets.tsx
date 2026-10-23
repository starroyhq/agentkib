import { fileName, shortPath } from "@/lib/path-display";
import { useI18n } from "@/core/useI18n";
import { createFileRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { WorkspaceAssetsSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useId, useMemo, useRef, useState } from "react";
import { AssetCatalogPage } from "@/features/catalog/AssetCatalogPage";
import { groupWorkspaceAssets } from "@/features/catalog/catalog";
import { MarkdownContent } from "@/components/MarkdownContent";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileCode2, Search, ShieldCheck, X } from "lucide-react";
import { cn } from "cn";
import type { AgentKind, ConnectionDefinition, Manifest, WorkspaceScan } from "@/core/types";
import { AGENT_LABELS as agentLabels } from "@/core/agents";
type WorkspaceAssetSection = "instructions" | "skills" | "mcp" | "native";

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}
function Assets({
  section,
  onSection,
  scan,
  manifest,
  onChange,
}: {
  section: WorkspaceAssetSection;
  onSection: (section: WorkspaceAssetSection) => void;
  scan: WorkspaceScan;
  manifest: Manifest;
  onChange: (manifest: Manifest) => void;
}) {
  const { tr } = useI18n();
  const [query, setQuery] = useState("");
  const [skillName, setSkillName] = useState("");
  const [skillPath, setSkillPath] = useState("");
  const [connectionName, setConnectionName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [endpoint, setEndpoint] = useState("");
  const formId = useId();
  const skillNameInput = useRef<HTMLInputElement>(null);
  const skillPathInput = useRef<HTMLInputElement>(null);
  const connectionNameInput = useRef<HTMLInputElement>(null);
  const endpointInput = useRef<HTMLInputElement>(null);
  const skillRows = useRef(new Map<string, HTMLDivElement>());
  const connectionRows = useRef(new Map<string, HTMLDivElement>());
  const [skillAttempted, setSkillAttempted] = useState(false);
  const [connectionAttempted, setConnectionAttempted] = useState(false);
  const normalizedSkillName = skillName.trim();
  const normalizedConnectionName = connectionName.trim();
  const existingSkill = manifest.skills.find((item) => item.name.trim() === normalizedSkillName);
  const existingConnection = manifest.connections.find(
    (item) => item.name.trim() === normalizedConnectionName,
  );
  const skillNameError = !normalizedSkillName
    ? "assets.nameRequired"
    : /[\\/]/.test(normalizedSkillName) || [".", ".."].includes(normalizedSkillName)
      ? "assets.skillNameInvalid"
      : existingSkill
        ? "assets.duplicateDraftName"
        : undefined;
  const skillPathError = !skillPath.trim() ? "assets.skillPathRequired" : undefined;
  const connectionNameError = !normalizedConnectionName
    ? "assets.nameRequired"
    : existingConnection
      ? "assets.duplicateDraftName"
      : undefined;
  // Match manifest validation; a stricter URL parser would reject existing
  // drafts that the backend accepts. Command/path availability stays in review.
  const endpointError = !endpoint.trim()
    ? transport === "stdio"
      ? "assets.commandRequired"
      : "assets.urlRequired"
    : transport === "http" && !/^https?:\/\//.test(endpoint.trim())
      ? "assets.httpUrlInvalid"
      : undefined;
  const showExisting = (row?: HTMLDivElement) => {
    row?.scrollIntoView?.({ block: "nearest" });
    row?.focus({ preventScroll: true });
  };
  const [instructionsMode, setInstructionsMode] = useState<"preview" | "edit">("preview");
  const nativeAssets = useMemo(() => groupWorkspaceAssets(scan.assets), [scan.assets]);
  const filtered = nativeAssets.filter((asset) =>
    `${asset.agents.join(" ")} ${asset.kind} ${asset.path}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const addSkill = () => {
    setSkillAttempted(true);
    if (skillNameError || skillPathError) {
      (skillNameError ? skillNameInput : skillPathInput).current?.focus();
      return;
    }
    onChange({
      ...manifest,
      skills: [
        ...manifest.skills,
        { name: normalizedSkillName, path: skillPath.trim(), targets: [] },
      ],
    });
    setSkillName("");
    setSkillPath("");
    setSkillAttempted(false);
  };
  const addConnection = () => {
    setConnectionAttempted(true);
    if (connectionNameError || endpointError) {
      (connectionNameError ? connectionNameInput : endpointInput).current?.focus();
      return;
    }
    const common = {
      name: normalizedConnectionName,
      env: {},
      allow_tools: [] as string[],
      targets: [] as AgentKind[],
    };
    const connection: ConnectionDefinition =
      transport === "stdio"
        ? { ...common, transport, command: endpoint.trim(), args: [] }
        : { ...common, transport, url: endpoint.trim() };
    onChange({
      ...manifest,
      connections: [...manifest.connections, connection],
    });
    setConnectionName("");
    setEndpoint("");
    setConnectionAttempted(false);
  };
  const tabs: Array<[WorkspaceAssetSection, string, number]> = [
    ["instructions", "assets.instructions", manifest.instructions.shared.trim() ? 1 : 0],
    ["skills", "assets.skills", manifest.skills.length],
    ["mcp", "MCP", manifest.connections.length],
    ["native", "assets.nativeAssets", nativeAssets.length],
  ];
  return (
    <div className="grid gap-4">
      <Tabs
        className="min-w-0 max-w-full"
        value={section}
        onValueChange={(value) => onSection(value as WorkspaceAssetSection)}
      >
        <TabsList
          className="segmented-control w-fit max-w-full justify-start"
          variant="default"
          aria-label={tr("nav.assets")}
        >
          {tabs.map(([value, label, count]) => (
            <TabsTrigger
              className="segmented-control-item h-9 min-h-9 flex-none px-3 text-xs sm:text-sm"
              value={value}
              key={value}
            >
              {label === "MCP" ? label : tr(label)}
              <em>{count}</em>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {section === "instructions" && (
        <Card className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          {!scan.manifest_exists && (
            <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              <ShieldCheck size={16} />
              <strong>{tr("assets.sharedLayerEmpty")}</strong>
            </div>
          )}
          <div className="grid gap-2 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-foreground">
                {tr("assets.sharedInstructions")}
              </span>
              <Tabs
                className="min-w-0"
                value={instructionsMode}
                onValueChange={(value) => setInstructionsMode(value as "preview" | "edit")}
              >
                <TabsList
                  className="segmented-control w-fit justify-start"
                  variant="default"
                  aria-label={tr("assets.sharedInstructions")}
                >
                  <TabsTrigger className="segmented-control-item h-8 px-3 text-xs" value="preview">
                    {tr("assets.preview")}
                  </TabsTrigger>
                  <TabsTrigger className="segmented-control-item h-8 px-3 text-xs" value="edit">
                    {tr("common.edit")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            {instructionsMode === "preview" ? (
              <MarkdownContent
                content={manifest.instructions.shared || tr("assets.sharedLayerEmpty")}
                className="min-h-48 rounded-xl border border-border bg-background px-4 py-3 text-sm [overflow-wrap:anywhere]"
              />
            ) : (
              <Textarea
                value={manifest.instructions.shared}
                onChange={(event) =>
                  onChange({
                    ...manifest,
                    instructions: { ...manifest.instructions, shared: event.target.value },
                  })
                }
              />
            )}
          </div>
        </Card>
      )}
      {section === "skills" && (
        <Card className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          <div className="grid gap-4">
            {!manifest.skills.length && (
              <p className="p-4 text-sm text-muted-foreground">{tr("assets.noDraftSkills")}</p>
            )}
            {manifest.skills.map((skill) => (
              <div
                className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                key={skill.name}
                role="group"
                aria-label={skill.name}
                tabIndex={-1}
                ref={(row) => {
                  if (row) skillRows.current.set(skill.name, row);
                  else skillRows.current.delete(skill.name);
                }}
              >
                <span>
                  <strong>{skill.name}</strong>
                  <small>{skill.path}</small>
                </span>
                <Button
                  variant="destructive"
                  size="icon"
                  aria-label={tr("assets.removeDraftItem", { name: skill.name })}
                  title={tr("assets.removeDraftItem", { name: skill.name })}
                  onClick={() =>
                    onChange({
                      ...manifest,
                      skills: manifest.skills.filter((item) => item.name !== skill.name),
                    })
                  }
                >
                  <X size={13} />
                </Button>
              </div>
            ))}
          </div>
          <form
            noValidate
            className="flex flex-wrap items-end gap-3 p-4"
            aria-label={tr("assets.skills")}
            onSubmit={(event) => {
              event.preventDefault();
              addSkill();
            }}
          >
            <div className="grid min-w-40 flex-1 gap-1.5">
              <Label htmlFor={`${formId}-skill-name`}>{tr("assets.name")}</Label>
              <Input
                id={`${formId}-skill-name`}
                ref={skillNameInput}
                required
                aria-invalid={(skillAttempted && Boolean(skillNameError)) || undefined}
                aria-describedby={
                  skillAttempted && skillNameError ? `${formId}-skill-name-error` : undefined
                }
                value={skillName}
                onChange={(event) => setSkillName(event.target.value)}
                placeholder={tr("assets.name")}
              />
              {skillAttempted && skillNameError && (
                <p
                  id={`${formId}-skill-name-error`}
                  role="alert"
                  className="text-xs text-destructive-text"
                >
                  {tr(skillNameError, { name: existingSkill?.name })}
                </p>
              )}
              {skillAttempted &&
                skillNameError === "assets.duplicateDraftName" &&
                existingSkill && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => showExisting(skillRows.current.get(existingSkill.name))}
                  >
                    {tr("assets.viewExistingDraftItem")}
                  </Button>
                )}
            </div>
            <div className="grid min-w-40 flex-1 gap-1.5">
              <Label htmlFor={`${formId}-skill-path`}>{tr("assets.skillPath")}</Label>
              <Input
                id={`${formId}-skill-path`}
                ref={skillPathInput}
                required
                aria-invalid={(skillAttempted && Boolean(skillPathError)) || undefined}
                aria-describedby={
                  skillAttempted && skillPathError ? `${formId}-skill-path-error` : undefined
                }
                value={skillPath}
                onChange={(event) => setSkillPath(event.target.value)}
                placeholder=".agents/skills/name"
              />
              {skillAttempted && skillPathError && (
                <p
                  id={`${formId}-skill-path-error`}
                  role="alert"
                  className="text-xs text-destructive-text"
                >
                  {tr(skillPathError)}
                </p>
              )}
            </div>
            <Button
              type="submit"
              className="bg-primary text-primary-foreground hover:bg-[var(--primary-hover-strong)]"
            >
              {tr("common.add")}
            </Button>
          </form>
        </Card>
      )}
      {section === "mcp" && (
        <Card className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          <div className="grid gap-4">
            {!manifest.connections.length && (
              <p className="p-4 text-sm text-muted-foreground">{tr("assets.noDraftConnections")}</p>
            )}
            {manifest.connections.map((connection) => (
              <div
                className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                key={connection.name}
                role="group"
                aria-label={connection.name}
                tabIndex={-1}
                ref={(row) => {
                  if (row) connectionRows.current.set(connection.name, row);
                  else connectionRows.current.delete(connection.name);
                }}
              >
                <span>
                  <strong>{connection.name}</strong>
                  <small>
                    {connection.transport === "stdio" ? connection.command : connection.url}
                  </small>
                </span>
                <Button
                  variant="destructive"
                  size="icon"
                  aria-label={tr("assets.removeDraftItem", { name: connection.name })}
                  title={tr("assets.removeDraftItem", { name: connection.name })}
                  onClick={() =>
                    onChange({
                      ...manifest,
                      connections: manifest.connections.filter(
                        (item) => item.name !== connection.name,
                      ),
                    })
                  }
                >
                  <X size={13} />
                </Button>
              </div>
            ))}
          </div>
          <form
            noValidate
            className="flex flex-wrap items-end gap-3 p-4"
            aria-label="MCP"
            onSubmit={(event) => {
              event.preventDefault();
              addConnection();
            }}
          >
            <div className="grid min-w-40 flex-1 gap-1.5">
              <Label htmlFor={`${formId}-connection-name`}>{tr("assets.name")}</Label>
              <Input
                id={`${formId}-connection-name`}
                ref={connectionNameInput}
                required
                aria-invalid={(connectionAttempted && Boolean(connectionNameError)) || undefined}
                aria-describedby={
                  connectionAttempted && connectionNameError
                    ? `${formId}-connection-name-error`
                    : undefined
                }
                value={connectionName}
                onChange={(event) => setConnectionName(event.target.value)}
                placeholder={tr("assets.name")}
              />
              {connectionAttempted && connectionNameError && (
                <p
                  id={`${formId}-connection-name-error`}
                  role="alert"
                  className="text-xs text-destructive-text"
                >
                  {tr(connectionNameError, { name: existingConnection?.name })}
                </p>
              )}
              {connectionAttempted &&
                connectionNameError === "assets.duplicateDraftName" &&
                existingConnection && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      showExisting(connectionRows.current.get(existingConnection.name))
                    }
                  >
                    {tr("assets.viewExistingDraftItem")}
                  </Button>
                )}
            </div>
            <div className="grid min-w-32 gap-1.5">
              <Label htmlFor={`${formId}-transport`}>{tr("assets.transport")}</Label>
              <Select
                value={transport}
                onValueChange={(value) => {
                  if (value === "stdio" || value === "http") setTransport(value);
                }}
              >
                <SelectTrigger id={`${formId}-transport`}>
                  <SelectValue>{transport === "stdio" ? "stdio" : "HTTP"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>{tr("assets.transport")}</SelectLabel>
                    <SelectItem value="stdio">stdio</SelectItem>
                    <SelectItem value="http">HTTP</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="grid min-w-40 flex-1 gap-1.5">
              <Label htmlFor={`${formId}-endpoint`}>
                {tr(transport === "stdio" ? "assets.command" : "assets.url")}
              </Label>
              <Input
                id={`${formId}-endpoint`}
                ref={endpointInput}
                required
                aria-invalid={(connectionAttempted && Boolean(endpointError)) || undefined}
                aria-describedby={
                  connectionAttempted && endpointError ? `${formId}-endpoint-error` : undefined
                }
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder={transport === "stdio" ? "/absolute/path/to/server" : "https://…"}
              />
              {connectionAttempted && endpointError && (
                <p
                  id={`${formId}-endpoint-error`}
                  role="alert"
                  className="text-xs text-destructive-text"
                >
                  {tr(endpointError)}
                </p>
              )}
            </div>
            <Button
              type="submit"
              className="bg-primary text-primary-foreground hover:bg-[var(--primary-hover-strong)]"
            >
              {tr("common.add")}
            </Button>
          </form>
        </Card>
      )}
      {section === "native" && (
        <Card className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card p-3">
            <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
              <Search size={16} />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={tr("assets.searchPlaceholder")}
              />
            </div>
            <span>{tr("overview.nativeAssets", { count: filtered.length })}</span>
          </div>
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(160px,1fr)_minmax(120px,auto)_auto] items-center gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0 bg-muted/40 text-xs font-medium text-muted-foreground">
              <span>{tr("assets.asset")}</span>
              <span>{tr("catalog.visibleAgents")}</span>
              <span>{tr("assets.type")}</span>
              <span>{tr("assets.size")}</span>
            </div>
            {filtered.map((asset) => {
              const allAgents = asset.agents.map((agent) => agentLabels[agent]).join(" · ");
              return (
                <div
                  className="grid grid-cols-[minmax(0,1.5fr)_minmax(160px,1fr)_minmax(120px,auto)_auto] items-center gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0"
                  key={asset.id}
                >
                  <span className="min-w-0">
                    <FileCode2 size={16} />
                    <div>
                      <strong>{fileName(asset.path)}</strong>
                      <small>{shortPath(asset.path)}</small>
                    </div>
                  </span>
                  <span
                    className="flex flex-wrap items-center gap-1.5"
                    aria-label={allAgents}
                    title={allAgents}
                  >
                    {asset.agents.map((agent) => (
                      <span
                        className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
                        key={agent}
                      >
                        {agentLabels[agent]}
                      </span>
                    ))}
                  </span>
                  <span>
                    <span className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                      {tr(`status.asset.${asset.kind}`)}
                    </span>
                  </span>
                  <span>{formatBytes(asset.size)}</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

type AssetsSearch = { workspaceAssetSection?: WorkspaceAssetSection };

function WorkspaceAssetsRoute() {
  const navigate = useNavigate();
  const { workspaceId } = useParams({ from: "/(main)/workspace/$workspaceId/assets" });
  const search = useSearch({ strict: false }) as AssetsSearch;
  const { scan, manifest, setManifest, planningChanges, applyingChanges } = useWorkspaceStore();
  const section = search.workspaceAssetSection ?? "instructions";
  const setSection = (nextSection: WorkspaceAssetSection) =>
    void navigate({
      to: "/workspace/$workspaceId/assets",
      params: { workspaceId },
      search: (current) => ({ ...current, workspaceAssetSection: nextSection }) as never,
    });
  if (!scan || !manifest) return <WorkspaceAssetsSkeleton />;
  return (
    <fieldset disabled={planningChanges || applyingChanges} className="min-w-0 border-0 p-0 m-0">
      <Assets
        section={section}
        onSection={setSection}
        scan={scan}
        manifest={manifest}
        onChange={(next) => {
          const current = useWorkspaceStore.getState();
          if (!current.planningChanges && !current.applyingChanges) setManifest(next);
        }}
      />
    </fieldset>
  );
}

export const Route = createFileRoute("/(main)/workspace/$workspaceId/assets")({
  staticData: { appRoute: { kind: "workspace", page: "assets" } },
  component: WorkspaceAssetsRoute,
});
