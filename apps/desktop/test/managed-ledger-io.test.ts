import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  claimManagedCommand,
  listManagedRecords,
  managedSessionHasUnknownCommands,
  openManagedLedger,
  readManagedCatalogSnapshot,
  readManagedEvents,
  readManagedRecord,
  readUnknownManagedCommands,
  replayManagedCommand,
  retainManagedLedgerReaders,
  saveManagedRecord,
} from "../../../packages/backend/src/managed-ledger";

const cleanups: Array<() => void> = [];
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "agentkib-ledger-io-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, "codex-managed", "executions.sqlite") };
}
function retain(dir: string) {
  const release = retainManagedLedgerReaders(dir);
  cleanups.push(release);
  return release;
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("managed ledger reader lifetime", () => {
  it("does not create a ledger during reads, even with a retained runtime", () => {
    const { dir, file } = fixture();
    retain(dir);
    expect(readManagedRecord(dir, "a")).toBeNull();
    expect(listManagedRecords(dir)).toEqual([]);
    expect(readManagedCatalogSnapshot(dir)).toEqual({ records: [], complete: true });
    expect(replayManagedCommand(dir, "request", "input")).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it("reads existing records and legacy receipts without migrating or chmodding", () => {
    const { dir, file } = fixture();
    saveManagedRecord(dir, { id: "a", title: "original" });
    const legacy = new DatabaseSync(file);
    legacy.exec("DROP TABLE managed_events; DROP TABLE managed_commands");
    legacy.close();
    if (process.platform !== "win32") chmodSync(file, 0o640);
    const before = statSync(file, { bigint: true });
    retain(dir);
    expect(readManagedRecord(dir, "a")).toMatchObject({ title: "original" });
    expect(listManagedRecords(dir)).toHaveLength(1);
    expect(readManagedCatalogSnapshot(dir).complete).toBe(true);
    expect(replayManagedCommand(dir, "request", "input")).toBeNull();
    expect(managedSessionHasUnknownCommands(dir, "a")).toBe(false);
    expect(readUnknownManagedCommands(dir, "a")).toEqual([]);
    expect(readManagedEvents(dir, "a", null, 50).events).toEqual([]);
    const after = statSync(file, { bigint: true });
    expect(after.mode).toBe(before.mode);
    expect(after.ctimeNs).toBe(before.ctimeNs);
    const check = new DatabaseSync(file, { readOnly: true });
    expect(
      check.prepare("SELECT name FROM sqlite_master WHERE name='managed_commands'").get(),
    ).toBeUndefined();
    check.close();
    // Actual writes still upgrade the old schema and restrict its permissions.
    expect(
      claimManagedCommand(dir, "request", "a", "input", null, { operation: "send" }),
    ).toBeNull();
    expect(replayManagedCommand(dir, "request", "input")).toMatchObject({
      reason: "request-interrupted",
    });
    if (process.platform !== "win32") expect(Number(statSync(file).mode) & 0o777).toBe(0o600);
  });

  it("reads committed data while another connection holds the writer lock", () => {
    const { dir, file } = fixture();
    saveManagedRecord(dir, { id: "a", title: "before" });
    retain(dir);
    const writer = new DatabaseSync(file);
    try {
      writer.exec("BEGIN IMMEDIATE");
      writer
        .prepare("UPDATE managed_sessions SET record=? WHERE id='a'")
        .run(JSON.stringify({ id: "a", title: "after" }));
      expect(readManagedRecord(dir, "a")).toMatchObject({ title: "before" });
      expect(listManagedRecords(dir)).toEqual([{ id: "a", title: "before" }]);
      expect(readManagedCatalogSnapshot(dir).records).toEqual([{ id: "a", title: "before" }]);
      // Opening an up-to-date writer must not perform DDL or BEGIN IMMEDIATE.
      openManagedLedger(dir)!.close();
      writer.exec("COMMIT");
      expect(readManagedRecord(dir, "a")).toMatchObject({ title: "after" });
    } finally {
      writer.close();
    }
  });

  it("keeps shared readers until the final owner releases and detects replacement", () => {
    const { dir, file } = fixture();
    saveManagedRecord(dir, { id: "a", title: "before" });
    const first = retain(dir);
    const second = retain(dir);
    expect(readManagedRecord(dir, "a")).toMatchObject({ title: "before" });
    first();
    first();
    saveManagedRecord(dir, { id: "a", title: "after" });
    expect(readManagedRecord(dir, "a")).toMatchObject({ title: "after" });
    second();
    // With no retained reader there are no handles preventing a move on Windows.
    renameSync(file, `${file}.old`);
    saveManagedRecord(dir, { id: "a", title: "replacement" });
    retain(dir);
    expect(readManagedRecord(dir, "a")).toMatchObject({ title: "replacement" });
    const existing = new DatabaseSync(file);
    existing.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    existing.close();
    if (process.platform !== "win32") {
      // Unix permits atomically replacing an open file; a reader must not stick to its inode.
      const fresh = `${file}.new`;
      const replacement = new DatabaseSync(fresh);
      replacement.exec("CREATE TABLE managed_sessions(id TEXT PRIMARY KEY,record TEXT NOT NULL)");
      replacement
        .prepare("INSERT INTO managed_sessions VALUES('a',?)")
        .run(JSON.stringify({ id: "a", title: "atomic" }));
      replacement.close();
      renameSync(fresh, file);
      expect(readManagedRecord(dir, "a")).toMatchObject({ title: "atomic" });
    }
  });

  it("can cycle more than four directories and reopen evicted readers", () => {
    const dirs = Array.from({ length: 6 }, (_, i) => {
      const { dir } = fixture();
      saveManagedRecord(dir, { id: "a", title: String(i) });
      retain(dir);
      return dir;
    });
    for (let pass = 0; pass < 2; pass += 1)
      dirs.forEach((dir, i) =>
        expect(readManagedRecord(dir, "a")).toMatchObject({ title: String(i) }),
      );
  });
});
