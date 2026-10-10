import { useQuery } from "@tanstack/react-query";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";
import { skillKeys } from "./skills-query";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Check, CircleAlert, Copy, Eye, LoaderCircle, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { api } from "@/core/api";
import type {
  AgentKind,
  InstalledSkill,
  PrepareSkillDeploymentRequest,
  SkillDeployment,
  SkillDeploymentOperation,
  SkillDeploymentPreview,
  SkillDeploymentReport,
  SkillDetailRequest,
  SkillInventory,
  SkillObservation,
  SkillPreviewFile,
  SkillTargetCapability,
  WorkspaceSummary,
} from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { sessionAgentNames } from "@/features/sessions/session-labels";
import { withAsyncCleanup } from "@/lib/utils";
import { isSkillDirectory, SkillFileBrowser, type SkillReadableContent } from "./SkillFileBrowser";

const knownStatuses = new Set([
  "current",
  "active",
  "inactive",
  "modified",
  "missing",
  "recovery-required",
  "unregistered-workspace",
  "observed",
  "native-restricted",
  "pending-trust",
  "unverified",
  "invalid",
  "broken-link",
  "link-loop",
  "conflict",
  "visible",
  "failed",
  "applied",
  "unchanged",
]);
function skillStatusLabel(status: string, translate: (key: string) => string) {
  return knownStatuses.has(status) ? translate(`skills.manager.status.${status}`) : status;
}
export function observationMatchesDeployment(
  observation: SkillObservation,
  deployment: SkillDeployment,
) {
  // A link can share package contents without sharing the destination's ownership or visibility.
  return observation.path === deployment.target;
}

interface ObservationGroup {
  path: string;
  observations: SkillObservation[];
}
export function groupSkillObservations(observations: SkillObservation[]): ObservationGroup[] {
  const groups = new Map<string, ObservationGroup>();
  for (const observation of observations) {
    const path = observation.resolved_path ?? observation.path;
    const group = groups.get(path) ?? { path, observations: [] };
    group.observations.push(observation);
    groups.set(path, group);
  }
  return [...groups.values()];
}

export function readableSkillFile(file: SkillPreviewFile): SkillReadableContent {
  return {
    path: file.path,
    before: file.before ?? undefined,
    after: file.after ?? undefined,
    binary: file.binary,
    truncated: file.truncated,
    before_size: file.before_size ?? undefined,
    after_size: file.after_size ?? undefined,
    before_sha256: file.before_sha256 ?? undefined,
    after_sha256: file.after_sha256 ?? undefined,
    before_executable: file.before_executable ?? undefined,
    after_executable: file.after_executable ?? undefined,
  };
}

export function SkillDetailDialog({
  request,
  onClose,
  onDeploy,
  onImport,
  deployments = [],
  inventory = { observations: [], warnings: [] },
}: {
  request: SkillDetailRequest;
  onClose: () => void;
  onDeploy: (libraryId: string) => void;
  onImport: (observationId: string) => void;
  deployments?: SkillDeployment[];
  inventory?: SkillInventory;
}) {
  const { tr, localizeMessage } = useI18n();
  const queryClient = useOptionalQueryClient();
  const observerId = useId();
  const detailQuery = useQuery(
    {
      ...queryDefaults,
      queryKey: [...skillKeys.detail(request), observerId],
      queryFn: () => api.skillDetail(request),
      staleTime: 0,
      gcTime: 0,
    },
    queryClient,
  );
  const detail = detailQuery.data;
  const error = detailQuery.error ?? undefined;
  const readFile = useCallback(
    async (path: string) => readableSkillFile(await api.readSkillDetailFile({ ...request, path })),
    [request],
  );
  const selectedObservation = inventory.observations.find(
    (item) => item.id === request.observation_id,
  );
  const libraryId = request.library_id ?? detail?.library_id ?? selectedObservation?.library_id;
  const usedDeployments = deployments.filter(
    (item) =>
      item.source_is_current_library === true &&
      item.library_id === libraryId &&
      item.status !== "inactive",
  );
  const usedPaths = new Set([
    ...usedDeployments.map((item) => item.target),
    ...(selectedObservation ? [selectedObservation.resolved_path ?? selectedObservation.path] : []),
  ]);
  const usedObservations = inventory.observations.filter(
    (item) =>
      item.id === request.observation_id ||
      (libraryId && item.library_id === libraryId) ||
      usedPaths.has(item.resolved_path ?? item.path),
  );
  const detailFiles = useMemo(
    () =>
      detail
        ? [
            ...detail.files,
            ...(detail.previous_files ?? []).filter(
              (file) => !detail.files.some((current) => current.path === file.path),
            ),
          ]
        : [],
    [detail],
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="top-0 right-0 left-auto h-dvh w-[min(1000px,100vw)] max-w-none translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none sm:max-w-none data-open:slide-in-from-right-8 data-open:zoom-in-100 data-closed:slide-out-to-right-8 data-closed:zoom-out-100">
        <DialogHeader>
          <DialogTitle>{detail?.name ?? tr("skills.manager.details")}</DialogTitle>
          <DialogDescription>
            {detail?.description || tr("skills.manager.readOnlyNotice")}
          </DialogDescription>
        </DialogHeader>
        {error !== undefined ? (
          <p role="alert" className="text-destructive">
            {localizeMessage(error)}
          </p>
        ) : !detail ? (
          <p role="status">{tr("common.loading")}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">
                {detail.source?.repository ?? tr("skills.localSource")}
              </Badge>
              <Badge variant="outline">
                {detail.files.filter((file) => !isSkillDirectory(file.path)).length}{" "}
                {tr("skills.files")}
              </Badge>
              {detail.files.some((file) => isSkillDirectory(file.path)) && (
                <Badge variant="outline">
                  {detail.files.filter((file) => isSkillDirectory(file.path)).length}{" "}
                  {tr("skills.manager.directories")}
                </Badge>
              )}
              <Badge variant="outline">{detail.total_size.toLocaleString()} B</Badge>
              {detail.source && <code>{detail.source.resolved_commit.slice(0, 12)}</code>}
            </div>
            {detail.local_source && (
              <code className="break-all text-xs">{detail.local_source}</code>
            )}
            {detail.local_resolved_path && detail.local_resolved_path !== detail.local_source && (
              <code className="break-all text-xs">→ {detail.local_resolved_path}</code>
            )}
            {detail.diagnostics.map((message, index) => (
              <p key={index} className="text-sm text-amber-700">
                {message}
              </p>
            ))}
            <div className="grid gap-2 rounded-xl border p-3">
              <h3 className="text-sm font-medium">{tr("skills.workspaceUsage")}</h3>
              <p className="text-xs text-muted-foreground">
                {tr("skills.manager.visibilityNotice")}
              </p>
              {usedDeployments.map((item) => (
                <div key={item.id} className="grid gap-1 text-xs">
                  <code className="break-all">{item.target}</code>
                  <span>
                    {skillStatusLabel(item.status, tr)} ·{" "}
                    {item.visible_to.map((agent) => sessionAgentNames[agent]).join(" · ")}
                  </span>
                </div>
              ))}
              {usedObservations.map((item) => (
                <div key={item.id} className="grid gap-1 text-xs">
                  <code className="break-all">{item.path}</code>
                  <span>
                    {tr(
                      item.scope === "personal"
                        ? "skills.manager.personal"
                        : "skills.manager.project",
                    )}{" "}
                    · {item.agents.map((agent) => sessionAgentNames[agent]).join(" · ")} ·{" "}
                    {tr("skills.manager.nativeVisibility")} {skillStatusLabel(item.status, tr)}
                  </span>
                  {item.diagnostics.map((message) => (
                    <p key={message} className="text-amber-700">
                      {message}
                    </p>
                  ))}
                </div>
              ))}
              {!usedDeployments.length && !usedObservations.length && (
                <p className="text-xs text-muted-foreground">{tr("skills.manager.noUsage")}</p>
              )}
            </div>
            <h3 className="text-sm font-medium">{tr("skills.manager.contentVersions")}</h3>
            <SkillFileBrowser
              key={detail.library_id ?? detail.observation_id}
              files={detailFiles}
              readFile={readFile}
            />
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tr("common.close")}
          </Button>
          {detail &&
            (request.library_id ? (
              <Button onClick={() => onDeploy(request.library_id!)}>
                {tr("skills.manager.deploy")}
              </Button>
            ) : (
              request.observation_id && (
                <Button onClick={() => onImport(request.observation_id!)}>
                  <Copy size={14} />
                  {tr("skills.manager.copyToLibrary")}
                </Button>
              )
            ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface SkillDeploymentAction {
  operation: SkillDeploymentOperation | "recover";
  libraryId?: string;
  deployment?: SkillDeployment;
  recoveryDeployments?: SkillDeployment[];
}

interface DeploymentRecovery {
  operationId: string;
  targets: { path: string; scope: string; workspace_id: string | null; visible_to: AgentKind[] }[];
}

function deploymentRecovery(
  operationId: string,
  deployments: SkillDeployment[],
): DeploymentRecovery {
  return {
    operationId,
    targets: deployments
      .filter((item) => item.operation_id === operationId && item.status === "recovery-required")
      .map((item) => ({
        path: item.target,
        scope: item.scope,
        workspace_id: item.workspace_id,
        visible_to: item.visible_to,
      })),
  };
}

interface TargetGroup {
  key: string;
  root: string;
  targets: SkillTargetCapability[];
}

export function groupSkillTargets(targets: SkillTargetCapability[]): TargetGroup[] {
  const groups = new Map<string, TargetGroup>();
  for (const target of targets) {
    const key = `${target.scope}\0${target.workspace_id ?? ""}\0${target.root}`;
    const group = groups.get(key) ?? { key, root: target.root, targets: [] };
    group.targets.push(target);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function SkillDeploymentDialog({
  action,
  workspaces,
  onClose,
  onChanged,
}: {
  action: SkillDeploymentAction;
  workspaces: WorkspaceSummary[];
  onClose: () => void;
  onChanged: () => Promise<unknown[]>;
}) {
  const { tr, localizeMessage, formatDateTime } = useI18n();
  const queryClient = useOptionalQueryClient();
  const targetsQuery = useQuery(
    {
      ...queryDefaults,
      queryKey: skillKeys.targets(),
      queryFn: () => api.skillTargets(),
      enabled: action.operation === "deploy",
      staleTime: 0,
    },
    queryClient,
  );
  const targets = useMemo(() => targetsQuery.data ?? [], [targetsQuery.data]);
  const [scope, setScope] = useState("personal");
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<SkillDeploymentPreview>();
  const [report, setReport] = useState<SkillDeploymentReport>();
  const [selectedTarget, setSelectedTarget] = useState<string>();
  const [approveHome, setApproveHome] = useState(false);
  const [actionBusy, setBusy] = useState(
    action.operation !== "recover" && action.operation !== "deploy",
  );
  const busy = actionBusy || (action.operation === "deploy" && targetsQuery.isPending);
  const [actionErrors, setErrors] = useState<unknown[]>([]);
  const errors = targetsQuery.error ? [...actionErrors, targetsQuery.error] : actionErrors;
  const [refreshErrors, setRefreshErrors] = useState<unknown[]>([]);
  const [pendingRecovery, setPendingRecovery] = useState<DeploymentRecovery>();
  const [recoveryLookupError, setRecoveryLookupError] = useState<unknown>();
  const [recovery, setRecovery] = useState<DeploymentRecovery | undefined>(() =>
    action.operation === "recover" && action.deployment
      ? deploymentRecovery(
          action.deployment.operation_id,
          action.recoveryDeployments ?? [action.deployment],
        )
      : undefined,
  );
  const groups = useMemo(() => groupSkillTargets(targets), [targets]);
  const visibleGroups = groups.filter((group) =>
    scope === "personal"
      ? group.targets[0].scope === "personal"
      : group.targets[0].workspace_id === scope,
  );
  const chosenTargetIds = groups
    .filter((group) => selected.includes(group.key))
    .flatMap((group) =>
      group.targets.filter((target) => target.writable).map((target) => target.id),
    );
  useEffect(() => {
    if (action.operation === "recover" || action.operation === "deploy") return;
    let cancelled = false;
    const task = api
      .prepareSkillDeployment({
        operation: action.operation,
        deployment_id: action.deployment?.id,
      })
      .then((value) => {
        if (!cancelled) {
          setPreview(value);
          setSelectedTarget(value.targets[0]?.target_id);
        }
      });
    task
      .catch((error) => {
        if (!cancelled) setErrors([error]);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [action]);
  const prepare = async () => {
    if (action.operation === "recover") return;
    setBusy(true);
    setErrors([]);
    setApproveHome(false);
    const request: PrepareSkillDeploymentRequest =
      action.operation === "deploy"
        ? { operation: "deploy", library_id: action.libraryId, target_ids: chosenTargetIds }
        : { operation: action.operation, deployment_id: action.deployment?.id };
    await withAsyncCleanup(
      async () => {
        try {
          const next = await api.prepareSkillDeployment(request);
          setPreview(next);
          setSelectedTarget(next.targets[0]?.target_id);
        } catch (error) {
          setErrors([error]);
        }
      },
      () => setBusy(false),
    );
  };
  const apply = async () => {
    const token = recovery?.operationId ?? preview?.token;
    const requiresHome = recovery
      ? recovery.targets.some((target) => target.scope === "personal")
      : preview?.requires_home_approval;
    if (!token || busy || (requiresHome && !approveHome)) return;
    setBusy(true);
    setErrors([]);
    await withAsyncCleanup(
      async () => {
        try {
          const result = await api.applySkillDeployment(token, approveHome);
          setReport(result);
          setPendingRecovery(undefined);
          setRecoveryLookupError(undefined);
          // Successful native writes can still have pending reservation cleanup. The current
          // deployment list, rather than the operation's old targets or result status, owns this state.
          const [refresh, currentDeployments] = await Promise.allSettled([
            onChanged(),
            api.skillDeployments(),
          ]);
          setRefreshErrors(refresh.status === "fulfilled" ? refresh.value : [refresh.reason]);
          if (currentDeployments.status === "fulfilled") {
            setPendingRecovery(deploymentRecovery(result.operation_id, currentDeployments.value));
          } else {
            setRecoveryLookupError(currentDeployments.reason);
          }
        } catch (error) {
          setErrors([error]);
        }
      },
      () => setBusy(false),
    );
  };
  const reviewRecovery = async () => {
    if (!report || busy) return;
    setBusy(true);
    await withAsyncCleanup(
      async () => {
        try {
          setPendingRecovery(deploymentRecovery(report.operation_id, await api.skillDeployments()));
          setRecoveryLookupError(undefined);
        } catch (error) {
          setRecoveryLookupError(error);
        }
      },
      () => setBusy(false),
    );
  };
  const targetPreview = preview?.targets.find((target) => target.target_id === selectedTarget);
  const files = useMemo(
    () =>
      targetPreview
        ? [
            ...new Set([
              ...targetPreview.added,
              ...targetPreview.modified,
              ...targetPreview.removed,
            ]),
          ].map((path) => ({ path, size: 0, executable: false }))
        : [],
    [targetPreview],
  );
  const previewToken = preview?.token;
  const readFile = useCallback(
    async (path: string) => {
      if (!previewToken || !selectedTarget)
        throw new Error("Skill deployment preview is unavailable");
      return readableSkillFile(await api.readSkillPreviewFile(previewToken, path, selectedTarget));
    },
    [previewToken, selectedTarget],
  );
  const hasEligible = preview?.targets.some((target) => !target.conflicts.length);
  const workspaceName = (id: string | null) =>
    workspaces.find((workspace) => workspace.id === id)?.name ??
    id ??
    tr("skills.manager.personal");
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[90vh] w-[min(1000px,calc(100vw-2rem))] !max-w-none overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>
            {tr(`skills.manager.operation.${recovery ? "recover" : action.operation}`)}
          </DialogTitle>
          <DialogDescription>
            {recovery
              ? tr("skills.manager.recoveryDescription")
              : action.operation === "undeploy"
                ? tr("skills.manager.withdrawDescription")
                : tr("skills.manager.deploymentDescription")}
          </DialogDescription>
        </DialogHeader>
        {errors.length > 0 && (
          <div role="alert" className="text-sm text-destructive">
            {errors.map(localizeMessage).join(" · ")}
          </div>
        )}
        {busy && !preview && !recovery && (
          <p role="status" className="flex gap-2">
            <LoaderCircle size={16} className="animate-spin" />
            {tr("common.loading")}
          </p>
        )}
        {!preview && !recovery && action.operation === "deploy" && (
          <>
            <Select
              value={scope}
              onValueChange={(value) => {
                if (value) {
                  setScope(value);
                  setSelected([]);
                }
              }}
            >
              <SelectTrigger aria-label={tr("skills.manager.scope")}>
                <SelectValue>
                  {scope === "personal" ? tr("skills.manager.personal") : workspaceName(scope)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{tr("skills.manager.scope")}</SelectLabel>
                  <SelectItem value="personal">{tr("skills.manager.personal")}</SelectItem>
                  {workspaces
                    .filter((workspace) => !workspace.remote)
                    .map((workspace) => (
                      <SelectItem key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </SelectItem>
                    ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <div className="grid max-h-96 gap-2 overflow-auto">
              {visibleGroups.map((group) => {
                const writable = group.targets.some((target) => target.writable);
                const agents = [...new Set(group.targets.flatMap((target) => target.visible_to))];
                return (
                  <div key={group.key} className="rounded-xl border p-3">
                    <Label className="flex items-start gap-3">
                      <Checkbox
                        checked={selected.includes(group.key)}
                        disabled={!writable || busy}
                        onCheckedChange={(checked) =>
                          setSelected((current) =>
                            checked
                              ? [...current, group.key]
                              : current.filter((key) => key !== group.key),
                          )
                        }
                        aria-label={group.root}
                      />
                      <span className="grid min-w-0 gap-2">
                        <span className="flex flex-wrap items-center gap-2">
                          {group.targets.map((target) => (
                            <span key={target.id} className="inline-flex items-center gap-1">
                              <AgentIcon agent={target.agent} compact />
                              {sessionAgentNames[target.agent]}
                              {target.profile ? ` · ${target.profile}` : ""}
                            </span>
                          ))}
                        </span>
                        <code className="break-all text-xs">{group.root}</code>
                      </span>
                    </Label>
                    {agents.length > 1 && (
                      <p className="mt-2 text-xs text-amber-700">
                        {tr("skills.manager.sharedImpact", {
                          agents: agents.map((agent) => sessionAgentNames[agent]).join("、"),
                        })}
                      </p>
                    )}
                    {group.targets
                      .flatMap((target) => [
                        ...(target.reason ? [target.reason] : []),
                        ...target.conditions,
                      ])
                      .filter((value, index, all) => all.indexOf(value) === index)
                      .map((message) => (
                        <p key={message} className="mt-1 text-xs text-muted-foreground">
                          {message}
                        </p>
                      ))}
                  </div>
                );
              })}
              {!busy && !visibleGroups.length && (
                <p className="text-sm text-muted-foreground">{tr("skills.manager.noTargets")}</p>
              )}
            </div>
          </>
        )}
        {preview && !report && !recovery && (
          <>
            <p className="text-xs text-muted-foreground">
              {tr("skills.manager.previewExpires", { time: formatDateTime(preview.expires_at) })}
            </p>
            <div className="grid gap-2">
              {preview.targets.map((target) => (
                <div key={target.target_id} className="rounded-xl border p-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-auto max-w-full justify-start text-left"
                    onClick={() => setSelectedTarget(target.target_id)}
                    aria-pressed={selectedTarget === target.target_id}
                  >
                    <Eye size={14} />
                    <span className="break-all">{target.path}</span>
                  </Button>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {target.scope === "personal"
                      ? tr("skills.manager.personal")
                      : workspaceName(target.workspace_id)}{" "}
                    · +{target.added.length} / ~{target.modified.length} / −{target.removed.length}
                  </p>
                  {target.visible_to.length > 1 && (
                    <p className="mt-1 text-xs text-amber-700">
                      {tr("skills.manager.sharedImpact", {
                        agents: target.visible_to
                          .map((agent) => sessionAgentNames[agent])
                          .join("、"),
                      })}
                    </p>
                  )}
                  {target.conflicts.map((conflict) => (
                    <p key={conflict} className="mt-1 text-sm text-destructive">
                      {conflict}
                    </p>
                  ))}
                  {target.conditions.map((condition) => (
                    <p key={condition} className="mt-1 text-xs text-muted-foreground">
                      {condition}
                    </p>
                  ))}
                </div>
              ))}
            </div>
            {!!files.length && (
              <SkillFileBrowser
                key={`${preview.token}:${selectedTarget}`}
                files={files}
                readFile={readFile}
              />
            )}
            {preview.requires_home_approval && (
              <Label className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <Checkbox
                  checked={approveHome}
                  disabled={busy}
                  onCheckedChange={(checked) => setApproveHome(Boolean(checked))}
                />
                <span>{tr("skills.manager.approveHome")}</span>
              </Label>
            )}
          </>
        )}
        {recovery && !report && (
          <>
            {recovery.targets.map((target) => (
              <div key={target.path} className="grid gap-2 rounded-xl border p-3">
                <code className="break-all text-xs">{target.path}</code>
                <p className="text-xs text-muted-foreground">
                  {target.scope === "personal"
                    ? tr("skills.manager.personal")
                    : workspaceName(target.workspace_id)}
                </p>
                {target.visible_to.length > 1 && (
                  <p className="text-xs text-amber-700">
                    {tr("skills.manager.sharedImpact", {
                      agents: target.visible_to.map((agent) => sessionAgentNames[agent]).join("、"),
                    })}
                  </p>
                )}
              </div>
            ))}
            {recovery.targets.some((target) => target.scope === "personal") && (
              <Label className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <Checkbox
                  checked={approveHome}
                  disabled={busy}
                  onCheckedChange={(checked) => setApproveHome(Boolean(checked))}
                />
                <span>{tr("skills.manager.approveHome")}</span>
              </Label>
            )}
          </>
        )}
        {report && (
          <div className="grid gap-2" role="status">
            <p className="font-medium">
              {tr("skills.manager.resultSummary", {
                succeeded: report.results.filter((result) => result.success).length,
                total: report.results.length,
              })}
            </p>
            {report.results.map((result) => (
              <div key={result.target_id} className="rounded-lg border p-3">
                <div className="flex items-start gap-2">
                  {result.success ? (
                    <Check size={16} className="shrink-0 text-emerald-600" />
                  ) : (
                    <CircleAlert size={16} className="shrink-0 text-destructive" />
                  )}
                  <code className="break-all text-xs">{result.path}</code>
                </div>
                <p className="mt-1 text-sm">
                  {result.error ?? skillStatusLabel(result.status, tr)}
                </p>
              </div>
            ))}
            {report.warnings.map((warning) => (
              <p key={warning} className="text-sm text-amber-700">
                {warning}
              </p>
            ))}
            {refreshErrors.length > 0 && (
              <p role="alert" className="text-sm text-amber-700">
                {tr("skills.manager.refreshFailed")}{" "}
                {refreshErrors.map(localizeMessage).join(" · ")}
              </p>
            )}
            {recoveryLookupError !== undefined && (
              <p role="alert" className="text-sm text-amber-700">
                {tr("skills.manager.refreshFailed")} {localizeMessage(recoveryLookupError)}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {tr("common.close")}
          </Button>
          {report && !pendingRecovery && (
            <Button disabled={busy} onClick={() => void reviewRecovery()}>
              <RefreshCw size={14} />
              {tr("skills.manager.replan")}
            </Button>
          )}
          {report && !!pendingRecovery?.targets.length && (
            <Button
              disabled={busy}
              onClick={() => {
                setRecovery(pendingRecovery);
                setReport(undefined);
                setApproveHome(false);
                setRefreshErrors([]);
              }}
            >
              {tr("skills.manager.operation.recover")}
            </Button>
          )}
          {!report && recovery && (
            <Button
              disabled={
                busy ||
                (recovery.targets.some((target) => target.scope === "personal") && !approveHome)
              }
              onClick={() => void apply()}
            >
              {busy && <LoaderCircle size={14} className="animate-spin" />}
              {tr("skills.manager.operation.recover")}
            </Button>
          )}
          {!report &&
            !recovery &&
            (preview ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (action.operation === "deploy") {
                      setPreview(undefined);
                      setApproveHome(false);
                    } else void prepare();
                  }}
                >
                  <RefreshCw size={14} />
                  {tr("skills.manager.replan")}
                </Button>
                <Button
                  disabled={
                    busy || !hasEligible || (preview.requires_home_approval && !approveHome)
                  }
                  onClick={() => void apply()}
                >
                  {busy && <LoaderCircle size={14} className="animate-spin" />}
                  {tr("skills.manager.applyDeployment")}
                </Button>
              </>
            ) : (
              <Button
                disabled={busy || (action.operation === "deploy" && !chosenTargetIds.length)}
                onClick={() => void prepare()}
              >
                {tr("skills.manager.reviewDeployment")}
              </Button>
            ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SkillUsageList({
  inventory,
  deployments,
  installed,
  workspaces,
  loading,
  busy,
  onDetail,
  onImport,
  onAction,
  onOpen,
}: {
  inventory: SkillInventory;
  deployments: SkillDeployment[];
  installed: InstalledSkill[];
  workspaces: WorkspaceSummary[];
  loading: boolean;
  busy: boolean;
  onDetail: (request: SkillDetailRequest) => void;
  onImport: (observationId: string) => void;
  onAction: (action: SkillDeploymentAction) => void;
  onOpen: (id: string) => void;
}) {
  const { tr } = useI18n();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [agent, setAgent] = useState("all");
  const [showInactive, setShowInactive] = useState(false);
  const matches = (name: string, path: string, scopeValue: string, agents: string[]) =>
    `${name} ${path} ${agents.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()) &&
    (scope === "all" || scope === scopeValue) &&
    (agent === "all" || agents.includes(agent));
  const native = inventory.observations.filter(
    (observation) =>
      !deployments.some(
        (deployment) =>
          deployment.status !== "inactive" && observationMatchesDeployment(observation, deployment),
      ),
  );
  const agents = [
    ...new Set([
      ...inventory.observations.flatMap((item) => item.agents),
      ...deployments.flatMap((item) => item.visible_to),
    ]),
  ];
  const filteredDeployments = deployments.filter(
    (item) =>
      (showInactive || item.status !== "inactive") &&
      matches(item.display_name ?? item.package_name, item.target, item.scope, item.visible_to),
  );
  const filteredNative = groupSkillObservations(native).filter((group) =>
    group.observations.some((item) =>
      matches(item.name, `${item.path} ${group.path}`, item.scope, item.agents),
    ),
  );
  const location = (item: { scope: string; workspace_id: string | null }) =>
    item.scope === "personal"
      ? tr("skills.manager.personal")
      : (workspaces.find((workspace) => workspace.id === item.workspace_id)?.name ??
        item.workspace_id);
  const observationRow = (group: ObservationGroup) => {
    const item =
      group.observations.find((observation) => observation.path === group.path) ??
      group.observations[0];
    const diagnostics = [
      ...new Set(group.observations.flatMap((observation) => observation.diagnostics)),
    ];
    const workspaceIds = [
      ...new Set(
        group.observations.flatMap((observation) =>
          observation.workspace_id ? [observation.workspace_id] : [],
        ),
      ),
    ];
    return (
      <div key={group.path} className="grid gap-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <strong>{item.name}</strong>
          <Badge variant="outline">{tr("skills.manager.external")}</Badge>
          {[...new Set(group.observations.map((observation) => observation.owner))].map((owner) => (
            <Badge key={owner} variant="outline">
              {owner}
            </Badge>
          ))}
        </div>
        <code className="break-all text-xs">{group.path}</code>
        <div className="grid gap-2 border-l pl-3">
          {group.observations.map((observation) => (
            <div key={observation.id} className="grid gap-1">
              <code className="break-all text-xs">{observation.path}</code>
              <p className="text-xs text-muted-foreground">
                {location(observation)} ·{" "}
                {observation.agents.map((value) => sessionAgentNames[value]).join(" · ")} ·{" "}
                {skillStatusLabel(observation.status, tr)}
              </p>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{tr("skills.manager.externalNotice")}</p>
        {diagnostics.map((diagnostic) => (
          <p key={diagnostic} className="text-xs text-amber-700">
            {diagnostic}
          </p>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => onDetail({ observation_id: item.id })}>
            <Eye size={14} />
            {tr("skills.manager.details")}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onImport(item.id)}>
            <Copy size={14} />
            {tr("skills.manager.copyToLibrary")}
          </Button>
          {workspaceIds.map((id) => (
            <Button key={id} size="sm" variant="ghost" onClick={() => onOpen(id)}>
              {tr("skills.manager.openWorkspace")} ·{" "}
              {workspaces.find((workspace) => workspace.id === id)?.name ?? id}
            </Button>
          ))}
        </div>
      </div>
    );
  };
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <Input
          className="min-w-40 flex-1"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={tr("skills.search")}
          placeholder={tr("skills.search")}
        />
        <Select value={scope} onValueChange={(value) => value && setScope(value)}>
          <SelectTrigger aria-label={tr("skills.manager.scope")} className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>{tr("skills.manager.scope")}</SelectLabel>
              <SelectItem value="all">{tr("skills.manager.allScopes")}</SelectItem>
              <SelectItem value="personal">{tr("skills.manager.personal")}</SelectItem>
              <SelectItem value="workspace">{tr("skills.manager.project")}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select value={agent} onValueChange={(value) => value && setAgent(value)}>
          <SelectTrigger aria-label={tr("workspace.allAgents")} className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>{tr("workspace.allAgents")}</SelectLabel>
              <SelectItem value="all">{tr("workspace.allAgents")}</SelectItem>
              {agents.map((value) => (
                <SelectItem value={value} key={value}>
                  {sessionAgentNames[value]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <Label className="flex items-center gap-2 text-xs">
        <Checkbox
          checked={showInactive}
          onCheckedChange={(checked) => setShowInactive(Boolean(checked))}
        />
        {tr("skills.manager.showInactive")}
      </Label>
      {loading && <p role="status">{tr("common.loading")}</p>}
      <p className="text-xs text-muted-foreground">{tr("skills.manager.visibilityNotice")}</p>
      {filteredDeployments.map((item) => {
        const localSource = item.source_is_current_library === true;
        const libraryHash = installed.find(
          (skill) => localSource && skill.name === item.library_id,
        )?.content_sha256;
        const observed = inventory.observations.filter((observation) =>
          observationMatchesDeployment(observation, item),
        );
        const diagnostics = [
          ...new Set([
            ...item.diagnostics,
            ...observed.flatMap((observation) => observation.diagnostics),
          ]),
        ];
        return (
          <div key={item.id} className="grid gap-3 rounded-xl border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <strong>{item.display_name ?? item.package_name}</strong>
              <Badge variant="outline">{tr("skills.manager.managedDeployment")}</Badge>
              <Badge variant="secondary">{skillStatusLabel(item.status, tr)}</Badge>
              {item.status !== "inactive" && libraryHash && libraryHash !== item.package_hash && (
                <Badge variant="outline">{tr("skills.manager.differsFromLibrary")}</Badge>
              )}
            </div>
            <code className="break-all text-xs">{item.target}</code>
            {!localSource && (
              <p className="text-xs text-amber-700">
                {tr("skills.manager.sourceUnavailable")}
                {item.library_root && <code className="ml-1 break-all">{item.library_root}</code>}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {location(item)} ·{" "}
              {item.visible_to.map((value) => sessionAgentNames[value]).join(" · ")}
            </p>
            <div className="flex flex-wrap gap-2 text-xs">
              <span>{tr("skills.manager.nativeVisibility")}</span>
              {observed.length ? (
                [...new Set(observed.map((observation) => observation.status))].map((status) => (
                  <Badge key={status} variant="outline">
                    {skillStatusLabel(status, tr)}
                  </Badge>
                ))
              ) : (
                <Badge variant="outline">{skillStatusLabel("unverified", tr)}</Badge>
              )}
            </div>
            {item.visible_to.length > 1 && (
              <p className="text-xs text-amber-700">
                {tr("skills.manager.sharedImpact", {
                  agents: item.visible_to.map((value) => sessionAgentNames[value]).join("、"),
                })}
              </p>
            )}
            {diagnostics.map((diagnostic) => (
              <p key={diagnostic} className="text-xs text-amber-700">
                {diagnostic}
              </p>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!observed.length && !localSource}
                onClick={() =>
                  onDetail(
                    observed[0]
                      ? { observation_id: observed[0].id }
                      : { library_id: item.library_id },
                  )
                }
              >
                {tr("skills.manager.details")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy ||
                  (item.status !== "recovery-required" &&
                    (!localSource || !installed.some((skill) => skill.name === item.library_id)))
                }
                onClick={() =>
                  onAction(
                    item.status === "recovery-required"
                      ? {
                          operation: "recover",
                          deployment: item,
                          recoveryDeployments: deployments.filter(
                            (deployment) =>
                              deployment.operation_id === item.operation_id &&
                              deployment.status === "recovery-required",
                          ),
                        }
                      : item.status === "inactive"
                        ? { operation: "deploy", libraryId: item.library_id }
                        : { operation: "update", deployment: item },
                  )
                }
              >
                {tr(
                  item.status === "recovery-required"
                    ? "skills.manager.operation.recover"
                    : item.status === "inactive"
                      ? "skills.manager.deploy"
                      : "skills.manager.syncUpdate",
                )}
              </Button>
              {item.previous_hash && item.status !== "recovery-required" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onAction({ operation: "rollback", deployment: item })}
                >
                  {tr("skills.manager.rollbackDeployment")}
                </Button>
              )}
              {item.status !== "inactive" && item.status !== "recovery-required" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => onAction({ operation: "undeploy", deployment: item })}
                >
                  {tr("skills.manager.withdraw")}
                </Button>
              )}
              {item.workspace_id && (
                <Button size="sm" variant="ghost" onClick={() => onOpen(item.workspace_id!)}>
                  {tr("skills.manager.openWorkspace")}
                </Button>
              )}
            </div>
          </div>
        );
      })}
      {filteredNative.map(observationRow)}
      {!loading && !filteredDeployments.length && !filteredNative.length && (
        <p className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">
          {tr("skills.manager.noUsage")}
        </p>
      )}
    </div>
  );
}
