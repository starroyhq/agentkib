import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SQLInputValue } from "node:sqlite";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { AGENTS, agentSchema, optionalString, parameters } from "./rpc";
import { Sql, positive, type Row } from "./sql";
import { INSIGHT_SQL as Q } from "./insight-sql";
import { timestamp } from "./timestamps";
import { compareTimes, storedTime, utcNow } from "./workspaces";
const qualitySchema = z.enum(["exact", "estimated", "incomplete"]);
function date(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new Error(`Invalid date: ${value}`);
  return value;
}
const dateSchema = z.string().refine((value) => {
  try {
    date(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid date");
const querySchema = z.object({
  from: dateSchema.nullable().optional(),
  to: dateSchema.nullable().optional(),
  agent: agentSchema.nullable().optional(),
  workspace_id: optionalString,
  repository_group_id: optionalString,
});
type Query = z.infer<typeof querySchema>;
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function shift(day: string, count: number): string {
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}
function quality(value: unknown): "exact" | "estimated" | "incomplete" {
  return Number(value) === 2 ? "incomplete" : Number(value) === 1 ? "estimated" : "exact";
}
const special = [
  "first-changeset",
  "first-memory",
  "shared-workspace",
  "exact-attribution",
  "remote-handshake",
  "night-owl",
  "comeback",
  "same-day-delivery",
];
export class Insights {
  constructor(readonly sql: Sql) {}
  request(method: string, value: unknown): unknown {
    if (method === RUNTIME_METHODS.gitIdentities) return this.identities();
    if (method === RUNTIME_METHODS.addGitIdentityAlias) {
      const { email } = parameters(z.object({ email: z.string() }), value);
      return this.addAlias(email);
    }
    if (method === RUNTIME_METHODS.setGitIdentityEnabled) {
      const { id, enabled } = parameters(z.object({ id: z.string(), enabled: z.boolean() }), value);
      this.setEnabled(id, enabled);
      return null;
    }
    if (method === RUNTIME_METHODS.achievements) return this.achievements();
    if (method === RUNTIME_METHODS.insightsStatus) return this.status();
    const { query } = parameters(z.object({ query: querySchema.default({}) }), value);
    switch (method) {
      case RUNTIME_METHODS.insightsSummary:
        return this.summary(query);
      case RUNTIME_METHODS.insightsHeatmap:
        return this.heatmap(query);
      case RUNTIME_METHODS.agentUsageBreakdown:
        return this.agents(query);
      case RUNTIME_METHODS.modelUsageBreakdown:
        return this.models(query);
      case RUNTIME_METHODS.workspaceUsageBreakdown:
        return this.workspaces(query);
      case RUNTIME_METHODS.repositoryCommitBreakdown:
        return this.repositories(query);
      case RUNTIME_METHODS.insightsView:
        return {
          summary: this.summary(query),
          heatmap: this.heatmap(query),
          agents: this.agents(query),
          models: this.models(query),
          workspaces: this.workspaces(query),
          repositories: this.repositories(query),
          achievements: this.achievements(),
          status: this.status(),
        };
      default:
        throw new Error(`Unknown insights method: ${method}`);
    }
  }
  rows(sql: string, values: SQLInputValue[] = []): Row[] {
    const bound: SQLInputValue[] = [];
    const positional = sql.replace(/\?(\d+)/g, (_, number) => {
      bound.push(values[Number(number) - 1] ?? null);
      return "?";
    });
    return this.sql.rows(positional, ...bound);
  }
  values(
    query: Query,
  ): [string | null, string | null, string | null, string | null, string | null] {
    return [
      query.from ?? null,
      query.to ?? null,
      query.agent ?? null,
      query.workspace_id ?? null,
      query.repository_group_id ??
        (query.workspace_id
          ? (this.sql.one(
              "SELECT repository_group_id FROM workspaces WHERE id = ?",
              query.workspace_id,
            )?.repository_group_id as string | null)
          : null) ??
        null,
    ];
  }
  status() {
    let refreshed_at: string | null = null;
    const providers = this.rows(Q.status).flatMap((row) => {
      const agent = String(row.k0);
      if (!AGENTS.includes(agent as (typeof AGENTS)[number])) return [];
      const updated = timestamp(row.k9);
      if (!updated) throw new Error("Invalid insight cursor timestamp");
      if (!refreshed_at || compareTimes(updated, refreshed_at) > 0) refreshed_at = updated;
      const params = z.record(z.string(), z.string()).parse(JSON.parse(String(row.k8)));
      return [
        {
          agent,
          available: Boolean(row.k1),
          quality: qualitySchema.parse(row.k2),
          coverage_from: row.k3 === null ? null : date(String(row.k3)),
          coverage_to: row.k4 === null ? null : date(String(row.k4)),
          imported_events: positive(row.k5),
          error: row.k6 as string | null,
          ...(row.k7 === null ? {} : { error_key: String(row.k7) }),
          ...(Object.keys(params).length ? { error_params: params } : {}),
        },
      ];
    });
    for (const agent of AGENTS)
      if (!providers.some((provider) => provider.agent === agent))
        providers.push({
          agent,
          available: false,
          quality: "incomplete",
          coverage_from: null,
          coverage_to: null,
          imported_events: 0,
          error: null,
        });
    providers.sort(
      (a, b) =>
        AGENTS.indexOf(a.agent as (typeof AGENTS)[number]) -
        AGENTS.indexOf(b.agent as (typeof AGENTS)[number]),
    );
    return { providers, refreshed_at, running: false };
  }
  active(query: Query): string[] {
    const [from, to, agent, workspace, repository] = this.values(query);
    return [
      ...new Set(
        [
          ...this.rows(Q.activeUsage, [from, to, agent, workspace, repository]),
          ...this.rows(Q.activeCommits, [from, to, repository, agent]),
        ].map((row) => date(String(row.k0))),
      ),
    ].sort();
  }
  summary(query: Query = {}) {
    const [from, to, agent, workspace, repository] = this.values(query),
      usage = this.rows(Q.summaryUsage, [from, to, agent, workspace, repository])[0]!,
      commits = this.rows(Q.summaryCommits, [from, to, repository, agent])[0]!;
    const active = this.active(query),
      days = new Set(active),
      now = today();
    let longest_streak = 0,
      run = 0,
      previous: string | undefined;
    for (const day of active) {
      run = previous && shift(previous, 1) === day ? run + 1 : 1;
      longest_streak = Math.max(longest_streak, run);
      previous = day;
    }
    let current_streak = 0,
      cursor = days.has(now) ? now : shift(now, -1);
    while (days.has(cursor)) {
      current_streak++;
      cursor = shift(cursor, -1);
    }
    const status = this.status(),
      installed = new Set(
        this.sql
          .rows("SELECT agent FROM agent_installations WHERE installed=1")
          .map((row) => agentSchema.parse(row.agent)),
      ),
      relevant = status.providers.filter(
        (value) =>
          (!query.agent || value.agent === query.agent) &&
          (value.available || installed.has(value.agent as (typeof AGENTS)[number])),
      );
    const quality =
      relevant.length === 0 ||
      relevant.some((value) => !value.available || value.quality === "incomplete")
        ? "incomplete"
        : relevant.some((value) => value.quality === "estimated")
          ? "estimated"
          : "exact";
    return {
      total_tokens: positive(usage.k0),
      input_tokens: positive(usage.k1),
      output_tokens: positive(usage.k2),
      cache_tokens: positive(usage.k3),
      reasoning_tokens: positive(usage.k4),
      session_count: positive(usage.k5),
      my_commits: positive(commits.k0),
      all_commits: positive(commits.k1),
      attributed_commits: positive(commits.k2),
      active_days: active.length,
      current_streak,
      longest_streak,
      quality,
      coverage_from: active[0] ?? null,
      coverage_to: active.at(-1) ?? null,
      refreshed_at: status.refreshed_at,
    };
  }
  heatmap(query: Query) {
    const [, , agent, workspace, repository] = this.values(query),
      from = query.from ?? shift(today(), -363),
      to = query.to ?? today();
    const points = new Map<
      string,
      {
        date: string;
        tokens: number;
        my_commits: number;
        all_commits: number;
        attributed_commits: number;
        sessions: number;
        quality: "exact" | "estimated" | "incomplete";
      }
    >();
    for (let day = from; day <= to; day = shift(day, 1))
      points.set(day, {
        date: day,
        tokens: 0,
        my_commits: 0,
        all_commits: 0,
        attributed_commits: 0,
        sessions: 0,
        quality: "exact",
      });
    for (const row of this.rows(Q.heatmapUsage, [from, to, agent, workspace, repository])) {
      const point = points.get(String(row.k0));
      if (point)
        Object.assign(point, {
          tokens: positive(row.k1),
          sessions: positive(row.k2),
          quality: quality(row.k3),
        });
    }
    for (const row of this.rows(Q.heatmapCommits, [from, to, repository, agent])) {
      const point = points.get(String(row.k0));
      if (point)
        Object.assign(point, {
          my_commits: positive(row.k1),
          all_commits: positive(row.k2),
          attributed_commits: positive(row.k3),
        });
    }
    return [...points.values()];
  }
  agents(query: Query = {}) {
    const [from, to, , workspace, repository] = this.values(query);
    return this.rows(Q.agents, [from, to, workspace, repository]).map((row) => ({
      agent: agentSchema.parse(row.k0),
      total_tokens: positive(row.k1),
      input_tokens: positive(row.k2),
      output_tokens: positive(row.k3),
      cache_tokens: positive(row.k4),
      reasoning_tokens: positive(row.k5),
      session_count: positive(row.k6),
      quality: quality(row.k7),
    }));
  }
  models(query: Query) {
    return this.rows(Q.models, this.values(query)).map((row) => ({
      model: String(row.k0),
      total_tokens: positive(row.k1),
      session_count: positive(row.k2),
    }));
  }
  workspaces(query: Query) {
    return this.rows(Q.workspaces, this.values(query)).map((row) => ({
      workspace_id: row.k0 as string | null,
      name: String(row.k1),
      total_tokens: positive(row.k2),
      session_count: positive(row.k3),
    }));
  }
  repositories(query: Query) {
    const [from, to, , , repository] = this.values(query);
    return this.rows(Q.repositories, [from, to, repository]).map((row) => ({
      repository_group_id: String(row.k0),
      name: String(row.k1),
      my_commits: positive(row.k2),
      all_commits: positive(row.k3),
      attributed_commits: positive(row.k4),
    }));
  }
  achievements() {
    const summary = this.summary(),
      agentCount = this.agents().filter(
        (value) => value.total_tokens > 0 || value.session_count > 0,
      ).length,
      workspaceCount = positive(this.rows(Q.workspaceCount)[0]?.k0);
    const tracks: [string, number[], number][] = [
      ["token", [1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12], summary.total_tokens],
      ["session", [10, 50, 100, 500, 1000, 5000, 10000], summary.session_count],
      ["commit", [1, 10, 100, 1000, 5000, 10000], summary.my_commits],
      ["active-days", [7, 30, 100, 365, 1000], summary.active_days],
      ["streak", [3, 7, 14, 30, 60, 100, 180, 365], summary.longest_streak],
      ["workspaces", [1, 5, 10, 25, 50, 100], workspaceCount],
      ["agents", [1, 2, 3, 4, 5], agentCount],
    ];
    this.sql.transaction(() => this.refreshAchievementUnlocks(tracks));
    return [
      ...tracks.flatMap(([category, thresholds, progress]) =>
        thresholds.map((threshold) => ({
          code: `${category}-${threshold}`,
          category,
          threshold,
          progress,
        })),
      ),
      ...special.map((code) => ({
        code: `special-${code}`,
        category: "special",
        threshold: 1,
        progress: 0,
      })),
    ].map((value) => {
      const saved = this.sql.one(
        "SELECT unlocked_at,rule_version FROM achievement_unlocks WHERE code=?",
        value.code,
      );
      let unlocked_at: string | null = null;
      if (saved && positive(saved.rule_version) > 0) {
        unlocked_at = timestamp(saved.unlocked_at);
        if (!unlocked_at) throw new Error("Invalid achievement timestamp");
      }
      return {
        ...value,
        progress: saved ? Math.max(value.progress, value.threshold) : value.progress,
        unlocked_at,
      };
    });
  }
  private refreshAchievementUnlocks(tracks: [string, number[], number][]): void {
    const unlock = (code: string, at: string | null) => {
      if (!at) return;
      this.sql.run(
        "INSERT INTO achievement_unlocks(code,unlocked_at,rule_version) VALUES (?,?,1) ON CONFLICT(code) DO UPDATE SET unlocked_at=excluded.unlocked_at, rule_version=1 WHERE achievement_unlocks.rule_version=0",
        code,
        at,
      );
    };
    const startOfDay = (day: string) => `${day}T00:00:00.000Z`;
    for (const [category, thresholds] of tracks)
      for (const threshold of thresholds) {
        const saved = this.sql.one(
          "SELECT rule_version FROM achievement_unlocks WHERE code=?",
          `${category}-${threshold}`,
        );
        if (saved && positive(saved.rule_version) > 0) continue;
        const day = this.achievementThresholdDay(category, threshold);
        if (day) unlock(`${category}-${threshold}`, startOfDay(day));
      }
    const first = (sql: string) => {
      const value = this.sql.one(sql)?.value;
      if (typeof value !== "string") return null;
      return timestamp(value);
    };
    unlock(
      "special-first-changeset",
      first("SELECT MIN(created_at) AS value FROM audit_events WHERE action='changeset.apply'"),
    );
    unlock(
      "special-first-memory",
      first(
        "SELECT MIN(approved_at) AS value FROM memories WHERE status='approved' AND approved_at IS NOT NULL",
      ),
    );
    const shared = this.firstSharedWorkspaceDay();
    if (shared) unlock("special-shared-workspace", startOfDay(shared));
    unlock(
      "special-exact-attribution",
      first(
        "SELECT MIN(c.authored_at) AS value FROM commit_attributions a JOIN git_commits c ON c.repository_group_id=a.repository_group_id AND c.commit_hash=a.commit_hash WHERE a.confidence='exact'",
      ),
    );
    const night = this.sql
      .rows(
        "SELECT occurred_at AS value FROM usage_events WHERE occurred_at IS NOT NULL AND date_precision='exact' AND (total_tokens>0 OR session_count>0) ORDER BY occurred_at",
      )
      .map((row) => timestamp(row.value))
      .find((value) => value !== null && new Date(value).getHours() < 5);
    if (night) unlock("special-night-owl", night);
    const activeDays = this.active({});
    const comeback = activeDays.find(
      (day, index) =>
        index > 0 &&
        Date.parse(`${day}T00:00:00Z`) - Date.parse(`${activeDays[index - 1]}T00:00:00Z`) >=
          31 * 86400000,
    );
    if (comeback) unlock("special-comeback", startOfDay(comeback));
    const delivery = this.sql.one(
      "SELECT MIN(d.day) AS value FROM usage_daily d WHERE (d.total_tokens>0 OR d.session_count>0) AND EXISTS(SELECT 1 FROM git_commits c WHERE c.day=d.day AND c.is_mine=1)",
    )?.value;
    if (typeof delivery === "string") unlock("special-same-day-delivery", startOfDay(delivery));
  }
  private achievementThresholdDay(category: string, threshold: number): string | null {
    if (category === "active-days") return this.active({})[threshold - 1] ?? null;
    if (category === "streak") {
      const days = this.active({});
      let run = 0;
      let previous: string | undefined;
      for (const day of days) {
        run =
          previous &&
          Date.parse(`${day}T00:00:00Z`) - Date.parse(`${previous}T00:00:00Z`) === 86400000
            ? run + 1
            : 1;
        if (run >= threshold) return day;
        previous = day;
      }
      return null;
    }
    if (category === "workspaces") {
      const rows = this.sql.rows(
        "SELECT day,workspace_id FROM usage_daily WHERE workspace_id!='' AND (total_tokens>0 OR session_count>0) ORDER BY day,workspace_id",
      );
      const seen = new Set<string>();
      for (const row of rows) {
        seen.add(String(row.workspace_id));
        if (seen.size >= threshold) return String(row.day);
      }
      return null;
    }
    if (category === "agents") {
      const rows = this.sql.rows(
        "SELECT MIN(day) AS day FROM usage_daily WHERE total_tokens>0 OR session_count>0 GROUP BY surface_agent ORDER BY MIN(day)",
      );
      const day = rows[threshold - 1]?.day;
      return typeof day === "string" ? day : null;
    }
    const column =
      category === "token"
        ? "total_tokens"
        : category === "session"
          ? "session_count"
          : category === "commit"
            ? "is_mine"
            : null;
    if (!column) return null;
    const table = category === "commit" ? "git_commits" : "usage_daily";
    const rows = this.sql.rows(
      `SELECT day,SUM(${column}) AS amount FROM ${table} GROUP BY day ORDER BY day`,
    );
    let cumulative = 0;
    for (const row of rows) {
      cumulative += positive(row.amount);
      if (cumulative >= threshold) return String(row.day);
    }
    return null;
  }
  private firstSharedWorkspaceDay(): string | null {
    const agents = new Map<string, Set<string>>();
    for (const row of this.sql.rows(
      "SELECT day,workspace_id,surface_agent FROM usage_daily WHERE workspace_id!='' AND (total_tokens>0 OR session_count>0) ORDER BY day,workspace_id,surface_agent",
    )) {
      const workspace = String(row.workspace_id);
      const seen = agents.get(workspace) ?? new Set<string>();
      seen.add(String(row.surface_agent));
      agents.set(workspace, seen);
      if (seen.size >= 2) return String(row.day);
    }
    return null;
  }
  identities() {
    return this.rows(Q.identities).map((row) => ({
      id: String(row.k0),
      label: String(row.label),
      source: String(row.k2),
      enabled: Boolean(row.k3),
    }));
  }
  salt(key = "insights_salt"): string {
    const existing = this.sql.one("SELECT value FROM schema_meta WHERE key=?", key);
    if (existing) return String(existing.value);
    this.sql.run(
      "INSERT OR IGNORE INTO schema_meta(key,value) VALUES (?,?)",
      key,
      randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    );
    return String(this.sql.one("SELECT value FROM schema_meta WHERE key=?", key)!.value);
  }
  addAlias(email: string) {
    email = email.trim().replace(/[A-Z]/g, (value) => value.toLowerCase());
    if (!email.includes("@") || Buffer.byteLength(email) > 320)
      throw new Error("Enter a valid Git email address");
    return this.sql.transaction(() => {
      const id = createHmac("sha256", this.salt()).update(email).digest("hex");
      this.sql.run(
        "INSERT INTO git_identities(id,identity_hash,source,label,enabled,created_at) VALUES (?,?,'manual','settings.gitIdentityAlias',1,?) ON CONFLICT(identity_hash) DO UPDATE SET enabled=1",
        id,
        id,
        storedTime(utcNow()),
      );
      this.recompute();
      const result = this.identities().find((value) => value.id === id);
      if (!result) throw new Error("Git identity could not be saved");
      return result;
    });
  }
  setEnabled(id: string, enabled: boolean): void {
    this.sql.transaction(() => {
      const result = this.sql.database
        .prepare("UPDATE git_identities SET enabled=? WHERE id=?")
        .run(Number(enabled), id);
      if (!result.changes) throw new Error("Git identity does not exist");
      this.recompute();
    });
  }
  recompute(): void {
    this.sql.run(
      "UPDATE git_commits SET is_mine=EXISTS(SELECT 1 FROM git_identities WHERE identity_hash=git_commits.author_identity_hash AND enabled=1)",
    );
  }
}
