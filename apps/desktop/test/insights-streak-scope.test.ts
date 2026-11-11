// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Insights } from "../../../packages/backend/src/insights";
import { Sql } from "../../../packages/backend/src/sql";
import { migrateSharedSchema } from "../../../packages/backend/src/store-migrations";

const databases: DatabaseSync[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 10, 12));
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.useRealTimers();
});
function day(offset: number) {
  const value = new Date(Date.UTC(2026, 10, 10 + offset));
  return value.toISOString().slice(0, 10);
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  migrateSharedSchema(db);
  const sql = new Sql(db);
  for (const name of ["a", "b"])
    sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,repository_group_id,status,last_discovered_at) VALUES (?,?,?,?,?,?)",
      name,
      `/synthetic/${name}`,
      name,
      `repo-${name}`,
      "healthy",
      new Date().toISOString(),
    );
  function usage(offset: number, agent = "codex", workspace = "a", tokens = 10) {
    const date = day(offset),
      key = `${date}:${agent}:${workspace}`;
    sql.run(
      "INSERT INTO usage_events(source_key,surface_agent,workspace_id,day,total_tokens,session_count,date_precision,quality) VALUES (?,?,?,?,?,1,'day','exact')",
      key,
      agent,
      workspace,
      date,
      tokens,
    );
    sql.run(
      "INSERT INTO usage_daily(day,surface_agent,workspace_id,total_tokens,session_count,quality) VALUES (?,?,?,?,1,'exact')",
      date,
      agent,
      workspace,
      tokens,
    );
  }
  function commit(offset: number, repository = "repo-a", agent = "codex") {
    const date = day(offset),
      hash = `${date}:${repository}`;
    sql.run(
      "INSERT INTO git_commits(repository_group_id,commit_hash,authored_at,day,author_identity_hash,is_mine) VALUES (?,?,?,?,?,1)",
      repository,
      hash,
      `${date}T12:00:00Z`,
      date,
      "synthetic-author",
    );
    sql.run(
      "INSERT INTO commit_attributions(repository_group_id,commit_hash,agent,confidence,method) VALUES (?,?,?,'exact','synthetic')",
      repository,
      hash,
      agent,
    );
  }
  return { insights: new Insights(sql), usage, commit };
}

describe("current insight streak outside the selected chart window", () => {
  it("keeps a 46-day streak while period totals and longest run remain scoped to 30 days", () => {
    const f = fixture();
    for (let offset = -45; offset <= 0; offset++) f.usage(offset);
    const value = f.insights.summary({ from: day(-29), to: day(0) });
    expect(value).toMatchObject({
      current_streak: 46,
      longest_streak: 30,
      active_days: 30,
      total_tokens: 300,
      session_count: 30,
      coverage_from: day(-29),
      coverage_to: day(0),
    });
  });

  it("uses yesterday when today has no activity and ignores future records", () => {
    const f = fixture();
    for (let offset = -35; offset < 0; offset++) f.usage(offset);
    f.usage(1);
    const value = f.insights.summary({ from: day(-6), to: day(0) });
    expect(value).toMatchObject({ current_streak: 35, longest_streak: 6, active_days: 6 });
  });

  it("does not extend a current streak across an inactive yesterday", () => {
    const f = fixture();
    for (let offset = -40; offset <= -2; offset++) f.usage(offset);
    expect(f.insights.summary({ from: day(-6), to: day(0) }).current_streak).toBe(0);
    f.usage(0);
    expect(f.insights.summary({ from: day(-6), to: day(0) }).current_streak).toBe(1);
  });

  it("retains agent and workspace/repository filters when looking before the selected start", () => {
    const f = fixture();
    for (let offset = -45; offset <= 0; offset++) {
      f.usage(offset, "claude-code", "a");
      f.usage(offset, "codex", "b");
    }
    for (let offset = -9; offset <= 0; offset++) f.usage(offset, "codex", "a");
    const query = { from: day(-6), to: day(0), agent: "codex" as const };
    expect(f.insights.summary({ ...query, workspace_id: "a" })).toMatchObject({
      current_streak: 10,
      active_days: 7,
      total_tokens: 70,
    });
    expect(f.insights.summary({ ...query, repository_group_id: "repo-a" }).current_streak).toBe(10);
    expect(f.insights.summary({ ...query, workspace_id: "b" }).current_streak).toBe(46);
  });

  it("counts attributed commits while excluding another repository or agent", () => {
    const f = fixture();
    for (let offset = -45; offset <= 0; offset++) f.commit(offset, "repo-b", "claude-code");
    for (let offset = -14; offset <= 0; offset++) f.commit(offset, "repo-a", "codex");
    const query = {
      from: day(-6),
      to: day(0),
      agent: "codex" as const,
      repository_group_id: "repo-a",
    };
    expect(f.insights.summary(query)).toMatchObject({
      current_streak: 15,
      longest_streak: 7,
      active_days: 7,
      my_commits: 7,
      all_commits: 7,
    });
    expect(f.insights.summary({ ...query, agent: "claude-code" }).current_streak).toBe(0);
  });

  it("keeps current activity anchored to today for a historical custom range", () => {
    const f = fixture();
    for (let offset = -45; offset <= 0; offset++) f.usage(offset);
    expect(f.insights.summary({ from: day(-40), to: day(-34) })).toMatchObject({
      current_streak: 46,
      longest_streak: 7,
      active_days: 7,
      total_tokens: 70,
    });
  });
});
