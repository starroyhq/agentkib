/**
 * Names a Codex thread AgentKib runs as Codex's terminal client names its own (CLI 0.167.0
 * `tui/src/app/thread_title.rs` and `tui/src/temporary_structured_request.rs`). The app-server
 * does not name threads by itself: the client asks a temporary thread beside the session for a
 * title of the first message, in one turn with a structured answer, and gives the title to the
 * thread with `thread/name/set`. With 0.167.0's own app-server, offline, the thread's settings
 * below kept a configured MCP server from starting, which it does without them.
 */

import type { CodexAppServerSession } from "./codex-app-server";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Characters (code points) a title keeps: the TUI's `THREAD_TITLE_MAX_CHARS`. */
export const THREAD_TITLE_MAX_CHARS = 36;
/** The model the TUI names threads with when the model list offers it, at low effort. */
export const THREAD_TITLE_MODEL = "gpt-5.6-luna";
/** The part of the first message the prompt carries, in UTF-8 bytes. */
const MESSAGE_MAX_BYTES = 960;
/** The TUI's bound on the temporary thread's turn. */
const TITLE_TIMEOUT_MS = 30_000;
/** The TUI's bound on the structured answer. */
const ANSWER_MAX_BYTES = 8 * 1024;
/** Temporary threads remembered after they end, so that late messages stay out of sessions. */
const REMEMBERED_THREADS = 64;
/** The analytics source the TUI gives these threads (`ThreadStartParams.threadSource`). */
const THREAD_SOURCE = "thread_title";
/**
 * What the TUI turns off for its temporary thread (`temporary_structured_request.rs`): tools,
 * hooks, plugins, skills, memories and the like, so that a title runs nothing but the model.
 * The person's MCP servers are added by name, and Codex's built-in read-only profile is the
 * thread's permissions, as for a session without a profile of its own.
 */
const TITLE_THREAD_CONFIG: Json = {
  ...Object.fromEntries(
    [
      "apps",
      "code_mode",
      "code_mode_only",
      "context_management",
      "current_time_reminder",
      "deferred_executor",
      "enable_fanout",
      "goals",
      "hooks",
      "image_generation",
      "memories",
      "multi_agent",
      "multi_agent_v2",
      "plugins",
      "request_permissions_tool",
      "shell_snapshot",
      "shell_tool",
      "standalone_web_search",
      "token_budget",
      "tool_suggest",
      "unified_exec",
      "view_image",
    ].map((feature) => [`features.${feature}`, false]),
  ),
  "cloud.skills.enabled": false,
  "skills.include_instructions": false,
  "tools.experimental_request_user_input.enabled": false,
  "tools.update_plan.enabled": false,
  web_search: "disabled",
  default_permissions: ":read-only",
};

const INSTRUCTIONS =
  `Generate a concise, single-line task title of at most ${THREAD_TITLE_MAX_CHARS} characters ` +
  "and under five words where possible. Start with an imperative verb. Capitalize only the " +
  "first word unless the user's language, proper nouns, acronyms, or code terms require " +
  "otherwise. Preserve ticket references exactly. Write in the user's language. Do not use " +
  "quotes, markdown, or trailing punctuation. Do not answer the request.";

/** The answer's shape: a title and nothing else (the TUI's `thread_title_output_schema`). */
export const THREAD_TITLE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: THREAD_TITLE_MAX_CHARS },
  },
  required: ["title"],
  additionalProperties: false,
};

/** The title turn's prompt: the TUI's instructions, then the first message cut to 960 bytes. */
export function threadTitlePrompt(message: string): string {
  return `${INSTRUCTIONS}\n\nUser prompt:\n${utf8Prefix(message.trim(), MESSAGE_MAX_BYTES)}`;
}

const QUOTES = new Set(['"', "'", "`", "“", "”", "‘", "’"]);

/** The TUI's `parse_thread_title`: the answer's title on one line, or null. */
export function parseThreadTitle(answer: string): string | null {
  const text = answer.trimStart();
  if (!text.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.title !== "string" || Object.keys(value).length !== 1)
    return null;
  const characters = [...value.title.trim()];
  while (characters.length > 0 && QUOTES.has(characters[0]!)) characters.shift();
  while (characters.length > 0 && QUOTES.has(characters.at(-1)!)) characters.pop();
  const title = characters
    .join("")
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ")
    .replace(/[.?!]+$/u, "")
    .trimEnd();
  if (!title) return null;
  return [...title].slice(0, THREAD_TITLE_MAX_CHARS).join("").trimEnd();
}

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * What the title turn runs on: the TUI's model when `model/list` offers it, at low effort; else
 * the thread's own model at the lowest effort the list gives it (Codex's default for a model the
 * list does not show). Null when neither is known.
 */
export function threadTitleModel(
  modelList: unknown,
  threadModel: string | null,
): { model: string; effort: string | null } | null {
  const rows =
    isObject(modelList) && Array.isArray(modelList.data) ? modelList.data.filter(isObject) : [];
  const efforts = (id: string): string[] => {
    const row = rows.find((model) => model.model === id);
    return Array.isArray(row?.supportedReasoningEfforts)
      ? row.supportedReasoningEfforts
          .filter(isObject)
          .map((effort) => effort.reasoningEffort)
          .filter((effort): effort is string => typeof effort === "string")
      : [];
  };
  if (rows.some((model) => model.model === THREAD_TITLE_MODEL)) {
    const supported = efforts(THREAD_TITLE_MODEL);
    return {
      model: THREAD_TITLE_MODEL,
      effort: supported.includes("low") ? "low" : lowestEffort(supported),
    };
  }
  return threadModel ? { model: threadModel, effort: lowestEffort(efforts(threadModel)) } : null;
}

function lowestEffort(efforts: string[]): string | null {
  const rank = (effort: string) => {
    const index = EFFORTS.indexOf(effort);
    return index < 0 ? EFFORTS.length : index;
  };
  return efforts.reduce<string | null>(
    (lowest, effort) => (lowest === null || rank(effort) < rank(lowest) ? effort : lowest),
    null,
  );
}

/** The text of a user message that Codex shows starting or ending in `threadId`, or null. */
export function codexUserMessageText(value: unknown, threadId: string | null): string | null {
  if (!threadId || !isObject(value)) return null;
  if (value.method !== "item/started" && value.method !== "item/completed") return null;
  const params = isObject(value.params) ? value.params : {};
  const item = isObject(params.item) ? params.item : null;
  if (params.threadId !== threadId || item?.type !== "userMessage") return null;
  return Array.isArray(item.content)
    ? item.content
        .filter(isObject)
        .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n")
    : "";
}

/**
 * The temporary threads that name AgentKib's Codex threads. Each runs on the app-server of the
 * session it names, so its notifications and requests reach that session's listeners as well;
 * they skip what `owns` claims, which keeps the title's turn out of the session.
 */
export class CodexTitleThreads {
  #threads = new Set<string>();

  /** Whether a notification or server request belongs to a temporary title thread. */
  owns(value: unknown): boolean {
    if (this.#threads.size === 0) return false;
    const thread = threadOf(value);
    return thread !== null && this.#threads.has(thread);
  }

  /**
   * A title for the first message of `threadId`, from a temporary thread on `session`: ephemeral,
   * so that Codex keeps nothing of it, read-only, never asking for approval and without tools,
   * hooks or MCP servers. Null when any step fails. The temporary thread is unsubscribed
   * afterwards.
   */
  async generate(
    session: CodexAppServerSession,
    request: {
      threadId: string;
      cwd: string;
      model: string;
      effort: string | null;
      message: string;
      timeoutMs?: number;
    },
  ): Promise<string | null> {
    // The MCP servers Codex would start in this directory, none of which may start for a title.
    // As in the TUI, no title without knowing them.
    const read = await session
      .request("config/read", { includeLayers: false, cwd: request.cwd })
      .catch(() => null);
    if (!isObject(read) || !isObject(read.config)) return null;
    const servers = isObject(read.config.mcp_servers) ? Object.keys(read.config.mcp_servers) : [];
    const response = await session
      .request("thread/start", {
        cwd: request.cwd,
        model: request.model,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        threadSource: THREAD_SOURCE,
        config: {
          ...TITLE_THREAD_CONFIG,
          mcp_servers: Object.fromEntries(
            servers.sort().map((server) => [server, { enabled: false }]),
          ),
        },
      })
      .catch(() => null);
    const thread = isObject(response) && isObject(response.thread) ? response.thread : null;
    const sandbox = isObject(response) && isObject(response.sandbox) ? response.sandbox : null;
    const id = typeof thread?.id === "string" && thread.id ? thread.id : null;
    // Never the session's own thread, which must neither be skipped nor unsubscribed.
    if (!thread || !id || id === request.threadId) return null;
    this.#threads.add(id);
    if (this.#threads.size > REMEMBERED_THREADS)
      this.#threads.delete(this.#threads.values().next().value!);
    try {
      // A Codex that would keep the thread, or let its turn write, does not run it.
      if (thread.ephemeral !== true || sandbox?.type !== "readOnly") return null;
      const answer = await this.#turn(session, id, request);
      return answer === null ? null : parseThreadTitle(answer);
    } catch {
      return null;
    } finally {
      if (session.connected)
        await session.request("thread/unsubscribe", { threadId: id }).catch(() => undefined);
    }
  }

  /** Runs the one turn: its final agent message, or null when it fails or does not end in time. */
  async #turn(
    session: CodexAppServerSession,
    thread: string,
    request: { message: string; effort: string | null; timeoutMs?: number },
  ): Promise<string | null> {
    let answer: string | null = null;
    let settle!: (value: { completed: boolean; answer: string | null }) => void;
    const result = new Promise<{ completed: boolean; answer: string | null }>(
      (resolve) => (settle = resolve),
    );
    const onNotification = (value: unknown) => {
      if (!isObject(value) || threadOf(value) !== thread) return;
      const params = isObject(value.params) ? value.params : {};
      const item = isObject(params.item) ? params.item : null;
      if (
        value.method === "item/completed" &&
        item?.type === "agentMessage" &&
        typeof item.text === "string"
      ) {
        if (Buffer.byteLength(item.text, "utf8") > ANSWER_MAX_BYTES)
          settle({ completed: false, answer: null });
        else answer = item.text;
      } else if (value.method === "turn/completed" && isObject(params.turn))
        settle({ completed: true, answer: params.turn.status === "completed" ? answer : null });
    };
    // Nothing the title's turn asks for is given; an answer lets it go on rather than wait.
    const onRequest = (value: unknown) => {
      if (!isObject(value) || threadOf(value) !== thread) return;
      try {
        if (value.method === "mcpServer/elicitation/request")
          session.respond(value.id, { action: "decline" });
        else
          session.respondError(
            value.id,
            -32601,
            `AgentKib does not handle ${[...String(value.method)].slice(0, 128).join("")}`,
          );
      } catch {
        // A closed connection ends the turn below.
      }
    };
    const onClose = () => settle({ completed: false, answer: null });
    const timer = setTimeout(
      () => settle({ completed: false, answer: null }),
      request.timeoutMs ?? TITLE_TIMEOUT_MS,
    );
    timer.unref?.();
    session.on("notification", onNotification);
    session.on("serverRequest", onRequest);
    session.once("close", onClose);
    let turnId: string | null = null;
    let completed = false;
    try {
      const response = await session.request("turn/start", {
        threadId: thread,
        input: [{ type: "text", text: threadTitlePrompt(request.message) }],
        outputSchema: THREAD_TITLE_SCHEMA,
        ...(request.effort ? { effort: request.effort } : {}),
      });
      const turn = isObject(response) && isObject(response.turn) ? response.turn : null;
      if (typeof turn?.id !== "string" || !turn.id) return null;
      turnId = turn.id;
      const outcome = await result;
      completed = outcome.completed;
      return outcome.answer;
    } finally {
      clearTimeout(timer);
      session.off("notification", onNotification);
      session.off("serverRequest", onRequest);
      session.off("close", onClose);
      // A turn that did not end in time is stopped before its thread is let go.
      if (turnId !== null && !completed && session.connected)
        await session
          .request("turn/interrupt", { threadId: thread, turnId })
          .catch(() => undefined);
    }
  }
}

/** The thread a notification or server request is about, when it names one. */
function threadOf(value: unknown): string | null {
  if (!isObject(value) || !isObject(value.params)) return null;
  const params = value.params;
  if (typeof params.threadId === "string") return params.threadId;
  return isObject(params.thread) && typeof params.thread.id === "string" ? params.thread.id : null;
}

/** The longest start of `text` within `maxBytes` UTF-8 bytes that splits no character. */
function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > maxBytes) break;
    end += character.length;
  }
  return text.slice(0, end);
}
