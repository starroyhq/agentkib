import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
  InstalledSkill,
  SkillDeployment,
  SkillImportBatchPreview,
  SkillImportResult,
  SkillInventory,
  SkillObservation,
} from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { sessionAgentNames } from "@/features/sessions/session-labels";
import { SkillFileBrowser } from "./SkillFileBrowser";
import {
  groupSkillObservations,
  observationMatchesDeployment,
  readableSkillFile,
} from "./SkillManagerPanels";

function canRead(observation: SkillObservation) {
  return (
    Boolean(observation.resolved_path) &&
    !["broken-link", "link-loop", "invalid"].includes(observation.status)
  );
}

function ImportItemIdentity({ libraryId, paths }: { libraryId?: string | null; paths: string[] }) {
  const { tr } = useI18n();
  return (
    <>
      {libraryId && <p className="text-xs">{tr("skills.imports.libraryId", { id: libraryId })}</p>}
      {paths.map((path) => (
        <code key={path} className="break-all text-xs">
          {path}
        </code>
      ))}
    </>
  );
}

function BatchFiles({
  token,
  item,
}: {
  token: string;
  item: SkillImportBatchPreview["items"][number];
}) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(false);
  const readFile = useCallback(
    async (path: string) =>
      readableSkillFile(await api.readSkillPreviewFile(token, path, undefined, item.id)),
    [token, item.id],
  );
  return item.preview ? (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="cursor-pointer text-sm">
        {tr("skills.imports.files")}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {open && (
          <div className="mt-3">
            <SkillFileBrowser files={item.preview.files} readFile={readFile} />
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  ) : null;
}

export function SkillImportDialog({
  inventory,
  deployments,
  onClose,
  onImported,
}: {
  inventory: SkillInventory;
  deployments: SkillDeployment[];
  onClose: () => void;
  onImported: (skills: InstalledSkill[], warnings: string[]) => Promise<unknown[]>;
}) {
  const { tr, localizeMessage, formatDateTime } = useI18n();
  const groups = useMemo(
    () =>
      groupSkillObservations(
        inventory.observations.filter(
          (observation) =>
            observation.owner !== "agentkib" &&
            !deployments.some(
              (deployment) =>
                deployment.status !== "inactive" &&
                observationMatchesDeployment(observation, deployment),
            ),
        ),
      ),
    [inventory.observations, deployments],
  );
  const [selected, setSelected] = useState(
    () =>
      new Set(
        groups.filter((group) => group.observations.some(canRead)).map((group) => group.path),
      ),
  );
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState("all");
  const [scope, setScope] = useState("all");
  const [batch, setBatch] = useState<SkillImportBatchPreview>();
  const [phase, setPhase] = useState<"select" | "preview" | "result">("select");
  const [results, setResults] = useState<
    Array<SkillImportResult & { display_name: string; paths: string[] }>
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const mounted = useRef(true);
  const activeToken = useRef<string | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const token = activeToken.current;
      if (token) void api.discardSkillPreview(token).catch(() => undefined);
    };
  }, []);
  const agents = [
    ...new Set(
      groups.flatMap((group) => group.observations.flatMap((observation) => observation.agents)),
    ),
  ];
  const filtered = groups.filter((group) =>
    group.observations.some(
      (observation) =>
        (agent === "all" ||
          observation.agents.includes(agent as (typeof observation.agents)[number])) &&
        (scope === "all" || observation.scope === scope) &&
        `${observation.name} ${observation.path} ${group.path}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    ),
  );
  const visibleSelectable = filtered.filter((group) => group.observations.some(canRead));
  const allSelected =
    visibleSelectable.length > 0 && visibleSelectable.every((group) => selected.has(group.path));
  const selectedIds = groups
    .filter((group) => selected.has(group.path))
    .flatMap((group) => group.observations.filter(canRead).map((observation) => observation.id));
  const prepare = async (ids: string[]) => {
    if (busy || !ids.length) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.prepareSkillImports(ids);
      if (!mounted.current) {
        await api.discardSkillPreview(next.token);
        return;
      }
      const previousToken = activeToken.current;
      activeToken.current = next.token;
      setBatch(next);
      setPhase("preview");
      setResults((items) => items.filter((item) => item.status !== "failed"));
      if (previousToken) {
        try {
          await api.discardSkillPreview(previousToken);
        } catch (cleanupError) {
          setWarnings((items) => [...items, localizeMessage(cleanupError)]);
        }
      }
    } catch (nextError) {
      if (mounted.current) setError(nextError);
    }
    if (mounted.current) setBusy(false);
  };
  const apply = async () => {
    if (!batch || busy) return;
    setBusy(true);
    setError(undefined);
    let report: Awaited<ReturnType<typeof api.applySkillImports>>;
    try {
      report = await api.applySkillImports(batch.token);
    } catch (nextError) {
      if (mounted.current) {
        setError(nextError);
        setBusy(false);
      }
      return;
    }
    const nextResults = report.items.map((item) => {
      const prepared = batch.items.find((preview) => preview.id === item.id);
      return {
        ...item,
        display_name: prepared?.display_name ?? item.library_id ?? item.id,
        paths: [
          ...new Set([
            ...(prepared?.paths ?? []),
            ...(prepared?.resolved_path ? [prepared.resolved_path] : []),
          ]),
        ],
      };
    });
    if (mounted.current) {
      setResults((items) => [...items, ...nextResults]);
      setPhase("result");
    }
    const imported = report.items.flatMap((item) =>
      item.status === "imported" && item.skill ? [item.skill] : [],
    );
    const operationWarnings = [
      ...(report.warnings ?? []),
      ...report.items.flatMap((item) => item.warnings ?? []),
    ];
    let refreshErrors: unknown[] = [];
    if (report.items.some((item) => item.status === "imported")) {
      try {
        refreshErrors = await onImported(imported, operationWarnings);
      } catch (refreshError) {
        refreshErrors = [refreshError];
      }
    }
    if (mounted.current) {
      setWarnings((items) => [
        ...items,
        ...operationWarnings,
        ...refreshErrors.map(localizeMessage),
      ]);
      setBusy(false);
    }
  };
  const close = async () => {
    if (busy) return;
    const token = activeToken.current;
    if (token) {
      setBusy(true);
      try {
        await api.discardSkillPreview(token);
        activeToken.current = undefined;
      } catch (nextError) {
        setError(nextError);
        setBusy(false);
        return;
      }
    }
    onClose();
  };
  const failedIds =
    phase === "result"
      ? results.filter((item) => item.status === "failed").flatMap((item) => item.observation_ids)
      : (batch?.items
          .filter((item) => item.status === "failed")
          .flatMap((item) => item.observation_ids) ?? []);
  const allSkipped =
    phase === "preview" &&
    Boolean(batch?.items.length) &&
    batch!.items.every((item) => item.status === "skipped");
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && void close()}>
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[85vh] w-[min(900px,calc(100vw-2rem))] !max-w-none overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{tr("skills.imports.title")}</DialogTitle>
          <DialogDescription>{tr("skills.imports.description")}</DialogDescription>
        </DialogHeader>
        {error !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {localizeMessage(error)}
          </p>
        )}
        {warnings.map((warning, index) => (
          <p key={`${index}:${warning}`} role="status" className="text-sm text-amber-700">
            {warning}
          </p>
        ))}
        {phase === "select" ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Input
                className="min-w-40 flex-1"
                aria-label={tr("skills.search")}
                placeholder={tr("skills.search")}
                disabled={busy}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Select
                value={agent}
                onValueChange={(value) => value && setAgent(value)}
                disabled={busy}
              >
                <SelectTrigger aria-label={tr("skills.imports.agent")} className="w-40">
                  <SelectValue>
                    {agent === "all"
                      ? tr("skills.imports.allAgents")
                      : sessionAgentNames[agent as keyof typeof sessionAgentNames]}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>{tr("skills.imports.agent")}</SelectLabel>
                    <SelectItem value="all">{tr("skills.imports.allAgents")}</SelectItem>
                    {agents.map((entry) => (
                      <SelectItem key={entry} value={entry}>
                        {sessionAgentNames[entry]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Select
                value={scope}
                onValueChange={(value) => value && setScope(value)}
                disabled={busy}
              >
                <SelectTrigger aria-label={tr("skills.manager.scope")} className="w-36">
                  <SelectValue>
                    {tr(
                      scope === "all"
                        ? "skills.manager.allLocations"
                        : scope === "personal"
                          ? "skills.manager.personal"
                          : "skills.manager.project",
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>{tr("skills.manager.scope")}</SelectLabel>
                    <SelectItem value="all">{tr("skills.manager.allLocations")}</SelectItem>
                    <SelectItem value="personal">{tr("skills.manager.personal")}</SelectItem>
                    <SelectItem value="workspace">{tr("skills.manager.project")}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !visibleSelectable.length}
                onClick={() =>
                  setSelected((current) => {
                    const next = new Set(current);
                    for (const group of visibleSelectable) {
                      if (allSelected) next.delete(group.path);
                      else next.add(group.path);
                    }
                    return next;
                  })
                }
              >
                {tr(
                  allSelected ? "skills.imports.deselectVisible" : "skills.imports.selectVisible",
                )}
              </Button>
              <span className="text-sm">
                {tr("skills.imports.selected", {
                  count: groups.filter((group) => selected.has(group.path)).length,
                })}
              </span>
            </div>
            {!filtered.length && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {tr("skills.imports.empty")}
              </p>
            )}
            {filtered.map((group) => (
              <div key={group.path} className="grid gap-2 rounded-lg border p-3">
                <label className="flex items-center gap-2 font-medium">
                  <Checkbox
                    checked={selected.has(group.path)}
                    disabled={busy || !group.observations.some(canRead)}
                    onCheckedChange={(checked) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (checked) next.add(group.path);
                        else next.delete(group.path);
                        return next;
                      })
                    }
                  />
                  {group.observations[0].name}
                </label>
                <code className="break-all text-xs">{group.path}</code>
                {group.observations.map((observation) => (
                  <div
                    key={observation.id}
                    className="grid gap-1 border-l pl-3 text-xs text-muted-foreground"
                  >
                    <code className="break-all">{observation.path}</code>
                    <p>
                      {observation.agents.map((entry) => sessionAgentNames[entry]).join(" · ")} ·{" "}
                      {tr(
                        observation.scope === "personal"
                          ? "skills.manager.personal"
                          : "skills.manager.project",
                      )}{" "}
                      · {tr(`skills.manager.status.${observation.status}`)}
                    </p>
                    {observation.diagnostics.map((diagnostic) => (
                      <p key={diagnostic}>{diagnostic}</p>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </>
        ) : phase === "preview" && batch ? (
          <>
            {allSkipped && (
              <p role="status" className="text-sm">
                {tr("skills.imports.allSkipped")}
              </p>
            )}
            <p className="text-sm">
              {tr("skills.imports.previewSummary", {
                count: batch.items.filter((item) => item.status === "ready").length,
                size: (batch.total_size / 1024).toFixed(1),
              })}
            </p>
            {results.map((item) => (
              <div key={item.id} className="grid gap-1 rounded-lg border p-3 text-sm">
                <p>
                  {item.display_name} · {tr(`skills.imports.status.${item.status}`)}
                </p>
                <ImportItemIdentity libraryId={item.library_id} paths={item.paths} />
              </div>
            ))}
            {batch.items.map((item) => (
              <div key={item.id} className="grid gap-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{item.display_name}</strong>
                  <Badge variant="outline">{tr(`skills.imports.status.${item.status}`)}</Badge>
                </div>
                <ImportItemIdentity libraryId={item.library_id} paths={item.paths} />
                {item.reason && <p className="text-sm text-muted-foreground">{item.reason}</p>}
                {item.preview && (
                  <BatchFiles key={`${batch.token}:${item.id}`} token={batch.token} item={item} />
                )}
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              {tr("skills.noExecutionNotice", { time: formatDateTime(batch.expires_at) })}
            </p>
          </>
        ) : (
          <div className="grid gap-2" role="status">
            <p className="font-medium">{tr("skills.imports.results")}</p>
            {results.map((item) => (
              <div key={item.id} className="grid gap-1 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{item.display_name}</strong>
                  <Badge variant="outline">{tr(`skills.imports.status.${item.status}`)}</Badge>
                </div>
                <ImportItemIdentity libraryId={item.library_id} paths={item.paths} />
                {item.error && <p className="text-destructive">{item.error}</p>}
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void close()}>
            {tr(phase === "result" || allSkipped ? "common.close" : "common.cancel")}
          </Button>
          {phase === "select" ? (
            <Button
              disabled={busy || !selectedIds.length}
              onClick={() => void prepare(selectedIds)}
            >
              {busy && <LoaderCircle size={15} className="animate-spin" />}
              {tr("skills.imports.review")}
            </Button>
          ) : phase === "preview" && batch?.items.some((item) => item.status === "ready") ? (
            <Button disabled={busy} onClick={() => void apply()}>
              {busy && <LoaderCircle size={15} className="animate-spin" />}
              {tr("skills.imports.apply")}
            </Button>
          ) : failedIds.length > 0 ? (
            <Button disabled={busy} onClick={() => void prepare([...new Set(failedIds)])}>
              {busy && <LoaderCircle size={15} className="animate-spin" />}
              {tr("skills.imports.retryFailed")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
