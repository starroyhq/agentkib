// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DSH_BRIDGE_PLUGIN_VERSION,
  DSH_BRIDGE_PROTOCOL,
  RUNTIME_METHODS,
  SESSION_EVENT_NOTIFICATION,
  sessionProviderCapabilities,
  type DshBridgeHistoryRecord,
  type SessionSubscription,
  type DshBridgeSessionState,
  type SubagentCatalog,
} from "@agentkib/runtime-protocol";
import {
  DshBridge,
  dshConversationEvents,
  type DshBridgeOptions,
} from "../../../packages/backend/src/agents/dsh/dsh-bridge";
import {
  createDshWorker,
  DshLaneWatch,
  type DshLaneBridge,
} from "../../../packages/backend/src/agents/dsh/dsh-lanes";
import { readControlReceipt } from "../../../packages/backend/src/control-receipt";
import type { ContextUsage } from "../../../packages/backend/src/context-usage";
import { TypeScriptBackend } from "../../../packages/backend/src/index";
import { withSessionActivities } from "../../../packages/backend/src/session-activities";
import { SessionApprovalAuditStore } from "../../../packages/backend/src/sessions/approval-audit";
import {
  approvalAuditEvidence,
  recordApprovalDecision,
} from "../../../packages/backend/src/sessions/approval-audit-decisions";
import { McpHub } from "../../../packages/backend/src/mcp-hub";
import { RemoteAgent } from "../../../packages/backend/src/remote-agent";
import { BackendStore } from "../../../packages/backend/src/store";
import { validateDeepSeekHarnessControl } from "../../../packages/backend/src/sessions/validate/deepseek-harness";
import {
  createBridge,
  DSH_BRIDGE_PATHS,
  managedHost,
} from "../../../packages/dsh-bridge-plugin/bridge.js";
import { post } from "../../../packages/dsh-bridge-plugin/client.js";
import * as dshClient from "../../../packages/dsh-bridge-plugin/client.js";
import { projectAgentFixture } from "./fixtures/project-agent";
import {
  dshBridgeCompatibility,
  dshBridgePluginCompatibility,
} from "../../../packages/dsh-bridge-plugin/compatibility.js";
import {
  commandEntries,
  goalFromProjection,
  goalView,
  historyRecord,
  permissionOptions,
  queueItems,
  subagentEntry,
} from "../../../packages/dsh-bridge-plugin/projection.js";

type Listener = { callback: (...args: any[]) => any; prepend: boolean };
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=",
  "base64",
);

/** Just enough of a DSH process: Cordis events and waterfalls, agents, queries and the session service. */
function fakeDsh(cwd: string, attachmentByReference = false) {
  const hooks = new Map<string, Listener[]>();
  const sessions = new Map<
    string,
    {
      events: any[];
      agent: any;
      title: string | null;
      updatedAt: number;
      selection?: unknown;
      parentSessionId?: string;
    }
  >();
  // Goals as DSH's goal service keeps them: every change names the goal's current revision.
  const goals = new Map<string, any>();
  const goalError = (code: string) => Object.assign(new Error(code), { code });
  const presets = ["read-only", "workspace-write", "danger-full-access"];
  const permissionOf = new Map<string, string>();
  // DSH's `plan` projection view: a `/plan` switch stays pending until the next step.
  const planOf = new Map<string, { active: boolean; pending: boolean }>();
  // Direct children by parent, and how each child's last turn ended.
  const children = new Map<
    string,
    { id: string; createdAt: number; mode: string; label?: string }[]
  >();
  const endings = new Map<string, boolean>();
  let compactionHold: Promise<void> | null = null;
  let commandCount = 0;
  const executed: string[] = [];
  const prompts: any[] = [];
  const creations: any[] = [];
  // A session's current model surface, by event seq, after a compaction replaced part of it.
  const surfaces = new Map<string, number[]>();
  const queueUpdates: any[] = [];
  const cancels: string[] = [];
  const selections: any[] = [];
  let defaultModel = { provider: "deepseek", model: "deepseek-chat" };
  // DSH keeps each image in its own store, named after the digest of its bytes.
  const images = new Map<string, { ref: any; data: string }>();
  let imagesRefused = false;
  const attachmentInvalid = (reason: string) =>
    Object.assign(new Error(reason), { code: "session/attachment-invalid", details: { reason } });
  const archived = new Set<string>();
  const pinned = new Set<string>();
  // Each agent's own tools (`agent.ctx.tools`), as DSH scopes them to one agent.
  const agentTools = new Map<any, any[]>();
  const followers = new Set<(frame: unknown) => void>();
  const pushWorkspace = (frame: unknown) => {
    for (const push of followers) push(frame);
  };
  const pushArchived = () => {
    pushWorkspace({ type: "archived", archivedSessionIds: [...archived] });
  };
  const pinInDsh = (sessionId: string, pin: boolean) => {
    if (pin) pinned.add(sessionId);
    else pinned.delete(sessionId);
    pushWorkspace({ type: "pinned", pinnedSessionIds: [...pinned] });
  };
  const disposers: Array<() => void> = [];
  const nativeAnswers: Array<{
    request: any;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];
  const emit = (name: string, ...args: any[]) => {
    for (const hook of hooks.get(name) ?? []) hook.callback(...args);
  };
  const append = (id: string, type: string, data: unknown) => {
    const session = sessions.get(id)!;
    const event = { seq: session.events.length, time: Date.now(), type, data };
    session.events.push(event);
    session.agent.session.seq = session.events.length;
    session.updatedAt = Date.now();
    emit("session/event", { id }, event);
    return event;
  };
  const ctx: any = {
    on(name: string, callback: (...args: any[]) => any, options?: { prepend?: boolean }) {
      const list = hooks.get(name) ?? [];
      const hook = { callback, prepend: options?.prepend === true };
      if (hook.prepend) list.unshift(hook);
      else list.push(hook);
      hooks.set(name, list);
      return () =>
        hooks.set(
          name,
          (hooks.get(name) ?? []).filter((item) => item !== hook),
        );
    },
    waterfall(thisArg: unknown, name: string, ...rest: any[]) {
      const inner = rest.pop();
      const callbacks = [...(hooks.get(name) ?? [])].map((hook) => hook.callback);
      const dispatch = (): any => {
        const callback = callbacks.shift();
        if (!callback) return inner();
        return callback.call(thisArg, ...rest, dispatch);
      };
      return dispatch();
    },
    effect(callback: () => () => void) {
      disposers.push(callback());
    },
    inject(_deps: string[], callback: () => void) {
      callback();
    },
    get(name: string) {
      return ctx[name];
    },
    agents: {
      get: (id: string) => sessions.get(id)?.agent,
      list: () => [...sessions.values()].map((session) => session.agent),
      turnBoundaryOf: (native: { id: string }) => {
        const event = sessions
          .get(native.id)
          ?.events.slice()
          .reverse()
          .find((entry) => entry.type === "turn/start" || entry.type === "turn/end");
        return {
          openTurnStartSeq: event?.type === "turn/start" ? event.seq : null,
          lastTurn: event?.data.turn ?? 0,
        };
      },
    },
    // DSH's tool registry; a plugin reaches one agent's own through `agent.ctx.tools`.
    tools: { register: () => () => undefined },
    llm: { resolveCallConfig: vi.fn(async () => ({})) },
    userQuestions: { ask: () => undefined },
    approval: { request: () => undefined },
    sessionQuery: {
      async observeSession(id: string) {
        const session = sessions.get(id);
        if (!session) throw new Error("not found");
        return {
          header: { id, cwd, createdAt: 1 },
          events: [...session.events],
          cursor: session.events.length - 1,
          [Symbol.dispose]() {},
        };
      },
      async listSessions() {
        return [...sessions.keys()].map((id) => ({
          header: { id, cwd, createdAt: 1 },
          live: true,
        }));
      },
      async readSurface(id: string) {
        const session = sessions.get(id);
        if (!session) throw new Error("not found");
        const surface = surfaces.get(id);
        return {
          session: { id, cwd, createdAt: 1 },
          inheritedEventCount: 0,
          capturedThroughSeq: session.events.at(-1)?.seq ?? null,
          events: surface
            ? surface.map((seq) => session.events[seq]).filter(Boolean)
            : [...session.events],
        };
      },
    },
    // DSH's Agent preset registry: shipped presets have no name of their own.
    agentPresets: {
      async remoteExportList() {
        return {
          presets: [
            { id: "standard", isDefault: true },
            { id: "ptc", isDefault: false },
            { id: "mine", name: "My preset", description: "Written by the user", isDefault: false },
            { id: "broken", isDefault: false, broken: "plugin missing" },
          ],
        };
      },
    },
    sessionController: {
      async list() {
        return {
          items: [...sessions.entries()].map(([sessionId, session]) => ({
            sessionId,
            cwd,
            updatedAt: session.updatedAt,
            running: session.agent.status === "running",
            agentAvailable: true,
            blank: false,
            projections: { kind: "sequenced", asOfSeq: 0, values: { title: session.title } },
            ...(session.parentSessionId
              ? { parentSessionId: session.parentSessionId, origin: "subagent" }
              : {}),
          })),
        };
      },
      // Every session here is running; DSH would resume one that is not.
      async resolveAgent(sessionId: string) {
        const session = sessions.get(sessionId);
        return session
          ? { agent: session.agent }
          : { error: Object.assign(new Error("not found"), { code: "session/not-found" }) };
      },
      async prompt(request: any) {
        prompts.push(request);
        const session = sessions.get(request.sessionId)!;
        if (
          session.events.some(
            (event) =>
              event.type === "user/message" && event.data.source.rpcId === request.requestId,
          )
        )
          return { accepted: true };
        if (imagesRefused && request.content.some((part: any) => part.type === "image"))
          throw attachmentInvalid("MODEL_DOES_NOT_SUPPORT_IMAGES");
        const content = request.content.map((part: any) => {
          if (part.type !== "image") return part;
          const bytes = Buffer.from(part.data, "base64");
          const ref = {
            attachmentId: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            mediaType: part.mediaType,
            bytes: bytes.length,
            width: 1,
            height: 1,
            ...(part.name ? { name: part.name } : {}),
          };
          images.set(ref.attachmentId, { ref, data: part.data });
          return { type: "image", attachment: ref };
        });
        session.agent.status = "running";
        emit("agent/status", { agent: session.agent, status: "running" });
        append(request.sessionId, "turn/start", { turn: 1 });
        append(request.sessionId, "user/message", {
          role: "user",
          id: randomUUID(),
          content,
          source: { kind: "user", rpcId: request.requestId },
        });
        return { accepted: true };
      },
      attachment: vi.fn(async (request: any) => {
        // DSH 0.2.2-rc.5 reads a durable reference from the global image store.
        if (attachmentByReference) {
          const stored = images.get(request.attachment?.attachmentId);
          if (!stored || !isDeepStrictEqual(stored.ref, request.attachment))
            throw attachmentInvalid("INVALID_ATTACHMENT_REFERENCE");
          return { attachment: stored.ref, data: stored.data };
        }
        // The earlier controller also checks that the image belongs to the requested session.
        const stored = images.get(request.attachmentId);
        const referenced = sessions
          .get(request.sessionId)
          ?.events.some(
            (event) =>
              event.type === "user/message" &&
              event.data.content.some(
                (part: any) => part.attachment?.attachmentId === request.attachmentId,
              ),
          );
        if (!stored || !referenced) throw attachmentInvalid("ATTACHMENT_NOT_REFERENCED");
        return { attachment: stored.ref, data: stored.data };
      }),
      async updateQueue(request: any) {
        queueUpdates.push(request);
        return { accepted: true };
      },
      cancel(request: any) {
        cancels.push(request.sessionId);
        return { accepted: true };
      },
      async rename(request: any) {
        const session = sessions.get(request.sessionId)!;
        session.title = String(request.title).trim();
        return { title: session.title, seq: session.events.length };
      },
      async fork(request: any) {
        const source = sessions.get(request.sessionId)!;
        const id = `${request.sessionId}-fork`;
        create(id, `${source.title} (fork)`);
        return { sessionId: id };
      },
      async create(request: any) {
        expect(request.cwd).toBe(cwd);
        creations.push(request);
        // DSH names a new session after the ID it is given.
        const id = request.sessionId ?? `session-new-${sessions.size}`;
        create(id, "");
        return { sessionId: id };
      },
      async modelCatalog() {
        return {
          default: defaultModel,
          routableProviders: ["deepseek", "mock/local"],
          groups: [
            {
              id: "deepseek",
              name: "DeepSeek",
              models: [
                {
                  id: "deepseek-chat",
                  name: "DeepSeek Chat",
                  reasoning: {
                    efforts: [
                      { id: "low", name: "Low" },
                      { id: "high", name: "High" },
                    ],
                    defaultEffort: "low",
                  },
                },
              ],
            },
            // A provider ID with a slash must survive the picker ID round trip.
            { id: "mock/local", name: "Mock", models: [{ id: "m-1", name: "Mock One" }] },
          ],
          failures: [],
        };
      },
      async selectModel(request: any) {
        const { sessionId: _sessionId, ...selected } = request;
        sessions.get(request.sessionId)!.agent.model.select(selected);
        defaultModel = selected;
        return { selected };
      },
      // The session's chosen model, read the way DSH's own model picker reads it.
      async projections(request: any) {
        const session = sessions.get(request.sessionId);
        if (!session) return null;
        const goal = goals.get(request.sessionId);
        const ending = endings.get(request.sessionId);
        return {
          kind: "sequenced",
          asOfSeq: session.events.length,
          values: {
            modelSelection: { lastUsed: null, next: session.selection ?? null },
            permissions: { currentValue: permissionOf.get(request.sessionId) ?? "workspace-write" },
            plan: planOf.get(request.sessionId) ?? { active: false, pending: false },
            goal: goal
              ? {
                  goal: {
                    id: goal.id,
                    revision: goal.revision,
                    objective: goal.objective,
                    phase: goal.phase,
                    maxGoalRounds: goal.maxGoalRounds,
                    ...(goal.blockedReason ? { blockedReason: goal.blockedReason } : {}),
                  },
                  roundsStarted: goal.roundsStarted,
                  createdAt: goal.createdAt,
                  updatedAt: goal.updatedAt,
                }
              : null,
            subagentCatalog: children.get(request.sessionId) ?? [],
            subagentTiming:
              ending === undefined ? { settledMs: 0 } : { settledMs: 5, lastTurnCompleted: ending },
          },
        };
      },
    },
    goals: {
      get: (agent: any) => (goals.has(agent.id) ? { ...goals.get(agent.id) } : undefined),
      create(agent: any, request: any) {
        const current = goals.get(agent.id);
        if (current && current.phase !== "complete") throw goalError("GOAL_ALREADY_EXISTS");
        return changeGoal(agent.id, {
          id: `goal-${randomUUID()}`,
          revision: 1,
          objective: String(request.objective).trim(),
          phase: "active",
          maxGoalRounds: 256,
          roundsStarted: 0,
          createdAt: 1,
          updatedAt: 1,
          activation: "armed",
        });
      },
      edit(agent: any, ref: any, request: any) {
        const current = currentGoal(agent.id, ref);
        return changeGoal(agent.id, {
          ...current,
          revision: current.revision + 1,
          objective: request.objective,
        });
      },
      pause(agent: any, ref: any) {
        const current = currentGoal(agent.id, ref);
        if (current.phase !== "active") throw goalError("GOAL_INVALID_TRANSITION");
        return changeGoal(agent.id, {
          ...current,
          revision: current.revision + 1,
          phase: "paused",
          activation: "disarmed",
        });
      },
      resume(agent: any, ref: any) {
        const current = currentGoal(agent.id, ref);
        if (current.phase === "active" && current.activation === "armed")
          throw goalError("GOAL_INVALID_TRANSITION");
        return changeGoal(agent.id, {
          ...current,
          revision: current.revision + 1,
          phase: "active",
          activation: "armed",
        });
      },
      clear(agent: any, ref: any) {
        const current = currentGoal(agent.id, ref);
        changeGoal(agent.id, null);
        return { id: current.id, revision: current.revision + 1 };
      },
    },
    permissionPresets: {
      catalog: () => ({
        options: presets.map((value) => ({ value, name: value })),
        defaultOptions: presets.map((value) => ({ value, name: value })),
        defaultPreset: "workspace-write",
      }),
    },
    // DSH's command registry: it logs each command it runs and what the command answered.
    // As in DSH 0.2.2-rc.1: `/export` and `/permission` are listed for every session, while
    // `/compact`, `/goal` and `/plan` show only in a running agent's own list.
    commands: {
      list: (agent?: any) =>
        [
          { name: "export", description: "Download this Session log as a ZIP archive" },
          {
            name: "permission",
            description: "Switch the permission preset (sandbox mode + approval policy)",
            input: { hint: "<preset>" },
          },
          ...(agent
            ? [
                { name: "compact", description: "Compact older conversation history" },
                {
                  name: "goal",
                  description: "Set or view the goal for a long-running task",
                  input: {
                    hint: "[<objective>|clear|edit <objective>|pause|resume]",
                    attachments: true,
                  },
                },
                {
                  name: "plan",
                  description: "Enter or leave plan mode",
                  input: { hint: "[off|message]", attachments: true },
                },
              ]
            : []),
        ].sort((a, b) => (a.name < b.name ? -1 : 1)),
      find: (agent: any, name: string) =>
        ctx.commands.list(agent).find((entry: any) => entry.name === name),
      async execute(agent: any, line: string) {
        const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/.exec(line);
        if (!match || !ctx.commands.find(agent, match[1])) return undefined;
        executed.push(line);
        const commandId = `cmd-${++commandCount}`;
        const args = line.slice(match[0].length);
        append(agent.id, "command/run", {
          commandId,
          name: match[1],
          args,
          source: { kind: "user" },
        });
        let result: { kind: "success" | "error"; text?: string };
        if (match[1] === "compact") {
          if (agent.status !== "idle")
            result = {
              kind: "error",
              text: "Compaction is unavailable because the agent is not idle.",
            };
          else {
            append(agent.id, "compaction/start", { compactionId: "c-1", turn: null });
            await compactionHold;
            append(agent.id, "compaction/end", { compactionId: "c-1", turn: null });
            result = { kind: "success", text: "Compacted 4 history items (~120 tokens)." };
          }
        } else if (match[1] === "permission") {
          const preset = args.trim();
          if (!presets.includes(preset))
            result = { kind: "error", text: `unknown preset "${preset}"` };
          else {
            permissionOf.set(agent.id, preset);
            append(agent.id, "permission/preset", { preset });
            result = { kind: "success", text: `preset ${preset}` };
          }
        } else if (match[1] === "plan") {
          const active = planOf.get(agent.id)?.active ?? false;
          const wanted = args.trim() !== "off";
          planOf.set(agent.id, { active, pending: wanted !== active });
          result = {
            kind: "success",
            text: wanted ? "Plan mode on. Use /plan off to leave." : "Plan mode off.",
          };
        } else result = { kind: "success", text: "Plan mode on. Use /plan off to leave." };
        append(agent.id, "command/done", { commandId, ...result });
        return { commandId, result };
      },
    },
    workspaceController: {
      async archiveSession(request: any) {
        archived.add(request.sessionId);
        pushArchived();
        return { archivedSessionIds: [...archived] };
      },
      async unarchiveSession(request: any) {
        archived.delete(request.sessionId);
        pushArchived();
        return { archivedSessionIds: [...archived] };
      },
      async pinSession({ sessionId }: { sessionId: string }) {
        pinInDsh(sessionId, true);
        return { pinnedSessionIds: [...pinned] };
      },
      async unpinSession({ sessionId }: { sessionId: string }) {
        pinInDsh(sessionId, false);
        return { pinnedSessionIds: [...pinned] };
      },
      async *follow(signal: AbortSignal) {
        const queue: unknown[] = [
          {
            type: "baseline",
            value: { items: [], archivedSessionIds: [...archived], pinnedSessionIds: [...pinned] },
          },
        ];
        let wake: (() => void) | undefined;
        const push = (frame: unknown) => {
          queue.push(frame);
          wake?.();
        };
        followers.add(push);
        try {
          while (!signal.aborted) {
            while (queue.length) yield queue.shift();
            await new Promise<void>((resolve) => {
              wake = resolve;
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        } finally {
          followers.delete(push);
        }
      },
    },
  };
  // DSH's own browser UI answers through a forwarded, non-prepended waterfall listener.
  for (const event of ["approval/request", "user-questions/request"])
    ctx.on(
      event,
      (request: any) =>
        new Promise((resolve, reject) => {
          const entry = { request, resolve, reject };
          nativeAnswers.push(entry);
          request.signal?.addEventListener("abort", () => reject(new Error("withdrawn")), {
            once: true,
          });
        }),
    );
  const newAgent = (id: string): any => {
    const agent: any = {
      id,
      status: "idle",
      inbox: { nextTurn: [], nextStep: [] },
      session: { id, seq: 0 },
      model: {
        select(selection: Record<string, unknown>) {
          selections.push({ sessionId: id, ...selection });
          sessions.get(id)!.selection = selection;
          append(id, "model/selection", selection);
        },
      },
      ctx: {
        tools: {
          register(definition: any) {
            const list = agentTools.get(agent) ?? [];
            if (list.some((item) => item.name === definition.name))
              throw new Error(`tool "${definition.name}" is already registered`);
            list.push(definition);
            agentTools.set(agent, list);
            return () => {
              const left = (agentTools.get(agent) ?? []).filter((item) => item !== definition);
              agentTools.set(agent, left);
            };
          },
        },
      },
    };
    return agent;
  };
  const create = (id: string, title: string, parentSessionId?: string) => {
    const agent = newAgent(id);
    sessions.set(id, {
      events: [],
      agent,
      title,
      updatedAt: Date.now(),
      selection: undefined,
      ...(parentSessionId ? { parentSessionId } : {}),
    });
    emit("agent/created", { agent, source: "startup" });
    return agent;
  };
  const currentGoal = (id: string, ref: any) => {
    const current = goals.get(id);
    if (!current) throw goalError("GOAL_NOT_FOUND");
    if (ref?.id !== current.id || ref?.revision !== current.revision)
      throw goalError("GOAL_STALE_REVISION");
    return current;
  };
  const changeGoal = (id: string, goal: any) => {
    if (goal) goals.set(id, goal);
    else goals.delete(id);
    append(id, "goal/change", { kind: "goal/change", goal });
    return goal && { ...goal };
  };
  const finishTurn = (id: string, text: string) => {
    const session = sessions.get(id)!;
    append(id, "assistant/message", {
      turn: 1,
      step: 0,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    append(id, "turn/end", { turn: 1, reason: { kind: "completed" } });
    session.agent.status = "idle";
    emit("agent/status", { agent: session.agent, status: "idle" });
  };
  return {
    ctx,
    sessions,
    prompts,
    creations,
    surfaces,
    queueUpdates,
    cancels,
    selections,
    archived,
    pinned,
    pinInDsh,
    pushWorkspace,
    /** An archive made in DSH's own window. */
    archiveInDsh(id: string) {
      archived.add(id);
      pushArchived();
    },
    nativeAnswers,
    /** A model without image input: DSH refuses prompts with images. */
    refuseImages() {
      imagesRefused = true;
    },
    goals,
    executed,
    permissionOf,
    planOf,
    /** DSH resumed the session: its goal stays active but no longer continues by itself. */
    disarmGoal(id: string) {
      goals.set(id, { ...goals.get(id), activation: "disarmed" });
      emit("goal/activation-changed", { sessionId: id });
    },
    /** A goal edited in DSH's own window. */
    editGoalInDsh(id: string, objective: string) {
      const current = goals.get(id);
      changeGoal(id, { ...current, revision: current.revision + 1, objective });
    },
    /** Keeps the next compaction running until the returned function is called. */
    holdCompaction() {
      let release!: () => void;
      compactionHold = new Promise<void>((resolve) => (release = resolve));
      return () => {
        compactionHold = null;
        release();
      };
    },
    /** A subagent of `parent`; `ending` is whether its last turn completed. */
    spawnChild(parent: string, id: string, label: string, ending?: boolean) {
      create(id, label, parent);
      children.set(parent, [
        ...(children.get(parent) ?? []),
        { id, createdAt: 1_700_000_000_000, mode: "one-shot", label },
      ]);
      if (ending !== undefined) endings.set(id, ending);
    },
    create,
    append,
    finishTurn,
    emit,
    /** The tools a session's current agent has of its own. */
    toolsOf: (id: string) => agentTools.get(sessions.get(id)?.agent) ?? [],
    /** DSH loads the session again: a new agent replaces the old one. */
    reload(id: string) {
      const session = sessions.get(id)!;
      emit("agent/disposed", { agent: session.agent });
      agentTools.delete(session.agent);
      session.agent = newAgent(id);
      emit("agent/created", { agent: session.agent, source: "resume" });
      return session.agent;
    },
    close: () => disposers.forEach((dispose) => dispose()),
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until<T>(read: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type FakeContextPressure = { projectedTokens: number; contextWindow?: number };

async function fixture({
  supportsCreateModelSelection = true,
  supportsPins = true,
  initiallyPinned = false,
  dshVersion = "0.2.2-rc.3",
  contextPressure,
  lead,
  reconcileGiveUpMs = 300,
  waitForWatch = true,
  onSessionsChanged,
}: {
  supportsCreateModelSelection?: boolean;
  supportsPins?: boolean;
  initiallyPinned?: boolean;
  dshVersion?: string;
  contextPressure?: () => FakeContextPressure;
  lead?: DshBridgeOptions["lead"];
  reconcileGiveUpMs?: number;
  waitForWatch?: boolean;
  onSessionsChanged?: DshBridgeOptions["sessionsChanged"];
} = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-dsh-test-")));
  const workspace = path.join(root, "workspace");
  const agentkibHome = path.join(root, "agentkib-home");
  mkdirSync(workspace);
  const publish = vi.fn();
  const changed: string[][] = [];
  const listed = Promise.withResolvers<void>();
  const bridge = new DshBridge({
    dataDir: path.join(root, "data"),
    bootId: randomUUID(),
    pluginDirectory: path.join(root, "plugin"),
    discoveryFile: path.join(agentkibHome, "dsh-bridge", "discovery-v1.json"),
    platform: "darwin",
    commandTimeoutMs: 1500,
    disconnectGraceMs: 100,
    reconcileIntervalMs: 0,
    reconcileGiveUpMs,
    sessionId: (nativeId) => `ak-${nativeId}`,
    workspaceFor: (cwd) =>
      cwd.startsWith(workspace) ? { id: "workspace", path: workspace } : null,
    workspacePath: (id) => (id === "workspace" ? workspace : null),
    sessionsChanged: (ids) => {
      changed.push(ids);
      onSessionsChanged?.(ids);
      if (bridge.handles("ak-session-a")) listed.resolve();
    },
    publish,
    ...(lead ? { lead } : {}),
  });
  bridge.initialize();
  const dsh = fakeDsh(workspace, dshVersion === "0.2.2-rc.5");
  if (!supportsCreateModelSelection) delete dsh.ctx.llm;
  if (!supportsPins) {
    delete dsh.ctx.workspaceController.pinSession;
    delete dsh.ctx.workspaceController.unpinSession;
  }
  if (contextPressure) {
    dsh.ctx.tokenMeter = { contextPressure };
    const projections = dsh.ctx.sessionController.projections;
    dsh.ctx.sessionController.projections = async (request: { sessionId: string }) => {
      const projection = await projections(request);
      if (projection) projection.values.contextPressure = contextPressure();
      return projection;
    };
  }
  dsh.create("session-a", "First DSH session");
  if (initiallyPinned) dsh.pinInDsh("session-a", true);
  const plugin = createBridge(dsh.ctx, {
    roots: [agentkibHome],
    dshVersion,
    discoveryMs: 50,
    debounceMs: 10,
    listThrottleMs: 20,
    commandWaitMs: 150,
  });
  cleanups.push(async () => {
    plugin.close();
    dsh.close();
    await bridge.close();
    rmSync(root, { recursive: true, force: true });
  });
  await listed.promise;
  // The first report lists the session; the next acknowledges the watch list.
  if (waitForWatch)
    await until(
      () => plugin.hosts.size > 0 && [...plugin.hosts.values()][0]!.watch.has("session-a"),
    );
  let lastBody: Record<string, unknown> = {};
  const control = (operation: string, extra: Record<string, unknown> = {}) => {
    const live = bridge.live("ak-session-a", true);
    lastBody = {
      operation,
      sessionId: "ak-session-a",
      requestId: randomUUID(),
      deviceId: "device-1",
      runtimeBootId: live.runtimeBootId,
      expectedRevision: live.revision,
      experimentalEnabled: true,
      ...extra,
    };
    return bridge.request(lastBody) as Promise<Record<string, any>>;
  };
  return {
    root,
    workspace,
    agentkibHome,
    bridge,
    dsh,
    plugin,
    publish,
    changed,
    control,
    lastBody: () => lastBody,
  };
}

describe("DeepSeek Harness bridge", () => {
  it("keeps other commands in a poll when a native import fails its final admission", async () => {
    const f = await fixture({ dshVersion: "0.2.2-rc.5" });
    const runtimeId = f.plugin.runtimeId;
    f.plugin.close();
    const discovery = JSON.parse(
      readFileSync(path.join(f.agentkibHome, "dsh-bridge", "discovery-v1.json"), "utf8"),
    );
    const { token } = await post(discovery.socketPath, DSH_BRIDGE_PATHS.register, {
      key: discovery.key,
      protocol: 1,
      pluginVersion: DSH_BRIDGE_PLUGIN_VERSION,
      dshVersion: "0.2.2-rc.5",
      runtimeId,
      pid: process.pid,
      services: {
        sessionController: true,
        sessionQuery: true,
        approvals: true,
        questions: true,
        historyImport: true,
      },
    });
    const poll = () => post(discovery.socketPath, DSH_BRIDGE_PATHS.poll, { token });
    const imported = f.bridge
      .importHistory({
        context: { runtimeId, workspaceId: "dsh-workspace" },
        workspaceId: "workspace",
        cwd: f.workspace,
        nativeId: randomUUID(),
        document: {
          schema_version: 1,
          source: { agent: "codex", workspace_id: "workspace" },
          turns: [{ id: "user", role: "user", blocks: [{ type: "text", text: "hello" }] }],
          redaction_count: 0,
          losses: [],
        },
        verifyOnly: false,
        beforeDispatch: () => {
          throw new Error("the authorized workspace changed");
        },
      })
      .then(
        () => null,
        (error: Error) => error.message,
      );
    const read = (await poll()).commands[0];
    expect(read.type).toBe("history-import-context");
    const complete = (commandId: string) =>
      post(discovery.socketPath, DSH_BRIDGE_PATHS.result, {
        token,
        commandId,
        ok: true,
        value: { workspaceId: "dsh-workspace" },
      });
    await complete(read.commandId);
    const other = f.bridge.historyImportContext(f.workspace);
    const batch = (await poll()).commands;
    expect(batch.map((command: { type: string }) => command.type)).toEqual([
      "history-import-context",
    ]);
    await complete(batch[0].commandId);
    await expect(other).resolves.toEqual({ runtimeId, workspaceId: "dsh-workspace" });
    expect(await imported).toBe("dsh-native-import-unverified");
  });

  it("reads native pins in both directions while running and retains the last value offline", async () => {
    const f = await fixture({ initiallyPinned: true });
    const id = "ak-session-a";
    await until(() => f.bridge.pinState(id)?.available);
    expect(f.bridge.pinState(id)).toEqual({ pinned: true, available: true });

    f.dsh.create("session-b", "Second DSH session");
    await until(() => f.bridge.handles("ak-session-b"));
    f.dsh.pushWorkspace({
      type: "replace",
      value: { items: [], archivedSessionIds: ["session-b"] },
    });
    await until(() =>
      f.bridge
        .list(f.workspace)
        .sessions.some((row) => row.native_ref === "session-b" && row.archived),
    );
    expect(f.bridge.pinState(id)).toEqual({ pinned: true, available: true });
    f.dsh.pushWorkspace({
      type: "replace",
      value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] },
    });
    await until(() => f.bridge.pinState(id)?.pinned === false);

    await f.control("send", { text: "run the tests" });
    await until(() => f.bridge.live(id, true).status === "running");
    await expect(f.bridge.setPinned(id, true)).resolves.toBe(true);
    expect(f.dsh.pinned.has("session-a")).toBe(true);
    await until(() => f.bridge.pinState(id)?.pinned === true);
    await expect(f.bridge.setPinned(id, false)).resolves.toBe(false);
    expect(f.dsh.pinned.has("session-a")).toBe(false);
    await until(() => f.bridge.pinState(id)?.pinned === false);

    f.changed.length = 0;
    f.dsh.pinInDsh("session-a", true);
    await until(() => f.bridge.pinState(id)?.pinned === true);
    expect(f.changed).toContainEqual(["workspace"]);
    f.plugin.close();
    await until(() => f.bridge.pinState(id)?.available === false);
    expect(f.bridge.pinState(id)).toEqual({ pinned: true, available: false });
    await expect(f.bridge.setPinned(id, false)).rejects.toThrow("session-pin-unavailable");
    await f.bridge.close();
    const reopened = new DshBridge({ ...f.bridge.options, discoveryFile: undefined });
    cleanups.push(() => reopened.close());
    expect(reopened.pinState(id)).toEqual({ pinned: true, available: false });
  });

  it("does not send pins to a DSH without native pin methods", async () => {
    const f = await fixture({ supportsPins: false });
    expect(f.bridge.pinState("ak-session-a")).toBeUndefined();
    await expect(f.bridge.setPinned("ak-session-a", true)).rejects.toThrow(
      "session-pin-unavailable",
    );
    await expect(f.bridge.setPinned("ak-missing", true)).rejects.toThrow("session-not-found");
  });

  it("browses its registered workspace without issuing a native command or enabling references", async () => {
    const f = await fixture();
    const before = f.dsh.executed.length;
    expect(f.bridge.capabilities("ak-session-a", false).features).toMatchObject({
      resources: { available: true },
      files: { available: true },
      context: { available: false },
      usage: { available: false },
    });
    expect(
      await f.bridge.request({ operation: "resources", sessionId: "ak-session-a" }),
    ).toMatchObject({
      available: true,
      contextReferences: { supportedTypes: [] },
      skills: [],
      plugins: [],
      apps: [],
    });
    expect(f.dsh.executed).toHaveLength(before);
    expect(f.dsh.prompts).toEqual([]);
  });

  it.skipIf(process.platform !== "darwin")(
    "routes the registered DSH provider and legacy requests to the same bridge and receipts",
    async () => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-dsh-provider-")));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const dataDir = path.join(root, "data");
      const workspace = path.join(root, "workspace");
      const agentkibHome = path.join(root, "agentkib-home");
      mkdirSync(dataDir);
      mkdirSync(workspace);
      const store = new BackendStore(path.join(dataDir, "agentkib.db"));
      store.sql.run(
        "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
        "workspace",
        workspace,
        "Synthetic DSH workspace",
        "healthy",
        new Date().toISOString(),
      );
      store.close();
      vi.spyOn(McpHub.prototype, "start").mockResolvedValue();
      vi.spyOn(RemoteAgent.prototype, "start").mockResolvedValue();
      const notify = vi.fn();
      const backend = new TypeScriptBackend(
        {
          HOME: root,
          USERPROFILE: root,
          AGENTKIB_HOME: agentkibHome,
          AGENTKIB_DSH_PLUGIN_DIR: "",
          CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
          CODEX_HOME: path.join(root, ".codex"),
          DSH_HOME: path.join(root, ".dsh"),
          PATH: "/usr/bin:/bin",
        },
        notify,
      );
      cleanups.push(() => backend.close());
      const call = (method: string, params: Record<string, unknown>) =>
        backend.handleAsync({ jsonrpc: "2.0", id: randomUUID(), method, params });
      const rpc = async (method: string, params: Record<string, unknown>) => {
        const response = await call(method, params);
        if (response.error) throw new Error(JSON.stringify(response.error));
        return response.result as Record<string, unknown>;
      };
      const web = (params: Record<string, unknown>) => rpc(RUNTIME_METHODS.webRequest, params);
      await rpc("backend.initialize", { dataDir });
      const dsh = fakeDsh(workspace);
      dsh.create("session-a", "Existing DSH session");
      const plugin = createBridge(dsh.ctx, {
        roots: [agentkibHome],
        dshVersion: "0.2.1-rc.5",
        discoveryMs: 50,
        debounceMs: 10,
      });
      cleanups.push(() => {
        plugin.close();
        dsh.close();
      });
      await until(() => [...plugin.hosts.values()].some((host) => host.watch.has("session-a")));

      const agent = "deepseek-harness";
      const provider = sessionProviderCapabilities(agent);
      const baseOptions = await web({ operation: "provider-options", agent });
      expect(baseOptions).toMatchObject({ available: true, provider });
      expect(baseOptions).not.toHaveProperty("models");
      const options = await web({ operation: "provider-options", agent, workspaceId: "workspace" });
      expect(options).toMatchObject({
        available: true,
        provider,
        models: expect.arrayContaining([
          expect.objectContaining({ id: "deepseek/deepseek-chat", efforts: ["low", "high"] }),
        ]),
        agentPresets: expect.arrayContaining([expect.objectContaining({ id: "ptc" })]),
      });
      expect(await web({ operation: "dsh-options", includeModels: true })).toEqual(options);

      const creation = {
        requestId: randomUUID(),
        deviceId: "device-1",
        workspaceId: "workspace",
        agentPreset: "ptc",
        model: "deepseek/deepseek-chat",
        effort: "high",
      };
      const result = await web({ operation: "provider-create", agent, ...creation });
      expect(result).toMatchObject({
        accepted: true,
        completed: true,
        sessionId: expect.any(String),
      });
      const sessionId = String(result.sessionId);
      expect(await web({ operation: "dsh-create", ...creation })).toMatchObject({
        accepted: true,
        sessionId,
      });
      expect(dsh.creations).toHaveLength(1);
      expect(dsh.creations[0]).toMatchObject({ cwd: workspace, agentPreset: "ptc" });
      expect(dsh.prompts).toHaveLength(0);

      const settings = () => web({ operation: "settings-state", sessionId });
      await vi.waitFor(async () => {
        expect(await settings()).toMatchObject({
          available: true,
          provider,
          current: { model: creation.model, effort: "high" },
          writable: { effort: { available: true } },
        });
      });
      expect(await web({ operation: "usage", sessionId })).toEqual({
        available: false,
        state: "unavailable",
        reason: "usage-unavailable",
      });

      const live = await web({ operation: "live", sessionId, experimentalEnabled: true });
      const update = {
        operation: "settings",
        sessionId,
        deviceId: creation.deviceId,
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        requestId: randomUUID(),
        effort: "low",
      };
      // The Codex RPC cannot claim an indexed DSH session using its native boot and revision.
      expect(await call(RUNTIME_METHODS.codexManaged, update)).toHaveProperty("error");
      expect(
        await web({
          ...update,
          requestId: randomUUID(),
          expectedRevision: Number(live.revision) + 1,
        }),
      ).toMatchObject({ controlOutcome: "not-dispatched", reason: "stale-dsh-revision" });
      expect(dsh.selections).toHaveLength(1);
      expect(await web(update)).toMatchObject({ accepted: true });
      expect(await web(update)).toMatchObject({ accepted: true });
      expect(dsh.selections).toHaveLength(2);
      expect(await settings()).toMatchObject({ current: { effort: "low" } });
      expect(
        await rpc(RUNTIME_METHODS.controlReceipt, {
          requestId: update.requestId,
          deviceId: creation.deviceId,
        }),
      ).toMatchObject({ found: true, status: "accepted", operation: "settings", sessionId });
      expect(
        await rpc(RUNTIME_METHODS.controlReceipt, {
          requestId: update.requestId,
          deviceId: "other-device",
        }),
      ).toMatchObject({ found: false });

      dsh.spawnChild(String(live.sourceSessionId), "activity-child", "Check package", true);
      const listing = await web({ operation: "subagents", sessionId });
      const childId = (listing.agents as SubagentCatalog["agents"])[0]?.id;
      expect(childId).toMatch(/^[a-f0-9]{64}$/);
      const subscription = (await rpc(RUNTIME_METHODS.sessionsSubscribe, {
        sessionId,
      })) as SessionSubscription;
      try {
        const snapshot = subscription.events.find(({ type }) => type === "snapshot")?.payload.live;
        expect(snapshot).toMatchObject({
          subagents: { agents: [], available: false },
          activities: [
            { id: childId, childId, kind: "subagent", title: "Check package", status: "completed" },
          ],
        });
        expect(await web({ operation: "live", sessionId })).not.toHaveProperty("activities");
        // Re-register with the same plugin runtime ID, as happens after a broken poll.
        // The replaced binding must clear its activities without waiting for a new list.
        plugin.close();
        const discovery = JSON.parse(
          readFileSync(path.join(agentkibHome, "dsh-bridge", "discovery-v1.json"), "utf8"),
        );
        await post(discovery.socketPath, DSH_BRIDGE_PATHS.register, {
          key: discovery.key,
          protocol: DSH_BRIDGE_PROTOCOL,
          pluginVersion: DSH_BRIDGE_PLUGIN_VERSION,
          dshVersion: plugin.dshVersion,
          runtimeId: plugin.runtimeId,
          pid: process.pid,
          services: {
            sessionController: true,
            sessionQuery: true,
            approvals: true,
            questions: true,
          },
        });
        expect(notify).toHaveBeenCalledWith(
          SESSION_EVENT_NOTIFICATION,
          expect.objectContaining({
            subscriptionId: subscription.subscriptionId,
            sessionId,
            type: "state",
            payload: expect.objectContaining({ activities: [] }),
          }),
        );
      } finally {
        await rpc(RUNTIME_METHODS.sessionsUnsubscribe, {
          subscriptionId: subscription.subscriptionId,
        });
      }
    },
  );

  it("publishes a private discovery file and lists sessions of registered workspaces", async () => {
    const f = await fixture();
    const discovery = path.join(f.agentkibHome, "dsh-bridge", "discovery-v1.json");
    expect(statSync(discovery).mode & 0o777).toBe(0o600);
    const value = JSON.parse(readFileSync(discovery, "utf8"));
    expect(value).toMatchObject({ protocol: 1, key: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(statSync(value.socketPath).mode & 0o777).toBe(0o600);
    const listing = f.bridge.list(f.workspace);
    expect(listing.sessions).toEqual([
      expect.objectContaining({
        native_ref: "session-a",
        agent: "deepseek-harness",
        title: "First DSH session",
        availability: "readable",
      }),
    ]);
    expect(f.bridge.list(path.join(f.root, "elsewhere")).sessions).toEqual([]);
    expect(f.changed.flat()).toContain("workspace");
  });

  it("projects native DSH catalog changes and waiting state without a session index refresh", async () => {
    const completed = new EventEmitter();
    const f = await fixture({
      waitForWatch: false,
      onSessionsChanged: (ids) => completed.emit("catalog", ids),
    });
    const update = async (write: () => void) => {
      const changed = once(completed, "catalog", { signal: AbortSignal.timeout(3_000) });
      write();
      await expect(changed).resolves.toEqual([["workspace"]]);
    };
    const session = () =>
      f.bridge.list(f.workspace).sessions.find(({ native_ref }) => native_ref === "session-b");

    await update(() => f.dsh.create("session-b", "New in DSH"));
    expect(session()).toMatchObject({ title: "New in DSH", archived: false });

    await update(() => {
      f.dsh.sessions.get("session-b")!.title = "Renamed in DSH";
      f.dsh.append("session-b", "session/title", { title: "Renamed in DSH" });
    });
    expect(session()).toMatchObject({ title: "Renamed in DSH" });

    const before = session()?.updated_at;
    await update(() => f.dsh.finishTurn("session-b", "Native turn finished"));
    expect(session()?.updated_at).not.toBe(before);
    expect(session()?.updated_at).toBe(
      new Date(f.dsh.sessions.get("session-b")!.updatedAt).toISOString(),
    );

    await update(() => f.dsh.archiveInDsh("session-b"));
    expect(session()).toMatchObject({ title: "Renamed in DSH", archived: true });

    const waiting = Promise.withResolvers<void>();
    f.publish.mockImplementation((id, type, payload) => {
      if (id === "ak-session-a" && type === "state" && payload.status === "waiting-input")
        waiting.resolve();
    });
    const agent = f.dsh.sessions.get("session-a")!.agent;
    const question = f.dsh.ctx.waterfall(
      { scoped: agent },
      "user-questions/request",
      { agent, questions: [{ id: "q1", question: "Continue?", options: [{ label: "Yes" }] }] },
      () => Promise.reject(new Error("no answerer")),
    );
    await waiting.promise;
    expect(f.bridge.live("ak-session-a", true)).toMatchObject({ status: "waiting-input" });
    const answer = { answers: [{ id: "q1", selected: ["Yes"] }] };
    f.dsh.nativeAnswers[0]!.resolve(answer);
    await expect(question).resolves.toEqual(answer);
  });

  it("takes a plugin of another release and leaves off what it does not report", async () => {
    const f = await fixture();
    const discovery = JSON.parse(
      readFileSync(path.join(f.agentkibHome, "dsh-bridge", "discovery-v1.json"), "utf8"),
    );
    const register = (change: Record<string, unknown> = {}) =>
      post(discovery.socketPath, DSH_BRIDGE_PATHS.register, {
        key: discovery.key,
        protocol: 1,
        pluginVersion: "0.9.0",
        dshVersion: "0.2.2-rc.1",
        runtimeId: randomUUID(),
        pid: process.pid,
        // A newer plugin may report services and fields this Runtime does not know.
        services: {
          sessionController: true,
          sessionQuery: true,
          approvals: true,
          questions: true,
          futureService: true,
        },
        futureField: { kept: false },
        ...change,
      });
    const { token } = await register();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    await post(discovery.socketPath, DSH_BRIDGE_PATHS.report, {
      token,
      sessions: [
        {
          sessionId: "session-newer",
          cwd: f.workspace,
          title: null,
          updatedAt: 1,
          running: false,
          live: false,
          blank: false,
          parentSessionId: null,
          origin: null,
          futureField: true,
        },
      ],
    });
    expect(
      f.bridge.management({ operation: "dsh-bridge-status", deviceId: "agentkib-local-owner" })
        .runtimes,
    ).toContainEqual(expect.objectContaining({ pluginVersion: "0.9.0", sessions: 1 }));
    // It reported no `documents`, so its session cannot be read for a handoff.
    expect(f.bridge.documentStatus("session-newer")).toEqual({
      status: "unavailable",
      reason: "dsh-document-unavailable",
    });
    expect(f.bridge.documentStatus("session-a")).toEqual({ status: "supported" });
    await expect(register({ pluginVersion: "0.4.0" })).rejects.toMatchObject({
      status: 409,
      code: "dsh-bridge-plugin-update-required",
    });
    await expect(register({ protocol: 2 })).rejects.toMatchObject({
      status: 409,
      code: "dsh-bridge-protocol-unsupported",
    });
  });

  it("reads history pages through the plugin and keeps injected context out", async () => {
    const f = await fixture();
    f.dsh.append("session-a", "turn/start", { turn: 1 });
    f.dsh.append("session-a", "user/message", {
      role: "user",
      id: "m1",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "r1" },
    });
    f.dsh.append("session-a", "user/message", {
      role: "user",
      id: "m2",
      content: [{ type: "text", text: "<AGENTS.md contents>" }],
      source: { kind: "context-notice" },
    });
    f.dsh.append("session-a", "tool/call", {
      turn: 1,
      step: 0,
      callId: "c1",
      name: "bash",
      arguments: "{}",
    });
    f.dsh.append("session-a", "tool/result", {
      turn: 1,
      step: 0,
      message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "ok" }] },
    });
    f.dsh.append("session-a", "assistant/message", {
      turn: 1,
      step: 1,
      message: {
        role: "assistant",
        content: [
          { type: "reasoning", text: "hidden" },
          { type: "text", text: "done" },
        ],
      },
    });
    const page = await f.bridge.events("session-a", null, 50);
    expect(page.events.map((event) => [event.kind, event.content, event.tool_status])).toEqual([
      ["user-message", "hello", null],
      ["tool-summary", "ok", "completed"],
      ["agent-message", "done", null],
    ]);
    expect(JSON.stringify(page)).not.toContain("AGENTS.md");
    expect(JSON.stringify(page)).not.toContain("hidden");
    await expect(f.bridge.events("session-a", "codex-native-v1:1", 10)).rejects.toThrow(
      "TRANSCRIPT_CURSOR_STALE",
    );
  });

  it("restores answered DSH questionnaires across separate call and result pages", async () => {
    const f = await fixture();
    const label = "优".repeat(400);
    const questions = [
      {
        id: "areas",
        header: "选择范围",
        question: "要覆盖哪些区域？",
        multi_select: true,
        options: [{ label, description: "选项说明" }, { label: "历史" }],
      },
      { id: "notes", question: "还有什么要说明？" },
    ];
    const answers = [
      { id: "notes", selected: [], custom: "只读即可" },
      { id: "areas", selected: [label, "历史"] },
    ];
    f.dsh.append("session-a", "tool/call", {
      turn: 1,
      callId: "questions",
      name: "ask_user_question",
      arguments: JSON.stringify({ questions }),
    });
    f.dsh.append("session-a", "tool/result", {
      turn: 1,
      message: {
        toolCallId: "questions",
        content: [{ type: "text", text: JSON.stringify({ answers }) }],
      },
    });

    const latest = await f.bridge.events("session-a", null, 1);
    const selectedLabel = "优".repeat(341) + "…";
    const questionnaire = {
      status: "answered",
      questions: [
        {
          id: "areas",
          header: "选择范围",
          question: "要覆盖哪些区域？",
          multiSelect: true,
          options: [{ label: selectedLabel, description: "选项说明" }, { label: "历史" }],
          answer: { selected: [selectedLabel, "历史"] },
        },
        {
          id: "notes",
          question: "还有什么要说明？",
          multiSelect: false,
          options: [],
          answer: { selected: [], custom: "只读即可" },
        },
      ],
    };
    expect(latest.events).toMatchObject([
      { id: "dsh-tool:questions", content: null, questionnaire },
    ]);
    expect(latest.next_cursor).toBeTruthy();
    const older = await f.bridge.events("session-a", latest.next_cursor, 1);
    expect(older.events).toMatchObject([
      { id: "dsh-tool:questions", content: null, questionnaire },
    ]);
    const together = await f.bridge.events("session-a", null, 10);
    expect(together.events).toMatchObject([
      { id: "dsh-tool:questions", content: null, questionnaire },
    ]);
  });

  it("keeps tool output readable when a plugin provides no valid questionnaire projection", () => {
    const preview = JSON.stringify({ answers: [{ id: "scope", selected: ["Docs"] }] });
    for (const questionnaire of [undefined, [{ id: "wrong shape" }]]) {
      const events = dshConversationEvents([
        {
          seq: 1,
          time: null,
          kind: "tool-call",
          turn: 1,
          callId: "questions",
          name: "ask_user_question",
        },
        {
          seq: 2,
          time: null,
          kind: "tool-result",
          turn: 1,
          callId: "questions",
          isError: false,
          preview,
          truncated: false,
          questionnaire,
        } as DshBridgeHistoryRecord,
      ]);
      expect(events).toMatchObject([
        { kind: "tool-summary", tool_name: "ask_user_question", content: preview },
      ]);
      expect(events[0]).not.toHaveProperty("questionnaire");
    }
  });

  it("sends through DSH's session service once per request and records a receipt", async () => {
    const f = await fixture();
    const result = await f.control("send", { text: "run the tests" });
    expect(result).toMatchObject({ accepted: true, controlOutcome: "accepted" });
    expect(f.dsh.prompts).toEqual([
      expect.objectContaining({
        sessionId: "session-a",
        requestId: result.requestId,
        mode: "queue",
      }),
    ]);
    // The same request replays the stored outcome instead of reaching DSH again; the same
    // request ID with a different body is refused.
    const body = f.lastBody();
    const replay = (await f.bridge.request(body)) as Record<string, unknown>;
    expect(replay).toMatchObject({ requestId: result.requestId, controlOutcome: "accepted" });
    // What was stored carries the settled state, not the moment the request was unconfirmed.
    expect(replay.live).not.toMatchObject({ status: "outcome-unknown" });
    expect(f.dsh.prompts).toHaveLength(1);
    await expect(f.bridge.request({ ...body, text: "something else" })).rejects.toThrow(
      "request-id-reused-with-different-input",
    );
    expect(
      readControlReceipt(f.bridge.options.dataDir, {
        requestId: result.requestId,
        deviceId: "device-1",
      }),
    ).toMatchObject({
      found: true,
      status: "accepted",
    });
    const live = await until(() => {
      const value = f.bridge.live("ak-session-a", true);
      return value.status === "running" && value;
    });
    expect(live).toMatchObject({
      executionMode: "dsh-follower",
      executionLocation: "external",
      sendEnabled: false,
      stopEnabled: true,
      turnId: "dsh-turn-1",
    });
    const stopped = await f.control("stop", { turnId: "dsh-turn-1" });
    expect(stopped).toMatchObject({ accepted: true, completed: false });
    expect(f.dsh.cancels).toEqual(["session-a"]);
  });

  it.each(["0.2.1-rc.5", "0.2.2-rc.6"])(
    "does not send an unscoped stop on DSH %s",
    async (dshVersion) => {
      const f = await fixture({ dshVersion });
      await f.control("send", { text: "keep running" });
      const live = await until(() => {
        const value = f.bridge.live("ak-session-a", true);
        return value.turnId === "dsh-turn-1" && value;
      });
      expect(live).toMatchObject({ stopEnabled: false, queueEnabled: true });
      await expect(f.control("stop", { turnId: "dsh-turn-1" })).resolves.toMatchObject({
        accepted: false,
        controlOutcome: "not-dispatched",
        reason: "dsh-stop-unavailable",
      });
      expect(f.dsh.cancels).toEqual([]);
    },
  );

  it("rechecks the native turn after the host's reported state and ignores a prior turn's late end", async () => {
    const f = await fixture();
    await f.control("send", { text: "stop first only" });
    await until(() => f.bridge.live("ak-session-a", true).turnId === "dsh-turn-1");
    const session = f.dsh.sessions.get("session-a")!;
    // Native switched turns while the Host still has the older report.
    const ended = {
      seq: session.events.length,
      time: Date.now(),
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    };
    const started = {
      seq: ended.seq + 1,
      time: Date.now(),
      type: "turn/start",
      data: { turn: 2 },
    };
    session.events.push(ended, started);
    await expect(f.control("stop", { turnId: "dsh-turn-1" })).resolves.toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "stale-turn",
    });
    expect(f.dsh.cancels).toEqual([]);

    f.dsh.emit("session/event", { id: "session-a" }, started);
    await until(() => f.bridge.live("ak-session-a", true).turnId === "dsh-turn-2");
    f.dsh.emit("agent/assistant-stream", {
      agent: session.agent,
      frame: { type: "chunk", chunk: { type: "text-delta", text: "next round" } },
    });
    f.dsh.emit("session/event", { id: "session-a" }, ended);
    await until(() => f.bridge.live("ak-session-a", true).streamText === "next round");
    expect(f.bridge.live("ak-session-a", true)).toMatchObject({
      turnId: "dsh-turn-2",
      stopEnabled: true,
    });
  });

  it("settles a lost stop reply only from the target turn's explicit native end", async () => {
    const f = await fixture();
    await f.control("send", { text: "stop this turn" });
    await until(() => f.bridge.live("ak-session-a", true).turnId === "dsh-turn-1");
    const sendRequest = dshClient.post;
    // Let the native cancellation request through and drop its transport acknowledgement.
    let dropped = false;
    const transport = vi.spyOn(dshClient, "post").mockImplementation((...args) => {
      const [_, route, body] = args;
      if (
        route === DSH_BRIDGE_PATHS.result &&
        body?.value?.accepted === true &&
        body.value.sessionId === "session-a" &&
        body.value.turn === 1
      ) {
        dropped = true;
        return Promise.reject(new Error("test lost reply"));
      }
      return sendRequest(...args);
    });
    try {
      const stopped = await f.control("stop", { turnId: "dsh-turn-1" });
      expect(dropped).toBe(true);
      expect(stopped).toMatchObject({ controlOutcome: "unknown", completed: false });
      expect(f.dsh.cancels).toEqual(["session-a"]);
      const check = () =>
        readControlReceipt(f.bridge.options.dataDir, {
          requestId: stopped.requestId,
          deviceId: "device-1",
        });
      f.dsh.append("session-a", "turn/start", { turn: 2 });
      f.dsh.append("session-a", "turn/end", { turn: 2, reason: { kind: "aborted" } });
      f.dsh.append("session-a", "turn/start", { turn: 3 });
      await f.bridge.request({ operation: "reconcile", sessionId: "ak-session-a" });
      expect(check().status).toBe("unknown");
      f.dsh.append("session-a", "turn/end", { turn: 1, reason: { kind: "aborted" } });
      await until(() => check().status === "accepted");
      expect(check()).toMatchObject({
        turnId: "dsh-turn-1",
        completionObserved: true,
        ack: { completed: true, completionObserved: true },
      });
      expect(f.bridge.live("ak-session-a", true)).toMatchObject({
        status: "running",
        turnId: "dsh-turn-3",
      });
      const history = await f.bridge.events("session-a", null, 20);
      expect(history.events).toContainEqual(
        expect.objectContaining({
          kind: "user-message",
          turn_id: "dsh-turn-1",
          turn_meta: { outcome: "aborted" },
        }),
      );
    } finally {
      transport.mockRestore();
    }
  });

  it("keeps the control revision while DSH streams, so a queued message is not stale", async () => {
    const f = await fixture();
    await f.control("send", { text: "run the tests" });
    const running = await until(() => {
      const value = f.bridge.live("ak-session-a", true);
      return value.status === "running" && value;
    });
    const agent = f.dsh.sessions.get("session-a")!.agent;
    for (const text of ["Working", " on", " it"])
      f.dsh.emit("agent/assistant-stream", {
        agent,
        frame: { type: "chunk", chunk: { type: "text-delta", text } },
      });
    await until(() => f.bridge.live("ak-session-a", true).streamText === "Working on it");
    expect(f.bridge.live("ak-session-a", true).revision).toBe(running.revision);
    // Decided on the revision seen before the text arrived.
    const queued = await f.bridge.request({
      operation: "queue-add",
      sessionId: "ak-session-a",
      requestId: randomUUID(),
      deviceId: "device-1",
      runtimeBootId: running.runtimeBootId,
      expectedRevision: running.revision,
      experimentalEnabled: true,
      text: "and then the lint",
    });
    expect(queued).toMatchObject({ accepted: true });
  });

  it("lists only messages waiting for the next turn and steers one into the running turn", async () => {
    const f = await fixture();
    await f.control("send", { text: "run the tests" });
    await until(() => f.bridge.live("ak-session-a", true).status === "running");
    const agent = f.dsh.sessions.get("session-a")!.agent;
    const message = (id: string, text: string) => ({
      id,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "user" },
    });
    agent.inbox.nextTurn = [message("q1", "after this turn")];
    agent.inbox.nextStep = [message("s1", "already steering")];
    f.publish.mockClear();
    f.dsh.emit("agent/status", { agent, status: "running" });
    await until(() => f.bridge.live("ak-session-a", true).queuedCount === 1);
    // Queue readers refetch on this signal, not on every streamed state change.
    expect(
      f.publish.mock.calls.some(
        ([id, type, payload]) =>
          id === "ak-session-a" && type === "invalidate" && payload.domains?.includes("queue"),
      ),
    ).toBe(true);
    // Steering is part of the running turn already, so only q1 is waiting.
    const queued = (await f.bridge.request({
      operation: "queue-list",
      sessionId: "ak-session-a",
    })) as { data: { id: string }[] };
    expect(queued.data.map((item) => item.id)).toEqual(["q1"]);
    expect(f.bridge.live("ak-session-a", true).queuedCount).toBe(1);
    await expect(f.control("queue-steer", { queuedSubmissionId: "s1" })).resolves.toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "queue-item-unavailable",
    });
    const steered = await f.control("queue-steer", { queuedSubmissionId: "q1" });
    expect(steered).toMatchObject({ accepted: true });
    expect(f.dsh.queueUpdates).toEqual([
      expect.objectContaining({ sessionId: "session-a", itemId: "q1", action: { kind: "steer" } }),
    ]);
  });

  it.each(["0.2.1-rc.5", "0.2.2-rc.5"])(
    "reads %s images only from their own session history",
    async (dshVersion) => {
      const f = await fixture({ dshVersion });
      expect(f.bridge.capabilities("ak-session-a", true).features).toMatchObject({
        attachments: { available: true },
      });
      const file = path.join(f.root, "shot.png");
      writeFileSync(file, PNG);
      const sha256 = createHash("sha256").update(PNG).digest("hex");
      const imageId = `dsh-image-v1-${sha256}`;
      const result = await f.control("send", {
        input: [
          { type: "text", text: "what is this?" },
          {
            type: "image",
            path: file,
            sha256,
            size: PNG.length,
            mediaType: "image/png",
            name: "shot.png",
          },
        ],
      });
      expect(result).toMatchObject({ accepted: true });
      // The plugin read the file and handed DSH its bytes; the path stays on this side.
      expect(f.dsh.prompts[0].content).toEqual([
        { type: "text", text: "what is this?" },
        { type: "image", mediaType: "image/png", data: PNG.toString("base64"), name: "shot.png" },
      ]);
      const page = await f.bridge.events("session-a", null, 50);
      expect(page.events.find((event) => event.kind === "user-message")).toMatchObject({
        content: "what is this?",
        attachment_count: 1,
        images: [{ id: imageId, mimeType: "image/png", name: "shot.png" }],
      });
      const preview = {
        mimeType: "image/png",
        base64: PNG.toString("base64"),
      };
      await expect(f.bridge.image("session-a", imageId)).resolves.toEqual(preview);
      f.dsh.create("session-b", "Another session");
      const read = f.dsh.ctx.sessionController.attachment;
      read.mockClear();
      // Even when the bytes are in the global store, an unrelated session cannot read them.
      await expect(f.bridge.image("session-b", imageId)).rejects.toThrow(
        "session-image-unavailable",
      );
      expect(read).not.toHaveBeenCalled();
      // Native import persists the same full image reference without running a live prompt.
      const imported = f.dsh.sessions
        .get("session-a")!
        .events.find((event) => event.type === "user/message")!.data;
      f.dsh.append("session-b", "user/message", { ...imported, source: { kind: "user" } });
      await expect(f.bridge.image("session-b", imageId)).resolves.toEqual(preview);
      await expect(f.bridge.image("session-a", "session-image-v1-x")).rejects.toThrow(
        "session-image-invalid",
      );
    },
  );

  it("refuses images DSH cannot take, whether AgentKib or DSH finds out", async () => {
    const f = await fixture();
    const file = path.join(f.root, "shot.png");
    const image = (sha256: string) => ({
      type: "image",
      path: file,
      sha256,
      size: PNG.length,
      mediaType: "image/png",
      name: "shot.png",
    });
    // The file no longer holds what AgentKib checked: the plugin stops before DSH is asked.
    const changed = Buffer.from(PNG);
    changed[changed.length - 1]! ^= 1;
    writeFileSync(file, changed);
    await expect(
      f.control("send", { input: [image(createHash("sha256").update(PNG).digest("hex"))] }),
    ).resolves.toMatchObject({ controlOutcome: "not-dispatched", reason: "attachment-changed" });
    expect(f.dsh.prompts).toEqual([]);
    // A model without image input: DSH refuses, and the reason says so.
    writeFileSync(file, PNG);
    f.dsh.refuseImages();
    await expect(
      f.control("send", {
        input: [
          { type: "text", text: "look" },
          image(createHash("sha256").update(PNG).digest("hex")),
        ],
      }),
    ).resolves.toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "model-images-unsupported",
    });
    expect(f.dsh.sessions.get("session-a")!.events).toEqual([]);
  });

  it("protects queued DSH attachments while retaining native delete and steer", async () => {
    const f = await fixture();
    await f.control("send", { text: "run the tests" });
    await until(() => f.bridge.live("ak-session-a", true).status === "running");
    const agent = f.dsh.sessions.get("session-a")!.agent;
    agent.inbox.nextTurn = [
      {
        id: "q1",
        role: "user",
        content: [
          { type: "text", text: "see this" },
          {
            type: "image",
            attachment: { attachmentId: `sha256:${"a".repeat(64)}`, mediaType: "image/png" },
          },
        ],
        source: { kind: "user" },
      },
      // A file reaches DSH as its own line of text naming it.
      {
        id: "q2",
        role: "user",
        content: [
          { type: "text", text: "read this" },
          { type: "text", text: 'User attached file "a.txt": /tmp/a.txt' },
        ],
        source: { kind: "user" },
      },
      {
        id: "q3",
        role: "user",
        content: [{ type: "file", name: "native.txt" }],
        source: { kind: "user" },
      },
      {
        id: "q4",
        role: "user",
        content: [
          { type: "text", text: "x".repeat(4096) },
          { type: "text", text: "User attached file [notes.txt](file:///tmp/notes.txt)" },
        ],
        source: { kind: "user" },
      },
    ];
    f.dsh.emit("agent/status", { agent, status: "running" });
    await until(() => f.bridge.live("ak-session-a", true).queuedCount === 4);
    const queued = (await f.bridge.request({
      operation: "queue-list",
      sessionId: "ak-session-a",
    })) as { data: { id: string; input: unknown[] }[] };
    expect(queued.data.slice(0, 2).map((item) => item.input)).toEqual([
      [{ type: "text", text: "see this" }, { type: "image" }],
      [
        { type: "text", text: "read this" },
        { type: "text", text: 'User attached file "a.txt": /tmp/a.txt' },
      ],
    ]);
    for (const item of queued.data) {
      expect(item).toMatchObject({
        hasAttachments: true,
        actions: { update: { available: false, reason: "queue_attachments_edit_unsupported" } },
      });
      await expect(
        f.control("queue-update", { queuedSubmissionId: item.id, text: "drop the attachment" }),
      ).resolves.toMatchObject({
        controlOutcome: "not-dispatched",
        reason: "queue_attachments_edit_unsupported",
      });
    }
    expect(f.dsh.queueUpdates).toEqual([]);
    expect(f.bridge.capabilities("ak-session-a", true).features).toMatchObject({
      "queue-list": { available: true },
      "queue-update": { available: true },
      "queue-delete": { available: true },
      "queue-steer": { available: true },
      "queue-reorder": { available: false },
      "queue-pause": { available: false },
      "queue-resume": { available: false },
    });
    const steered = await f.control("queue-steer", { queuedSubmissionId: "q3" });
    expect(steered).toMatchObject({ accepted: true });
    await expect(f.bridge.request(f.lastBody())).resolves.toEqual(steered);
    await expect(f.control("queue-delete", { queuedSubmissionId: "q4" })).resolves.toMatchObject({
      accepted: true,
    });
    expect(f.dsh.queueUpdates).toEqual([
      { sessionId: "session-a", itemId: "q3", action: { kind: "steer" } },
      { sessionId: "session-a", itemId: "q4", action: { kind: "remove" } },
    ]);
    expect(f.dsh.prompts).toHaveLength(1);
  });

  it("checks a DSH queue edit against the native item even before the next bridge report", async () => {
    const f = await fixture();
    await f.control("send", { text: "run the tests" });
    await until(() => f.bridge.live("ak-session-a", true).status === "running");
    const agent = f.dsh.sessions.get("session-a")!.agent;
    const plain = { id: "queued", role: "user", content: "plain text", source: { kind: "user" } };
    agent.inbox.nextTurn = [plain];
    f.dsh.emit("agent/status", { agent, status: "running" });
    await until(() => f.bridge.live("ak-session-a", true).queuedCount === 1);
    await expect(
      f.control("queue-update", { queuedSubmissionId: "queued", text: "edited text" }),
    ).resolves.toMatchObject({ accepted: true });
    expect(f.dsh.queueUpdates).toEqual([
      {
        sessionId: "session-a",
        itemId: "queued",
        action: { kind: "edit", content: [{ type: "text", text: "edited text" }] },
      },
    ]);

    // The bridge still sees the plain snapshot; the real inbox item changed before dispatch.
    agent.inbox.nextTurn = [{ ...plain, content: [{ type: "file", name: "new.txt" }] }];
    await expect(
      f.control("queue-update", { queuedSubmissionId: "queued", text: "erase the attachment" }),
    ).resolves.toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "queue_attachments_edit_unsupported",
    });
    expect(f.dsh.queueUpdates).toHaveLength(1);
  });

  it("keeps legacy DSH queue actions when the bridge cannot verify plain text for editing", async () => {
    const sendRequest = dshClient.post;
    const transport = vi.spyOn(dshClient, "post").mockImplementation((...args) => {
      const [socketPath, route, body, options] = args;
      if (route !== DSH_BRIDGE_PATHS.report || !Array.isArray(body?.states))
        return sendRequest(...args);
      return sendRequest(
        socketPath,
        route,
        {
          ...body,
          states: body.states.map((state: DshBridgeSessionState) => ({
            ...state,
            queue: state.queue.map(({ hasAttachments: _hasAttachments, ...item }) => item),
          })),
        },
        options,
      );
    });
    try {
      const f = await fixture();
      await f.control("send", { text: "run the tests" });
      await until(() => f.bridge.live("ak-session-a", true).status === "running");
      const agent = f.dsh.sessions.get("session-a")!.agent;
      agent.inbox.nextTurn = [
        { id: "legacy", role: "user", content: "legacy text", source: { kind: "user" } },
      ];
      f.dsh.emit("agent/status", { agent, status: "running" });
      await until(() => f.bridge.live("ak-session-a", true).queuedCount === 1);
      await expect(
        f.bridge.request({ operation: "queue-list", sessionId: "ak-session-a" }),
      ).resolves.toMatchObject({
        data: [
          {
            id: "legacy",
            input: [{ type: "text", text: "legacy text" }],
            actions: { update: { available: false, reason: "dsh-queue-edit-unverified" } },
          },
        ],
      });
      await expect(
        f.control("queue-update", { queuedSubmissionId: "legacy", text: "cannot verify" }),
      ).resolves.toMatchObject({
        controlOutcome: "not-dispatched",
        reason: "dsh-queue-edit-unverified",
      });
      await expect(f.control("queue-add", { text: "keep queueing text" })).resolves.toMatchObject({
        accepted: true,
      });
      expect(f.dsh.prompts.at(-1)?.content).toEqual([{ type: "text", text: "keep queueing text" }]);
      await expect(
        f.control("queue-delete", { queuedSubmissionId: "legacy" }),
      ).resolves.toMatchObject({ accepted: true });
      expect(f.dsh.queueUpdates).toEqual([
        { sessionId: "session-a", itemId: "legacy", action: { kind: "remove" } },
      ]);
    } finally {
      transport.mockRestore();
    }
  });

  it("requires send permission to steer a pending DSH queue item", () => {
    const context = {
      executionMode: "dsh-follower",
      verifiedClaudeManaged: false,
      verifiedSerialQueue: false,
      requireFullAccess: vi.fn(),
    };
    expect(
      validateDeepSeekHarnessControl({ operation: "queue-steer", legacyCodex: false }, context),
    ).toMatchObject({ available: true, requiresSend: true, queueItem: "pending" });
    expect(
      validateDeepSeekHarnessControl({ operation: "queue-delete", legacyCodex: false }, context),
    ).not.toHaveProperty("requiresSend", true);
  });

  it("shows an approval in both places and the first answer wins", async () => {
    const f = await fixture();
    const outer = new AbortController();
    const agent = f.dsh.sessions.get("session-a")!.agent;
    const pending = f.dsh.ctx.waterfall(
      { scoped: agent },
      "approval/request",
      { agent, toolName: "bash", reason: "needs network", signal: outer.signal },
      () => Promise.resolve("unavailable"),
    );
    const live = await until(() => {
      const value = f.bridge.live("ak-session-a", true);
      return (value.approvals as unknown[]).length > 0 && value;
    });
    expect(live.status).toBe("awaiting-approval");
    const approval = (live.approvals as any[])[0];
    expect(approval).toMatchObject({
      method: "dsh/approval",
      toolName: "bash",
      supported: true,
      availableDecisions: ["accept", "decline"],
    });
    // DSH's own UI received the same request through the re-dispatched copy.
    expect(f.dsh.nativeAnswers).toHaveLength(1);
    const answered = await f.control("approve", {
      turnId: approval.turnId,
      approvalId: approval.requestId,
      decision: "accept",
    });
    expect(answered).toMatchObject({ accepted: true });
    await expect(pending).resolves.toBe("allowed-once");
    // AgentKib answered first, so the DSH UI copy is withdrawn.
    await expect(
      new Promise((resolve, reject) =>
        f.dsh.nativeAnswers[0]!.request.signal.aborted
          ? resolve("aborted")
          : reject(new Error("still open")),
      ),
    ).resolves.toBe("aborted");
    await until(() => (f.bridge.live("ak-session-a", true).approvals as unknown[]).length === 0);
  });

  it.each([
    ["Fixture approve this run", "allow", "once", "executed"],
    ["Fixture reject this run", "deny", "once", "denied"],
    ["Fixture save this allowance", "allow", "persistent", "executed"],
  ] as const)(
    "records the native DSH permission choice %s without keeping answer text",
    async (label, kind, scope, result) => {
      const f = await fixture();
      const agent = f.dsh.sessions.get("session-a")!.agent;
      const questions = [
        {
          id: "fixture-permission",
          question: "Fixture private approval prompt",
          options: [{ label: "Fixture approve this run" }, { label: "Fixture reject this run" }],
          intent: {
            kind: "approval",
            approve: "Fixture approve this run",
            reject: "Fixture reject this run",
            always: "Fixture save this allowance",
          },
        },
      ];
      const pending = f.dsh.ctx.waterfall(
        { scoped: agent },
        "user-questions/request",
        { agent, questions },
        () => Promise.reject(new Error("no answerer")),
      );
      const live = await until(() => {
        const value = f.bridge.live("ak-session-a", true);
        return (value.questions as unknown[]).length > 0 && value;
      });
      const [question] = live.questions as Record<string, unknown>[];
      const request = {
        operation: "answer",
        sessionId: "ak-session-a",
        deviceId: "device-1",
        requestId: randomUUID(),
        turnId: question?.turnId,
        questionId: question?.requestId,
        answers: { "fixture-permission": [label] },
      };
      const evidence = await approvalAuditEvidence(live, request, f.workspace);
      expect(evidence).toEqual({
        risk: { level: "high", reason: "unknown-operation" },
        decision: { kind, scope },
      });
      const audit = new SessionApprovalAuditStore(path.join(f.root, "audit"));
      await expect(
        recordApprovalDecision(
          audit,
          "answer",
          request,
          { agent: "deepseek-harness", workspaceId: "workspace" },
          { source: { kind: "desktop" }, ...evidence },
          () => f.control("answer", request),
        ),
      ).resolves.toMatchObject({ accepted: true });
      await expect(pending).resolves.toEqual({
        answers: [{ id: "fixture-permission", selected: [label] }],
      });
      expect((await audit.list()).entries).toMatchObject([
        {
          kind: "approval",
          decision: { kind, scope },
          result,
        },
      ]);
      const kept = readFileSync(path.join(f.root, "audit", "approval-audit.json"), "utf8");
      expect(kept).not.toContain(label);
      expect(kept).not.toContain("Fixture private approval prompt");
    },
  );

  it("withdraws the AgentKib copy when DSH's UI answers first", async () => {
    const f = await fixture();
    const agent = f.dsh.sessions.get("session-a")!.agent;
    const pending = f.dsh.ctx.waterfall(
      { scoped: agent },
      "user-questions/request",
      {
        agent,
        questions: [{ id: "q1", question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
      },
      () => Promise.reject(new Error("no answerer")),
    );
    const live = await until(() => {
      const value = f.bridge.live("ak-session-a", true);
      return (value.questions as unknown[]).length > 0 && value;
    });
    const question = (live.questions as any[])[0];
    expect(question).toMatchObject({ method: "dsh/question", supported: true });
    f.dsh.nativeAnswers[0]!.resolve({ answers: [{ id: "q1", selected: ["A"] }] });
    await expect(pending).resolves.toEqual({ answers: [{ id: "q1", selected: ["A"] }] });
    await until(() => (f.bridge.live("ak-session-a", true).questions as unknown[]).length === 0);
    // Refused before reaching DSH, and said so: the answer was not sent, not of unknown outcome.
    await expect(
      f.control("answer", {
        turnId: question.turnId,
        questionId: question.requestId,
        answers: { q1: ["B"] },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "interaction-answered-elsewhere",
    });
  });

  it("withdraws the native waterfall of a timed question when AgentKib answers", async () => {
    const f = await fixture({ dshVersion: "0.2.2-rc.5" });
    const outer = new AbortController();
    const agent = f.dsh.sessions.get("session-a")!.agent;
    const wait = { callId: "timed-tool-call", timed: true };
    const pending = f.dsh.ctx.waterfall(
      { scoped: agent },
      "user-questions/request",
      {
        agent,
        signal: outer.signal,
        wait,
        questions: [{ id: "q1", question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
      },
      () => Promise.reject(new Error("no answerer")),
    );
    const question = await until(() => {
      const live = f.bridge.live("ak-session-a", true);
      return (live.questions as any[])[0];
    });
    expect(f.dsh.nativeAnswers).toHaveLength(1);
    const forwarded = f.dsh.nativeAnswers[0]!;
    expect(forwarded.request.wait).toEqual(wait);
    expect(forwarded.request.signal).not.toBe(outer.signal);
    const answer = {
      turnId: question.turnId,
      questionId: question.requestId,
      answers: { q1: ["B"] },
    };
    await expect(f.control("answer", answer)).resolves.toMatchObject({
      accepted: true,
    });
    expect(forwarded.request.signal.aborted).toBe(true);
    expect(outer.signal.aborted).toBe(false);
    forwarded.resolve({ answers: [{ id: "q1", selected: ["A"] }] });
    await expect(pending).resolves.toEqual({ answers: [{ id: "q1", selected: ["B"] }] });
    await until(() => (f.bridge.live("ak-session-a", true).questions as unknown[]).length === 0);
    await expect(f.control("answer", answer)).resolves.toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "interaction-answered-elsewhere",
    });
  });

  it.each(["approval", "question"] as const)(
    "rejects a stale bridge %s response as soon as the original request is cancelled",
    async (kind) => {
      const f = await fixture({ dshVersion: "0.2.2-rc.5" });
      const outer = new AbortController();
      const reason = Object.assign(new Error("The original wait ended"), { code: "ASK_TIMED_OUT" });
      const agent = f.dsh.sessions.get("session-a")!.agent;
      const pending = f.dsh.ctx.waterfall(
        { scoped: agent },
        kind === "approval" ? "approval/request" : "user-questions/request",
        {
          agent,
          signal: outer.signal,
          ...(kind === "approval"
            ? { toolName: "bash" }
            : {
                wait: { callId: "timed-tool-call", timed: true },
                questions: [{ id: "q1", question: "Which?", options: [{ label: "A" }] }],
              }),
        },
        () => Promise.reject(new Error("no answerer")),
      );
      const settlement =
        kind === "approval"
          ? expect(pending).resolves.toBe("cancelled")
          : expect(pending).rejects.toBe(reason);
      await until(() => f.dsh.nativeAnswers[0]);
      const interactionId = [...f.plugin.interactions.keys()][0];
      expect(interactionId).toEqual(expect.any(String));
      outer.abort(reason);
      // Queue the reply before the downstream promise rejection can propagate. It must not
      // revive the cancelled interaction or overwrite the native timed-wait reason.
      const response = await f.plugin.run({
        type: "answer",
        interactionId,
        value:
          kind === "approval"
            ? { outcome: "allowed-once" }
            : { answers: [{ id: "q1", selected: ["A"] }] },
      });
      await settlement;
      expect(response).toEqual({ found: false });
      expect(f.dsh.nativeAnswers[0]!.request.signal.reason).toBe(reason);
      expect(f.plugin.interactions.size).toBe(0);
    },
  );

  it("shows a send still waiting for DSH's reply as busy, not unconfirmed", async () => {
    const f = await fixture();
    const controller = f.dsh.ctx.sessionController;
    const prompt = controller.prompt.bind(controller);
    let release: (() => void) | undefined;
    // DSH starts the turn, and reports it, before the prompt call returns.
    controller.prompt = (request: any) =>
      new Promise((resolve) => {
        const started = prompt(request);
        release = () => resolve(started);
      });
    const sending = f.control("send", { text: "slow reply" });
    await until(() => release !== undefined);
    const waiting = f.bridge.live("ak-session-a", true);
    expect(waiting.status).not.toBe("outcome-unknown");
    expect(waiting.reason).not.toBe("control-outcome-unconfirmed");
    expect(waiting.sendEnabled).toBe(false);
    release!();
    expect(await sending).toMatchObject({ controlOutcome: "accepted" });
  });

  it("keeps a delivered send unknown until DSH's record confirms it", async () => {
    const f = await fixture();
    const original = f.dsh.ctx.sessionController.prompt;
    // The prompt reaches DSH, but its result never comes back.
    f.dsh.ctx.sessionController.prompt = (request: any) => {
      void original(request);
      return new Promise(() => undefined);
    };
    const result = await f.control("send", { text: "lost reply" });
    expect(result).toMatchObject({ accepted: false, controlOutcome: "unknown" });
    expect(result.live).toMatchObject({
      status: "outcome-unknown",
      sendEnabled: false,
      reason: "control-outcome-unconfirmed",
    });
    // DSH's next report brings it back from the record; a manual check finds the same.
    await f.bridge.request({ operation: "reconcile", sessionId: "ak-session-a" });
    await until(
      () =>
        readControlReceipt(f.bridge.options.dataDir, {
          requestId: result.requestId,
          deviceId: "device-1",
        }).status === "accepted",
    );
    expect(f.bridge.live("ak-session-a", true).reason).not.toBe("control-outcome-unconfirmed");
  });

  it("settles a send whose result never came back from DSH's own record", async () => {
    const f = await fixture();
    const controller = f.dsh.ctx.sessionController;
    const prompt = controller.prompt.bind(controller);
    let release!: () => void;
    controller.prompt = (request: any) =>
      new Promise((resolve) => {
        release = () => resolve(prompt(request));
      });
    const sent = await f.control("send", { text: "slow to take" });
    expect(sent).toMatchObject({ controlOutcome: "unknown" });
    expect(f.bridge.live("ak-session-a", true).reason).toBe("control-outcome-unconfirmed");
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Overdue, but DSH still works on it: absent from the record without being lost.
    await f.bridge.request({
      operation: "reconcile",
      sessionId: "ak-session-a",
      experimentalEnabled: true,
    });
    expect(f.bridge.live("ak-session-a", true).reason).toBe("control-outcome-unconfirmed");
    f.publish.mockClear();
    release();
    await until(() => f.bridge.live("ak-session-a", true).reason !== "control-outcome-unconfirmed");
    expect(
      readControlReceipt(f.bridge.options.dataDir, {
        requestId: sent.requestId,
        deviceId: "device-1",
      }),
    ).toMatchObject({ found: true, status: "accepted" });
    // Clients holding a fence for it read the receipt again.
    expect(
      f.publish.mock.calls.some(
        ([id, type, payload]) =>
          id === "ak-session-a" && type === "invalidate" && payload.domains?.includes("receipts"),
      ),
    ).toBe(true);
  });

  it("ends the wait for a send DSH has no trace of once it no longer works on it", async () => {
    const f = await fixture({ reconcileGiveUpMs: 0, waitForWatch: false });
    // The plugin reports the indeterminate result after removing this prompt from its active set.
    f.dsh.ctx.sessionController.prompt = async () => {
      throw new Error("unknown");
    };
    const sent = await f.control("send", { text: "never taken" });
    expect(sent).toMatchObject({ controlOutcome: "unknown" });
    await f.bridge.request({
      operation: "reconcile",
      sessionId: "ak-session-a",
      experimentalEnabled: true,
    });
    expect(
      readControlReceipt(f.bridge.options.dataDir, {
        requestId: sent.requestId,
        deviceId: "device-1",
      }).status,
    ).toBe("not-dispatched");
    expect(f.bridge.live("ak-session-a", true)).toMatchObject({ sendEnabled: true });
  });

  it("keeps read history after DSH quits and reads it again when DSH returns", async () => {
    const f = await fixture();
    for (const [index, text] of ["hello", "next"].entries())
      f.dsh.append("session-a", "user/message", {
        role: "user",
        id: `message-${index}`,
        content: [{ type: "text", text }],
        source: { kind: "user", rpcId: `request-${index}` },
      });
    const page = await f.bridge.events("session-a", null, 1);
    expect(page.events).toMatchObject([{ content: "next" }]);
    expect(page.next_cursor).toBe("dsh-v1:1");
    const older = await f.bridge.events("session-a", page.next_cursor, 1);
    expect(older.events).toMatchObject([{ content: "hello" }]);
    const disconnected = Promise.withResolvers<void>();
    f.publish.mockImplementation((id, type, payload) => {
      if (id === "ak-session-a" && type === "state" && payload.reason === "dsh-runtime-offline")
        disconnected.resolve();
    });
    f.plugin.close();
    // The dropped poll is noticed within the grace period, long before OFFLINE_MS.
    await disconnected.promise;
    expect(f.bridge.list(f.workspace).sessions).toEqual([
      expect.objectContaining({ native_ref: "session-a", availability: "readable" }),
    ]);
    // What this run read stays visible; an older page it never read is not made up.
    await expect(f.bridge.events("session-a", null, 1)).resolves.toEqual({
      ...page,
      warnings: ["dsh-history-unavailable"],
    });
    await expect(f.bridge.events("session-a", page.next_cursor, 1)).resolves.toEqual({
      ...older,
      warnings: ["dsh-history-unavailable"],
    });
    await expect(f.bridge.events("session-a", "dsh-v1:0", 1)).rejects.toThrow(
      "dsh-runtime-offline",
    );
    const refreshed = Promise.withResolvers<void>();
    f.publish.mockImplementation((id, type, payload) => {
      if (id === "ak-session-a" && type === "invalidate" && payload.domains.includes("history"))
        refreshed.resolve();
    });
    const again = createBridge(f.dsh.ctx, {
      roots: [f.agentkibHome],
      dshVersion: "0.2.1-rc.5",
      discoveryMs: 50,
      debounceMs: 10,
    });
    cleanups.push(() => again.close());
    await refreshed.promise;
    expect(f.bridge.live("ak-session-a", true).executionLocation).toBe("external");
    await expect(f.bridge.events("session-a", null, 1)).resolves.toEqual(page);
  });

  it("keeps the last complete context reading across a partial reply and host restart", async () => {
    let pressure: FakeContextPressure = { projectedTokens: 100 };
    const f = await fixture({ contextPressure: () => pressure });
    const sessionId = "ak-session-a";
    const usage = () => f.bridge.live(sessionId, true).usage as ContextUsage;
    const requestUsage = { operation: "usage", sessionId };
    const updatePressure = (reading: FakeContextPressure) => {
      pressure = reading;
      f.dsh.append("session-a", "user/message", {
        role: "user",
        id: randomUUID(),
        content: [{ type: "text", text: "Context changed" }],
        source: { kind: "user" },
      });
    };

    await f.bridge.request(requestUsage);
    await vi.waitFor(() =>
      expect(usage()).toMatchObject({ available: true, state: "pending", usedTokens: 100 }),
    );
    expect(usage().contextWindow).toBeUndefined();

    updatePressure({ projectedTokens: 200, contextWindow: 1000 });
    await vi.waitFor(() =>
      expect(usage()).toMatchObject({
        state: "ready",
        usedTokens: 200,
        contextWindow: 1000,
        percent: 20,
      }),
    );
    const complete = usage();

    updatePressure({ projectedTokens: 300 });
    const cached = {
      available: true,
      state: "stale",
      historical: true,
      usedTokens: 200,
      contextWindow: 1000,
      updatedAt: complete.updatedAt,
    };
    await vi.waitFor(() => expect(usage()).toMatchObject(cached));

    f.plugin.close();
    await f.bridge.close();
    const reopened = new DshBridge({ ...f.bridge.options, bootId: randomUUID() });
    cleanups.push(() => reopened.close());
    expect(reopened.live(sessionId, true).usage).toMatchObject(cached);
    await expect(reopened.request(requestUsage)).resolves.toMatchObject(cached);
  });

  it("distinguishes verified empty history from unavailable history after restart", async () => {
    const f = await fixture();
    await expect(f.bridge.events("session-a", null, 50)).resolves.toEqual({
      events: [],
      next_cursor: null,
      warnings: [],
    });
    f.plugin.close();
    await f.bridge.close();
    const reopened = new DshBridge({ ...f.bridge.options, discoveryFile: undefined });
    cleanups.push(() => reopened.close());
    expect(reopened.list(f.workspace).sessions).toEqual([
      expect.objectContaining({ native_ref: "session-a", availability: "readable" }),
    ]);
    await expect(reopened.events("session-a", null, 50)).resolves.toEqual({
      events: [],
      next_cursor: null,
      warnings: ["dsh-history-unavailable"],
    });
    expect(reopened.live("ak-session-a", true)).toMatchObject({
      status: "unsupported",
      reason: "dsh-runtime-offline",
      sendEnabled: false,
    });
  });

  it("keeps rejected and mismatched plugin pages out of history", async () => {
    const f = await fixture();
    const observe = f.dsh.ctx.sessionQuery.observeSession;
    const observation = vi.spyOn(f.dsh.ctx.sessionQuery, "observeSession");
    observation.mockRejectedValue(new Error("Synthetic native history failure"));
    await expect(f.bridge.events("session-a", null, 50)).rejects.toMatchObject({
      message: "dsh-history-unavailable",
    });
    observation.mockImplementation(async (id) => {
      const result = await observe(id);
      return { ...result, header: { ...result.header, id: "other-session" } };
    });
    await expect(f.bridge.events("session-a", null, 50)).rejects.toMatchObject({
      message: "dsh-history-unavailable",
    });

    observation.mockRestore();
    f.dsh.append("session-a", "user/message", {
      role: "user",
      id: "m1",
      content: [{ type: "text", text: "Recovered history" }],
      source: { kind: "user", rpcId: "r1" },
    });
    await expect(f.bridge.events("session-a", null, 50)).resolves.toMatchObject({
      events: [{ content: "Recovered history" }],
      warnings: [],
    });
  });

  it("preserves cached content when the active history read loses its plugin", async () => {
    const f = await fixture();
    f.dsh.append("session-a", "user/message", {
      role: "user",
      id: "m1",
      content: [{ type: "text", text: "Cached history" }],
      source: { kind: "user", rpcId: "r1" },
    });
    const page = await f.bridge.events("session-a", null, 50);
    expect(page.events).toMatchObject([{ content: "Cached history" }]);
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const observe = f.dsh.ctx.sessionQuery.observeSession;
    vi.spyOn(f.dsh.ctx.sessionQuery, "observeSession").mockImplementation(async (id) => {
      received.resolve();
      await release.promise;
      return observe(id);
    });
    const pending = f.bridge.events("session-a", null, 50);
    await received.promise;
    f.plugin.close();
    try {
      await f.bridge.close();
    } finally {
      release.resolve();
    }
    await expect(pending).resolves.toEqual({ ...page, warnings: ["dsh-history-timeout"] });
  });
});

describe("DeepSeek Harness plugin projections", () => {
  it("bounds versions and history records", () => {
    expect(dshBridgeCompatibility("0.2.1-rc.5")).toBe("verified");
    expect(dshBridgeCompatibility("0.2.2-alpha.3")).toBe("unverified");
    expect(dshBridgeCompatibility("0.2.1-rc.4")).toBe("too-old");
    expect(dshBridgeCompatibility("0.2.1")).toBe("unverified");
    expect(dshBridgeCompatibility("unknown")).toBe("unknown");
    expect(dshBridgeCompatibility("latest")).toBe("invalid");
    expect(dshBridgePluginCompatibility("0.5.0")).toBe("supported");
    expect(dshBridgePluginCompatibility("0.6.0")).toBe("supported");
    expect(dshBridgePluginCompatibility("1.0.0")).toBe("supported");
    expect(dshBridgePluginCompatibility("0.4.9")).toBe("too-old");
    expect(dshBridgePluginCompatibility("0.5.0-rc.1")).toBe("too-old");
    expect(dshBridgePluginCompatibility("latest")).toBe("invalid");
    expect(dshBridgePluginCompatibility(undefined)).toBe("invalid");
    expect(historyRecord({ seq: 1, time: 1, type: "system/message", data: {} })).toBeNull();
    // A failed turn keeps the provider's error code and a bounded message; others add nothing.
    expect(
      historyRecord({
        seq: 2,
        time: 1,
        type: "turn/end",
        data: {
          turn: 3,
          reason: { kind: "error", error: { code: "QUOTA", message: "x".repeat(900) } },
        },
      }),
    ).toMatchObject({
      kind: "turn-end",
      reason: "error",
      failure: { code: "QUOTA", message: "x".repeat(500) },
    });
    expect(
      historyRecord({
        seq: 3,
        time: 1,
        type: "turn/end",
        data: { turn: 3, reason: { kind: "error", error: {} } },
      }),
    ).not.toHaveProperty("failure");
    expect(
      historyRecord({
        seq: 4,
        time: 1,
        type: "turn/end",
        data: { turn: 3, reason: { kind: "completed" } },
      }),
    ).not.toHaveProperty("failure");
    expect(
      historyRecord({
        seq: 2,
        time: 1,
        type: "user/message",
        data: { content: "x".repeat(70_000), source: { kind: "user" } },
      }),
    ).toMatchObject({ kind: "user", truncated: true });
    expect(
      queueItems({
        inbox: {
          nextTurn: [
            {
              id: "1",
              content: [{ type: "text", text: "queued" }],
              source: { kind: "user", rpcId: "r" },
            },
          ],
          nextStep: [{ id: "2", content: "notice", source: { kind: "context" } }],
        },
      }),
    ).toEqual([
      {
        id: "1",
        placement: "queued",
        text: "queued",
        images: 0,
        hasAttachments: false,
        rpcId: "r",
      },
    ]);
    // Images keep DSH's stored reference; one without a well-formed reference is left out.
    expect(
      historyRecord({
        seq: 3,
        time: 1,
        type: "user/message",
        data: {
          content: [
            { type: "text", text: "look" },
            {
              type: "image",
              attachment: {
                attachmentId: `sha256:${"b".repeat(64)}`,
                mediaType: "image/png",
                name: "a.png",
              },
            },
            {
              type: "image",
              attachment: { attachmentId: "../etc/passwd", mediaType: "image/png" },
            },
          ],
          source: { kind: "user" },
        },
      }),
    ).toMatchObject({
      kind: "user",
      images: [{ attachmentId: `sha256:${"b".repeat(64)}`, mediaType: "image/png", name: "a.png" }],
    });
    expect(
      dshConversationEvents([
        {
          seq: 1,
          time: null,
          kind: "tool-result",
          turn: 1,
          callId: "x",
          isError: true,
          preview: "boom",
          truncated: false,
        },
      ]),
    ).toEqual([expect.objectContaining({ id: "dsh-tool:x", tool_status: "failed" })]);
  });

  it("bounds goals, commands, presets and subagents", () => {
    expect(
      historyRecord({
        seq: 4,
        type: "command/run",
        data: { commandId: "cmd-1", name: "goal", args: " ship", source: { kind: "user" } },
      }),
    ).toMatchObject({ kind: "command", name: "goal", args: " ship" });
    expect(
      historyRecord({ seq: 5, type: "command/done", data: { commandId: "cmd-1", kind: "error" } }),
    ).toMatchObject({ kind: "command-result", ok: false, text: null });
    // A command DSH answered without text adds nothing to read.
    expect(
      dshConversationEvents([
        { seq: 5, time: null, kind: "command-result", commandId: "cmd-1", ok: true, text: null },
      ]),
    ).toEqual([]);

    const goal = {
      id: "goal-1",
      revision: 3,
      objective: "x".repeat(70 * 1024),
      phase: "blocked",
      blockedReason: { code: "needs-input", message: "Which branch?" },
      maxGoalRounds: 256,
      roundsStarted: 7,
      createdAt: 1,
      updatedAt: 2,
      activation: "armed",
    };
    expect(goalView(goal)).toMatchObject({
      phase: "blocked",
      blockedReason: { code: "needs-input", message: "Which branch?" },
      roundsStarted: 7,
      activation: "armed",
    });
    expect(goalView(goal)!.objective).toHaveLength(64 * 1024);
    expect(goalView({ ...goal, phase: "unknown" })).toBeNull();
    expect(goalView({ ...goal, revision: 0 })).toBeNull();
    // Without a running agent the goal is read from DSH's projection, as DSH would resume it.
    expect(
      goalFromProjection({
        goal: { ...goal, phase: "active", blockedReason: undefined },
        roundsStarted: 7,
        createdAt: 1,
        updatedAt: 2,
      }),
    ).toMatchObject({ phase: "active", activation: "disarmed", blockedReason: null });

    expect(
      commandEntries([
        { name: "goal", description: "Goal", input: { hint: "[objective]", attachments: true } },
        { name: "Bad Name", description: "x" },
        { name: "plan", description: "Plan" },
      ]),
    ).toEqual([
      { name: "goal", description: "Goal", hint: "[objective]", attachments: true },
      { name: "plan", description: "Plan", hint: null, attachments: false },
    ]);
    expect(
      permissionOptions({
        options: [
          { value: "read-only", name: "read-only" },
          { value: "" },
          { value: "x".repeat(200) },
        ],
      }),
    ).toEqual([{ value: "read-only", name: "read-only", description: null }]);
    expect(subagentEntry({ id: "child", createdAt: 5, mode: "spawned", label: "" })).toEqual({
      sessionId: "child",
      createdAt: 5,
      mode: "unknown",
      label: null,
    });
  });

  it("renames, archives and forks through DSH's own services", async () => {
    const f = await fixture();
    const features = () =>
      f.bridge.capabilities("ak-session-a", true).features as Record<
        string,
        { available: boolean }
      >;
    const row = () =>
      f.bridge.list(f.workspace).sessions.find((session) => session.native_ref === "session-a");
    await until(() => features().archive.available);
    expect(features().rename.available).toBe(true);
    expect(features().unarchive.available).toBe(false);

    expect(await f.control("rename", { name: "  Renamed in AgentKib " })).toMatchObject({
      accepted: true,
      controlOutcome: "accepted",
    });
    expect(f.dsh.sessions.get("session-a")!.title).toBe("Renamed in AgentKib");
    await until(() => row()?.title === "Renamed in AgentKib");
    expect(await f.control("rename", { name: "   " })).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "invalid-name",
    });

    expect(await f.control("archive")).toMatchObject({ accepted: true });
    expect(f.dsh.archived.has("session-a")).toBe(true);
    await until(() => row()?.archived === true);
    expect(features().archive.available).toBe(false);
    expect(features().unarchive.available).toBe(true);
    expect(await f.control("unarchive")).toMatchObject({ accepted: true });
    await until(() => row()?.archived === false);
    // An archive made in DSH's own window reaches AgentKib through the archive follow.
    f.dsh.archiveInDsh("session-a");
    await until(() => row()?.archived === true);

    // Clients open the copy from the receipt, so it is already listed when the reply comes.
    expect(await f.control("fork")).toMatchObject({
      accepted: true,
      completed: true,
      sessionId: "ak-session-a-fork",
    });
    expect(f.bridge.handles("ak-session-a-fork")).toBe(true);
    expect(f.bridge.live("ak-session-a", true).reason).not.toBe("control-outcome-unconfirmed");

    // While a turn runs, renaming and forking still work; archiving waits for the turn to end.
    await f.control("send", { text: "run the tests" });
    await until(() => f.bridge.live("ak-session-a", true).status === "running");
    expect(features().rename.available).toBe(true);
    expect(features().fork.available).toBe(true);
    expect(features().unarchive).toEqual({ available: false, reason: "session-busy" });
    // The native permission command can affect the current turn, so settings wait for idle.
    expect(features().settings).toEqual({ available: false, reason: "session-busy" });
    // Limits and selections remain readable.
    expect(
      (await f.bridge.request({
        operation: "settings-state",
        sessionId: "ak-session-a",
      })) as Record<string, unknown>,
    ).toMatchObject({
      available: true,
      writable: {
        model: { available: false, reason: "session-busy" },
        effort: { available: false, reason: "session-busy" },
        policy: { available: false, reason: "session-busy" },
      },
    });
    expect(await f.control("settings", { effort: "high" })).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "session-busy",
    });
  });

  it("lists DSH's models and switches the session's model and effort", async () => {
    const f = await fixture();
    const settings = () =>
      f.bridge.request({ operation: "settings-state", sessionId: "ak-session-a" }) as Promise<
        Record<string, any>
      >;
    await until(
      () =>
        (f.bridge.capabilities("ak-session-a", true).features as Record<string, any>)[
          "settings-state"
        ].available,
    );
    const state = await settings();
    expect(state).toMatchObject({
      available: true,
      current: { model: "deepseek/deepseek-chat", effort: null, policyId: "workspace-write" },
      writable: { model: { available: true }, effort: { available: true } },
    });
    // A provider with a slash keeps an unambiguous picker ID; each model names its provider, as
    // DSH's own model menu groups them.
    expect(state.models).toEqual([
      {
        id: "deepseek/deepseek-chat",
        name: "DeepSeek Chat",
        group: "DeepSeek",
        efforts: ["low", "high"],
        defaultEffort: "low",
      },
      { id: "mock%2Flocal/m-1", name: "Mock One", group: "Mock", efforts: [] },
    ]);

    // An effort change keeps the current model.
    f.publish.mockClear();
    const changed = await f.control("settings", { effort: "high" });
    expect(changed).toMatchObject({ accepted: true });
    expect(f.publish.mock.calls.filter(([, type]) => type === "invalidate")).toEqual([
      ["ak-session-a", "invalidate", { domains: ["settings"] }, changed.live],
    ]);
    expect(f.dsh.selections.at(-1)).toEqual({
      sessionId: "session-a",
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "high",
    });
    expect((await settings()).current).toEqual({
      model: "deepseek/deepseek-chat",
      effort: "high",
      policyId: "workspace-write",
      mode: "default",
    });
    expect(await f.control("settings", { effort: "extreme" })).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "invalid-effort",
    });
    // A new model starts at its own default effort.
    expect(await f.control("settings", { model: "mock%2Flocal/m-1" })).toMatchObject({
      accepted: true,
    });
    expect(f.dsh.selections.at(-1)).toEqual({
      sessionId: "session-a",
      provider: "mock/local",
      model: "m-1",
    });
    // Read back from DSH's own selection, as its model picker shows it.
    expect((await settings()).current).toEqual({
      model: "mock%2Flocal/m-1",
      effort: null,
      policyId: "workspace-write",
      mode: "default",
    });
    expect(await settings()).toMatchObject({
      defaults: { model: "deepseek/deepseek-chat", effort: null },
    });
    expect(await f.control("settings", { model: "nobody/none" })).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "invalid-model",
    });
    // Restoring defaults selects DSH's default model at its default effort.
    await settings();
    expect(await f.control("settings", { resetDefaults: true })).toMatchObject({
      accepted: true,
    });
    expect(f.dsh.selections.at(-1)).toEqual({
      sessionId: "session-a",
      provider: "deepseek",
      model: "deepseek-chat",
    });
  });

  it("keeps models readable and blocks unsafe writes without scoped model selection", async () => {
    const f = await fixture({ supportsCreateModelSelection: false });
    const state = await f.bridge.request({
      operation: "settings-state",
      sessionId: "ak-session-a",
    });
    expect(state).toMatchObject({
      available: true,
      current: { model: "deepseek/deepseek-chat", effort: null },
      writable: {
        model: { available: false },
        effort: { available: false },
        policy: { available: true },
      },
    });
    expect(await f.control("settings", { effort: "high" })).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "operation-unavailable",
    });
    expect(
      await f.control("settings", { model: "deepseek/deepseek-chat", policyId: "read-only" }),
    ).toMatchObject({ accepted: true });
    expect(f.dsh.selections).toEqual([]);
  });

  it("reconciles a lost DSH model settings reply without invalidating history", async () => {
    const f = await fixture();
    await until(
      () =>
        (f.bridge.capabilities("ak-session-a", true).features as Record<string, any>)[
          "settings-state"
        ].available,
    );
    await f.bridge.request({ operation: "settings-state", sessionId: "ak-session-a" });
    const controller = f.dsh.ctx.sessionController;
    const projections = controller.projections.bind(controller);
    let dropReply = true;
    controller.projections = (request: unknown) => {
      if (dropReply && f.dsh.selections.length > 0) {
        dropReply = false;
        return new Promise(() => undefined);
      }
      return projections(request);
    };
    f.publish.mockClear();
    const result = await f.control("settings", { effort: "high" });
    expect(result).toMatchObject({ accepted: false, controlOutcome: "unknown" });

    const receipt = () =>
      readControlReceipt(f.bridge.options.dataDir, {
        requestId: result.requestId,
        deviceId: "device-1",
      });
    await vi.waitFor(
      async () => {
        await f.bridge.request({
          operation: "reconcile",
          sessionId: "ak-session-a",
          experimentalEnabled: true,
        });
        expect(receipt()).toMatchObject({ found: true, status: "accepted" });
      },
      { timeout: 2000 },
    );
    expect(f.dsh.selections).toHaveLength(1);
    expect(f.bridge.live("ak-session-a", true).reason).not.toBe("control-outcome-unconfirmed");
    expect(
      f.publish.mock.calls
        .filter(([id, type]) => id === "ak-session-a" && type === "invalidate")
        .flatMap(([, , payload]) => payload.domains),
    ).toEqual(["settings", "receipts"]);
  });

  it("starts a new DSH session in a registered workspace, once per request", async () => {
    const f = await fixture();
    // The new-task form offers DSH's Agent presets; a shipped one has no name of its own.
    expect(await f.bridge.createOptions()).toEqual({
      available: true,
      nativeGoals: true,
      agentPresets: [
        { id: "standard", name: null, description: null, isDefault: true, broken: null },
        { id: "ptc", name: null, description: null, isDefault: false, broken: null },
        {
          id: "mine",
          name: "My preset",
          description: "Written by the user",
          isDefault: false,
          broken: null,
        },
        { id: "broken", name: null, description: null, isDefault: false, broken: "plugin missing" },
      ],
    });
    const request = {
      operation: "create",
      requestId: randomUUID(),
      deviceId: "device-1",
      workspaceId: "workspace",
    };
    const created = await f.bridge.create(request);
    expect(created).toMatchObject({
      accepted: true,
      completed: true,
      controlOutcome: "accepted",
      sessionId: expect.stringMatching(/^ak-session-[0-9a-f-]{36}$/),
    });
    const sessionId = String(created.sessionId);
    // The client opens it from the reply, so it is already listed and not left unconfirmed.
    expect(f.bridge.handles(sessionId)).toBe(true);
    expect(f.bridge.live(sessionId, true).reason).not.toBe("control-outcome-unconfirmed");
    // The receipt names the new session, so a client that lost the reply can still open it.
    expect(
      readControlReceipt(f.bridge.options.dataDir, {
        requestId: request.requestId,
        deviceId: "device-1",
      }),
    ).toMatchObject({ operation: "create", status: "accepted", sessionId });
    // The same request returns its stored outcome instead of starting another session.
    expect(await f.bridge.create(request)).toMatchObject({ sessionId });
    expect(f.dsh.sessions.size).toBe(2);
    expect(
      await f.bridge.create({ ...request, requestId: randomUUID(), workspaceId: "elsewhere" }),
    ).toMatchObject({ controlOutcome: "not-dispatched", reason: "workspace-unavailable" });
    // With a second DSH running, AgentKib cannot tell which one the person means.
    const second = createBridge(f.dsh.ctx, {
      roots: [f.agentkibHome],
      dshVersion: "0.2.1-rc.5",
      discoveryMs: 50,
      debounceMs: 10,
    });
    cleanups.push(() => second.close());
    for (let tries = 0; (await f.bridge.createOptions()).available && tries < 250; tries++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await f.bridge.createOptions()).toEqual({
      available: false,
      reason: "dsh-create-ambiguous",
    });
    expect(await f.bridge.create({ ...request, requestId: randomUUID() })).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "dsh-create-ambiguous",
    });
    expect(f.dsh.sessions.size).toBe(2);
  });

  it("settles a create whose reply was lost once its session is listed", async () => {
    const f = await fixture();
    const controller = f.dsh.ctx.sessionController;
    const original = controller.create.bind(controller);
    // DSH makes the session, but the reply never comes back.
    controller.create = (request: any) => {
      void original(request);
      return new Promise(() => undefined);
    };
    const request = { requestId: randomUUID(), deviceId: "device-1", workspaceId: "workspace" };
    expect(await f.bridge.create(request)).toMatchObject({ controlOutcome: "unknown" });
    // Read from the ledger alone, so only the bridge's own reconciliation can settle it.
    const stored = () =>
      readControlReceipt(f.bridge.options.dataDir, {
        requestId: request.requestId,
        deviceId: "device-1",
      });
    const sessionId = String(stored().sessionId);
    await until(() => f.bridge.handles(sessionId));
    await until(() => stored().status === "accepted");
    expect(f.dsh.sessions.has(String(f.bridge.nativeId(sessionId)))).toBe(true);
    // The new session is not left waiting on the create that made it, and nothing was resent.
    expect(f.bridge.live(sessionId, true).reason).not.toBe("control-outcome-unconfirmed");
    expect(f.dsh.sessions.size).toBe(2);
  });

  it("reads new-session models without creating a session and records the chosen route before sending", async () => {
    const f = await fixture();
    const projections = vi.spyOn(f.dsh.ctx.sessionController, "projections");
    const options = await f.bridge.createOptions(true);
    expect(options).toMatchObject({
      available: true,
      defaults: { model: "deepseek/deepseek-chat", effort: null },
      models: [
        {
          id: "deepseek/deepseek-chat",
          group: "DeepSeek",
          efforts: ["low", "high"],
          defaultEffort: "low",
        },
        { id: "mock%2Flocal/m-1", group: "Mock", efforts: [] },
      ],
    });
    expect(projections).not.toHaveBeenCalled();
    expect(f.dsh.creations).toHaveLength(0);

    const request = {
      requestId: randomUUID(),
      deviceId: "device-1",
      workspaceId: "workspace",
      agentPreset: "ptc",
      model: "deepseek/deepseek-chat",
      effort: "high",
    };
    const created = await f.bridge.create(request);
    expect(created).toMatchObject({ accepted: true, controlOutcome: "accepted" });
    const sessionId = String(created.sessionId);
    const nativeId = String(f.bridge.nativeId(sessionId));
    expect(f.dsh.creations).toEqual([
      { sessionId: nativeId, cwd: f.workspace, agentPreset: "ptc" },
    ]);
    expect(f.dsh.ctx.llm.resolveCallConfig).toHaveBeenCalledWith({
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "high",
    });
    expect(f.dsh.selections).toEqual([
      {
        sessionId: nativeId,
        provider: "deepseek",
        model: "deepseek-chat",
        reasoningEffort: "high",
      },
    ]);
    expect(f.dsh.prompts).toEqual([]);
    expect(
      await f.control("send", {
        sessionId,
        expectedRevision: f.bridge.live(sessionId, true).revision,
        text: "Use the configured model",
      }),
    ).toMatchObject({ accepted: true });
    expect(f.dsh.sessions.get(nativeId)?.events.slice(0, 3)).toMatchObject([
      {
        type: "model/selection",
        data: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" },
      },
      { type: "turn/start" },
      { type: "user/message" },
    ]);
    expect(await f.bridge.create(request)).toMatchObject({ sessionId });
    expect(f.dsh.creations).toHaveLength(1);
  });

  it("reads the native create permission choices and confirms the chosen policy before the first prompt", async () => {
    const f = await fixture();
    const projections = vi.spyOn(f.dsh.ctx.sessionController, "projections");
    expect(await f.bridge.createOptions(true)).toMatchObject({
      available: true,
      policies: [
        { id: "read-only", name: expect.any(String) },
        { id: "workspace-write", name: expect.any(String) },
        { id: "danger-full-access", name: expect.any(String) },
      ],
      defaults: { model: "deepseek/deepseek-chat", policyId: "workspace-write" },
    });
    expect(projections).not.toHaveBeenCalled();
    expect(f.dsh.creations).toEqual([]);
    const request = {
      requestId: randomUUID(),
      deviceId: "device-1",
      workspaceId: "workspace",
      agentPreset: "ptc",
      model: "mock%2Flocal/m-1",
      policyId: "read-only",
    };
    const created = await f.bridge.create(request);
    expect(created).toMatchObject({ controlOutcome: "accepted", policyId: "read-only" });
    const sessionId = String(created.sessionId);
    const nativeId = String(f.bridge.nativeId(sessionId));
    expect(f.dsh.creations).toEqual([
      { sessionId: nativeId, cwd: f.workspace, agentPreset: "ptc" },
    ]);
    expect(f.dsh.permissionOf.get(nativeId)).toBe("read-only");
    expect(f.dsh.sessions.get(nativeId)?.selection).toEqual({
      provider: "mock/local",
      model: "m-1",
    });
    expect(projections).toHaveBeenCalledWith({ sessionId: nativeId }, expect.any(AbortSignal));
    expect(f.dsh.prompts).toEqual([]);
    await expect(
      f.control("send", {
        sessionId,
        expectedRevision: f.bridge.live(sessionId, true).revision,
        text: "use the confirmed policy",
      }),
    ).resolves.toMatchObject({ accepted: true });
    const events = f.dsh.sessions.get(nativeId)!.events;
    expect(events.findIndex((event) => event.type === "permission/preset")).toBeLessThan(
      events.findIndex((event) => event.type === "user/message"),
    );
    expect(await f.bridge.create(request)).toEqual(created);
    expect(f.dsh.creations).toHaveLength(1);
    expect(f.dsh.executed).toEqual(["/permission read-only"]);
  });

  it("never accepts a listed blank DSH session when policy readback does not match", async () => {
    const f = await fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // The native command acknowledges the change without recording it.
    const commands = f.dsh.ctx.commands;
    vi.spyOn(commands, "execute").mockImplementation(async () => {
      await held;
      return { commandId: "ignored", result: { kind: "success" } };
    });
    const request = {
      requestId: randomUUID(),
      deviceId: "device-1",
      workspaceId: "workspace",
      policyId: "read-only",
    };
    const pending = f.bridge.create(request);
    try {
      const nativeId = await until(() => f.dsh.creations[0]?.sessionId as string | undefined);
      const sessionId = `ak-${nativeId}`;
      await until(() => f.bridge.handles(sessionId));
      expect(f.bridge.live(sessionId, true).sendEnabled).toBe(false);
      await expect(
        f.control("send", {
          sessionId,
          expectedRevision: f.bridge.live(sessionId, true).revision,
          text: "must keep this draft",
        }),
      ).resolves.toMatchObject({ controlOutcome: "not-dispatched" });
    } finally {
      release();
    }
    expect(await pending).toMatchObject({ controlOutcome: "unknown" });
    const stored = () =>
      f.bridge.receipt(
        readControlReceipt(f.bridge.options.dataDir, {
          requestId: request.requestId,
          deviceId: request.deviceId,
        }),
      ) as Record<string, unknown>;
    expect(stored().status).not.toBe("accepted");
    await until(() => stored().status === "not-dispatched");
    expect(stored().ack).toMatchObject({ reason: "dsh-create-permission-not-applied" });
    expect(await f.bridge.create(request)).toMatchObject({ controlOutcome: "not-dispatched" });
    expect(f.dsh.creations).toHaveLength(1);
    expect(f.dsh.prompts).toEqual([]);
  });

  it("reconciles a lost permission create reply without running the setter or allocating again", async () => {
    const f = await fixture();
    const sendRequest = dshClient.post;
    const transport = vi.spyOn(dshClient, "post").mockImplementation((...args) => {
      const [, route, body] = args;
      if (route === DSH_BRIDGE_PATHS.result && body?.value?.policyId === "read-only")
        return Promise.reject(new Error("test lost create acknowledgement"));
      return sendRequest(...args);
    });
    try {
      const request = {
        requestId: randomUUID(),
        deviceId: "device-1",
        workspaceId: "workspace",
        policyId: "read-only",
        model: "mock%2Flocal/m-1",
      };
      expect(await f.bridge.create(request)).toMatchObject({ controlOutcome: "unknown" });
      const stored = () =>
        readControlReceipt(f.bridge.options.dataDir, {
          requestId: request.requestId,
          deviceId: request.deviceId,
        });
      await until(() => stored().status === "accepted");
      expect(stored().ack).toMatchObject({ policyId: "read-only" });
      expect(await f.bridge.create(request)).toMatchObject({ controlOutcome: "accepted" });
      expect(f.dsh.creations).toHaveLength(1);
      expect(f.dsh.executed).toEqual(["/permission read-only"]);
      expect(f.dsh.selections).toHaveLength(1);
      expect(f.dsh.prompts).toEqual([]);
    } finally {
      transport.mockRestore();
    }
  });

  it("preserves default creation when the plugin has no verified create policy service", async () => {
    const sendRequest = dshClient.post;
    const transport = vi.spyOn(dshClient, "post").mockImplementation((...args) => {
      const [socketPath, route, body, options] = args;
      if (route !== DSH_BRIDGE_PATHS.register && route !== DSH_BRIDGE_PATHS.report)
        return sendRequest(...args);
      const { createPermissionPreset: _createPermissionPreset, ...services } = body.services;
      return sendRequest(socketPath, route, { ...body, services }, options);
    });
    try {
      const f = await fixture();
      expect(await f.bridge.createOptions(true)).not.toHaveProperty("policies");
      const request = { deviceId: "device-1", workspaceId: "workspace" };
      await expect(
        f.bridge.create({ ...request, requestId: randomUUID(), policyId: "read-only" }),
      ).resolves.toMatchObject({
        controlOutcome: "not-dispatched",
        reason: "dsh-create-permission-selection-unsupported",
      });
      expect(f.dsh.creations).toEqual([]);
      expect(f.dsh.executed).toEqual([]);
      await expect(f.bridge.create({ ...request, requestId: randomUUID() })).resolves.toMatchObject(
        {
          controlOutcome: "accepted",
        },
      );
    } finally {
      transport.mockRestore();
    }
  });

  it("rejects a DSH create permission preset absent from the native catalog before allocating", async () => {
    const f = await fixture();
    await expect(
      f.bridge.create({
        requestId: randomUUID(),
        deviceId: "device-1",
        workspaceId: "workspace",
        policyId: "unknown-preset",
      }),
    ).resolves.toMatchObject({ controlOutcome: "not-dispatched", reason: "invalid-policy" });
    expect(f.dsh.creations).toEqual([]);
    expect(f.dsh.executed).toEqual([]);
    expect(f.dsh.prompts).toEqual([]);
  });

  it("rejects unavailable models and effort levels before creating the session", async () => {
    const f = await fixture();
    const request = { deviceId: "device-1", workspaceId: "workspace" };
    expect(
      await f.bridge.create({
        ...request,
        requestId: randomUUID(),
        model: "no/such-model",
      }),
    ).toMatchObject({ controlOutcome: "not-dispatched", reason: "unsupported-model" });
    expect(
      await f.bridge.create({
        ...request,
        requestId: randomUUID(),
        model: "mock%2Flocal/m-1",
        effort: "high",
      }),
    ).toMatchObject({ controlOutcome: "not-dispatched", reason: "unsupported-effort" });
    expect(f.dsh.creations).toEqual([]);
  });

  it("preserves default creation when the plugin cannot set a new session's model", async () => {
    const f = await fixture({ supportsCreateModelSelection: false });
    const options = await f.bridge.createOptions(true);
    expect(options).toMatchObject({ available: true, agentPresets: expect.any(Array) });
    expect(options).not.toHaveProperty("models");
    const request = { deviceId: "device-1", workspaceId: "workspace" };
    expect(
      await f.bridge.create({
        ...request,
        requestId: randomUUID(),
        model: "deepseek/deepseek-chat",
      }),
    ).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "dsh-create-model-selection-unsupported",
    });
    expect(f.dsh.creations).toEqual([]);
    expect(await f.bridge.create({ ...request, requestId: randomUUID() })).toMatchObject({
      controlOutcome: "accepted",
    });
  });

  it("requires the recorded model to reconcile a new session whose reply was lost", async () => {
    const f = await fixture();
    const controller = f.dsh.ctx.sessionController;
    const original = controller.projections.bind(controller);
    let missed = false;
    controller.projections = (request: { sessionId: string }) => {
      if (request.sessionId !== "session-a" && !missed) {
        missed = true;
        return new Promise(() => undefined);
      }
      return original(request);
    };
    const request = {
      requestId: randomUUID(),
      deviceId: "device-1",
      workspaceId: "workspace",
      model: "mock%2Flocal/m-1",
    };
    expect(await f.bridge.create(request)).toMatchObject({ controlOutcome: "unknown" });
    const stored = () =>
      readControlReceipt(f.bridge.options.dataDir, {
        requestId: request.requestId,
        deviceId: request.deviceId,
      });
    await until(() => stored().status === "accepted");
    const nativeId = String(f.bridge.nativeId(String(stored().sessionId)));
    expect(f.dsh.sessions.get(nativeId)?.selection).toEqual({
      provider: "mock/local",
      model: "m-1",
    });
    expect(f.dsh.creations).toHaveLength(1);
  });

  it("never accepts a listed blank session with an unconfirmed starting model", async () => {
    const f = await fixture();
    const controller = f.dsh.ctx.sessionController;
    const original = controller.create.bind(controller);
    controller.create = async (request: { sessionId: string }) => {
      const result = await original(request);
      f.dsh.sessions.get(request.sessionId)!.agent.model.select = () => {
        throw new Error("selection refused");
      };
      return result;
    };
    const request = {
      requestId: randomUUID(),
      deviceId: "device-1",
      workspaceId: "workspace",
      model: "deepseek/deepseek-chat",
      effort: "high",
    };
    expect(await f.bridge.create(request)).toMatchObject({ controlOutcome: "unknown" });
    const stored = () =>
      f.bridge.receipt(
        readControlReceipt(f.bridge.options.dataDir, {
          requestId: request.requestId,
          deviceId: request.deviceId,
        }),
      ) as Record<string, unknown>;
    const sessionId = String(stored().sessionId);
    expect(f.bridge.handles(sessionId)).toBe(true);
    expect(stored().status).not.toBe("accepted");
    await until(() => stored().status === "not-dispatched");
    expect(stored().ack).toMatchObject({ reason: "dsh-create-model-not-applied" });
    expect(f.dsh.creations).toHaveLength(1);
    expect(f.dsh.prompts).toEqual([]);
  });

  it("settles a lost create DSH never made once DSH has listed its sessions since", async () => {
    const f = await fixture();
    f.dsh.ctx.sessionController.create = () => new Promise(() => undefined);
    const request = { requestId: randomUUID(), deviceId: "device-1", workspaceId: "workspace" };
    expect(await f.bridge.create(request)).toMatchObject({ controlOutcome: "unknown" });
    const receipt = () =>
      f.bridge.receipt(
        readControlReceipt(f.bridge.options.dataDir, {
          requestId: request.requestId,
          deviceId: "device-1",
        }),
      ) as Record<string, unknown>;
    // Overdue, but DSH has not told AgentKib its sessions since: it may still be listed.
    expect(receipt()).toMatchObject({ status: "unknown" });
    f.dsh.create("session-b", "Another DSH session");
    await until(() => receipt().status === "not-dispatched");
    expect(receipt().ack).toMatchObject({ reason: "dsh-session-not-created" });
  });
});

async function eventually<T>(read: () => Promise<T | undefined | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("DeepSeek Harness goals, commands, presets and subagents", () => {
  const features = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.bridge.capabilities("ak-session-a", true).features as Record<string, any>;

  it("reads and changes the session's goal through DSH's goal service", async () => {
    const f = await fixture();
    const goal = () =>
      f.bridge.request({ operation: "goal", sessionId: "ak-session-a" }) as Promise<
        Record<string, any>
      >;
    // Each goal change reaches AgentKib as a goal invalidation; the next change names its result.
    const notices = () =>
      f.publish.mock.calls.filter(
        ([id, type, payload]) =>
          id === "ak-session-a" && type === "invalidate" && payload.domains.includes("goal"),
      ).length;
    const reported = async (step: Promise<Record<string, any>>) => {
      const before = notices();
      const result = await step;
      if (result.accepted) await until(() => notices() > before);
      return result;
    };
    await until(() => features(f).goal.available);
    const empty = await goal();
    expect(empty).toMatchObject({
      available: true,
      budget: "rounds",
      actions: {
        set: { available: true },
        pause: { available: false, reason: "goal-action-unavailable" },
        clear: { available: false, reason: "goal-action-unavailable" },
      },
    });
    expect(empty.goal).toBeUndefined();
    // DSH bounds a goal by rounds; a token budget is refused before anything reaches DSH.
    expect(
      await f.control("goal-set", {
        goal: { objective: "Ship it", intent: "start", tokenBudget: 1000 },
      }),
    ).toMatchObject({ controlOutcome: "not-dispatched", reason: "goal-token-budget-unavailable" });
    expect(f.dsh.goals.size).toBe(0);

    expect(
      await reported(
        f.control("goal-set", { goal: { objective: " Ship the release ", intent: "start" } }),
      ),
    ).toMatchObject({ accepted: true });
    expect(await goal()).toMatchObject({
      goal: { objective: "Ship the release", status: "active", rounds: { used: 0, limit: 256 } },
      actions: {
        pause: { available: true },
        resume: { available: false, reason: "goal-action-unavailable" },
        clear: { available: true },
      },
    });
    expect(await reported(f.control("goal-pause"))).toMatchObject({ accepted: true });
    expect(await goal()).toMatchObject({
      goal: { status: "paused" },
      actions: { resume: { available: true } },
    });
    expect(await reported(f.control("goal-resume"))).toMatchObject({ accepted: true });
    // A goal that exists is edited, as DSH's own `/goal edit` does.
    expect(
      await reported(f.control("goal-set", { goal: { objective: "Ship 1.0", intent: "update" } })),
    ).toMatchObject({ accepted: true });
    expect(f.dsh.goals.get("session-a")).toMatchObject({ objective: "Ship 1.0", revision: 4 });

    // A session DSH resumed keeps its goal active but does not continue it by itself.
    f.dsh.disarmGoal("session-a");
    expect(
      await eventually(async () => {
        const value = await goal();
        return value.goal?.status === "paused" && value.actions.resume.available === true;
      }),
    ).toBe(true);

    // A goal changed in DSH's window changes what AgentKib decides on; an older control is stale.
    const before = f.bridge.live("ak-session-a", true).revision;
    const stale = { ...f.lastBody(), operation: "goal-clear", expectedRevision: before };
    f.dsh.editGoalInDsh("session-a", "Ship 1.1");
    await until(() => f.bridge.live("ak-session-a", true).revision !== before);
    expect(await f.bridge.request({ ...stale, requestId: randomUUID() })).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "stale-dsh-revision",
    });
    expect(f.dsh.goals.has("session-a")).toBe(true);
    expect(await reported(f.control("goal-clear"))).toMatchObject({ accepted: true });
    expect(f.dsh.goals.has("session-a")).toBe(false);
    expect(await f.control("goal-pause")).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "goal-changed",
    });
  });

  it("runs a message naming one of DSH's slash commands as that command", async () => {
    const f = await fixture();
    // The running agent's own list: DSH's window lists a session's commands this way.
    await until(
      () => (f.bridge.capabilities("ak-session-a", true).commands as unknown[])?.length === 5,
    );
    expect(f.bridge.capabilities("ak-session-a", true).commands).toEqual([
      { name: "compact", description: "Compact older conversation history" },
      { name: "export", description: "Download this Session log as a ZIP archive" },
      {
        name: "goal",
        description: "Set or view the goal for a long-running task",
        argumentHint: "[<objective>|clear|edit <objective>|pause|resume]",
      },
      {
        name: "permission",
        description: "Switch the permission preset (sandbox mode + approval policy)",
        argumentHint: "<preset>",
      },
      { name: "plan", description: "Enter or leave plan mode", argumentHint: "[off|message]" },
    ]);

    expect(await f.control("send", { text: "/plan" })).toMatchObject({ accepted: true });
    expect(f.dsh.executed).toEqual(["/plan"]);
    expect(f.dsh.prompts).toEqual([]);
    // The history shows the command as typed, and DSH's answer as text DSH wrote itself.
    const page = await f.bridge.events("session-a", null, 50);
    expect(page.events.map((event) => [event.kind, event.content, !!event.cli_output])).toEqual([
      ["user-message", "/plan", false],
      ["agent-message", "Plan mode on. Use /plan off to leave.", true],
    ]);

    // `/export` downloads a file in DSH's own window; commands take no attachments.
    expect(await f.control("send", { text: "/export" })).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "dsh-command-window-only",
    });
    expect(
      await f.control("send", {
        input: [
          { type: "text", text: "/plan check the logs" },
          { type: "text", text: 'User attached file "a.txt": /tmp/a.txt' },
        ],
      }),
    ).toMatchObject({ controlOutcome: "not-dispatched", reason: "dsh-command-attachments" });
    // `/goal` changes the session's goal: only a device with full access may run it.
    expect(await f.control("send", { text: "/goal ship it" })).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "dsh-command-full-access",
    });
    expect(f.dsh.executed).toEqual(["/plan"]);
    expect(await f.control("send", { text: "/goal ship it", commandAccess: "all" })).toMatchObject({
      accepted: true,
    });
    expect(f.dsh.executed).toEqual(["/plan", "/goal ship it"]);

    // A path, or a name DSH does not know, stays a message for the model.
    expect(await f.control("send", { text: "/private/tmp holds the logs" })).toMatchObject({
      accepted: true,
    });
    expect(f.dsh.prompts.at(-1).content).toEqual([
      { type: "text", text: "/private/tmp holds the logs" },
    ]);
    // While the turn runs, a command still runs at once, as in DSH's window.
    await until(() => f.bridge.live("ak-session-a", true).status === "running");
    const live = f.bridge.live("ak-session-a", true);
    expect(await f.control("steer", { text: "/plan off", turnId: live.turnId })).toMatchObject({
      accepted: true,
    });
    expect(f.dsh.executed).toEqual(["/plan", "/goal ship it", "/plan off"]);
    expect(f.dsh.prompts).toHaveLength(1);
  });

  it("offers a session without a running agent the commands its siblings have", async () => {
    const f = await fixture();
    await until(
      () => (f.bridge.capabilities("ak-session-a", true).commands as unknown[])?.length === 5,
    );
    // DSH's agent for session-a goes away; DSH lists the session's own commands once it resumes.
    const agent = f.dsh.sessions.get("session-a")!.agent;
    f.dsh.create("session-b", "Second DSH session");
    await until(() => f.bridge.handles("ak-session-b"));
    f.dsh.emit("agent/disposed", { agent });
    f.dsh.ctx.agents.get = (id: string) =>
      id === "session-a" ? undefined : f.dsh.sessions.get(id)?.agent;
    f.dsh.ctx.agents.list = () => [f.dsh.sessions.get("session-b")!.agent];
    await until(
      () =>
        (f.bridge.capabilities("ak-session-b", true).commands as { name: string }[])?.length === 5,
    );
    // session-a keeps the menu of a running sibling, and so `/compact` stays offered.
    await f.plugin.run({ type: "refresh" });
    expect(
      (f.bridge.capabilities("ak-session-a", true).commands as { name: string }[]).map(
        (entry) => entry.name,
      ),
    ).toEqual(["compact", "export", "goal", "permission", "plan"]);
  });

  it("compacts with DSH's own /compact and holds messages while it runs", async () => {
    const f = await fixture();
    await until(() => features(f).compact.available);
    const release = f.dsh.holdCompaction();
    // The plugin answers once DSH has run the command a while; the compaction goes on.
    expect(await f.control("compact")).toMatchObject({ accepted: true });
    await until(() => f.bridge.live("ak-session-a", true).activity === "compacting");
    expect(f.bridge.live("ak-session-a", true)).toMatchObject({
      sendEnabled: false,
      reason: "session-compacting",
    });
    expect(features(f).compact).toEqual({ available: false, reason: "session-compacting" });
    expect(await f.control("send", { text: "after the compaction" })).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "session-busy",
    });
    release();
    await until(() => f.bridge.live("ak-session-a", true).sendEnabled === true);
    expect(f.bridge.live("ak-session-a", true).activity).toBeNull();
    const page = await f.bridge.events("session-a", null, 50);
    expect(page.events.map((event) => event.content)).toEqual([
      "/compact",
      "Compacted 4 history items (~120 tokens).",
    ]);
    // A running turn keeps its context; the compaction waits for the turn to end.
    await f.control("send", { text: "run the tests" });
    await until(() => f.bridge.live("ak-session-a", true).status === "running");
    expect(features(f).compact).toEqual({ available: false, reason: "session-busy" });
  });

  it("shows DSH's plan mode as Codex's collaboration mode and switches it with /plan", async () => {
    const f = await fixture();
    const settings = () =>
      f.bridge.request({ operation: "settings-state", sessionId: "ak-session-a" }) as Promise<
        Record<string, any>
      >;
    await until(() => features(f).settings.available);
    // The running agent's own `/plan` is what switches it.
    await until(() =>
      ((f.bridge.capabilities("ak-session-a", true).commands as { name: string }[]) ?? []).some(
        (entry) => entry.name === "plan",
      ),
    );
    expect(await settings()).toMatchObject({
      current: { mode: "default" },
      collaborationModes: [{ id: "default" }, { id: "plan" }],
      writable: { mode: { available: true } },
    });
    f.publish.mockClear();
    expect(await f.control("settings", { mode: "plan" })).toMatchObject({ accepted: true });
    expect(f.dsh.executed.at(-1)).toBe("/plan");
    await until(() =>
      f.publish.mock.calls.some(
        ([id, type, payload]) =>
          id === "ak-session-a" && type === "invalidate" && payload.domains.includes("history"),
      ),
    );
    // A switch counts at once, as DSH's chip shows it, though DSH applies it at the next step.
    expect(f.dsh.planOf.get("session-a")).toEqual({ active: false, pending: true });
    expect((await settings()).current.mode).toBe("plan");
    expect(await f.control("settings", { mode: "default" })).toMatchObject({ accepted: true });
    expect(f.dsh.executed.at(-1)).toBe("/plan off");
    expect((await settings()).current.mode).toBe("default");
    // A plan switch goes alone, as DSH's own chip and `/plan` make it.
    expect(await f.control("settings", { mode: "plan", policyId: "read-only" })).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "invalid-settings",
    });
    expect(f.dsh.executed.at(-1)).toBe("/plan off");
  });

  it("switches the permission preset with DSH's own /permission", async () => {
    const f = await fixture();
    const settings = () =>
      f.bridge.request({ operation: "settings-state", sessionId: "ak-session-a" }) as Promise<
        Record<string, any>
      >;
    await until(() => features(f).settings.available);
    const state = await settings();
    // DSH names its built-in presets by key; AgentKib words them as it words Codex's policies.
    expect(state.policies).toEqual([
      {
        id: "read-only",
        name: "Read only · ask when needed",
        description: "Can read the workspace; changes and other actions require user approval.",
      },
      {
        id: "workspace-write",
        name: "Workspace write · ask when needed",
        description:
          "Can write inside the workspace and permitted temporary directories; wider access requires user approval.",
      },
      {
        id: "danger-full-access",
        name: "Full access · no approval prompts",
        description: "Can access all files and run commands without prompting for approvals.",
      },
    ]);
    expect(state).toMatchObject({
      current: { policyId: "workspace-write" },
      writable: { policy: { available: true } },
    });
    // The settings dialog sends the model it shows along with the new preset.
    const { model, effort } = state.current;
    expect(
      await f.control("settings", { model, effort: effort ?? undefined, policyId: "read-only" }),
    ).toMatchObject({ accepted: true });
    expect(f.dsh.executed).toEqual(["/permission read-only"]);
    expect(f.dsh.selections).toEqual([]);
    await until(() =>
      f.publish.mock.calls.some(
        ([id, type, payload]) =>
          id === "ak-session-a" && type === "invalidate" && payload.domains.includes("settings"),
      ),
    );
    expect((await settings()).current.policyId).toBe("read-only");
    // DSH's own window leaves preset switches out of the conversation, and so does AgentKib,
    // also for one typed as `/permission`.
    expect(
      await f.control("send", { text: "/permission workspace-write", commandAccess: "all" }),
    ).toMatchObject({ accepted: true });
    expect(f.dsh.permissionOf.get("session-a")).toBe("workspace-write");
    expect((await f.bridge.events("session-a", null, 50)).events).toEqual([]);
    // One that failed stays: the conversation is the only place its reason shows.
    expect(
      await f.control("send", { text: "/permission root", commandAccess: "all" }),
    ).toMatchObject({ accepted: true });
    expect(await f.control("send", { text: "/plan" })).toMatchObject({ accepted: true });
    expect(
      (await f.bridge.events("session-a", null, 50)).events.map((event) => event.content),
    ).toEqual([
      "/permission root",
      'unknown preset "root"',
      "/plan",
      "Plan mode on. Use /plan off to leave.",
    ]);
    expect(await f.control("settings", { policyId: "root" })).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "invalid-policy",
    });

    // The native preset changes the next approval of the current turn.
    await f.control("send", { text: "run the tests" });
    await until(() => f.bridge.live("ak-session-a", true).status === "running");
    await settings();
    expect(await f.control("settings", { policyId: "danger-full-access" })).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "session-busy",
    });
    expect(f.dsh.permissionOf.get("session-a")).toBe("workspace-write");
    expect(
      await f.control("settings", { model: "mock%2Flocal/m-1", policyId: "workspace-write" }),
    ).toMatchObject({ controlOutcome: "not-dispatched", reason: "session-busy" });
    expect(f.dsh.permissionOf.get("session-a")).toBe("workspace-write");

    // Idle again: a new preset and a new model are two steps, preset first.
    f.dsh.finishTurn("session-a", "done");
    await until(() => f.bridge.live("ak-session-a", true).status === "idle");
    await settings();
    expect(
      await f.control("settings", { model: "mock%2Flocal/m-1", policyId: "read-only" }),
    ).toMatchObject({ accepted: true });
    expect(f.dsh.permissionOf.get("session-a")).toBe("read-only");
    expect(f.dsh.selections.at(-1)).toMatchObject({ provider: "mock/local", model: "m-1" });
  });

  it("lists a session's subagents and reads their history", async () => {
    const f = await fixture();
    f.dsh.spawnChild("session-a", "child-1", "Explore the repo", true);
    f.dsh.spawnChild("session-a", "child-2", "Run the tests", false);
    f.dsh.spawnChild("session-a", "child-3", "Watch the build");
    f.dsh.sessions.get("child-3")!.agent.status = "running";
    f.dsh.emit("agent/status", { agent: f.dsh.sessions.get("child-3")!.agent, status: "running" });
    f.dsh.append("child-1", "assistant/message", {
      turn: 1,
      step: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Found 3 packages." }] },
    });
    await until(() => f.bridge.handles("ak-child-3"));
    await until(() => features(f).send.available);
    const catalog = (await f.bridge.request({
      operation: "subagents",
      sessionId: "ak-session-a",
    })) as Record<string, any>;
    expect(catalog).toMatchObject({ version: 1, sessionId: "ak-session-a", truncated: false });
    expect(catalog.agents.map((agent: any) => [agent.name, agent.status])).toEqual([
      ["Explore the repo", "completed"],
      ["Run the tests", "stopped"],
      ["Watch the build", "running"],
    ]);
    for (const agent of catalog.agents)
      expect(agent).toMatchObject({
        id: expect.stringMatching(/^[a-f0-9]{64}$/),
        agent: "deepseek-harness",
        readable: true,
        updatedAt: "2023-11-14T22:13:20.000Z",
      });
    // Subagents stay out of the session list; DSH shows them read-only under their parent.
    expect(f.bridge.list(f.workspace).sessions.map((session) => session.native_ref)).not.toContain(
      "child-1",
    );

    const page = (await f.bridge.request({
      operation: "subagent-events",
      sessionId: "ak-session-a",
      subagentId: catalog.agents[0].id,
      cursor: null,
      limit: 50,
    })) as Record<string, any>;
    expect(page).toMatchObject({
      version: 1,
      sessionId: "ak-session-a",
      subagentId: catalog.agents[0].id,
      epoch: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(page.events.map((event: any) => event.content)).toEqual(["Found 3 packages."]);
    await expect(
      f.bridge.request({
        operation: "subagent-events",
        sessionId: "ak-session-a",
        subagentId: "0".repeat(64),
        limit: 50,
      }),
    ).rejects.toThrow("subagent-unavailable");
  });

  it("reads activities from the bound DSH plugin apart from the legacy directory cache", async () => {
    const { bridge, dsh } = await fixture();
    const sessionId = "ak-session-a";
    const scope = bridge.activitySubagentScope(sessionId);
    expect(scope).toBeDefined();
    const legacy = () =>
      bridge.request({ operation: "subagents", sessionId }) as Promise<SubagentCatalog>;
    expect((await legacy()).agents).toEqual([]);

    dsh.spawnChild("session-a", "native-child", "Check the build", true);
    dsh.append("native-child", "assistant/message", {
      turn: 1,
      step: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Build passed." }] },
    });
    await until(() => bridge.handles("ak-native-child"));
    await expect(bridge.activitySubagents(sessionId, "other-binding")).resolves.toBeUndefined();
    const catalog = await bridge.activitySubagents(sessionId, scope);
    const child = catalog?.agents[0];
    expect(child?.id).toMatch(/^[a-f0-9]{64}$/);
    expect(withSessionActivities(bridge.live(sessionId, true), catalog).activities).toEqual([
      {
        id: child?.id,
        childId: child?.id,
        kind: "subagent",
        title: "Check the build",
        status: "completed",
      },
    ]);
    expect((await legacy()).agents).toEqual([]);
    expect(
      await bridge.request({ operation: "subagent-events", sessionId, subagentId: child?.id }),
    ).toMatchObject({ events: [{ content: "Build passed." }] });
    vi.spyOn(dsh.ctx.sessionController, "projections").mockRejectedValueOnce(new Error("offline"));
    await expect(bridge.activitySubagents(sessionId, scope)).resolves.toBeUndefined();
  });

  it("rechecks a plugin child whose completion has no list change marker", async () => {
    const { bridge, dsh } = await fixture();
    const list = dsh.ctx.sessionController.list;
    vi.spyOn(dsh.ctx.sessionController, "list").mockImplementation(async () => ({
      items: (await list()).items.filter((item) => item.sessionId !== "unlisted-child"),
    }));
    dsh.spawnChild("session-a", "unlisted-child", "Independent check", false);
    const read = () => bridge.activitySubagents("ak-session-a");
    expect((await read())?.agents[0]?.status).toBe("stopped");
    const projections = dsh.ctx.sessionController.projections;
    vi.spyOn(dsh.ctx.sessionController, "projections").mockImplementation(async (request) => {
      const result = await projections(request);
      if (result && request.sessionId === "unlisted-child")
        result.values.subagentTiming = { settledMs: 5, lastTurnCompleted: true };
      return result;
    });
    expect((await read())?.agents[0]?.status).toBe("completed");
  });

  it("remembers the commands it ran, so a lost reply can be settled", async () => {
    const f = await fixture();
    const requestId = randomUUID();
    expect(
      await f.plugin.run({
        type: "command",
        sessionId: "session-a",
        requestId,
        line: "/plan",
      }),
    ).toMatchObject({ matched: true, running: false, ok: true });
    expect(await f.plugin.run({ type: "verify", sessionId: "session-a", requestId })).toMatchObject(
      { present: true, inFlight: false },
    );
    expect(
      await f.plugin.run({ type: "command", sessionId: "session-a", requestId, line: "/nope" }),
    ).toEqual({ matched: false });
    expect(await f.plugin.run({ type: "verify", sessionId: "session-a", requestId })).toMatchObject(
      { present: false },
    );
  });
});

describe("DeepSeek Harness documents, Agent presets and handoffs", () => {
  const source = {
    agent: "deepseek-harness" as const,
    workspace_id: "workspace",
    title: "First DSH session",
    created_at: null,
    updated_at: null,
    git_branch: null,
  };
  const message = (text: string, kind = "user") => ({
    role: "user",
    id: randomUUID(),
    content: [{ type: "text", text }],
    source: kind === "compact-checkpoint" ? { kind, compactionId: "c-1" } : { kind },
  });

  it("reads a whole session for a handoff, with what a compaction replaced", async () => {
    const f = await fixture();
    f.dsh.append("session-a", "user/message", message("Old question"));
    f.dsh.append("session-a", "assistant/message", {
      turn: 1,
      step: 0,
      message: {
        role: "assistant",
        content: [
          { type: "reasoning", text: "never leaves DSH" },
          { type: "text", text: "Old answer" },
          { type: "tool-call", id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' },
        ],
      },
    });
    f.dsh.append("session-a", "tool/result", {
      turn: 1,
      step: 0,
      message: { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "file a" }] },
    });
    // Injected context is not the conversation.
    f.dsh.append("session-a", "user/message", message("AGENTS.md says", "agents-md"));
    f.dsh.append("session-a", "assistant/message", {
      turn: 2,
      step: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Kept answer" }] },
    });
    f.dsh.append("session-a", "user/message", message("Earlier work", "compact-checkpoint"));
    f.dsh.append("session-a", "user/message", message("New question"));
    // As DSH 0.2.2-rc.1 compacts: the checkpoint replaces seq 0-3 in place, ahead of the reply
    // the compaction left.
    f.dsh.surfaces.set("session-a", [5, 4, 6]);
    expect(f.bridge.documentStatus("session-a")).toEqual({ status: "supported" });
    const { records, revision } = await f.bridge.conversation("session-a");
    expect(revision).toBe(6);
    expect(records.map((record) => [record.kind, record.position])).toEqual([
      ["user", null],
      ["assistant", null],
      ["tool-result", null],
      ["assistant", 1],
      ["summary", 0],
      ["user", 2],
    ]);
    const now = await f.bridge.document("session-a", source);
    expect(now.turns.map((turn) => turn.kind ?? turn.role)).toEqual([
      "context-summary",
      "assistant",
      "user",
    ]);
    expect(now.losses).toEqual([{ code: "compacted-history", count: 3 }]);
    const full = await f.bridge.document("session-a", source, {
      includePreCompactionHistory: true,
    });
    expect(full.turns.map((turn) => turn.kind ?? turn.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "compaction-boundary",
      "context-summary",
      "user",
    ]);
    expect(full.turns[1]!.blocks).toContainEqual({
      type: "tool-call",
      call_id: "call-1",
      name: "read_file",
      input: '{"path":"a.ts"}',
    });
    expect(full.losses).toEqual([{ code: "reasoning-excluded", count: 1 }]);
  });

  it("carries a message's images into the handoff document", async () => {
    const f = await fixture();
    const file = path.join(f.root, "shot.png");
    writeFileSync(file, PNG);
    const sha256 = createHash("sha256").update(PNG).digest("hex");
    await f.control("send", {
      input: [
        { type: "text", text: "what is this?" },
        {
          type: "image",
          path: file,
          sha256,
          size: PNG.length,
          mediaType: "image/png",
          name: "shot.png",
        },
      ],
    });
    const document = await f.bridge.document("session-a", source);
    expect(document.turns[0]!.blocks).toEqual([
      { type: "text", text: "what is this?" },
      {
        type: "attachment",
        kind: "image",
        media_type: "image/png",
        filename: "shot.png",
        inline_base64: PNG.toString("base64"),
      },
    ]);
    expect(document.losses).toEqual([]);
  });

  it("reads a long session in pages that end where the first one was read", async () => {
    const f = await fixture();
    // Each message is near the plugin's text bound, so the session takes more than one page.
    const long = "x".repeat(250 * 1024);
    for (let index = 0; index < 14; index++)
      f.dsh.append("session-a", "user/message", message(`${index} ${long}`));
    // A message that arrives between two pages is left for the next read.
    const surface = f.dsh.ctx.sessionQuery.readSurface;
    let pages = 0;
    f.dsh.ctx.sessionQuery.readSurface = async (id: string) => {
      if (++pages === 2) f.dsh.append("session-a", "user/message", message("late"));
      return surface(id);
    };
    const { records, revision } = await f.bridge.conversation("session-a");
    expect(pages).toBe(2);
    expect(revision).toBe(13);
    expect(records.map((record) => (record as { text: string }).text.split(" ")[0])).toEqual(
      Array.from({ length: 14 }, (_, index) => String(index)),
    );
  });

  it("says why a session cannot be read whole", async () => {
    const f = await fixture();
    expect(f.bridge.documentStatus("session-unknown")).toEqual({
      status: "unavailable",
      reason: "dsh-runtime-offline",
    });
    // A plugin that predates whole-session reads still lists the session.
    delete f.dsh.ctx.sessionQuery.readSurface;
    f.dsh.emit("agent/status", { agent: f.dsh.sessions.get("session-a")!.agent, status: "idle" });
    await until(() => f.bridge.documentStatus("session-a").status === "unavailable");
    expect(f.bridge.documentStatus("session-a")).toEqual({
      status: "unavailable",
      reason: "dsh-document-unavailable",
    });
    await expect(f.bridge.conversation("session-a")).rejects.toThrow("dsh-document-unavailable");
  });

  it("starts a session with the Agent preset chosen for it", async () => {
    const f = await fixture();
    const created = await f.bridge.create({
      operation: "create",
      requestId: randomUUID(),
      deviceId: "device-1",
      workspaceId: "workspace",
      agentPreset: "ptc",
    });
    expect(created).toMatchObject({ controlOutcome: "accepted" });
    expect(f.dsh.creations.at(-1)).toMatchObject({ agentPreset: "ptc" });
    // Without a choice DSH runs its default preset.
    await f.bridge.create({
      operation: "create",
      requestId: randomUUID(),
      deviceId: "device-1",
      workspaceId: "workspace",
    });
    expect(f.dsh.creations.at(-1)).not.toHaveProperty("agentPreset");
  });

  it("continues a handoff in a new session once, however often it is tried", async () => {
    const f = await fixture();
    const handoff = {
      key: "workspace\n20261108-codex-to-deepseek-harness.md",
      workspaceId: "workspace",
      text: "This is a fresh session continuing from a handoff.",
    };
    const first = await f.bridge.handoff(handoff);
    expect(first.sessionId).toMatch(/^ak-session-/);
    const nativeId = first.sessionId.slice("ak-".length);
    expect(f.dsh.prompts).toEqual([
      expect.objectContaining({
        sessionId: nativeId,
        mode: "queue",
        content: [{ type: "text", text: handoff.text }],
      }),
    ]);
    // Trying again finds the same session and the message already in it.
    expect(await f.bridge.handoff(handoff)).toEqual(first);
    expect(f.dsh.prompts).toHaveLength(1);
    expect(f.dsh.creations).toHaveLength(1);
    // Another handoff file is another session.
    const other = await f.bridge.handoff({ ...handoff, key: "workspace\nother.md" });
    expect(other.sessionId).not.toBe(first.sessionId);
  });
});

/**
 * A bridge that can start DSH in the background. Starting one connects the same fake DSH
 * through a plugin reporting the background process's ID, as the real process would.
 */
async function managedFixture(
  options: {
    available?: { available: true } | { available: false; reason: any };
    idleMs?: number;
    desktopRunning?: boolean;
    /** No session, and no DSH of the user's has ever run: a fresh DSH install. */
    empty?: boolean;
    /** How long a background DSH takes to exit once told to stop. */
    stopDelayMs?: number;
    writerStatus?: DshBridgeOptions["writerStatus"];
    localTurn?: DshBridgeOptions["localTurn"];
    localHistory?: DshBridgeOptions["localHistory"];
    quitWork?: boolean;
  } = {},
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-dsh-managed-")));
  const workspace = path.join(root, "workspace");
  const agentkibHome = path.join(root, "agentkib-home");
  mkdirSync(workspace);
  const dsh = fakeDsh(workspace);
  if (!options.empty) dsh.create("session-a", "First DSH session");
  // Each start is a new process with its own ID, as a real one would be.
  let nextPid = 424242;
  type Process = {
    pid: number;
    phase: "starting" | "running" | "stopping";
    plugin: ReturnType<typeof createBridge>;
    exited?: Promise<void>;
  };
  let current: Process | null = null;
  const starts: number[] = [];
  const stops: number[] = [];
  const pluginOptions = {
    roots: [agentkibHome],
    dshVersion: options.quitWork ? "0.2.2-rc.5" : "0.2.1-rc.5",
    discoveryMs: 50,
    debounceMs: 10,
    listThrottleMs: 20,
    commandWaitMs: 150,
  };
  let bridge!: DshBridge;
  const managed = {
    get pid() {
      return current?.pid ?? null;
    },
    available: vi.fn(() => options.available ?? ({ available: true } as const)),
    status: () => ({
      phase: current?.phase ?? ("stopped" as const),
      pid: current?.pid ?? null,
      launcher: "app" as const,
      version: "0.2.2-rc.1",
      failure: null,
    }),
    start: vi.fn(async () => {
      // Like the real one: a process still exiting is waited for first.
      if (current?.phase === "stopping") await current.exited;
      if (current) return current.pid;
      starts.push(Date.now());
      const pid = ++nextPid;
      current = {
        pid,
        phase: "starting",
        plugin: createBridge(dsh.ctx, {
          ...pluginOptions,
          pid,
          ...(options.quitWork
            ? { managed: { home: agentkibHome }, stdin: new PassThrough() }
            : {}),
        }),
      };
      return pid;
    }),
    started: vi.fn(() => {
      if (current?.phase === "starting") current.phase = "running";
    }),
    stop: vi.fn(async () => {
      const process = current;
      if (!process) return;
      if (process.exited) return process.exited;
      stops.push(Date.now());
      process.phase = "stopping";
      process.exited = (async () => {
        await new Promise((resolve) => setTimeout(resolve, options.stopDelayMs ?? 0));
        process.plugin.close();
        if (current === process) current = null;
        bridge.managedExited(process.pid);
      })();
      return process.exited;
    }),
    desktopRunning: vi.fn(async () => options.desktopRunning ?? false),
  };
  const bridgeOptions: DshBridgeOptions = {
    dataDir: path.join(root, "data"),
    bootId: randomUUID(),
    pluginDirectory: path.join(root, "plugin"),
    discoveryFile: path.join(agentkibHome, "dsh-bridge", "discovery-v1.json"),
    platform: "darwin",
    commandTimeoutMs: 1500,
    disconnectGraceMs: 100,
    reconcileIntervalMs: 0,
    reconcileGiveUpMs: 300,
    sessionId: (nativeId) => `ak-${nativeId}`,
    workspaceFor: (cwd) =>
      cwd.startsWith(workspace) ? { id: "workspace", path: workspace } : null,
    workspacePath: (id) => (id === "workspace" ? workspace : null),
    writerStatus: options.writerStatus,
    localTurn: options.localTurn,
    localHistory: options.localHistory,
    sessionsChanged: () => undefined,
    publish: vi.fn(),
    managed: {
      runtime: managed,
      idleMs: options.idleMs ?? 60_000,
      desktopIdleMs: 200,
      reviewMs: 50,
      settleMs: 300,
    },
  };
  bridge = new DshBridge(bridgeOptions);
  bridge.initialize();
  // The user's own DSH ran once, so AgentKib knows the session; then they closed it.
  if (!options.empty) {
    const user = createBridge(dsh.ctx, { ...pluginOptions, pid: 1111 });
    await until(() => bridge.handles("ak-session-a"));
    user.close();
    await until(() => bridge.live("ak-session-a", true).cliVersion === undefined);
  }
  cleanups.push(async () => {
    current?.plugin.close();
    dsh.close();
    await bridge.close();
    rmSync(root, { recursive: true, force: true });
  });
  const send = (text: string, extra: Record<string, unknown> = {}) => {
    const live = bridge.live("ak-session-a", true);
    return bridge.request({
      operation: "send",
      sessionId: "ak-session-a",
      requestId: randomUUID(),
      deviceId: "device-1",
      runtimeBootId: live.runtimeBootId,
      expectedRevision: live.revision,
      experimentalEnabled: true,
      text,
      ...extra,
    }) as Promise<Record<string, any>>;
  };
  const userDsh = () => createBridge(dsh.ctx, { ...pluginOptions, pid: 1111 });
  const create = () =>
    bridge.create({ requestId: randomUUID(), deviceId: "device-1", workspaceId: "workspace" });
  return {
    root,
    agentkibHome,
    bridge,
    dsh,
    managed,
    starts,
    stops,
    send,
    create,
    userDsh,
    pluginOptions,
    async reopen() {
      await bridge.close();
      bridge = new DshBridge({ ...bridgeOptions, bootId: randomUUID() });
      bridge.initialize();
      return bridge;
    },
  };
}

describe("DeepSeek Harness started in the background", () => {
  it("publishes read-only running observations and clears them on turn end or writer release", async () => {
    const writer = vi.fn<NonNullable<DshBridgeOptions["writerStatus"]>>(() => "held");
    const now = Date.now();
    const opened = {
      dev: 1,
      ino: 2,
      size: 120,
      mtimeMs: now,
      seq: 10,
      lastEventAt: now,
      open: { turn: 7, startedAt: now },
    };
    const localTurn = vi.fn<NonNullable<DshBridgeOptions["localTurn"]>>(async () => opened);
    const f = await managedFixture({ writerStatus: writer, localTurn });
    const published = vi.mocked(f.bridge.options.publish);
    published.mockClear();
    await f.bridge.refreshLocalTurns();
    const active = {
      status: "running",
      reason: "dsh-native-turn-observed",
      executionLocation: "external",
      turnId: null,
      sendEnabled: false,
      stopEnabled: false,
      queueEnabled: false,
    };
    expect(f.bridge.live("ak-session-a", true)).toMatchObject(active);
    expect(published).toHaveBeenCalledWith(
      "ak-session-a",
      "state",
      expect.objectContaining(active),
      expect.objectContaining(active),
    );
    expect(f.starts).toEqual([]);
    published.mockClear();
    await f.bridge.refreshLocalTurns();
    expect(localTurn).toHaveBeenLastCalledWith("session-a", expect.any(String), opened);
    expect(published).not.toHaveBeenCalled();

    localTurn.mockResolvedValueOnce({ ...opened, size: 200, seq: 18, open: null });
    await f.bridge.refreshLocalTurns();
    expect(f.bridge.live("ak-session-a", true)).toMatchObject({
      status: "unsupported",
      reason: "dsh-native-status-unknown",
    });
    expect(published).toHaveBeenCalledTimes(1);

    localTurn.mockResolvedValueOnce({ ...opened, lastEventAt: now - 31 * 60_000 });
    await f.bridge.refreshLocalTurns();
    expect(f.bridge.live("ak-session-a", true).status).toBe("unsupported");
    await f.bridge.refreshLocalTurns();
    expect(f.bridge.live("ak-session-a", true)).toMatchObject(active);

    const user = f.userDsh();
    cleanups.push(() => user.close());
    await until(() => f.bridge.live("ak-session-a", true).status === "idle");
    expect(f.bridge.live("ak-session-a", true).reason).toBeUndefined();
    user.close();
    await until(() => f.bridge.live("ak-session-a", true).cliVersion === undefined);
    await f.bridge.refreshLocalTurns();
    expect(f.bridge.live("ak-session-a", true)).toMatchObject(active);

    writer.mockReturnValue("free");
    await f.bridge.refreshLocalTurns();
    expect(f.bridge.live("ak-session-a", true)).toMatchObject({
      status: "unsupported",
      executionLocation: null,
      sendEnabled: true,
    });
    expect(f.starts).toEqual([]);
  });

  it("lets a session be sent to while no DSH runs, and starts one to take it", async () => {
    const f = await managedFixture();
    const offline = f.bridge.live("ak-session-a", true);
    expect(offline).toMatchObject({
      status: "unsupported",
      reason: "dsh-native-status-unknown",
      sendEnabled: true,
      executionLocation: null,
    });
    expect(f.bridge.capabilities("ak-session-a", true)).toMatchObject({
      features: {
        send: { available: true },
        stop: { available: false },
        rename: { available: false },
        fork: { available: false },
      },
    });

    const sent = await f.send("hello from the phone");
    expect(sent.controlOutcome).toBe("accepted");
    expect(f.starts).toHaveLength(1);
    expect(f.managed.started).toHaveBeenCalled();
    expect(f.dsh.prompts.at(-1)).toMatchObject({
      sessionId: "session-a",
      content: [{ type: "text", text: "hello from the phone" }],
    });
    // It runs where AgentKib runs: it stops when AgentKib quits.
    expect(f.bridge.live("ak-session-a", true).executionLocation).toBe("agentkib");
    expect(
      (
        f.bridge.management({
          operation: "dsh-bridge-status",
          deviceId: "agentkib-local-owner",
        }) as any
      ).runtimes,
    ).toEqual([expect.objectContaining({ managed: true })]);
  });

  it("stops the background DSH once it has had nothing to do", async () => {
    const f = await managedFixture({ idleMs: 200 });
    expect((await f.send("one turn")).controlOutcome).toBe("accepted");
    // Running: it stays.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(f.stops).toHaveLength(0);
    f.dsh.finishTurn("session-a", "done");
    await until(() => f.stops.length === 1, 3000);
    // The session can be sent to again; that starts DSH anew.
    expect(f.bridge.live("ak-session-a", true)).toMatchObject({
      status: "unsupported",
      reason: "dsh-native-status-unknown",
      sendEnabled: true,
    });
    expect((await f.send("again")).controlOutcome).toBe("accepted");
    expect(f.starts).toHaveLength(2);
  });

  it("gives way at once to a DSH of the user's, and lets it take new sessions", async () => {
    const f = await managedFixture();
    expect((await f.send("started here")).controlOutcome).toBe("accepted");
    f.dsh.finishTurn("session-a", "done");
    const user = f.userDsh();
    cleanups.push(() => user.close());
    // With both running, AgentKib still knows where a new session goes.
    await until(
      () =>
        (
          f.bridge.management({
            operation: "dsh-bridge-status",
            deviceId: "agentkib-local-owner",
          }) as any
        ).runtimes.length === 2 || f.stops.length === 1,
    );
    await until(() => f.stops.length === 1, 3000);
    expect((await f.bridge.createOptions()).available).toBe(true);
  });

  it("gives way once DSH Desktop's own window is open", async () => {
    const f = await managedFixture({ desktopRunning: true });
    expect((await f.send("started here")).controlOutcome).toBe("accepted");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(f.stops).toHaveLength(0);
    f.dsh.finishTurn("session-a", "done");
    await until(() => f.stops.length === 1, 3000);
  });

  it("does not start an unsupported version of DSH and reports why", async () => {
    const old = await managedFixture({
      available: { available: false, reason: "dsh-version-unsupported" },
    });
    expect(old.bridge.live("ak-session-a", true)).toMatchObject({
      status: "unsupported",
      reason: "dsh-version-unsupported",
    });
    expect(old.bridge.documentStatus("session-a")).toEqual({
      status: "unavailable",
      reason: "dsh-version-unsupported",
    });
    expect(await old.create()).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "dsh-version-unsupported",
    });
    expect(old.starts).toHaveLength(0);
  });

  it("reports the reason when the background start fails", async () => {
    const f = await managedFixture();
    f.managed.start.mockRejectedValueOnce(new Error("dsh-start-failed"));
    expect(await f.send("not sent")).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "dsh-start-failed",
    });
    expect(f.dsh.prompts).toHaveLength(0);
  });

  it("only reads uncached history, documents and creation options with no runtime", async () => {
    const f = await managedFixture();
    await expect(f.bridge.conversation("session-a")).rejects.toThrow("dsh-runtime-offline");
    expect(f.bridge.documentStatus("session-a")).toEqual({
      status: "unavailable",
      reason: "dsh-runtime-offline",
    });
    await expect(f.bridge.events("session-a", null, 20)).resolves.toMatchObject({ events: [] });
    await expect(f.bridge.createOptions(true)).resolves.toEqual({ available: true });
    expect(f.starts).toHaveLength(0);
  });

  it("refreshes the latest offline history while retaining the last readable page", async () => {
    const localHistory = vi.fn<NonNullable<DshBridgeOptions["localHistory"]>>();
    const f = await managedFixture({ localHistory });
    const readPage = (cursor: number, text: string) => ({
      sessionId: "session-a",
      cwd: null,
      createdAt: null,
      cursor,
      records: [
        {
          kind: "assistant" as const,
          seq: cursor,
          time: null,
          turn: 1,
          text,
          truncated: false,
          interrupted: false,
        },
      ],
      nextBefore: null,
    });
    localHistory
      .mockResolvedValueOnce(readPage(1, "saved"))
      .mockResolvedValueOnce(readPage(2, "appended"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...readPage(0, ""), records: [] });
    const getPage = () => f.bridge.events("session-a", null, 20);
    await expect(getPage()).resolves.toMatchObject({
      events: [{ content: "saved" }],
      warnings: [],
    });
    await expect(getPage()).resolves.toMatchObject({
      events: [{ content: "appended" }],
      warnings: [],
    });
    await expect(getPage()).resolves.toMatchObject({
      events: [{ content: "appended" }],
      warnings: ["dsh-history-unavailable"],
    });
    await expect(getPage()).resolves.toEqual({ events: [], next_cursor: null, warnings: [] });
    expect(f.starts).toHaveLength(0);
  });

  it("follows the original agent once bridged and never resumes over an unobserved writer", async () => {
    const writerStatus = vi.fn<NonNullable<DshBridgeOptions["writerStatus"]>>(() => "held");
    const f = await managedFixture({ writerStatus });
    const unknown = {
      status: "unsupported",
      reason: "dsh-native-status-unknown",
      executionLocation: null,
      sendEnabled: false,
      stopEnabled: false,
    };
    expect(f.bridge.live("ak-session-a", true)).toMatchObject(unknown);
    expect(await f.send("must not start")).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: unknown.reason,
    });
    expect(f.starts).toHaveLength(0);
    writerStatus.mockReturnValueOnce("unknown");
    expect(f.bridge.live("ak-session-a", true)).toMatchObject(unknown);

    // The background bridge can read this history but has no agent for this session.
    const agents = f.dsh.ctx.agents.list;
    f.dsh.ctx.agents.list = () =>
      agents().filter((agent: { id: string }) => agent.id !== "session-a");
    const list = f.dsh.ctx.sessionController.list;
    f.dsh.ctx.sessionController.list = async () => {
      const { items } = await list();
      return {
        items: items.map((item: { sessionId: string }) =>
          item.sessionId === "session-a" ? { ...item, agentAvailable: false } : item,
        ),
      };
    };
    expect(await f.create()).toMatchObject({ controlOutcome: "accepted" });
    expect(f.starts).toHaveLength(1);
    await f.bridge.events("session-a", null, 20);
    expect(f.bridge.live("ak-session-a", true)).toMatchObject(unknown);
    expect(await f.send("must not dispatch")).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: unknown.reason,
    });
    expect(f.dsh.prompts).toHaveLength(0);

    // The native process reports the real running turn, with no AgentKib send.
    const native = fakeDsh(path.join(f.root, "workspace"));
    native.create("session-a", "First DSH session");
    const user = createBridge(native.ctx, { ...f.pluginOptions, pid: 1111 });
    cleanups.push(() => {
      user.close();
      native.close();
    });
    await native.ctx.sessionController.prompt({
      sessionId: "session-a",
      content: [{ type: "text", text: "Already sent in native DSH" }],
    });
    await until(() => f.bridge.live("ak-session-a", true).status === "running");
    expect(f.bridge.live("ak-session-a", true)).toMatchObject({
      status: "running",
      executionLocation: "external",
      turnId: "dsh-turn-1",
    });
    user.close();
    await until(() => f.bridge.live("ak-session-a", true).reason === unknown.reason);
    expect(f.bridge.live("ak-session-a", true)).toMatchObject(unknown);
  });

  it("explains a session another DSH holds", async () => {
    const f = await managedFixture();
    const controller = f.dsh.ctx.sessionController;
    controller.prompt = async () => {
      throw Object.assign(new Error("already owned by an active write handle"), {
        code: "session/writer-held",
      });
    };
    expect(await f.send("held elsewhere")).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "dsh-session-in-use",
    });
  });

  it("takes a DSH with no sessions yet as ready", async () => {
    const f = await managedFixture({ empty: true });
    expect(await f.bridge.createOptions()).toEqual({ available: true });
    expect(f.starts).toHaveLength(0);
    expect(await f.create()).toMatchObject({ controlOutcome: "accepted" });
    const options = await f.bridge.createOptions();
    expect(options.available).toBe(true);
    expect(options.agentPresets?.map((preset) => preset.id)).toContain("standard");
    expect(f.starts).toHaveLength(1);
  });

  it("hands nothing to a background DSH it is stopping, and starts another", async () => {
    const f = await managedFixture({ desktopRunning: true, stopDelayMs: 800 });
    expect((await f.send("first")).controlOutcome).toBe("accepted");
    f.dsh.finishTurn("session-a", "done");
    // Idle with DSH Desktop open: it is being stopped, and takes a moment to exit.
    await until(() => f.stops.length === 1, 3000);
    expect(f.bridge.live("ak-session-a", true).executionLocation).toBeNull();
    // A new session wanted meanwhile goes to a new DSH, not the one exiting.
    expect(await f.create()).toMatchObject({ controlOutcome: "accepted" });
    expect(f.starts).toHaveLength(2);
  });

  it("stops the background DSH when AgentKib closes", async () => {
    const f = await managedFixture();
    expect((await f.send("running when AgentKib quits")).controlOutcome).toBe("accepted");
    await f.bridge.close();
    expect(f.managed.stop).toHaveBeenCalled();
    expect(f.stops).toHaveLength(1);
  });
});

describe("DeepSeek Harness quit work", () => {
  const scenarios = [
    "same settings",
    "settings changed during restore",
    "steering pending at preview",
    "queued after preview",
  ];
  it.each(scenarios)(
    "verifies the managed interruption and sends no continuation when native input was queued: %s",
    async (settings) => {
      const writerStatus = vi.fn(() => "free" as "free" | "held");
      const localTurn = vi.fn();
      const f = await managedFixture({ quitWork: true, writerStatus, localTurn });
      const session = f.dsh.sessions.get("session-a")!;
      const agent = session.agent;
      const cwd = path.join(f.root, "workspace");
      const model = { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" };
      const followup = vi.fn();
      let loaded = true;
      let resumed = false;
      const manualOnly =
        settings === "steering pending at preview" || settings === "queued after preview";
      agent.session.header = { id: agent.id, cwd };
      agent.session.requestHeader = () => ({ config: model });
      agent.session.eventAt = (seq: number) => session.events[seq];
      agent.model.current = () => model;
      agent.followup = followup;
      agent.cancel = vi.fn((reason: unknown) => {
        f.dsh.append(agent.id, "turn/end", { turn: 1, reason: { kind: "aborted", reason } });
        agent.status = "idle";
        f.dsh.emit("agent/status", { agent, status: "idle" });
      });
      agent.whenIdle = async () => {};
      f.dsh.ctx.agents.get = () => (loaded ? agent : undefined);
      f.dsh.ctx.agents.list = () => (loaded ? [agent] : []);
      f.dsh.ctx.workspaceRegistry = { archivedSessionIds: [] };
      f.dsh.ctx.sessionProjections = {
        snapshot: () => ({
          values: {
            agentPreset: "standard",
            permissions: { currentValue: "workspace-write" },
            plan: {
              active: resumed && settings === "settings changed during restore",
              pending: false,
            },
          },
        }),
      };
      f.dsh.ctx.permissionPresets.resolve = () => ({
        sandbox: "workspace-write",
        approval: "on-request",
      });
      f.dsh.ctx.sessionPersistence = {
        flush: vi.fn(async () => {}),
        open: async () => ({
          header: agent.session.header,
          read: async (offset: number) => ({ events: session.events.slice(offset) }),
          close: async () => {},
        }),
      };
      f.dsh.ctx.sessionController.resolveAgent = async () => {
        resumed = true;
        loaded = true;
        f.dsh.append(agent.id, "session/end-seed", {});
        f.dsh.emit("agent/created", { agent, source: "resume" });
        return { agent };
      };

      const id = "ak-session-a";
      await expect(f.bridge.quitCandidate(id)).resolves.toBeUndefined();
      expect(await f.send("first")).toMatchObject({ controlOutcome: "accepted" });
      await until(() => f.bridge.live(id, true).turnId === "dsh-turn-1");
      if (settings === "steering pending at preview") agent.inbox.nextStep = [{ id: "steering" }];
      expect(await f.bridge.quitCandidate(id)).toEqual({
        turnId: "dsh-turn-1",
        ...(settings === "steering pending at preview" ? { manualOnly: true } : {}),
      });
      if (settings === "queued after preview") agent.inbox.nextTurn = [{ id: "queued" }];
      expect(await f.bridge.interruptForQuit(id, "dsh-turn-2")).toBeUndefined();
      expect(agent.cancel).not.toHaveBeenCalled();
      const evidence = (await f.bridge.interruptForQuit(id, "dsh-turn-1"))!;
      expect(evidence).toMatchObject({ cwd, turn: 1, endSeq: session.events.at(-1).seq });
      expect(evidence.manualOnly === true).toBe(manualOnly);
      if (manualOnly) expect([...agent.inbox.nextTurn, ...agent.inbox.nextStep]).toHaveLength(1);
      expect(agent.cancel).toHaveBeenCalledExactlyOnceWith(
        { kind: "hook", reason: `agentkib-quit:${evidence.interruptionId}` },
        { keepInbox: true },
      );
      expect(f.dsh.ctx.sessionPersistence.flush).toHaveBeenCalledTimes(1);
      expect(await f.bridge.endedTurns(id)).toEqual([]);
      const reopened = await f.reopen();
      loaded = false;
      expect(reopened.handles(id)).toBe(true);
      localTurn.mockResolvedValue({
        seq: Number(evidence.endSeq) + (manualOnly ? 1 : 0),
        quitInterruption: {
          turn: 1,
          interruptionId: evidence.interruptionId,
          endSeq: evidence.endSeq,
          ...(manualOnly ? { cleanup: "next-turn" } : {}),
        },
      });
      writerStatus.mockReturnValueOnce("held");
      expect(await reopened.checkAfterQuit(id, evidence)).toBe(false);
      expect(await reopened.checkAfterQuit(id, { ...evidence, interruptionId: randomUUID() })).toBe(
        false,
      );
      writerStatus.mockReturnValueOnce("free").mockReturnValueOnce("held");
      expect(await reopened.checkAfterQuit(id, evidence)).toBe(false);
      expect(await reopened.checkAfterQuit(id, evidence)).toBe(manualOnly ? "open-session" : true);
      const requestId = randomUUID();
      if (manualOnly) {
        const starts = f.starts.length;
        expect(await reopened.resumeAfterQuit(id, evidence, requestId, "Continue")).toBe(
          "manual-required",
        );
        expect(f.starts).toHaveLength(starts);
        expect(f.dsh.prompts).toHaveLength(1);
        expect(followup).not.toHaveBeenCalled();
        return;
      }
      if (settings === "settings changed during restore") {
        expect(await reopened.resumeAfterQuit(id, evidence, requestId, "Continue")).toBe("skipped");
        expect(resumed).toBe(true);
        expect(followup).not.toHaveBeenCalled();
        return;
      }
      expect(await reopened.resumeAfterQuit(id, evidence, requestId, "Continue")).toBe("continued");
      expect(followup).toHaveBeenCalledExactlyOnceWith({
        id: requestId,
        role: "user",
        content: [{ type: "text", text: "Continue" }],
        source: { kind: "user", rpcId: requestId },
      });
      expect(
        readControlReceipt(path.join(f.root, "data"), { requestId, deviceId: "desktop-local" }),
      ).toMatchObject({ sessionId: id, status: "accepted", operation: "send" });
      expect(await reopened.resumeAfterQuit(id, evidence, randomUUID(), "Do not continue")).toBe(
        "skipped",
      );
      expect(followup).toHaveBeenCalledTimes(1);
    },
  );
});

describe("DeepSeek Harness plugin in a DSH that AgentKib started", () => {
  it("reports only to that AgentKib and exits when it goes away", async () => {
    const f = await fixture();
    const appExit = vi.fn();
    const dsh = fakeDsh(f.workspace);
    dsh.ctx.appExit = appExit;
    const stdin = new PassThrough();
    const plugin = createBridge(dsh.ctx, {
      managed: { home: f.agentkibHome },
      stdin,
      dshVersion: "0.2.1-rc.5",
      discoveryMs: 50,
      debounceMs: 10,
      pid: 5151,
    });
    cleanups.push(() => {
      plugin.close();
      dsh.close();
    });
    expect(plugin.managed).toBe(true);
    await until(() => [...plugin.hosts.values()].some((host: any) => host.token));
    expect(appExit).not.toHaveBeenCalled();
    // AgentKib closing its end of DSH's standard input means it is gone.
    stdin.end();
    await until(() => appExit.mock.calls.length > 0);
    expect(appExit).toHaveBeenCalledWith(0);
  });

  it("exits once it has not reached that AgentKib for a while", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-dsh-gone-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const appExit = vi.fn();
    const dsh = fakeDsh(root);
    dsh.ctx.appExit = appExit;
    const plugin = createBridge(dsh.ctx, {
      managed: { home: path.join(root, "no-agentkib-here") },
      stdin: new PassThrough(),
      discoveryMs: 50,
      hostGoneMs: 200,
    });
    cleanups.push(() => {
      plugin.close();
      dsh.close();
    });
    await until(() => appExit.mock.calls.length > 0, 3000);
  });

  it("ignores a managed config without an absolute AgentKib home", () => {
    expect(managedHost({ home: "relative/home" })).toBeNull();
    expect(managedHost({ home: "/a/../b" })).toBeNull();
    expect(managedHost(undefined)).toBeNull();
    expect(managedHost({ home: "/Users/someone/.agentkib" })).toEqual({
      home: "/Users/someone/.agentkib",
    });
  });
});

describe("DeepSeek Harness sessions as a Project Agent's workers", () => {
  it("reads how a session's turns ended from DSH's history", async () => {
    const f = await fixture();
    expect(await f.control("send", { text: "brief" })).toMatchObject({ accepted: true });
    f.dsh.finishTurn("session-a", "done");
    f.dsh.append("session-a", "turn/start", { turn: 2 });
    f.dsh.append("session-a", "turn/end", {
      turn: 2,
      reason: { kind: "aborted", reason: { kind: "user" } },
    });
    f.dsh.append("session-a", "turn/start", { turn: 3 });
    f.dsh.append("session-a", "turn/end", { turn: 3, reason: { kind: "error", error: {} } });
    const turns = await f.bridge.endedTurns("ak-session-a");
    expect(turns.map(({ turnId, outcome }) => ({ turnId, outcome }))).toEqual([
      { turnId: "dsh-turn-1", outcome: "completed" },
      { turnId: "dsh-turn-2", outcome: "cancelled" },
      { turnId: "dsh-turn-3", outcome: "failed" },
    ]);
    expect(Date.parse(turns[0]!.endedAt!)).toBeGreaterThanOrEqual(Date.parse(turns[0]!.startedAt!));
    await expect(f.bridge.endedTurns("ak-nope")).rejects.toThrow("session-unavailable");
  });

  it("shows a used-up provider quota as a usage limit and clears it with the next turn", async () => {
    const f = await fixture();
    expect(f.bridge.live("ak-session-a", true).usageLimit).toBeNull();
    expect(await f.control("send", { text: "go" })).toMatchObject({ accepted: true });
    const agent = f.dsh.sessions.get("session-a")!.agent;
    f.dsh.append("session-a", "turn/end", {
      turn: 1,
      reason: {
        kind: "error",
        error: { code: "ACCOUNT_QUOTA", message: "Request quota exhausted." },
      },
    });
    agent.status = "idle";
    f.dsh.emit("agent/status", { agent, status: "idle" });
    await until(() => f.bridge.live("ak-session-a", true).usageLimit);
    expect(f.bridge.live("ak-session-a", true)).toMatchObject({
      status: "idle",
      usageLimit: {
        agent: "deepseek-harness",
        kind: "quota",
        resetsAt: null,
        continueAt: null,
        manual: "reset-unknown",
        message: "Request quota exhausted.",
      },
    });
    // A later turn clears it, and a turn that ends normally does not bring it back.
    f.dsh.append("session-a", "turn/start", { turn: 2 });
    agent.status = "running";
    f.dsh.emit("agent/status", { agent, status: "running" });
    await until(() => f.bridge.live("ak-session-a", true).usageLimit === null);
    f.dsh.finishTurn("session-a", "done again");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.bridge.live("ak-session-a", true).usageLimit).toBeNull();
  });

  it("neither lists nor reads worker turns by starting DSH", async () => {
    const f = await managedFixture();
    expect(await f.bridge.createOptions(true)).toEqual({ available: true });
    expect(await f.bridge.endedTurns("ak-session-a")).toEqual([]);
    expect(f.starts).toEqual([]);
    // A new session for the person still starts it.
    expect(await f.create()).toMatchObject({ controlOutcome: "accepted" });
    expect(f.starts).toHaveLength(1);
  });

  it("starts a worker in DSH's workspace-write preset, or refuses one it cannot confirm", async () => {
    const f = await fixture();
    const open = (preset?: string, bridge: Partial<DshLaneBridge> = {}) =>
      createDshWorker(
        {
          create: async (value) => {
            const created = await f.bridge.create(value);
            // DSH's default preset for new sessions, as the user set it.
            const nativeId =
              typeof created.sessionId === "string" ? f.bridge.nativeId(created.sessionId) : null;
            if (nativeId && preset) f.dsh.permissionOf.set(nativeId, preset);
            return created;
          },
          request: (value) => f.bridge.request(value),
          live: (id, controls) => f.bridge.live(id, controls),
          ...bridge,
        },
        { requestId: randomUUID(), deviceId: "device-1", workspaceId: "workspace" },
      );
    // Already in a preset that asks: nothing to change.
    const plain = await open();
    expect(plain).toMatchObject({ accepted: true, sessionId: expect.stringMatching(/^ak-/) });
    expect(f.dsh.executed).toEqual([]);
    for (const preset of ["read-only"]) {
      expect(await open(preset)).toMatchObject({ accepted: true });
      expect(f.dsh.executed).toEqual([]);
    }
    // Full access by default: moved to workspace-write before it is a worker.
    const moved = await open("danger-full-access");
    expect(moved).toMatchObject({ accepted: true });
    expect(f.dsh.executed).toEqual(["/permission workspace-write"]);
    expect(f.dsh.permissionOf.get(f.bridge.nativeId(moved.sessionId as string)!)).toBe(
      "workspace-write",
    );
    // A change DSH refuses leaves an ordinary session, named in the refusal.
    const refused = await open("danger-full-access", {
      request: async (value) =>
        value.operation === "settings"
          ? { accepted: false, controlOutcome: "not-dispatched", reason: "session-busy" }
          : f.bridge.request(value),
    });
    expect(refused).toMatchObject({
      accepted: false,
      reason: "dsh-worker-preset-unavailable",
      sessionId: expect.stringMatching(/^ak-/),
    });
    // A DSH that reports no presets cannot be checked.
    expect(
      await open("danger-full-access", {
        request: async (value) =>
          value.operation === "settings-state"
            ? { available: true, current: {}, policies: [] }
            : f.bridge.request(value),
      }),
    ).toMatchObject({ accepted: false, reason: "dsh-worker-preset-unavailable" });
    // A create DSH refuses is passed on as it is.
    expect(
      await createDshWorker(
        {
          create: async () => ({ accepted: false, reason: "dsh-runtime-offline" }),
          request: async () => ({}),
          live: () => ({}),
        },
        { requestId: randomUUID(), deviceId: "device-1", workspaceId: "workspace" },
      ),
    ).toEqual({ accepted: false, reason: "dsh-runtime-offline" });
  });

  it("reports a worker's turn from the states the bridge publishes", async () => {
    const f = await fixture();
    const ended: unknown[][] = [];
    const waiting: unknown[][] = [];
    let lane = true;
    const watch = new DshLaneWatch({
      isLane: () => lane,
      endedTurns: (id) => f.bridge.endedTurns(id),
      turnEnded: async (...args) => void ended.push(args),
      waiting: async (...args) => void waiting.push(args),
      retryMs: 20,
    });
    cleanups.push(() => watch.close());
    for (const [id, type, , live] of f.publish.mock.calls)
      if (type === "state") watch.observe(id, live);
    f.publish.mockImplementation((id, type, _payload, live) => {
      if (type === "state") watch.observe(id, live);
    });
    expect(await f.control("send", { text: "brief" })).toMatchObject({ accepted: true });
    await until(() => f.bridge.live("ak-session-a", true).status === "running");
    f.dsh.finishTurn("session-a", "done");
    await until(() => ended.length > 0);
    expect(ended).toEqual([["ak-session-a", "dsh-turn-1", "completed", expect.any(Number)]]);
    expect(waiting).toEqual([]);
    // Not a worker: its turns are nobody's report.
    lane = false;
    expect(await f.control("send", { text: "again" })).toMatchObject({ accepted: true });
    await until(() => f.bridge.live("ak-session-a", true).status === "running");
    f.dsh.finishTurn("session-a", "done again");
    await until(() => f.bridge.live("ak-session-a", true).status === "idle");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ended).toHaveLength(1);
  });

  it("waits for a turn's end to reach DSH's history, and reports waiting states once", async () => {
    const turns: Array<{
      turnId: string;
      outcome: string;
      startedAt: string | null;
      endedAt: string | null;
    }> = [];
    const ended: unknown[][] = [];
    const waiting: unknown[][] = [];
    let failRead = true;
    const watch = new DshLaneWatch({
      isLane: (id) => id === "lane",
      endedTurns: async () => {
        if (failRead) {
          failRead = false;
          throw new Error("native history temporarily unavailable");
        }
        return turns;
      },
      turnEnded: async (...args) => void ended.push(args),
      waiting: async (...args) => void waiting.push(args),
      retryMs: 10,
      retries: 3,
    });
    cleanups.push(() => watch.close());
    watch.observe("lane", { status: "running", turnId: "dsh-turn-4" });
    watch.observe("lane", { status: "awaiting-approval", turnId: "dsh-turn-4" });
    watch.observe("lane", { status: "awaiting-approval", turnId: "dsh-turn-4" });
    watch.observe("lane", { status: "running", turnId: "dsh-turn-4" });
    watch.observe("lane", { status: "waiting-input", turnId: "dsh-turn-4" });
    expect(waiting).toEqual([
      ["lane", "dsh-turn-4", "awaiting-approval"],
      ["lane", "dsh-turn-4", "waiting-input"],
    ]);
    watch.observe("lane", { status: "idle", turnId: null });
    await new Promise((resolve) => setTimeout(resolve, 15));
    turns.push({
      turnId: "dsh-turn-4",
      outcome: "cancelled",
      startedAt: null,
      endedAt: new Date().toISOString(),
    });
    await until(() => ended.length > 0);
    // DSH's history did not reach back to the start: no length is made up.
    expect(ended).toEqual([["lane", "dsh-turn-4", "cancelled", null]]);
    // DSH went away mid-turn: nothing in its history yet, so nothing is reported now.
    turns.length = 0;
    watch.observe("lane", { status: "running", turnId: "dsh-turn-5" });
    watch.observe("lane", { status: "unsupported", turnId: null });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ended).toHaveLength(1);
  });
});

describe("DeepSeek Harness sessions as Project Agents", () => {
  it("registers assigned-worker tools and refuses retired calls through the plugin bridge", async () => {
    const lead = projectAgentFixture("ak-session-a", "workspace");
    try {
      const f = await fixture({
        lead: {
          sessions: () => ["ak-session-a"],
          tools: (id) => lead.service.leadToolSpecs(id),
          call: (id, name, input) => lead.service.call(id, name, input),
        },
      });
      await until(() => f.dsh.toolsOf("session-a").length === 6);
      expect(f.dsh.toolsOf("session-a").map(({ name }: { name: string }) => name)).toEqual([
        "worker_list",
        "worker_send",
        "worker_read",
        "worker_settings",
        "worker_stop",
        "worker_restart",
      ]);
      const token = [...f.plugin.hosts.values()][0]!.token;
      const discovery = JSON.parse(
        readFileSync(path.join(f.agentkibHome, "dsh-bridge", "discovery-v1.json"), "utf8"),
      );
      for (const name of ["worker_open", "worker_close"]) {
        const result = await post(discovery.socketPath, DSH_BRIDGE_PATHS.leadCall, {
          token,
          sessionId: "session-a",
          name,
          input: {},
        });
        expect(JSON.parse(result.text)).toEqual({ accepted: false, reason: "tool-not-offered" });
      }
    } finally {
      await lead.close();
    }
  });

  const SPECS = [
    {
      name: "worker_list",
      description: "List your workers.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "worker_send",
      description: "Give a worker a task.",
      inputSchema: {
        type: "object",
        properties: { worker: { type: "string" }, text: { type: "string" } },
        required: ["worker", "text"],
      },
    },
  ];

  async function leading() {
    let leads = ["ak-session-a"];
    let specs = SPECS;
    const calls: Array<[string, string, Record<string, unknown>]> = [];
    const f = await fixture({
      lead: {
        sessions: () => leads,
        tools: () => specs,
        call: async (sessionId, name, input) => {
          calls.push([sessionId, name, input]);
          return name === "worker_send"
            ? {
                text: JSON.stringify({ accepted: false, reason: "delegation-paused" }),
                isError: true,
              }
            : { text: JSON.stringify({ workers: [] }) };
        },
      },
    });
    return {
      ...f,
      calls,
      lead: (value: string[]) => {
        leads = value;
        f.bridge.leadChanged();
      },
      specs: (value: typeof SPECS) => {
        specs = value;
        f.bridge.leadChanged();
      },
    };
  }

  it("gives a lead session's own agent its worker tools and runs their calls in AgentKib", async () => {
    const f = await leading();
    f.dsh.create("session-b", "Another session");
    f.bridge.leadChanged();
    await until(() => f.dsh.toolsOf("session-a").length === 2);
    expect(f.dsh.toolsOf("session-a").map((tool: any) => tool.name)).toEqual([
      "worker_list",
      "worker_send",
    ]);
    // No other session sees them.
    expect(f.dsh.toolsOf("session-b")).toEqual([]);
    const [list, send] = f.dsh.toolsOf("session-a");
    expect(list.parameters).toEqual(SPECS[0]!.inputSchema);
    expect(list.output.render({}, "text")).toEqual([{ type: "text", text: "text" }]);
    expect(await list.execute({}, { signal: new AbortController().signal })).toBe(
      JSON.stringify({ workers: [] }),
    );
    // A refusal is the tool's failure, with AgentKib's reason for the model to read.
    await expect(
      send.execute({ worker: "api", text: "go" }, { signal: new AbortController().signal }),
    ).rejects.toThrow("delegation-paused");
    expect(f.calls).toEqual([
      ["ak-session-a", "worker_list", {}],
      ["ak-session-a", "worker_send", { worker: "api", text: "go" }],
    ]);
    // Only for a lead this DSH has: AgentKib checks again on every call.
    const token = [...f.plugin.hosts.values()][0]!.token;
    const discovery = JSON.parse(
      readFileSync(path.join(f.agentkibHome, "dsh-bridge", "discovery-v1.json"), "utf8"),
    );
    await expect(
      post(discovery.socketPath, DSH_BRIDGE_PATHS.leadCall, {
        token,
        sessionId: "session-b",
        name: "worker_list",
        input: {},
      }),
    ).rejects.toMatchObject({ status: 403, code: "not-a-project-agent" });
  });

  it.each([false, true])(
    "requires a unique controller for a lead visible in two runtimes (both loaded: %s)",
    async (bothLoaded) => {
      const f = await leading();
      const other = fakeDsh(f.workspace);
      const list = other.ctx.sessionController.list;
      if (bothLoaded) {
        other.create("session-a", "First DSH session");
      } else {
        other.ctx.sessionController.list = async () => {
          const { items } = await f.dsh.ctx.sessionController.list();
          return { items: items.map((item: object) => ({ ...item, agentAvailable: false })) };
        };
      }
      const plugin = createBridge(other.ctx, {
        roots: [f.agentkibHome],
        dshVersion: "0.2.2-rc.3",
        discoveryMs: 50,
        debounceMs: 10,
        listThrottleMs: 20,
        commandWaitMs: 150,
      });
      cleanups.push(() => {
        plugin.close();
        other.close();
      });
      const otherHost = await until(() =>
        [...plugin.hosts.values()].find((host) => host.watch.has("session-a")),
      );
      const primaryHost = [...f.plugin.hosts.values()][0]!;
      const call = (host: typeof otherHost) =>
        post(host.socketPath, DSH_BRIDGE_PATHS.leadCall, {
          token: host.token,
          sessionId: "session-a",
          name: "worker_list",
          input: {},
        });
      await expect(call(otherHost)).rejects.toMatchObject({
        status: 403,
        code: "not-a-project-agent",
      });
      if (bothLoaded) {
        await expect(call(primaryHost)).rejects.toMatchObject({
          status: 403,
          code: "not-a-project-agent",
        });
        expect(f.calls).toEqual([]);
      } else {
        await expect(call(primaryHost)).resolves.toEqual({
          text: '{"workers":[]}',
          isError: false,
        });
        expect(f.calls).toEqual([["ak-session-a", "worker_list", {}]]);
        f.plugin.close();
        await until(() => {
          const { runtimes } = f.bridge.management({
            operation: "dsh-bridge-status",
            deviceId: "agentkib-local-owner",
          });
          return Array.isArray(runtimes) && runtimes.length === 1;
        });
        await expect(call(otherHost)).rejects.toMatchObject({
          status: 403,
          code: "not-a-project-agent",
        });
        expect(f.calls).toHaveLength(1);
        const firstCall = call(otherHost);
        await new Promise((resolve) => setTimeout(resolve, 50));
        other.ctx.sessionController.list = list;
        other.create("session-a", "First DSH session");
        await expect(firstCall).resolves.toEqual({ text: '{"workers":[]}', isError: false });
        expect(f.calls).toHaveLength(2);
      }
    },
  );

  it("keeps the tools with the lead as DSH loads it again, changes them, and takes them away", async () => {
    const f = await leading();
    await until(() => f.dsh.toolsOf("session-a").length === 2);
    // DSH runs the session in a new agent: it gets the tools as it is created.
    f.dsh.reload("session-a");
    expect(f.dsh.toolsOf("session-a").map((tool: any) => tool.name)).toEqual([
      "worker_list",
      "worker_send",
    ]);
    f.specs([SPECS[0]!]);
    await until(() => f.dsh.toolsOf("session-a").length === 1);
    f.lead([]);
    await until(() => f.dsh.toolsOf("session-a").length === 0);
    // Calls of a session that stopped leading are refused.
    const token = [...f.plugin.hosts.values()][0]!.token;
    const discovery = JSON.parse(
      readFileSync(path.join(f.agentkibHome, "dsh-bridge", "discovery-v1.json"), "utf8"),
    );
    await expect(
      post(discovery.socketPath, DSH_BRIDGE_PATHS.leadCall, {
        token,
        sessionId: "session-a",
        name: "worker_list",
        input: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.calls).toEqual([]);
  });

  it("says a session can lead only where its DSH gives leads their tools", async () => {
    const f = await leading();
    expect(f.bridge.leadCapable("ak-session-a")).toBe(true);
    expect(f.bridge.leadCapable("ak-nope")).toBe(false);
    // A DSH whose plugin predates the tools.
    const old = await fixture();
    expect(old.bridge.leadCapable("ak-session-a")).toBe(false);
    const register = old.plugin.hosts.values().next().value!;
    expect(register.token).toBeTruthy();
  });

  it("lists AgentKib's own queued messages by the request that queued them", async () => {
    const f = await fixture();
    await f.control("send", { text: "run the tests" });
    await until(() => f.bridge.live("ak-session-a", true).status === "running");
    const agent = f.dsh.sessions.get("session-a")!.agent;
    const message = (id: string, text: string, rpcId?: string) => ({
      id,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "user", ...(rpcId ? { rpcId } : {}) },
    });
    // A report AgentKib queued, and a message typed in DSH's own window.
    agent.inbox.nextTurn = [message("q1", "report", "request-1"), message("q2", "typed in DSH")];
    f.dsh.emit("agent/status", { agent, status: "running" });
    await until(() => f.bridge.live("ak-session-a", true).queuedCount === 2);
    const queued = (await f.bridge.request({
      operation: "queue-list",
      sessionId: "ak-session-a",
    })) as { data: Array<Record<string, unknown>> };
    expect(queued.data[0]).toMatchObject({ id: "q1", clientUserMessageId: "request-1" });
    expect(queued.data[1]).not.toHaveProperty("clientUserMessageId");
  });
});
