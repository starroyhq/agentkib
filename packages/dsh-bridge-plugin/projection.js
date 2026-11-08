// Bounded, plain-data projections of DeepSeek Harness state. Nothing here reaches into the
// model surface: hidden reasoning, system prompts, provider frames and injected context stay out.

export const MAX_TEXT = 64 * 1024;
export const MAX_PREVIEW = 4 * 1024;
export const MAX_STREAM = 128 * 1024;

export function bounded(value, max = MAX_TEXT) {
  if (typeof value !== "string") return { text: "", truncated: false };
  if (value.length <= max) return { text: value, truncated: false };
  // Do not split a surrogate pair.
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: value.slice(0, end), truncated: true };
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
// DSH names a stored image after the digest of its bytes, so AgentKib can check what it reads.
const ATTACHMENT_ID = /^sha256:[a-f0-9]{64}$/;

/** The stored image an admitted image block refers to, or null for anything else. */
function imageRef(block) {
  const ref = block?.attachment;
  if (typeof ref?.attachmentId !== "string" || !ATTACHMENT_ID.test(ref.attachmentId)) return null;
  if (!IMAGE_TYPES.has(ref.mediaType)) return null;
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    name: typeof ref.name === "string" && ref.name ? bounded(ref.name, 255).text : null,
  };
}

/**
 * Text blocks only; images and files are counted and images keep their stored reference.
 * Reasoning and tool blocks are not text.
 */
export function contentParts(content) {
  if (typeof content === "string") return { text: content, images: 0, imageRefs: [], files: 0 };
  const parts = Array.isArray(content) ? content : [];
  const images = parts.filter((block) => block?.type === "image");
  return {
    text: parts
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n"),
    images: images.length,
    imageRefs: images.map(imageRef).filter(Boolean).slice(0, 32),
    files: parts.filter((block) => block?.type === "file").length,
  };
}

/** Human prompts carry a `user` source; injected context (notices, AGENTS.md, skills) does not. */
export function isHumanMessage(message) {
  return message?.source?.kind === "user";
}

/** One displayable history record, or null for events the conversation view never shows. */
export function historyRecord(event) {
  const base = { seq: event?.seq, time: typeof event?.time === "number" ? event.time : null };
  if (!Number.isSafeInteger(base.seq)) return null;
  const data = event.data ?? {};
  switch (event.type) {
    case "turn/start":
      return { ...base, kind: "turn-start", turn: data.turn };
    case "turn/end":
      return { ...base, kind: "turn-end", turn: data.turn, reason: reasonOf(data.reason) };
    case "user/message": {
      if (!isHumanMessage(data)) return null;
      const parts = contentParts(data.content);
      const { text, truncated } = bounded(parts.text);
      return {
        ...base,
        kind: "user",
        id: typeof data.id === "string" ? data.id : null,
        text,
        truncated,
        images: parts.imageRefs,
        files: parts.files,
        rpcId: typeof data.source?.rpcId === "string" ? data.source.rpcId : null,
      };
    }
    case "assistant/message": {
      const parts = contentParts(data.message?.content);
      const { text, truncated } = bounded(parts.text);
      if (!text) return null;
      return {
        ...base,
        kind: "assistant",
        turn: data.turn,
        text,
        truncated,
        interrupted: data.interrupted === true,
      };
    }
    case "tool/call":
      return {
        ...base,
        kind: "tool-call",
        turn: data.turn,
        callId: String(data.callId ?? ""),
        name: bounded(String(data.name ?? ""), 256).text,
      };
    case "tool/result": {
      const parts = contentParts(data.message?.content);
      const preview = bounded(parts.text, MAX_PREVIEW);
      return {
        ...base,
        kind: "tool-result",
        turn: data.turn,
        callId: String(data.message?.toolCallId ?? ""),
        isError: data.message?.isError === true,
        preview: preview.text,
        truncated: preview.truncated,
      };
    }
    // A slash command DSH ran itself, never the model, and what it answered.
    case "command/run":
      return {
        ...base,
        kind: "command",
        commandId: bounded(String(data.commandId ?? ""), 128).text,
        name: bounded(String(data.name ?? ""), 128).text,
        args: typeof data.args === "string" ? bounded(data.args, MAX_PREVIEW).text : null,
      };
    case "command/done":
      return {
        ...base,
        kind: "command-result",
        commandId: bounded(String(data.commandId ?? ""), 128).text,
        ok: data.kind === "success",
        text: typeof data.text === "string" ? bounded(data.text, MAX_PREVIEW).text : null,
      };
    default:
      return null;
  }
}

// A handoff or search reads whole messages; a page is still bounded (`DOCUMENT_PAGE_BYTES`).
export const MAX_DOCUMENT_TEXT = 256 * 1024;
export const MAX_DOCUMENT_ARGUMENTS = 64 * 1024;
export const MAX_DOCUMENT_OUTPUT = 128 * 1024;

/**
 * One record of a session's conversation for handoff and search, or null for the rest of the log.
 * `position` is the event's place on DSH's current model surface, absent when a compaction took
 * it off. Injected context, system and developer messages and reasoning stay out; a compaction
 * checkpoint becomes its summary.
 */
export function documentRecord(event, position) {
  const current = Number.isSafeInteger(position);
  const base = {
    seq: event?.seq,
    time: typeof event?.time === "number" ? event.time : null,
    position: current ? position : null,
  };
  if (!Number.isSafeInteger(base.seq)) return null;
  const data = event.data ?? {};
  switch (event.type) {
    case "user/message": {
      const parts = contentParts(data.content);
      const { text, truncated } = bounded(parts.text, MAX_DOCUMENT_TEXT);
      if (data.source?.kind === "compact-checkpoint")
        return text ? { ...base, current, kind: "summary", text, truncated } : null;
      if (!isHumanMessage(data) || (!text && !parts.images && !parts.files)) return null;
      return {
        ...base,
        current,
        kind: "user",
        text,
        truncated,
        images: parts.imageRefs,
        files: parts.files,
      };
    }
    case "assistant/message": {
      const blocks = Array.isArray(data.message?.content) ? data.message.content : [];
      const { text, truncated } = bounded(contentParts(blocks).text, MAX_DOCUMENT_TEXT);
      const calls = blocks
        .filter((block) => block?.type === "tool-call")
        .slice(0, 64)
        .map((block) => {
          const input = bounded(
            typeof block.arguments === "string" ? block.arguments : "",
            MAX_DOCUMENT_ARGUMENTS,
          );
          return {
            id: bounded(String(block.id ?? ""), 256).text,
            name: bounded(String(block.name ?? ""), 256).text,
            arguments: input.text,
            truncated: input.truncated,
          };
        });
      const reasoning = blocks.some((block) => block?.type === "reasoning");
      if (!text && !calls.length && !reasoning) return null;
      return { ...base, current, kind: "assistant", text, truncated, calls, reasoning };
    }
    case "tool/result": {
      const parts = contentParts(data.message?.content);
      const output = bounded(parts.text, MAX_DOCUMENT_OUTPUT);
      return {
        ...base,
        current,
        kind: "tool-result",
        callId: bounded(String(data.message?.toolCallId ?? ""), 256).text,
        isError: data.message?.isError === true,
        text: output.text,
        truncated: output.truncated,
        images: parts.images,
      };
    }
    default:
      return null;
  }
}

/** One of DSH's Agent presets, or null for a row that is not one. */
export function presetEntry(row) {
  if (typeof row?.id !== "string" || !row.id || row.id.length > 128) return null;
  const optional = (value, max) =>
    typeof value === "string" && value ? bounded(value, max).text : null;
  return {
    id: row.id,
    name: optional(row.name, 256),
    description: optional(row.description, 1024),
    isDefault: row.isDefault === true,
    broken: optional(row.broken, 512),
  };
}

function reasonOf(reason) {
  if (typeof reason === "string") return reason;
  if (reason && typeof reason === "object" && typeof reason.kind === "string") return reason.kind;
  return null;
}

/** Pending inbox items a person can see: queued prompts and steering, never injected context. */
export function queueItems(agent) {
  const items = [];
  const add = (messages, placement) => {
    for (const message of Array.isArray(messages) ? messages : []) {
      if (!isHumanMessage(message)) continue;
      const parts = contentParts(message.content);
      items.push({
        id: String(message.id),
        placement,
        text: bounded(parts.text, MAX_PREVIEW).text,
        images: Math.min(parts.images, 64),
        rpcId: typeof message.source?.rpcId === "string" ? message.source.rpcId : null,
      });
    }
  };
  add(agent?.inbox?.nextTurn, "queued");
  add(agent?.inbox?.nextStep, "steering");
  return items.slice(0, 64);
}

const titleOf = (projections) => {
  const value = projections?.values?.title;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.title === "string") return value.title;
  return null;
};

/**
 * One row of `sessionController.list`, reduced to what the AgentKib catalog stores. `archived`
 * is DSH's archive set, which lives in its workspace controller, not in the session list.
 */
export function sessionSummary(item, archived) {
  if (!item || typeof item.sessionId !== "string" || typeof item.cwd !== "string") return null;
  return {
    sessionId: item.sessionId,
    cwd: item.cwd,
    title: bounded(titleOf(item.projections) ?? "", 512).text || null,
    updatedAt: Number.isSafeInteger(item.updatedAt) ? item.updatedAt : null,
    running: item.running === true,
    live: item.agentAvailable === true,
    blank: item.blank === true,
    parentSessionId: typeof item.parentSessionId === "string" ? item.parentSessionId : null,
    origin: item.origin === "subagent" ? "subagent" : null,
    archived: archived?.has(item.sessionId) === true,
  };
}

const ID_LIMIT = 128;
const shortId = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= ID_LIMIT ? value : null;
function modelSelection(value) {
  const provider = shortId(value?.provider);
  const model = shortId(value?.model);
  if (!provider || !model) return null;
  return { provider, model, reasoningEffort: shortId(value.reasoningEffort) };
}

/**
 * DSH's model catalog flattened for AgentKib's model picker. An identifier too long to pass back
 * to `selectModel` unchanged is left out rather than shortened. `selected` is the session's model.
 */
export function modelsProjection(catalog, selected) {
  const models = [];
  for (const group of Array.isArray(catalog?.groups) ? catalog.groups.slice(0, 32) : []) {
    const provider = shortId(group?.id);
    if (!provider) continue;
    for (const model of Array.isArray(group.models) ? group.models.slice(0, 64) : []) {
      const id = shortId(model?.id);
      if (!id || models.length >= 64) continue;
      const efforts = Array.isArray(model.reasoning?.efforts) ? model.reasoning.efforts : [];
      models.push({
        provider,
        providerName: bounded(String(group.name ?? provider), 128).text,
        model: id,
        name: bounded(String(model.name ?? id), 256).text,
        efforts: efforts
          .slice(0, 16)
          .filter((effort) => shortId(effort?.id))
          .map((effort) => ({
            id: effort.id,
            name: bounded(String(effort.name ?? effort.id), 128).text,
          })),
        defaultEffort: shortId(model.reasoning?.defaultEffort),
      });
    }
  }
  return { models, default: modelSelection(catalog?.default), selected: modelSelection(selected) };
}

/** A pending native question, bounded for display. Option labels are answer values. */
export function questionItems(questions) {
  return (Array.isArray(questions) ? questions : []).slice(0, 8).map((question) => ({
    id: String(question?.id ?? ""),
    question: bounded(String(question?.question ?? ""), MAX_PREVIEW).text,
    header: typeof question?.header === "string" ? bounded(question.header, 256).text : null,
    detail: typeof question?.detail === "string" ? bounded(question.detail, MAX_TEXT).text : null,
    multiSelect: question?.multiSelect === true,
    options: (Array.isArray(question?.options) ? question.options : [])
      .slice(0, 32)
      .map((option) => ({
        label: bounded(String(option?.label ?? ""), 512).text,
        description:
          typeof option?.description === "string" ? bounded(option.description, 1024).text : null,
      })),
    intent:
      question?.intent?.kind === "plan-review"
        ? { kind: "plan-review", approve: String(question.intent.approve ?? "") }
        : question?.intent?.kind === "approval"
          ? {
              kind: "approval",
              approve: String(question.intent.approve ?? ""),
              reject: String(question.intent.reject ?? ""),
              ...(typeof question.intent.always === "string"
                ? { always: question.intent.always }
                : {}),
            }
          : null,
  }));
}

const GOAL_PHASES = new Set(["active", "paused", "blocked", "complete"]);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const time = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * A goal as DSH's goal service reports it. A change names `id` and `revision`, so one made in
 * DSH's own window meanwhile makes it fail instead of being overwritten. `activation` says
 * whether this DSH continues the goal by itself; a session DSH has just resumed starts disarmed
 * until someone resumes the goal.
 */
export function goalView(view) {
  if (!view || typeof view !== "object" || !GOAL_PHASES.has(view.phase)) return null;
  const id = shortId(view.id);
  if (!id || !Number.isSafeInteger(view.revision) || view.revision < 1) return null;
  const reason = view.phase === "blocked" ? view.blockedReason : null;
  return {
    id,
    revision: view.revision,
    objective: bounded(String(view.objective ?? ""), MAX_TEXT).text,
    phase: view.phase,
    blockedReason:
      reason && typeof reason.code === "string"
        ? {
            code: bounded(reason.code, 128).text,
            message: bounded(String(reason.message ?? ""), MAX_PREVIEW).text,
          }
        : null,
    maxGoalRounds: count(view.maxGoalRounds),
    roundsStarted: count(view.roundsStarted),
    createdAt: time(view.createdAt),
    updatedAt: time(view.updatedAt),
    activation: view.activation === "armed" ? "armed" : "disarmed",
  };
}

/** The goal of a session without a running agent, from DSH's `goal` projection. */
export function goalFromProjection(projection) {
  if (!projection || typeof projection !== "object") return null;
  return goalView({
    ...projection.goal,
    roundsStarted: projection.roundsStarted,
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
    activation: "disarmed",
  });
}

/** DSH's slash commands, as its own `/` menu lists them. */
export function commandEntries(list) {
  const entries = [];
  for (const command of Array.isArray(list) ? list.slice(0, 128) : []) {
    if (typeof command?.name !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(command.name))
      continue;
    entries.push({
      name: command.name,
      description: bounded(String(command.description ?? ""), 512).text,
      hint: typeof command.input?.hint === "string" ? bounded(command.input.hint, 256).text : null,
      attachments: command.input?.attachments === true,
    });
  }
  return entries;
}

/** DSH's permission presets: each one a sandbox mode with an approval policy. */
export function permissionOptions(catalog) {
  return (Array.isArray(catalog?.options) ? catalog.options.slice(0, 32) : [])
    .filter((option) => shortId(option?.value))
    .map((option) => ({
      value: option.value,
      name: bounded(String(option.name ?? option.value), 128).text,
      description:
        typeof option.description === "string" ? bounded(option.description, 512).text : null,
    }));
}

const SUBAGENT_MODES = new Set(["one-shot", "external", "continuable", "unknown"]);

/** One direct child from the parent's `subagentCatalog` projection. */
export function subagentEntry(entry) {
  const sessionId = shortId(entry?.id);
  if (!sessionId) return null;
  return {
    sessionId,
    createdAt: time(entry.createdAt),
    mode: SUBAGENT_MODES.has(entry.mode) ? entry.mode : "unknown",
    label: typeof entry.label === "string" && entry.label ? bounded(entry.label, 256).text : null,
  };
}
