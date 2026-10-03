import { performance } from "node:perf_hooks";
import { acpObject, acpTimestamp, stringifyAcpJson } from "./acp-json";
import { hasText, property, trimWhitespace, type ConversationEvent } from "./session-events";
import type { SessionDocument } from "./session-model";
type Turn = SessionDocument["turns"][number];
type Block = Turn["blocks"][number];
type Loss = SessionDocument["losses"][number]["code"];
export interface AntigravityReplay {
  events: ConversationEvent[];
  turns: Turn[];
  warnings: string[];
  losses: Map<Loss, number>;
  title?: string | null;
  updated_at?: string | null;
  toolOutputBytes: number;
  toolNameBytes: number;
}
interface Tool {
  name: string;
  nameSource: string | null;
  nameFields: Record<string, string>;
  status: string;
  rawOutput: unknown;
  contentText: string | null;
  locationsReported: boolean;
  callTurn: number;
  resultPosition: [number, number] | null;
}
const bytes = (value: string | null | undefined) =>
  value === null || value === undefined ? 0 : Buffer.byteLength(value);
const text = (value: unknown, error: string): string => {
  if (typeof value !== "string") throw new Error(error);
  return value;
};
const jsonText = (value: unknown): string =>
  typeof value === "string" ? value : stringifyAcpJson(value);
const present = (value: unknown) => value !== null && value !== undefined;
function empty(): AntigravityReplay {
  return {
    events: [],
    turns: [],
    warnings: [],
    losses: new Map(),
    toolOutputBytes: 0,
    toolNameBytes: 0,
  };
}
function event(
  id: string,
  kind: ConversationEvent["kind"],
  content: string | null,
  toolName: string | null = null,
  status: string | null = null,
): ConversationEvent {
  return {
    id,
    kind,
    turn_id: id,
    timestamp: null,
    content,
    tool_name: toolName,
    tool_status: status,
    duration_ms: null,
    attachment_count: 0,
    truncated: false,
  };
}
function loss(parsed: AntigravityReplay, code: Loss, warning: string): void {
  parsed.losses.set(code, (parsed.losses.get(code) ?? 0) + 1);
  if (!parsed.warnings.includes(warning)) parsed.warnings.push(warning);
}
function account(
  parsed: AntigravityReplay,
  type: "toolOutputBytes" | "toolNameBytes",
  replaced: number,
  added: number,
): void {
  const total = parsed[type] - replaced + added;
  if (parsed[type] < replaced) throw new Error("Invalid Antigravity replay accounting");
  const max = type === "toolOutputBytes" ? 64 * 1024 * 1024 : 16 * 1024 * 1024;
  if (total > max)
    throw new Error(
      type === "toolOutputBytes"
        ? "Antigravity ACP parsed tool output exceeds 64 MiB"
        : "Antigravity ACP parsed tool names exceed 16 MiB",
    );
  parsed[type] = total;
}
function toolName(update: Record<string, unknown>): string {
  const name = property(update, ["title", "name", "kind"]);
  return typeof name === "string" && hasText(name) ? name : "tool";
}
function callId(update: Record<string, unknown>): string {
  const id = text(update.toolCallId, "Antigravity ACP tool update is missing toolCallId");
  if (!id) throw new Error("Antigravity ACP tool update is missing toolCallId");
  return id;
}
function output(call: Tool): string | null {
  if (call.rawOutput !== undefined && call.contentText !== null)
    return stringifyAcpJson({ rawOutput: call.rawOutput, contentText: call.contentText }, true);
  if (call.rawOutput !== undefined) return jsonText(call.rawOutput);
  return call.contentText;
}
function toolContent(parsed: AntigravityReplay, value: unknown): string {
  if (!Array.isArray(value)) throw new Error("Invalid Antigravity tool content");
  const fragments: string[] = [];
  for (const raw of value) {
    const block = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    if (block.type === "content") {
      if (!Object.hasOwn(block, "content"))
        throw new Error("Missing Antigravity tool content block");
      const content =
        block.content !== null && typeof block.content === "object"
          ? (block.content as Record<string, unknown>)
          : {};
      if (content.type === "text")
        fragments.push(text(content.text, "Invalid Antigravity tool text"));
      else if (content.type === "resource") {
        const resource =
          content.resource !== null && typeof content.resource === "object"
            ? (content.resource as Record<string, unknown>)
            : {};
        if (typeof resource.text === "string") fragments.push(resource.text);
        loss(
          parsed,
          "unsupported-attachment",
          "Antigravity tool resource metadata or binary content cannot be represented by a text tool result",
        );
      } else
        loss(
          parsed,
          "unsupported-attachment",
          "Antigravity tool contained non-text content that cannot be represented by a text tool result",
        );
    } else if (block.type === "diff")
      loss(
        parsed,
        "source-content-truncated",
        "Antigravity tool diff content cannot be represented by a text tool result",
      );
    else if (block.type === "terminal")
      loss(
        parsed,
        "source-content-truncated",
        "Antigravity tool terminal content cannot be represented by a text tool result",
      );
    else
      loss(
        parsed,
        "source-content-truncated",
        "Antigravity tool contained an unsupported structured content block",
      );
  }
  return fragments.join("\n");
}
function updateTool(
  parsed: AntigravityReplay,
  id: string,
  callId: string,
  call: Tool,
  update: Record<string, unknown>,
  initial: boolean,
): void {
  const hasOutput = present(update.rawOutput) || present(update.content);
  if (present(update.status)) {
    const status = text(update.status, "Invalid Antigravity tool status");
    if (!["pending", "in_progress", "completed", "failed"].includes(status))
      throw new Error(`Unsupported Antigravity ACP tool status: ${status}`);
    if (call.resultPosition !== null && call.status !== status)
      throw new Error("Antigravity tool status changed after completion");
    call.status = status;
  }
  const previousSource = call.nameSource,
    changed = new Set<string>();
  for (const field of ["title", "name", "kind"])
    if (present(update[field])) {
      const name = text(update[field], "Invalid Antigravity tool name metadata");
      if (call.nameFields[field] !== name) {
        changed.add(field);
        call.nameFields[field] = name;
      }
    }
  let nameChanged = false;
  if (changed.size) {
    call.nameSource =
      ["title", "name", "kind"].find((key) => Object.hasOwn(call.nameFields, key)) ?? null;
    if (
      previousSource !== call.nameSource ||
      (call.nameSource !== null && changed.has(call.nameSource))
    ) {
      const name = toolName(call.nameFields);
      if (name !== call.name) {
        call.name = name;
        nameChanged = true;
      }
    }
  }
  if (present(update.content)) call.contentText = toolContent(parsed, update.content);
  if (present(update.rawOutput)) call.rawOutput = update.rawOutput;
  if (present(update.locations)) {
    if (!Array.isArray(update.locations)) throw new Error("Invalid Antigravity tool locations");
    if (update.locations.length && !call.locationsReported) {
      loss(
        parsed,
        "source-content-truncated",
        "Antigravity tool locations cannot be represented in the session document",
      );
      call.locationsReported = true;
    }
  }
  const callBlock = parsed.turns[call.callTurn]!.blocks[0]!;
  if (callBlock.type !== "tool-call") throw new Error("Invalid Antigravity tool call turn");
  if (nameChanged) {
    account(parsed, "toolNameBytes", bytes(callBlock.name), bytes(call.name));
    callBlock.name = call.name;
  }
  if (present(update.rawInput)) callBlock.input = jsonText(update.rawInput);
  if (!["completed", "failed"].includes(call.status)) {
    if (!initial) {
      const content = hasOutput ? output(call) : null;
      account(parsed, "toolOutputBytes", 0, bytes(content));
      account(parsed, "toolNameBytes", 0, bytes(call.name));
      parsed.events.push(event(id, "tool-summary", content, call.name, call.status));
    }
    return;
  }
  if (call.resultPosition !== null && !hasOutput) {
    const result = parsed.events[call.resultPosition[1]]!;
    if (nameChanged) {
      account(parsed, "toolNameBytes", bytes(result.tool_name), bytes(call.name));
      result.tool_name = call.name;
    }
    result.tool_status = call.status;
    return;
  }
  const content = output(call) ?? `Antigravity tool status: ${call.status}`,
    previous = call.resultPosition === null ? null : parsed.events[call.resultPosition[1]]!;
  account(parsed, "toolOutputBytes", bytes(previous?.content) * 2, bytes(content) * 2);
  if (previous === null || nameChanged)
    account(parsed, "toolNameBytes", bytes(previous?.tool_name), bytes(call.name));
  const block: Block = {
    type: "tool-result",
    call_id: callId,
    output: content,
    is_error: call.status === "failed",
  };
  if (call.resultPosition !== null) {
    parsed.turns[call.resultPosition[0]]!.blocks[0] = block;
    previous!.content = content;
    if (nameChanged) previous!.tool_name = call.name;
    previous!.tool_status = call.status;
  } else {
    call.resultPosition = [parsed.turns.length, parsed.events.length];
    const resultId = `${id}-result`;
    parsed.events.push(event(resultId, "tool-summary", content, call.name, call.status));
    parsed.turns.push({ id: resultId, role: "tool", timestamp: null, blocks: [block] });
  }
}
function validBase64(value: string): boolean {
  return (
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) &&
    Buffer.from(value, "base64").toString("base64") === value
  );
}
function attachmentName(value: Record<string, unknown>): string | null {
  const name = property(value, ["name", "title", "uri"]);
  return typeof name === "string" && name.length ? name : null;
}
function textualMedia(value: string): boolean {
  const type = trimWhitespace(value.split(";")[0]!).replace(/[A-Z]/g, (character) =>
    character.toLowerCase(),
  );
  return (
    type.startsWith("text/") ||
    ["application/json", "application/xml", "application/javascript"].includes(type) ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}
function pushText(
  parsed: AntigravityReplay,
  id: string,
  kind: ConversationEvent["kind"],
  role: Turn["role"],
  content: string,
): void {
  const lastEvent = parsed.events.at(-1),
    lastTurn = parsed.turns.at(-1),
    lastBlock = lastTurn?.blocks.at(-1);
  if (lastEvent?.kind === kind && lastEvent.tool_name === null && lastEvent.content !== null)
    lastEvent.content += content;
  else parsed.events.push(event(id, kind, content));
  if (lastTurn?.role === role && lastBlock?.type === "text") lastBlock.text += content;
  else parsed.turns.push({ id, role, timestamp: null, blocks: [{ type: "text", text: content }] });
}
function pushContent(
  parsed: AntigravityReplay,
  id: string,
  kind: ConversationEvent["kind"],
  role: Turn["role"],
  value: unknown,
): void {
  if (typeof value === "string") {
    if (value) pushText(parsed, id, kind, role, value);
    return;
  }
  if (value === undefined) throw new Error("Antigravity ACP message chunk is missing content");
  const fields =
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  let block: Extract<Block, { type: "attachment" }>;
  if (fields.type === "text") {
    const content = text(fields.text, "Antigravity ACP text content is missing text");
    if (content) pushText(parsed, id, kind, role, content);
    return;
  }
  if (fields.type === "image" || fields.type === "audio") {
    const data = text(fields.data, `Antigravity ACP ${fields.type} content is missing data`),
      media = text(fields.mimeType, `Antigravity ACP ${fields.type} content is missing mimeType`);
    if (!data || !validBase64(data))
      throw new Error(`Antigravity ACP ${fields.type} content is not valid base64`);
    if (!media) throw new Error(`Antigravity ACP ${fields.type} content is missing mimeType`);
    if (fields.type === "audio")
      loss(
        parsed,
        "unsupported-attachment",
        "Antigravity audio was preserved as a document attachment",
      );
    block = {
      type: "attachment",
      kind: fields.type === "image" ? "image" : "document",
      media_type: media,
      filename: attachmentName(fields),
      inline_base64: data,
    };
  } else if (fields.type === "resource") {
    const resource = acpObject(fields.resource);
    let data: string | null = null,
      fromText = false;
    if (typeof resource.blob === "string") {
      if (!validBase64(resource.blob))
        throw new Error("Antigravity ACP resource blob is not valid base64");
      data = resource.blob;
    } else if (typeof resource.text === "string") {
      data = Buffer.from(resource.text).toString("base64");
      fromText = true;
    }
    if (data === null)
      loss(parsed, "external-attachment", "Antigravity resource content remains external");
    const declared =
      typeof resource.mimeType === "string" && hasText(resource.mimeType)
        ? resource.mimeType
        : "application/octet-stream";
    block = {
      type: "attachment",
      kind: "document",
      media_type: fromText && !textualMedia(declared) ? "text/plain" : declared,
      filename: attachmentName(resource),
      inline_base64: data,
    };
  } else if (fields.type === "resource_link") {
    loss(parsed, "external-attachment", "Antigravity resource link remains external");
    block = {
      type: "attachment",
      kind: "document",
      media_type:
        typeof fields.mimeType === "string" ? fields.mimeType : "application/octet-stream",
      filename: attachmentName(fields),
      inline_base64: null,
    };
  } else if (typeof fields.type === "string") {
    loss(
      parsed,
      "unsupported-attachment",
      "Antigravity message contained an unsupported content block",
    );
    return;
  } else throw new Error("Invalid Antigravity ACP message content");
  const attachment = event(id, kind, block.filename ?? block.media_type);
  attachment.attachment_count = 1;
  parsed.events.push(attachment);
  parsed.turns.push({ id, role, timestamp: null, blocks: [block] });
}
function merge(
  parsed: AntigravityReplay,
  messages: Map<string, [number, number]>,
  messageId: string | null,
  chunk: AntigravityReplay,
): void {
  for (const [code, count] of chunk.losses)
    parsed.losses.set(code, (parsed.losses.get(code) ?? 0) + count);
  for (const warning of chunk.warnings)
    if (!parsed.warnings.includes(warning)) parsed.warnings.push(warning);
  const turn = chunk.turns[0],
    incoming = chunk.events[0];
  if (!turn) return;
  if (!incoming) throw new Error("Missing Antigravity message event");
  const previous = messageId === null ? undefined : messages.get(messageId);
  if (previous) {
    const target = parsed.turns[previous[0]]!,
      targetEvent = parsed.events[previous[1]]!;
    if (target.role !== turn.role) throw new Error("Antigravity messageId changed role");
    for (const block of turn.blocks) {
      const last = target.blocks.at(-1);
      if (last?.type === "text" && block.type === "text") last.text += block.text;
      else target.blocks.push(block);
    }
    if (incoming.content !== null)
      targetEvent.content =
        targetEvent.content === null
          ? incoming.content
          : targetEvent.content +
            (targetEvent.attachment_count > 0 || incoming.attachment_count > 0 ? "\n" : "") +
            incoming.content;
    targetEvent.attachment_count += incoming.attachment_count;
  } else {
    if (messageId !== null) messages.set(messageId, [parsed.turns.length, parsed.events.length]);
    turn.id = incoming.id;
    parsed.turns.push(turn);
    parsed.events.push(incoming);
  }
}
export function parseAntigravityReplay(
  updates: Record<string, unknown>[],
  deadline = performance.now() + 15_000,
): AntigravityReplay {
  const parsed = empty(),
    tools = new Map<string, Tool>(),
    messages = new Map<string, [number, number]>();
  let lastHadId = false;
  const check = () => {
    if (performance.now() >= deadline)
      throw new Error("Antigravity ACP replay timed out while parsing history");
  };
  for (let index = 0; index < updates.length; index++) {
    check();
    const update = updates[index]!,
      kind = text(update.sessionUpdate, "Antigravity ACP replay update is missing sessionUpdate"),
      id = `antigravity-update-${index}`;
    if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
      const eventKind = kind === "user_message_chunk" ? "user-message" : "agent-message",
        role = kind === "user_message_chunk" ? "user" : "assistant";
      let messageId: string | null = null;
      if (present(update.messageId)) {
        messageId = text(update.messageId, "Invalid Antigravity messageId");
        if (!messageId) throw new Error("Invalid Antigravity messageId");
      }
      if (messageId !== null || lastHadId) {
        const chunk = empty();
        pushContent(chunk, id, eventKind, role, update.content);
        merge(parsed, messages, messageId, chunk);
      } else pushContent(parsed, id, eventKind, role, update.content);
      lastHadId = messageId !== null;
    } else if (kind === "agent_thought_chunk")
      loss(parsed, "reasoning-excluded", "Antigravity reasoning content was excluded");
    else if (kind === "tool_call") {
      const value = callId(update),
        name = toolName(update);
      if (tools.has(value)) throw new Error("Duplicate Antigravity tool call ID");
      const call: Tool = {
          name,
          nameSource: null,
          nameFields: {},
          status: "pending",
          rawOutput: undefined,
          contentText: null,
          locationsReported: false,
          callTurn: parsed.turns.length,
          resultPosition: null,
        },
        input = Object.hasOwn(update, "rawInput") ? jsonText(update.rawInput) : "";
      account(parsed, "toolNameBytes", 0, bytes(name) * 2);
      parsed.events.push(
        event(
          id,
          "tool-summary",
          input || null,
          name,
          typeof update.status === "string" ? update.status : null,
        ),
      );
      parsed.turns.push({
        id,
        role: "tool",
        timestamp: null,
        blocks: [{ type: "tool-call", call_id: value, name, input }],
      });
      updateTool(parsed, id, value, call, update, true);
      tools.set(value, call);
    } else if (kind === "tool_call_update") {
      const value = callId(update),
        call = tools.get(value);
      if (!call) throw new Error("Orphan Antigravity tool result");
      updateTool(parsed, id, value, call, update, false);
    } else if (kind === "session_info_update") {
      for (const key of Object.keys(update).sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      )) {
        if (key === "sessionUpdate") continue;
        if (key === "title")
          parsed.title =
            update[key] === null ? null : text(update[key], "Invalid Antigravity session title");
        else if (key === "updatedAt") {
          const time = acpTimestamp(update[key]);
          if (update[key] !== null && time === null)
            throw new Error("Invalid Antigravity session updatedAt");
          parsed.updated_at = time;
        } else
          loss(
            parsed,
            "source-content-truncated",
            "Antigravity session metadata included fields without a session document mapping",
          );
      }
    } else if (
      ![
        "plan",
        "available_commands_update",
        "current_mode_update",
        "config_option_update",
        "usage_update",
      ].includes(kind)
    )
      throw new Error(`Unsupported Antigravity ACP replay update: ${kind}`);
    check();
  }
  check();
  return parsed;
}
