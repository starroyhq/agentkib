// The AgentKib side of a running DeepSeek Harness process. It reports sessions, live state and
// pending interactions to every AgentKib Runtime it can discover, and runs their commands
// through DSH's own session services. It never rewrites the log or starts another executor.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DSH_BRIDGE_COMPATIBILITY } from "./compatibility.js";
import { BridgeHttpError, discover, discoveryRoots, post } from "./client.js";
import {
  MAX_PREVIEW,
  MAX_STREAM,
  bounded,
  historyRecord,
  isHumanMessage,
  modelsProjection,
  queueItems,
  questionItems,
  sessionSummary,
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
const LIST_THROTTLE_MS = 1_000;
const HISTORY_PAGE_BYTES = 1536 * 1024;
const APPROVAL_OUTCOMES = new Set(["allowed-once", "rejected"]);

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
 * @param ctx - the plugin's Cordis context.
 * @param options - test seams: discovery roots, a fixed version and timers.
 */
export function createBridge(ctx, options = {}) {
  const runtimeId = randomUUID();
  const dshVersion = options.dshVersion ?? readDshVersion();
  const roots = options.roots ?? discoveryRoots();
  const lifetime = new AbortController();
  const hosts = new Map();
  /** Monotonic change counter; every report sends what changed after the host's last ack. */
  let version = 0;
  let listVersion = 0;
  let interactionsVersion = 0;
  let summaries = [];
  let listing = null;
  let listQueued = false;
  let lastList = 0;
  const states = new Map();
  const historyVersions = new Map();
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
  const attach = (agent) => {
    const state = stateOf(String(agent.id));
    state.live = true;
    state.status = agent.status === "running" ? "running" : "idle";
    state.cursor = typeof agent.session?.seq === "number" ? agent.session.seq - 1 : state.cursor;
    state.queue = queueItems(agent);
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
    if (event?.type === "session/title" || event?.type === "turn/end") refreshList();
  });
  ctx.on("session/created", () => refreshList());
  ctx.on("session/disposed", () => refreshList());

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
        if (JSON.stringify(next) !== JSON.stringify(summaries)) {
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
      const records = [];
      let bytes = 0;
      let index = events.length - 1;
      if (Number.isSafeInteger(before)) while (index >= 0 && events[index].seq >= before) index--;
      const max = Math.min(Math.max(Number(limit) || 50, 1), 100);
      for (; index >= 0 && records.length < max; index--) {
        const record = historyRecord(events[index]);
        if (!record) continue;
        bytes += JSON.stringify(record).length;
        if (records.length && bytes > HISTORY_PAGE_BYTES) break;
        records.push(record);
      }
      let older = false;
      for (let rest = index; rest >= 0; rest--)
        if (historyRecord(events[rest])) {
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
  // Prompts DSH is still taking (a cold session resumes first). Until one finishes, its message
  // may be missing from the record without having been lost.
  const promptsInFlight = new Set();
  async function present({ sessionId, requestId }) {
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
      case "verify":
        return present(command);
      case "prompt": {
        const requestId = String(command.requestId);
        promptsInFlight.add(requestId);
        try {
          return await needController().prompt(
            {
              requestId,
              sessionId: String(command.sessionId),
              mode: command.mode === "steer" ? "steer" : "queue",
              content: [{ type: "text", text: String(command.text) }],
            },
            lifetime.signal,
          );
        } finally {
          promptsInFlight.delete(requestId);
        }
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
        // DSH creates the session under the ID AgentKib reserved for it.
        const value = await needController().create({
          cwd: String(command.cwd),
          sessionId: String(command.sessionId),
        });
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
        if (typeof controller.modelCatalog !== "function")
          throw new Error("model-catalog-unavailable");
        const catalog = await controller.modelCatalog();
        return modelsProjection(catalog, await chosenModel(controller, String(command.sessionId)));
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

  const services = () => ({
    sessionController: typeof service("sessionController")?.prompt === "function",
    sessionQuery: typeof service("sessionQuery")?.observeSession === "function",
    approvals: true,
    questions: typeof service("userQuestions")?.ask === "function",
    workspaceController: typeof service("workspaceController")?.archiveSession === "function",
    modelCatalog: typeof service("sessionController")?.modelCatalog === "function",
  });
  function report(host) {
    const since = host.acked;
    const at = version;
    // Services can finish starting after registration, so every report restates them.
    const body = { token: host.token, services: services() };
    if (listVersion > since) body.sessions = summaries;
    const changed = [...states.values()].filter((state) => state.version > since);
    if (changed.length)
      body.states = changed.map(({ version: _version, ...state }) => ({
        ...state,
        pending: [...interactions.values()].filter((item) => item.sessionId === state.sessionId)
          .length,
      }));
    if (interactionsVersion > since) body.interactions = openInteractions();
    const historyChanged = [...historyVersions]
      .filter(([, value]) => value > since)
      .map(([id]) => id);
    if (historyChanged.length) body.historyChanged = historyChanged;
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
        pid: process.pid,
        services: services(),
      },
      { signal: lifetime.signal },
    );
    host.token = String(reply.token);
    host.acked = 0;
    host.error = null;
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
  // The web application's session service can start after this plugin; list again with titles.
  ctx.inject?.(["sessionController"], () => {
    refreshList();
    schedule();
  });
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

  return {
    runtimeId,
    dshVersion,
    hosts,
    states,
    interactions,
    summaries: () => summaries,
    run: (command) => run({ acked: 0 }, command),
    close() {
      lifetime.abort();
      clearInterval(heartbeat);
      if (scheduled) clearTimeout(scheduled);
      for (const host of hosts.values()) host.closed = true;
    },
  };
}
