import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { RolloutCache, resolveRollout } from "../../../packages/backend/src/codex-rollout-files";
import { CodexSessions } from "../../../packages/backend/src/codex-sessions";
import { readJsonlSearchSource } from "../../../packages/backend/src/history-search-source-jsonl";
import { SessionPaging } from "../../../packages/backend/src/session-paging";

const fixtures: string[] = [];
const nativeId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const parentId = "11111111-2222-4333-8444-555555555555";

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  fixtures.push(directory);
  return directory;
}

/** Deterministic text that compresses poorly, to make long compressed files. */
function noise(seed: number, length: number): string {
  let value = seed,
    text = "";
  while (text.length < length) {
    value = (value * 1103515245 + 12345) % 2 ** 31;
    text += value.toString(36);
  }
  return text.slice(0, length);
}

/** A synthetic Codex rollout: the session header, then [turns] question and answer pairs. */
function rollout(cwd: string, turns = 3, padding = 0, noisy = 0): string {
  const at = (second: number) => new Date(Date.UTC(2026, 9, 1, 8, 0, second)).toISOString();
  const rows: unknown[] = [
    {
      timestamp: at(0),
      type: "session_meta",
      payload: { id: nativeId, cwd, source: "cli", forked_from_id: parentId },
    },
  ];
  for (let turn = 1; turn <= turns; turn++) {
    const turn_id = `turn-${turn}`;
    rows.push(
      { timestamp: at(turn), type: "event_msg", payload: { type: "task_started", turn_id } },
      {
        timestamp: at(turn),
        type: "event_msg",
        payload: { type: "user_message", message: `Synthetic question ${turn}`, turn_id },
      },
      {
        timestamp: at(turn),
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: `Synthetic answer ${turn} ${"x".repeat(padding)}${noise(turn, noisy)}`,
          turn_id,
        },
      },
      { timestamp: at(turn), type: "event_msg", payload: { type: "task_complete", turn_id } },
    );
  }
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

/**
 * A Codex home whose thread row names `rollout-….jsonl`. [stored] says which
 * spellings exist on disk; [recorded] which one the row names.
 */
function codexHome(
  options: {
    stored?: Array<"plain" | "compressed">;
    recorded?: "plain" | "compressed";
    turns?: number;
    padding?: number;
    noisy?: number;
  } = {},
) {
  const root = temporary("agentkib-codex-zst-");
  const home = path.join(root, "home"),
    codex = path.join(home, ".codex"),
    workspace = path.join(root, "workspace"),
    plain = path.join(codex, "sessions", "2026", "10", "01", `rollout-${nativeId}.jsonl`);
  mkdirSync(path.dirname(plain), { recursive: true });
  mkdirSync(workspace);
  const body = rollout(workspace, options.turns, options.padding, options.noisy);
  const stored = options.stored ?? ["compressed"];
  if (stored.includes("plain")) writeFileSync(plain, body);
  if (stored.includes("compressed")) writeFileSync(`${plain}.zst`, zstdCompressSync(body));
  const db = new DatabaseSync(path.join(codex, "state_5.sqlite"));
  try {
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, source TEXT, archived INTEGER)",
    );
    db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?)").run(
      nativeId,
      options.recorded === "compressed" ? `${plain}.zst` : path.relative(codex, plain),
      workspace,
      "Synthetic conversation",
      "cli",
      0,
    );
  } finally {
    db.close();
  }
  const reader = new CodexSessions({ HOME: home, USERPROFILE: home, CODEX_HOME: codex });
  return { root, codex, workspace, plain, body, reader };
}

const listed = (reader: CodexSessions) => reader.list(null).sessions;

function usageReport(usedTokens: number, contextWindow: number) {
  return JSON.stringify({
    timestamp: "2026-10-01T08:30:00.123Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { total_tokens: usedTokens },
        total_token_usage: { total_tokens: 900_000 },
        model_context_window: contextWindow,
      },
    },
  });
}

function setIndexedModel(codex: string, model: string, effort: string) {
  const db = new DatabaseSync(path.join(codex, "state_5.sqlite"));
  try {
    db.exec(
      "ALTER TABLE threads ADD COLUMN model TEXT; ALTER TABLE threads ADD COLUMN reasoning_effort TEXT;",
    );
    db.prepare("UPDATE threads SET model=?, reasoning_effort=? WHERE id=?").run(
      model,
      effort,
      nativeId,
    );
  } finally {
    db.close();
  }
}

describe("historical Codex display settings", () => {
  it.each(["plain", "compressed"] as const)(
    "reads the latest valid report in a %s rollout",
    (stored) => {
      const f = codexHome({ stored: [stored] });
      setIndexedModel(f.codex, "next-model", "low");
      const turn = JSON.stringify({
        type: "turn_context",
        payload: { model: "last-model", effort: "xhigh" },
      });
      const data = `${f.body}${turn}\n${usageReport(70_000, 258_400)}\n${usageReport(75_584, 258_400)}\n${usageReport(100_000, 0)}\n${usageReport(102_000, 258_400)}`;
      if (stored === "compressed") writeFileSync(`${f.plain}.zst`, zstdCompressSync(data));
      else writeFileSync(f.plain, data);
      expect(f.reader.historicalSettings(nativeId, f.workspace)).toEqual({
        modelId: "last-model",
        effort: "xhigh",
        usage: {
          usedTokens: 75_584,
          contextWindow: 258_400,
          updatedAt: "2026-10-01T08:30:00.123Z",
        },
      });
      expect(readdirSync(path.dirname(f.plain))).toEqual([
        path.basename(f.plain) + (stored === "compressed" ? ".zst" : ""),
      ]);
    },
  );

  it("reads a bounded plain tail and invalidates a cached report when the rollout changes", () => {
    const f = codexHome({ stored: ["plain"] });
    setIndexedModel(f.codex, "indexed-model", "medium");
    const largeEntry = JSON.stringify({
      type: "response_item",
      payload: { value: "x".repeat(1024 * 1024) },
    });
    const data = `${f.body}${usageReport(5, 100)}\n${largeEntry}\n`;
    writeFileSync(f.plain, data);
    expect(f.reader.historicalSettings(nativeId, f.workspace)).toEqual({
      modelId: "indexed-model",
      effort: "medium",
    });
    writeFileSync(f.plain, `${data}${usageReport(0, 100)}\n`);
    expect(f.reader.historicalSettings(nativeId, f.workspace)?.usage).toMatchObject({
      usedTokens: 0,
      contextWindow: 100,
    });
  });

  it("uses only the indexed settings when a compressed history exceeds the decode budget", () => {
    const f = codexHome({ turns: 16, padding: 512 * 1024 });
    setIndexedModel(f.codex, "indexed-model", "medium");
    writeFileSync(`${f.plain}.zst`, zstdCompressSync(`${f.body}${usageReport(75_584, 258_400)}\n`));
    expect(f.reader.historicalSettings(nativeId, f.workspace)).toEqual({
      modelId: "indexed-model",
      effort: "medium",
    });
  });

  it("requires the recorded thread and creation directory to match the verified workspace", () => {
    const f = codexHome({ stored: ["plain"] });
    setIndexedModel(f.codex, "indexed-model", "medium");
    writeFileSync(f.plain, `${f.body}${usageReport(25, 100)}\n`);
    expect(f.reader.historicalSettings(nativeId, f.workspace)?.usage?.usedTokens).toBe(25);
    expect(f.reader.historicalSettings(nativeId, f.codex)).toBeUndefined();
    writeFileSync(f.plain, `${f.body.replace(nativeId, parentId)}${usageReport(35, 100)}\n`);
    expect(f.reader.historicalSettings(nativeId, f.workspace)).toBeUndefined();
  });
});

describe("compressed Codex rollouts", () => {
  it("keep a thread readable after Codex compresses its rollout", () => {
    // Long enough that the header is decoded from a prefix of the file.
    const f = codexHome({ turns: 400, noisy: 400 });
    expect(lstatSync(`${f.plain}.zst`).size).toBeGreaterThan(64 * 1024);
    const [source] = listed(f.reader);
    expect(source?.transcript).toBe(`${f.plain}.zst`);
    expect(source?.session.availability).toBe("readable");
    // The header is decoded from the compressed file.
    expect(source?.session.forked_from_session_id).toBe(parentId);
    expect(f.reader.verifiedControlIds([nativeId])).toEqual(new Set([nativeId]));
    expect(f.reader.verifiedIndexedIdentities([nativeId]).get(nativeId)?.id).toBe(nativeId);
  });

  it("prefer the recorded rollout while it still exists", () => {
    const f = codexHome({ stored: ["plain", "compressed"] });
    expect(listed(f.reader)[0]?.transcript).toBe(f.plain);
    expect(resolveRollout(f.plain)).toBe(f.plain);
  });

  it("read a row that already names the compressed rollout", () => {
    const f = codexHome({ recorded: "compressed" });
    const [source] = listed(f.reader);
    expect(source?.transcript).toBe(`${f.plain}.zst`);
    expect(source?.session.availability).toBe("readable");
  });

  it("verify a small header without decoding its highly compressed full history", () => {
    const f = codexHome({ turns: 70, padding: 512 * 1024 });
    expect(Buffer.byteLength(f.body)).toBeGreaterThan(32 * 1024 * 1024);
    expect(lstatSync(`${f.plain}.zst`).size).toBeLessThan(16 * 1024);
    expect(listed(f.reader)[0]?.session.forked_from_session_id).toBe(parentId);
    expect(f.reader.verifiedControlIds([nativeId])).toEqual(new Set([nativeId]));
    expect(f.reader.verifiedIndexedIdentities([nativeId]).get(nativeId)?.cwd).toBe(f.workspace);
  });

  it("keep the header verification byte limits for compressed rollouts", () => {
    const f = codexHome(),
      oversized = JSON.stringify({
        type: "session_meta",
        payload: {
          id: nativeId,
          cwd: f.workspace,
          source: "cli",
          instructions: "x".repeat(256 * 1024),
        },
      });
    writeFileSync(`${f.plain}.zst`, zstdCompressSync(`${oversized}\n${f.body}`));
    expect(f.reader.verifiedControlIds([nativeId])).toEqual(new Set());
    expect(f.reader.verifiedIndexedIdentities([nativeId]).has(nativeId)).toBe(false);
  });

  it("leave a thread without either rollout as metadata only", () => {
    const f = codexHome({ stored: [] });
    expect(listed(f.reader)[0]?.session.availability).toBe("metadata-only");
  });

  it.skipIf(process.platform === "win32")(
    "do not follow a compressed rollout that is a link",
    () => {
      const f = codexHome({ stored: [] });
      const elsewhere = path.join(f.root, "elsewhere.jsonl.zst");
      writeFileSync(elsewhere, zstdCompressSync(f.body));
      symlinkSync(elsewhere, `${f.plain}.zst`);
      expect(listed(f.reader)[0]?.session.availability).toBe("metadata-only");
      setIndexedModel(f.codex, "indexed-model", "medium");
      expect(f.reader.historicalSettings(nativeId, f.workspace)).toBeUndefined();
    },
  );

  it("page history with the same events and ids from either spelling", async () => {
    const plain = codexHome({ stored: ["plain"], turns: 60 }),
      compressed = codexHome({ turns: 60 }),
      cache = new RolloutCache(temporary("agentkib-rollout-cache-"));
    const pages = async (file: string) => {
      const paging = new SessionPaging(),
        events = [];
      let cursor: string | null = null;
      do {
        const page = paging.read(file, cursor, 25, "codex");
        events.unshift(...page.events);
        cursor = page.next_cursor;
      } while (cursor);
      return events;
    };
    const fromPlain = await pages(plain.plain);
    const copy = await cache.plain(`${compressed.plain}.zst`);
    expect(fromPlain.length).toBeGreaterThan(100);
    expect(await pages(copy)).toEqual(fromPlain);
    // One private copy serves later reads.
    expect(await cache.plain(`${compressed.plain}.zst`)).toBe(copy);
    if (process.platform !== "win32") {
      expect(lstatSync(copy).mode & 0o777).toBe(0o600);
      expect(lstatSync(`${copy}.used`).mode & 0o777).toBe(0o600);
      expect(lstatSync(path.dirname(copy)).mode & 0o777).toBe(0o700);
    }
    // A plain rollout needs no copy.
    expect(await cache.plain(plain.plain)).toBe(plain.plain);
  });

  it("refuse a rollout that decompresses past the size limit and keep no partial copy", async () => {
    const f = codexHome({ turns: 20, padding: 4096 }),
      root = temporary("agentkib-rollout-cache-"),
      cache = new RolloutCache(root, { file: 16 * 1024, total: 1024 ** 2, recentMs: 0 });
    await expect(cache.plain(`${f.plain}.zst`)).rejects.toThrow(
      "TRANSCRIPT_UNREADABLE: decompressed rollout exceeds the cache limit",
    );
    const [directory] = readdirSync(root);
    expect(readdirSync(path.join(root, directory!))).toEqual([]);
  });

  it("keep history cursors valid when every page resolves the compressed cache again", async () => {
    const f = codexHome({ turns: 60 }),
      cache = new RolloutCache(temporary("agentkib-rollout-cache-")),
      paging = new SessionPaging(),
      firstPath = await cache.plain(`${f.plain}.zst`),
      first = paging.read(firstPath, null, 25, "codex"),
      before = lstatSync(firstPath, { bigint: true });
    expect(first.next_cursor).not.toBeNull();
    const secondPath = await cache.plain(`${f.plain}.zst`);
    expect(lstatSync(secondPath, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
    const second = paging.read(secondPath, first.next_cursor, 25, "codex");
    expect(second.events).toHaveLength(25);
    expect(second.next_cursor).not.toBeNull();
  });

  it("keep the first published copy stable across concurrent cache instances", async () => {
    const f = codexHome({ turns: 600 }),
      root = temporary("agentkib-rollout-cache-"),
      caches = [new RolloutCache(root), new RolloutCache(root)],
      paging = new SessionPaging();
    let first: ReturnType<SessionPaging["read"]> | undefined;
    let firstCopy: string | undefined;
    const copies = await Promise.all(
      caches.map(async (cache) => {
        const copy = await cache.plain(`${f.plain}.zst`);
        if (!first) {
          firstCopy = copy;
          first = paging.read(copy, null, 25, "codex");
        }
        return copy;
      }),
    );
    expect(copies).toEqual([firstCopy, firstCopy]);
    expect(first?.next_cursor).not.toBeNull();
    const next = paging.read(firstCopy!, first!.next_cursor, 25, "codex");
    expect(next.events).toHaveLength(25);
  });

  it.skipIf(process.platform === "win32")(
    "reject a cached copy replaced with a symlink",
    async () => {
      const f = codexHome(),
        cache = new RolloutCache(temporary("agentkib-rollout-cache-")),
        copy = await cache.plain(`${f.plain}.zst`),
        elsewhere = path.join(f.root, "elsewhere.jsonl");
      writeFileSync(elsewhere, f.body);
      const before = lstatSync(elsewhere, { bigint: true });
      rmSync(copy);
      symlinkSync(elsewhere, copy);
      await expect(cache.plain(`${f.plain}.zst`)).rejects.toThrow("TRANSCRIPT_UNREADABLE");
      expect(lstatSync(elsewhere, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
    },
  );

  it("evict the least recently used copy beyond the total limit", async () => {
    const first = codexHome({ turns: 30 }),
      second = codexHome({ turns: 30 }),
      cache = new RolloutCache(temporary("agentkib-rollout-cache-"), {
        file: 1024 ** 2,
        total: Buffer.byteLength(first.body) + 1,
        recentMs: 0,
      });
    const older = await cache.plain(`${first.plain}.zst`);
    const newer = await cache.plain(`${second.plain}.zst`);
    expect(existsSync(newer)).toBe(true);
    expect(existsSync(older)).toBe(false);
    expect(existsSync(`${older}.used`)).toBe(false);
  });

  it("preserve copies recently reused by another cache instance", async () => {
    const first = codexHome({ turns: 30 }),
      second = codexHome({ turns: 30 }),
      root = temporary("agentkib-rollout-cache-"),
      limits = { file: 1024 ** 2, total: Buffer.byteLength(first.body) + 1, recentMs: 60_000 },
      original = new RolloutCache(root, limits),
      other = new RolloutCache(root, limits),
      copy = await original.plain(`${first.plain}.zst`),
      stale = new Date(Date.now() - 120_000);
    utimesSync(`${copy}.used`, stale, stale);
    expect(await other.plain(`${first.plain}.zst`)).toBe(copy);
    await original.plain(`${second.plain}.zst`);
    expect(existsSync(copy)).toBe(true);
  });

  it("index full text the same from either spelling", async () => {
    const plain = codexHome({ stored: ["plain"], turns: 40 }),
      compressed = codexHome({ turns: 40 });
    const contents = async (file: string) => {
      const found: string[] = [];
      await readJsonlSearchSource(file, "codex", {
        emit: async (record) => {
          found.push(record.content);
        },
        checkpoint: () => {},
        fingerprint: () => {},
        limit: () => {},
      });
      return found;
    };
    const fromPlain = await contents(plain.plain);
    expect(fromPlain.length).toBeGreaterThan(40);
    expect(await contents(`${compressed.plain}.zst`)).toEqual(fromPlain);
  });
});
