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

/** Text blocks only; images and files are counted, reasoning and tool blocks are not text. */
export function contentParts(content) {
  if (typeof content === "string") return { text: content, images: 0, files: 0 };
  const parts = Array.isArray(content) ? content : [];
  return {
    text: parts
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n"),
    images: parts.filter((block) => block?.type === "image").length,
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
        images: parts.images,
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
    default:
      return null;
  }
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
