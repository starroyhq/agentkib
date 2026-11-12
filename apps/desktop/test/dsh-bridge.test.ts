// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { DshBridge, dshConversationEvents } from "../../../packages/backend/src/dsh-bridge";
import { readControlReceipt } from "../../../packages/backend/src/control-receipt";
import {
  createBridge,
  DSH_BRIDGE_PATHS,
  managedHost,
} from "../../../packages/dsh-bridge-plugin/bridge.js";
import { post } from "../../../packages/dsh-bridge-plugin/client.js";
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
function fakeDsh(cwd: string) {
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
  // DSH keeps each image in its own store, named after the digest of its bytes.
  const images = new Map<string, { ref: any; data: string }>();
  let imagesRefused = false;
  const attachmentInvalid = (reason: string) =>
    Object.assign(new Error(reason), { code: "session/attachment-invalid", details: { reason } });
  const archived = new Set<string>();
  const followers = new Set<(frame: unknown) => void>();
  const pushArchived = () => {
    for (const push of followers) push({ type: "archived", archivedSessionIds: [...archived] });
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
    },
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
      // Only an image the session's own log refers to.
      async attachment(request: any) {
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
      },
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
          default: { provider: "deepseek", model: "deepseek-chat" },
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
        selections.push(request);
        const { sessionId: _sessionId, ...selected } = request;
        sessions.get(request.sessionId)!.selection = selected;
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
      async *follow(signal: AbortSignal) {
        const queue: unknown[] = [
          {
            type: "baseline",
            value: { items: [], archivedSessionIds: [...archived], pinnedSessionIds: [] },
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
  const create = (id: string, title: string, parentSessionId?: string) => {
    const agent = {
      id,
      status: "idle",
      inbox: { nextTurn: [], nextStep: [] },
      session: { id, seq: 0 },
    };
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

async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-dsh-test-")));
  const workspace = path.join(root, "workspace");
  const agentkibHome = path.join(root, "agentkib-home");
  mkdirSync(workspace);
  const publish = vi.fn();
  const changed: string[][] = [];
  const bridge = new DshBridge({
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
    sessionsChanged: (ids) => changed.push(ids),
    publish,
  });
  bridge.initialize();
  const dsh = fakeDsh(workspace);
  dsh.create("session-a", "First DSH session");
  const plugin = createBridge(dsh.ctx, {
    roots: [agentkibHome],
    dshVersion: "0.2.1-rc.5",
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
  await until(() => bridge.handles("ak-session-a"));
  // The first report lists the session; the next acknowledges the watch list.
  await until(() => plugin.hosts.size > 0 && [...plugin.hosts.values()][0]!.watch.has("session-a"));
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
    expect(stopped).toMatchObject({ accepted: true });
    expect(f.dsh.cancels).toEqual(["session-a"]);
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

  it("sends images through DSH's own prompt and reads them back for its history", async () => {
    const f = await fixture();
    expect(f.bridge.capabilities("ak-session-a", true).features).toMatchObject({
      attachments: { available: true },
    });
    const file = path.join(f.root, "shot.png");
    writeFileSync(file, PNG);
    const sha256 = createHash("sha256").update(PNG).digest("hex");
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
      images: [{ id: `dsh-image-v1-${sha256}`, mimeType: "image/png", name: "shot.png" }],
    });
    await expect(f.bridge.image("session-a", `dsh-image-v1-${sha256}`)).resolves.toEqual({
      mimeType: "image/png",
      base64: PNG.toString("base64"),
    });
    // DSH reads an image only for a session whose log refers to it.
    await expect(f.bridge.image("session-b", `dsh-image-v1-${sha256}`)).rejects.toThrow(
      "session-image-unavailable",
    );
    await expect(f.bridge.image("session-a", "session-image-v1-x")).rejects.toThrow(
      "session-image-invalid",
    );
  });

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

  it("marks a queued message with images or files, which an edit would drop", async () => {
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
    ];
    f.dsh.emit("agent/status", { agent, status: "running" });
    await until(() => f.bridge.live("ak-session-a", true).queuedCount === 2);
    const queued = (await f.bridge.request({
      operation: "queue-list",
      sessionId: "ak-session-a",
    })) as { data: { input: unknown[] }[] };
    expect(queued.data.map((item) => item.input)).toEqual([
      [{ type: "text", text: "see this" }, { type: "image" }],
      [
        { type: "text", text: "read this" },
        { type: "text", text: 'User attached file "a.txt": /tmp/a.txt' },
      ],
    ]);
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
    const f = await fixture();
    let lose!: () => void;
    f.dsh.ctx.sessionController.prompt = () =>
      new Promise((_resolve, reject) => {
        lose = () => reject(new Error("lost"));
      });
    const sent = await f.control("send", { text: "never taken" });
    expect(sent).toMatchObject({ controlOutcome: "unknown" });
    lose();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await f.bridge.request({
      operation: "reconcile",
      sessionId: "ak-session-a",
      experimentalEnabled: true,
    });
    await until(
      () =>
        readControlReceipt(f.bridge.options.dataDir, {
          requestId: sent.requestId,
          deviceId: "device-1",
        }).status === "not-dispatched",
    );
    expect(f.bridge.live("ak-session-a", true)).toMatchObject({ sendEnabled: true });
  });

  it("keeps read history after DSH quits and reads it again when DSH returns", async () => {
    const f = await fixture();
    f.dsh.append("session-a", "user/message", {
      role: "user",
      id: "m1",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "r1" },
    });
    const page = await f.bridge.events("session-a", null, 50);
    expect(page.events).toHaveLength(1);
    f.plugin.close();
    // The dropped poll is noticed within the grace period, long before OFFLINE_MS.
    await until(() => f.bridge.live("ak-session-a", true).reason === "dsh-runtime-offline");
    expect(f.bridge.list(f.workspace).sessions).toEqual([
      expect.objectContaining({ native_ref: "session-a", availability: "readable" }),
    ]);
    // What this run read stays visible; an older page it never read is not made up.
    await expect(f.bridge.events("session-a", null, 50)).resolves.toEqual(page);
    await expect(f.bridge.events("session-a", "dsh-v1:1", 50)).rejects.toThrow(
      "dsh-runtime-offline",
    );
    f.publish.mockClear();
    const again = createBridge(f.dsh.ctx, {
      roots: [f.agentkibHome],
      dshVersion: "0.2.1-rc.5",
      discoveryMs: 50,
      debounceMs: 10,
    });
    cleanups.push(() => again.close());
    await until(() =>
      f.publish.mock.calls.some(
        ([id, type, payload]) =>
          id === "ak-session-a" && type === "invalidate" && payload.domains?.includes("history"),
      ),
    );
    expect(f.bridge.live("ak-session-a", true).executionLocation).toBe("external");
  });

  it("lists DSH sessions with empty history when no DSH ran since AgentKib started", async () => {
    const f = await fixture();
    f.plugin.close();
    await f.bridge.close();
    const reopened = new DshBridge({ ...f.bridge.options, discoveryFile: undefined });
    cleanups.push(() => reopened.close());
    expect(reopened.list(f.workspace).sessions).toEqual([
      expect.objectContaining({ native_ref: "session-a", availability: "readable" }),
    ]);
    // The live state explains why; the history is not an error.
    await expect(reopened.events("session-a", null, 50)).resolves.toEqual({
      events: [],
      next_cursor: null,
      warnings: [],
    });
    expect(reopened.live("ak-session-a", true)).toMatchObject({
      status: "unsupported",
      reason: "dsh-runtime-offline",
      sendEnabled: false,
    });
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
    ).toEqual([{ id: "1", placement: "queued", text: "queued", images: 0, rpcId: "r" }]);
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
    // A permission preset applies to the next approval, so it still changes during the turn.
    expect(features().settings).toEqual({ available: true });
    // The model picker still reads, and says why it cannot change now.
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
        policy: { available: true },
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
    expect(await f.control("settings", { effort: "high" })).toMatchObject({ accepted: true });
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

  it("starts a new DSH session in a registered workspace, once per request", async () => {
    const f = await fixture();
    // The new-task form offers DSH's Agent presets; a shipped one has no name of its own.
    expect(await f.bridge.createOptions()).toEqual({
      available: true,
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
    expect(await f.control("settings", { mode: "plan" })).toMatchObject({ accepted: true });
    expect(f.dsh.executed.at(-1)).toBe("/plan");
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

    // A preset changes during a turn; the model waits for the turn to end.
    await f.control("send", { text: "run the tests" });
    await until(() => f.bridge.live("ak-session-a", true).status === "running");
    await settings();
    expect(await f.control("settings", { policyId: "danger-full-access" })).toMatchObject({
      accepted: true,
    });
    expect(f.dsh.permissionOf.get("session-a")).toBe("danger-full-access");
    expect(
      await f.control("settings", { model: "mock%2Flocal/m-1", policyId: "workspace-write" }),
    ).toMatchObject({ controlOutcome: "not-dispatched", reason: "session-busy" });
    expect(f.dsh.permissionOf.get("session-a")).toBe("danger-full-access");

    // Idle again: a new preset and a new model are two steps, preset first.
    f.dsh.finishTurn("session-a", "done");
    await until(() => f.bridge.live("ak-session-a", true).status === "idle");
    await settings();
    expect(
      await f.control("settings", { model: "mock%2Flocal/m-1", policyId: "workspace-write" }),
    ).toMatchObject({ accepted: true });
    expect(f.dsh.permissionOf.get("session-a")).toBe("workspace-write");
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
    enabled?: () => boolean;
    available?: { available: true } | { available: false; reason: any };
    idleMs?: number;
    desktopRunning?: boolean;
    /** No session, and no DSH of the user's has ever run: a fresh DSH install. */
    empty?: boolean;
    /** How long a background DSH takes to exit once told to stop. */
    stopDelayMs?: number;
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
    dshVersion: "0.2.1-rc.5",
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
        plugin: createBridge(dsh.ctx, { ...pluginOptions, pid }),
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
  bridge = new DshBridge({
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
    sessionsChanged: () => undefined,
    publish: vi.fn(),
    managed: {
      runtime: managed,
      enabled: options.enabled ?? (() => true),
      idleMs: options.idleMs ?? 60_000,
      desktopIdleMs: 200,
      reviewMs: 50,
      settleMs: 300,
    },
  });
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
  return { root, agentkibHome, bridge, dsh, managed, starts, stops, send, userDsh, pluginOptions };
}

describe("DeepSeek Harness started in the background", () => {
  it("lets a session be sent to while no DSH runs, and starts one to take it", async () => {
    const f = await managedFixture();
    const offline = f.bridge.live("ak-session-a", true);
    expect(offline).toMatchObject({
      status: "idle",
      sendEnabled: true,
      executionLocation: null,
    });
    expect(offline.reason).toBeUndefined();
    expect(f.bridge.capabilities("ak-session-a", true)).toMatchObject({
      features: { send: { available: true }, stop: { available: false } },
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
      status: "idle",
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

  it("starts nothing when the setting is off, and says why it cannot start", async () => {
    const off = await managedFixture({ enabled: () => false });
    expect(off.bridge.live("ak-session-a", true)).toMatchObject({
      status: "unsupported",
      reason: "dsh-runtime-offline",
      sendEnabled: false,
    });
    expect(await off.send("not sent")).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "dsh-runtime-offline",
    });
    expect(off.starts).toHaveLength(0);

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

  it("starts DSH to read a session someone opens, but never for search", async () => {
    const f = await managedFixture();
    await expect(f.bridge.conversation("session-a")).rejects.toThrow("dsh-runtime-offline");
    expect(f.starts).toHaveLength(0);
    expect(f.bridge.documentStatus("session-a")).toEqual({ status: "supported" });
    await f.bridge.events("session-a", null, 20);
    expect(f.starts).toHaveLength(1);
    expect(f.bridge.live("ak-session-a", true).executionLocation).toBe("agentkib");
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
    const options = await f.bridge.createOptions();
    expect(options.available).toBe(true);
    expect(options.agentPresets?.length).toBeGreaterThan(0);
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
