import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import {
  Doctor,
  StoredDoctorSummaries,
  type DoctorSummary,
} from "../../../packages/backend/src/doctor";
import { BackendStore } from "../../../packages/backend/src/store";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

const fixtures: ContextFixture[] = [];
afterEach(() => {
  for (const created of fixtures.splice(0)) created.dispose();
});

/** A doctor over one synthetic project, recording which workspaces it diagnosed. */
function setup() {
  const f = contextFixture();
  fixtures.push(f);
  f.write("CLAUDE.md", "# Project\nUse tabs.\n");
  const diagnosed: string[] = [];
  const unavailable = new Set<string>();
  const doctor = new Doctor(f.context, (id) => {
    diagnosed.push(id);
    if (unavailable.has(id)) throw new Error("Workspace is unavailable");
    return f.project;
  });
  const read = (workspaceIds: string[]) =>
    doctor.request(RUNTIME_METHODS.workspaceDoctorSummaries, { workspaceIds }) as Promise<
      DoctorSummary[]
    >;
  return { f, doctor, diagnosed, unavailable, read };
}

const ids = (rows: DoctorSummary[]) => rows.map((row) => row.workspace_id);
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

describe("kept workspace diagnostics", () => {
  it("answers a summary read from what refresh kept, without diagnosing", async () => {
    const { doctor, diagnosed, read } = setup();
    expect(await read(["a", "b"])).toEqual([]);
    expect(diagnosed).toEqual([]);
    expect(await doctor.refresh(["a", "b"])).toEqual({ checked: 2, failed: 0 });
    diagnosed.length = 0;
    expect(ids(await read(["b", "a", "missing"]))).toEqual(["b", "a"]);
    expect(diagnosed).toEqual([]);
  });

  it("keeps the summary of a full report, as the Doctor page runs it, and drops it when it fails", async () => {
    const { doctor, unavailable, read } = setup();
    await doctor.request(RUNTIME_METHODS.workspaceDoctorReport, { id: "a" });
    expect(ids(await read(["a"]))).toEqual(["a"]);
    unavailable.add("a");
    await expect(
      doctor.request(RUNTIME_METHODS.workspaceDoctorReport, { id: "a" }),
    ).rejects.toThrow("Workspace is unavailable");
    expect(await read(["a"])).toEqual([]);
  });

  it("checks only workspaces whose summary is older than maxAgeMs, or missing", async () => {
    const { doctor, diagnosed, read } = setup();
    await doctor.refresh(["fresh", "old"]);
    const [old] = await read(["old"]);
    doctor.summaries.put({ ...old!, checked_at: hoursAgo(2) });
    diagnosed.length = 0;
    expect(await doctor.refresh(["fresh", "old", "new"], 30 * 60_000)).toEqual({
      checked: 2,
      failed: 0,
    });
    expect(diagnosed).toEqual(["old", "new"]);
    // Without a limit, every workspace is checked again.
    diagnosed.length = 0;
    await doctor.refresh(["fresh", "old", "new"]);
    expect(diagnosed).toEqual(["fresh", "old", "new"]);
  });

  it("drops the summaries of removed workspaces and of workspaces that cannot be checked", async () => {
    const { doctor, unavailable, read } = setup();
    await doctor.refresh(["a", "b", "c"]);
    unavailable.add("b");
    expect(await doctor.refresh(["a", "b"])).toEqual({ checked: 1, failed: 1 });
    expect(ids(await read(["a", "b", "c"]))).toEqual(["a"]);
  });

  it("starts each workspace on a new turn of the event loop", async () => {
    const { doctor } = setup();
    const order: string[] = [];
    // A report with no I/O of its own: without the yield, all of them would run in one turn.
    doctor.report = (async (id: string) => {
      order.push(id);
      doctor.summaries.put({
        workspace_id: id,
        error_count: 0,
        warning_count: 0,
        info_count: 0,
        repairable_count: 0,
        checked_at: new Date().toISOString(),
      });
      return {};
    }) as unknown as Doctor["report"];
    const other = (async () => {
      for (let turn = 0; turn < 3; turn++) {
        await nextTurn();
        order.push(`other-${turn}`);
      }
    })();
    await doctor.refresh(["a", "b", "c"]);
    await other;
    expect(order.indexOf("other-0")).toBeLessThan(order.indexOf("c"));
    expect(order.filter((entry) => !entry.startsWith("other"))).toEqual(["a", "b", "c"]);
  });
});

describe("stored workspace diagnostics", () => {
  it("survive reopening the database, which keeps passing its schema check", async () => {
    const f = contextFixture();
    fixtures.push(f);
    const file = path.join(f.root, "data", "agentkib.db");
    const first = new BackendStore(file);
    const summary: DoctorSummary = {
      workspace_id: "a",
      error_count: 1,
      warning_count: 2,
      info_count: 0,
      repairable_count: 1,
      checked_at: "2026-11-09T03:00:00Z",
    };
    new StoredDoctorSummaries(first.sql).put(summary);
    first.close();
    const second = new BackendStore(file);
    try {
      const stored = new StoredDoctorSummaries(second.sql);
      expect(stored.get(["a", "b"])).toEqual([summary]);
      stored.retain(["b"]);
      expect(stored.get(["a"])).toEqual([]);
    } finally {
      second.close();
    }
  });

  it("ignores a stored row it cannot read", async () => {
    const f = contextFixture();
    fixtures.push(f);
    const store = new BackendStore(path.join(f.root, "data", "agentkib.db"));
    try {
      const stored = new StoredDoctorSummaries(store.sql);
      store.sql.run(
        "INSERT INTO doctor_summaries(workspace_id, summary) VALUES (?, ?), (?, ?)",
        "broken",
        "{not json",
        "other",
        JSON.stringify({ workspace_id: "someone-else", error_count: 0 }),
      );
      expect(stored.get(["broken", "other"])).toEqual([]);
    } finally {
      store.close();
    }
  });
});
