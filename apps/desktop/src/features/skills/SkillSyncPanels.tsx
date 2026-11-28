import { LoadingSkeleton } from "@agentkib/session-ui";
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/core/api";
import { useI18n } from "@/core/useI18n";
import type {
  PrepareSkillSyncRequest,
  SkillSyncPolicy,
  SkillSyncReport,
  SkillSyncState,
  SkillSyncComparison,
} from "@/core/types";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";
import { skillKeys } from "./skills-query";
import { readableSkillFile } from "./SkillManagerPanels";
import { SkillFileBrowser } from "./SkillFileBrowser";
import { Button } from "@agentkib/ui/button";
import { Badge } from "@agentkib/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@agentkib/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@agentkib/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@agentkib/ui/dialog";

const resultStatuses = new Set([
  "synchronized",
  "detached",
  "forked",
  "recovery-required",
  "failed",
  "blocked",
  "current",
  "library-updated",
  "update-available",
  "committed",
  "recovered",
  "applied",
  "rolled_back",
  "check-failed",
]);
function resultLabel(status: string, translate: (key: string) => string) {
  return resultStatuses.has(status) ? translate(`skills.sync.result.${status}`) : status;
}

export function SkillSyncDialog({
  request,
  state,
  onClose,
  onChanged,
}: {
  request: PrepareSkillSyncRequest;
  state?: SkillSyncState;
  onClose(): void;
  onChanged(): Promise<unknown[]>;
}) {
  const { tr, localizeMessage, formatDateTime } = useI18n();
  const client = useOptionalQueryClient();
  const [resolution, setResolution] = useState(request.resolution);
  const [libraryId, setLibraryId] = useState(request.library_id);
  const operation =
    resolution && (request.operation === "pull" || request.operation === "push")
      ? resolution === "library"
        ? "push"
        : "pull"
      : request.operation;
  const [report, setReport] = useState<SkillSyncReport>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [approveHome, setApproveHome] = useState(false);
  const [targetIndex, setTargetIndex] = useState(0);
  const [comparison, setComparison] = useState<SkillSyncComparison>("candidate");
  const preparation = useQuery(
    {
      ...queryDefaults,
      queryKey: ["skill-sync-preview", request, resolution, libraryId],
      queryFn: async ({ signal }) => {
        const input: PrepareSkillSyncRequest = { ...request, operation };
        delete input.library_id;
        delete input.resolution;
        if (libraryId) input.library_id = libraryId;
        if (resolution) input.resolution = resolution;
        const next = await api.prepareSkillSync(input);
        if (signal.aborted) {
          await api.discardSkillPreview(next.token);
          throw new Error("Skill synchronization preview was closed");
        }
        return next;
      },
      staleTime: 0,
      gcTime: 0,
    },
    client,
  );
  const current = preparation.data;
  useEffect(() => {
    if (!current || report) return;
    return () => {
      void api.discardSkillPreview(current.token).catch(() => undefined);
    };
  }, [current, report]);
  const target = current?.targets[targetIndex];
  const comparedFiles =
    comparison === "base-library"
      ? target?.base_library
      : comparison === "base-target"
        ? target?.base_target
        : target;
  const readFile = useCallback(
    async (path: string) => {
      if (!current) throw new Error("Skill synchronization preview is unavailable");
      return readableSkillFile(
        await (comparison === "candidate"
          ? api.readSkillPreviewFile(current.token, path, target?.target_id)
          : api.readSkillPreviewFile(
              current.token,
              path,
              target?.target_id,
              undefined,
              comparison,
            )),
      );
    },
    [current, target?.target_id, comparison],
  );
  const apply = async () => {
    if (!current || busy || (current.requires_home_approval && !approveHome)) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.applySkillSync(current.token, approveHome);
      setReport(next);
      const failures = await onChanged();
      if (failures.length) setError(failures.map(localizeMessage).join(" · "));
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (current && !report) await api.discardSkillPreview(current.token);
      onClose();
    } catch (reason) {
      setError(reason);
      setBusy(false);
    }
  };
  const chooseResolution = async (next: "library" | "deployment") => {
    if (busy || next === resolution) return;
    setBusy(true);
    try {
      if (current) await api.discardSkillPreview(current.token);
      setApproveHome(false);
      setComparison("candidate");
      setTargetIndex(0);
      setError(undefined);
      setResolution(next);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  };
  const chooseLibrary = async (next: string) => {
    const selected = next === "new" ? undefined : next.slice("existing:".length);
    if (busy || selected === libraryId) return;
    setBusy(true);
    try {
      if (current) await api.discardSkillPreview(current.token);
      setApproveHome(false);
      setComparison("candidate");
      setTargetIndex(0);
      setError(undefined);
      setResolution(undefined);
      setLibraryId(selected);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  };
  const conflicts = current?.targets.flatMap((item) => item.conflicts) ?? [];
  const reviewingConflict =
    !resolution &&
    (request.operation === "push" || request.operation === "pull") &&
    (current
      ? conflicts.length > 0
      : state?.deployments.find((item) => item.id === request.deployment_id)?.sync_state ===
        "conflict");
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && void close()}>
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[85vh] w-[min(920px,calc(100vw-2rem))] !max-w-none overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>
            {tr(
              reviewingConflict
                ? "skills.sync.reviewConflict"
                : `skills.sync.operation.${operation}`,
            )}
          </DialogTitle>
          <DialogDescription>
            {tr(
              reviewingConflict
                ? "skills.sync.conflictDescription"
                : `skills.sync.description.${operation}`,
            )}{" "}
            {tr("skills.sync.reviewNotice")}
          </DialogDescription>
        </DialogHeader>
        {request.operation === "adopt" && !report && (
          <div className="grid gap-2">
            <Label htmlFor="skill-sync-adopt-library">{tr("skills.sync.adoptLibrary")}</Label>
            <Select
              value={libraryId ? `existing:${libraryId}` : "new"}
              disabled={busy}
              onValueChange={(value) => value && void chooseLibrary(value)}
            >
              <SelectTrigger id="skill-sync-adopt-library" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">{tr("skills.sync.newLibrary")}</SelectItem>
                {(state?.library ?? []).map((item) => (
                  <SelectItem
                    key={item.library_id}
                    value={`existing:${item.library_id}`}
                    disabled={!item.valid}
                  >
                    {item.display_name} · {item.library_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{tr("skills.sync.adoptLibraryNotice")}</p>
          </div>
        )}
        {(error || preparation.error) && (
          <p role="alert" className="text-sm text-destructive-text">
            {localizeMessage(error ?? preparation.error)}
          </p>
        )}
        {preparation.isPending && <LoadingSkeleton label={tr("common.loading")} />}
        {current && !report && (
          <>
            <p className="text-xs text-muted-foreground">
              {tr("skills.manager.previewExpires", { time: formatDateTime(current.expires_at) })}
            </p>
            {current.targets.map((item, index) => (
              <div key={`${item.path}:${index}`} className="rounded-lg border p-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setTargetIndex(index)}
                  aria-pressed={index === targetIndex}
                >
                  <code className="break-all">{item.path}</code>
                </Button>
                <p className="text-sm">
                  {tr(`skills.sync.state.${item.state}`)} · +{item.added.length} / ~
                  {item.modified.length} / −{item.removed.length}
                </p>
                {item.conflicts.map((conflict) => (
                  <p key={conflict} className="text-sm text-destructive-text">
                    {conflict}
                  </p>
                ))}
              </div>
            ))}
            {request.operation === "adopt" && current.library_id && resolution && (
              <p role="note" className="text-sm text-amber-700">
                {tr(
                  resolution === "deployment"
                    ? "skills.sync.adoptUpdatesLibrary"
                    : "skills.sync.adoptUpdatesInstallation",
                  { library: current.library_id },
                )}
              </p>
            )}
            {((conflicts.length > 0 &&
              (request.operation === "pull" || request.operation === "push")) ||
              (request.operation === "adopt" && Boolean(libraryId))) && (
              <div className="grid gap-2 rounded-lg border border-amber-500/40 p-3">
                <p className="text-sm">
                  {tr(
                    request.operation === "adopt"
                      ? "skills.sync.versionNotice"
                      : "skills.sync.conflictNotice",
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant={resolution === "library" ? "default" : "outline"}
                    disabled={busy}
                    onClick={() => void chooseResolution("library")}
                  >
                    {tr("skills.sync.useLibrary")}
                  </Button>
                  <Button
                    variant={resolution === "deployment" ? "default" : "outline"}
                    disabled={busy}
                    onClick={() => void chooseResolution("deployment")}
                  >
                    {tr("skills.sync.useDeployment")}
                  </Button>
                </div>
              </div>
            )}
            {target && (
              <Tabs
                value={comparison}
                onValueChange={(value) => setComparison(value as SkillSyncComparison)}
              >
                <TabsList>
                  <TabsTrigger value="candidate">
                    {tr("skills.sync.comparison.candidate")}
                  </TabsTrigger>
                  <TabsTrigger value="base-library" disabled={!target.base_library}>
                    {tr("skills.sync.comparison.base-library")}
                  </TabsTrigger>
                  <TabsTrigger value="base-target" disabled={!target.base_target}>
                    {tr("skills.sync.comparison.base-target")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            )}
            {comparedFiles && (
              <SkillFileBrowser
                key={`${current.token}:${targetIndex}:${comparison}`}
                files={[
                  ...new Set([
                    ...comparedFiles.added,
                    ...comparedFiles.modified,
                    ...comparedFiles.removed,
                  ]),
                ].map((path) => ({ path, size: 0, executable: false }))}
                readFile={readFile}
              />
            )}
            {current.requires_home_approval && (
              <Label className="flex items-start gap-2 rounded-lg border border-amber-500/40 p-3">
                <Checkbox
                  checked={approveHome}
                  disabled={busy}
                  onCheckedChange={(checked) => setApproveHome(Boolean(checked))}
                />
                {tr("skills.manager.approveHome")}
              </Label>
            )}
          </>
        )}
        {report && (
          <div role="status" className="grid gap-2">
            <p>
              {tr("skills.manager.resultSummary", {
                succeeded: report.results.filter((item) => item.success).length,
                total: report.results.length,
              })}
            </p>
            {report.results.map((item, index) => (
              <div key={index} className="rounded-lg border p-3">
                <p className="break-all text-xs">{item.path ?? item.library_id}</p>
                <p className={item.success ? "text-sm" : "text-sm text-destructive-text"}>
                  {item.error ?? resultLabel(item.status, tr)}
                </p>
              </div>
            ))}
            {report.warnings.map((warning) => (
              <p key={warning} className="text-sm text-amber-700">
                {warning}
              </p>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void close()}>
            {tr("common.close")}
          </Button>
          {!report && (
            <Button
              disabled={
                busy ||
                preparation.isPending ||
                !current ||
                conflicts.length > 0 ||
                (current?.requires_home_approval && !approveHome)
              }
              onClick={() => void apply()}
            >
              {tr("skills.sync.confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SkillSyncPolicyDialog({
  state,
  onClose,
  onChanged,
}: {
  state?: SkillSyncState;
  onClose(): void;
  onChanged(): Promise<unknown[]>;
}) {
  const { tr, localizeMessage } = useI18n();
  const client = useOptionalQueryClient();
  const query = useQuery(
    {
      ...queryDefaults,
      queryKey: skillKeys.policy(),
      queryFn: () => api.skillSyncPolicy(),
      staleTime: 0,
    },
    client,
  );
  const [draft, setDraft] = useState<SkillSyncPolicy>();
  const current = draft ?? query.data;
  const [approvedHomeKey, setApprovedHomeKey] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const hasPersistentHomeGrant = (id: string, owner: string, target: string) => {
    const previous = query.data?.deployments[id];
    return Boolean(
      owner &&
      target &&
      previous?.mode === "follow" &&
      previous.approve_home &&
      previous.owner_key === owner &&
      previous.target_key === target,
    );
  };
  const pendingHomeTargets = (state?.deployments ?? []).filter((item) => {
    const next = current?.deployments[item.id];
    return (
      item.scope === "personal" &&
      next?.mode === "follow" &&
      (next.owner_key !== item.owner_key ||
        next.target_key !== item.target_key ||
        !hasPersistentHomeGrant(item.id, item.owner_key, item.target_key))
    );
  });
  const needsHome = pendingHomeTargets.length > 0;
  const homeApprovalKey = JSON.stringify([
    current?.revision,
    pendingHomeTargets
      .map((item) => JSON.stringify([item.id, item.scope, item.owner_key, item.target_key]))
      .sort(),
  ]);
  const home = needsHome && approvedHomeKey === homeApprovalKey;
  const save = async () => {
    if (!current || busy || (needsHome && !home)) return;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await api.saveSkillSyncPolicy({
        policy: current,
        revision: current.revision,
        approve_home: home,
      });
      client.setQueryData(skillKeys.policy(), saved);
      setDraft(saved);
      const errors = await onChanged();
      if (errors.length) setError(errors.map(localizeMessage).join(" · "));
      else onClose();
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent showCloseButton={!busy} className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tr("skills.sync.policy")}</DialogTitle>
          <DialogDescription>{tr("skills.sync.scheduleNotice")}</DialogDescription>
        </DialogHeader>
        {(error || query.error) && (
          <p role="alert" className="text-sm text-destructive-text">
            {localizeMessage(error ?? query.error)}
          </p>
        )}
        {current ? (
          <>
            <Label className="flex items-center gap-2">
              <Checkbox
                checked={current.enabled}
                disabled={busy}
                onCheckedChange={(checked) => setDraft({ ...current, enabled: Boolean(checked) })}
              />
              {tr("skills.sync.enabled")}
            </Label>
            <Label className="grid gap-2">
              {tr("skills.sync.interval")}
              <Select
                value={String(current.interval_hours)}
                disabled={busy}
                onValueChange={(value) =>
                  value && setDraft({ ...current, interval_hours: Number(value) })
                }
              >
                <SelectTrigger aria-label={tr("skills.sync.interval")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[0, 1, 6, 24].map((hours) => (
                    <SelectItem key={hours} value={String(hours)}>
                      {hours === 0 ? tr("skills.sync.mode.manual") : `${hours} h`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
            <p className="text-xs text-muted-foreground">{tr("skills.sync.checkDefault")}</p>
            {(state?.library ?? []).map((item) => (
              <div key={item.library_id} className="grid gap-2 rounded-lg border p-3">
                <strong className="text-sm">{item.display_name}</strong>
                {item.locally_customized && (
                  <Badge variant="outline">{tr("skills.sync.customized")}</Badge>
                )}
                <Label className="grid gap-1 text-sm">
                  {tr("skills.sync.upstreamMode")}
                  <Select
                    disabled={busy || !item.source_key}
                    value={current.libraries[item.library_id]?.mode ?? current.default_mode}
                    onValueChange={(value) =>
                      value &&
                      setDraft({
                        ...current,
                        libraries: {
                          ...current.libraries,
                          [item.library_id]: {
                            mode: value as "manual" | "check" | "auto_update",
                            owner_key: item.owner_key,
                            source_key: item.source_key,
                          },
                        },
                      })
                    }
                  >
                    <SelectTrigger
                      aria-label={`${tr("skills.sync.upstreamMode")} · ${item.display_name}`}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(["manual", "check", "auto_update"] as const).map((mode) => (
                        <SelectItem
                          key={mode}
                          value={mode}
                          disabled={mode === "auto_update" && !item.can_auto_update}
                        >
                          {tr(`skills.sync.mode.${mode}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Label>
              </div>
            ))}
            {(state?.deployments ?? [])
              .filter((item) => item.status !== "inactive")
              .map((item) => (
                <div key={item.id} className="grid gap-2 rounded-lg border p-3">
                  <code className="break-all text-xs">{item.target}</code>
                  <Label className="grid gap-1 text-sm">
                    {tr("skills.sync.deploymentMode")}
                    <Select
                      disabled={busy}
                      value={current.deployments[item.id]?.mode ?? "manual"}
                      onValueChange={(value) => {
                        if (!value) return;
                        setApprovedHomeKey(undefined);
                        setDraft({
                          ...current,
                          deployments: {
                            ...current.deployments,
                            [item.id]: {
                              mode: value as "manual" | "follow" | "pinned",
                              approve_home:
                                item.scope !== "personal" ||
                                (value === "follow" &&
                                  hasPersistentHomeGrant(item.id, item.owner_key, item.target_key)),
                              owner_key: item.owner_key,
                              target_key: item.target_key,
                            },
                          },
                        });
                      }}
                    >
                      <SelectTrigger
                        aria-label={`${tr("skills.sync.deploymentMode")} · ${item.target}`}
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(["manual", "follow", "pinned"] as const).map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {tr(`skills.sync.mode.${mode}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Label>
                </div>
              ))}
            {needsHome && (
              <Label className="flex items-start gap-2 rounded-lg border border-amber-500/40 p-3">
                <Checkbox
                  checked={home}
                  disabled={busy}
                  onCheckedChange={(checked) => {
                    const accepted = Boolean(checked);
                    setApprovedHomeKey(accepted ? homeApprovalKey : undefined);
                    setDraft({
                      ...current,
                      deployments: Object.fromEntries(
                        Object.entries(current.deployments).map(([id, item]) => {
                          if (
                            item.mode !== "follow" ||
                            !state?.deployments.some(
                              (entry) => entry.id === id && entry.scope === "personal",
                            )
                          )
                            return [id, item];
                          const acceptedTarget = accepted
                            ? pendingHomeTargets.find((entry) => entry.id === id)
                            : undefined;
                          return [
                            id,
                            {
                              ...item,
                              ...(acceptedTarget
                                ? {
                                    owner_key: acceptedTarget.owner_key,
                                    target_key: acceptedTarget.target_key,
                                  }
                                : {}),
                              approve_home:
                                Boolean(acceptedTarget) ||
                                hasPersistentHomeGrant(id, item.owner_key, item.target_key),
                            },
                          ];
                        }),
                      ),
                    });
                  }}
                />
                {tr("skills.sync.homeGrant")}
              </Label>
            )}
          </>
        ) : (
          query.isPending && <LoadingSkeleton label={tr("common.loading")} />
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {tr("common.cancel")}
          </Button>
          <Button
            disabled={
              busy ||
              !current ||
              !state ||
              ![0, 1, 6, 24].includes(current.interval_hours) ||
              (needsHome && !home)
            }
            onClick={() => void save()}
          >
            {tr("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SkillSyncRunsDialog({
  onClose,
  onChanged,
}: {
  onClose(): void;
  onChanged(): Promise<unknown[]>;
}) {
  const { tr, localizeMessage, formatDateTime } = useI18n();
  const client = useOptionalQueryClient();
  const query = useQuery(
    {
      ...queryDefaults,
      queryKey: skillKeys.runs(),
      queryFn: () => api.skillSyncRuns(),
      staleTime: 0,
    },
    client,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [home, setHome] = useState(false);
  const recover = async (id: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const report = await api.recoverSkillSync(id, home);
      const errors = [
        ...report.results.filter((item) => !item.success).map((item) => item.error ?? item.status),
        ...(await onChanged()),
      ];
      await query.refetch({ throwOnError: true });
      if (errors.length) setError(errors.map(localizeMessage).join(" · "));
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent showCloseButton={!busy} className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tr("skills.sync.history")}</DialogTitle>
          <DialogDescription>{tr("skills.sync.recoveryNotice")}</DialogDescription>
        </DialogHeader>
        {(error || query.error) && (
          <p role="alert" className="text-sm text-destructive-text">
            {localizeMessage(error ?? query.error)}
          </p>
        )}
        {query.isPending && <LoadingSkeleton label={tr("common.loading")} />}
        {query.data?.runs.map((run) => (
          <div key={run.operation_id} className="grid gap-2 rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">
              {formatDateTime(run.started_at)} · {tr(`skills.sync.trigger.${run.trigger}`)}
            </p>
            {run.results.map((item, index) => (
              <p
                key={index}
                className={
                  item.success ? "break-all text-sm" : "break-all text-sm text-destructive-text"
                }
              >
                {item.path ?? item.library_id} · {item.error ?? resultLabel(item.status, tr)}
              </p>
            ))}
            {run.warnings.map((warning) => (
              <p key={warning} className="text-xs text-amber-700">
                {warning}
              </p>
            ))}
            {(!run.finished_at ||
              run.results.some((item) => item.status === "recovery-required")) && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void recover(run.operation_id)}
              >
                {tr("skills.manager.operation.recover")}
              </Button>
            )}
          </div>
        ))}
        {query.data && !query.data.runs.length && (
          <p className="text-sm text-muted-foreground">{tr("skills.sync.noRuns")}</p>
        )}
        <Label className="flex items-start gap-2">
          <Checkbox
            checked={home}
            disabled={busy}
            onCheckedChange={(checked) => setHome(Boolean(checked))}
          />
          {tr("skills.manager.approveHome")}
        </Label>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {tr("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
