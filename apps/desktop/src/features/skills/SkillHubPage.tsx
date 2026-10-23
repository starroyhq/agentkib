import { useQuery } from "@tanstack/react-query";
import { useI18n } from "@/core/useI18n";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";
import {
  skillKeys,
  useSkillLibrary,
  useSkillInventory,
  useSkillDeployments,
  useSkillSyncState,
  useSkillSyncStatus,
  type SkillLibrary,
} from "./skills-query";
import {
  ArchiveRestore,
  CircleAlert,
  Download,
  Eye,
  History,
  Library,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { GitHubIcon } from "@/components/GitHubIcon";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { usePathDisplay } from "@/lib/usePathDisplay";
import type {
  InstalledSkill,
  RemovedSkill,
  SkillCandidate,
  SkillOperationPreview,
  SkillDetailRequest,
  SkillSource,
  WorkspaceSummary,
  PrepareSkillSyncRequest,
} from "@/core/types";
import { cn } from "cn";
import { isSkillDirectory, SkillFileBrowser } from "./SkillFileBrowser";
import {
  readableSkillFile,
  observationMatchesDeployment,
  groupSkillObservations,
  SkillDeploymentDialog,
  SkillDetailDialog,
  SkillUsageList,
  canReadSkillObservation,
  skillImportGroups,
  type SkillDeploymentAction,
} from "./SkillManagerPanels";
import { SkillImportDialog } from "./SkillImportDialog";
import { SkillVersionDialog } from "./SkillVersionDialog";
import { SkillSyncDialog, SkillSyncPolicyDialog, SkillSyncRunsDialog } from "./SkillSyncPanels";

export type SkillHubSection = "library" | "workspace" | "discover";
type SkillLibrarySuccess = {
  operation: "added" | "updated" | "rolledBack" | "movedToTrash" | "restored";
  skills: Pick<InstalledSkill, "name" | "display_name">[];
};
const librarySuccessKeys = {
  added: "skills.manager.libraryAdded",
  updated: "skills.manager.libraryUpdated",
  rolledBack: "skills.manager.libraryRolledBack",
  movedToTrash: "skills.manager.libraryMovedToTrash",
  restored: "skills.manager.libraryRestored",
} as const;
const noInstalledSkills: InstalledSkill[] = [];
const noRemovedSkills: RemovedSkill[] = [];

interface SkillHubPageProps {
  section?: SkillHubSection;
  onSectionChange?: (section: SkillHubSection) => void;
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
  if (status === "update-available") return "border-primary/30 bg-primary/10 text-primary-text";
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

export function SkillHubPage({
  section: controlledSection,
  onSectionChange,
  workspaces,
  onOpen,
  onReload,
}: SkillHubPageProps) {
  const { localizeMessage, tr, formatDateTime } = useI18n();
  const displayPath = usePathDisplay();
  const dialogs = useAppDialogs();
  const [localSection, setLocalSection] = useState<SkillHubSection>();
  const [previousControlledSection, setPreviousControlledSection] = useState(controlledSection);
  if (previousControlledSection !== controlledSection) {
    setPreviousControlledSection(controlledSection);
    // Browser history can remove an explicit URL destination without remounting this page.
    if (controlledSection === undefined) setLocalSection(undefined);
  }
  const setSection = (next: SkillHubSection) => {
    if (controlledSection === undefined) setLocalSection(next);
    onSectionChange?.(next);
  };
  const queryClient = useOptionalQueryClient();
  const libraryQuery = useSkillLibrary();
  const installed = libraryQuery.data?.installed ?? noInstalledSkills;
  const removed = libraryQuery.data?.removed ?? noRemovedSkills;
  const inventoryQuery = useSkillInventory();
  const deploymentsQuery = useSkillDeployments();
  const inventory = inventoryQuery.data ?? { observations: [], warnings: [] };
  const deployments = deploymentsQuery.data ?? [];
  const activeDeployments = deployments.filter((item) => item.status !== "inactive");
  const workspaceUsageCount =
    activeDeployments.length +
    groupSkillObservations(
      inventory.observations.filter(
        (item) =>
          !activeDeployments.some((deployment) => observationMatchesDeployment(item, deployment)),
      ),
    ).length;
  const importableCount = skillImportGroups(inventory, deployments).filter((group) =>
    group.observations.some(canReadSkillObservation),
  ).length;
  // Resolve the first automatic destination only from complete successful snapshots.
  // A user choice or an explicit URL always wins and survives later refreshes.
  if (
    controlledSection === undefined &&
    localSection === undefined &&
    libraryQuery.isSuccess &&
    inventoryQuery.isSuccess &&
    deploymentsQuery.isSuccess
  ) {
    setLocalSection(!installed.length && workspaceUsageCount > 0 ? "workspace" : "library");
  }
  const section = controlledSection ?? localSection ?? "library";
  // 操作结果直接写回缓存，界面立即更新；随后的 refreshAfterMutation 再与服务端对齐。
  const updateLibrary = (update: (library: SkillLibrary) => SkillLibrary) =>
    queryClient.setQueryData<SkillLibrary>(skillKeys.library(), (current) =>
      update(current ?? { installed: [], removed: [] }),
    );
  const setInstalled = (next: (items: InstalledSkill[]) => InstalledSkill[]) =>
    updateLibrary((library) => ({ ...library, installed: next(library.installed) }));
  const setRemoved = (next: (items: RemovedSkill[]) => RemovedSkill[]) =>
    updateLibrary((library) => ({ ...library, removed: next(library.removed) }));
  const libraryLoading =
    libraryQuery.isPending ||
    (controlledSection === undefined &&
      localSection === undefined &&
      (inventoryQuery.isPending || deploymentsQuery.isPending));
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
  const syncQuery = useSkillSyncState();
  const syncStatus = useSkillSyncStatus();
  const [pendingOnly, setPendingOnly] = useState(false);
  const pendingHeading = useRef<HTMLHeadingElement>(null);
  const pendingFocusRequested = useRef(false);
  const usageId = useId();
  useEffect(() => {
    if (section !== "workspace" || !pendingOnly || !pendingFocusRequested.current) return;
    pendingFocusRequested.current = false;
    pendingHeading.current?.scrollIntoView?.({ block: "start" });
    pendingHeading.current?.focus({ preventScroll: true });
  }, [section, pendingOnly]);
  const showPendingSync = () => {
    if (section === "workspace" && pendingOnly) {
      setPendingOnly(false);
      return;
    }
    pendingFocusRequested.current = true;
    setPendingOnly(true);
    if (section !== "workspace") setSection("workspace");
  };
  const [syncRequest, setSyncRequest] = useState<PrepareSkillSyncRequest>();
  const [syncPolicyOpen, setSyncPolicyOpen] = useState(false);
  const [syncRunsOpen, setSyncRunsOpen] = useState(false);
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
  const pendingSync =
    syncQuery.data?.deployments.filter(
      (item) =>
        (item.lifecycle_status ?? item.status) !== "inactive" &&
        ["incoming", "conflict", "missing", "blocked", "unverified"].includes(item.sync_state),
    ) ?? [];
  const pendingSyncCount = pendingSync.length;
  // The two snapshots can refresh independently. Do not attach a pending status
  // to a different target, library, or an already inactive deployment.
  const pendingDeploymentIds = new Set(
    pendingSync
      .filter((sync) =>
        deployments.some(
          (item) =>
            item.id === sync.id &&
            item.target === sync.target &&
            item.library_id === sync.library_id &&
            item.status !== "inactive",
        ),
      )
      .map((item) => item.id),
  );
  const unavailablePending = pendingSync.filter((item) => !pendingDeploymentIds.has(item.id));
  const managerLoading = inventoryQuery.isPending || deploymentsQuery.isPending;
  const [librarySearch, setLibrarySearch] = useState("");
  const [librarySource, setLibrarySource] = useState("all");
  const [libraryStatus, setLibraryStatus] = useState("all");
  const [libraryUsage, setLibraryUsage] = useState("all");
  const [detailRequest, setDetailRequest] = useState<SkillDetailRequest>();
  const [deploymentAction, setDeploymentAction] = useState<SkillDeploymentAction>();
  const [success, setSuccess] = useState<SkillLibrarySuccess>();
  const [operationWarnings, setOperationWarnings] = useState<string[]>([]);
  const visibleErrors = [
    ...new Set([
      ...errors,
      ...[
        libraryQuery.error,
        inventoryQuery.error,
        deploymentsQuery.error,
        catalogQuery.error,
        syncQuery.error,
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
    setSuccess(undefined);
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
      syncQuery.refetch({ throwOnError: true }),
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
      setSuccess({
        operation: preview.operation === "install" ? "added" : "updated",
        skills: [skill],
      });
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
      setOperationWarnings(
        checked
          .filter((skill) => skill.update_check === "failed")
          .map(
            (skill) =>
              `${skill.display_name}: ${tr("skills.sync.checkFailed")} · ${skill.update_error ?? ""}`,
          ),
      );
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
      setSuccess({ operation: "rolledBack", skills: [rolledBack] });
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
      setSuccess({ operation: "movedToTrash", skills: [removedSkill] });
      await refreshAfterMutation();
    });
  };

  const restore = (skill: RemovedSkill) =>
    run(`restore:${skill.id}`, async () => {
      const restored = await api.restoreSkill(skill.id);
      setOperationWarnings(restored.warnings ?? []);
      setRemoved((items) => items.filter((item) => item.id !== skill.id));
      setInstalled((items) => upsertSkill(items, restored));
      setSuccess({ operation: "restored", skills: [restored] });
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
  const successHasDeployments = Boolean(
    success?.skills.some((skill) =>
      activeDeployments.some(
        (item) => item.source_is_current_library === true && item.library_id === skill.name,
      ),
    ),
  );
  const deployableSuccessSkill =
    success && success.operation !== "movedToTrash" && success.skills.length === 1
      ? installed.find((skill) => skill.name === success.skills[0].name)
      : undefined;
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
      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          value={section}
          onValueChange={(value) => {
            const next = value as SkillHubSection;
            setSection(next);
          }}
        >
          <TabsList className="segmented-control !h-auto" variant="default">
            <TabsTrigger
              className="segmented-control-item h-9 gap-2"
              value="library"
              aria-label={`${tr("skills.library")} ${installed.length}`}
            >
              <Library size={15} />
              {tr("skills.library")}
              <span className="text-muted-foreground tabular-nums">{installed.length}</span>
            </TabsTrigger>
            <TabsTrigger
              className="segmented-control-item h-9 gap-2"
              value="workspace"
              aria-label={`${tr("skills.workspaceUsage")} ${workspaceUsageCount}`}
            >
              <Sparkles size={15} />
              {tr("skills.workspaceUsage")}
              <span className="text-muted-foreground tabular-nums">{workspaceUsageCount}</span>
            </TabsTrigger>
            <TabsTrigger className="segmented-control-item h-9 gap-2" value="discover">
              <Search size={15} />
              {tr("skills.discover")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {tr("skills.libraryLocation")}
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
            <MoreHorizontal size={14} />
            {tr("common.moreActions")}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setSyncPolicyOpen(true)}>
              {tr("skills.sync.policy")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSyncRunsOpen(true)}>
              {tr("skills.sync.history")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {pendingSyncCount > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="border-amber-500/40 text-amber-700"
            aria-pressed={pendingOnly && section === "workspace"}
            aria-controls={section === "workspace" ? usageId : undefined}
            onClick={showPendingSync}
          >
            {tr("skills.sync.pending", { count: pendingSyncCount })}
          </Button>
        </div>
      )}
      {syncStatus.data?.state === "failed" && (
        <p
          role="alert"
          className="rounded-xl border border-amber-500/30 p-3 text-sm text-amber-700"
        >
          {tr("skills.sync.checkFailed")} · {syncStatus.data.error}
        </p>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-text">
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
            {success.operation === "added" && success.skills.length > 1
              ? tr("skills.manager.libraryAddedMultiple", { count: success.skills.length })
              : tr(librarySuccessKeys[success.operation], { name: success.skills[0].display_name })}
            {successHasDeployments ? ` ${tr("skills.manager.deploymentsUnchanged")}` : ""}
            {errors.length > 0 ? ` ${tr("skills.manager.refreshFailed")}` : ""}
          </span>
          <div className="flex flex-wrap gap-2">
            {deployableSuccessSkill && (
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => openDeployment(deployableSuccessSkill.name)}
              >
                {tr("skills.manager.deploy")}
              </Button>
            )}
            {successHasDeployments && (
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => setSection("workspace")}
              >
                {tr("skills.manager.viewDeployments")}
              </Button>
            )}
          </div>
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
        <div
          id={usageId}
          role="region"
          aria-labelledby={`${usageId}-heading`}
          className="grid gap-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2
                id={`${usageId}-heading`}
                ref={pendingHeading}
                tabIndex={-1}
                className="font-semibold"
              >
                {pendingOnly
                  ? tr("skills.sync.pending", { count: pendingSyncCount })
                  : tr("skills.workspaceUsage")}
              </h2>
              {pendingOnly && (
                <p className="text-xs text-muted-foreground">
                  {tr("skills.sync.pendingDescription")}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {pendingOnly && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setPendingOnly(false);
                    pendingHeading.current?.focus({ preventScroll: true });
                  }}
                >
                  {tr("skills.sync.showAllUsage")}
                </Button>
              )}
              <Button
                disabled={Boolean(busy) || managerLoading || importableCount === 0}
                onClick={() => setImportOpen(true)}
              >
                <Download size={15} />
                {tr("skills.imports.countedTitle", { count: importableCount })}
              </Button>
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
          </div>
          {pendingOnly &&
            !managerLoading &&
            unavailablePending.map((item) => (
              <div key={item.id} className="grid gap-2 rounded-xl border border-amber-500/40 p-4">
                <strong>{item.display_name ?? item.package_name}</strong>
                <code className="truncate text-xs" title={item.target}>
                  {displayPath(item.target)}
                </code>
                <p role="status" className="text-sm text-amber-700">
                  {tr("skills.sync.pendingUnavailable")}
                </p>
              </div>
            ))}
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
            syncState={syncQuery.data}
            onSync={setSyncRequest}
            pendingDeploymentIds={pendingOnly ? pendingDeploymentIds : undefined}
            emptyMessage={
              pendingOnly
                ? unavailablePending.length
                  ? null
                  : tr("skills.sync.noPending")
                : undefined
            }
          />
        </div>
      )}

      {section === "library" && (
        <div className="grid gap-4">
          {(libraryLoading || installed.length > 0) && (
            <>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">{tr("skills.libraryTitle")}</h2>
                  <p className="text-sm text-muted-foreground">{tr("skills.libraryDescription")}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={Boolean(busy) || managerLoading || importableCount === 0}
                    onClick={() => setImportOpen(true)}
                  >
                    <Download size={15} />
                    {tr("skills.imports.countedTitle", { count: importableCount })}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={Boolean(busy)}
                    onClick={() => void checkUpdates()}
                  >
                    <RefreshCw
                      className={cn(busy === "check-updates" && "animate-spin")}
                      size={15}
                    />
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
                <Select
                  value={libraryUsage}
                  onValueChange={(value) => value && setLibraryUsage(value)}
                >
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
            </>
          )}

          {libraryLoading ? (
            <EmptyState title={tr("common.loading")} />
          ) : !libraryQuery.data ? (
            <Button
              variant="outline"
              className="justify-self-start"
              disabled={Boolean(busy)}
              onClick={() => void run("refresh-library", loadLibrary)}
            >
              {tr("runtime.retry")}
            </Button>
          ) : !installed.length ? (
            <div className="grid min-h-60 place-items-center rounded-2xl border bg-card p-8 text-center">
              <div className="grid justify-items-center gap-3">
                <Library className="text-muted-foreground" size={24} />
                <h2 className="font-semibold">{tr("skills.libraryEmpty")}</h2>
                <p className="text-sm text-muted-foreground">
                  {tr(importableCount > 0 ? "skills.libraryEmptyHint" : "skills.libraryEmptyNone", {
                    count: importableCount,
                  })}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button
                    disabled={Boolean(busy) || managerLoading || importableCount === 0}
                    onClick={() => setImportOpen(true)}
                  >
                    <Download size={15} />
                    {tr("skills.imports.countedTitle", { count: importableCount })}
                  </Button>
                  <Button variant="link" onClick={() => setSection("discover")}>
                    {tr("skills.browseCurated")}
                  </Button>
                </div>
              </div>
            </div>
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
                        <Badge variant="outline">AgentKib</Badge>
                        {syncQuery.data?.library.find((item) => item.library_id === skill.name)
                          ?.locally_customized && (
                          <Badge variant="outline">{tr("skills.sync.customized")}</Badge>
                        )}
                        {skill.update_check === "failed" ? (
                          <Badge variant="outline" className="border-amber-500/40 text-amber-700">
                            {tr("skills.sync.checkFailed")}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className={statusClass(skill.status)}>
                            {statusLabel(skill.status, tr)}
                          </Badge>
                        )}
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
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={<Button size="icon-sm" variant="outline" />}
                          aria-label={`${tr("common.moreActions")} · ${skill.display_name}`}
                        >
                          <MoreHorizontal size={14} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {skill.source && (
                            <>
                              <DropdownMenuItem
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
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={Boolean(busy)}
                                onClick={() => void prepareUpdate(skill)}
                              >
                                <Download size={14} />
                                {tr("skills.update")}
                              </DropdownMenuItem>
                            </>
                          )}
                          {skill.can_rollback && (
                            <DropdownMenuItem
                              disabled={Boolean(busy)}
                              onClick={() => void rollback(skill)}
                            >
                              <History size={14} />
                              {tr("skills.rollback")}
                            </DropdownMenuItem>
                          )}
                          {(skill.source || skill.can_rollback) && <DropdownMenuSeparator />}
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={Boolean(busy)}
                            onClick={() => void uninstall(skill)}
                          >
                            <Trash2 size={14} />
                            {tr("skills.moveToTrash")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
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
                <GitHubIcon size={17} />
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

      {syncRequest && (
        <SkillSyncDialog
          key={JSON.stringify(syncRequest)}
          request={syncRequest}
          state={syncQuery.data}
          onClose={() => setSyncRequest(undefined)}
          onChanged={refreshAfterMutation}
        />
      )}
      {syncPolicyOpen && (
        <SkillSyncPolicyDialog
          state={syncQuery.data}
          onClose={() => setSyncPolicyOpen(false)}
          onChanged={refreshAfterMutation}
        />
      )}
      {syncRunsOpen && (
        <SkillSyncRunsDialog
          onClose={() => setSyncRunsOpen(false)}
          onChanged={refreshAfterMutation}
        />
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
            setSuccess(skills.length ? { operation: "added", skills } : undefined);
            setOperationWarnings(warnings);
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
