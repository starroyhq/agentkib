import { McpChoice, McpDisclosure } from "@/features/mcp/McpControls";
import { SelectItem } from "@agentkib/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useRef, useState } from "react";
import type {
  McpImportPreview,
  McpImportReport,
  McpImportSelection,
  McpMigrationPreview,
} from "@agentkib/runtime-protocol";
import type { McpMigrationCandidate } from "@/core/types";
import { api } from "@/core/api";
import { isClaudeGlobalConfig } from "@/core/claude-global-config";
import { useI18n } from "@/core/useI18n";
import { Button } from "@agentkib/ui/button";
import { Input } from "@agentkib/ui/input";
import { Textarea } from "@agentkib/ui/textarea";

export function McpImportPanel({
  project,
  onSaved,
}: {
  project?: string;
  onSaved: () => Promise<void>;
}) {
  const { tr, localizeMessage } = useI18n();
  const [text, setText] = useState("");
  const [candidates, setCandidates] = useState<McpMigrationCandidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<McpImportPreview>();
  const [choices, setChoices] = useState<McpImportSelection[]>([]);
  const [report, setReport] = useState<McpImportReport>();
  const [migration, setMigration] = useState<McpMigrationPreview>();
  const [approved, setApproved] = useState(false);
  const [migrated, setMigrated] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
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
  async function scan() {
    await run(async () => {
      const result = await api.nativeMcpCandidates(project);
      if (alive.current) {
        setCandidates(result);
        setSelected([]);
        setPreview(undefined);
        setMigration(undefined);
        setApproved(false);
        setMigrated(false);
      }
    });
  }
  async function prepare(native: boolean) {
    await run(async () => {
      const result = await api.previewMcpImport({
        project,
        ...(native ? { candidateIds: selected } : { text }),
      });
      if (alive.current) {
        setPreview(result);
        setReport(undefined);
        setChoices(
          result.items.map((item) => ({
            key: item.key,
            action: item.status === "new" ? "add" : "skip",
          })),
        );
      }
    });
  }
  async function apply() {
    if (!preview) return;
    await run(async () => {
      const result = await api.applyMcpImport({
        project,
        token: preview.token,
        revision: preview.revision,
        selections: choices,
      });
      if (alive.current) {
        setReport(result);
        setPreview(undefined);
        setMigration(undefined);
        setApproved(false);
        setMigrated(false);
        setText("");
        await onSaved();
      }
    });
  }
  async function migrate() {
    if (!project || !selected.length) return;
    await run(async () => {
      const state = await api.mcpManagementState({ project });
      if (!alive.current) return;
      const plan = await api.previewMcpMigration({
        project,
        revision: state.revision,
        candidateIds: selected,
      });
      if (alive.current) {
        setMigration(plan);
        setApproved(false);
        setMigrated(false);
      }
    });
  }
  return (
    <section className="grid gap-4 rounded-xl border p-5">
      <h3>{tr("mcp.manage.import")}</h3>
      <p className="text-sm text-muted-foreground">{tr("mcp.manage.importHint")}</p>
      <label>
        {tr("mcp.manage.paste")}
        <Textarea
          aria-label={tr("mcp.manage.paste")}
          value={text}
          disabled={busy}
          className="min-h-32 font-mono"
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(undefined);
            setMigration(undefined);
            setApproved(false);
            setMigrated(false);
          }}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !text.trim()} onClick={() => void prepare(false)}>
          {tr("mcp.manage.previewPaste")}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void scan()}>
          {tr("mcp.manage.scanNative")}
        </Button>
      </div>
      {candidates.some((candidate) => candidate.agent === "claude-code") && (
        <p className="text-sm text-muted-foreground">{tr("mcp.manage.claudeScopesHint")}</p>
      )}
      {candidates.map((candidate) => (
        <label key={candidate.id} className="flex items-start gap-2">
          <Checkbox
            disabled={busy || !candidate.supported}
            checked={selected.includes(candidate.id)}
            onCheckedChange={(checked) => {
              setSelected((old) =>
                checked ? [...old, candidate.id] : old.filter((id) => id !== candidate.id),
              );
              setPreview(undefined);
              setMigration(undefined);
              setApproved(false);
              setMigrated(false);
            }}
          />
          <span>
            <strong>{candidate.name}</strong> · {candidate.agent} · {candidate.scope}
            <small className="block break-all">{candidate.source_path}</small>
            <small>
              {candidate.warnings
                .map((warning, index) =>
                  localizeMessage(candidate.warning_messages?.[index] ?? warning),
                )
                .join(" · ")}
            </small>
          </span>
        </label>
      ))}
      {!!candidates.length && (
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !selected.length} onClick={() => void prepare(true)}>
            {tr("mcp.manage.previewNative")}
          </Button>
          <Button
            variant="outline"
            disabled={busy || !selected.length || !project}
            onClick={() => void migrate()}
          >
            {tr("mcp.manage.migrate")}
          </Button>
          <small>{tr("mcp.manage.migrationHint")}</small>
        </div>
      )}
      {migration && (
        <div className="grid gap-2">
          {migration.changes.map((change) => (
            <McpDisclosure key={change.target} title={<>{change.target}</>}>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">
                {change.before}
                {"\n→\n"}
                {change.after}
              </pre>
            </McpDisclosure>
          ))}
          {migration.changes.some(isClaudeGlobalConfig) && (
            <p role="note" className="text-sm text-amber-700">
              {tr("changes.claudeGlobalConfigWarning")}
            </p>
          )}
          {migration.requires_home_approval && (
            <label>
              <Checkbox checked={approved} onCheckedChange={(checked) => setApproved(checked)} />
              {tr("mcp.manage.homeApproval")}
            </label>
          )}
          <Button
            disabled={busy || (migration.requires_home_approval && !approved)}
            onClick={() =>
              void run(async () => {
                const current = migration;
                setMigration(undefined);
                await api.applyMcpMigration({ token: current.token, approveHome: approved });
                if (alive.current) {
                  setMigrated(true);
                  await onSaved();
                }
              })
            }
          >
            {tr("mcp.manage.applyConnection")}
          </Button>
        </div>
      )}
      {migrated && <p role="status">{tr("mcp.manage.reloadHint")}</p>}
      {error && (
        <p role="alert" className="text-destructive-text">
          {error}
        </p>
      )}
      {preview && (
        <div className="grid gap-3">
          {preview.items.map((item) => {
            const choice = choices.find((value) => value.key === item.key)!;
            function change(patch: Partial<McpImportSelection>) {
              setChoices((old) =>
                old.map((value) => {
                  if (value.key !== item.key) return value;
                  const next = { ...value, ...patch };
                  if (next.action !== "add") delete next.id;
                  return next;
                }),
              );
            }
            return (
              <article key={item.key} className="grid gap-2 rounded border p-3">
                <strong>
                  {item.config?.name ?? item.key} · {tr(`mcp.manage.import_${item.status}`)}
                </strong>
                <p>
                  {item.warnings
                    .map((warning, index) =>
                      localizeMessage(item.warning_messages?.[index] ?? warning),
                    )
                    .join(" · ")}
                </p>
                {item.config && (
                  <McpDisclosure title={<>{tr("mcp.publicJson")}</>}>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">
                      {JSON.stringify(item.config, null, 2)}
                    </pre>
                  </McpDisclosure>
                )}
                <p className="text-xs">
                  {[...item.required_env, ...item.required_headers].join(", ")}
                </p>
                <div className="flex flex-wrap gap-2">
                  <McpChoice
                    aria-label={tr("mcp.manage.importAction", { name: item.key })}
                    disabled={busy || item.status === "blocked"}
                    value={choice.action}
                    onValueChange={(value) =>
                      change({ action: value as McpImportSelection["action"] })
                    }
                  >
                    <SelectItem value="skip">{tr("mcp.manage.skip")}</SelectItem>
                    {item.status !== "identical" && (
                      <SelectItem value="add">{tr("mcp.manage.addAs")}</SelectItem>
                    )}
                    <SelectItem value="replace">
                      {tr(
                        item.status === "identical"
                          ? "mcp.manage.reconfirm"
                          : "mcp.manage.replaceLocal",
                      )}
                    </SelectItem>
                  </McpChoice>
                  {choice.action === "add" && (
                    <Input
                      aria-label={`${item.key} ID`}
                      disabled={busy}
                      value={choice.id ?? item.config?.id ?? ""}
                      onChange={(e) => change({ id: e.target.value })}
                    />
                  )}
                </div>
              </article>
            );
          })}
          <Button
            disabled={busy || choices.every((choice) => choice.action === "skip")}
            onClick={() => void apply()}
          >
            {tr("mcp.manage.collect")}
          </Button>
        </div>
      )}
      {report && (
        <div role="status">
          {report.results.map((result) => (
            <p key={result.key}>
              {result.id ?? result.key} · {tr(`mcp.manage.import_${result.status}`)}{" "}
              {localizeMessage(result.error_message ?? result.error ?? "")}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
