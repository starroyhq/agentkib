import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Commands } from "./commands";

export type UsageQuality = "exact" | "estimated" | "incomplete";
export type DatePrecision = "exact" | "day" | "aggregate";

export interface UsageEvent {
  source_key: string;
  surface_agent: string;
  workspace_path: string | null;
  occurred_at: string | null;
  day: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  session_key: string | null;
  session_count: number;
  date_precision: DatePrecision;
  quality: UsageQuality;
  source_id?: string;
  workspace_id?: string | null;
}

export interface UsageBatch {
  agent: string;
  events: UsageEvent[];
  cursor: string | null;
  unchanged: boolean;
  status: {
    available: boolean;
    quality: UsageQuality;
    coverage_from: string | null;
    coverage_to: string | null;
    imported_events: number;
    error_key?: string;
    error?: string;
  };
}

type Provider = (
  cursor: string | null,
  context: { home: string; environment: NodeJS.ProcessEnv; commands: Commands },
) => Promise<UsageBatch>;

const validDay = (value: unknown) => {
  if (typeof value !== "string") return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(`${day}T00:00:00.000Z`)) &&
    new Date(`${day}T00:00:00.000Z`).toISOString().startsWith(day)
    ? day
    : null;
};
const number = (value: unknown) => {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER)
    : 0;
};
const field = (value: unknown, key: string) =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
const fingerprint = async (files: string[], sqlite = false) => {
  const hash = createHash("sha256");
  for (const file of files.slice().sort()) {
    const related = sqlite ? [file, `${file}-wal`, `${file}-shm`] : [file];
    for (const source of related) {
      hash.update(source);
      try {
        const info = await stat(source, { bigint: true });
        const size = Buffer.alloc(8);
        size.writeBigUInt64LE(info.size);
        hash.update(size);
        const modified = Buffer.alloc(16);
        let nanos = info.mtimeNs;
        for (let index = 0; index < modified.length; index++) {
          modified[index] = Number(nanos & 0xffn);
          nanos >>= 8n;
        }
        hash.update(modified);
      } catch {
        // Rust hashes the source path for missing files, with no metadata bytes.
      }
    }
  }
  return hash.digest("hex");
};
const complete = (agent: string, events: UsageEvent[], cursor: string | null): UsageBatch => {
  const days = events
    .map((event) => event.day)
    .filter((day): day is string => day !== null)
    .sort();
  const rank: Record<UsageQuality, number> = { exact: 0, estimated: 1, incomplete: 2 };
  const quality = events.reduce<UsageQuality>(
    (current, event) => (rank[event.quality] > rank[current] ? event.quality : current),
    "exact",
  );
  return {
    agent,
    events,
    cursor,
    unchanged: false,
    status: {
      available: true,
      quality: events.length ? quality : "incomplete",
      coverage_from: days[0] ?? null,
      coverage_to: days.at(-1) ?? null,
      imported_events: events.length,
    },
  };
};
const unchanged = (agent: string, cursor: string): UsageBatch => ({
  agent,
  events: [],
  cursor,
  unchanged: true,
  status: {
    available: true,
    quality: "exact",
    coverage_from: null,
    coverage_to: null,
    imported_events: 0,
  },
});
const fromFile = async (
  agent: string,
  file: string,
  cursor: string | null,
  parse: (value: unknown) => UsageEvent[],
) => {
  const current = await fingerprint([file]);
  if (cursor === current) return unchanged(agent, current);
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  const events = parse(value);
  if (!events.length) throw new Error(`${agent} usage source has no usable data`);
  return complete(agent, events, current);
};

const claude: Provider = async (cursor, { home }) =>
  fromFile("claude-code", path.join(home, ".claude", "stats-cache.json"), cursor, (raw) => {
    const value = raw as Record<string, unknown>;
    const events: UsageEvent[] = [];
    const daily = Array.isArray(value.dailyModelTokens) ? value.dailyModelTokens : [];
    for (const item of daily) {
      const day = validDay(field(item, "date"));
      const models = field(item, "tokensByModel");
      if (!day || !models || typeof models !== "object" || Array.isArray(models)) continue;
      for (const [model, tokens] of Object.entries(models))
        events.push({
          source_key: `claude:daily:${day}:${model}`,
          surface_agent: "claude-code",
          workspace_path: null,
          occurred_at: null,
          day,
          model,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: number(tokens),
          session_key: null,
          session_count: 0,
          date_precision: "day",
          quality: "exact",
        });
    }
    const activities = Array.isArray(value.dailyActivity) ? value.dailyActivity : [];
    for (const item of activities) {
      const day = validDay(field(item, "date")),
        sessions = number(field(item, "sessionCount"));
      if (day && sessions)
        events.push({
          source_key: `claude:sessions:${day}`,
          surface_agent: "claude-code",
          workspace_path: null,
          occurred_at: null,
          day,
          model: null,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: 0,
          session_key: null,
          session_count: sessions,
          date_precision: "day",
          quality: "exact",
        });
    }
    const models = value.modelUsage;
    if (models && typeof models === "object" && !Array.isArray(models)) {
      const hasDailyTokens = events.some((event) => event.total_tokens > 0);
      for (const [model, usage] of Object.entries(models)) {
        const input = number(field(usage, "inputTokens")),
          output = number(field(usage, "outputTokens"));
        const cacheRead = number(field(usage, "cacheReadInputTokens")),
          cacheWrite = number(field(usage, "cacheCreationInputTokens"));
        if (input + output + cacheRead + cacheWrite === 0) continue;
        events.push({
          source_key: `claude:model-aggregate:${model}`,
          surface_agent: "claude-code",
          workspace_path: null,
          occurred_at: null,
          day: null,
          model,
          input_tokens: input,
          output_tokens: output,
          cache_read_tokens: cacheRead,
          cache_write_tokens: cacheWrite,
          reasoning_tokens: 0,
          total_tokens: hasDailyTokens ? 0 : input + output,
          session_key: null,
          session_count: 0,
          date_precision: "aggregate",
          quality: hasDailyTokens ? "exact" : "incomplete",
        });
      }
    }
    return events;
  });

function collectOpenClaw(
  value: unknown,
  inheritedAgent: string | null,
  events: UsageEvent[],
  key: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      collectOpenClaw(child, inheritedAgent, events, `${key}:${index}`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  const agentValue = object.agent ?? object.agentId;
  const agent = typeof agentValue === "string" ? agentValue : inheritedAgent;
  const day = validDay(object.date ?? object.day);
  const total = number(object.totalTokens ?? object.total_tokens ?? object.tokens);
  if (day && total > 0) {
    const model = typeof object.model === "string" ? object.model : "all";
    const channel = typeof object.channel === "string" ? object.channel : "all";
    events.push({
      source_key: `openclaw:${day}:${agent ?? "all"}:${model}:${channel}`,
      surface_agent: "open-claw",
      workspace_path: null,
      occurred_at: null,
      day,
      model: model === "all" ? null : model,
      input_tokens: number(object.inputTokens),
      output_tokens: number(object.outputTokens),
      cache_read_tokens: number(object.cacheReadTokens),
      cache_write_tokens: number(object.cacheWriteTokens),
      reasoning_tokens: number(object.reasoningTokens),
      total_tokens: total,
      session_key: null,
      session_count: number(object.sessions),
      date_precision: "day",
      quality: "exact",
    });
    return;
  }
  for (const [childKey, child] of Object.entries(object))
    collectOpenClaw(child, agent, events, `${key}:${childKey}`);
}

const openClaw: Provider = async (_cursor, { commands }) => {
  const output = await commands.run(
    "openclaw",
    ["gateway", "usage-cost", "--all-agents", "--json"],
    { timeout: 10_000, limit: 4 * 1024 * 1024, strictOutput: true },
  );
  const events: UsageEvent[] = [];
  collectOpenClaw(JSON.parse(output.bytes.toString("utf8")), null, events, "root");
  if (!events.length) throw new Error("OpenClaw did not return usable daily token data");
  return complete("open-claw", events, null);
};

const deepSeek: Provider = async (cursor, { home, environment }) => {
  const root = environment.DSH_HOME || path.join(home, ".dsh");
  const file = path.join(root, "storages", "session_projcache.json");
  return fromFile("deepseek-harness", file, cursor, (value) => {
    const unit = field(value, "unit");
    if (field(unit, "name") !== "session_projcache" || number(field(unit, "version")) !== 3)
      throw new Error("DeepSeek Harness projection cache version is not supported");
    const tables = field(value, "tables"),
      sessions = field(tables, "sessions");
    if (!sessions || typeof sessions !== "object" || Array.isArray(sessions))
      throw new Error("DeepSeek Harness projection cache has no sessions table");
    const events: UsageEvent[] = [];
    for (const [id, record] of Object.entries(sessions)) {
      const rows = field(record, "rows"),
        tokenUsage = field(rows, "tokenUsage"),
        val = field(tokenUsage, "val"),
        totals = field(val, "totals");
      if (number(field(tokenUsage, "ver")) !== 1 || !totals) continue;
      const input = number(field(totals, "uncachedInputTokens")),
        output = number(field(totals, "outputTokens"));
      const cacheRead = number(field(totals, "cacheReadTokens")),
        cacheWrite = number(field(totals, "cacheWriteTokens"));
      const total = input + output + cacheRead + cacheWrite;
      if (!total) continue;
      const identity = field(record, "identity");
      events.push({
        source_key: `deepseek-harness:${id}`,
        surface_agent: "deepseek-harness",
        workspace_path:
          typeof field(identity, "cwd") === "string" ? (field(identity, "cwd") as string) : null,
        occurred_at: null,
        day: null,
        model: null,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        reasoning_tokens: 0,
        total_tokens: total,
        session_key: id,
        session_count: 1,
        date_precision: "aggregate",
        quality: "incomplete",
      });
    }
    return events;
  });
};

async function hermesFiles(home: string): Promise<string[]> {
  const root = path.join(home, ".hermes"),
    files: string[] = [];
  const state = path.join(root, "state.db");
  try {
    if ((await stat(state)).isFile()) files.push(state);
  } catch {
    /* unavailable */
  }
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === "state.db") files.push(candidate);
      else if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(candidate, depth + 1);
    }
  };
  await visit(path.join(root, "profiles"), 0);
  return [...new Set(files)].sort();
}

const hermes: Provider = async (cursor, { home }) => {
  const files = await hermesFiles(home);
  if (!files.length) throw new Error("Hermes is not installed or state.db was not found");
  const current = await fingerprint(files, true);
  if (cursor === current) return unchanged("hermes", current);
  const events: UsageEvent[] = [];
  for (const file of files) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      if (!columns.length) continue;
      const names = new Set(columns.map((column) => column.name));
      const pick = (candidates: string[]) => candidates.find((candidate) => names.has(candidate));
      const id = pick(["id", "session_id"]),
        cwd = pick(["cwd", "working_directory", "project_path"]),
        timestamp = pick(["updated_at", "created_at", "timestamp"]),
        model = pick(["model"]);
      const input = pick(["input_tokens"]),
        output = pick(["output_tokens"]),
        cacheRead = pick(["cache_read_tokens"]),
        cacheWrite = pick(["cache_write_tokens"]),
        reasoning = pick(["reasoning_tokens"]);
      const fields = [
        "id",
        "cwd",
        "timestamp",
        "model",
        "input",
        "output",
        "cache_read",
        "cache_write",
        "reasoning",
      ];
      const select = [id, cwd, timestamp, model, input, output, cacheRead, cacheWrite, reasoning]
        .map((column, index) => `${column ? `"${column}"` : "NULL"} AS "${fields[index]}"`)
        .join(",");
      const rows = db.prepare(`SELECT ${select} FROM sessions`).all() as Array<
        Record<string, unknown>
      >;
      for (const [index, row] of rows.entries()) {
        const tokensIn = number(row.input),
          tokensOut = number(row.output),
          total = tokensIn + tokensOut;
        if (!total) continue;
        const at = typeof row.timestamp === "string" ? row.timestamp : null;
        const parsed = at ? new Date(at) : null,
          validAt = parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
        const localDay = validAt
          ? `${validAt.getFullYear()}-${String(validAt.getMonth() + 1).padStart(2, "0")}-${String(validAt.getDate()).padStart(2, "0")}`
          : null;
        const sessionId = typeof row.id === "string" ? row.id : null;
        events.push({
          source_key: `hermes:${file}:${sessionId ?? index}`,
          surface_agent: "hermes",
          workspace_path: typeof row.cwd === "string" ? row.cwd : null,
          occurred_at: validAt?.toISOString() ?? null,
          day: localDay,
          model: typeof row.model === "string" ? row.model : null,
          input_tokens: tokensIn,
          output_tokens: tokensOut,
          cache_read_tokens: number(row.cache_read),
          cache_write_tokens: number(row.cache_write),
          reasoning_tokens: number(row.reasoning),
          total_tokens: total,
          session_key: sessionId,
          session_count: 1,
          date_precision: validAt ? "exact" : "aggregate",
          quality: "exact",
        });
      }
    } finally {
      db.close();
    }
  }
  if (!events.length) throw new Error("Hermes state.db does not contain usable session statistics");
  return complete("hermes", events, current);
};

export async function collectUsage(
  cursors: Map<string, string>,
  context: { home?: string; environment?: NodeJS.ProcessEnv; commands: Commands },
): Promise<UsageBatch[]> {
  const home = context.home ?? context.environment?.HOME ?? process.env.HOME ?? homedir();
  const environment = context.environment ?? process.env;
  const providers: Array<[string, Provider]> = [
    ["claude-code", claude],
    ["open-claw", openClaw],
    ["hermes", hermes],
    ["deepseek-harness", deepSeek],
  ];
  const output: UsageBatch[] = [];
  const concurrency = availableParallelism() <= 4 ? 1 : 2;
  for (let offset = 0; offset < providers.length; offset += concurrency) {
    const group = providers.slice(offset, offset + concurrency);
    output.push(
      ...(await Promise.all(
        group.map(async ([agent, provider]) => {
          try {
            return await provider(cursors.get(agent) ?? null, {
              home,
              environment,
              commands: context.commands,
            });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return {
              agent,
              events: [],
              cursor: null,
              unchanged: false,
              status: {
                available: false,
                quality: "incomplete",
                coverage_from: null,
                coverage_to: null,
                imported_events: 0,
                error_key:
                  agent === "deepseek-harness" && detail.includes("version is not supported")
                    ? "errors.deepseekProjectionVersion"
                    : "errors.providerUnavailable",
                error: detail,
              },
            } satisfies UsageBatch;
          }
        }),
      )),
    );
  }
  return output;
}
