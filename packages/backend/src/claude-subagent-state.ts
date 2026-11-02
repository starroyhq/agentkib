import { frameOrigin } from "./claude-frame-policy";
import { claudeToolDetail, redactToolText } from "./conversation-tools";
import { truncateUtf8 } from "./session-event-values";
import type { ConversationEvent } from "./session-events";

type Json = Record<string, unknown>;
export type ClaudeSubagentStatus =
  | "starting"
  | "running"
  | "waiting-input"
  | "waiting-approval"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown";

/** Internal observation. Native IDs are identifiers, never file paths or authority to read one. */
export interface ClaudeSubagentSnapshot {
  id: string;
  spawnToolId: string;
  parentId?: string;
  name: string;
  agent: "claude-code";
  status: ClaudeSubagentStatus;
  updatedAt: string;
  readable: boolean;
  nativeAgentId?: string;
  taskId?: string;
  truncated?: boolean;
}

interface Observation {
  summary: ClaudeSubagentSnapshot;
  background: boolean;
  items: ConversationEvent[];
  streamId?: string;
  serial: number;
}
const MAX_AGENTS = 128;
const MAX_ITEMS = 128;
const MAX_BYTES = 2 * 1024 * 1024;
const record = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9_:-]{1,256}$/.test(value) ? value : undefined;
const nativeIdentifier = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
const active = (status: ClaudeSubagentStatus) =>
  ["starting", "running", "waiting-input", "waiting-approval"].includes(status);
function status(value: unknown): ClaudeSubagentStatus | undefined {
  switch (value) {
    case "pending":
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "waiting-input":
      return "waiting-input";
    case "waiting-approval":
      return "waiting-approval";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
    case "stopped":
      return "stopped";
    default:
      return undefined;
  }
}
function content(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value)
    ? value
        .flatMap((part) =>
          record(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
        )
        .join("\n")
    : "";
}

/** A bounded read-only projection, deliberately separate from the parent turn's control state. */
export class ClaudeSubagentState {
  #bytes = 0;
  #agents = new Map<string, Observation>();
  #tasks = new Map<string, string>();
  #tools = new Map<string, string>();
  #requests = new Map<string, { owner: string; status: "waiting-input" | "waiting-approval" }>();

  checkpoint() {
    return structuredClone({
      agents: this.#agents,
      tasks: this.#tasks,
      tools: this.#tools,
      requests: this.#requests,
      bytes: this.#bytes,
    });
  }
  restore(value: ReturnType<ClaudeSubagentState["checkpoint"]>): void {
    const copy = structuredClone(value);
    this.#agents = copy.agents;
    this.#tasks = copy.tasks;
    this.#tools = copy.tools;
    this.#requests = copy.requests;
    this.#bytes = copy.bytes;
  }
  snapshot(): ClaudeSubagentSnapshot[] {
    return [...this.#agents.values()].map(({ summary, items }) => ({
      ...summary,
      readable: !!summary.nativeAgentId || items.length > 0,
    }));
  }
  events(id: string): ConversationEvent[] | null {
    const row = this.#agents.get(id);
    return row ? structuredClone(row.items) : null;
  }

  /** A confirmed stop kills the owned process tree; other losses only make liveness unknown. */
  unavailable(stopped = false): void {
    for (const row of this.#agents.values())
      if (active(row.summary.status)) this.#change(row, stopped ? "stopped" : "unknown");
    this.#requests.clear();
  }
  resolve(request: unknown): void {
    if (typeof request !== "string") return;
    const pending = this.#requests.get(request);
    if (!pending) return;
    this.#requests.delete(request);
    const row = this.#agents.get(pending.owner);
    if (!row || !active(row.summary.status)) return;
    const remaining = [...this.#requests.values()].filter((entry) => entry.owner === pending.owner);
    this.#change(
      row,
      remaining.some((entry) => entry.status === "waiting-input")
        ? "waiting-input"
        : remaining.length
          ? "waiting-approval"
          : "running",
    );
  }

  observe(frame: Json, mainActive: boolean): void {
    const origin = frameOrigin(frame);
    if (origin.kind === "unattributed") return;
    const owner = origin.kind === "subagent" ? this.#agents.get(origin.spawner) : undefined;
    if (origin.kind === "subagent" && !owner) return;
    if (frame.type === "assistant" || frame.type === "user") {
      const message = record(frame.message) ? frame.message : {};
      const blocks = Array.isArray(message.content) ? message.content.filter(record) : [];
      if (frame.type === "assistant") {
        for (const block of blocks) {
          if (block.type !== "tool_use") continue;
          const id = identifier(block.id);
          if (!id) continue;
          if (owner && this.#tools.size < 4096) this.#tools.set(id, owner.summary.id);
          if (
            ["Agent", "Task"].includes(String(block.name)) &&
            (owner || (origin.kind === "main" && mainActive))
          )
            this.#spawn(id, record(block.input) ? block.input : {}, owner);
        }
      } else {
        for (const block of blocks) {
          if (block.type !== "tool_result") continue;
          const spawned = this.#agents.get(String(block.tool_use_id));
          if (!spawned) continue;
          if (spawned.summary.parentId !== owner?.summary.id) continue;
          // Like the parent tool projection, sibling results cannot share one unlabelled payload.
          const soleResult = blocks.filter((entry) => entry.type === "tool_result").length === 1;
          const result =
            soleResult && record(frame.tool_use_result)
              ? frame.tool_use_result
              : soleResult && record(frame.toolUseResult)
                ? frame.toolUseResult
                : {};
          spawned.background ||= result.isAsync === true || result.status === "async_launched";
          this.#bindNative(spawned, result.agentId ?? result.agent_id);
          const terminal = status(result.status);
          if (block.is_error === true) this.#change(spawned, "failed");
          else if (terminal) this.#change(spawned, terminal);
          // A background Agent returns a dispatch receipt before the child finishes.
          else if (!spawned.background) this.#change(spawned, "completed");
        }
      }
      if (owner) this.#message(owner, frame, message, blocks);
      return;
    }
    if (frame.type === "stream_event" && owner) {
      const event = record(frame.event) ? frame.event : {};
      if (
        event.type === "content_block_start" &&
        record(event.content_block) &&
        event.content_block.type === "tool_use"
      ) {
        const block = event.content_block;
        const id = identifier(block.id);
        if (id && this.#tools.size < 4096) this.#tools.set(id, owner.summary.id);
        if (id && ["Agent", "Task"].includes(String(block.name)))
          this.#spawn(id, record(block.input) ? block.input : {}, owner);
      }
      const delta = record(event.delta) ? event.delta : {};
      const block = record(event.content_block) ? event.content_block : {};
      const text =
        event.type === "content_block_delta" &&
        delta.type === "text_delta" &&
        typeof delta.text === "string"
          ? delta.text
          : event.type === "content_block_start" &&
              block.type === "text" &&
              typeof block.text === "string"
            ? block.text
            : "";
      if (text) {
        if (!owner.streamId) owner.streamId = `sub:${owner.summary.id}:stream:${++owner.serial}`;
        const previous = owner.items.find((item) => item.id === owner.streamId)?.content ?? "";
        const streamed = {
          ...this.#event(owner.streamId, "agent-message", previous + text),
          ephemeral: true,
        };
        this.#put(owner, streamed);
        if (active(owner.summary.status) && !owner.summary.status.startsWith("waiting"))
          this.#change(owner, "running");
      }
      return;
    }
    if (frame.type === "control_request" && record(frame.request)) {
      const request = frame.request;
      if (request.subtype !== "can_use_tool") return;
      const toolOwner = this.#tools.get(String(request.tool_use_id));
      const nativeId = nativeIdentifier(request.agent_id);
      const row = toolOwner
        ? this.#agents.get(toolOwner)
        : nativeId
          ? [...this.#agents.values()].find((entry) => entry.summary.nativeAgentId === nativeId)
          : undefined;
      const requestId = identifier(frame.request_id);
      if (!row || !requestId || this.#requests.size >= 64) return;
      this.#bindNative(row, nativeId);
      const waiting =
        request.tool_name === "AskUserQuestion" ? "waiting-input" : "waiting-approval";
      this.#requests.set(requestId, { owner: row.summary.id, status: waiting });
      this.#change(row, waiting);
      return;
    }
    if (frame.type === "control_cancel_request") {
      this.resolve(frame.request_id);
      return;
    }
    if (frame.type !== "system") return;
    if (frame.subtype === "task_started" && frame.task_type === "local_agent") {
      const task = identifier(frame.task_id),
        tool = identifier(frame.tool_use_id);
      const row = tool ? this.#agents.get(tool) : undefined;
      if (!row || !task || (this.#tasks.has(task) && this.#tasks.get(task) !== tool)) return;
      if (row.summary.taskId && row.summary.taskId !== task) return;
      this.#tasks.set(task, tool!);
      row.summary.taskId = task;
      row.background ||= frame.is_backgrounded === true;
      this.#bindNative(row, frame.agent_id ?? frame.agentId);
      this.#change(row, "running");
    } else if (frame.subtype === "task_updated" || frame.subtype === "task_notification") {
      if (frame.task_type !== undefined && frame.task_type !== "local_agent") return;
      const task = identifier(frame.task_id),
        tool = task ? this.#tasks.get(task) : undefined;
      const row = tool ? this.#agents.get(tool) : undefined;
      if (!row || (frame.tool_use_id !== undefined && frame.tool_use_id !== tool)) return;
      const patch = record(frame.patch) ? frame.patch : {};
      const next = status(frame.subtype === "task_notification" ? frame.status : patch.status);
      row.background ||= patch.is_backgrounded === true;
      if (next) this.#change(row, next);
    } else if (frame.subtype === "background_tasks_changed" && Array.isArray(frame.tasks)) {
      const present = new Set<string>();
      for (const entry of frame.tasks) {
        if (!record(entry) || entry.task_type !== "local_agent") continue;
        const tool = this.#tasks.get(String(entry.task_id));
        const row = tool ? this.#agents.get(tool) : undefined;
        if (!row) continue;
        present.add(row.summary.id);
        row.background = true;
        if (active(row.summary.status)) this.#change(row, "running");
      }
      for (const row of this.#agents.values())
        if (
          row.background &&
          ["starting", "running"].includes(row.summary.status) &&
          !present.has(row.summary.id)
        )
          this.#change(row, "unknown");
    }
  }

  #spawn(id: string, input: Json, parent?: Observation): void {
    let row = this.#agents.get(id);
    if (!row) {
      if (this.#agents.size >= MAX_AGENTS) {
        // A long conversation must still show new work after the retained completed window fills.
        // Keep any node that still anchors a retained descendant's identity.
        const retired = [...this.#agents.values()].find(
          (entry) =>
            ["completed", "failed", "stopped"].includes(entry.summary.status) &&
            ![...this.#agents.values()].some(
              (child) => child.summary.parentId === entry.summary.id,
            ),
        );
        if (!retired) return;
        this.#agents.delete(retired.summary.id);
        this.#bytes -= retired.items.reduce(
          (sum, item) => sum + Buffer.byteLength(JSON.stringify(item)),
          0,
        );
        for (const [tool, owner] of this.#tools)
          if (owner === retired.summary.id) this.#tools.delete(tool);
        for (const [task, owner] of this.#tasks)
          if (owner === retired.summary.id) this.#tasks.delete(task);
        for (const [request, pending] of this.#requests)
          if (pending.owner === retired.summary.id) this.#requests.delete(request);
      }
      row = {
        summary: {
          id,
          spawnToolId: id,
          ...(parent ? { parentId: parent.summary.id } : {}),
          name: "Agent",
          agent: "claude-code",
          status: "starting",
          updatedAt: new Date().toISOString(),
          readable: false,
        },
        background: false,
        items: [],
        serial: 0,
      };
      this.#agents.set(id, row);
    }
    const name =
      typeof input.description === "string" && input.description.trim()
        ? input.description
        : typeof input.subagent_type === "string" && input.subagent_type.trim()
          ? input.subagent_type
          : undefined;
    if (name) row.summary.name = truncateUtf8(redactToolText(name.trim()), 256).content;
    row.background ||= input.run_in_background === true;
  }
  #bindNative(row: Observation, value: unknown): void {
    const nativeId = nativeIdentifier(value);
    if (!nativeId || (row.summary.nativeAgentId && row.summary.nativeAgentId !== nativeId)) return;
    if (
      [...this.#agents.values()].some(
        (other) => other !== row && other.summary.nativeAgentId === nativeId,
      )
    )
      return;
    row.summary.nativeAgentId = nativeId;
  }
  #change(row: Observation, next: ClaudeSubagentStatus): void {
    // A pending child interaction remains more precise than a task's generic running status.
    if (active(next)) {
      const pending = [...this.#requests.values()].filter(
        (entry) => entry.owner === row.summary.id,
      );
      if (pending.length)
        next = pending.some((entry) => entry.status === "waiting-input")
          ? "waiting-input"
          : "waiting-approval";
    }
    if (row.summary.status === next) return;
    // A late receipt or stream frame cannot overturn an explicit child terminal result.
    if (["completed", "failed", "stopped"].includes(row.summary.status)) return;
    row.summary.status = next;
    row.summary.updatedAt = new Date().toISOString();
  }
  #event(id: string, kind: ConversationEvent["kind"], text: string): ConversationEvent {
    const clipped = truncateUtf8(text, 64 * 1024);
    return {
      id,
      kind,
      content: clipped.content,
      timestamp: new Date().toISOString(),
      tool_name: null,
      tool_status: null,
      duration_ms: null,
      attachment_count: 0,
      truncated: clipped.truncated,
    };
  }
  #put(row: Observation, item: ConversationEvent): void {
    const index = row.items.findIndex((previous) => previous.id === item.id);
    if (index >= 0) this.#bytes -= Buffer.byteLength(JSON.stringify(row.items[index]));
    if (index < 0) row.items.push(item);
    else row.items[index] = item;
    this.#bytes += Buffer.byteLength(JSON.stringify(item));
    row.summary.updatedAt = new Date().toISOString();
    while (row.items.length > MAX_ITEMS) {
      this.#bytes -= Buffer.byteLength(JSON.stringify(row.items.shift()));
      row.summary.truncated = true;
    }
    // Observation is process-local and bounded independently of parent history and its reducer.
    for (const entry of this.#agents.values())
      while (this.#bytes > MAX_BYTES && entry.items.length) {
        this.#bytes -= Buffer.byteLength(JSON.stringify(entry.items.shift()));
        entry.summary.truncated = true;
      }
  }
  #message(row: Observation, frame: Json, message: Json, blocks: Json[]): void {
    const text = content(message.content);
    if (text) {
      if (frame.type === "assistant" && row.streamId) {
        row.items = row.items.filter((item) => {
          if (item.id !== row.streamId) return true;
          this.#bytes -= Buffer.byteLength(JSON.stringify(item));
          return false;
        });
        row.streamId = undefined;
      }
      const id =
        identifier(frame.uuid) ??
        identifier(message.id) ??
        `sub:${row.summary.id}:message:${++row.serial}`;
      this.#put(
        row,
        this.#event(id, frame.type === "user" ? "user-message" : "agent-message", text),
      );
    }
    for (const block of blocks) {
      if (block.type === "tool_use") {
        const id = identifier(block.id);
        if (!id || typeof block.name !== "string") continue;
        const item = this.#event(id, "tool-summary", "");
        item.tool_name = truncateUtf8(block.name, 256).content;
        item.tool_status = "running";
        item.tool = claudeToolDetail(block.name, block.input, undefined);
        this.#put(row, item);
      } else if (block.type === "tool_result") {
        const item = row.items.find((entry) => entry.id === block.tool_use_id);
        if (!item) continue;
        this.#put(row, { ...item, tool_status: block.is_error === true ? "failed" : "completed" });
      }
    }
    if (active(row.summary.status) && !row.summary.status.startsWith("waiting"))
      this.#change(row, "running");
  }
}
