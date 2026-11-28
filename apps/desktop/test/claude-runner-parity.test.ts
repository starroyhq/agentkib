import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeManagedRunnerProcess,
  type ClaudeRunnerOptions,
  type ClaudeRunnerTerminalResult,
} from "../../../packages/backend/src/agents/claude/claude-managed-runner";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(mode = "ordinary", options: ClaudeRunnerOptions = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-claude-runner-parity-")));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const config = path.join(root, "config");
  for (const directory of [home, workspace, config]) mkdirSync(directory, { mode: 0o700 });
  const log = path.join(root, "synthetic-frames.jsonl");
  const executable = path.join(root, "synthetic-claude");
  writeFileSync(
    executable,
    `#!${process.execPath}\n${String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const log = (value) => fs.appendFileSync(process.env.PARITY_LOG, JSON.stringify(value) + '\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
log({args: process.argv.slice(2)});
let first, firstSession;
readline.createInterface({input:process.stdin}).on('line', line => {
  const frame = JSON.parse(line); log(frame);
  if(frame.type === 'control_request') {
    if(frame.request.subtype !== 'initialize' && process.env.PARITY_MODE === 'timeout') return;
    if(frame.request.subtype === 'initialize' && process.env.PARITY_MODE === 'model-alias')
      send({type:'system',subtype:'init',model:'fixture-actual-model',permissionMode:'plan'});
    if(frame.request.subtype === 'initialize' && process.env.PARITY_MODE === 'inherited-plan')
      send({type:'system',subtype:'init',model:'fixture-model',permissionMode:'plan'});
    if(first && frame.request.subtype === 'set_model' && process.env.PARITY_MODE.startsWith('model-replay-')) {
      send({type:'user',isReplay:true,parent_tool_use_id:null,session_id:firstSession,uuid:first,
        message:{role:'user',content:process.env.PARITY_MODE === 'model-replay-output'
          ? '<local-command-stdout>Set model to \`fixture-model (fixture-actual-model)\`</local-command-stdout>'
          : 'Unexpected user message'}});
    }
    const response = frame.request.subtype === 'initialize' ? {
      models: process.env.PARITY_MODE === 'model-alias'
        ? [{value:'fixture-alias',resolvedModel:'fixture-actual-model',displayName:'Fixture',supportedEffortLevels:['low','high']}]
        : [{value:'fixture-model',displayName:'Fixture',supportedEffortLevels:['low','high'],
            ...(process.env.PARITY_MODE === 'bad-resolved-model' ? {resolvedModel:[]} : {})}],
      commands: [{name:'fixture:check',description:'Synthetic command'}],
      account: {apiKeySource:'must-not-be-forwarded'},
    } : {};
    send({type:'control_response',response:{
      subtype:'success', request_id: process.env.PARITY_MODE === 'wrong-id' &&
        frame.request.subtype !== 'initialize' ? 'unrelated' : frame.request_id, response,
    }});
  } else if(frame.type === 'user') {
    first ||= frame.uuid;
    firstSession ||= frame.session_id;
    if(process.env.PARITY_MODE === 'inherited-plan-late')
      send({type:'system',subtype:'init',model:'fixture-model',permissionMode:'plan'});
    if(process.env.PARITY_MODE === 'steer' && !frame.priority) return;
    send({type:'assistant',parent_tool_use_id:null,message:{
      id: first, model:'fixture-model', usage:{input_tokens:7},content:[],
    }});
    if(process.env.PARITY_MODE === 'missing-result') {
      process.stdout.end(() => process.exit(0));
      return;
    }
    send({type:'result',subtype:process.env.PARITY_MODE === 'error' ? 'error_during_execution' : 'success',
      is_error:process.env.PARITY_MODE === 'error', usage:{input_tokens:19,output_tokens:11,cache_read_input_tokens:23},
      modelUsage:{'fixture-model':{contextWindow:100}},total_cost_usd:0.012,
      terminal_reason: process.env.PARITY_MODE === 'aborted' ? 'aborted_tools' : 'completed',
    });
  }
});
`}`,
    { mode: 0o700 },
  );
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const results: ClaudeRunnerTerminalResult[] = [];
  const runner = new ClaudeManagedRunnerProcess(
    workspace,
    randomUUID(),
    true,
    0,
    {
      HOME: home,
      PATH: root,
      XDG_DATA_HOME: path.join(home, "data"),
      CLAUDE_CONFIG_DIR: config,
      PARITY_LOG: log,
      PARITY_MODE: mode,
    },
    () => undefined,
    true,
    undefined,
    { ...options, onResult: (result) => results.push(result) },
  );
  cleanups.push(() => runner.shutdown());
  const frames = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { runner, executable, frames, results };
}

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Claude remote runner protocol",
  () => {
    it("prepares and discovers options without sending a model turn; settings require native acknowledgements", async () => {
      const f = fixture();
      const discovered = await f.runner.prepare(f.executable);
      expect(discovered).toMatchObject({
        models: [{ value: "fixture-model" }],
        commands: [{ name: "fixture:check" }],
        settingsAcknowledged: true,
      });
      expect(discovered).not.toHaveProperty("account");
      expect(f.runner.snapshot()).toMatchObject({
        status: "idle",
        turnId: "",
        terminalResult: null,
      });
      const changing = f.runner.configure(
        { model: "fixture-model", effort: "high", permissionMode: "plan" },
        f.runner.snapshot().revision,
      );
      expect(f.runner.optionsSnapshot.settingsAcknowledged).toBe(false);
      await expect(changing).resolves.toMatchObject({
        settings: { model: "fixture-model", effort: "high", permissionMode: "plan" },
        settingsAcknowledged: true,
      });
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(0);
      expect(
        f
          .frames()
          .filter((frame) => frame.type === "control_request")
          .map((frame) => frame.request),
      ).toEqual([
        { subtype: "initialize", hooks: null },
        { subtype: "set_model", model: "fixture-model" },
        { subtype: "apply_flag_settings", settings: { effortLevel: "high" } },
        { subtype: "set_permission_mode", mode: "plan" },
      ]);
    });

    it("keeps an idle runner ready when set_model replays its local command output", async () => {
      const f = fixture("model-replay-output");
      const firstTurn = randomUUID();
      await f.runner.send(f.executable, "first turn", firstTurn, 0);
      await expect.poll(() => f.results.length).toBe(1);
      const before = f.runner.snapshot();
      await expect(
        f.runner.configure({ model: "fixture-model", effort: "high" }, before.revision),
      ).resolves.toMatchObject({
        settings: { model: "fixture-model", effort: "high" },
        settingsAcknowledged: true,
      });
      expect(f.runner.snapshot()).toMatchObject({
        status: "idle",
        turnId: firstTurn,
        terminalResult: before.terminalResult,
      });
      expect(f.results).toHaveLength(1);
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(1);

      const nextTurn = randomUUID();
      await f.runner.send(f.executable, "next turn", nextTurn, f.runner.snapshot().revision);
      await expect
        .poll(() => f.results.map((result) => result.turnId))
        .toEqual([firstTurn, nextTurn]);
      expect(f.frames().filter((frame) => frame.args)).toHaveLength(1);
      expect(f.frames().filter((frame) => frame.type === "user")).toMatchObject([
        { uuid: firstTurn },
        { uuid: nextTurn },
      ]);
    });

    it("still rejects an unexpected user frame while waiting for set_model", async () => {
      const f = fixture("model-replay-user");
      await f.runner.send(f.executable, "first turn", randomUUID(), 0);
      await expect.poll(() => f.results.length).toBe(1);
      await expect(
        f.runner.configure({ model: "fixture-model" }, f.runner.snapshot().revision),
      ).rejects.toThrow("Claude user frame outside an active turn");
      expect(f.runner.snapshot().status).toBe("outcome-unknown");
    });

    it("rejects unavailable model and effort before sending controls", async () => {
      const f = fixture();
      await f.runner.prepare(f.executable);
      const revision = f.runner.snapshot().revision;
      await expect(f.runner.configure({ model: "unknown" }, revision)).rejects.toThrow(
        "unsupported Claude model",
      );
      await expect(
        f.runner.configure({ model: "fixture-model", effort: "max" }, revision),
      ).rejects.toThrow("unsupported Claude effort");
      expect(f.frames().filter((frame) => frame.type === "control_request")).toHaveLength(1);
      expect(f.runner.snapshot().status).toBe("idle");
    });

    it("validates effort against the resolved inherited model without selecting the alias", async () => {
      const f = fixture("model-alias");
      const discovered = await f.runner.prepare(f.executable);
      expect(discovered.models[0]).toMatchObject({
        value: "fixture-alias",
        resolvedModel: "fixture-actual-model",
      });
      await f.runner.configure({ effort: "high" }, f.runner.snapshot().revision);
      expect(f.runner.optionsSnapshot.settings).toEqual({
        model: "fixture-actual-model",
        effort: "high",
        permissionMode: "plan",
      });
      expect(f.frames().filter((frame) => frame.request?.subtype === "set_model")).toEqual([]);
    });

    it("rejects malformed resolved models and shares failure cleanup with immediate shutdown", async () => {
      const f = fixture("bad-resolved-model");
      await expect(f.runner.prepare(f.executable)).rejects.toThrow("invalid Claude resolved model");
      await expect(Promise.all([f.runner.shutdown(), f.runner.shutdown()])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(f.runner.snapshot().status).toBe("outcome-unknown");
      expect(f.runner.optionsSnapshot.settingsAcknowledged).toBe(false);
      expect(f.runner.hasWorker).toBe(false);
      expect(f.runner.cleanupError).toBeNull();
    });

    it("keeps inherited permission settings unknown until the CLI reports them", async () => {
      const f = fixture();
      const discovered = await f.runner.prepare(f.executable);
      expect(discovered.settingsAcknowledged).toBe(true);
      expect(discovered.settings.permissionMode).toBeNull();
      await f.runner.configure({ model: "fixture-model" }, f.runner.snapshot().revision);
      expect(f.runner.optionsSnapshot.settings.permissionMode).toBeNull();
      expect(f.frames()[0].args).not.toContain("--permission-mode");
      expect(
        f.frames().filter((frame) => frame.request?.subtype === "set_permission_mode"),
      ).toEqual([]);
    });

    it("reports inherited Plan mode without turning it into an explicit setting", async () => {
      const f = fixture("inherited-plan");
      const discovered = await f.runner.prepare(f.executable);
      expect(discovered.settings.permissionMode).toBe("plan");
      await f.runner.configure({ effort: "high" }, f.runner.snapshot().revision);
      expect(f.runner.optionsSnapshot.settings).toMatchObject({
        model: "fixture-model",
        effort: "high",
        permissionMode: "plan",
      });
      await f.runner.configure({ model: "fixture-model" }, f.runner.snapshot().revision);
      expect(f.runner.optionsSnapshot.settings.permissionMode).toBe("plan");
      expect(
        f.frames().filter((frame) => frame.request?.subtype === "set_permission_mode"),
      ).toEqual([]);
      await f.runner.retireIfInactive();
      await f.runner.prepare(f.executable);
      const launches = f.frames().filter((frame) => frame.args);
      expect(launches).toHaveLength(2);
      expect(launches.every((frame) => !frame.args.includes("--permission-mode"))).toBe(true);
      expect(f.runner.optionsSnapshot.settings.permissionMode).toBe("plan");
    });

    it("updates inherited permissions when native init arrives with the first turn", async () => {
      const f = fixture("inherited-plan-late");
      const discovered = await f.runner.prepare(f.executable);
      expect(discovered.settings.permissionMode).toBeNull();
      await f.runner.send(f.executable, "first turn", randomUUID(), f.runner.snapshot().revision);
      await expect.poll(() => f.runner.snapshot().status).toBe("idle");
      expect(f.runner.optionsSnapshot.settings.permissionMode).toBe("plan");
    });

    it.each(["bypassPermissions", null])(
      "rejects unsafe or invalid permission mode %s",
      async (mode) => {
        const f = fixture();
        await f.runner.prepare(f.executable);
        await expect(
          f.runner.configure(
            { permissionMode: mode } as unknown as Parameters<typeof f.runner.configure>[0],
            f.runner.snapshot().revision,
          ),
        ).rejects.toThrow("unsupported Claude permission mode");
        expect(
          f.frames().filter((frame) => frame.request?.subtype === "set_permission_mode"),
        ).toEqual([]);
      },
    );

    it("confirms an explicit permission change and retains default on worker restart", async () => {
      const f = fixture();
      await f.runner.prepare(f.executable);
      await f.runner.configure({ permissionMode: "plan" }, f.runner.snapshot().revision);
      expect(f.runner.optionsSnapshot.settings.permissionMode).toBe("plan");
      await f.runner.configure({ permissionMode: "default" }, f.runner.snapshot().revision);
      expect(f.runner.optionsSnapshot.settings.permissionMode).toBe("default");
      await f.runner.retireIfInactive();
      const restarted = await f.runner.prepare(f.executable);
      expect(restarted.settings.permissionMode).toBe("default");
      const launches = f.frames().filter((frame) => frame.args);
      expect(launches).toHaveLength(2);
      expect(launches[1].args.slice(-2)).toEqual(["--permission-mode", "default"]);
    });

    it("confirms explicitly selected startup settings after initialization", async () => {
      const f = fixture("ordinary", {
        model: "fixture-model",
        effort: "high",
        permissionMode: "acceptEdits",
      });
      expect(f.runner.optionsSnapshot.settingsAcknowledged).toBe(false);
      expect(f.runner.optionsSnapshot.settings.permissionMode).toBeNull();
      await expect(f.runner.prepare(f.executable)).resolves.toMatchObject({
        settings: { model: "fixture-model", effort: "high", permissionMode: "acceptEdits" },
        settingsAcknowledged: true,
      });
    });

    it.each(["timeout", "wrong-id"])(
      "keeps uncertain settings blocked on %s instead of claiming success",
      async (mode) => {
        const f = fixture(mode, { controlTimeoutMs: 1500 });
        await f.runner.prepare(f.executable);
        await expect(
          f.runner.configure({ permissionMode: "acceptEdits" }, f.runner.snapshot().revision),
        ).rejects.toThrow();
        expect(f.runner.snapshot().status).toBe("outcome-unknown");
        expect(f.runner.optionsSnapshot.settingsAcknowledged).toBe(false);
        await expect.poll(() => f.runner.hasWorker).toBe(false);
      },
    );

    it("steers in the same turn with a distinct input identity and next priority", async () => {
      const f = fixture("steer");
      const turnId = randomUUID();
      const steerId = randomUUID();
      await f.runner.send(f.executable, "start", turnId, 0);
      const revision = f.runner.snapshot().revision;
      let dispatches = 0;
      await f.runner.steer("focus on this", steerId, turnId, revision, () => dispatches++);
      await expect.poll(() => f.runner.snapshot().status).toBe("idle");
      expect(f.frames().filter((frame) => frame.type === "user")).toMatchObject([
        { uuid: turnId, message: { content: "start" } },
        { uuid: steerId, priority: "next", message: { content: "focus on this" } },
      ]);
      expect(f.runner.snapshot().turnId).toBe(turnId);
      expect(f.results).toHaveLength(1);
      expect(f.results[0]?.turnId).toBe(turnId);
      expect(dispatches).toBe(1);
      await expect(
        f.runner.steer("duplicate", steerId, turnId, f.runner.snapshot().revision),
      ).rejects.toThrow();
    });

    it.each(["ordinary", "error", "aborted"])(
      "retains the native result aggregate separately from context usage (%s)",
      async (mode) => {
        const f = fixture(mode);
        const id = randomUUID();
        await f.runner.send(f.executable, "one turn", id, 0);
        await expect.poll(() => f.results.length).toBe(1);
        expect(f.results[0]).toMatchObject({
          turnId: id,
          success: mode === "ordinary",
          usage: { input_tokens: 19, output_tokens: 11, cache_read_input_tokens: 23 },
          costUsd: 0.012,
        });
        expect(f.runner.snapshot().tokenUsage).toEqual({ input_tokens: 7 });
        if (mode === "aborted") expect(f.runner.snapshot().lastOutcome).toBe("cancelled");
      },
    );

    it("keeps a fork lazy and binds native parent, target and cutoff on first launch", async () => {
      const parent = randomUUID();
      const cutoff = randomUUID();
      const f = fixture("ordinary", { forkSourceNativeId: parent, forkCutoff: cutoff });
      expect(f.runner.hasWorker).toBe(false);
      await f.runner.send(f.executable, "fork continuation", randomUUID(), 0);
      await expect.poll(() => f.runner.snapshot().status).toBe("idle");
      expect(f.frames()[0].args).toEqual(
        expect.arrayContaining([
          `--resume=${parent}`,
          "--fork-session",
          `--session-id=${f.runner.sessionId}`,
          `--resume-session-at=${cutoff}`,
        ]),
      );
      await f.runner.retireIfInactive();
      await f.runner.send(f.executable, "same fork", randomUUID(), f.runner.snapshot().revision);
      await expect.poll(() => f.runner.snapshot().status).toBe("idle");
      const launches = f.frames().filter((frame) => frame.args);
      expect(launches).toHaveLength(2);
      expect(launches[1].args).toContain(`--resume=${f.runner.sessionId}`);
      expect(launches[1].args).not.toContain("--fork-session");
    });

    it("does not infer completion or usage totals when the CLI exits without a native result", async () => {
      const f = fixture("missing-result");
      await f.runner.send(f.executable, "unfinished", randomUUID(), 0);
      await expect.poll(() => f.runner.snapshot().status).toBe("outcome-unknown");
      expect(f.runner.snapshot().terminalResult).toBeNull();
      expect(f.results).toEqual([]);
      expect(f.runner.snapshot().sendEnabled).toBe(false);
    });
  },
);
