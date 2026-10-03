import { useI18n } from "@/core/useI18n";
import { createFileRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { WorkspaceAssetsSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useMemo, useState } from "react";
import { AssetCatalogPage } from "@/features/catalog/AssetCatalogPage";
import { groupWorkspaceAssets } from "@/features/catalog/catalog";
import { MarkdownContent } from "@/components/MarkdownContent";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileCode2, Search, ShieldCheck, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentKind, ConnectionDefinition, Manifest, WorkspaceScan } from "../../../core/types";
import { AGENT_LABELS as agentLabels } from "@/core/agents";
type WorkspaceAssetSection = "instructions" | "skills" | "mcp" | "native";
function shortPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}
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
  const [instructionsMode, setInstructionsMode] = useState<"preview" | "edit">("preview");
  const nativeAssets = useMemo(() => groupWorkspaceAssets(scan.assets), [scan.assets]);
  const filtered = nativeAssets.filter((asset) =>
    `${asset.agents.join(" ")} ${asset.kind} ${asset.path}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const addSkill = () => {
    if (!skillName.trim() || !skillPath.trim()) return;
    onChange({
      ...manifest,
      skills: [
        ...manifest.skills.filter((skill) => skill.name !== skillName.trim()),
        { name: skillName.trim(), path: skillPath.trim(), targets: [] },
      ],
    });
    setSkillName("");
    setSkillPath("");
  };
  const addConnection = () => {
    if (!connectionName.trim() || !endpoint.trim()) return;
    const common = {
      name: connectionName.trim(),
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
      connections: [
        ...manifest.connections.filter((item) => item.name !== connection.name),
        connection,
      ],
    });
    setConnectionName("");
    setEndpoint("");
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
            {manifest.skills.map((skill) => (
              <span
                className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                key={skill.name}
              >
                <span>
                  <strong>{skill.name}</strong>
                  <small>{skill.path}</small>
                </span>
                <Button
                  aria-label={tr("common.remove")}
                  onClick={() =>
                    onChange({
                      ...manifest,
                      skills: manifest.skills.filter((item) => item.name !== skill.name),
                    })
                  }
                >
                  <X size={13} />
                </Button>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 p-4">
            <Input
              value={skillName}
              onChange={(event) => setSkillName(event.target.value)}
              placeholder={tr("assets.name")}
            />
            <Input
              value={skillPath}
              onChange={(event) => setSkillPath(event.target.value)}
              placeholder=".agents/skills/name"
            />
            <Button
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={addSkill}
            >
              {tr("common.add")}
            </Button>
          </div>
        </Card>
      )}
      {section === "mcp" && (
        <Card className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          <div className="grid gap-4">
            {manifest.connections.map((connection) => (
              <span
                className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                key={connection.name}
              >
                <span>
                  <strong>{connection.name}</strong>
                  <small>
                    {connection.transport === "stdio" ? connection.command : connection.url}
                  </small>
                </span>
                <Button
                  aria-label={tr("common.remove")}
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
              </span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 p-4 grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">
            <Input
              value={connectionName}
              onChange={(event) => setConnectionName(event.target.value)}
              placeholder={tr("assets.name")}
            />
            <Select
              value={transport}
              onValueChange={(value) => {
                if (value === "stdio" || value === "http") setTransport(value);
              }}
            >
              <SelectTrigger>
                <SelectValue>{transport === "stdio" ? "stdio" : "HTTP"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">stdio</SelectItem>
                <SelectItem value="http">HTTP</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder={transport === "stdio" ? "/absolute/path/to/server" : "https://…"}
            />
            <Button
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={addConnection}
            >
              {tr("common.add")}
            </Button>
          </div>
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
                      <strong>{asset.path.split("/").pop()}</strong>
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
  const { workspaceId } = useParams({ from: "/workspace/$workspaceId/assets" });
  const search = useSearch({ strict: false }) as AssetsSearch;
  const { scan, manifest, setManifest } = useWorkspaceStore();
  const section = search.workspaceAssetSection ?? "instructions";
  const setSection = (nextSection: WorkspaceAssetSection) =>
    void navigate({
      to: "/workspace/$workspaceId/assets",
      params: { workspaceId },
      search: (current) => ({ ...current, workspaceAssetSection: nextSection }) as never,
    });
  if (!scan || !manifest) return <WorkspaceAssetsSkeleton />;
  return (
    <Assets
      section={section}
      onSection={setSection}
      scan={scan}
      manifest={manifest}
      onChange={setManifest}
    />
  );
}

export const Route = createFileRoute("/workspace/$workspaceId/assets")({
  component: WorkspaceAssetsRoute,
});
