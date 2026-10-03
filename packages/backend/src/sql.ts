import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { storedTime, utcNow } from "./workspaces";
export type Row = Record<string, unknown>;
export class Sql {
  #statements = new Map<string, StatementSync>();
  constructor(readonly database: DatabaseSync) {}
  #statement(sql: string): StatementSync {
    const cached = this.#statements.get(sql);
    if (cached) return cached;
    const statement = this.database.prepare(sql);
    statement.setReadBigInts(true);
    // Dynamic IN queries can have many shapes. Bound retention per database.
    if (this.#statements.size >= 64) this.#statements.delete(this.#statements.keys().next().value!);
    this.#statements.set(sql, statement);
    return statement;
  }
  rows(sql: string, ...values: SQLInputValue[]): Row[] {
    return this.#statement(sql).all(...values);
  }
  one(sql: string, ...values: SQLInputValue[]): Row | undefined {
    return this.#statement(sql).get(...values);
  }
  run(sql: string, ...values: SQLInputValue[]): void {
    this.#statement(sql).run(...values);
  }
  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  audit(project: string | null, action: string, detail: string): void {
    const at = storedTime(utcNow());
    this.run(
      "INSERT INTO audit_events(id,project_id,action,detail,created_at) VALUES (?,?,?,?,?)",
      randomUUID(),
      project,
      action,
      detail,
      at,
    );
    const code =
      action === "changeset.apply"
        ? "special-first-changeset"
        : action === "memory.review" && detail.endsWith(":approved")
          ? "special-first-memory"
          : null;
    if (code)
      this.run(
        "INSERT INTO achievement_unlocks(code,unlocked_at,rule_version) VALUES (?,?,1) ON CONFLICT(code) DO UPDATE SET unlocked_at=excluded.unlocked_at, rule_version=1 WHERE achievement_unlocks.rule_version=0",
        code,
        at,
      );
  }
}
export function positive(value: unknown): number {
  return Math.max(0, Number(value ?? 0));
}
