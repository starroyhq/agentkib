// The AgentKib side of a running DeepSeek Harness process. It reports sessions, live state and
// pending interactions to every AgentKib Runtime it can discover, and runs their commands
// through DSH's own session services. It never rewrites the log or starts another executor.
import { createHash, randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { DSH_BRIDGE_COMPATIBILITY } from "./compatibility.js";
import { BridgeHttpError, discover, discoveryRoots, post } from "./client.js";
import { DSH_COMMAND_LINE, DSH_HIDDEN_COMMANDS, dshCommandRefusal } from "./commands.js";
import {
  MAX_PREVIEW,
  MAX_STREAM,
  bounded,
  commandEntries,
  documentRecord,
  goalFromProjection,
  goalView,
  historyRecord,
  isHumanMessage,
  modelsProjection,
  permissionOptions,
  presetEntry,
  queueItems,
  questionItems,
  sessionSummary,
  subagentEntry,
} from "./projection.js";

export const DSH_BRIDGE_PATHS = Object.freeze({
  register: "/v1/register",
  report: "/v1/report",
  poll: "/v1/poll",
  result: "/v1/result",
});

const HEARTBEAT_MS = 10_000;
// A restarted AgentKib writes a new key; DSH sessions stay metadata only until it is found, so
// look often. Each pass only reads one small file per root.
const DISCOVERY_MS = 2_000;
// A DSH that AgentKib started in the background stops once it has not reached that AgentKib for
// this long: three missed heartbeats. AgentKib stops it itself when it quits normally.
const HOST_GONE_MS = 30_000;
const LIST_THROTTLE_MS = 1_000;
const HISTORY_PAGE_BYTES = 1536 * 1024;
// UTF-8 bytes of one conversation page; a bridge message carries at most 8 MiB.
const DOCUMENT_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_PRESETS = 32;
const APPROVAL_OUTCOMES = new Set(["allowed-once", "rejected"]);
// AgentKib's upload limit. DSH applies its own image limits when it takes the prompt.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// A bridge message carries at most 8 MiB; DSH stores images at about 4 MiB.
const MAX_IMAGE_READ_CHARS = 7 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
// A slash command answers within this time or keeps running (a compaction calls the model); its
// outcome is in the session's history either way. AgentKib's Host answers no reads while it
// waits for a control, so the wait stays short; DSH's own commands answer in milliseconds.
const COMMAND_WAIT_MS = 2_000;
const MAX_SUBAGENTS = 50;
// Session events that change what a session's settings show: its permission preset, and its plan
// mode, which a `/plan` switches once its command settles.
const SETTINGS_EVENTS = new Set([
  "permission/preset",
  "sandbox/mode",
  "approval/policy",
  "plan/mode",
  "command/done",
]);

/**
 * One image for a prompt, read from the AgentKib attachment file. The file must still hold the
 * exact bytes AgentKib checked; otherwise the prompt fails before DSH sees it.
 */
async function attachedImage(part) {
  if (
    typeof part?.path !== "string" ||
    !path.isAbsolute(part.path) ||
    typeof part.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(part.sha256) ||
    !Number.isSafeInteger(part.size) ||
    part.size < 1 ||
    part.size > MAX_ATTACHMENT_BYTES ||
    !IMAGE_TYPES.has(part.mediaType)
  )
    throw new Error("invalid-prompt");
  let handle;
  let data;
  try {
    handle = await open(part.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size !== part.size) throw new Error("attachment-changed");
    data = await handle.readFile();
  } catch (error) {
    throw new Error(
      error?.message === "attachment-changed" ? "attachment-changed" : "attachment-unavailable",
    );
  } finally {
    await handle?.close();
  }
  if (data.length !== part.size || createHash("sha256").update(data).digest("hex") !== part.sha256)
    throw new Error("attachment-changed");
  return {
    type: "image",
    mediaType: part.mediaType,
    data: data.toString("base64"),
    ...(typeof part.name === "string" && part.name ? { name: part.name } : {}),
  };
}

/** DSH's prompt content, with each image's bytes in place of AgentKib's file reference. */
async function promptContent(content) {
  if (!Array.isArray(content) || !content.length || content.length > 32)
    throw new Error("invalid-prompt");
  const parts = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string")
      parts.push({ type: "text", text: part.text });
    else if (part?.type === "image") parts.push(await attachedImage(part));
    else throw new Error("invalid-prompt");
  }
  return parts;
}

/** DSH refuses an image it cannot take: a model without image input, or one over its limits. */
function attachmentRefusal(error) {
  if (error?.code !== "session/attachment-invalid") return error;
  return new Error(
    error.details?.reason === "MODEL_DOES_NOT_SUPPORT_IMAGES"
      ? "model-images-unsupported"
      : "attachment-invalid",
  );
}

const DSH_PACKAGE = /^@deepseek-ai\/dsh(-desktop-host)?$/;

/**
 * Best effort: the launcher package next to the running entry point names the release
 * (npm CLI: `@deepseek-ai/dsh`; DSH Desktop: `@deepseek-ai/dsh-desktop-host`). The plugin can
 * still connect without it, because every operation is also gated by the services it reports.
 */
export function readDshVersion(entry = process.argv[1]) {
  const require = createRequire(import.meta.url);
  try {
    const version = require("@deepseek-ai/dsh/package.json")?.version;
    if (typeof version === "string") return version;
  } catch {
    // Not resolvable from this installation.
  }
  if (typeof entry === "string" && path.isAbsolute(entry))
    for (let directory = path.dirname(entry), depth = 0; depth < 8; depth++) {
      try {
        const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
        if (DSH_PACKAGE.test(manifest?.name) && typeof manifest.version === "string")
          return manifest.version;
      } catch {
        // Keep walking up.
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  return "unknown";
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * The AgentKib that started this DSH in the background, from the plugin row's `managed` config;
 * null for a DSH the user runs.
 */
export function managedHost(config) {
  const home = config?.home;
  return typeof home === "string" && path.isAbsolute(home) && path.normalize(home) === home
    ? { home }
    : null;
}

/**
 * @param ctx - the plugin's Cordis context.
 * @param options - `managed` for a DSH that AgentKib started, and test seams: discovery roots,
 *   a fixed version, process ID, standard input and timers.
 */
export function createBridge(ctx, options = {}) {
  const runtimeId = randomUUID();
  const dshVersion = options.dshVersion ?? readDshVersion();
  // A DSH that AgentKib started reports only to that AgentKib.
  const managed = managedHost(options.managed);
  const roots = options.roots ?? (managed ? [managed.home] : discoveryRoots());
  const lifetime = new AbortController();
  const hosts = new Map();
  /** When an AgentKib last answered; a DSH that AgentKib started stops once this is too old. */
  let lastContact = Date.now();
  /** Monotonic change counter; every report sends what changed after the host's last ack. */
  let version = 0;
  let listVersion = 0;
  /** The list goes out once even when empty, so AgentKib knows DSH has listed its sessions. */
  let listedOnce = false;
  let interactionsVersion = 0;
  let summaries = [];
  let listing = null;
  let listQueued = false;
  let lastList = 0;
  const states = new Map();
  const historyVersions = new Map();
  /** Sessions whose goal or permission preset changed, as history changes are reported. */
  const goalVersions = new Map();
  const settingsVersions = new Map();
  /**
   * DSH's slash commands: the ones registered for every session, and each running agent's own
   * view, which can add commands of its own (DSH's window lists a session's commands this way).
   */
  let commandCatalog = [];
  let commandsVersion = 0;
  const agentCommands = new Map();
  const interactions = new Map();
  const derived = new WeakSet();
  /** DSH's archive set, from its workspace controller. */
  let archived = new Set();
  let followingArchive = false;

  const service = (name) => {
    try {
      return ctx.get?.(name) ?? ctx[name];
    } catch {
      return undefined;
    }
  };
  const bump = () => ++version;
  const watched = (sessionId) => [...hosts.values()].some((host) => host.watch.has(sessionId));

  // ---- live state -------------------------------------------------------------------------

  const stateOf = (sessionId) => {
    let state = states.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        live: false,
        status: "idle",
        turn: null,
        cursor: -1,
        queue: [],
        streamText: "",
        streamTruncated: false,
        // A compaction runs outside any turn, while DSH reports the agent idle.
        activity: null,
        goal: null,
        version: 0,
      };
      states.set(sessionId, state);
    }
    return state;
  };
  const touch = (state) => {
    state.version = bump();
    schedule();
  };
  /**
   * Which goal a change must name. It is part of what a control is decided on, so a goal changed
   * in DSH's own window makes AgentKib read it again before changing it.
   */
  const goalRefOf = (agent) => {
    try {
      const view = goalView(service("goals")?.get?.(agent));
      return view
        ? { id: view.id, revision: view.revision, phase: view.phase, activation: view.activation }
        : null;
    } catch {
      return null;
    }
  };
  const refreshGoal = (agent) => {
    const state = stateOf(String(agent.id));
    const goal = goalRefOf(agent);
    goalVersions.set(state.sessionId, bump());
    if (JSON.stringify(goal) === JSON.stringify(state.goal)) return schedule();
    state.goal = goal;
    touch(state);
  };
  const attach = (agent) => {
    const state = stateOf(String(agent.id));
    state.live = true;
    state.status = agent.status === "running" ? "running" : "idle";
    state.cursor = typeof agent.session?.seq === "number" ? agent.session.seq - 1 : state.cursor;
    state.queue = queueItems(agent);
    state.goal = goalRefOf(agent);
    touch(state);
  };
  const detach = (agent) => {
    const state = stateOf(String(agent.id));
    Object.assign(state, {
      live: false,
      status: "idle",
      turn: null,
      queue: [],
      streamText: "",
      streamTruncated: false,
      activity: null,
      goal: null,
    });
    touch(state);
  };

  ctx.on("agent/created", ({ agent }) => {
    attach(agent);
    refreshList();
    return undefined;
  });
  ctx.on("agent/disposed", ({ agent }) => {
    detach(agent);
    refreshList();
  });
  ctx.on("agent/status", ({ agent, status }) => {
    const state = stateOf(String(agent.id));
    state.live = true;
    state.status = status === "running" ? "running" : "idle";
    state.queue = queueItems(agent);
    if (state.status === "idle") {
      state.streamText = "";
      state.streamTruncated = false;
    }
    touch(state);
  });
  for (const event of ["agent/inbox/inserted", "agent/inbox/claimed", "agent/inbox/discarded"])
    ctx.on(event, ({ agent }) => {
      const state = stateOf(String(agent.id));
      state.queue = queueItems(agent);
      touch(state);
    });
  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    const state = stateOf(String(agent.id));
    if (frame?.type === "start" || frame?.type === "end") {
      if (!state.streamText && !state.streamTruncated) return;
      state.streamText = "";
      state.streamTruncated = false;
    } else if (frame?.type === "chunk" && frame.chunk?.type === "text-delta") {
      if (state.streamTruncated) return;
      const next = state.streamText + String(frame.chunk.text ?? "");
      const { text, truncated } = bounded(next, MAX_STREAM);
      state.streamText = text;
      state.streamTruncated = truncated;
    } else return;
    touch(state);
  });
  ctx.on("session/event", (session, event) => {
    const sessionId = String(session?.id ?? "");
    if (!sessionId) return;
    const state = states.get(sessionId);
    if (state) {
      state.cursor = Math.max(state.cursor, Number(event?.seq ?? -1));
      if (event?.type === "turn/start") state.turn = event.data?.turn ?? null;
      if (event?.type === "turn/end") {
        state.turn = null;
        state.streamText = "";
        state.streamTruncated = false;
      }
      if (event?.type === "compaction/start") state.activity = "compacting";
      if (event?.type === "compaction/end") state.activity = null;
      // Inbox events can fire before the claimed message leaves the inbox; turn edges settle it.
      if (
        event?.type === "turn/start" ||
        event?.type === "turn/end" ||
        event?.type === "user/message"
      ) {
        const agent = service("agents")?.get?.(sessionId);
        if (agent) state.queue = queueItems(agent);
      }
      touch(state);
    }
    if (historyRecord(event)) {
      historyVersions.set(sessionId, bump());
      schedule();
    }
    if (event?.type === "goal/change") {
      const agent = service("agents")?.get?.(sessionId);
      if (agent) refreshGoal(agent);
      else {
        goalVersions.set(sessionId, bump());
        schedule();
      }
    }
    if (SETTINGS_EVENTS.has(event?.type)) {
      settingsVersions.set(sessionId, bump());
      schedule();
    }
    if (event?.type === "session/title" || event?.type === "turn/end") refreshList();
  });
  ctx.on("session/created", () => refreshList());
  ctx.on("session/disposed", () => refreshList());
  // Whether DSH continues a goal by itself lives only in this process, outside the session log.
  ctx.on("goal/activation-changed", (payload) => {
    const agent = service("agents")?.get?.(String(payload?.sessionId ?? ""));
    if (agent) refreshGoal(agent);
  });
  /** Lists the commands again; every report does, so a registration DSH made later shows up. */
  function refreshCommands() {
    const commands = service("commands");
    if (typeof commands?.list !== "function") return;
    try {
      // A session that is not running has no agent: it gets the commands of every session.
      const next = commandEntries(commands.list(undefined));
      if (JSON.stringify(next) !== JSON.stringify(commandCatalog)) {
        commandCatalog = next;
        commandsVersion = bump();
      }
    } catch {
      // Keep the previous catalog; the next report lists again.
    }
    const live = new Set();
    for (const agent of service("agents")?.list?.() ?? []) {
      const sessionId = String(agent.id);
      live.add(sessionId);
      try {
        const entries = commandEntries(commands.list(agent));
        const known = agentCommands.get(sessionId);
        if (!known || JSON.stringify(known.entries) !== JSON.stringify(entries))
          agentCommands.set(sessionId, { entries, version: bump() });
      } catch {
        // This agent is going away; the next report drops it.
      }
    }
    // An agent that went away is reported once without commands, so AgentKib drops its list.
    for (const [sessionId, known] of agentCommands)
      if (!live.has(sessionId) && known.entries !== null)
        agentCommands.set(sessionId, { entries: null, version: bump() });
  }
  ctx.on("commands/change", () => schedule());

  // ---- session list -----------------------------------------------------------------------

  async function readList() {
    const controller = service("sessionController");
    if (typeof controller?.list === "function") {
      try {
        const value = await controller.list({}, lifetime.signal);
        return (value?.items ?? []).map((item) => sessionSummary(item, archived)).filter(Boolean);
      } catch {
        // Fall back to the persistence corpus below.
      }
    }
    const query = service("sessionQuery");
    const records = (await query?.listSessions?.(lifetime.signal)) ?? [];
    return records
      .map((record) =>
        sessionSummary(
          {
            sessionId: record?.header?.id,
            cwd: record?.header?.cwd,
            updatedAt: record?.header?.createdAt,
            agentAvailable: record?.live === true,
            parentSessionId: record?.header?.parentSession,
            origin: record?.header?.origin,
          },
          archived,
        ),
      )
      .filter(Boolean);
  }
  /**
   * The session's chosen model, read as DSH's own model picker reads it: the next selection of
   * its `modelSelection` projection, which needs no running agent. The running agent's own
   * answer is only the fallback for a DSH without projection reads. Null means DSH's default.
   */
  async function chosenModel(controller, sessionId) {
    if (typeof controller.projections === "function") {
      try {
        const value = await controller.projections({ sessionId }, lifetime.signal);
        const selection = value?.values?.modelSelection;
        if (selection && typeof selection === "object")
          return selection.next ?? selection.lastUsed ?? null;
      } catch {
        // Read from the running agent below.
      }
    }
    try {
      return service("agents")?.get?.(sessionId)?.model?.current?.() ?? null;
    } catch {
      return null;
    }
  }
  function canSelectModelAtCreation(controller) {
    return (
      typeof controller?.create === "function" &&
      typeof controller?.modelCatalog === "function" &&
      typeof controller?.projections === "function" &&
      typeof service("agents")?.get === "function" &&
      typeof service("llm")?.resolveCallConfig === "function"
    );
  }
  async function recordedModel(controller, sessionId) {
    const value = await controller.projections({ sessionId }, lifetime.signal);
    const selection = value?.values?.modelSelection;
    if (!selection || typeof selection !== "object") throw new Error("dsh-models-unavailable");
    return selection.next ?? selection.lastUsed ?? null;
  }
  async function createSelection(controller, selection) {
    if (!canSelectModelAtCreation(controller))
      throw new Error("dsh-create-model-selection-unsupported");
    const catalog = modelsProjection(await controller.modelCatalog(), null);
    const model = catalog.models.find(
      (entry) => entry.provider === selection.provider && entry.model === selection.model,
    );
    if (!model) throw new Error("unsupported-model");
    if (
      selection.reasoningEffort !== undefined &&
      !model.efforts.some((effort) => effort.id === selection.reasoningEffort)
    )
      throw new Error("unsupported-effort");
    try {
      // Resolve adapter configuration before creating anything. This does not send a model request.
      await service("llm").resolveCallConfig(selection);
    } catch {
      throw new Error("dsh-models-unavailable");
    }
  }
  function setArchived(ids) {
    if (!Array.isArray(ids)) return;
    const next = new Set(ids.filter((id) => typeof id === "string"));
    if (next.size === archived.size && [...next].every((id) => archived.has(id))) return;
    archived = next;
    refreshList();
  }
  /** Keeps the archive set current, including archives made in DSH's own window. */
  async function followArchive() {
    const workspaces = service("workspaceController");
    if (followingArchive || typeof workspaces?.follow !== "function") return;
    followingArchive = true;
    try {
      for await (const frame of workspaces.follow(lifetime.signal)) {
        if (frame?.type === "baseline" || frame?.type === "replace")
          setArchived(frame.value?.archivedSessionIds);
        else if (frame?.type === "archived") setArchived(frame.archivedSessionIds);
      }
    } catch {
      // The stream ends with the service or this plugin; the next injection follows again.
    } finally {
      followingArchive = false;
    }
  }
  function refreshList() {
    if (listQueued || lifetime.signal.aborted) return;
    listQueued = true;
    const wait = Math.max(0, lastList + (options.listThrottleMs ?? LIST_THROTTLE_MS) - Date.now());
    setTimeout(async () => {
      listQueued = false;
      if (lifetime.signal.aborted) return;
      lastList = Date.now();
      listing = readList();
      try {
        const next = await listing;
        if (!listedOnce || JSON.stringify(next) !== JSON.stringify(summaries)) {
          listedOnce = true;
          summaries = next;
          listVersion = bump();
          schedule();
        }
      } catch {
        // Keep the previous list; the next change tries again.
      }
    }, wait).unref?.();
  }

  // ---- interactions -----------------------------------------------------------------------

  const openInteractions = () =>
    [...interactions.values()].map(({ settle: _settle, ...wire }) => wire);
  function settleInteraction(id) {
    if (!interactions.delete(id)) return;
    interactionsVersion = bump();
    schedule();
  }
  async function toolArguments(sessionId, callId) {
    if (!callId) return null;
    const query = service("sessionQuery");
    if (typeof query?.observeSession !== "function") return null;
    try {
      const observation = await query.observeSession(sessionId, { projectionMode: "none" });
      try {
        const events = observation.events;
        for (let index = events.length - 1; index >= 0 && index >= events.length - 400; index--) {
          const event = events[index];
          if (event?.type === "tool/call" && event.data?.callId === callId)
            return bounded(String(event.data.arguments ?? ""), MAX_PREVIEW).text;
        }
      } finally {
        observation[Symbol.dispose]?.();
      }
    } catch {
      // The card still shows the tool name and the reason.
    }
    return null;
  }

  /**
   * Show the request in AgentKib and in DSH's own UI at once; the first answer wins and the
   * other copy is withdrawn. DSH's `next()` takes no arguments, so the native copy is
   * dispatched again with a signal this plugin can abort.
   */
  const race = (event, fallback) =>
    function (request, next) {
      if (derived.has(request)) return next();
      const sessionId = String(request?.agent?.id ?? "");
      if (!sessionId || !watched(sessionId) || ![...hosts.values()].some((host) => host.token))
        return next();
      const scope = this;
      const id = randomUUID();
      const controller = new AbortController();
      const outer = request.signal;
      if (outer?.aborted) return next();
      const onOuterAbort = () => controller.abort(outer.reason);
      outer?.addEventListener("abort", onOuterAbort, { once: true });
      const copy = { ...request, signal: controller.signal };
      derived.add(copy);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (settle) => {
          if (settled) return false;
          settled = true;
          outer?.removeEventListener("abort", onOuterAbort);
          settleInteraction(id);
          settle();
          return true;
        };
        Promise.resolve()
          .then(() => ctx.waterfall(scope, event, copy, fallback))
          .then(
            (value) => finish(() => resolve(value)),
            (error) => finish(() => reject(error)),
          );
        const wire = {
          id,
          sessionId,
          kind: event === "approval/request" ? "approval" : "question",
          createdAt: Date.now(),
          ...(event === "approval/request"
            ? {
                toolName: bounded(String(request.toolName ?? ""), 256).text,
                callId: request.callId ? String(request.callId) : null,
                reason:
                  typeof request.reason === "string"
                    ? bounded(request.reason, MAX_PREVIEW).text
                    : null,
                displayReason:
                  request.displayReason && typeof request.displayReason === "object"
                    ? Object.fromEntries(
                        Object.entries(request.displayReason)
                          .filter(([, value]) => typeof value === "string")
                          .slice(0, 8)
                          .map(([locale, value]) => [locale, bounded(value, MAX_PREVIEW).text]),
                      )
                    : null,
                arguments: null,
              }
            : { questions: questionItems(request.questions) }),
          settle: (value) =>
            finish(() => {
              controller.abort(new Error("answered-in-agentkib"));
              resolve(value);
            }),
        };
        interactions.set(id, wire);
        interactionsVersion = bump();
        schedule();
        if (wire.kind === "approval" && wire.callId)
          void toolArguments(sessionId, wire.callId).then((value) => {
            if (value === null || !interactions.has(id)) return;
            wire.arguments = value;
            interactionsVersion = bump();
            schedule();
          });
      });
    };
  ctx.on(
    "approval/request",
    race("approval/request", () => Promise.resolve("unavailable")),
    { prepend: true },
  );
  ctx.on(
    "user-questions/request",
    race("user-questions/request", () =>
      Promise.reject(
        Object.assign(new Error("no user-questions answerer accepted the request"), {
          code: "NO_PROVIDER",
        }),
      ),
    ),
    { prepend: true },
  );

  function validAnswer(interaction, value) {
    if (interaction.kind === "approval") {
      if (!APPROVAL_OUTCOMES.has(value?.outcome)) throw new Error("invalid-answer");
      return value.outcome;
    }
    const questions = new Map(interaction.questions.map((question) => [question.id, question]));
    const answers = Array.isArray(value?.answers) ? value.answers : null;
    if (!answers || answers.length !== questions.size) throw new Error("invalid-answer");
    const seen = new Set();
    for (const answer of answers) {
      const question = questions.get(answer?.id);
      if (!question || seen.has(answer.id)) throw new Error("invalid-answer");
      seen.add(answer.id);
      const labels = new Set(question.options.map((option) => option.label));
      if (question.intent?.kind === "approval" && question.intent.always)
        labels.add(question.intent.always);
      const selected = Array.isArray(answer.selected) ? answer.selected : null;
      if (!selected || selected.some((label) => typeof label !== "string" || !labels.has(label)))
        throw new Error("invalid-answer");
      if (!question.multiSelect && selected.length > 1) throw new Error("invalid-answer");
      if (
        answer.custom !== undefined &&
        (typeof answer.custom !== "string" || answer.custom.length > 16_000)
      )
        throw new Error("invalid-answer");
      if (!selected.length && !answer.custom?.trim()) throw new Error("invalid-answer");
    }
    return {
      answers: answers.map((answer) => ({
        id: answer.id,
        selected: [...answer.selected],
        ...(answer.custom?.trim() ? { custom: answer.custom } : {}),
      })),
    };
  }

  // ---- commands ---------------------------------------------------------------------------

  async function history({ sessionId, before, limit }) {
    const query = service("sessionQuery");
    if (typeof query?.observeSession !== "function") throw new Error("history-unavailable");
    const observation = await query.observeSession(String(sessionId), { projectionMode: "none" });
    try {
      const events = observation.events;
      // A command's answer names only its run, so the runs to leave out are found first. One that
      // failed stays: the conversation is the only place its reason shows.
      const runs = new Set(
        events
          .filter(
            (event) =>
              event?.type === "command/run" && DSH_HIDDEN_COMMANDS.includes(event.data?.name),
          )
          .map((event) => String(event.data.commandId)),
      );
      const hidden = new Set(
        events
          .filter(
            (event) =>
              event?.type === "command/done" &&
              event.data?.kind === "success" &&
              runs.has(String(event.data.commandId)),
          )
          .map((event) => String(event.data.commandId)),
      );
      const recordOf = (event) =>
        (event?.type === "command/run" || event?.type === "command/done") &&
        hidden.has(String(event.data?.commandId))
          ? null
          : historyRecord(event);
      const records = [];
      let bytes = 0;
      let index = events.length - 1;
      if (Number.isSafeInteger(before)) while (index >= 0 && events[index].seq >= before) index--;
      const max = Math.min(Math.max(Number(limit) || 50, 1), 100);
      for (; index >= 0 && records.length < max; index--) {
        const record = recordOf(events[index]);
        if (!record) continue;
        bytes += JSON.stringify(record).length;
        if (records.length && bytes > HISTORY_PAGE_BYTES) break;
        records.push(record);
      }
      let older = false;
      for (let rest = index; rest >= 0; rest--)
        if (recordOf(events[rest])) {
          older = true;
          break;
        }
      records.reverse();
      return {
        sessionId: String(observation.header?.id ?? sessionId),
        cwd: observation.header?.cwd ?? null,
        createdAt: observation.header?.createdAt ?? null,
        cursor: observation.cursor,
        records,
        nextBefore: older && records.length ? records[0].seq : null,
      };
    } finally {
      observation[Symbol.dispose]?.();
    }
  }

  /**
   * One page of a session's conversation, oldest first, for a handoff or search. DSH's current
   * model surface says which records a compaction replaced and in what order the model sees the
   * rest. The first page fixes `revision`, the
   * last event the surface was read up to, and later pages stop there, so an event added while
   * AgentKib reads is left for the next read rather than counted as replaced.
   */
  async function conversation({ sessionId, after, through }) {
    const query = service("sessionQuery");
    if (typeof query?.observeSession !== "function" || typeof query?.readSurface !== "function")
      throw new Error("document-unavailable");
    const id = String(sessionId);
    const surface = await query.readSurface(id);
    // A compaction's summary takes the place of what it replaced, ahead of messages it left.
    const positions = new Map((surface?.events ?? []).map((event, index) => [event?.seq, index]));
    const captured = Number.isSafeInteger(surface?.capturedThroughSeq)
      ? surface.capturedThroughSeq
      : null;
    const until = Number.isSafeInteger(through)
      ? captured === null
        ? through
        : Math.min(through, captured)
      : captured;
    const observation = await query.observeSession(id, { projectionMode: "none" });
    try {
      const records = [];
      let bytes = 0;
      let nextAfter = null;
      for (const event of observation.events) {
        if (Number.isSafeInteger(after) && event.seq <= after) continue;
        if (until === null || event.seq > until) break;
        const record = documentRecord(event, positions.get(event.seq));
        if (!record) continue;
        const size = Buffer.byteLength(JSON.stringify(record));
        if (records.length && bytes + size > DOCUMENT_PAGE_BYTES) {
          nextAfter = records[records.length - 1].seq;
          break;
        }
        bytes += size;
        records.push(record);
      }
      return {
        sessionId: String(observation.header?.id ?? id),
        revision: until,
        records,
        nextAfter,
      };
    } finally {
      observation[Symbol.dispose]?.();
    }
  }
  // Prompts DSH is still taking (a cold session resumes first). Until one finishes, its message
  // may be missing from the record without having been lost.
  const promptsInFlight = new Set();
  // Slash commands this plugin ran, by AgentKib request: DSH records a command under an ID of its
  // own, so this is the only trace of the request. It is gone once DSH restarts.
  const commandRequests = new Map();
  /** The session's agent; DSH resumes one that is not running, as its own window does. */
  async function agentFor(sessionId) {
    const controller = service("sessionController");
    if (typeof controller?.resolveAgent !== "function")
      throw new Error("session-controller-unavailable");
    const found = await controller.resolveAgent(sessionId);
    if (found?.error) throw found.error;
    if (!found?.agent) throw new Error("session-unavailable");
    return found.agent;
  }
  async function projections(sessionId) {
    const controller = service("sessionController");
    if (typeof controller?.projections !== "function") throw new Error("projections-unavailable");
    const value = await controller.projections({ sessionId }, lifetime.signal);
    return value?.values ?? {};
  }
  // How a subagent that is not running ended. Reading it can mean reading the child's whole log,
  // and AgentKib asks every few seconds, so it is read again only once the child has changed.
  const endings = new Map();
  async function settledStatus(sessionId, updatedAt) {
    const known = endings.get(sessionId);
    if (known && known.updatedAt === updatedAt) return known.status;
    let status = "unknown";
    try {
      const timing = (await projections(sessionId)).subagentTiming;
      status = timing?.active
        ? "running"
        : timing?.lastTurnCompleted === true
          ? "completed"
          : timing?.lastTurnCompleted === false
            ? "stopped"
            : "unknown";
    } catch {
      return "unknown";
    }
    if (status !== "running") {
      endings.set(sessionId, { updatedAt, status });
      if (endings.size > 512) endings.delete(endings.keys().next().value);
    }
    return status;
  }
  /** Runs one command line in DSH's command registry, as DSH's own window does. */
  async function runCommand(agent, requestId, line) {
    const commands = service("commands");
    const record = { done: false };
    commandRequests.set(requestId, record);
    if (commandRequests.size > 256) commandRequests.delete(commandRequests.keys().next().value);
    // The command outlives this request, as it does when DSH's own window runs it.
    const execution = Promise.resolve()
      .then(() => commands.execute(agent, line, [], lifetime.signal))
      .finally(() => {
        record.done = true;
      });
    const settled = await Promise.race([
      execution.then((value) => ({ value })),
      sleep(options.commandWaitMs ?? COMMAND_WAIT_MS, lifetime.signal).then(() => null),
    ]);
    if (!settled) {
      execution.catch(() => undefined);
      return { matched: true, running: true };
    }
    if (!settled.value) {
      commandRequests.delete(requestId);
      return { matched: false };
    }
    const result = settled.value.result;
    return {
      matched: true,
      running: false,
      ok: result?.kind === "success",
      text: typeof result?.text === "string" ? bounded(result.text, MAX_PREVIEW).text : null,
    };
  }
  /**
   * A message naming one of the session's commands runs as that command, as in DSH's own window:
   * DSH's registry for the session's agent decides, also for a session DSH resumes for it. Null
   * for any other message. AgentKib says whether the device has full access.
   */
  async function slashCommand(command) {
    const parts = Array.isArray(command.content) ? command.content : [];
    const line = parts[0]?.type === "text" ? parts[0].text : "";
    const name = DSH_COMMAND_LINE.exec(line)?.[1];
    const commands = service("commands");
    if (!name || typeof commands?.find !== "function") return null;
    const agent = await agentFor(String(command.sessionId));
    if (!commands.find(agent, name)) return null;
    const refusal = dshCommandRefusal(name, {
      fullAccess: command.fullAccess === true,
      attachments: parts.length > 1,
    });
    if (refusal) throw new Error(refusal);
    return { command: name, ...(await runCommand(agent, String(command.requestId), line)) };
  }
  async function present({ sessionId, requestId }) {
    const command = commandRequests.get(String(requestId));
    if (command) return { present: true, live: true, inFlight: !command.done };
    const inFlight = promptsInFlight.has(String(requestId));
    const agent = service("agents")?.get?.(String(sessionId));
    const matches = (message) => isHumanMessage(message) && message.source?.rpcId === requestId;
    if (agent && [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])].some(matches))
      return { present: true, live: true, inFlight };
    const query = service("sessionQuery");
    const observation = await query.observeSession(String(sessionId), { projectionMode: "none" });
    try {
      return {
        present: observation.events.some(
          (event) => event?.type === "user/message" && matches(event.data),
        ),
        live: !!agent,
        inFlight,
      };
    } finally {
      observation[Symbol.dispose]?.();
    }
  }
  async function run(host, command) {
    const controller = service("sessionController");
    const needController = () => {
      if (!controller) throw new Error("session-controller-unavailable");
      return controller;
    };
    switch (command?.type) {
      case "history":
        return history(command);
      case "document":
        return conversation(command);
      case "presets": {
        const registry = service("agentPresets");
        if (typeof registry?.remoteExportList !== "function")
          throw new Error("agent-presets-unavailable");
        const roster = await registry.remoteExportList();
        return {
          presets: (Array.isArray(roster?.presets) ? roster.presets : [])
            .slice(0, MAX_PRESETS)
            .map(presetEntry)
            .filter(Boolean),
        };
      }
      case "verify":
        return present(command);
      case "prompt": {
        const requestId = String(command.requestId);
        const controller = needController();
        const slash = await slashCommand(command);
        if (slash) return slash;
        // Read before DSH is asked: an attachment that changed fails the prompt here.
        const content = await promptContent(command.content);
        promptsInFlight.add(requestId);
        try {
          return await controller.prompt(
            {
              requestId,
              sessionId: String(command.sessionId),
              mode: command.mode === "steer" ? "steer" : "queue",
              content,
            },
            lifetime.signal,
          );
        } catch (error) {
          throw attachmentRefusal(error);
        } finally {
          promptsInFlight.delete(requestId);
        }
      }
      case "image": {
        const controller = needController();
        if (typeof controller.attachment !== "function") throw new Error("images-unavailable");
        // DSH returns only images the session's own log refers to.
        const value = await controller.attachment({
          sessionId: String(command.sessionId),
          attachmentId: String(command.attachmentId),
        });
        if (typeof value?.data !== "string" || value.data.length > MAX_IMAGE_READ_CHARS)
          throw new Error("image-too-large");
        return { mediaType: value.attachment?.mediaType ?? null, data: value.data };
      }
      case "queue":
        return needController().updateQueue({
          sessionId: String(command.sessionId),
          itemId: String(command.itemId),
          action:
            command.action?.kind === "edit"
              ? { kind: "edit", content: [{ type: "text", text: String(command.action.text) }] }
              : command.action?.kind === "steer"
                ? { kind: "steer" }
                : { kind: "remove" },
        });
      case "cancel":
        return needController().cancel({ sessionId: String(command.sessionId) });
      case "rename": {
        const value = await needController().rename({
          sessionId: String(command.sessionId),
          title: String(command.title),
        });
        refreshList();
        return { title: value?.title ?? null };
      }
      case "fork": {
        const value = await needController().fork({ sessionId: String(command.sessionId) });
        refreshList();
        return { sessionId: value?.sessionId ?? null };
      }
      case "create": {
        const controller = needController();
        const selection = command.modelSelection;
        if (selection) await createSelection(controller, selection);
        // DSH creates the session under the ID AgentKib reserved for it.
        const value = await controller.create({
          cwd: String(command.cwd),
          sessionId: String(command.sessionId),
          ...(command.agentPreset ? { agentPreset: String(command.agentPreset) } : {}),
        });
        if (selection)
          try {
            const sessionId = value?.sessionId;
            if (sessionId !== command.sessionId) throw new Error("dsh-create-session-id-changed");
            // The native controller's selectModel also saves the global default. The Agent's
            // model interface records the same selection locally for this just-created session.
            service("agents").get(sessionId).model.select(selection);
            const selected = await recordedModel(controller, sessionId);
            if (
              selected?.provider !== selection.provider ||
              selected.model !== selection.model ||
              (selected.reasoningEffort ?? null) !== (selection.reasoningEffort ?? null)
            )
              throw new Error("dsh-create-model-not-applied");
            return {
              sessionId,
              selected: { ...selection, reasoningEffort: selection.reasoningEffort ?? null },
            };
          } catch {
            // The native blank session may already exist. The host reconciles it before sending.
            throw new Error("dsh-create-model-not-applied");
          } finally {
            refreshList();
          }
        refreshList();
        return { sessionId: value?.sessionId ?? null };
      }
      case "archive": {
        const workspaces = service("workspaceController");
        if (typeof workspaces?.archiveSession !== "function")
          throw new Error("workspace-controller-unavailable");
        const sessionId = String(command.sessionId);
        // Never stops a running turn: DSH refuses to archive an active session instead.
        const value = command.archived
          ? await workspaces.archiveSession({ sessionId })
          : await workspaces.unarchiveSession({ sessionId });
        setArchived(value?.archivedSessionIds);
        return { archived: archived.has(sessionId) };
      }
      case "models": {
        const controller = needController();
        if (command.recordedOnly && typeof command.sessionId === "string")
          return modelsProjection(undefined, await recordedModel(controller, command.sessionId));
        if (typeof controller.modelCatalog !== "function")
          throw new Error("model-catalog-unavailable");
        const catalog = await controller.modelCatalog();
        const sessionId = command.sessionId;
        const selected =
          typeof sessionId === "string" ? await chosenModel(controller, sessionId) : null;
        return modelsProjection(catalog, selected);
      }
      case "selectModel": {
        const value = await needController().selectModel({
          sessionId: String(command.sessionId),
          provider: String(command.provider),
          model: String(command.model),
          ...(command.reasoningEffort ? { reasoningEffort: String(command.reasoningEffort) } : {}),
        });
        return { selected: value?.selected ?? null };
      }
      case "goal": {
        const sessionId = String(command.sessionId);
        const goals = service("goals");
        const agent = service("agents")?.get?.(sessionId);
        // A running session answers with whether this DSH continues the goal by itself; one that
        // is not running is read without resuming it, and DSH would resume it disarmed.
        if (agent && typeof goals?.get === "function")
          return { goal: goalView(goals.get(agent)), live: true };
        return { goal: goalFromProjection((await projections(sessionId)).goal), live: false };
      }
      case "goal-control": {
        const goals = service("goals");
        if (typeof goals?.get !== "function") throw new Error("goals-unavailable");
        const agent = await agentFor(String(command.sessionId));
        const current = goalView(goals.get(agent));
        // The goal AgentKib showed; DSH refuses the change once its own revision moved on.
        const ref =
          typeof command.goalId === "string" && Number.isSafeInteger(command.goalRevision)
            ? { id: command.goalId, revision: command.goalRevision }
            : current && { id: current.id, revision: current.revision };
        const objective = typeof command.objective === "string" ? command.objective : "";
        if (command.action !== "set" && !ref) throw new Error("GOAL_NOT_FOUND");
        switch (command.action) {
          case "set":
            // As DSH's own `/goal edit` does: a finished goal is replaced, any other one edited.
            if (!current || current.phase === "complete") goals.create(agent, { objective });
            else goals.edit(agent, ref, { objective });
            break;
          case "pause":
            goals.pause(agent, ref);
            break;
          case "resume":
            goals.resume(agent, ref);
            break;
          case "clear":
            goals.clear(agent, ref);
            break;
          default:
            throw new Error("invalid-goal-action");
        }
        return { goal: goalView(goals.get(agent)) };
      }
      case "command":
        if (typeof service("commands")?.execute !== "function")
          throw new Error("commands-unavailable");
        return runCommand(
          await agentFor(String(command.sessionId)),
          String(command.requestId),
          String(command.line),
        );
      case "permissions": {
        const presets = service("permissionPresets");
        if (typeof presets?.catalog !== "function") throw new Error("permissions-unavailable");
        const values = await projections(String(command.sessionId));
        const current = values.permissions?.currentValue;
        // DSH's plan mode, which its composer shows beside the preset.
        const plan = values.plan;
        return {
          options: permissionOptions(presets.catalog()),
          current: typeof current === "string" ? current : null,
          plan:
            typeof plan?.active === "boolean" && typeof plan?.pending === "boolean"
              ? { active: plan.active, pending: plan.pending }
              : null,
        };
      }
      case "subagents": {
        const catalog = (await projections(String(command.sessionId))).subagentCatalog;
        const entries = (Array.isArray(catalog) ? catalog : [])
          .slice(-MAX_SUBAGENTS)
          .map(subagentEntry)
          .filter(Boolean);
        const rows = new Map(summaries.map((row) => [row.sessionId, row]));
        return {
          agents: await Promise.all(
            entries.map(async (entry) => {
              const row = rows.get(entry.sessionId);
              if (row?.running || states.get(entry.sessionId)?.status === "running")
                return { ...entry, status: "running" };
              return { ...entry, status: await settledStatus(entry.sessionId, row?.updatedAt) };
            }),
          ),
          truncated: Array.isArray(catalog) && catalog.length > MAX_SUBAGENTS,
        };
      }
      case "answer": {
        const interaction = interactions.get(String(command.interactionId));
        if (!interaction) return { found: false };
        const value = validAnswer(interaction, command.value);
        return { found: true, settled: interaction.settle(value) };
      }
      case "refresh":
        host.acked = 0;
        refreshList();
        schedule();
        return { refreshed: true };
      default:
        throw new Error("unknown-command");
    }
  }

  // ---- hosts ------------------------------------------------------------------------------

  const services = () => {
    const controller = service("sessionController");
    // Goals and commands act on the session's agent, which this resolves (resuming it).
    const resolves = typeof controller?.resolveAgent === "function";
    const projects = typeof controller?.projections === "function";
    const query = service("sessionQuery");
    return {
      sessionController: typeof controller?.prompt === "function",
      sessionQuery: typeof query?.observeSession === "function",
      approvals: true,
      questions: typeof service("userQuestions")?.ask === "function",
      workspaceController: typeof service("workspaceController")?.archiveSession === "function",
      modelCatalog: typeof controller?.modelCatalog === "function",
      createModelSelection: canSelectModelAtCreation(controller),
      images: typeof controller?.attachment === "function",
      goals: resolves && projects && typeof service("goals")?.get === "function",
      commands: resolves && typeof service("commands")?.execute === "function",
      permissions: projects && typeof service("permissionPresets")?.catalog === "function",
      subagents: projects,
      documents:
        typeof query?.observeSession === "function" && typeof query?.readSurface === "function",
      agentPresets: typeof service("agentPresets")?.remoteExportList === "function",
    };
  };
  function report(host) {
    refreshCommands();
    const since = host.acked;
    const at = version;
    // Services can finish starting after registration, so every report restates them.
    const body = { token: host.token, services: services() };
    if (listVersion > since) body.sessions = summaries;
    if (commandsVersion > since) body.commands = commandCatalog;
    const sessionCommands = [...agentCommands]
      .filter(([, known]) => known.version > since)
      .map(([sessionId, known]) => ({ sessionId, commands: known.entries }));
    if (sessionCommands.length) body.sessionCommands = sessionCommands;
    const changed = [...states.values()].filter((state) => state.version > since);
    if (changed.length)
      body.states = changed.map(({ version: _version, ...state }) => ({
        ...state,
        pending: [...interactions.values()].filter((item) => item.sessionId === state.sessionId)
          .length,
      }));
    if (interactionsVersion > since) body.interactions = openInteractions();
    const changedSince = (versions) =>
      [...versions].filter(([, value]) => value > since).map(([id]) => id);
    const historyChanged = changedSince(historyVersions);
    if (historyChanged.length) body.historyChanged = historyChanged;
    const goalChanged = changedSince(goalVersions);
    if (goalChanged.length) body.goalChanged = goalChanged;
    const settingsChanged = changedSince(settingsVersions);
    if (settingsChanged.length) body.settingsChanged = settingsChanged;
    return { body, at };
  }
  async function send(host) {
    if (!host.token || host.sending) {
      host.again = true;
      return;
    }
    host.sending = true;
    try {
      do {
        host.again = false;
        const { body, at } = report(host);
        const reply = await post(host.socketPath, DSH_BRIDGE_PATHS.report, body, {
          signal: lifetime.signal,
        });
        host.acked = at;
        host.lastReport = Date.now();
        lastContact = host.lastReport;
        if (Array.isArray(reply?.watch)) host.watch = new Set(reply.watch.map(String));
      } while (host.again && host.token && !lifetime.signal.aborted);
    } catch (error) {
      if (error instanceof BridgeHttpError && error.status === 401) host.token = null;
    } finally {
      host.sending = false;
    }
  }
  let scheduled = null;
  function schedule() {
    if (scheduled || lifetime.signal.aborted) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      for (const host of hosts.values()) void send(host);
    }, options.debounceMs ?? 120);
    scheduled.unref?.();
  }
  async function register(host) {
    const reply = await post(
      host.socketPath,
      DSH_BRIDGE_PATHS.register,
      {
        key: host.key,
        protocol: DSH_BRIDGE_COMPATIBILITY.protocol,
        pluginVersion: DSH_BRIDGE_COMPATIBILITY.pluginVersion,
        dshVersion,
        runtimeId,
        pid: options.pid ?? process.pid,
        services: services(),
      },
      { signal: lifetime.signal },
    );
    host.token = String(reply.token);
    host.acked = 0;
    host.error = null;
    lastContact = Date.now();
  }
  async function hostLoop(host) {
    let backoff = 500;
    while (!lifetime.signal.aborted && !host.closed) {
      try {
        if (!host.token) {
          await register(host);
          backoff = 500;
          void send(host);
        }
        const reply = await post(
          host.socketPath,
          DSH_BRIDGE_PATHS.poll,
          { token: host.token },
          { timeoutMs: 35_000, signal: lifetime.signal },
        );
        host.failures = 0;
        lastContact = Date.now();
        if (Date.now() - host.lastReport > HEARTBEAT_MS) void send(host);
        for (const command of Array.isArray(reply?.commands) ? reply.commands : [])
          void (async () => {
            let result;
            try {
              result = {
                commandId: command.commandId,
                ok: true,
                value: (await run(host, command)) ?? null,
              };
            } catch (error) {
              result = {
                commandId: command.commandId,
                ok: false,
                error: String(error?.code ?? error?.message ?? error).slice(0, 256),
              };
            }
            try {
              await post(
                host.socketPath,
                DSH_BRIDGE_PATHS.result,
                { token: host.token, ...result },
                { signal: lifetime.signal },
              );
            } catch {
              // AgentKib treats an unreported result as unknown and reconciles it.
            }
          })();
      } catch (error) {
        if (lifetime.signal.aborted) return;
        if (error instanceof BridgeHttpError && error.status === 401) host.token = null;
        else if (error instanceof BridgeHttpError && error.status === 409) {
          // Incompatible plugin or DSH version: stay quiet until AgentKib changes.
          host.error = error.code;
          host.token = null;
          await sleep(60_000, lifetime.signal);
          continue;
        } else {
          host.token = null;
          host.failures = (host.failures ?? 0) + 1;
          if (host.failures > 6) {
            host.closed = true;
            hosts.delete(host.socketPath);
            return;
          }
        }
        await sleep(backoff, lifetime.signal);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }
  async function scan() {
    while (!lifetime.signal.aborted) {
      try {
        for (const found of await discover(roots)) {
          const existing = hosts.get(found.socketPath);
          if (existing && existing.key === found.key) continue;
          if (existing) existing.closed = true;
          const host = {
            ...found,
            token: null,
            acked: 0,
            lastReport: 0,
            watch: new Set(),
            closed: false,
          };
          hosts.set(found.socketPath, host);
          void hostLoop(host);
        }
      } catch {
        // Discovery is retried on the next interval.
      }
      await sleep(options.discoveryMs ?? DISCOVERY_MS, lifetime.signal);
    }
  }

  for (const agent of service("agents")?.list?.() ?? []) attach(agent);
  refreshList();
  refreshCommands();
  // The web application's session service can start after this plugin; list again with titles.
  ctx.inject?.(["sessionController"], () => {
    refreshList();
    schedule();
  });
  // So can the command registry, and the services behind goals and permission and Agent presets.
  ctx.inject?.(["commands"], () => schedule());
  for (const name of ["goals", "permissionPresets", "agentPresets"])
    ctx.inject?.([name], () => schedule());
  // The archive set lives in the workspace controller, which can also start after this plugin.
  ctx.inject?.(["workspaceController"], () => {
    void followArchive();
    schedule();
  });
  void followArchive();
  void scan();
  const heartbeat = setInterval(() => {
    for (const host of hosts.values())
      if (host.token && Date.now() - host.lastReport >= (options.heartbeatMs ?? HEARTBEAT_MS))
        void send(host);
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref?.();

  // A DSH that AgentKib started goes with that AgentKib. AgentKib stops it itself when it quits;
  // if AgentKib crashes, DSH's standard input closes and the contact ends, and DSH exits the way
  // its own launcher does, so a running turn is recorded as interrupted.
  let exiting = false;
  const exit = () => {
    if (exiting || lifetime.signal.aborted) return;
    exiting = true;
    const appExit = service("appExit");
    if (typeof appExit === "function") appExit(0);
    else process.kill(process.pid, "SIGTERM");
  };
  const hostGoneMs = options.hostGoneMs ?? HOST_GONE_MS;
  const stdin = managed ? (options.stdin ?? process.stdin) : null;
  let hostWatch = null;
  if (managed) {
    hostWatch = setInterval(
      () => {
        if (Date.now() - lastContact > hostGoneMs) exit();
      },
      Math.min(hostGoneMs, 5_000),
    );
    hostWatch.unref?.();
    stdin.on("end", exit);
    stdin.on("error", () => undefined);
    stdin.resume?.();
  }

  return {
    runtimeId,
    dshVersion,
    managed: managed !== null,
    hosts,
    states,
    interactions,
    summaries: () => summaries,
    run: (command) => run({ acked: 0 }, command),
    close() {
      lifetime.abort();
      clearInterval(heartbeat);
      if (hostWatch) clearInterval(hostWatch);
      stdin?.off?.("end", exit);
      if (scheduled) clearTimeout(scheduled);
      for (const host of hosts.values()) host.closed = true;
    },
  };
}
