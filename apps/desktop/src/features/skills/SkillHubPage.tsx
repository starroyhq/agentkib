import { useQuery } from "@tanstack/react-query";
import { useI18n } from "@/core/useI18n";
import { useCallback, useMemo, useState } from "react";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";
import {
  skillKeys,
  useSkillLibrary,
  useSkillInventory,
  useSkillDeployments,
  type SkillLibrary,
} from "./skills-query";
import {
  ArchiveRestore,
  CircleAlert,
  Download,
  Eye,
  Github,
  History,
  Library,
  LoaderCircle,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/core/api";
import { tr } from "@/core/i18n";
import { withAsyncCleanup } from "@/lib/utils";
import type {
  InstalledSkill,
  RemovedSkill,
  SkillCandidate,
  SkillOperationPreview,
  SkillDetailRequest,
  SkillSource,
  WorkspaceSummary,
} from "@/core/types";
import type { CatalogAssetGroup } from "@/features/catalog/catalog";
import { cn } from "cn";
import { isSkillDirectory, SkillFileBrowser } from "./SkillFileBrowser";
import {
  readableSkillFile,
  observationMatchesDeployment,
  groupSkillObservations,
  SkillDeploymentDialog,
  SkillDetailDialog,
  SkillUsageList,
  type SkillDeploymentAction,
} from "./SkillManagerPanels";
import { SkillImportDialog } from "./SkillImportDialog";
import { SkillVersionDialog } from "./SkillVersionDialog";

type SkillHubSection = "library" | "workspace" | "discover";
const noInstalledSkills: InstalledSkill[] = [];
const noRemovedSkills: RemovedSkill[] = [];

interface SkillHubPageProps {
  workspaceAssets: CatalogAssetGroup[];
  workspaces: WorkspaceSummary[];
  onOpen: (id: string) => void;
  onReload: () => Promise<void>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sourceLabel(candidate: SkillCandidate | InstalledSkill, translate = tr) {
  if (!candidate.source) return translate("skills.localSource");
  return candidate.source.kind === "openai-curated"
    ? translate("skills.openaiCurated")
    : candidate.source.repository;
}

function isSameSource(installed: InstalledSkill["source"], candidate: SkillCandidate["source"]) {
  return (
    !!installed &&
    !!candidate &&
    installed.repository.toLowerCase() === candidate.repository.toLowerCase() &&
    installed.ref === candidate.ref &&
    installed.ref_type === candidate.ref_type &&
    installed.path === candidate.path
  );
}

function statusLabel(status: InstalledSkill["status"], translate = tr) {
  return translate(`skills.status.${status}`);
}

function statusClass(status: InstalledSkill["status"]) {
  if (status === "update-available") return "border-blue-300 bg-blue-50 text-blue-800";
  if (status === "modified") return "border-amber-300 bg-amber-50 text-amber-800";
  if (status === "unmanaged") return "border-border bg-muted/50 text-muted-foreground";
  return "border-emerald-300 bg-emerald-50 text-emerald-800";
}

function upsertSkill<T extends { name: string }>(items: T[], next: T) {
  const index = items.findIndex((item) => item.name === next.name);
  if (index < 0) return [...items, next];
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}

function upsertRemovedSkill(items: RemovedSkill[], next: RemovedSkill) {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}

export function SkillHubPage({ workspaces, onOpen, onReload }: SkillHubPageProps) {
  const { localizeMessage, tr, formatDateTime } = useI18n();
  const dialogs = useAppDialogs();
  const [section, setSection] = useState<SkillHubSection>("library");
  const queryClient = useOptionalQueryClient();
  const libraryQuery = useSkillLibrary();
  const installed = libraryQuery.data?.installed ?? noInstalledSkills;
  const removed = libraryQuery.data?.removed ?? noRemovedSkills;
  // 操作结果直接写回缓存，界面立即更新；随后的 refreshAfterMutation 再与服务端对齐。
  const updateLibrary = (update: (library: SkillLibrary) => SkillLibrary) =>
    queryClient.setQueryData<SkillLibrary>(skillKeys.library(), (current) =>
      update(current ?? { installed: [], removed: [] }),
    );
  const setInstalled = (next: (items: InstalledSkill[]) => InstalledSkill[]) =>
    updateLibrary((library) => ({ ...library, installed: next(library.installed) }));
  const setRemoved = (next: (items: RemovedSkill[]) => RemovedSkill[]) =>
    updateLibrary((library) => ({ ...library, removed: next(library.removed) }));
  const libraryLoading = libraryQuery.isPending;
  const catalogQuery = useQuery(
    {
      ...queryDefaults,
      queryKey: skillKeys.catalog(),
      queryFn: () => api.skillCatalog(false),
      enabled: section === "discover",
    },
    queryClient,
  );
  const catalog = catalogQuery.data;
  const inventoryQuery = useSkillInventory();
  const deploymentsQuery = useSkillDeployments();
  const [candidates, setCandidates] = useState<SkillCandidate[]>([]);
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<SkillOperationPreview>();
  const [importOpen, setImportOpen] = useState(false);
  const [versionRequest, setVersionRequest] = useState<{
    name: string;
    source: SkillSource;
    libraryId?: string;
  }>();
  const [busy, setBusy] = useState<string>();
  const [errors, setErrors] = useState<unknown[]>([]);
  const inventory = inventoryQuery.data ?? { observations: [], warnings: [] };
  const deployments = deploymentsQuery.data ?? [];
  const managerLoading = inventoryQuery.isPending || deploymentsQuery.isPending;
  const [librarySearch, setLibrarySearch] = useState("");
  const [librarySource, setLibrarySource] = useState("all");
  const [libraryStatus, setLibraryStatus] = useState("all");
  const [libraryUsage, setLibraryUsage] = useState("all");
  const [detailRequest, setDetailRequest] = useState<SkillDetailRequest>();
  const [deploymentAction, setDeploymentAction] = useState<SkillDeploymentAction>();
  const [success, setSuccess] = useState(false);
  const [addedLibraryId, setAddedLibraryId] = useState<string>();
  const [operationWarnings, setOperationWarnings] = useState<string[]>([]);
  const visibleErrors = [
    ...new Set([
      ...errors,
      ...[
        libraryQuery.error,
        inventoryQuery.error,
        deploymentsQuery.error,
        catalogQuery.error,
      ].filter(Boolean),
    ]),
  ];
  const error = visibleErrors.map(localizeMessage).join(" · ");

  const loadLibrary = async () => {
    await libraryQuery.refetch({ throwOnError: true });
  };

  const loadCatalog = async (force = false, reportError = true): Promise<unknown[]> => {
    setBusy("catalog");
    if (reportError) setErrors([]);
    return withAsyncCleanup(
      async () => {
        try {
          await queryClient.fetchQuery({
            ...queryDefaults,
            queryKey: skillKeys.catalog(),
            queryFn: () => api.skillCatalog(force),
            staleTime: 0,
          });
          return [];
        } catch (nextError) {
          if (reportError) setErrors([nextError]);
          return [nextError];
        }
      },
      () => setBusy(undefined),
    );
  };

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setErrors([]);
    setSuccess(false);
    setAddedLibraryId(undefined);
    setOperationWarnings([]);
    await withAsyncCleanup(
      async () => {
        try {
          await task();
        } catch (nextError) {
          setErrors([nextError]);
        }
      },
      () => setBusy(undefined),
    );
  };

  const refreshAfterMutation = async () => {
    const refreshResults = await Promise.allSettled([
      loadLibrary(),
      onReload(),
      inventoryQuery.refetch({ throwOnError: true }),
      deploymentsQuery.refetch({ throwOnError: true }),
    ]);
    const refreshErrors = refreshResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (catalog) {
      refreshErrors.push(...(await loadCatalog(true, false)));
    }
    if (refreshErrors.length) setErrors(refreshErrors);
    return refreshErrors;
  };

  const prepareInstall = (candidate: SkillCandidate) =>
    run(`prepare:${candidate.name}`, async () => {
      if (candidate.source) setPreview(await api.prepareSkillInstall(candidate.source));
    });

  const prepareUpdate = (skill: InstalledSkill) =>
    run(`prepare:${skill.name}`, async () => {
      setPreview(await api.prepareSkillUpdate(skill.name));
    });

  const applyPreview = async () => {
    if (!preview) return;
    if (preview.local_modified) {
      const accepted = await dialogs.confirm({
        title: tr("skills.modifiedConfirmTitle"),
        description: tr("skills.modifiedConfirmDescription", { name: preview.skill.name }),
        tone: "warning",
      });
      if (!accepted) return;
    }
    await run(`apply:${preview.skill.name}`, async () => {
      const skill = await api.applySkillOperation(preview.token, preview.local_modified);
      setOperationWarnings(skill.warnings ?? []);
      setInstalled((items) => upsertSkill(items, skill));
      setPreview(undefined);
      setSuccess(true);
      setAddedLibraryId(skill.name);
      await refreshAfterMutation();
    });
  };

  const discoverUrl = () => {
    setCandidates([]);
    return run("discover-url", async () => {
      setCandidates(await api.discoverSkills(url.trim()));
    });
  };

  const checkUpdates = () =>
    run("check-updates", async () => {
      const checked = await api.checkSkillUpdates();
      setInstalled(() => checked);
    });

  const rollback = async (skill: InstalledSkill) => {
    if (
      !(await dialogs.confirm({
        title: tr("skills.rollback"),
        description: tr("skills.rollbackConfirm", { name: skill.display_name }),
        tone: "warning",
      }))
    )
      return;
    await run(`rollback:${skill.name}`, async () => {
      const rolledBack = await api.rollbackSkill(skill.name);
      setOperationWarnings(rolledBack.warnings ?? []);
      setInstalled((items) => upsertSkill(items, rolledBack));
      setSuccess(true);
      await refreshAfterMutation();
    });
  };

  const uninstall = async (skill: InstalledSkill) => {
    if (
      !(await dialogs.confirm({
        title: tr("skills.moveToTrash"),
        description: tr("skills.uninstallConfirm", { name: skill.display_name }),
        tone: "destructive",
      }))
    )
      return;
    await run(`uninstall:${skill.name}`, async () => {
      const removedSkill = await api.uninstallSkill(skill.name);
      setOperationWarnings(removedSkill.warnings ?? []);
      setInstalled((items) => items.filter((item) => item.name !== skill.name));
      setRemoved((items) => upsertRemovedSkill(items, removedSkill));
      setSuccess(true);
      await refreshAfterMutation();
    });
  };

  const restore = (skill: RemovedSkill) =>
    run(`restore:${skill.id}`, async () => {
      const restored = await api.restoreSkill(skill.id);
      setOperationWarnings(restored.warnings ?? []);
      setRemoved((items) => items.filter((item) => item.id !== skill.id));
      setInstalled((items) => upsertSkill(items, restored));
      setSuccess(true);
      await refreshAfterMutation();
    });

  const availableEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (candidates.length ? candidates : (catalog?.entries ?? [])).filter((entry) =>
      `${entry.name} ${entry.description} ${sourceLabel(entry, tr)}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [candidates, catalog, query, tr]);
  const activeDeployments = deployments.filter((item) => item.status !== "inactive");
  const filteredInstalled = installed.filter((skill) => {
    const usage = activeDeployments.filter(
      (item) => item.source_is_current_library === true && item.library_id === skill.name,
    );
    return (
      `${skill.display_name} ${skill.description} ${sourceLabel(skill, tr)}`
        .toLowerCase()
        .includes(librarySearch.trim().toLowerCase()) &&
      (librarySource === "all" || (skill.source?.kind ?? "local") === librarySource) &&
      (libraryStatus === "all" || skill.status === libraryStatus) &&
      (libraryUsage === "all" ||
        (libraryUsage === "unused"
          ? !usage.length
          : usage.some((item) => item.scope === libraryUsage)))
    );
  });
  const prepareImport = (observationId: string) => {
    setDetailRequest(undefined);
    return run(`import:${observationId}`, async () =>
      setPreview(await api.prepareSkillImport(observationId)),
    );
  };
  const openDeployment = (libraryId: string) => {
    setDetailRequest(undefined);
    setDeploymentAction({ operation: "deploy", libraryId });
  };

  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={section}
          onValueChange={(value) => {
            const next = value as SkillHubSection;
            setSection(next);
          }}
        >
          <TabsList className="segmented-control !h-auto" variant="default">
            <TabsTrigger className="segmented-control-item h-9 gap-2" value="library">
              <Library size={15} />
              {tr("skills.library")}
              <Badge variant="secondary">{installed.length}</Badge>
            </TabsTrigger>
            <TabsTrigger className="segmented-control-item h-9 gap-2" value="workspace">
              <Sparkles size={15} />
              {tr("skills.workspaceUsage")}
              <Badge variant="secondary">
                {activeDeployments.length +
                  groupSkillObservations(
                    inventory.observations.filter(
                      (item) =>
                        !activeDeployments.some((deployment) =>
                          observationMatchesDeployment(item, deployment),
                        ),
                    ),
                  ).length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger className="segmented-control-item h-9 gap-2" value="discover">
              <Search size={15} />
              {tr("skills.discover")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="text-xs text-muted-foreground">{tr("skills.libraryLocation")}</p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <CircleAlert className="mt-0.5 shrink-0" size={16} />
          <span>{error}</span>
        </div>
      )}
      {inventory.warnings.map((warning) => (
        <p
          key={warning}
          className="rounded-xl border border-amber-500/30 p-3 text-sm text-amber-700"
        >
          {warning}
        </p>
      ))}
      {success && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm"
        >
          <span>
            {tr("skills.manager.libraryChanged")}
            {errors.length > 0 ? ` ${tr("skills.manager.refreshFailed")}` : ""}
          </span>
          {addedLibraryId && (
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => openDeployment(addedLibraryId)}
            >
              {tr("skills.manager.deploy")}
            </Button>
          )}
        </div>
      )}
      {operationWarnings.map((warning) => (
        <p
          key={warning}
          role="status"
          className="rounded-xl border border-amber-500/30 p-3 text-sm text-amber-700"
        >
          {warning}
        </p>
      ))}

      {section === "workspace" && (
        <div className="grid gap-3">
          <div className="flex justify-end">
            <Button
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() =>
                void run("refresh-inventory", async () => {
                  await refreshAfterMutation();
                })
              }
            >
              <RefreshCw size={14} />
              {tr("skills.manager.refresh")}
            </Button>
          </div>
          <SkillUsageList
            inventory={inventory}
            deployments={deployments}
            installed={installed}
            workspaces={workspaces}
            loading={managerLoading}
            busy={Boolean(busy)}
            onDetail={setDetailRequest}
            onImport={(id) => void prepareImport(id)}
            onAction={setDeploymentAction}
            onOpen={onOpen}
          />
        </div>
      )}

      {section === "library" && (
        <div className="grid gap-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">{tr("skills.libraryTitle")}</h2>
              <p className="text-sm text-muted-foreground">{tr("skills.libraryDescription")}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={Boolean(busy) || managerLoading}
                onClick={() => setImportOpen(true)}
              >
                <Download size={15} />
                {tr("skills.imports.title")}
              </Button>
              <Button
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => void checkUpdates()}
              >
                <RefreshCw className={cn(busy === "check-updates" && "animate-spin")} size={15} />
                {tr("skills.checkUpdates")}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              className="min-w-40 flex-1"
              aria-label={tr("skills.manager.searchLibrary")}
              placeholder={tr("skills.manager.searchLibrary")}
              value={librarySearch}
              onChange={(event) => setLibrarySearch(event.target.value)}
            />
            <Select
              value={librarySource}
              onValueChange={(value) => value && setLibrarySource(value)}
            >
              <SelectTrigger className="w-36" aria-label={tr("catalog.source")}>
                <SelectValue>
                  {librarySource === "all"
                    ? tr("skills.manager.allSources")
                    : librarySource === "local"
                      ? tr("skills.localSource")
                      : librarySource === "openai-curated"
                        ? tr("skills.openaiCurated")
                        : "GitHub"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{tr("catalog.source")}</SelectLabel>
                  <SelectItem value="all">{tr("skills.manager.allSources")}</SelectItem>
                  <SelectItem value="local">{tr("skills.localSource")}</SelectItem>
                  <SelectItem value="github">GitHub</SelectItem>
                  <SelectItem value="openai-curated">{tr("skills.openaiCurated")}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              value={libraryStatus}
              onValueChange={(value) => value && setLibraryStatus(value)}
            >
              <SelectTrigger className="w-36" aria-label={tr("skills.manager.statusFilter")}>
                <SelectValue>
                  {libraryStatus === "all"
                    ? tr("skills.manager.allStatuses")
                    : tr(`skills.status.${libraryStatus}`)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{tr("skills.manager.statusFilter")}</SelectLabel>
                  <SelectItem value="all">{tr("skills.manager.allStatuses")}</SelectItem>
                  {(["current", "update-available", "modified", "unmanaged"] as const).map(
                    (status) => (
                      <SelectItem key={status} value={status}>
                        {statusLabel(status, tr)}
                      </SelectItem>
                    ),
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select value={libraryUsage} onValueChange={(value) => value && setLibraryUsage(value)}>
              <SelectTrigger className="w-40" aria-label={tr("skills.workspaceUsage")}>
                <SelectValue>
                  {libraryUsage === "all"
                    ? tr("skills.manager.allLocations")
                    : libraryUsage === "unused"
                      ? tr("skills.manager.notDeployed")
                      : libraryUsage === "personal"
                        ? tr("skills.manager.personal")
                        : tr("skills.manager.project")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{tr("skills.workspaceUsage")}</SelectLabel>
                  <SelectItem value="all">{tr("skills.manager.allLocations")}</SelectItem>
                  <SelectItem value="unused">{tr("skills.manager.notDeployed")}</SelectItem>
                  <SelectItem value="personal">{tr("skills.manager.personal")}</SelectItem>
                  <SelectItem value="workspace">{tr("skills.manager.project")}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          {libraryLoading ? (
            <EmptyState title={tr("common.loading")} />
          ) : !installed.length ? (
            <EmptyState
              title={tr("skills.libraryEmpty")}
              description={tr("skills.libraryEmptyHint")}
            />
          ) : (
            <div className="grid gap-2">
              {filteredInstalled.map((skill) => (
                <Card
                  key={skill.name}
                  className="grid gap-2 rounded-xl p-3 lg:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <CardHeader className="flex-row items-start justify-between gap-3 p-0">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate font-semibold">{skill.display_name}</h3>
                        <Badge variant="outline" className={statusClass(skill.status)}>
                          {statusLabel(skill.status, tr)}
                        </Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        {skill.description || tr("skills.noDescription")}
                      </p>
                    </div>
                  </CardHeader>
                  <CardContent className="grid content-center gap-2 p-0">
                    <div className="grid gap-1 text-xs text-muted-foreground">
                      <span className="truncate">{sourceLabel(skill, tr)}</span>
                      {skill.source && (
                        <code className="break-all">
                          {skill.source.ref} · {skill.source.resolved_commit.slice(0, 12)}
                        </code>
                      )}
                      <span>
                        {formatBytes(skill.size)}
                        {skill.updated_at ? ` · ${formatDateTime(skill.updated_at)}` : ""}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDetailRequest({ library_id: skill.name })}
                      >
                        <Eye size={14} />
                        {tr("skills.manager.details")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={Boolean(busy)}
                        onClick={() => openDeployment(skill.name)}
                      >
                        {tr("skills.manager.deploy")}
                      </Button>
                      <Badge variant="secondary">
                        {tr("skills.manager.usageCount", {
                          count: activeDeployments.filter(
                            (item) =>
                              item.source_is_current_library === true &&
                              item.library_id === skill.name,
                          ).length,
                        })}
                      </Badge>
                      {skill.source && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            setVersionRequest({
                              name: skill.display_name,
                              source: skill.source!,
                              libraryId: skill.name,
                            })
                          }
                        >
                          <History size={14} />
                          {tr("skills.versions.choose")}
                        </Button>
                      )}
                      {skill.source && (
                        <Button
                          size="sm"
                          variant={skill.status === "update-available" ? "default" : "outline"}
                          disabled={Boolean(busy)}
                          onClick={() => void prepareUpdate(skill)}
                        >
                          <Download size={14} />
                          {tr("skills.update")}
                        </Button>
                      )}
                      {skill.can_rollback && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={Boolean(busy)}
                          onClick={() => void rollback(skill)}
                        >
                          <History size={14} />
                          {tr("skills.rollback")}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={Boolean(busy)}
                        onClick={() => void uninstall(skill)}
                      >
                        <Trash2 size={14} />
                        {tr("skills.moveToTrash")}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          {installed.length > 0 && !filteredInstalled.length && (
            <EmptyState title={tr("skills.noResults")} />
          )}

          {removed.length > 0 && (
            <Card className="rounded-2xl">
              <CardHeader className="border-b p-4">
                <h2 className="font-semibold">{tr("skills.trash")}</h2>
                <p className="text-sm text-muted-foreground">{tr("skills.trashDescription")}</p>
              </CardHeader>
              <CardContent className="divide-y p-0">
                {removed.map((skill) => (
                  <div key={skill.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{skill.display_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(skill.removed_at)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() => void restore(skill)}
                    >
                      <ArchiveRestore size={14} />
                      {tr("skills.restore")}
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {section === "discover" && (
        <div className="grid gap-4">
          <Card className="rounded-2xl">
            <CardHeader className="p-4 pb-2">
              <div className="flex items-center gap-2 font-semibold">
                <Github size={17} />
                {tr("skills.addFromGithub")}
              </div>
              <p className="text-sm text-muted-foreground">{tr("skills.githubDescription")}</p>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 p-4 pt-2 sm:flex-row">
              <Input
                aria-label={tr("skills.addFromGithub")}
                value={url}
                disabled={busy === "discover-url"}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setCandidates([]);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && url.trim() && !busy) void discoverUrl();
                }}
                placeholder="https://github.com/owner/repo/tree/main/path/to/skill"
              />
              <Button disabled={!url.trim() || Boolean(busy)} onClick={() => void discoverUrl()}>
                {busy === "discover-url" && <LoaderCircle className="animate-spin" size={15} />}
                {tr("skills.inspectUrl")}
              </Button>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold">
                  {candidates.length ? tr("skills.githubResults") : tr("skills.openaiCurated")}
                </h2>
                {catalog?.stale && <Badge variant="outline">{tr("skills.cached")}</Badge>}
              </div>
              <p className="text-sm text-muted-foreground">
                {catalog?.stale
                  ? tr("skills.cachedAt", { time: formatDateTime(catalog.cached_at) })
                  : tr("skills.discoverDescription")}
              </p>
            </div>
            <div className="flex gap-2">
              <label className="flex h-9 items-center gap-2 rounded-lg border bg-card px-3 text-muted-foreground">
                <Search size={14} />
                <Input
                  aria-label={tr("skills.search")}
                  className="h-7 w-44 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={tr("skills.search")}
                />
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => {
                  setCandidates([]);
                  void loadCatalog(true);
                }}
              >
                <RefreshCw className={cn(busy === "catalog" && "animate-spin")} size={14} />
                {tr("common.refresh")}
              </Button>
            </div>
          </div>

          {(catalogQuery.isPending || busy === "catalog") && !catalog ? (
            <EmptyState title={tr("skills.loadingCatalog")} />
          ) : !availableEntries.length ? (
            <EmptyState title={tr("skills.noResults")} description={tr("skills.noResultsHint")} />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {availableEntries.map((candidate) => {
                const existing = installed.find((skill) =>
                  isSameSource(skill.source, candidate.source),
                );
                const versionTarget = installed.find(
                  (skill) =>
                    skill.source &&
                    candidate.source &&
                    skill.source.repository.toLowerCase() ===
                      candidate.source.repository.toLowerCase() &&
                    skill.source.path === candidate.source.path,
                );
                const sameSource = Boolean(existing);
                const switchingVersion = Boolean(versionTarget && !sameSource);
                const chooseVersion = () => {
                  if (!candidate.source) return;
                  setVersionRequest({
                    name: candidate.name,
                    source: versionTarget?.source ?? candidate.source,
                    ...(versionTarget ? { libraryId: versionTarget.name } : {}),
                  });
                };
                return (
                  <Card
                    key={`${candidate.source?.repository ?? "local"}:${candidate.source?.path ?? candidate.name}`}
                    className="rounded-2xl"
                  >
                    <CardHeader className="p-4 pb-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate font-semibold">{candidate.name}</h3>
                          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                            {candidate.description || tr("skills.noDescription")}
                          </p>
                        </div>
                        <Badge variant="outline">{sourceLabel(candidate, tr)}</Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="flex items-end justify-between gap-3 p-4 pt-2">
                      <div className="min-w-0 text-xs text-muted-foreground">
                        <p className="truncate">
                          {candidate.source?.path ||
                            candidate.source?.repository ||
                            tr("skills.localSource")}
                        </p>
                        {candidate.license && <p>{candidate.license}</p>}
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        {candidate.source && !switchingVersion && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={Boolean(busy)}
                            onClick={chooseVersion}
                          >
                            {tr("skills.versions.choose")}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          disabled={!candidate.source || Boolean(busy)}
                          onClick={() =>
                            switchingVersion ? chooseVersion() : void prepareInstall(candidate)
                          }
                        >
                          <Download size={14} />
                          {switchingVersion
                            ? tr("skills.versions.choose")
                            : sameSource
                              ? tr("skills.update")
                              : tr("skills.addToLibrary")}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      <SkillPreviewDialog
        preview={preview}
        busy={Boolean(busy?.startsWith("apply:") || busy === "discard-preview")}
        onClose={() => {
          const token = preview?.token;
          if (!token) return;
          void run("discard-preview", async () => {
            await api.discardSkillPreview(token);
            setPreview(undefined);
          });
        }}
        onApply={() => void applyPreview()}
      />
      {importOpen && (
        <SkillImportDialog
          inventory={inventory}
          deployments={deployments}
          onClose={() => setImportOpen(false)}
          onImported={async (skills, warnings) => {
            setInstalled((items) =>
              skills.reduce((current, skill) => upsertSkill(current, skill), items),
            );
            setSuccess(true);
            setOperationWarnings(warnings);
            setAddedLibraryId(skills.length === 1 ? skills[0].name : undefined);
            setErrors([]);
            return refreshAfterMutation();
          }}
        />
      )}
      {versionRequest && (
        <SkillVersionDialog
          {...versionRequest}
          onClose={() => setVersionRequest(undefined)}
          onPrepared={(next) => {
            setVersionRequest(undefined);
            setPreview(next);
          }}
        />
      )}
      {detailRequest && (
        <SkillDetailDialog
          request={detailRequest}
          inventory={inventory}
          deployments={deployments}
          onClose={() => setDetailRequest(undefined)}
          onDeploy={openDeployment}
          onImport={(id) => void prepareImport(id)}
        />
      )}
      {deploymentAction && (
        <SkillDeploymentDialog
          key={`${deploymentAction.operation}:${deploymentAction.libraryId ?? deploymentAction.deployment?.id}`}
          action={deploymentAction}
          workspaces={workspaces}
          onClose={() => setDeploymentAction(undefined)}
          onChanged={refreshAfterMutation}
        />
      )}
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="grid min-h-40 place-items-center rounded-2xl border border-dashed bg-muted/20 p-6 text-center">
      <div>
        <Library className="mx-auto mb-3 text-muted-foreground" size={24} />
        <p className="font-medium">{title}</p>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}

function SkillPreviewDialog({
  preview,
  busy,
  onClose,
  onApply,
}: {
  preview?: SkillOperationPreview;
  busy: boolean;
  onClose: () => void;
  onApply: () => void;
}) {
  const { tr, formatDateTime } = useI18n();
  const previewToken = preview?.token;
  const readFile = useCallback(
    async (path: string) => {
      if (!previewToken) throw new Error("Skill preview is unavailable");
      return readableSkillFile(await api.readSkillPreviewFile(previewToken, path));
    },
    [previewToken],
  );
  return (
    <Dialog open={Boolean(preview)} onOpenChange={(open) => !open && !busy && onClose()}>
      {preview && (
        <DialogContent
          showCloseButton={!busy}
          className="max-h-[85vh] w-[min(920px,calc(100vw-2rem))] !max-w-none overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>
              {tr(
                preview.operation === "install" ? "skills.installPreview" : "skills.updatePreview",
              )}
            </DialogTitle>
            <DialogDescription>
              {tr("skills.previewDescription", { name: preview.skill.name })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2 rounded-xl border bg-muted/30 p-3 text-sm sm:grid-cols-4">
              <PreviewMetric
                label={tr("skills.files")}
                value={String(preview.files.filter((file) => !isSkillDirectory(file.path)).length)}
              />
              {preview.files.some((file) => isSkillDirectory(file.path)) && (
                <PreviewMetric
                  label={tr("skills.manager.directories")}
                  value={String(preview.files.filter((file) => isSkillDirectory(file.path)).length)}
                />
              )}
              <PreviewMetric
                label={tr("skills.executableFiles")}
                value={String(preview.files.filter((file) => file.executable).length)}
              />
              <PreviewMetric label={tr("assets.size")} value={formatBytes(preview.total_size)} />
              <PreviewMetric
                label={tr("skills.sourceCommit")}
                value={
                  preview.skill.source?.resolved_commit.slice(0, 12) ?? tr("skills.localSource")
                }
              />
            </div>
            {preview.skill.source && (
              <div className="grid gap-3 rounded-xl border p-3 text-sm sm:grid-cols-2">
                {preview.previous_source && (
                  <PreviewMetric
                    label={tr("skills.versions.current")}
                    value={`${preview.previous_source.ref} · ${preview.previous_source.resolved_commit.slice(0, 12)}`}
                  />
                )}
                <PreviewMetric
                  label={tr("skills.versions.target")}
                  value={`${preview.skill.source.ref} · ${preview.skill.source.resolved_commit.slice(0, 12)}`}
                />
              </div>
            )}
            {preview.operation === "update" && (
              <p className="text-xs text-muted-foreground">
                {tr("skills.versions.deploymentNotice")}
              </p>
            )}
            {(preview.skill.license || preview.skill.compatibility) && (
              <div className="grid gap-2 rounded-xl border p-3 text-sm sm:grid-cols-2">
                {preview.skill.license && (
                  <PreviewMetric label={tr("skills.license")} value={preview.skill.license} />
                )}
                {preview.skill.compatibility && (
                  <PreviewMetric
                    label={tr("skills.compatibility")}
                    value={preview.skill.compatibility}
                  />
                )}
              </div>
            )}
            {preview.local_modified && (
              <div className="flex gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <CircleAlert className="mt-0.5 shrink-0" size={16} />
                {tr("skills.localChangesWarning")}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <FileChanges title={tr("skills.addedFiles")} files={preview.added} />
              <FileChanges title={tr("skills.modifiedFiles")} files={preview.modified} />
              <FileChanges title={tr("skills.removedFiles")} files={preview.removed} />
            </div>
            <SkillFileBrowser
              key={preview.token}
              files={[
                ...preview.files,
                ...preview.removed
                  .filter((path) => !preview.files.some((file) => file.path === path))
                  .map((path) => ({ path, size: 0, executable: false })),
              ]}
              readFile={readFile}
            />
            <p className="text-xs text-muted-foreground">
              {tr("skills.noExecutionNotice", { time: formatDateTime(preview.expires_at) })}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {tr("common.cancel")}
            </Button>
            <Button disabled={busy} onClick={onApply}>
              {busy && <LoaderCircle className="animate-spin" size={15} />}
              {tr(preview.operation === "install" ? "skills.addToLibrary" : "skills.applyUpdate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

function PreviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate font-medium">{value}</p>
    </div>
  );
}

function FileChanges({ title, files }: { title: string; files: string[] }) {
  const { tr } = useI18n();
  return (
    <div className="min-w-0 rounded-xl border p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title} · {files.length}
      </p>
      <div className="max-h-32 space-y-1 overflow-y-auto text-xs">
        {files.length ? (
          files.map((file) => (
            <p key={file} className="truncate font-mono" title={file}>
              {file}
            </p>
          ))
        ) : (
          <p className="text-muted-foreground">{tr("common.none")}</p>
        )}
      </div>
    </div>
  );
}
