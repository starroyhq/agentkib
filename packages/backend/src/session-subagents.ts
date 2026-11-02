import { createHmac, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { SessionPaging } from "./session-paging";
import { codexRollouts, decompressedChunks, isCompressedRollout } from "./codex-rollout-files";
import type { ConversationEventPage } from "./session-events";
import { codexErrorText } from "./codex-turn-error";
import type { SubagentStatus, SubagentSummary } from "@agentkib/runtime-protocol";
export type { SubagentStatus, SubagentSummary } from "@agentkib/runtime-protocol";

export interface SubagentObservation {
  id: string;
  parentId?: string;
  name: string;
  status: SubagentStatus;
  updatedAt?: string;
  nativeAgentId?: string;
  readable?: boolean;
}
export interface SubagentParent {
  sessionId: string;
  nativeId: string;
  workspace: string;
  transcript: string;
  agent: "codex" | "claude-code";
  /** Only a resident runner/follower can confirm that the parent's turn is active. */
  running?: boolean;
  turnId?: string | null;
  /** Identity of the resident native connection, not its current turn. Never persisted or public. */
  connected?: boolean;
  observerId?: string;
}
export interface CodexSubagentSource {
  nativeId: string;
  parentNativeId: string;
  name: string;
  transcript: string;
}
type Source = {
  summary: SubagentSummary;
  transcript?: string;
  nativeId?: string;
  parentNativeId?: string;
};
const MAX_CHILDREN = 128,
  MAX_SCAN_BYTES = 1024 * 1024,
  CHILD_SCAN_BYTES = 64 * 1024,
  HEADER_BYTES = 8 * 1024,
  MAX_SCAN_LINES = 10_000;
const MAX_SCAN_BUDGET = 12 * 1024 * 1024,
  MAX_CACHE_BYTES = 12 * 1024 * 1024;
type ScanBudget = { remaining: number; truncated: boolean };
const safeId = /^[A-Za-z0-9_:-]{1,256}$/;
const active = new Set<SubagentStatus>([
  "starting",
  "running",
  "waiting-input",
  "waiting-approval",
]);
const statuses = new Set<SubagentStatus>([...active, "completed", "failed", "stopped", "unknown"]);
const name = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim()
    ? [...value.replace(/\p{Cc}/gu, " ").trim()].slice(0, 160).join("")
    : fallback;
const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const scopedId = (parent: SubagentParent, salt: string, id: string) =>
  createHmac("sha256", salt)
    .update(`subagent:${parent.sessionId}:${parent.nativeId}:${parent.agent}:${id}`)
    .digest("hex");

/** Safe synchronous projection for native progress publications; never forwards private fields. */
export function projectSubagentObservations(
  parent: SubagentParent,
  salt: string,
  observations: SubagentObservation[],
) {
  const ids = new Map(
    observations
      .filter((value) => safeId.test(value.id))
      .map((value) => [value.id, scopedId(parent, salt, `call:${value.id}`)]),
  );
  const agents: SubagentSummary[] = observations
    .slice(0, MAX_CHILDREN)
    .filter((value) => safeId.test(value.id) && statuses.has(value.status))
    .map((value) => ({
      id: ids.get(value.id)!,
      name: name(value.name, parent.agent === "codex" ? "Codex" : "Claude Code"),
      agent: parent.agent,
      status: value.status,
      readable: value.readable === true,
      ...(value.parentId && ids.has(value.parentId) ? { parentId: ids.get(value.parentId) } : {}),
      ...(value.updatedAt && Number.isFinite(Date.parse(value.updatedAt))
        ? { updatedAt: value.updatedAt }
        : {}),
    }));
  return {
    version: 1 as const,
    sessionId: parent.sessionId,
    agents,
    truncated: observations.length > MAX_CHILDREN,
    partial: true as const,
  };
}

function activeCodexChildren(
  rows: Record<string, any>[],
  turnId: string | null | undefined,
): Map<string, SubagentStatus> {
  const children = new Map<string, SubagentStatus>();
  if (!turnId) return children;
  let turn: string | undefined;
  for (const row of rows) {
    const payload = row.payload;
    if (row.type === "event_msg" && payload?.type === "task_started")
      turn = payload.turn_id ?? payload.turnId;
    const current = row.turn_id ?? payload?.turn_id ?? payload?.turnId ?? turn;
    if (current !== turnId) continue;
    const item = row.type === "response_item" ? payload : (row.item ?? payload?.item ?? payload);
    const kind = String(item?.type ?? "")
      .replace(/[_-]/g, "")
      .toLowerCase();
    if (kind === "subagentactivity") {
      const id = item.agent_thread_id ?? item.agentThreadId;
      if (typeof id !== "string") continue;
      if (["started", "interacted"].includes(item.kind)) children.set(id, "running");
      if (item.kind === "completed") children.set(id, "completed");
      if (item.kind === "interrupted") children.set(id, "stopped");
    }
    if (kind === "collabagenttoolcall") {
      // The tool call completing only confirms dispatch. Child states are explicit native facts.
      const states = item.agents_states ?? item.agentsStates;
      if (!record(states)) continue;
      for (const [id, value] of Object.entries(states).slice(0, MAX_CHILDREN)) {
        const raw = record(value) ? value.status : value;
        const status =
          raw === "pendingInit" || raw === "pending_init"
            ? "starting"
            : raw === "errored"
              ? "failed"
              : raw === "shutdown"
                ? "stopped"
                : raw;
        if (typeof status === "string" && statuses.has(status as SubagentStatus))
          children.set(id, status as SubagentStatus);
      }
    }
  }
  return children;
}

/** Refuse symlinks in the complete canonical source chain, not just the final file. */
function sourceIdentity(file: string): string {
  const absolute = path.resolve(file);
  if (realpathSync(absolute) !== absolute) throw new Error("subagent-source-unsafe");
  const parts = absolute.slice(path.parse(absolute).root.length).split(path.sep);
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    const st = lstatSync(current);
    if (st.isSymbolicLink() || (current !== absolute && !st.isDirectory()))
      throw new Error("subagent-source-unsafe");
  }
  const st = lstatSync(absolute);
  if (!st.isFile()) throw new Error("subagent-source-unsafe");
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
}
function rows(
  file: string,
  maximum: number,
  budget: ScanBudget,
  prefix = false,
): { values: Record<string, any>[]; truncated: boolean; budgetLimited: boolean } {
  sourceIdentity(file);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("subagent-source-unsafe");
    // A bounded suffix keeps recent completions visible even in long parent histories.
    const length = Math.max(0, Math.min(st.size, maximum, budget.remaining)),
      start = prefix ? 0 : st.size - length;
    budget.remaining -= length;
    const budgetLimited = length < Math.min(st.size, maximum);
    if (budgetLimited) budget.truncated = true;
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, bytes, read, length - read, start + read);
      if (!count) break;
      read += count;
    }
    const lines = bytes.subarray(0, read).toString("utf8").split("\n");
    if (start) lines.shift();
    if (prefix && length < st.size) lines.pop();
    const selected = lines.slice(-MAX_SCAN_LINES),
      values: Record<string, any>[] = [];
    for (const line of selected) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (record(value)) values.push(value);
      } catch {
        /* An incomplete last append is not a frame. */
      }
    }
    return { values, truncated: start > 0 || lines.length > MAX_SCAN_LINES, budgetLimited };
  } finally {
    closeSync(fd);
  }
}
async function codexHeader(
  file: string,
  expected: string,
  parent: string,
  workspace: string,
  budget: ScanBudget,
): Promise<void> {
  sourceIdentity(file);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const parts: Buffer[] = [];
    let total = 0,
      complete = false;
    if (isCompressedRollout(file)) {
      // A list only needs the first metadata line. Never materialize an entire compressed
      // child just to count it: input, decoded output and the aggregate request are bounded.
      const compressedSize = fstatSync(fd).size;
      const input = Math.max(0, Math.min(compressedSize, 256 * 1024, budget.remaining));
      if (input < Math.min(compressedSize, 256 * 1024)) budget.truncated = true;
      budget.remaining -= input;
      let reading = true;
      try {
        for await (const value of decompressedChunks(fd, input, () => reading)) {
          const chunk = Buffer.from(value);
          if (chunk.length > budget.remaining) {
            budget.remaining = 0;
            budget.truncated = true;
            throw new Error("subagent-scan-limit");
          }
          budget.remaining -= chunk.length;
          const newline = chunk.indexOf(10),
            count = newline >= 0 ? newline + 1 : chunk.length;
          if (total + count > 64 * 1024) {
            budget.truncated = true;
            throw new Error("subagent-scan-limit");
          }
          parts.push(chunk.subarray(0, count));
          total += count;
          if (newline >= 0) {
            complete = true;
            break;
          }
        }
      } finally {
        reading = false;
      }
    }
    while (!isCompressedRollout(file) && total < 64 * 1024 && !complete) {
      const requested = Math.max(0, Math.min(HEADER_BYTES, 64 * 1024 - total, budget.remaining));
      if (!requested) {
        budget.truncated = true;
        throw new Error("subagent-scan-limit");
      }
      const bytes = Buffer.alloc(requested),
        count = readSync(fd, bytes, 0, bytes.length, total);
      budget.remaining -= count;
      if (!count) {
        complete = true;
        break;
      }
      parts.push(bytes.subarray(0, count));
      total += count;
      complete = bytes.subarray(0, count).includes(10);
    }
    if (!complete) {
      budget.truncated = true;
      throw new Error("subagent-scan-limit");
    }
    const first = Buffer.concat(parts, total).toString("utf8").split("\n")[0];
    const row = JSON.parse(first),
      meta = row?.payload;
    const spawn = meta?.source?.subagent?.thread_spawn;
    if (
      row?.type !== "session_meta" ||
      meta?.id !== expected ||
      (meta?.parent_thread_id ?? spawn?.parent_thread_id) !== parent
    )
      throw new Error("subagent-parent-mismatch");
    if (typeof meta.cwd !== "string") throw new Error("subagent-parent-mismatch");
    const relative = path.relative(workspace, meta.cwd);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("session-workspace-mismatch");
  } finally {
    closeSync(fd);
  }
}
function codexTurn(rows: Record<string, any>[]): { status: SubagentStatus; turnId: string | null } {
  for (const row of [...rows].reverse()) {
    if (row.type !== "event_msg") continue;
    const type = row.payload?.type;
    const turnId = row.payload?.turn_id ?? row.payload?.turnId;
    if (["task_complete", "turn_complete", "task_completed"].includes(type))
      return {
        status: codexErrorText(row.payload?.error) ? "failed" : "completed",
        turnId: typeof turnId === "string" ? turnId : null,
      };
    if (["turn_aborted", "task_aborted"].includes(type))
      return { status: "stopped", turnId: typeof turnId === "string" ? turnId : null };
    if (["task_started", "turn_started"].includes(type))
      return { status: "unknown", turnId: typeof turnId === "string" ? turnId : null };
  }
  return { status: "unknown", turnId: null };
}

/** Parent-scoped, read-only projection. No native ids, filesystem paths or control handles leave it. */
export class SessionSubagents {
  #paging = new SessionPaging();
  #rows = new Map<string, { identity: string; value: ReturnType<typeof rows>; bytes: number }>();
  #rowBytes = 0;
  #cursors = new Map<string, string>();
  #epochs = new Map<string, { identity: string; size: number; modified: number; epoch: string }>();
  #epochGeneration = randomUUID();
  #codexHeaders = new Map<string, string>();
  #codexRuns = new Map<
    string,
    Map<string, { turnId: string; identity: string; status: SubagentStatus }>
  >();
  constructor(readonly salt: string) {}
  clear(): void {
    this.#paging.clear();
    this.#rows.clear();
    this.#rowBytes = 0;
    this.#cursors.clear();
    this.#epochs.clear();
    this.#codexRuns.clear();
    this.#codexHeaders.clear();
  }
  #id(parent: SubagentParent, nativeId: string): string {
    return scopedId(parent, this.salt, nativeId);
  }
  observationId(
    parent: SubagentParent,
    id: string,
    observations: SubagentObservation[],
  ): string | undefined {
    return observations.find((value) => this.#id(parent, `call:${value.id}`) === id)?.id;
  }
  async #verifyCodexHeader(
    file: string,
    nativeId: string,
    parentId: string,
    workspace: string,
    budget: ScanBudget,
  ) {
    const key = JSON.stringify([file, nativeId, parentId, workspace]);
    const identity = sourceIdentity(file);
    if (this.#codexHeaders.get(key) === identity) return;
    await codexHeader(file, nativeId, parentId, workspace, budget);
    if (sourceIdentity(file) === identity) {
      this.#codexHeaders.set(key, identity);
      if (this.#codexHeaders.size > 256)
        this.#codexHeaders.delete(this.#codexHeaders.keys().next().value!);
    }
  }
  #read(file: string, budget: ScanBudget, maximum = MAX_SCAN_BYTES, prefix = false) {
    const key = `${maximum}:${prefix}:${file}`;
    const identity = sourceIdentity(file),
      cached = this.#rows.get(key);
    if (cached?.identity === identity) return cached.value;
    const value = rows(file, maximum, budget, prefix);
    // A per-request budget must never poison the next request's cached metadata.
    if (value.budgetLimited) return value;
    this.#rowBytes -= cached?.bytes ?? 0;
    this.#rows.delete(key);
    const bytes = Buffer.byteLength(JSON.stringify(value.values));
    this.#rows.set(key, { identity, value, bytes });
    this.#rowBytes += bytes;
    while (this.#rows.size > 384 || this.#rowBytes > MAX_CACHE_BYTES) {
      const key = this.#rows.keys().next().value!;
      this.#rowBytes -= this.#rows.get(key)!.bytes;
      this.#rows.delete(key);
    }
    return value;
  }
  async list(
    parent: SubagentParent,
    codex: CodexSubagentSource[] = [],
    observations: SubagentObservation[] = [],
  ) {
    const sources = await this.#sources(parent, codex, observations);
    return {
      version: 1 as const,
      sessionId: parent.sessionId,
      agents: sources.values.map((value) => value.summary),
      truncated: sources.truncated,
    };
  }
  async events(
    parent: SubagentParent,
    id: string,
    cursor: string | null,
    limit: number,
    codex: CodexSubagentSource[] = [],
    observations: SubagentObservation[] = [],
  ): Promise<
    ConversationEventPage & { version: 1; sessionId: string; subagentId: string; epoch: string }
  > {
    if (!/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("invalid-request");
    const sources = await this.#sources(parent, codex, observations),
      source = sources.values.find((value) => value.summary.id === id);
    if (!source?.transcript) throw new Error("subagent-unavailable");
    // SessionPaging cursors also bind a file, but this additional parent/id binding prevents cross-parent cursor reuse.
    const scope = `${parent.sessionId}:${id}`;
    if (cursor && this.#cursors.get(cursor) !== scope) throw new Error("TRANSCRIPT_CURSOR_INVALID");
    const recorded = source.transcript;
    const compressedIdentity = isCompressedRollout(recorded) ? sourceIdentity(recorded) : null;
    // Only the explicitly selected child uses the existing bounded rollout cache.
    const file =
      parent.agent === "codex" ? realpathSync(await codexRollouts.plain(recorded)) : recorded;
    if (compressedIdentity !== null && sourceIdentity(recorded) !== compressedIdentity)
      throw new Error("TRANSCRIPT_CURSOR_STALE");
    if (parent.agent === "codex" && source.nativeId && source.parentNativeId)
      await this.#verifyCodexHeader(
        file,
        source.nativeId,
        source.parentNativeId,
        parent.workspace,
        { remaining: MAX_SCAN_BUDGET, truncated: false },
      );
    const metadata = lstatSync(recorded),
      identity = `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`;
    const previous = this.#epochs.get(file);
    const epoch =
      previous &&
      previous.identity === identity &&
      metadata.size >= previous.size &&
      (metadata.size > previous.size || metadata.mtimeMs === previous.modified)
        ? previous.epoch
        : this.#id(parent, `epoch:${id}:${this.#epochGeneration}:${identity}:${randomUUID()}`);
    this.#epochs.set(file, { identity, size: metadata.size, modified: metadata.mtimeMs, epoch });
    if (this.#epochs.size > 128) this.#epochs.delete(this.#epochs.keys().next().value!);
    const page = this.#paging.read(file, cursor, limit, parent.agent, {
      workspace: parent.workspace,
    });
    // SessionPaging validates its snapshot prefix and identity while allowing normal appends.
    sourceIdentity(file);
    if (compressedIdentity !== null && sourceIdentity(recorded) !== compressedIdentity)
      throw new Error("TRANSCRIPT_CURSOR_STALE");
    if (page.next_cursor) {
      this.#cursors.set(page.next_cursor, scope);
      if (this.#cursors.size > 256) this.#cursors.delete(this.#cursors.keys().next().value!);
    }
    return { ...page, version: 1, sessionId: parent.sessionId, subagentId: id, epoch };
  }
  async #sources(
    parent: SubagentParent,
    candidates: CodexSubagentSource[],
    observations: SubagentObservation[],
  ) {
    if (parent.transcript) sourceIdentity(parent.transcript);
    const sources = new Map<string, Source>();
    let truncated = false;
    const budget: ScanBudget = { remaining: MAX_SCAN_BUDGET, truncated: false };
    if (!parent.transcript) {
      // A verified fresh managed session may have observations before its native file exists.
    } else if (parent.agent === "codex") {
      const activeChildren = parent.running
        ? activeCodexChildren(this.#read(parent.transcript, budget).values, parent.turnId)
        : new Map<string, SubagentStatus>();
      const observed = parent.connected === true && !!parent.observerId;
      const observerKey = JSON.stringify([parent.sessionId, parent.nativeId, parent.observerId]);
      const observerPrefix = JSON.stringify([parent.sessionId, parent.nativeId]).slice(0, -1) + ",";
      for (const key of this.#codexRuns.keys())
        if (key.startsWith(observerPrefix) && (!observed || key !== observerKey))
          this.#codexRuns.delete(key);
      const runs = observed
        ? (this.#codexRuns.get(observerKey) ??
          new Map<string, { turnId: string; identity: string; status: SubagentStatus }>())
        : new Map<string, { turnId: string; identity: string; status: SubagentStatus }>();
      if (observed) {
        this.#codexRuns.set(observerKey, runs);
        if (this.#codexRuns.size > 32) this.#codexRuns.delete(this.#codexRuns.keys().next().value!);
      }
      const activityByParent = new Map([[parent.nativeId, activeChildren]]);
      const nativeIds = new Set([parent.nativeId]);
      for (let depth = 0; depth < 8; depth++) {
        let added = false;
        for (const candidate of candidates) {
          if (nativeIds.has(candidate.nativeId) || !nativeIds.has(candidate.parentNativeId))
            continue;
          if (sources.size >= MAX_CHILDREN) {
            truncated = true;
            break;
          }
          try {
            const file = candidate.transcript;
            await this.#verifyCodexHeader(
              file,
              candidate.nativeId,
              candidate.parentNativeId,
              parent.workspace,
              budget,
            );
            const data = isCompressedRollout(file)
                ? { values: [], truncated: true, budgetLimited: false }
                : this.#read(file, budget, CHILD_SCAN_BYTES),
              id = this.#id(parent, candidate.nativeId);
            const native = codexTurn(data.values),
              metadata = lstatSync(file),
              identity = `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`;
            const earlier = runs.get(candidate.nativeId);
            if (earlier && (earlier.turnId !== native.turnId || earlier.identity !== identity))
              runs.delete(candidate.nativeId);
            const current = activityByParent.get(candidate.parentNativeId)?.get(candidate.nativeId);
            if (
              observed &&
              current &&
              active.has(current) &&
              native.turnId &&
              native.status === "unknown"
            )
              runs.set(candidate.nativeId, { turnId: native.turnId, identity, status: current });
            if (native.status !== "unknown" || (current && !active.has(current)))
              runs.delete(candidate.nativeId);
            const status =
              native.status !== "unknown"
                ? native.status
                : observed && current && !active.has(current)
                  ? current
                  : observed
                    ? (runs.get(candidate.nativeId)?.status ?? "unknown")
                    : "unknown";
            if (active.has(status))
              activityByParent.set(
                candidate.nativeId,
                activeCodexChildren(data.values, native.turnId),
              );
            sources.set(candidate.nativeId, {
              nativeId: candidate.nativeId,
              parentNativeId: candidate.parentNativeId,
              transcript: file,
              summary: {
                id,
                ...(candidate.parentNativeId !== parent.nativeId
                  ? { parentId: this.#id(parent, candidate.parentNativeId) }
                  : {}),
                name: name(candidate.name, "Codex"),
                agent: parent.agent,
                status,
                readable: true,
              },
            });
            nativeIds.add(candidate.nativeId);
            added = true;
            truncated ||= data.truncated;
          } catch {
            /* Metadata without a verified transcript is never exposed as a child. */
          }
        }
        if (!added) break;
      }
      // A removed, rejected or budget-omitted source is no longer evidence of a resident child.
      // This also bounds each parent's observation table under long-lived child churn.
      for (const id of runs.keys()) if (!nativeIds.has(id)) runs.delete(id);
    } else {
      const folder = path.join(path.dirname(parent.transcript), parent.nativeId, "subagents");
      let files: string[] = [];
      try {
        if (realpathSync(folder) !== folder || !lstatSync(folder).isDirectory())
          throw new Error("subagent-source-unsafe");
        files = readdirSync(folder)
          .filter((value) => /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/.test(value))
          .sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      truncated ||= files.length > MAX_CHILDREN;
      const parentData = this.#read(parent.transcript, budget);
      const names = new Map<string, string>(),
        calls = new Map<string, string>(),
        completions = new Map<string, SubagentStatus>();
      for (const row of parentData.values) {
        const blocks = Array.isArray(row.message?.content) ? row.message.content : [];
        for (const block of blocks) {
          if (
            block?.type === "tool_use" &&
            ["Agent", "Task"].includes(block.name) &&
            typeof block.id === "string"
          )
            calls.set(
              block.id,
              name(block.input?.description ?? block.input?.subagent_type, "Claude Code"),
            );
          if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
          const result = row.toolUseResult ?? row.tool_use_result;
          const native = result?.agentId ?? result?.agent_id;
          if (typeof native !== "string" || !safeId.test(native)) continue;
          names.set(native, calls.get(block.tool_use_id) ?? "Claude Code");
          // A background dispatch response completes the tool call, not the child agent.
          if (result?.status === "completed" || result?.status === "failed")
            completions.set(native, result.status);
          else if (block.is_error === true) completions.set(native, "failed");
        }
      }
      for (const filename of files.slice(0, MAX_CHILDREN)) {
        const native = filename.slice(6, -6),
          file = path.join(folder, filename);
        try {
          const tail = this.#read(file, budget, CHILD_SCAN_BYTES);
          const prefix = tail.truncated ? this.#read(file, budget, HEADER_BYTES, true) : null;
          const data = { ...tail, values: [...(prefix?.values ?? []), ...tail.values] };
          // The child file has its parent's native session id; the app managed id is unrelated.
          if (
            !data.values.some(
              (row) =>
                row.sessionId === parent.nativeId &&
                row.agentId === native &&
                row.isSidechain === true,
            )
          )
            continue;
          if (
            data.values.some(
              (row) =>
                (row.sessionId !== undefined && row.sessionId !== parent.nativeId) ||
                (row.agentId !== undefined && row.agentId !== native),
            )
          )
            continue;
          if (
            data.values.some(
              (row) =>
                typeof row.cwd === "string" &&
                (() => {
                  const relative = path.relative(parent.workspace, row.cwd);
                  return (
                    relative === ".." ||
                    relative.startsWith(`..${path.sep}`) ||
                    path.isAbsolute(relative)
                  );
                })(),
            )
          )
            continue;
          const id = this.#id(parent, native);
          sources.set(native, {
            transcript: file,
            nativeId: native,
            summary: {
              id,
              name: names.get(native) ?? "Claude Code",
              agent: parent.agent,
              status: completions.get(native) ?? "unknown",
              readable: true,
            },
          });
        } catch {
          /* Do not expose an unsafe or unbound child file. */
        }
      }
    }
    const observationIds = new Map(
      observations
        .filter((value) => safeId.test(value.id))
        .map((value) => [value.id, this.#id(parent, `call:${value.id}`)]),
    );
    for (const observation of observations.slice(0, MAX_CHILDREN)) {
      if (!safeId.test(observation.id) || !statuses.has(observation.status)) continue;
      const native = observation.nativeAgentId,
        existing = native ? sources.get(native) : undefined;
      // Runtime identity stays stable when the native transcript becomes available later.
      const id = this.#id(parent, `call:${observation.id}`);
      observationIds.set(observation.id, id);
      const summary: SubagentSummary = {
        id,
        name: name(observation.name, parent.agent === "codex" ? "Codex" : "Claude Code"),
        agent: parent.agent,
        status: observation.status,
        readable: !!existing?.transcript || observation.readable === true,
      };
      if (observation.updatedAt && Number.isFinite(Date.parse(observation.updatedAt)))
        summary.updatedAt = observation.updatedAt;
      if (observation.parentId && observationIds.has(observation.parentId))
        summary.parentId = observationIds.get(observation.parentId);
      if (existing) existing.summary = summary;
      else sources.set(`call:${observation.id}`, { summary });
    }
    truncated ||= observations.length > MAX_CHILDREN;
    return {
      values: [...sources.values()].slice(0, MAX_CHILDREN),
      truncated: truncated || budget.truncated || sources.size > MAX_CHILDREN,
    };
  }
}
