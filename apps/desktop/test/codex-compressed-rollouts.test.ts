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
import {
  RolloutCache,
  resolveRollout,
} from "../../../packages/backend/src/agents/codex/codex-rollout-files";
import { CodexSessions } from "../../../packages/backend/src/agents/codex/codex-sessions";
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
    filenameSuffix?: string;
  } = {},
) {
  const root = temporary("agentkib-codex-zst-");
  const home = path.join(root, "home"),
    codex = path.join(home, ".codex"),
    workspace = path.join(root, "workspace"),
    plain = path.join(
      codex,
      "sessions",
      "2026",
      "10",
      "01",
      `rollout-${nativeId}${options.filenameSuffix ?? ""}.jsonl`,
    );
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
      nativePolicy: { policyId: null, reason: "native-policy-unconfirmed" },
    });
    writeFileSync(f.plain, `${data}${usageReport(0, 100)}\n`);
    expect(f.reader.historicalSettings(nativeId, f.workspace)?.usage).toMatchObject({
      usedTokens: 0,
      contextWindow: 100,
    });
  });

  it("keeps the indexed model and marks the policy unconfirmed past the compressed decode budget", () => {
    const f = codexHome({ turns: 16, padding: 512 * 1024 });
    setIndexedModel(f.codex, "indexed-model", "medium");
    writeFileSync(`${f.plain}.zst`, zstdCompressSync(`${f.body}${usageReport(75_584, 258_400)}\n`));
    expect(f.reader.historicalSettings(nativeId, f.workspace)).toEqual({
      modelId: "indexed-model",
      effort: "medium",
      nativePolicy: { policyId: null, reason: "native-policy-unconfirmed" },
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

describe("Codex native rollout policy", () => {
  const turnContext = (payload: Record<string, unknown>) =>
    JSON.stringify({ type: "turn_context", payload }) + "\n";
  const fullAccess = { approval_policy: "never", sandbox_policy: { type: "danger-full-access" } };
  const workspaceWrite = {
    type: "workspace-write",
    writable_roots: [],
    network_access: false,
    exclude_tmpdir_env_var: true,
    exclude_slash_tmp: true,
  };

  it.each(["plain", "compressed"] as const)(
    "reads the latest policy from a verified %s rollout without requiring a model",
    (stored) => {
      const f = codexHome({ stored: [stored] });
      const data =
        f.body + turnContext({ approval_policy: "on-request" }) + turnContext(fullAccess);
      if (stored === "compressed") writeFileSync(`${f.plain}.zst`, zstdCompressSync(data));
      else writeFileSync(f.plain, data);
      expect(f.reader.historicalSettings(nativeId, f.workspace)).toEqual({
        nativePolicy: { policyId: "full-access-on-request" },
      });
      expect(f.reader.historicalSettings(nativeId, f.codex)).toBeUndefined();
    },
  );

  it.each([
    ["user", "workspace-write-on-request"],
    ["auto_review", "workspace-write-auto-review"],
    ["agent", "workspace-write-auto-review"],
  ])("maps a workspace-only sandbox with reviewer %s", (approvals_reviewer, policyId) => {
    const f = codexHome({ stored: ["plain"] });
    writeFileSync(
      f.plain,
      f.body +
        turnContext({
          approval_policy: "on-request",
          approvals_reviewer,
          sandbox_policy: { ...workspaceWrite, writable_roots: [f.workspace] },
        }),
    );
    expect(f.reader.historicalSettings(nativeId, f.workspace)?.nativePolicy).toEqual({
      policyId,
    });
  });

  it.each([
    ["approval", { approval_policy: "on-failure" }, {}, "approval-policy"],
    ["reviewer", { approvals_reviewer: "other-reviewer" }, {}, "approvals-reviewer"],
    ["missing reviewer", { approvals_reviewer: undefined }, {}, "approvals-reviewer"],
    ["type", {}, { type: "read-only" }, "sandbox-type"],
    ["network", {}, { network_access: true }, "sandbox-network"],
    ["TMPDIR", {}, { exclude_tmpdir_env_var: false }, "sandbox-tmpdir"],
    ["/tmp", {}, { exclude_slash_tmp: false }, "sandbox-slash-tmp"],
    ["restricted reads", {}, { read_only_access: { type: "restricted" } }, "sandbox-read-access"],
  ])(
    "reports the mismatched native %s without exposing raw values",
    (_, approval, sandbox, reason) => {
      const f = codexHome({ stored: ["plain"] });
      writeFileSync(
        f.plain,
        f.body +
          turnContext({
            approval_policy: "on-request",
            approvals_reviewer: "user",
            ...approval,
            sandbox_policy: { ...workspaceWrite, ...sandbox },
          }),
      );
      expect(f.reader.historicalSettings(nativeId, f.workspace)?.nativePolicy).toEqual({
        policyId: null,
        reason: `native-policy-${reason}-mismatch`,
      });
    },
  );

  it("rejects an actual extra writable directory without projecting its path", () => {
    const f = codexHome({ stored: ["plain"] });
    writeFileSync(
      f.plain,
      f.body +
        turnContext({
          approval_policy: "on-request",
          approvals_reviewer: "user",
          sandbox_policy: { ...workspaceWrite, writable_roots: [f.workspace, f.codex] },
        }),
    );
    expect(f.reader.historicalSettings(nativeId, f.workspace)?.nativePolicy).toEqual({
      policyId: null,
      reason: "native-policy-sandbox-writable-roots-mismatch",
    });
  });

  it("requires the native turn cwd to match the verified session directory", () => {
    const f = codexHome({ stored: ["plain"] });
    writeFileSync(f.plain, f.body + turnContext({ ...fullAccess, cwd: f.codex }));
    expect(f.reader.historicalSettings(nativeId, f.workspace)?.nativePolicy).toEqual({
      policyId: null,
      reason: "native-policy-cwd-mismatch",
    });
  });

  it("uses the verified narrower rollout directory for policy without projecting model history", () => {
    const f = codexHome({ stored: ["compressed"] });
    const cwd = path.join(f.workspace, "original-project");
    mkdirSync(cwd);
    setIndexedModel(f.codex, "indexed-model", "low");
    const [header, ...history] = f.body.trimEnd().split("\n");
    const first = JSON.parse(header!);
    first.payload.cwd = cwd;
    writeFileSync(
      `${f.plain}.zst`,
      zstdCompressSync(
        [JSON.stringify(first), ...history, usageReport(30, 100), ""].join("\n") +
          turnContext({ ...fullAccess, cwd, model: "rollout-model", effort: "high" }),
      ),
    );
    expect(f.reader.verifiedIndexedIdentities([nativeId]).has(nativeId)).toBe(false);
    expect(f.reader.verifiedControlDirectories([nativeId]).get(nativeId)).toEqual({
      id: nativeId,
      cwd,
    });
    const expected = { nativePolicy: { policyId: "full-access-on-request" } };
    expect(f.reader.historicalSettings(nativeId, f.workspace)).toEqual(expected);
    expect(f.reader.historicalSettings(nativeId, f.workspace)).toEqual(expected);
    expect(f.reader.historicalSettings(nativeId, f.codex)).toBeUndefined();
  });

  it("distinguishes a complete legacy rollout from unverified policy evidence", () => {
    const f = codexHome({ stored: ["plain"] });
    expect(f.reader.historicalSettings(nativeId, f.workspace)).toEqual({});

    const largeEntry = JSON.stringify({
      type: "response_item",
      payload: { value: "x".repeat(8 * 1024 * 1024) },
    });
    const data = f.body + turnContext(fullAccess) + largeEntry + "\n";
    writeFileSync(f.plain, data);
    expect(f.reader.historicalSettings(nativeId, f.workspace)?.nativePolicy).toEqual({
      policyId: null,
      reason: "native-policy-unconfirmed",
    });
    writeFileSync(f.plain, data + turnContext(fullAccess));
    expect(f.reader.historicalSettings(nativeId, f.workspace)?.nativePolicy).toEqual({
      policyId: "full-access-on-request",
    });
  });

  it("recovers the latest native policy beyond the display tail from an indexed dual-ID rollout", () => {
    const f = codexHome({ stored: ["plain"], filenameSuffix: `_${parentId}` });
    setIndexedModel(f.codex, "indexed-model", "medium");
    const remainingAfterContext = JSON.stringify({
      type: "response_item",
      payload: { value: "x".repeat(832_000) },
    });
    const data =
      f.body +
      turnContext({ approval_policy: "on-request", sandbox_policy: { type: "read-only" } }) +
      turnContext({
        ...fullAccess,
        approvals_reviewer: "user",
        model: "older-rollout-model",
        effort: "high",
      }) +
      usageReport(25, 100) +
      "\n" +
      remainingAfterContext +
      "\n";
    writeFileSync(f.plain, data);
    expect(f.reader.historicalSettings(nativeId, f.workspace)).toEqual({
      modelId: "indexed-model",
      effort: "medium",
      nativePolicy: { policyId: "full-access-on-request" },
    });
    expect(f.reader.historicalSettings(parentId, f.workspace)).toBeUndefined();
    writeFileSync(f.plain, data + turnContext({ model: "newer-context-without-policy" }));
    expect(f.reader.historicalSettings(nativeId, f.workspace)?.nativePolicy).toEqual({
      policyId: null,
      reason: "native-policy-unconfirmed",
    });
  });

  it.each([
    turnContext({ model: "recent-model" }),
    turnContext({ sandbox_policy: null }),
    '{"type":"turn_context","payload":]\n',
    '{"type":"turn_context","payload":',
  ])(
    "prefers an unconfirmed policy over an older mapped policy after an incomplete context",
    (tail) => {
      const f = codexHome({ stored: ["plain"] });
      const data = f.body + turnContext(fullAccess);
      writeFileSync(f.plain, data);
      expect(f.reader.historicalSettings(nativeId, f.workspace)?.nativePolicy).toEqual({
        policyId: "full-access-on-request",
      });
      writeFileSync(f.plain, data + tail);
      expect(f.reader.historicalSettings(nativeId, f.workspace)?.nativePolicy).toEqual({
        policyId: null,
        reason: "native-policy-unconfirmed",
      });
    },
  );
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
