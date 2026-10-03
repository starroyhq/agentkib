import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { SessionDocument } from "./session-model";

export const handoffFormat = z.enum(["markdown", "json"]);
export const DEFAULT_HISTORY_BUDGET_TOKENS = 120_000;
export const HISTORY_BUDGET_OPTIONS = [64_000, 120_000, 180_000] as const;
const maximumBytes = 256 * 1024 * 1024;
const maximumActiveBlockTokens = 16_000;
const sensitiveKeys = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "cookies",
  "setcookie",
  "apikey",
  "apikeys",
  "accesskey",
  "accesskeys",
  "accesskeyid",
  "privatekey",
  "privatekeys",
  "token",
  "tokens",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "bearertoken",
  "sessiontoken",
  "tokenvalue",
  "secret",
  "secrets",
  "clientsecret",
  "apisecret",
  "webhooksecret",
  "password",
  "passwords",
  "passwordhash",
  "passwd",
  "credential",
  "credentials",
  "databaseurl",
  "dsn",
]);
const normalizeKey = (key: string) => key.replace(/[^a-z\d]/gi, "").toLowerCase();
function redactPrefixedCredentials(value: string, count: { value: number }): string {
  return value.replace(
    /(^|[^A-Za-z0-9_-])(sk-|ghp_|github_pat_|xoxb-|xoxp-)([A-Za-z0-9_-]{12,})/gi,
    (_match, boundary: string) => {
      count.value += 1;
      return `${boundary}[REDACTED]`;
    },
  );
}

function sanitizeLine(line: string, count: { value: number }): string {
  let output = line;
  output = output.replace(
    /(--(?:api[-_]?key|access[-_]?token|auth[-_]?token|password|secret|credential)(?:=|\s+))([^\s'"`]+)/gi,
    (_match, option: string) => {
      count.value += 1;
      return `${option}[REDACTED]`;
    },
  );
  const keyValue = /(^|[\s,{;])([A-Za-z][A-Za-z\d _-]{0,80})(\s*[:=]\s*)([^,;}]*)/g;
  output = output.replace(
    keyValue,
    (match, before: string, key: string, delimiter: string, raw: string) => {
      if (!sensitiveKeys.has(normalizeKey(key))) return match;
      const value = raw.trim();
      if (!value || value.startsWith("[REDACTED]")) return match;
      count.value += 1;
      return `${before}${key}${delimiter}[REDACTED]`;
    },
  );
  output = output.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, (_match, scheme: string) => {
    count.value += 1;
    return `${scheme} [REDACTED]`;
  });
  return redactPrefixedCredentials(output, count);
}

function sanitizeText(value: string, count: { value: number }): string {
  let output = value;
  const home = homedir();
  if (home && output.includes(home)) {
    const occurrences = output.split(home).length - 1;
    output = output.replaceAll(home, "$HOME");
    count.value += occurrences;
  }
  const lines: string[] = [];
  let privateKeyEnd: string | undefined;
  for (const line of output.split("\n")) {
    if (privateKeyEnd) {
      if (line.trim().toUpperCase() === privateKeyEnd) privateKeyEnd = undefined;
      continue;
    }
    const marker = line
      .trim()
      .toUpperCase()
      .match(/^-----BEGIN (.+PRIVATE KEY)-----$/);
    if (marker) {
      lines.push("[REDACTED PRIVATE KEY]");
      privateKeyEnd = `-----END ${marker[1]}-----`;
      count.value += 1;
      continue;
    }
    lines.push(sanitizeLine(line, count));
  }
  return lines.join("\n");
}

export function sanitizeSessionText(value: string, redactions: { value: number }): string {
  return sanitizeText(value, redactions);
}

function sanitizeJson(value: unknown, count: { value: number }, key?: string): unknown {
  if (key && sensitiveKeys.has(normalizeKey(key))) {
    count.value += 1;
    return "[REDACTED]";
  }
  if (typeof value === "string") return sanitizeText(value, count);
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, count));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([childKey, child]) => [childKey, sanitizeJson(child, count, childKey)]),
    );
  return value;
}

export function sanitizeHandoffExport(content: string, format: "markdown" | "json"): string {
  if (Buffer.byteLength(content, "utf8") > maximumBytes)
    throw new Error("Handoff content exceeds 256 MiB");
  const redactions = { value: 0 };
  const sanitized =
    format === "markdown"
      ? sanitizeText(content, redactions)
      : `${JSON.stringify(sanitizeJson(JSON.parse(content), redactions), null, 2)}\n`;
  if (Buffer.byteLength(sanitized, "utf8") > maximumBytes)
    throw new Error("Handoff content exceeds 256 MiB");
  return sanitized;
}

export interface SessionImportStats {
  turn_count: number;
  message_count: number;
  tool_call_count: number;
  tool_result_count: number;
  attachment_count: number;
}
export interface SessionWindowStats {
  estimated_total_tokens: number;
  estimated_active_tokens: number;
  estimated_deferred_tokens: number;
  active: SessionImportStats;
  deferred_turn_count: number;
  deferred_block_count: number;
  estimate_quality: "conservative";
}
export interface SessionWindowPlan {
  strategy: "full" | "windowed";
  active_document: SessionDocument;
  stats: SessionWindowStats;
}

export function sessionImportStats(document: SessionDocument): SessionImportStats {
  const stats: SessionImportStats = {
    turn_count: document.turns.length,
    message_count: 0,
    tool_call_count: 0,
    tool_result_count: 0,
    attachment_count: 0,
  };
  for (const block of document.turns.flatMap((turn) => turn.blocks)) {
    if (block.type === "text") stats.message_count++;
    else if (block.type === "tool-call") stats.tool_call_count++;
    else if (block.type === "tool-result") stats.tool_result_count++;
    else stats.attachment_count++;
  }
  return stats;
}

function estimateTextTokens(value: string): number {
  let quarters = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    quarters +=
      (point >= 48 && point <= 57) ||
      (point >= 65 && point <= 90) ||
      (point >= 97 && point <= 122) ||
      [9, 10, 11, 12, 13, 32].includes(point)
        ? 1
        : point <= 127
          ? 2
          : 4;
  }
  return Math.max(Math.ceil(quarters / 4), Math.ceil(Buffer.byteLength(value, "utf8") / 3));
}

function estimateBlockTokens(block: SessionDocument["turns"][number]["blocks"][number]): number {
  let content = 0;
  if (block.type === "text") content = estimateTextTokens(block.text);
  else if (block.type === "tool-call")
    content =
      estimateTextTokens(block.call_id) +
      estimateTextTokens(block.name) +
      estimateTextTokens(block.input);
  else if (block.type === "tool-result")
    content = estimateTextTokens(block.call_id) + estimateTextTokens(block.output);
  else
    content =
      estimateTextTokens(block.media_type) +
      (block.filename ? estimateTextTokens(block.filename) : 0) +
      (block.inline_base64 ? estimateTextTokens(block.inline_base64) : 0);
  return content + 8;
}

function estimateTurnTokens(turn: SessionDocument["turns"][number]): number {
  return turn.blocks.reduce((sum, block) => sum + estimateBlockTokens(block), 16);
}

function estimateDocumentTokens(document: SessionDocument): number {
  return document.turns.reduce((sum, turn) => sum + estimateTurnTokens(turn), 64);
}

export function planSessionWindow(
  document: SessionDocument,
  historyBudgetTokens: number,
  archiveId: string = randomUUID(),
): SessionWindowPlan {
  if (!(HISTORY_BUDGET_OPTIONS as readonly number[]).includes(historyBudgetTokens))
    throw new Error("History budget must be one of 64000, 120000, or 180000 tokens");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(archiveId))
    throw new Error("Archive ID must be a UUID");
  const totalTokens = estimateDocumentTokens(document);
  const normalized = structuredClone(document);
  let externalizedBlocks = 0;
  let blockNumber = 0;
  for (const turn of normalized.turns) {
    for (const [index, block] of turn.blocks.entries()) {
      blockNumber++;
      if (estimateBlockTokens(block) > maximumActiveBlockTokens) {
        const blockId = `block-${String(blockNumber).padStart(6, "0")}`;
        turn.blocks[index] = {
          type: "text",
          text: `[AgentKib archived an oversized block: archive_id=${archiveId}, turn_id=${turn.id}, block=${index}, block_id=${blockId}. Use session_search with query "${blockId}"; each hit includes the exact first/last chunk IDs for session_read_chunk.]`,
        };
        externalizedBlocks++;
      }
    }
  }
  const groups: SessionDocument["turns"][number][][] = [];
  for (const turn of normalized.turns) {
    const containsToolResult = turn.blocks.some((block) => block.type === "tool-result");
    if ((turn.role === "user" && !containsToolResult) || groups.length === 0) groups.push([]);
    groups.at(-1)!.push(turn);
  }
  while (groups.length > 0 && groups[0]?.[0]?.role !== "user") groups.shift();
  let start = groups.length;
  let used = 64;
  for (let index = groups.length - 1; index >= 0; index--) {
    const groupTokens = groups[index]!.reduce((sum, turn) => sum + estimateTurnTokens(turn), 0);
    if (used + groupTokens > historyBudgetTokens) break;
    used += groupTokens;
    start = index;
  }
  const activeTurns = groups.slice(start).flat();
  const skippedTurns = normalized.turns.length - activeTurns.length;
  const activeBlocks = activeTurns.reduce((sum, turn) => sum + turn.blocks.length, 0);
  const totalBlocks = document.turns.reduce((sum, turn) => sum + turn.blocks.length, 0);
  const activeDocument = normalized;
  activeDocument.turns = activeTurns;
  if (!activeDocument.turns.length)
    activeDocument.turns.push({
      id: "archive-reference",
      role: "user",
      timestamp: document.source.updated_at,
      blocks: [
        {
          type: "text",
          text: `[AgentKib archived this conversation as ${archiveId}. Use session_search and session_read_chunk to retrieve the latest task before continuing.]`,
        },
      ],
    });
  const activeTokens = estimateDocumentTokens(activeDocument);
  if (activeTokens > historyBudgetTokens)
    throw new Error("Active session window exceeds its token budget");
  return {
    strategy: skippedTurns === 0 && externalizedBlocks === 0 ? "full" : "windowed",
    active_document: activeDocument,
    stats: {
      estimated_total_tokens: totalTokens,
      estimated_active_tokens: activeTokens,
      estimated_deferred_tokens: Math.max(0, totalTokens - activeTokens),
      active: sessionImportStats(activeDocument),
      deferred_turn_count: skippedTurns,
      deferred_block_count: Math.max(0, totalBlocks - activeBlocks) + externalizedBlocks,
      estimate_quality: "conservative",
    },
  };
}

export function fingerprintSessionDocument(document: SessionDocument): string {
  return createHash("sha256").update(JSON.stringify(document), "utf8").digest("hex");
}

export function renderHandoff(
  document: SessionDocument,
  targetAgent: string,
  format: "markdown" | "json",
  generatedAt: string,
  notice: string,
): string {
  if (format === "json")
    return `${JSON.stringify({ generated_at: generatedAt, instruction: notice, schema_version: 1, session: document, target_agent: targetAgent }, null, 2)}\n`;
  let output = `# AgentKib session continuation\n\n> ${notice}\n\n- Source Agent: ${document.source.agent}\n- Target Agent: ${targetAgent}\n- Generated: ${generatedAt}\n\n## Timeline\n`;
  for (const turn of document.turns) {
    output += `\n### ${turn.role[0]!.toUpperCase()}${turn.role.slice(1)}\n\n`;
    for (const block of turn.blocks) {
      if (block.type === "text") output += `${block.text}\n`;
      else if (block.type === "tool-call")
        output += `\`\`\`tool-call\n${JSON.stringify({ id: block.call_id, input: block.input, name: block.name })}\n\`\`\`\n`;
      else if (block.type === "tool-result")
        output += `\`\`\`tool-result\n${JSON.stringify({ id: block.call_id, is_error: block.is_error, output: block.output })}\n\`\`\`\n`;
      else
        output += `\`\`\`agentkib-attachment\n${JSON.stringify({ inline_base64: block.inline_base64 ?? null, filename: block.filename ?? null, kind: block.kind, media_type: block.media_type })}\n\`\`\`\n`;
    }
  }
  if (document.losses.length) {
    output += "\n## Import losses\n";
    for (const loss of document.losses) output += `\n- ${loss.code}: ${loss.count}\n`;
  }
  return output;
}
