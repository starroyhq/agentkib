// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { Sql } from "../../../packages/backend/src/sql";
import {
  beginSqliteWrite,
  observeSqliteLockAcquisition,
} from "../../../packages/backend/src/sqlite-lock-timing";

describe("SQLite writer lock diagnostics", () => {
  it("reports real native busy waits without retrying or changing lock policy", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentkib-sqlite-lock-"));
    const file = path.join(directory, "fixture.sqlite");
    const locker = new DatabaseSync(file);
    const contender = new DatabaseSync(file);
    const record = vi.fn();
    const stop = observeSqliteLockAcquisition(record);
    try {
      locker.exec("CREATE TABLE test (id INT); BEGIN IMMEDIATE;");
      contender.exec("PRAGMA busy_timeout = 40");
      const exec = vi.spyOn(contender, "exec");
      expect(() => beginSqliteWrite(contender, "managed-ledger")).toThrow(
        expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 5 }),
      );
      expect(exec).toHaveBeenCalledExactlyOnceWith("BEGIN IMMEDIATE");
      expect(record).toHaveBeenCalledExactlyOnceWith({
        kind: "sqlite",
        operation: "begin-immediate",
        database: "managed-ledger",
        waitMs: expect.any(Number),
        outcome: "busy",
      });
      expect(record.mock.calls[0]?.[0].waitMs).toBeGreaterThanOrEqual(35);
      expect(contender.prepare("PRAGMA busy_timeout").get()).toMatchObject({ timeout: 40 });
      locker.exec("ROLLBACK");
    } finally {
      stop();
      contender.close();
      locker.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("times acquisition only, omits fast acquisitions, and cannot interrupt a write", () => {
    const database = new DatabaseSync(":memory:");
    const sql = new Sql(database);
    const clock = vi.spyOn(performance, "now");
    const record = vi.fn(() => {
      throw new Error("diagnostic fixture");
    });
    const stop = observeSqliteLockAcquisition(record);
    try {
      database.exec("CREATE TABLE test (id INT);");
      clock.mockReturnValueOnce(0).mockReturnValueOnce(2);
      sql.transaction(() => sql.run("INSERT INTO test VALUES (1);"));
      expect(record).not.toHaveBeenCalled();
      clock.mockReturnValueOnce(10).mockReturnValueOnce(17);
      sql.transaction(() => {
        expect(record).toHaveBeenCalledExactlyOnceWith({
          kind: "sqlite",
          operation: "begin-immediate",
          database: "shared-store",
          waitMs: 7,
          outcome: "acquired",
        });
        sql.run("INSERT INTO test VALUES (2);");
      });
      expect(sql.rows("SELECT id FROM test ORDER BY id")).toEqual([{ id: 1n }, { id: 2n }]);
      stop();
      const clockCalls = clock.mock.calls.length;
      sql.transaction(() => {});
      expect(clock).toHaveBeenCalledTimes(clockCalls);
    } finally {
      stop();
      clock.mockRestore();
      database.close();
    }
  });
});
