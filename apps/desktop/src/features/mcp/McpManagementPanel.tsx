import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import type {
  ManagedMcpServer,
  McpManagedEntry,
  McpManagementState,
} from "@agentkib/runtime-protocol";
import type { WorkspaceSummary } from "@/core/types";
import { api } from "@/core/api";
import { useI18n } from "@/core/useI18n";
import { AGENT_LABELS } from "@/core/agents";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { changeMcpTargets, MCP_MANAGED_AGENTS } from "./mcp-targets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { McpChoice } from "./McpControls";
import { McpRuntimeProbe } from "./McpRuntimeProbe";
import { McpBatchConnectionPanel } from "./McpBatchConnectionPanel";
import { McpImportPanel } from "./McpImportPanel";
import { McpPolicyEditor } from "./McpPolicyEditor";
import { McpServiceEditor, newMcpDraft, type McpEditorDraft } from "./McpServiceEditor";

export const MCP_ALL_SCOPES = "__all_scopes__";
const globalChoice = "__global_scope__";
const rowKey = (project: string | undefined, id: string) => JSON.stringify([project ?? null, id]);
type LibraryEntry = McpManagedEntry & { project?: string; revision: string; key: string };
type BatchItem = { id: string; name?: string; enabled: boolean; project?: string };
type BatchResult = BatchItem & { status: "saved" | "failed" | "skipped"; error?: string };
export type McpEditorState = {
  entry?: McpManagedEntry;
  revision: string;
  draft: McpEditorDraft;
  project?: string;
};

export function McpManagementPanel({
  project,
  workspaces: suppliedWorkspaces,
  onChanged,
  drafts,
  scope,
  onScopeChange,
  onOpenIntegrations,
}: {
  project?: string;
  workspaces: WorkspaceSummary[];
  onChanged: () => Promise<void>;
  drafts: Map<string, McpEditorState>;
  scope?: string;
  onScopeChange?: (scope: string) => void;
  onOpenIntegrations?: () => void;
}) {
  const { tr, localizeMessage } = useI18n();
  // Controller records belong to another computer even when their paths match locally.
  const workspaces = suppliedWorkspaces.filter((workspace) => !workspace.remote);
  const searchInput = useRef<HTMLInputElement>(null);
  const rowTriggers = useRef(new Map<string, HTMLElement>());
  const targetReturn = useRef<HTMLElement | null>(null);
  const dialogs = useAppDialogs();
  const catalog = scope !== undefined;
  const allScopes = scope === MCP_ALL_SCOPES;
  const projects = catalog
    ? [undefined, ...new Set(workspaces.map((item) => item.path))]
    : [project];
  const queries = useQueries({
    queries: projects.map((sourceProject) => ({
      queryKey: ["mcp", "management", sourceProject],
      queryFn: () => api.mcpManagementState({ project: sourceProject }),
      staleTime: 0,
    })),
  });
  const snapshot = (sourceProject?: string) => queries[projects.indexOf(sourceProject)]?.data;
  const scopeName = (sourceProject?: string) =>
    sourceProject
      ? tr("mcp.manage.projectScope", {
          name: workspaces.find((item) => item.path === sourceProject)?.name ?? sourceProject,
        })
      : tr("mcp.globalScope");
  const [search, setSearch] = useState("");
  const [agentFilter, setAgentFilter] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  const draftKey = allScopes ? MCP_ALL_SCOPES : (project ?? "global");
  const [editor, setEditor] = useState<McpEditorState | undefined>(() => drafts.get(draftKey));
  const [open, setOpen] = useState<"add" | "import" | "connect" | undefined>();
  // Undefined means the user has not selected a destination; null is explicitly global.
  const [writeTarget, setWriteTarget] = useState<string | null | undefined>(
    allScopes ? undefined : (project ?? null),
  );
  const [policy, setPolicy] = useState<{ id: string | null; project?: string }>();
  const [targetKey, setTargetKey] = useState<string>();
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  useEffect(() => {
    if (editor) drafts.set(draftKey, editor);
    else drafts.delete(draftKey);
  }, [editor, drafts, draftKey]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<BatchResult[]>([]);
  const alive = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const rows: LibraryEntry[] = projects.flatMap((sourceProject, index) => {
    if (!allScopes && sourceProject !== project) return [];
    const state = queries[index].data;
    return (state?.servers ?? [])
      .filter(
        (entry) =>
          !allScopes || !sourceProject || (!entry.inherited && entry.scope === "workspace"),
      )
      .map((entry) => ({
        ...entry,
        project: sourceProject,
        revision: state!.revision,
        key: rowKey(sourceProject, entry.config.id),
      }));
  });
  const visible = rows.filter(
    (entry) =>
      JSON.stringify(entry.config).toLowerCase().includes(search.toLowerCase()) &&
      (agentFilter === "all" ||
        !entry.config.targets.length ||
        entry.config.targets.includes(agentFilter as (typeof MCP_MANAGED_AGENTS)[number])),
  );
  const targetEntry = rows.find((entry) => entry.key === targetKey);
  const failedQueries = queries.flatMap((query, index) =>
    query.error ? [{ query, project: projects[index] }] : [],
  );
  const currentQuery = queries[projects.indexOf(project)];
  const reading = allScopes ? queries.some((query) => query.isPending) : currentQuery?.isPending;
  const knownScope = allScopes
    ? queries.every((query) => Boolean(query.data))
    : Boolean(currentQuery?.data);
  const filtered = Boolean(rows.length && (search || agentFilter !== "all"));
  const empty = knownScope && !reading && !rows.length;
  const others = projects.flatMap((sourceProject, index) => {
    if (sourceProject === project) return [];
    const count = (queries[index].data?.servers ?? []).filter(
      (entry) => !sourceProject || (!entry.inherited && entry.scope === "workspace"),
    ).length;
    return count ? [{ project: sourceProject, count }] : [];
  });
  const operationProject = writeTarget ?? undefined;
  const operationState = writeTarget !== undefined ? snapshot(operationProject) : undefined;
  useEffect(() => {
    if (open !== "add" || writeTarget === undefined || !operationState) return;
    setEditor({
      revision: operationState.revision,
      draft: newMcpDraft(),
      project: operationProject,
    });
    setOpen(undefined);
  }, [open, writeTarget, operationState, operationProject]);
  async function refresh() {
    await Promise.all(queries.map((query) => query.refetch()));
    if (alive.current) setCatalogEpoch((value) => value + 1);
    await onChanged();
  }
  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      if (alive.current) setError(localizeMessage(reason));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function save(entry: LibraryEntry, patch: Partial<ManagedMcpServer>) {
    await run(async () => {
      await api.saveMcpConfiguration({
        project: entry.project,
        revision: entry.revision,
        originalId: entry.config.id,
        server: { ...entry.config, ...patch } as ManagedMcpServer,
      });
      if (alive.current) await refresh();
    });
  }
  async function batch(requested: BatchItem[]) {
    const items = requested.map(({ id, name, enabled, project: sourceProject }) => ({
      id,
      name,
      enabled,
      project: sourceProject,
    }));
    await run(async () => {
      const report: BatchResult[] = [];
      const states = new Map<string | undefined, McpManagementState>();
      for (let index = 0; index < items.length; index++) {
        if (!alive.current) break;
        const item = items[index];
        let latest = states.get(item.project);
        try {
          latest ??= await api.mcpManagementState({ project: item.project });
        } catch (reason) {
          report.push(
            ...items.slice(index).map((next) => ({
              ...next,
              status: "failed" as const,
              error: localizeMessage(reason),
            })),
          );
          if (alive.current) setResults(report);
          throw reason;
        }
        if (!alive.current) break;
        states.set(item.project, latest);
        const entry = latest.servers.find((value) => value.config.id === item.id);
        if (!entry || entry.inherited) {
          report.push({ ...item, status: "skipped" });
          setResults([...report]);
          continue;
        }
        try {
          states.set(
            item.project,
            await api.saveMcpConfiguration({
              project: item.project,
              revision: latest.revision,
              originalId: item.id,
              server: { ...entry.config, enabled: item.enabled },
            }),
          );
          report.push({ ...item, status: "saved" });
        } catch (reason) {
          report.push({ ...item, status: "failed", error: localizeMessage(reason) });
          try {
            states.set(item.project, await api.mcpManagementState({ project: item.project }));
          } catch (refreshError) {
            report.push(
              ...items.slice(index + 1).map((next) => ({
                ...next,
                status: "failed" as const,
                error: tr("mcp.manage.notAttempted"),
              })),
            );
            if (alive.current) setResults([...report]);
            throw refreshError;
          }
        }
        if (alive.current) setResults([...report]);
      }
      if (alive.current) await refresh();
    });
  }
  function target(
    entry: LibraryEntry,
    agent: (typeof MCP_MANAGED_AGENTS)[number],
    checked: boolean,
  ) {
    const next = changeMcpTargets(entry.config.targets, agent, checked);
    if (!next) {
      setError(tr("mcp.manage.lastTarget"));
      return;
    }
    void save(entry, { targets: next });
  }
  function begin(kind: "add" | "import") {
    setPolicy(undefined);
    setWriteTarget(allScopes ? undefined : (project ?? null));
    if (kind === "add" && !allScopes && snapshot(project)) {
      setEditor({ revision: snapshot(project)!.revision, draft: newMcpDraft(), project });
      setOpen(undefined);
    } else setOpen(open === kind ? undefined : kind);
  }
  function chooseDestination(value: string) {
    const nextProject = value === globalChoice ? undefined : value;
    setWriteTarget(nextProject ?? null);
    if (open === "add" && snapshot(nextProject)) {
      setEditor({
        revision: snapshot(nextProject)!.revision,
        draft: newMcpDraft(),
        project: nextProject,
      });
      setOpen(undefined);
    }
    if (policy?.id === null) setPolicy({ id: null, project: nextProject });
  }
  const scopeItems = [
    <SelectItem key="global" value={globalChoice}>
      {tr("mcp.globalScope")}
    </SelectItem>,
    ...workspaces.map((workspace) => (
      <SelectItem key={workspace.id} value={workspace.path}>
        {workspace.name}
      </SelectItem>
    )),
  ];
  const addButton = (
    <Button disabled={busy || !!editor || (!catalog && !knownScope)} onClick={() => begin("add")}>
      {tr("mcp.manage.add")}
    </Button>
  );
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={searchInput}
          className="min-w-48 flex-1"
          aria-label={tr("mcp.manage.search")}
          placeholder={tr("mcp.manage.search")}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setSelected([]);
          }}
        />
        {catalog && (
          <McpChoice
            value={scope === "" ? globalChoice : scope!}
            aria-label={tr("mcp.scope")}
            onValueChange={(value) => onScopeChange?.(value === globalChoice ? "" : value)}
          >
            <SelectItem value={MCP_ALL_SCOPES}>{tr("mcp.manage.allScopes")}</SelectItem>
            {scopeItems}
          </McpChoice>
        )}
        <McpChoice
          value={agentFilter}
          aria-label={tr("mcp.manage.agentFilter")}
          onValueChange={(value) => {
            setAgentFilter(value);
            setSelected([]);
          }}
        >
          <SelectItem value="all">{tr("mcp.manage.allAgents")}</SelectItem>
          {MCP_MANAGED_AGENTS.map((agent) => (
            <SelectItem value={agent} key={agent}>
              {AGENT_LABELS[agent]}
            </SelectItem>
          ))}
        </McpChoice>
        {!empty && addButton}
        <Button variant="outline" onClick={() => begin("import")}>
          {tr("mcp.manage.import")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" />}>
            <MoreHorizontal size={16} />
            {tr("mcp.manage.more")}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => {
                setOpen(open === "connect" ? undefined : "connect");
                setPolicy(undefined);
              }}
            >
              {tr("mcp.manage.connect")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setPolicy(policy?.id === null ? undefined : { id: null, project });
                setWriteTarget(allScopes ? undefined : (project ?? null));
                setOpen(undefined);
              }}
            >
              {tr("mcp.manage.builtins")}
            </DropdownMenuItem>
            {onOpenIntegrations && (
              <DropdownMenuItem onClick={onOpenIntegrations}>
                {tr("mcp.openIntegrationSettings")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error && !targetEntry && (
        <p role="alert" className="text-destructive-text">
          {error}
        </p>
      )}
      {failedQueries.map(({ query, project: sourceProject }) => (
        <div
          role="alert"
          key={sourceProject ?? globalChoice}
          className="grid justify-items-start gap-2 text-destructive-text"
        >
          <p>{tr("mcp.manage.scopeReadFailed", { scope: scopeName(sourceProject) })}</p>
          <p>{localizeMessage(query.error)}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            {tr("common.retry")}
          </Button>
        </div>
      ))}
      {(open === "add" || open === "import" || policy?.id === null) &&
        writeTarget === undefined && (
          <div className="grid justify-items-start gap-2 rounded-xl border p-4">
            <McpChoice
              value="__choose_scope__"
              aria-label={tr("mcp.manage.targetScope")}
              onValueChange={chooseDestination}
            >
              <SelectItem value="__choose_scope__" disabled>
                {tr("mcp.manage.chooseScope")}
              </SelectItem>
              {scopeItems}
            </McpChoice>
            <Button
              variant="outline"
              onClick={() => {
                setOpen(undefined);
                setPolicy(undefined);
              }}
            >
              {tr("common.cancel")}
            </Button>
          </div>
        )}
      {open === "add" && writeTarget !== undefined && !operationState && (
        <div className="grid justify-items-start gap-2 rounded-xl border p-4">
          {reading && <p role="status">{tr("common.loading")}</p>}
          <Button variant="outline" onClick={() => setOpen(undefined)}>
            {tr("common.cancel")}
          </Button>
        </div>
      )}
      {open === "connect" && (
        <McpBatchConnectionPanel
          workspaces={workspaces}
          project={project}
          servicesRevision={JSON.stringify([
            projects.map((p) => [p, snapshot(p)?.revision]),
            catalogEpoch,
          ])}
        />
      )}
      {open === "import" && writeTarget !== undefined && (
        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">
            {tr("mcp.scope")}: {scopeName(operationProject)}
          </p>
          <McpImportPanel
            key={operationProject ?? globalChoice}
            project={operationProject}
            onSaved={refresh}
          />
        </div>
      )}
      {editor && (
        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">
            {tr("mcp.scope")}: {scopeName(editor.project ?? project)}
          </p>
          <McpServiceEditor
            key={`${editor.project ?? project ?? globalChoice}:${editor.entry?.config.id ?? "new"}:${editor.revision}`}
            project={editor.project ?? project}
            revision={editor.revision}
            entry={editor.entry}
            draft={editor.draft}
            onDraft={(draft) => setEditor((old) => (old ? { ...old, draft } : old))}
            onCancel={() => setEditor(undefined)}
            onSaved={async () => {
              setEditor(undefined);
              await refresh();
            }}
          />
        </div>
      )}
      {policy?.id === null && writeTarget !== undefined && operationState && (
        <McpPolicyEditor
          project={operationProject}
          serverId={null}
          revision={`${operationState.revision}:${catalogEpoch}`}
          onSaved={refresh}
        />
      )}
      {!!selected.length && (
        <div className="flex gap-2">
          {[true, false].map((enabled) => (
            <Button
              key={String(enabled)}
              disabled={busy}
              variant="outline"
              onClick={() =>
                void batch(
                  visible
                    .filter((entry) => selected.includes(entry.key))
                    .map((entry) => ({
                      id: entry.config.id,
                      name: entry.config.name,
                      enabled,
                      project: entry.project,
                    })),
                )
              }
            >
              {tr(enabled ? "mcp.manage.enableSelected" : "mcp.manage.disableSelected")}
            </Button>
          ))}
        </div>
      )}
      {!!results.length && (
        <div role="status">
          {results.map((result) => (
            <p key={rowKey(result.project, result.id)}>
              {result.name && result.name !== result.id
                ? `${result.name} (${result.id})`
                : result.id}{" "}
              · {tr(`mcp.manage.import_${result.status}`)} {result.error}
            </p>
          ))}
          {results.some((result) => result.status === "failed") && (
            <Button
              disabled={busy}
              onClick={() => void batch(results.filter((result) => result.status === "failed"))}
            >
              {tr("mcp.manage.retryFailed")}
            </Button>
          )}
        </div>
      )}
      {!!visible.length && (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="w-10 p-3">
                  <Checkbox
                    aria-label={tr("mcp.manage.selectVisible")}
                    checked={
                      visible.length > 0 && visible.every((entry) => selected.includes(entry.key))
                    }
                    onCheckedChange={(checked) =>
                      setSelected(checked ? visible.map((entry) => entry.key) : [])
                    }
                  />
                </th>
                <th className="p-3 text-left">{tr("mcp.manage.services")}</th>
                <th className="p-3 text-right">
                  <span className="text-xs text-muted-foreground">
                    {tr("mcp.manage.serviceCount", { count: visible.length })}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => (
                <tr key={entry.key} className="border-t">
                  <td className="p-3">
                    <Checkbox
                      aria-label={tr("mcp.manage.selectService", {
                        name: entry.config.name || entry.config.id,
                      })}
                      checked={selected.includes(entry.key)}
                      onCheckedChange={(checked) =>
                        setSelected((old) =>
                          checked ? [...old, entry.key] : old.filter((key) => key !== entry.key),
                        )
                      }
                    />
                  </td>
                  <td className="min-w-0 p-3">
                    <strong>{entry.config.name}</strong>
                    <code
                      className="mt-1 block max-w-[min(40vw,36rem)] truncate text-xs text-muted-foreground"
                      title={
                        entry.config.transport === "stdio"
                          ? [entry.config.command, ...entry.config.args].join(" ")
                          : entry.config.url
                      }
                    >
                      {entry.config.transport === "stdio"
                        ? [entry.config.command, ...entry.config.args].join(" ")
                        : entry.config.url}
                    </code>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">
                        {entry.inherited ? tr("mcp.manage.inherited") : scopeName(entry.project)}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {tr("mcp.manage.enabledFor")}
                      </span>
                      {MCP_MANAGED_AGENTS.filter(
                        (agent) =>
                          !entry.config.targets.length || entry.config.targets.includes(agent),
                      ).map((agent) => (
                        <span
                          className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs"
                          key={agent}
                        >
                          <AgentIcon agent={agent} compact />
                          {AGENT_LABELS[agent]}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="p-3">
                    <div
                      className="flex items-center justify-end gap-3"
                      onFocus={(event) => {
                        if (event.currentTarget.contains(event.target))
                          event.target.scrollIntoView({ block: "nearest", inline: "nearest" });
                      }}
                    >
                      {entry.config.enabled && (
                        <McpRuntimeProbe
                          key={JSON.stringify([entry.project, entry.config, entry.revision])}
                          serverId={entry.config.id}
                          project={entry.project}
                          onProbed={refresh}
                        />
                      )}
                      <Switch
                        aria-label={`${entry.config.name} ${tr("mcp.manage.enabled")}`}
                        disabled={busy || entry.inherited}
                        checked={entry.config.enabled}
                        onCheckedChange={(checked) => void save(entry, { enabled: checked })}
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={<Button variant="outline" size="icon" />}
                          ref={(element) => {
                            if (element) rowTriggers.current.set(entry.key, element);
                            else rowTriggers.current.delete(entry.key);
                          }}
                          aria-label={tr("mcp.manage.moreActions", { name: entry.config.name })}
                          title={tr("mcp.manage.moreActions", { name: entry.config.name })}
                        >
                          <MoreHorizontal size={16} aria-hidden="true" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-52">
                          <DropdownMenuItem
                            disabled={busy || entry.inherited}
                            onClick={() => {
                              setError("");
                              targetReturn.current = rowTriggers.current.get(entry.key) ?? null;
                              setTargetKey(entry.key);
                            }}
                          >
                            {tr("mcp.manage.chooseAgents")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={busy || !!editor}
                            onClick={() => {
                              setEditor({
                                entry,
                                revision: entry.revision,
                                draft: newMcpDraft(entry),
                                project: entry.project,
                              });
                              setOpen(undefined);
                            }}
                          >
                            {tr(entry.inherited ? "mcp.manage.createOverride" : "mcp.manage.edit")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              void navigator.clipboard
                                .writeText(JSON.stringify(entry.config, null, 2))
                                .catch((reason) => {
                                  if (alive.current) setError(localizeMessage(reason));
                                })
                            }
                          >
                            {tr("mcp.manage.copy")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              setPolicy(
                                policy?.id === entry.config.id && policy.project === entry.project
                                  ? undefined
                                  : { id: entry.config.id, project: entry.project },
                              )
                            }
                          >
                            {tr("mcp.manage.toolPolicy")}
                          </DropdownMenuItem>
                          {entry.config.transport === "streamable-http" && (
                            <DropdownMenuItem
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  const response = await api.startMcpOAuth(
                                    entry.config.id,
                                    entry.project,
                                  );
                                  if (alive.current)
                                    await api.openExternal(response.authorization_url);
                                })
                              }
                            >
                              {tr("mcp.authorize")}
                            </DropdownMenuItem>
                          )}
                          {!entry.inherited && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                disabled={busy}
                                onClick={() =>
                                  void run(async () => {
                                    if (
                                      !(await dialogs.confirm({
                                        title: tr("mcp.manage.removeNamedTitle", {
                                          name: entry.config.name,
                                        }),
                                        description: tr("mcp.manage.removeConfirm", {
                                          name: entry.config.name,
                                        }),
                                        tone: "destructive",
                                      }))
                                    )
                                      return;
                                    if (!alive.current) return;
                                    await api.removeMcpConfiguration({
                                      project: entry.project,
                                      revision: entry.revision,
                                      id: entry.config.id,
                                    });
                                    if (alive.current) await refresh();
                                  })
                                }
                              >
                                {tr(entry.project ? "mcp.manage.removeOverride" : "common.remove")}
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {policy?.id === entry.config.id && policy.project === entry.project && (
                      <McpPolicyEditor
                        key={entry.key}
                        project={entry.project}
                        serverId={entry.config.id}
                        revision={`${entry.revision}:${catalogEpoch}`}
                        onSaved={refresh}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!visible.length &&
        (reading ? (
          <p role="status" className="p-5">
            {tr("common.loading")}
          </p>
        ) : knownScope ? (
          <div className="grid justify-items-center gap-3 rounded-xl border bg-card p-8 text-center">
            <h3>
              {filtered
                ? tr("mcp.manage.searchEmpty", { query: search })
                : allScopes
                  ? tr("mcp.manage.catalogEmpty")
                  : tr("mcp.manage.scopeEmpty", { scope: scopeName(project) })}
            </h3>
            {!allScopes &&
              !filtered &&
              others.map((other) => (
                <p className="text-sm text-muted-foreground" key={other.project ?? globalChoice}>
                  {tr("mcp.manage.otherScopeCount", {
                    scope: scopeName(other.project),
                    count: other.count,
                  })}
                </p>
              ))}
            <div className="flex gap-2">
              {filtered ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearch("");
                    setAgentFilter("all");
                    setSelected([]);
                  }}
                >
                  {tr("mcp.manage.clearFilters")}
                </Button>
              ) : catalog && !allScopes ? (
                <Button variant="outline" onClick={() => onScopeChange?.(MCP_ALL_SCOPES)}>
                  {tr("mcp.manage.viewAllScopes")}
                </Button>
              ) : null}
              {empty && addButton}
            </div>
          </div>
        ) : null)}
      <Dialog
        open={Boolean(targetEntry)}
        onOpenChange={(next) => {
          if (!next) setTargetKey(undefined);
        }}
      >
        <DialogContent
          finalFocus={() =>
            targetReturn.current?.isConnected ? targetReturn.current : searchInput.current
          }
        >
          <DialogHeader>
            <DialogTitle>
              {tr("mcp.manage.chooseAgents")} · {targetEntry?.config.name}
            </DialogTitle>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-destructive-text">
              {error}
            </p>
          )}
          {targetEntry &&
            MCP_MANAGED_AGENTS.map((agent) => (
              <label key={agent} className="flex min-h-9 items-center gap-2">
                <Checkbox
                  aria-label={`${targetEntry.config.name} ${AGENT_LABELS[agent]}`}
                  disabled={busy || targetEntry.inherited}
                  checked={
                    !targetEntry.config.targets.length || targetEntry.config.targets.includes(agent)
                  }
                  onCheckedChange={(checked) => target(targetEntry, agent, checked)}
                />
                <AgentIcon agent={agent} compact />
                {AGENT_LABELS[agent]}
              </label>
            ))}
          <Button variant="outline" onClick={() => setTargetKey(undefined)}>
            {tr("common.close")}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
