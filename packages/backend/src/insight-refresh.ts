import { randomUUID, createHmac } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { Commands } from "./commands";
import { Git } from "./git";
import { checkpointRows, collectCodexUsage, parseCodexState } from "./usage-codex";
import { collectUsage, type UsageBatch, type UsageEvent } from "./usage-providers";
import { Sql } from "./sql";
import { canonicalize, pathIdentity } from "./paths";

type Workspace = { id: string; canonical_path: string; repository_group_id: string | null };
type GitCommit = { hash: string; authored_at: string; email: string };
type GitRepository = {
  group: string;
  path: string;
  fingerprint: string;
  changed: boolean;
  commits: GitCommit[];
  identities: Array<{ email: string; label: string; source: string }>;
  error: string | null;
};
const utcNow = () => new Date().toISOString();
const hmac = (salt: string, value: string) =>
  createHmac("sha256", salt).update(value).digest("hex");
const positive = (value: unknown) => Math.max(0, Number(value ?? 0));
const coded = (error: unknown) => (error instanceof Error ? error.message : String(error));
const asUsage = (value: UsageEvent) =>
  value as UsageEvent & { source_id?: string; workspace_id?: string | null };

async function insightSalt(sql: Sql): Promise<string> {
  const prior = sql.one("SELECT value FROM schema_meta WHERE key='insights_salt'");
  if (typeof prior?.value === "string") return prior.value;
  const generated = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  sql.run("INSERT OR IGNORE INTO schema_meta(key,value) VALUES('insights_salt',?)", generated);
  const saved = sql.one("SELECT value FROM schema_meta WHERE key='insights_salt'")?.value;
  if (typeof saved !== "string") throw new Error("Insight identity salt is unavailable");
  return saved;
}

function localDay(instant: Date) {
  return `${instant.getFullYear()}-${String(instant.getMonth() + 1).padStart(2, "0")}-${String(instant.getDate()).padStart(2, "0")}`;
}
async function collectGit(git: Git, sql: Sql, workspaces: Workspace[]): Promise<GitRepository[]> {
  const groups = new Map<string, string>();
  for (const workspace of workspaces)
    if (workspace.repository_group_id && !groups.has(workspace.repository_group_id))
      groups.set(workspace.repository_group_id, workspace.canonical_path);
  const previous = new Map(
    sql
      .rows(
        "SELECT substr(provider,5) AS group_id,cursor_json FROM insight_cursors WHERE provider LIKE 'git:%' AND cursor_json IS NOT NULL",
      )
      .map((row) => [String(row.group_id), String(row.cursor_json)]),
  );
  const output: GitRepository[] = [];
  for (const [group, workspace] of groups) {
    try {
      const repository = await git.repository(workspace);
      if (!repository) throw new Error("Git repository is unavailable");
      const root = repository.worktree_root;
      const [refs, head, localEmail, globalEmail] = await Promise.all([
        git.run(root, ["for-each-ref", "--format=%(objectname) %(refname)"], 16 * 1024 * 1024),
        git.run(root, ["rev-parse", "HEAD"], 65536, true),
        git.run(root, ["config", "user.email"], 65536, true),
        git.run(root, ["config", "--global", "user.email"], 65536, true),
      ]);
      const fingerprint = `${head.bytes.toString("utf8")}\n${refs.bytes.toString("utf8")}`;
      const identities: GitRepository["identities"] = [];
      const local = localEmail.bytes.toString("utf8").trim();
      const global = globalEmail.bytes.toString("utf8").trim();
      if (local)
        identities.push({
          email: local,
          label: "settings.gitIdentityRepository",
          source: `repository:${group}`,
        });
      if (global)
        identities.push({
          email: global,
          label: "settings.gitIdentityGlobal",
          source: "git-global",
        });
      if (previous.get(group) === fingerprint) {
        output.push({
          group,
          path: root,
          fingerprint,
          changed: false,
          commits: [],
          identities,
          error: null,
        });
        continue;
      }
      const raw = await git.run(
        root,
        ["log", "--all", "--format=%H%x1f%aI%x1f%ae%x1e"],
        256 * 1024 * 1024,
        false,
        true,
      );
      const commits = raw.bytes
        .toString("utf8")
        .split("\u001e")
        .flatMap((record) => {
          const fields = record.trim().split("\u001f");
          if (fields.length < 3 || !fields[0] || !fields[2]) return [];
          const authored = new Date(fields[1]!);
          return Number.isFinite(authored.getTime())
            ? [
                {
                  hash: fields[0]!,
                  authored_at: authored.toISOString(),
                  email: fields[2]!.trim().toLowerCase(),
                },
              ]
            : [];
        });
      output.push({
        group,
        path: root,
        fingerprint,
        changed: true,
        commits,
        identities,
        error: null,
      });
    } catch (error) {
      output.push({
        group,
        path: workspace,
        fingerprint: "",
        changed: false,
        commits: [],
        identities: [],
        error: coded(error),
      });
    }
  }
  return output;
}

function loadCodexState(sql: Sql) {
  const value = sql.one("SELECT state_json FROM codex_incremental_state WHERE id=1")?.state_json;
  const rows = sql
    .rows("SELECT source_kind,source_id,state_json FROM codex_source_checkpoints")
    .map((row) => ({
      source_kind: String(row.source_kind),
      source_id: String(row.source_id),
      state_json: String(row.state_json),
    }));
  return parseCodexState(typeof value === "string" ? value : null, rows);
}

function workspaceForPath(value: string | null, workspaces: Workspace[]) {
  if (!value) return null;
  let resolved: string;
  try {
    resolved = canonicalize(value);
  } catch {
    resolved = value;
  }
  const identity = pathIdentity(resolved);
  return (
    [...workspaces]
      .sort((a, b) => b.canonical_path.length - a.canonical_path.length)
      .find((workspace) => {
        let root: string;
        try {
          root = pathIdentity(canonicalize(workspace.canonical_path));
        } catch {
          root = pathIdentity(workspace.canonical_path);
        }
        return (
          identity === root ||
          identity.startsWith(
            root.endsWith("/") || root.endsWith("\\")
              ? root
              : `${root}${process.platform === "win32" ? "\\" : "/"}`,
          )
        );
      })?.id ?? null
  );
}

function syncUsage(
  sql: Sql,
  salt: string,
  batches: UsageBatch[],
  workspaces: Workspace[],
  codex?: { state: unknown },
) {
  const now = utcNow();
  const changedProviders = new Set<string>();
  for (const batch of batches) {
    if (batch.unchanged) continue;
    const provider = batch.agent;
    sql.run(
      "INSERT INTO insight_cursors(provider,cursor_json,available,quality,coverage_from,coverage_to,imported_events,error,error_key,error_params,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET cursor_json=excluded.cursor_json,available=excluded.available,quality=excluded.quality,coverage_from=excluded.coverage_from,coverage_to=excluded.coverage_to,imported_events=excluded.imported_events,error=excluded.error,error_key=excluded.error_key,error_params=excluded.error_params,updated_at=excluded.updated_at",
      provider,
      batch.cursor,
      batch.status.available ? 1 : 0,
      batch.status.quality,
      batch.status.coverage_from,
      batch.status.coverage_to,
      batch.status.imported_events,
      batch.status.error ?? null,
      batch.status.error_key ?? null,
      "{}",
      now,
    );
    if (!batch.status.available) continue;
    if (provider === "codex") {
      sql.run("DELETE FROM usage_events WHERE surface_agent='codex'");
    } else {
      sql.run("DELETE FROM usage_events WHERE surface_agent=?", provider);
    }
    for (const value of batch.events) {
      const event = asUsage(value);
      const sourceKey = hmac(salt, event.source_key);
      const sessionHash = event.session_key ? hmac(salt, event.session_key) : null;
      const workspaceId = event.workspace_id ?? workspaceForPath(event.workspace_path, workspaces);
      sql.run(
        "INSERT INTO usage_events(source_key,surface_agent,workspace_id,occurred_at,day,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,total_tokens,session_hash,session_count,date_precision,quality) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        sourceKey,
        provider,
        workspaceId,
        event.occurred_at,
        event.day,
        event.model,
        event.input_tokens,
        event.output_tokens,
        event.cache_read_tokens,
        event.cache_write_tokens,
        event.reasoning_tokens,
        event.total_tokens,
        sessionHash,
        event.session_count,
        event.date_precision,
        event.quality,
      );
      if (provider === "codex" && event.source_id)
        sql.run(
          "INSERT INTO insight_source_events(source_id,source_key) VALUES(?,?)",
          event.source_id,
          sourceKey,
        );
    }
    changedProviders.add(provider);
  }
  if (codex && batches.some((batch) => batch.agent === "codex" && !batch.unchanged)) {
    const state = codex.state as Parameters<typeof checkpointRows>[0];
    const rows = checkpointRows(state);
    sql.run("DELETE FROM codex_source_checkpoints");
    for (const row of rows)
      sql.run(
        "INSERT INTO codex_source_checkpoints(source_kind,source_id,state_json) VALUES(?,?,?)",
        row.source_kind,
        row.source_id,
        row.state_json,
      );
    sql.run(
      "INSERT INTO codex_incremental_state(id,state_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json",
      JSON.stringify({ storage_version: 1, generation: randomUUID(), sources: rows.length }),
    );
  }
  for (const provider of changedProviders) {
    sql.run("DELETE FROM usage_daily WHERE surface_agent=?", provider);
    sql.run(
      "INSERT INTO usage_daily(day,surface_agent,workspace_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,total_tokens,session_count,quality) SELECT day,surface_agent,COALESCE(workspace_id,''),SUM(input_tokens),SUM(output_tokens),SUM(cache_read_tokens),SUM(cache_write_tokens),SUM(reasoning_tokens),SUM(total_tokens),SUM(session_count),CASE MAX(CASE quality WHEN 'incomplete' THEN 2 WHEN 'estimated' THEN 1 ELSE 0 END) WHEN 2 THEN 'incomplete' WHEN 1 THEN 'estimated' ELSE 'exact' END FROM usage_events WHERE day IS NOT NULL AND date_precision!='aggregate' AND surface_agent=? GROUP BY day,surface_agent,COALESCE(workspace_id,'')",
      provider,
    );
  }
}

function syncGit(sql: Sql, salt: string, repositories: GitRepository[]) {
  const now = utcNow();
  let changed = false;
  for (const repository of repositories) {
    const provider = `git:${repository.group}`;
    if (repository.error) {
      sql.run(
        "INSERT INTO insight_cursors(provider,available,quality,imported_events,error,error_key,error_params,updated_at) VALUES(?,0,'incomplete',0,?,'errors.providerUnavailable','{}',?) ON CONFLICT(provider) DO UPDATE SET available=0,quality='incomplete',error=excluded.error,error_key=excluded.error_key,error_params=excluded.error_params,updated_at=excluded.updated_at",
        provider,
        repository.error,
        now,
      );
      continue;
    }
    for (const identity of repository.identities) {
      const identityHash = hmac(salt, identity.email.trim().toLowerCase());
      sql.run(
        "INSERT INTO git_identities(id,identity_hash,source,label,enabled,created_at) VALUES(?,?,?,?,1,?) ON CONFLICT(identity_hash) DO UPDATE SET source=excluded.source,label=excluded.label",
        identityHash,
        identityHash,
        identity.source,
        identity.label,
        now,
      );
    }
    if (repository.changed) {
      changed = true;
      sql.run("DELETE FROM commit_attributions WHERE repository_group_id=?", repository.group);
      sql.run("DELETE FROM git_commits WHERE repository_group_id=?", repository.group);
      for (const commit of repository.commits) {
        const identityHash = hmac(salt, commit.email.trim().toLowerCase());
        const authored = new Date(commit.authored_at);
        sql.run(
          "INSERT INTO git_commits(repository_group_id,commit_hash,authored_at,day,author_identity_hash,is_mine) VALUES(?,?,?,?,?,EXISTS(SELECT 1 FROM git_identities WHERE identity_hash=? AND enabled=1))",
          repository.group,
          commit.hash,
          authored.toISOString(),
          localDay(authored),
          identityHash,
          identityHash,
        );
      }
    }
    sql.run(
      "INSERT INTO insight_cursors(provider,cursor_json,available,quality,imported_events,error,updated_at) VALUES(?,?,1,'exact',?,NULL,?) ON CONFLICT(provider) DO UPDATE SET cursor_json=excluded.cursor_json,available=1,quality='exact',imported_events=excluded.imported_events,error=NULL,updated_at=excluded.updated_at",
      provider,
      repository.fingerprint,
      repository.commits.length,
      now,
    );
  }
  sql.run(
    "UPDATE git_commits SET is_mine=EXISTS(SELECT 1 FROM git_identities WHERE identity_hash=git_commits.author_identity_hash AND enabled=1) WHERE is_mine!=EXISTS(SELECT 1 FROM git_identities WHERE identity_hash=git_commits.author_identity_hash AND enabled=1)",
  );
  const identitiesChanged = positive(sql.one("SELECT changes() AS value")?.value) > 0;
  if (changed || identitiesChanged)
    sql.run("DELETE FROM commit_attributions WHERE method='time-correlation'");
  return changed || identitiesChanged;
}

export class InsightRefresh {
  constructor(
    readonly sql: Sql,
    readonly commands: Commands,
    readonly git: Git,
    readonly environment: NodeJS.ProcessEnv,
    readonly refreshAchievements: () => unknown,
  ) {}
  async refresh() {
    const queued = utcNow(),
      started = utcNow();
    const salt = await insightSalt(this.sql);
    const workspaces = this.sql.rows(
      "SELECT id,canonical_path,repository_group_id FROM workspaces ORDER BY COALESCE(last_active_at,last_scanned_at) DESC,name ASC",
    ) as unknown as Workspace[];
    const codexHome =
      this.environment.CODEX_HOME ?? path.join(this.environment.HOME ?? homedir(), ".codex");
    let codex: Awaited<ReturnType<typeof collectCodexUsage>> | null = null;
    let codexError: UsageBatch | null = null;
    try {
      const saved = this.sql.one(
        "SELECT state_json FROM codex_incremental_state WHERE id=1",
      )?.state_json;
      codex = await collectCodexUsage({
        home: codexHome,
        state: loadCodexState(this.sql),
        salt,
        workspaces,
      });
      if (typeof saved !== "string" && !codex.initial_complete)
        throw new Error(
          "Codex initial usage scan was incomplete; existing statistics were retained",
        );
    } catch (error) {
      codexError = {
        agent: "codex",
        events: [],
        cursor: null,
        unchanged: false,
        status: {
          available: false,
          quality: "incomplete",
          coverage_from: null,
          coverage_to: null,
          imported_events: 0,
          error_key: "errors.providerUnavailable",
          error: coded(error),
        },
      };
    }
    const cursors = new Map(
      this.sql
        .rows(
          "SELECT provider,cursor_json FROM insight_cursors WHERE provider NOT LIKE 'git:%' AND cursor_json IS NOT NULL",
        )
        .map((row) => [String(row.provider), String(row.cursor_json)]),
    );
    const [others, repositories] = await Promise.all([
      collectUsage(cursors, {
        home: this.environment.HOME ?? homedir(),
        environment: this.environment,
        commands: this.commands,
      }),
      collectGit(this.git, this.sql, workspaces),
    ]);
    const codexBatch = codex?.batch ?? codexError!;
    this.sql.transaction(() => {
      syncUsage(
        this.sql,
        salt,
        [...others, codexBatch],
        workspaces,
        codex ? { state: codex.state } : undefined,
      );
      const gitChanged = syncGit(this.sql, salt, repositories);
      const dataChanged =
        gitChanged ||
        [...others, codexBatch].some((batch) => !batch.unchanged && batch.status.available);
      if (dataChanged)
        this.sql.run("DELETE FROM commit_attributions WHERE method='time-correlation'");
      this.sql.run(
        "INSERT INTO audit_events(id,project_id,action,detail,created_at) VALUES(?,NULL,'insights.refresh',?,?)",
        randomUUID(),
        `${others.length + 1} providers, ${repositories.length} repositories`,
        utcNow(),
      );
    });
    this.refreshAchievements();
    const finished = utcNow();
    const requestId = `${Date.now()}-typescript`;
    return {
      kind: "insights",
      disposition: "queued",
      request_id: requestId,
      status: {
        kind: "insights",
        state: "succeeded",
        request_id: requestId,
        queued_at: queued,
        started_at: started,
        finished_at: finished,
        progress_current: 1,
        progress_total: 1,
        error: null,
        next_allowed_at: null,
      },
    };
  }
}
