import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeManagedRunnerProcess,
  normalizeObservedPermissionMode,
  type ClaudeRunnerOptions,
} from "../../../packages/backend/src/agents/claude/claude-managed-runner";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/agents/claude/claude-managed-read";
import type { BackendStore } from "../../../packages/backend/src/store";
import type { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { Commands } from "../../../packages/backend/src/commands";

// Frames below are hand-built after the stream-json shape in the Agent SDK reference
// (system/init and system/status may carry permissionMode). No real Claude session is started.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Plan = {
  /** Emitted before the initialize response. */
  beforeInitialize?: unknown[];
  /** Emitted right after the initialize response. */
  afterInitialize?: unknown[];
  /** Emitted when a user frame arrives, before the assistant and result frames. */
  onUser?: unknown[];
};
const init = (...mode: unknown[]) => ({
  type: "system",
  subtype: "init",
  model: "fixture-model",
  ...(mode.length ? { permissionMode: mode[0] } : {}),
});
const status = (...mode: unknown[]) => ({
  type: "system",
  subtype: "status",
  status: null,
  ...(mode.length ? { permissionMode: mode[0] } : {}),
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-claude-permission-")));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  const bin = path.join(root, "bin");
  for (const directory of [workspace, home, config, bin]) mkdirSync(directory, { mode: 0o700 });
  const log = path.join(root, "frames.jsonl");
  const planFile = path.join(root, "plan.json");
  const executable = path.join(bin, "claude");
  // Only this temporary Node program is started; no installed Agent or user config is read.
  writeFileSync(
    executable,
    `#!${process.execPath}\n${String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const plan = () => { try { return JSON.parse(fs.readFileSync(process.env.PERM_PLAN, 'utf8')); } catch { return {}; } };
const log = (value) => fs.appendFileSync(process.env.PERM_LOG, JSON.stringify(value) + '\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const emit = (frames) => {
  for (const frame of frames || []) {
    // A plan can end the process, like a CLI that dies mid-turn.
    if (frame.type === '__exit') { process.stdout.end(() => process.exit(0)); return true; }
    send(frame);
  }
  return false;
};
log({args: process.argv.slice(2)});
let first;
readline.createInterface({input: process.stdin}).on('line', (line) => {
  const frame = JSON.parse(line); log(frame);
  if (frame.type === 'control_request') {
    const initialize = frame.request.subtype === 'initialize';
    if (initialize) emit(plan().beforeInitialize);
    send({type: 'control_response', response: {
      subtype: 'success', request_id: frame.request_id,
      response: initialize ? {
        models: [{value: 'fixture-model', displayName: 'Fixture', supportedEffortLevels: ['low', 'high']}],
        commands: [],
      } : {},
    }});
    if (initialize) emit(plan().afterInitialize);
  } else if (frame.type === 'user') {
    first ||= frame.uuid;
    const transcript = process.env.CLAUDE_CONFIG_DIR + '/' + frame.session_id + '.jsonl';
    const append = row => fs.appendFileSync(transcript, JSON.stringify({sessionId:frame.session_id,cwd:process.cwd(),...row})+'\n');
    append({type:'user',uuid:frame.uuid,message:frame.message});
    if (emit(plan().onUser)) return;
    append({type:'assistant',uuid:require('node:crypto').randomUUID(),parentUuid:frame.uuid,message:{role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'Synthetic complete'}]}});
    send({type: 'assistant', parent_tool_use_id: null, message: {
      id: first, model: 'fixture-model', usage: {input_tokens: 7}, content: [],
    }});
    send({type: 'result', subtype: 'success', is_error: false,
      usage: {input_tokens: 19, output_tokens: 11},
      modelUsage: {'fixture-model': {contextWindow: 100}}, terminal_reason: 'completed'});
  }
});
`}`,
    { mode: 0o700 },
  );
  const environment = {
    PATH: bin,
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    XDG_DATA_HOME: path.join(home, "data"),
    PERM_LOG: log,
    PERM_PLAN: planFile,
  };
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    workspace,
    config,
    executable,
    environment,
    setPlan: (plan: Plan) => writeFileSync(planFile, JSON.stringify(plan)),
    frames: (): Array<Record<string, any>> =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
  };
}

function runnerFor(f: ReturnType<typeof fixture>, options: ClaudeRunnerOptions = {}) {
  const runner = new ClaudeManagedRunnerProcess(
    f.workspace,
    randomUUID(),
    true,
    0,
    f.environment,
    () => undefined,
    true,
    undefined,
    options,
  );
  cleanups.push(() => runner.shutdown());
  return runner;
}
async function turn(runner: ClaudeManagedRunnerProcess, f: ReturnType<typeof fixture>) {
  await runner.send(f.executable, "synthetic turn", randomUUID(), runner.snapshot().revision);
  await expect.poll(() => runner.snapshot().status).toBe("idle");
}

// Long or structured values get a short label so a failing run keeps readable titles.
const malformed: Array<{ label: string; value: unknown }> = [
  { label: "an unknown word", value: "yolo" },
  { label: "the empty string", value: "" },
  { label: "a different case", value: "AUTO" },
  { label: "a number", value: 123 },
  { label: "null", value: null },
  { label: "an array", value: ["auto"] },
  { label: "an object", value: {} },
  { label: "a 5000-character string", value: "x".repeat(5000) },
];

describe("observed permission mode normalization", () => {
  it.each([
    ["default", "default"],
    ["plan", "plan"],
    ["acceptEdits", "acceptEdits"],
    ["auto", "auto"],
    ["dontAsk", "dontAsk"],
    ["bypassPermissions", "bypassPermissions"],
    ["manual", "default"],
  ])("maps %s to %s", (value, expected) => {
    expect(normalizeObservedPermissionMode(value)).toBe(expected);
  });

  it.each([
    ...malformed,
    { label: "a leading space", value: " auto" },
    { label: "undefined", value: undefined },
    { label: "a boolean", value: true },
    { label: "a 10000-character string", value: "x".repeat(10_000) },
  ])("treats $label as unknown", ({ value }) => {
    expect(normalizeObservedPermissionMode(value)).toBeNull();
  });
});

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Claude runner permission mode observation (synthetic offline CLI)",
  () => {
    it.each(["auto", "dontAsk", "bypassPermissions"])(
      "reports an unselectable %s mode from system/init sent before the initialize response",
      async (mode) => {
        const f = fixture();
        f.setPlan({ beforeInitialize: [init(mode)] });
        const runner = runnerFor(f);
        expect(runner.observedPermissionMode).toBeNull();
        await runner.prepare(f.executable);
        expect(runner.observedPermissionMode).toBe(mode);
        // The CLI's own mode is shown, never turned into a selection.
        expect(runner.optionsSnapshot.settings.permissionMode).toBeNull();
        expect(f.frames()[0].args).not.toContain("--permission-mode");
        expect(
          f.frames().filter((frame) => frame.request?.subtype === "set_permission_mode"),
        ).toEqual([]);
      },
    );

    it.each(["auto", "dontAsk", "bypassPermissions"])(
      "reports an unselectable %s mode from system/init sent after the initialize response",
      async (mode) => {
        const f = fixture();
        f.setPlan({ afterInitialize: [init(mode)] });
        const runner = runnerFor(f);
        await runner.prepare(f.executable);
        await expect.poll(() => runner.observedPermissionMode).toBe(mode);
        expect(runner.optionsSnapshot.settings.permissionMode).toBeNull();
      },
    );

    it.each(["auto", "dontAsk", "bypassPermissions"])(
      "reports an unselectable %s mode from system/init that arrives with the first user frame",
      async (mode) => {
        const f = fixture();
        f.setPlan({ onUser: [init(mode)] });
        const runner = runnerFor(f);
        await runner.prepare(f.executable);
        expect(runner.observedPermissionMode).toBeNull();
        await turn(runner, f);
        expect(runner.observedPermissionMode).toBe(mode);
        expect(runner.optionsSnapshot.settings.permissionMode).toBeNull();
        expect(f.frames()[0].args).not.toContain("--permission-mode");
      },
    );

    it.each(["default", "plan", "acceptEdits"] as const)(
      "reports the selectable %s mode as both the observed and the effective mode",
      async (mode) => {
        const f = fixture();
        f.setPlan({ beforeInitialize: [init(mode)] });
        const runner = runnerFor(f);
        await runner.prepare(f.executable);
        expect(runner.observedPermissionMode).toBe(mode);
        expect(runner.optionsSnapshot.settings.permissionMode).toBe(mode);
        expect(f.frames()[0].args).not.toContain("--permission-mode");
      },
    );

    it("normalizes the CLI's manual alias to default", async () => {
      const f = fixture();
      f.setPlan({ beforeInitialize: [init("manual")] });
      const runner = runnerFor(f);
      await runner.prepare(f.executable);
      expect(runner.observedPermissionMode).toBe("default");
      expect(runner.optionsSnapshot.settings.permissionMode).toBe("default");
    });

    it.each(malformed)(
      "ignores $label as a permission report without ending the process",
      async ({ value }) => {
        const f = fixture();
        f.setPlan({ beforeInitialize: [init(value)], onUser: [status(value)] });
        const runner = runnerFor(f);
        await runner.prepare(f.executable);
        await turn(runner, f);
        expect(runner.observedPermissionMode).toBeNull();
        expect(runner.optionsSnapshot.settings.permissionMode).toBeNull();
        expect(runner.snapshot().status).toBe("idle");
        expect(runner.hasWorker).toBe(true);
        expect(runner.optionsSnapshot.settingsAcknowledged).toBe(true);
      },
    );

    it("keeps an earlier valid observation when a later report is malformed or missing", async () => {
      const f = fixture();
      f.setPlan({
        beforeInitialize: [init("auto")],
        onUser: [status("yolo"), status(), init()],
      });
      const runner = runnerFor(f);
      await runner.prepare(f.executable);
      await turn(runner, f);
      expect(runner.observedPermissionMode).toBe("auto");
      expect(runner.snapshot().status).toBe("idle");
    });

    it("follows system/status changes and keeps the selectable effective setting consistent", async () => {
      const f = fixture();
      f.setPlan({ beforeInitialize: [init("plan")] });
      // A user selection (launch flag) of plan is confirmed by init.
      const runner = runnerFor(f, { permissionMode: "plan" });
      await runner.prepare(f.executable);
      expect(f.frames()[0].args.slice(-2)).toEqual(["--permission-mode", "plan"]);
      expect(runner.observedPermissionMode).toBe("plan");
      expect(runner.optionsSnapshot.settings.permissionMode).toBe("plan");

      f.setPlan({ onUser: [status("auto")] });
      await turn(runner, f);
      expect(runner.observedPermissionMode).toBe("auto");
      // The stale plan selection must not linger beside an observed auto mode.
      expect(runner.optionsSnapshot.settings.permissionMode).toBeNull();

      f.setPlan({ onUser: [status("default")] });
      await turn(runner, f);
      expect(runner.observedPermissionMode).toBe("default");
      expect(runner.optionsSnapshot.settings.permissionMode).toBe("default");

      f.setPlan({ onUser: [status("bypassPermissions")] });
      await turn(runner, f);
      expect(runner.observedPermissionMode).toBe("bypassPermissions");
      expect(runner.optionsSnapshot.settings.permissionMode).toBeNull();
    });

    it("does not restore a selected mode over an unselectable init that precedes the initialize response", async () => {
      const f = fixture();
      f.setPlan({ beforeInitialize: [init("auto")] });
      const runner = runnerFor(f, { permissionMode: "plan" });
      await runner.prepare(f.executable);
      expect(runner.observedPermissionMode).toBe("auto");
      expect(runner.optionsSnapshot.settings.permissionMode).toBeNull();
      expect(runner.optionsSnapshot.settingsAcknowledged).toBe(true);
    });

    it("still confirms the explicit selection when the CLI reports nothing", async () => {
      const f = fixture();
      f.setPlan({});
      const runner = runnerFor(f, { permissionMode: "acceptEdits" });
      await runner.prepare(f.executable);
      expect(runner.observedPermissionMode).toBeNull();
      expect(runner.optionsSnapshot.settings.permissionMode).toBe("acceptEdits");
    });

    it("records a successful set_permission_mode as the observed mode and replaces an unselectable one", async () => {
      const f = fixture();
      f.setPlan({ beforeInitialize: [init("auto")] });
      const runner = runnerFor(f);
      await runner.prepare(f.executable);
      expect(runner.observedPermissionMode).toBe("auto");
      await runner.configure({ permissionMode: "plan" }, runner.snapshot().revision);
      expect(
        f.frames().filter((frame) => frame.request?.subtype === "set_permission_mode"),
      ).toEqual([
        expect.objectContaining({ request: { subtype: "set_permission_mode", mode: "plan" } }),
      ]);
      expect(runner.observedPermissionMode).toBe("plan");
      expect(runner.optionsSnapshot.settings.permissionMode).toBe("plan");
      // A model-only change leaves the observation alone.
      await runner.configure({ model: "fixture-model" }, runner.snapshot().revision);
      expect(runner.observedPermissionMode).toBe("plan");
    });

    it("forgets the observation when the worker restarts", async () => {
      const f = fixture();
      f.setPlan({ beforeInitialize: [init("auto")] });
      const runner = runnerFor(f);
      await runner.prepare(f.executable);
      expect(runner.observedPermissionMode).toBe("auto");
      await runner.retireIfInactive();
      expect(runner.hasWorker).toBe(false);
      f.setPlan({});
      await runner.prepare(f.executable);
      expect(runner.hasWorker).toBe(true);
      expect(runner.observedPermissionMode).toBeNull();
      expect(runner.optionsSnapshot.settings.permissionMode).toBeNull();
    });

    it("forgets the observation when the process fails", async () => {
      const f = fixture();
      f.setPlan({
        beforeInitialize: [init("auto")],
        // A frame the runner cannot follow (an unknown frame type is only ignored).
        onUser: [
          {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: 5 } },
          },
          { type: "__exit" },
        ],
      });
      const runner = runnerFor(f);
      await runner.prepare(f.executable);
      expect(runner.observedPermissionMode).toBe("auto");
      await runner
        .send(f.executable, "fail this turn", randomUUID(), runner.snapshot().revision)
        .catch(() => undefined);
      await expect.poll(() => runner.snapshot().status).toBe("outcome-unknown");
      expect(runner.observedPermissionMode).toBeNull();
      expect(runner.optionsSnapshot.settingsAcknowledged).toBe(false);
      await expect.poll(() => runner.hasWorker).toBe(false);
    });
  },
);

const deviceId = "browser-device-a";
async function create(owner: ClaudeManagedReadOwner, fields: Record<string, unknown> = {}) {
  return (await owner.request({
    operation: "create",
    workspaceId: "workspace",
    requestId: randomUUID(),
    deviceId,
    ...fields,
  })) as Record<string, any>;
}
async function control(
  owner: ClaudeManagedReadOwner,
  id: string,
  operation: string,
  fields: Record<string, unknown> = {},
) {
  const live = await owner.live(id, true);
  return (await owner.request({
    operation,
    sessionId: id,
    deviceId,
    requestId: randomUUID(),
    runtimeBootId: owner.bootId,
    expectedRevision: live.revision,
    experimentalEnabled: true,
    ...fields,
  })) as Record<string, any>;
}

const liveOf = async (owner: ClaudeManagedReadOwner, id: string) =>
  (await owner.live(id, true)) as Record<string, any>;
// vi.spyOn(...).mock.contexts is typed as {}; these are the runner instances the host created.
const runnerAt = (spy: { mock: { contexts: unknown[] } }, index: number) =>
  spy.mock.contexts[index] as ClaudeManagedRunnerProcess;

function hostFixture(version: string | null = "2.1.296") {
  const f = fixture();
  const events: Array<{
    id: string;
    type: string;
    payload: Record<string, any>;
    live: Record<string, any>;
  }> = [];
  const commands = {
    run: vi.fn(async (command: string, args: string[]) => {
      if (command === "/bin/ps") return { success: true, bytes: Buffer.from("") };
      if (args[0] === "agents") return { success: true, bytes: Buffer.from("[]\n") };
      expect(args).toEqual(["--version"]);
      return {
        success: true,
        bytes: Buffer.from(version === null ? "not a version\n" : `${version} (Claude Code)\n`),
      };
    }),
  } as unknown as Commands;
  const store = {
    workspacePath: () => f.workspace,
    sessions: { id: (_agent: string, id: string) => id },
  } as unknown as BackendStore;
  const sessions = {
    verifiedClaudeControlTarget: (id: string) => path.join(f.config, `${id}.jsonl`),
  } as unknown as SessionReaders;
  const owner = new ClaudeManagedReadOwner(
    store,
    sessions,
    commands,
    f.root,
    f.environment,
    randomUUID(),
    {
      publish: (id, type, payload, live) => events.push({ id, type, payload, live }),
      alias: () => undefined,
    },
  );
  cleanups.push(() => owner.shutdown());
  const patches = (id: string) =>
    events.filter((event) => event.id === id && event.type === "state");
  const idle = (id: string) =>
    expect.poll(async () => (await owner.live(id, true)).status).toBe("idle");
  return { ...f, owner, events, patches, idle };
}

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Claude host permission view (synthetic offline CLI)",
  () => {
    it.each([
      ["2.1.284", false],
      ["2.1.285", true],
      ["2.1.296", true],
    ])(
      "marks a never-observed session as possibly auto only from 2.1.285 (version %s)",
      async (version, hint) => {
        const f = hostFixture(version);
        const created = await create(f.owner);
        const expected = hint ? { mode: null, possiblyAuto: true } : { mode: null };
        expect(created.live.permission).toEqual(expected);
        await control(f.owner, created.sessionId, "send", { text: "synthetic turn" });
        await f.idle(created.sessionId);
        // live() and the stream patches share one version source and cannot disagree.
        expect((await liveOf(f.owner, created.sessionId)).permission).toEqual(expected);
        const patches = f.patches(created.sessionId);
        expect(patches.length).toBeGreaterThan(0);
        for (const patch of patches) {
          expect(patch.payload.permission).toEqual(expected);
          expect(patch.live.permission).toEqual(expected);
        }
        // The hint never replaces the unknown mode with a guess.
        expect((await liveOf(f.owner, created.sessionId)).permission.mode).toBeNull();
      },
    );

    it("does not add the hint when the user selected a mode or the version is unknown", async () => {
      const selected = hostFixture("2.1.296");
      const created = await create(selected.owner, { permissionMode: "plan" });
      expect(created.live.permission).toEqual({ mode: null });
      expect((await liveOf(selected.owner, created.sessionId)).permission).toEqual({
        mode: null,
      });

      const unknown = hostFixture(null);
      const id = randomUUID();
      mkdirSync(path.join(unknown.root, "claude-managed"), { recursive: true, mode: 0o700 });
      writeFileSync(
        path.join(unknown.root, "claude-managed", `${id}.json`),
        JSON.stringify({
          version: 1,
          id,
          workspaceId: "workspace",
          workspace: unknown.workspace,
          registeredWorkspace: unknown.workspace,
          home: unknown.environment.CLAUDE_CONFIG_DIR,
          nativeId: randomUUID(),
          title: "Synthetic",
          createdAt: new Date().toISOString(),
          adopted: false,
          released: false,
          fresh: true,
          fingerprint: null,
          completedRequests: [],
          snapshot: {
            status: "idle",
            revision: 0,
            turnId: null,
            sendEnabled: true,
            stopEnabled: false,
            approvals: [],
            questions: [],
            streamText: "",
          },
        }),
        { mode: 0o600 },
      );
      const live = await liveOf(unknown.owner, id);
      expect(live.cliVersion).toBeNull();
      expect(live.permission).toEqual({ mode: null });
    });

    it.each(["auto", "dontAsk", "bypassPermissions"])(
      "shows the %s mode reported by the CLI and keeps it out of the selectable settings",
      async (mode) => {
        const f = hostFixture();
        f.setPlan({ beforeInitialize: [init(mode)] });
        const created = await create(f.owner);
        await control(f.owner, created.sessionId, "send", { text: "synthetic turn" });
        await f.idle(created.sessionId);
        const live = await liveOf(f.owner, created.sessionId);
        expect(live.permission).toEqual({ mode });
        expect(live.settings.current.permissionMode).toBeNull();
        expect(await f.owner.settingsState(created.sessionId)).toMatchObject({
          current: { permissionMode: null },
          permissionModes: [{ id: "default" }, { id: "plan" }, { id: "acceptEdits" }],
        });
        const patches = f.patches(created.sessionId);
        expect(patches.at(-1)?.payload.permission).toEqual({ mode });
        expect(patches.at(-1)?.live.permission).toEqual({ mode });
        // The launch never forced a mode.
        for (const frame of f.frames().filter((item) => item.args))
          expect(frame.args).not.toContain("--permission-mode");
      },
    );

    it("shows a selectable mode reported by the CLI without a hint", async () => {
      const f = hostFixture();
      f.setPlan({ beforeInitialize: [init("default")] });
      const created = await create(f.owner);
      await control(f.owner, created.sessionId, "send", { text: "synthetic turn" });
      await f.idle(created.sessionId);
      const live = await liveOf(f.owner, created.sessionId);
      expect(live.permission).toEqual({ mode: "default" });
      expect(live.settings.current.permissionMode).toBe("default");
    });

    it("keeps the last observed mode after the worker retires, then lets a new report replace it", async () => {
      const f = hostFixture();
      const send = vi.spyOn(ClaudeManagedRunnerProcess.prototype, "send");
      f.setPlan({ beforeInitialize: [init("auto")] });
      const created = await create(f.owner);
      const id = created.sessionId as string;
      await control(f.owner, id, "send", { text: "first turn" });
      await f.idle(id);
      expect((await liveOf(f.owner, id)).permission).toEqual({ mode: "auto" });

      const runner = runnerAt(send, 0);
      f.events.length = 0;
      await expect(runner.retireIfInactive()).resolves.toBe(true);
      expect(runner.hasWorker).toBe(false);
      const retired = f.patches(id).at(-1);
      // A retired worker is not hidden behind a possibly-auto hint: the last report is kept.
      expect(retired?.payload.permission).toEqual({ mode: "auto", previous: true });
      expect((await liveOf(f.owner, id)).permission).toEqual({ mode: "auto", previous: true });

      f.setPlan({ beforeInitialize: [init("plan")] });
      await control(f.owner, id, "send", { text: "second turn" });
      await f.idle(id);
      expect((await liveOf(f.owner, id)).permission).toEqual({ mode: "plan" });
      expect(f.patches(id).at(-1)?.payload.permission).toEqual({ mode: "plan" });
    });

    it("shows the previous mode while a restarted worker has not reported yet", async () => {
      const f = hostFixture();
      const send = vi.spyOn(ClaudeManagedRunnerProcess.prototype, "send");
      f.setPlan({ beforeInitialize: [init("bypassPermissions")] });
      const created = await create(f.owner);
      const id = created.sessionId as string;
      await control(f.owner, id, "send", { text: "first turn" });
      await f.idle(id);
      await runnerAt(send, 0).retireIfInactive();
      // The next worker only reports with its first user frame.
      f.setPlan({ onUser: [init("dontAsk")] });
      f.events.length = 0;
      await control(f.owner, id, "send", { text: "second turn" });
      await f.idle(id);
      const modes = f.patches(id).map((patch) => patch.payload.permission);
      expect(modes[0]).toEqual({ mode: "bypassPermissions", previous: true });
      expect(modes.at(-1)).toEqual({ mode: "dontAsk" });
      expect((await liveOf(f.owner, id)).permission).toEqual({ mode: "dontAsk" });
    });

    it("clears the permission explicitly when the session is released and forgets the last mode", async () => {
      const f = hostFixture();
      f.setPlan({ beforeInitialize: [init("auto")] });
      const created = await create(f.owner);
      const id = created.sessionId as string;
      await control(f.owner, id, "send", { text: "synthetic turn" });
      await f.idle(id);
      expect((await liveOf(f.owner, id)).permission).toEqual({ mode: "auto" });
      f.events.length = 0;
      await f.owner.request({
        operation: "release",
        sessionId: id,
        requestId: randomUUID(),
        deviceId,
        runtimeBootId: f.owner.bootId,
        expectedRevision: (await f.owner.live(id, true)).revision,
      });
      const last = f.patches(id).at(-1);
      expect(last?.payload.permission).toEqual({ mode: null });
      const released = await liveOf(f.owner, id);
      expect(released).toMatchObject({
        status: "idle",
        sendEnabled: true,
        executionLocation: null,
      });
      // Neither a stale mode nor a hint for a session this host no longer runs.
      expect(released.permission).toEqual({ mode: null });
    });

    it("never lets a failing permission view end the running session", async () => {
      const f = hostFixture();
      f.setPlan({ beforeInitialize: [init("auto")] });
      const send = vi.spyOn(ClaudeManagedRunnerProcess.prototype, "send");
      let firstGetterFailure: number | undefined;
      vi.spyOn(
        ClaudeManagedRunnerProcess.prototype,
        "observedPermissionMode",
        "get",
      ).mockImplementation(() => {
        firstGetterFailure ??= f.events.length;
        throw new Error("synthetic getter failure");
      });
      const created = await create(f.owner);
      const id = created.sessionId as string;
      await control(f.owner, id, "send", { text: "first turn" });
      await f.idle(id);
      const runner = runnerAt(send, 0);
      expect(runner.snapshot().status).toBe("idle");
      expect(runner.hasWorker).toBe(true);
      expect(await liveOf(f.owner, id)).not.toHaveProperty("permission");
      expect(f.patches(id).length).toBeGreaterThan(0);
      expect(firstGetterFailure).toBeDefined();
      let preStartHints = 0;
      for (const patch of f.patches(id)) {
        if (patch.payload.permission !== undefined) {
          // Before a worker exists, no observed-mode getter is read and the CLI hint is valid.
          expect(patch.payload.status).toBe("starting");
          expect(patch.payload.permission).toEqual({ mode: null, possiblyAuto: true });
          expect(f.events.indexOf(patch)).toBeLessThan(firstGetterFailure!);
          preStartHints += 1;
        } else expect(patch.payload).not.toHaveProperty("permission");
      }
      expect(preStartHints).toBeGreaterThan(0);
      expect(f.patches(id).some((patch) => patch.payload.status !== "starting")).toBe(true);
      // Later frames are still processed and the session still takes turns.
      await control(f.owner, id, "send", { text: "second turn" });
      await f.idle(id);
      expect(runner.snapshot().status).toBe("idle");
      expect(runner.hasWorker).toBe(true);
    });
  },
);
